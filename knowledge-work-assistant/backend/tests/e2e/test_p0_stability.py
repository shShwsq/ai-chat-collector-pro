from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

from httpx import AsyncClient
from sqlalchemy import func, select, text

import app.db as db_module
from app.models.db_models import Observation
from app.services import ws_notify
from app.services.graph_store import graph_store
from app.services.task_registry import BackgroundTaskRegistry


def _plugin_payload(conversation_id: str) -> dict[str, object]:
    return {
        "platform": "deepseek",
        "timestamp": "2026-07-30T12:00:00+08:00",
        "conversation_markdown": "## 用户\n并发测试\n\n## 助手\n稳定写入",
        "metadata": {"conversation_id": conversation_id, "title": "并发测试"},
    }


async def test_sqlite_pragmas_match_runtime(tmp_db) -> None:
    async with db_module.engine.connect() as conn:
        foreign_keys = (await conn.execute(text("PRAGMA foreign_keys"))).scalar_one()
        journal_mode = (await conn.execute(text("PRAGMA journal_mode"))).scalar_one()
        busy_timeout = (await conn.execute(text("PRAGMA busy_timeout"))).scalar_one()
        synchronous = (await conn.execute(text("PRAGMA synchronous"))).scalar_one()

    assert foreign_keys == 1
    assert str(journal_mode).lower() == "wal"
    assert busy_timeout == db_module.SQLITE_BUSY_TIMEOUT_MS
    assert synchronous == 1


async def test_concurrent_plugin_push_is_atomic_and_idempotent(
    async_client: AsyncClient,
) -> None:
    payload = _plugin_payload("same-conversation")
    responses = await asyncio.gather(
        *(async_client.post("/api/plugin/conversations", json=payload) for _ in range(8))
    )

    assert all(response.status_code == 200 for response in responses)
    bodies = [response.json() for response in responses]
    assert len({body["observation_id"] for body in bodies}) == 1
    assert sum(not body["deduplicated"] for body in bodies) == 1

    async with db_module.AsyncSessionLocal() as db:
        count = await db.scalar(select(func.count(Observation.id)))
    assert count == 1


async def test_undirected_edge_is_normalized_and_idempotent(tmp_db) -> None:
    graph = await graph_store.create_graph("边幂等", "study")
    first = await graph_store.create_node(graph["id"], "general", "A")
    second = await graph_store.create_node(graph["id"], "general", "B")

    edge_a = await graph_store.create_edge(graph["id"], second["id"], first["id"])
    edge_b = await graph_store.create_edge(graph["id"], first["id"], second["id"])

    assert edge_a["id"] == edge_b["id"]
    assert edge_a["src_id"] < edge_a["dst_id"]
    assert len(await graph_store.list_edges(graph["id"])) == 1


async def test_background_registry_rejects_and_closes_coroutine_after_shutdown() -> None:
    registry = BackgroundTaskRegistry()
    blocker = asyncio.Event()

    async def wait_forever() -> None:
        await blocker.wait()

    task = registry.create_task(wait_forever(), request_id="req-1", op="chat")
    assert registry.active_count() == 1
    assert await registry.shutdown(timeout=0.5) == 1
    assert task.cancelled()
    assert registry.active_count() == 0

    coroutine = wait_forever()
    try:
        registry.create_task(coroutine)
    except RuntimeError:
        pass
    else:
        raise AssertionError("关停后应拒绝新后台任务")
    assert coroutine.cr_frame is None


async def test_ws_send_failure_removes_stale_connection() -> None:
    ws = AsyncMock()
    ws.client_state = ws.application_state = ws_notify.WebSocketState.CONNECTED
    # 实现已改用 send_text 预序列化（避免 send_json 内部 dumps 对 datetime/UUID
    # 抛 TypeError 被静默吞掉），此处需 mock send_text 才能模拟发送失败。
    ws.send_text.side_effect = RuntimeError("closed")

    await ws_notify.register("stale-session", ws)
    assert await ws_notify.is_session_online("stale-session") is True
    assert await ws_notify.notify_session("stale-session", {"type": "test"}) == 0
    assert await ws_notify.is_session_online("stale-session") is False


async def test_http_responses_disable_caching(async_client: AsyncClient) -> None:
    response = await async_client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"


async def test_request_body_size_limit_uses_configured_threshold(
    async_client: AsyncClient, monkeypatch
) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "max_request_size_bytes", 128)
    response = await async_client.post(
        "/api/plugin/conversations",
        content=b"x" * 129,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "request body too large"
    assert response.headers["cache-control"] == "no-store"

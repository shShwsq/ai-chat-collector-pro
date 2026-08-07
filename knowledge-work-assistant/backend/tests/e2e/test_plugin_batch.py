"""批量导入对话接口测试（``POST /api/plugin/conversations/batch``）。

覆盖手动导入功能的核心行为：

- 批量成功落库 + source='plugin'
- 跨批 / 批内 ``dedup_key`` 幂等去重
- 平台白名单 / 数量上限 / 空批 / metadata 校验
- FTS5 可用时验证全文索引被批量回填（条件性，FTS5 不可用则跳过）

测试隔离：通过 ``tmp_db`` fixture 使用临时 SQLite，不读写 ``backend/data/app.db``。
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text

import app.db as db_module
from app.models.db_models import Observation


def _batch_payload(
    *,
    platform: str = "deepseek",
    conversations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造 ``POST /api/plugin/conversations/batch`` 请求体。"""
    if conversations is None:
        conversations = [
            {
                "timestamp": "2025-02-20T17:11:10+08:00",
                "conversation_markdown": f"## 用户\n问题 {i}\n\n## 助手\n回答 {i}",
                "metadata": {
                    "conversation_id": f"ds-conv-{i:04d}",
                    "title": f"测试对话 {i}",
                    "model": "deepseek-reasoner",
                },
            }
            for i in range(3)
        ]
    return {"platform": platform, "conversations": conversations}


async def _count_plugin_observations() -> int:
    async with db_module.AsyncSessionLocal() as db:
        result = await db.execute(
            select(func.count(Observation.id)).where(Observation.source == "plugin")
        )
        return int(result.scalar() or 0)


class TestBatchImport:
    """POST /api/plugin/conversations/batch 测试组。"""

    async def test_batch_success(self, async_client: AsyncClient) -> None:
        """批量提交 3 条 → 全部落库，imported=3, deduplicated=0。"""
        before = await _count_plugin_observations()
        assert before == 0

        resp = await async_client.post(
            "/api/plugin/conversations/batch", json=_batch_payload()
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["received"] is True
        assert body["total"] == 3
        assert body["imported"] == 3
        assert body["deduplicated"] == 0
        assert body["failed"] == 0

        after = await _count_plugin_observations()
        assert after == 3

    async def test_batch_dedup_against_existing(
        self, async_client: AsyncClient
    ) -> None:
        """先单条推送一条，再批量提交含相同 conversation_id → 该条 deduplicated。"""
        # 先单条推送 ds-conv-0001
        single = {
            "platform": "deepseek",
            "timestamp": "2025-02-20T17:11:10+08:00",
            "conversation_markdown": "## 用户\n已有问题\n\n## 助手\n已有回答",
            "metadata": {
                "conversation_id": "ds-conv-0001",
                "title": "已有对话",
            },
        }
        resp1 = await async_client.post("/api/plugin/conversations", json=single)
        assert resp1.status_code == 200

        # 批量提交 3 条，其中第 1 条 conversation_id 与已存在的相同
        resp = await async_client.post(
            "/api/plugin/conversations/batch", json=_batch_payload()
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 3
        assert body["imported"] == 2, "应有 2 条新增"
        assert body["deduplicated"] == 1, "应有 1 条命中去重"

        # 数据库共 3 条（1 单条 + 2 批量新增）
        count = await _count_plugin_observations()
        assert count == 3

    async def test_batch_in_batch_dedup(self, async_client: AsyncClient) -> None:
        """同一批次内出现两个相同 conversation_id → 仅 1 条落库，另 1 条 deduplicated。"""
        conversations = [
            {
                "timestamp": "2025-03-01T10:00:00+08:00",
                "conversation_markdown": "## 用户\n问题 A\n\n## 助手\n回答 A",
                "metadata": {"conversation_id": "dup-id", "title": "A"},
            },
            {
                "timestamp": "2025-03-01T11:00:00+08:00",
                "conversation_markdown": "## 用户\n问题 B\n\n## 助手\n回答 B",
                "metadata": {"conversation_id": "dup-id", "title": "B"},
            },
            {
                "timestamp": "2025-03-01T12:00:00+08:00",
                "conversation_markdown": "## 用户\n问题 C\n\n## 助手\n回答 C",
                "metadata": {"conversation_id": "unique-id", "title": "C"},
            },
        ]
        resp = await async_client.post(
            "/api/plugin/conversations/batch",
            json=_batch_payload(conversations=conversations),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["imported"] == 2, "批内去重后应新增 2 条"
        assert body["deduplicated"] == 1, "批内 1 条重复"

        count = await _count_plugin_observations()
        assert count == 2

    async def test_batch_invalid_platform(self, async_client: AsyncClient) -> None:
        """非法 platform → 400，不落库。"""
        resp = await async_client.post(
            "/api/plugin/conversations/batch",
            json=_batch_payload(platform="unknown"),
        )
        assert resp.status_code == 400
        assert "unsupported platform" in resp.json().get("detail", "")
        assert await _count_plugin_observations() == 0

    async def test_batch_too_large(
        self, async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """超过 MAX_BATCH_SIZE → 413。"""
        from app.routers import plugin as plugin_router

        monkeypatch.setattr(plugin_router, "MAX_BATCH_SIZE", 2)
        resp = await async_client.post(
            "/api/plugin/conversations/batch", json=_batch_payload()
        )
        assert resp.status_code == 413
        assert "batch too large" in resp.json().get("detail", "")

    async def test_batch_empty(self, async_client: AsyncClient) -> None:
        """空 conversations → 200，全 0。"""
        resp = await async_client.post(
            "/api/plugin/conversations/batch",
            json={"platform": "deepseek", "conversations": []},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 0
        assert body["imported"] == 0

    async def test_batch_metadata_validation(
        self, async_client: AsyncClient
    ) -> None:
        """批量中某条 metadata.title 非 string → 422，整批不落库。"""
        conversations = _batch_payload()["conversations"]
        conversations[0]["metadata"] = {
            "conversation_id": "ds-bad-0001",
            "title": 12345,  # 非 string
        }
        resp = await async_client.post(
            "/api/plugin/conversations/batch",
            json={"platform": "deepseek", "conversations": conversations},
        )
        assert resp.status_code == 422
        assert "title" in resp.json().get("detail", "")
        assert await _count_plugin_observations() == 0

    async def test_batch_no_conversation_id_all_imported(
        self, async_client: AsyncClient
    ) -> None:
        """无 conversation_id（无 dedup_key）的条目不去重，全部落库。"""
        conversations = [
            {
                "timestamp": "2025-04-01T10:00:00+08:00",
                "conversation_markdown": f"## 用户\n问题 {i}",
                "metadata": {"title": f"无 ID 对话 {i}"},
            }
            for i in range(3)
        ]
        resp = await async_client.post(
            "/api/plugin/conversations/batch",
            json={"platform": "deepseek", "conversations": conversations},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["imported"] == 3
        assert body["deduplicated"] == 0


class TestBatchFtsPopulation:
    """FTS5 全文索引批量回填测试（条件性：FTS5 不可用时跳过）。"""

    async def test_batch_populates_fts_index(
        self, async_client: AsyncClient
    ) -> None:
        """批量导入后 observations_fts 应有对应行（FTS5 可用时）。

        手动创建 observations_fts 虚拟表与 observations_ai 触发器（与 db.py 一致），
        再批量导入，验证：
        - 触发器在批量后被正确重建（再单条插入仍会自动同步 FTS）；
        - 批量导入的行在 observations_fts 中有对应记录。
        """
        # 尝试创建 FTS5 表与触发器；FTS5 不可用则跳过
        async with db_module.AsyncSessionLocal() as db:
            try:
                await db.execute(
                    text(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts "
                        "USING fts5(row_id UNINDEXED, conversation_markdown, "
                        "tokenize='unicode61')"
                    )
                )
                await db.execute(
                    text(
                        "CREATE TRIGGER IF NOT EXISTS observations_ai "
                        "AFTER INSERT ON observations BEGIN "
                        "INSERT INTO observations_fts(row_id, conversation_markdown) "
                        "VALUES (NEW.id, NEW.conversation_markdown); END"
                    )
                )
                await db.commit()
            except Exception:
                pytest.skip("FTS5 扩展不可用，跳过 FTS 回填测试")

        # 批量导入 3 条
        resp = await async_client.post(
            "/api/plugin/conversations/batch", json=_batch_payload()
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["imported"] == 3

        # 验证 observations_fts 有 3 行
        async with db_module.AsyncSessionLocal() as db:
            fts_count = int(
                (await db.execute(text("SELECT count(*) FROM observations_fts"))).scalar()
                or 0
            )
        assert fts_count == 3, f"FTS 应有 3 行，实际 {fts_count}"

        # 验证触发器已重建：再单条插入，FTS 应自动 +1
        single = {
            "platform": "deepseek",
            "timestamp": "2025-05-01T10:00:00+08:00",
            "conversation_markdown": "## 用户\n单条触发器测试",
            "metadata": {"conversation_id": "ds-trigger-test"},
        }
        resp2 = await async_client.post("/api/plugin/conversations", json=single)
        assert resp2.status_code == 200

        async with db_module.AsyncSessionLocal() as db:
            fts_count_after = int(
                (await db.execute(text("SELECT count(*) FROM observations_fts"))).scalar()
                or 0
            )
        assert fts_count_after == 4, (
            "触发器应已重建，单条插入后 FTS 应为 4 行，"
            f"实际 {fts_count_after}（说明批量后触发器未恢复）"
        )

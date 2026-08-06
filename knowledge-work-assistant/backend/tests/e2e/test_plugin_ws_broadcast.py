"""浏览器插件 WS 广播 + 完整链路 e2e 测试（Task 13）。

覆盖推送成功后 WebSocket 广播与端到端数据一致性：

1. ``test_ws_broadcast_on_push``：建立 WS 连接 → POST 推送 → WS 收到
   ``{type: 'plugin.conversation_received', payload: {observation_id, platform,
   title, timestamp}}`` 事件。
2. ``test_e2e_full_pipeline``：模拟 collector patch 采集的完整对话 Markdown →
   调用 webhook → 验证落库（observations 表字段正确）→ 验证 WS 广播 →
   验证 payload 一致性（HTTP 响应 / 数据库 / WS 广播三者 observation_id 一致）。

测试隔离
--------

- 所有测试通过 ``tmp_db`` fixture 使用临时 SQLite，不读写 ``backend/data/app.db``
- 所有 LLM 调用通过 ``mock_llm`` fixture 替代（本测试组实际不触发 LLM）
- HTTP 测试通过 ``httpx.AsyncClient`` + ``ASGITransport(app)`` 直连 FastAPI app
- WS 测试通过 ``httpx_ws.aconnect_ws`` + ``ASGIWebSocketTransport(app)`` 直连
  FastAPI app 的 WebSocket 端点，无需启动 uvicorn

技术要点
--------

1. **ASGIWebSocketTransport vs ASGITransport**：``httpx.ASGITransport`` 仅支持
   HTTP，不支持 WebSocket。WS 连接需用 ``httpx_ws.transport.ASGIWebSocketTransport``
   （继承自 ``ASGITransport``，扩展 WS 支持）。
2. **独立 client for HTTP & WS**：WS 连接是长连接，会占用 client 的 transport
   状态。为避免冲突，HTTP POST 推送与 WS 接收使用独立的 ``AsyncClient`` 实例，
   但都指向同一个 FastAPI app。``ws_notify`` 模块是全局单例，WS 连接注册到
   全局 ``_connections``，broadcast 能跨 client 找到已注册连接。
3. **keepalive ping 禁用**：``aconnect_ws`` 默认每 20s 发 keepalive ping，
   测试中禁用（``keepalive_ping_interval_seconds=None``）避免干扰消息接收。
4. **welcome 消息**：WS 端点 ``/ws`` 在连接建立后会立即推送 ``{type: 'welcome'}``，
   测试需先接收 welcome（确认连接已注册到 ws_notify），再 POST 推送，否则
   broadcast 可能找不到连接。
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from httpx_ws import aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport

import app.db as db_module
from app.models.db_models import Observation
from app.services.graph_store import graph_store
from sqlalchemy import select

# 32 位十六进制字符串（uuid4().hex 风格）
_HEX32_RE = re.compile(r"^[0-9a-f]{32}$")


def _make_full_conversation_payload(
    *,
    platform: str = "chatgpt",
    conversation_id: str = "conv-ws-full-001",
    title: str = "知识图谱与 RAG 检索增强生成",
    model: str = "gpt-4o-mini",
    url: str = "https://chat.openai.com/c/abc123",
    timestamp: str = "2025-01-01T12:00:00+08:00",
    conversation_markdown: str | None = None,
) -> dict[str, Any]:
    """构造完整的插件推送请求体（模拟 collector patch 采集的对话）。

    默认 ``conversation_markdown`` 为一段完整的 AI 对话，包含用户提问与
    助手回答，覆盖知识图谱与 RAG 主题，作为 Agent 抽取知识点的源材料。

    Args:
        platform: 来源平台，默认 chatgpt。
        conversation_id: 对话唯一 ID（用于幂等去重）。
        title: 对话标题。
        model: 模型名。
        url: 对话 URL。
        timestamp: ISO8601 时间戳。
        conversation_markdown: 对话原文 Markdown；None 表示用默认完整对话。

    Returns:
        合法的请求体 dict。
    """
    if conversation_markdown is None:
        conversation_markdown = (
            "## 用户\n"
            "什么是知识图谱？它和 RAG 检索增强生成有什么关系？\n\n"
            "## 助手\n"
            "知识图谱是一种用图结构组织知识的方式，节点表示实体或概念，边表示它们之间的关系。\n\n"
            "RAG（检索增强生成）是通过外部知识库检索再交由 LLM 生成答案的技术。\n\n"
            "两者可以结合：用知识图谱作为 RAG 的检索源，提升答案的准确性与可解释性。\n\n"
            "## 用户\n"
            "那如何构建一个知识图谱？\n\n"
            "## 助手\n"
            "构建知识图谱一般包括以下步骤：\n"
            "1. 数据采集（从文档、对话、数据库等来源）\n"
            "2. 实体识别与关系抽取（可用 LLM 辅助）\n"
            "3. 图谱存储（图数据库或关系型数据库）\n"
            "4. 图谱查询与可视化\n"
        )
    return {
        "platform": platform,
        "timestamp": timestamp,
        "conversation_markdown": conversation_markdown,
        "metadata": {
            "conversation_id": conversation_id,
            "title": title,
            "url": url,
            "model": model,
        },
    }


class TestPluginWsBroadcast:
    """WS 广播 + 完整链路 e2e 测试组。"""

    async def test_ws_broadcast_on_push(self, app) -> None:
        """建立 WS 连接 → POST 推送 → WS 收到 plugin.conversation_received 事件。

        验证：
        - WS 连接建立后收到 welcome 消息
        - POST /api/plugin/conversations 返回 200 + observation_id
        - WS 收到 {type: 'plugin.conversation_received', payload: {observation_id,
          platform, title, timestamp}} 事件
        - payload 中 observation_id 与 HTTP 响应一致
        - payload 中 platform / title 与请求体一致
        - payload 中 timestamp 与请求体 timestamp 解析后一致
        """
        # 1. 建立 WS 连接（用 ASGIWebSocketTransport，禁用 keepalive ping）
        #    先获取 WS 鉴权 token（/ws 端点要求 ?token=xxx）
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as auth_client:
            token_resp = await auth_client.get("/api/auth/ws-token")
        assert token_resp.status_code == 200, token_resp.text
        ws_token = token_resp.json()["token"]

        ws_transport = ASGIWebSocketTransport(app=app)
        async with AsyncClient(
            transport=ws_transport, base_url="http://test"
        ) as ws_client:
            async with aconnect_ws(
                f"ws://test/ws?token={ws_token}",
                ws_client,
                keepalive_ping_interval_seconds=None,
                keepalive_ping_timeout_seconds=None,
            ) as ws:
                # 2. 接收 welcome（确认 WS 连接已注册到 ws_notify）
                welcome = await ws.receive_json()
                assert welcome["type"] == "welcome", (
                    f"首条消息应为 welcome，实际: {welcome.get('type')}"
                )

                # 3. POST 推送（用独立的 HTTP client，避免与 WS 长连接冲突）
                payload = _make_full_conversation_payload(
                    conversation_id="conv-ws-broadcast-001",
                    title="WS 广播测试对话",
                    timestamp="2025-01-01T12:00:00+08:00",
                )
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as http_client:
                    resp = await http_client.post(
                        "/api/plugin/conversations", json=payload
                    )
                assert resp.status_code == 200, resp.text
                resp_body = resp.json()
                assert resp_body["received"] is True
                obs_id = resp_body["observation_id"]
                assert _HEX32_RE.match(obs_id), (
                    f"observation_id 应为 32 位 hex，实际: {obs_id}"
                )

                # 4. 接收 WS 广播（带超时，避免测试卡死）
                # 注意：aconnect_ws 的 receive_json 默认无超时，但 keepalive ping
                # 已禁用，广播应在 POST 后立即触发。用 asyncio.wait_for 兜底。
                broadcast_msg = await asyncio.wait_for(ws.receive_json(), timeout=5.0)

                # 5. 验证广播消息内容
                assert broadcast_msg["type"] == "plugin.conversation_received", (
                    f"广播 type 应为 plugin.conversation_received，"
                    f"实际: {broadcast_msg.get('type')}"
                )
                broadcast_payload = broadcast_msg["payload"]
                assert broadcast_payload["observation_id"] == obs_id, (
                    "广播 payload.observation_id 应与 HTTP 响应一致"
                )
                assert broadcast_payload["platform"] == "chatgpt"
                assert broadcast_payload["title"] == "WS 广播测试对话"
                # timestamp 为 ISO8601 字符串
                assert broadcast_payload["timestamp"] is not None
                # 验证 timestamp 可解析为 datetime
                parsed_ts = datetime.fromisoformat(broadcast_payload["timestamp"])
                # 解析后的时间应与请求体 timestamp 一致
                expected_ts = datetime.fromisoformat("2025-01-01T12:00:00+08:00")
                assert parsed_ts == expected_ts, (
                    f"广播 timestamp 应为 {expected_ts}，实际: {parsed_ts}"
                )

    async def test_e2e_full_pipeline(self, app) -> None:
        """模拟 collector patch 数据 → 调用 webhook → 验证落库 → 验证 WS 广播 → 验证 payload 一致性。

        端到端验证：
        1. 构造完整的 conversationMarkdown（模拟 collector patch 采集）
        2. 建立 WS 连接
        3. POST 推送
        4. 验证 HTTP 响应（received=True, observation_id）
        5. 验证落库（observations 表字段正确：source/platform/conversation_markdown/metadata）
        6. 验证 WS 广播（收到 plugin.conversation_received 事件）
        7. 验证 payload 一致性（HTTP 响应 / 数据库 / WS 广播三者 observation_id 一致）
        """
        # 1. 构造完整的 collector patch 数据
        payload = _make_full_conversation_payload(
            platform="deepseek",
            conversation_id="conv-e2e-full-001",
            title="知识图谱与 RAG 完整链路测试",
            model="deepseek-chat",
            url="https://chat.deepseek.com/c/full001",
            timestamp="2025-01-02T09:30:00+08:00",
        )

        # 2. 建立 WS 连接
        #    先获取 WS 鉴权 token（/ws 端点要求 ?token=xxx）
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as auth_client:
            token_resp = await auth_client.get("/api/auth/ws-token")
        assert token_resp.status_code == 200, token_resp.text
        ws_token = token_resp.json()["token"]

        ws_transport = ASGIWebSocketTransport(app=app)
        async with AsyncClient(
            transport=ws_transport, base_url="http://test"
        ) as ws_client:
            async with aconnect_ws(
                f"ws://test/ws?token={ws_token}",
                ws_client,
                keepalive_ping_interval_seconds=None,
                keepalive_ping_timeout_seconds=None,
            ) as ws:
                # 接收 welcome
                welcome = await ws.receive_json()
                assert welcome["type"] == "welcome"

                # 3. POST 推送
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as http_client:
                    resp = await http_client.post(
                        "/api/plugin/conversations", json=payload
                    )

                # 4. 验证 HTTP 响应
                assert resp.status_code == 200, resp.text
                resp_body = resp.json()
                assert resp_body["received"] is True
                assert resp_body["deduplicated"] is False
                obs_id_http = resp_body["observation_id"]
                assert _HEX32_RE.match(obs_id_http)

                # 5. 接收 WS 广播
                broadcast_msg = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
                assert broadcast_msg["type"] == "plugin.conversation_received"
                broadcast_payload = broadcast_msg["payload"]
                obs_id_ws = broadcast_payload["observation_id"]
                assert _HEX32_RE.match(obs_id_ws)

        # 6. 验证落库（直接查数据库，用动态访问 app.db.AsyncSessionLocal）
        async with db_module.AsyncSessionLocal() as db:
            result = await db.execute(
                select(Observation).where(Observation.id == obs_id_http)
            )
            obs_row = result.scalar_one_or_none()
            assert obs_row is not None, (
                f"observation {obs_id_http} 应已落库"
            )

            # 验证字段
            assert obs_row.source == "plugin", "source 应为 plugin"
            assert obs_row.platform == "deepseek", "platform 应为 deepseek"
            assert "知识图谱" in obs_row.conversation_markdown, (
                "conversation_markdown 应含原文"
            )
            assert "RAG" in obs_row.conversation_markdown, (
                "conversation_markdown 应含 RAG 关键词"
            )
            # metadata_json 反序列化
            metadata = json.loads(obs_row.metadata_json)
            assert metadata.get("conversation_id") == "conv-e2e-full-001"
            assert metadata.get("title") == "知识图谱与 RAG 完整链路测试"
            assert metadata.get("model") == "deepseek-chat"
            assert metadata.get("url") == "https://chat.deepseek.com/c/full001"
            # _dedup_key 应已合并
            assert metadata.get("_dedup_key") == "deepseek:conv-e2e-full-001"
            # occurred_at 应为请求体 timestamp 解析后的时间
            # SQLite DateTime 列不保留时区信息（naive datetime），
            # SQLAlchemy 存储带时区的 datetime 时会去掉时区但**不转换时区**，
            # 故数据库中存的是 "2025-01-02 09:30:00"（去掉 +08:00 后的 naive 值）。
            # 比较时统一去掉时区，比较 naive 值。
            assert obs_row.occurred_at is not None
            expected_occurred = datetime.fromisoformat("2025-01-02T09:30:00+08:00")
            expected_naive = expected_occurred.replace(tzinfo=None)
            actual_occurred = obs_row.occurred_at
            if actual_occurred.tzinfo is not None:
                actual_naive = actual_occurred.replace(tzinfo=None)
            else:
                actual_naive = actual_occurred
            # 允许 1 秒精度差异（SQLite 时间戳精度）
            diff = abs((actual_naive - expected_naive).total_seconds())
            assert diff < 1.0, (
                f"occurred_at 应为 {expected_naive}，实际: {actual_naive}，差异: {diff}s"
            )
            assert obs_row.processed is False, "新推送的记录应未被处理"
            assert obs_row.graph_id is None, "新推送的记录应无关联图谱"

        # 7. 验证 payload 一致性
        # HTTP 响应 / 数据库 / WS 广播 三者 observation_id 一致
        assert obs_id_http == obs_id_ws, (
            f"HTTP 响应 observation_id ({obs_id_http}) 应与 WS 广播 ({obs_id_ws}) 一致"
        )
        # 数据库 observation_id 已通过 obs_row.id 验证（等于 obs_id_http）
        assert obs_row.id == obs_id_http

        # 通过 graph_store 二次验证落库（用 monkeypatch 后的 session）
        obs_dict = await graph_store.get_observation(obs_id_http)
        assert obs_dict is not None
        assert obs_dict["source"] == "plugin"
        assert obs_dict["platform"] == "deepseek"
        assert obs_dict["metadata"]["_dedup_key"] == "deepseek:conv-e2e-full-001"

        # 验证 WS 广播 payload 与请求体一致
        assert broadcast_payload["platform"] == "deepseek"
        assert broadcast_payload["title"] == "知识图谱与 RAG 完整链路测试"
        # timestamp 应为请求体 timestamp 解析后的 ISO8601（带时区）。
        # 广播用的是内存中的 occurred_at（带时区 datetime），未经数据库序列化，
        # 故 isoformat() 保留时区信息，应与请求体 timestamp 完全一致。
        parsed_broadcast_ts = datetime.fromisoformat(broadcast_payload["timestamp"])
        expected_ts = datetime.fromisoformat("2025-01-02T09:30:00+08:00")
        # 两者都带时区，直接比较（转 UTC 后比较绝对时刻）
        if parsed_broadcast_ts.tzinfo is None:
            parsed_cmp = parsed_broadcast_ts.replace(tzinfo=timezone.utc)
        else:
            parsed_cmp = parsed_broadcast_ts.astimezone(timezone.utc)
        expected_cmp = expected_ts.astimezone(timezone.utc)
        diff = abs((parsed_cmp - expected_cmp).total_seconds())
        assert diff < 1.0, (
            f"广播 timestamp 应为 {expected_cmp}，实际: {parsed_cmp}，差异: {diff}s"
        )

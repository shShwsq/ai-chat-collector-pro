"""ws_notify 序列化兜底测试。

回归覆盖 commit 0d5c252 修复、后被 28719e7 合并回退的问题：
``notify_session`` / ``broadcast`` 推送含 datetime / UUID 等非 JSON 原生
类型的事件时，``send_json`` 内部 ``json.dumps`` 抛 TypeError，被 ``except Exception``
静默吞掉，不仅消息无法送达前端，还会把仍开着的连接误判为死连接并 ``unregister``，
导致该 session 后续所有 WS 事件都丢失（测验卡不刷新、token 不送达）。
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

from starlette.websockets import WebSocketState

from app.services import ws_notify


def _make_mock_ws() -> MagicMock:
    """构造一个模拟已连接的 WebSocket（send_text / send_json 为 AsyncMock）。"""
    ws = MagicMock(name="ws")
    ws.send_text = AsyncMock(name="send_text")
    ws.send_json = AsyncMock(name="send_json")
    # register 时会尝试关闭旧连接，close 为 AsyncMock
    ws.close = AsyncMock(name="close")
    # is_session_online / _is_connected 检查两端状态
    ws.client_state = WebSocketState.CONNECTED
    ws.application_state = WebSocketState.CONNECTED
    return ws


async def test_notify_session_delivers_event_with_datetime() -> None:
    """含 datetime 的事件必须成功送达，连接不被误判为死连接。

    触发场景：``graph_generate_quiz`` 返回的 quiz 记录含 ``created_at``
    datetime 字段，``chat_tool_result`` 事件携带该 result 推送给前端。
    """
    # 清理残留状态
    await ws_notify.close_all()

    ws = _make_mock_ws()
    await ws_notify.register("session-dt", ws)

    event = {
        "type": "chat_tool_result",
        "op": "chat",
        "tool": "graph_generate_quiz",
        "result": {
            "status": "ok",
            "quiz_id": "abc123",
            "quiz": {
                "id": "abc123",
                "created_at": datetime(2026, 7, 31, 12, 0, tzinfo=UTC),
                "answered_at": None,
            },
        },
    }

    count = await ws_notify.notify_session("session-dt", event)

    # 事件必须成功送达
    assert count == 1, "含 datetime 的事件应成功送达"
    ws.send_text.assert_awaited_once()
    # send_json 不应被调用（旧路径会因 json.dumps 抛 TypeError）
    ws.send_json.assert_not_called()

    # 连接不应被误注销——后续推送仍可达
    assert await ws_notify.is_session_online("session-dt") is True

    await ws_notify.close_all()


async def test_broadcast_delivers_event_with_datetime() -> None:
    """broadcast 同样必须能处理含 datetime 的事件。"""
    await ws_notify.close_all()

    ws = _make_mock_ws()
    await ws_notify.register("session-bc", ws)

    event = {
        "type": "plugin.conversation_received",
        "payload": {
            "occurred_at": datetime(2026, 7, 31, 12, 0, tzinfo=UTC),
        },
    }

    count = await ws_notify.broadcast(event)
    assert count == 1, "含 datetime 的广播事件应成功送达"
    ws.send_text.assert_awaited_once()
    ws.send_json.assert_not_called()
    assert await ws_notify.is_session_online("session-bc") is True

    await ws_notify.close_all()


async def test_notify_session_unregisters_genuinely_dead_connection() -> None:
    """真正断开的连接（send_text 抛异常）仍应被清理，保持原有行为不变。"""
    await ws_notify.close_all()

    ws = _make_mock_ws()
    ws.send_text.side_effect = RuntimeError("connection closed")
    await ws_notify.register("session-dead", ws)

    count = await ws_notify.notify_session(
        "session-dead", {"type": "ping"}
    )
    assert count == 0, "死连接不应计入成功数"
    # 死连接应被注销
    assert await ws_notify.is_session_online("session-dead") is False

    await ws_notify.close_all()

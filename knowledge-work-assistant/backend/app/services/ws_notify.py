"""WebSocket 连接注册表（按 session_id 索引）。

供后台任务（如子 Agent、文件概括等异步流程）向特定会话的 WebSocket 连接推送
``agent_event`` 等异步事件，即便该事件不在 WS 主消息循环中触发。

工作方式：

1. ``routers/ws``（或后续的流式对话路由）在 ``accept`` 后调用
   :func:`register`，断开时 :func:`unregister`。
2. 任意后台任务调用 :func:`notify_session` 推送事件；同一会话可有多个连接
   （多端登录场景），逐一推送，失败连接被静默忽略。
3. ``notify_session`` 返回成功推送的连接数；调用方可据此判断是否有活跃连接。

并发安全：``asyncio.Lock`` 保护内部 ``dict``，避免 ``register`` / ``unregister``
在事件循环中交错。CPython 单线程模型下其实可省，但 ``send_json`` 涉及 IO，
持锁时间应尽量短（仅复制连接列表后释放锁再推送）。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketState

logger = logging.getLogger(__name__)


def _dumps_event(event: dict[str, Any]) -> str:
    """将事件预序列化为 JSON 字符串。

    使用 ``default=str`` 兜底，把 datetime / UUID / ORM 对象等非 JSON 原生
    类型转为字符串，避免 ``ws.send_json`` 内部 ``json.dumps`` 抛 TypeError
    被静默吞掉（典型场景：``graph_generate_quiz`` 返回的 quiz 记录含
    ``created_at`` datetime 字段，导致 ``chat_tool_result`` 事件无法送达
    前端，测验卡需刷新才显示）。与持久化层（main_agent 落库 tool_calls）
    的 ``default=str`` 策略保持一致。
    """
    return json.dumps(event, ensure_ascii=False, default=str)

# session_id -> 活跃 WebSocket 连接集合（多端登录时可能有多个）
_connections: dict[str, set[WebSocket]] = {}
_lock = asyncio.Lock()


async def register(session_id: str, ws: WebSocket) -> None:
    """注册一个 WebSocket 连接到指定会话。

    Args:
        session_id: 会话 ID。
        ws: 已 ``accept`` 的 WebSocket 连接。
    """
    async with _lock:
        stale = list(_connections.get(session_id, ()))
        _connections[session_id] = {ws}

    # 单进程本地 Demo 中同一 session 只保留最新连接，避免重连后重复投递。
    for old_ws in stale:
        if old_ws is ws:
            continue
        try:
            await old_ws.close(code=1000, reason="同一会话已建立新连接")
        except Exception:  # noqa: BLE001
            logger.debug("关闭被替换的 WS 连接失败 session=%s", session_id)


async def unregister(session_id: str, ws: WebSocket) -> None:
    """注销指定会话的一个 WebSocket 连接。

    幂等：连接不在注册表中也不报错。空集合自动从 dict 移除。
    """
    async with _lock:
        conns = _connections.get(session_id)
        if not conns:
            return
        conns.discard(ws)
        if not conns:
            _connections.pop(session_id, None)


async def notify_session(session_id: str, event: dict[str, Any]) -> int:
    """向指定会话的所有 WebSocket 连接推送事件。

    推送失败的连接被静默忽略（不抛异常，不阻断其他连接）。

    Args:
        session_id: 会话 ID。
        event: 待推送的 JSON 事件 dict（如
            ``{"type": "agent_event", "agent": "summarize", ...}``）。

    Returns:
        成功推送的连接数（0 表示无活跃连接）。
    """
    async with _lock:
        sockets = list(_connections.get(session_id, ()))

    if not sockets:
        return 0

    # 预序列化一次：避免 datetime / UUID 等非 JSON 原生类型导致 send_json
    # 抛 TypeError 被静默吞掉（如 graph_generate_quiz 的 quiz.created_at），
    # 进而误判连接已死并 unregister 仍开着的连接。
    payload = _dumps_event(event)

    count = 0
    failed: list[WebSocket] = []
    for ws in sockets:
        try:
            await ws.send_text(payload)
            count += 1
        except Exception as exc:  # noqa: BLE001
            # 连接已关闭 / 发送失败：静默忽略，不阻断其他连接
            logger.debug(
                "WS 推送失败 session=%s event_type=%s: %s",
                session_id,
                event.get("type"),
                exc,
            )
            failed.append(ws)
    for ws in failed:
        await unregister(session_id, ws)
    return count


async def broadcast(event: dict[str, Any]) -> int:
    """向所有已注册会话的所有 WebSocket 连接推送事件。

    用于全局事件广播（如插件推送对话到达），不区分会话。推送失败的连接
    被静默忽略（不抛异常，不阻断其他连接）。

    Args:
        event: 待推送的 JSON 事件 dict（如
            ``{"type": "plugin.conversation_received", "payload": {...}}``）。

    Returns:
        成功推送的连接数（0 表示无活跃连接）。
    """
    async with _lock:
        all_sockets: list[tuple[str, WebSocket]] = []
        for session_id, conns in _connections.items():
            all_sockets.extend((session_id, ws) for ws in conns)

    if not all_sockets:
        return 0

    payload = _dumps_event(event)

    count = 0
    failed: list[tuple[str, WebSocket]] = []
    for session_id, ws in all_sockets:
        try:
            await ws.send_text(payload)
            count += 1
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "WS 广播失败 event_type=%s: %s", event.get("type"), exc
            )
            failed.append((session_id, ws))
    for session_id, ws in failed:
        await unregister(session_id, ws)
    return count


def has_session_connection(session_id: str) -> bool:
    """查询指定会话是否有活跃 WebSocket 连接（同步，便于快速判断）。"""
    return any(_is_connected(ws) for ws in _connections.get(session_id, ()))


def _is_connected(ws: WebSocket) -> bool:
    """同时检查 ASGI 客户端与应用端状态，过滤已关闭但尚未清理的连接。"""
    return (
        ws.client_state == WebSocketState.CONNECTED
        and ws.application_state == WebSocketState.CONNECTED
    )


async def is_session_online(session_id: str) -> bool:
    """在锁内确认目标 session 当前存在已连接 socket。"""
    async with _lock:
        return any(_is_connected(ws) for ws in _connections.get(session_id, ()))


async def close_all() -> int:
    """清空注册表并关闭所有 socket，供应用关停使用。"""
    async with _lock:
        sockets = [ws for conns in _connections.values() for ws in conns]
        _connections.clear()
    for ws in sockets:
        try:
            await ws.close(code=1001, reason="服务正在关闭")
        except Exception:  # noqa: BLE001
            pass
    return len(sockets)

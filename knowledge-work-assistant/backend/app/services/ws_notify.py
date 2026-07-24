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
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

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
        _connections.setdefault(session_id, set()).add(ws)


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

    count = 0
    for ws in sockets:
        try:
            await ws.send_json(event)
            count += 1
        except Exception as exc:  # noqa: BLE001
            # 连接已关闭 / 发送失败：静默忽略，不阻断其他连接
            logger.debug(
                "WS 推送失败 session=%s event_type=%s: %s",
                session_id,
                event.get("type"),
                exc,
            )
    return count


def has_session_connection(session_id: str) -> bool:
    """查询指定会话是否有活跃 WebSocket 连接（同步，便于快速判断）。"""
    return bool(_connections.get(session_id))

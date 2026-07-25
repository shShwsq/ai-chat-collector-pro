"""WebSocket 测试端点：/ws。

供前端 lib/ws.ts 联调：建立连接后后端推送 ``welcome`` 事件，
前端可发送任意 JSON 消息，后端回 ``echo``；发送 ``{"type":"ping"}`` 回 ``pong``。

后续业务 WebSocket（如流式对话 /api/ws/chat/{session_id}）会在本模块或独立模块扩展，
当前仅提供最小可收发测试通道。

连接生命周期内会注册到 :mod:`app.services.ws_notify`，使后台任务
（如插件推送对话到达后的全局广播）能通过 :func:`ws_notify.broadcast`
向所有已连接前端推送事件。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services import ws_notify

logger = logging.getLogger(__name__)

router = APIRouter()

#: 默认会话 ID：当前 /ws 端点不区分会话，所有连接注册到同一会话，
#: 供 :func:`ws_notify.broadcast` 全局广播使用。后续流式对话路由
#: （/api/ws/chat/{session_id}）会按实际 session_id 注册。
_DEFAULT_SESSION_ID = "default"


@router.websocket("/ws")
async def ws_test(websocket: WebSocket) -> None:
    """WebSocket 测试端点。

    协议：
    - 连接建立 → 注册到 ws_notify → 推送 ``{"type":"welcome","message":"..."}``
    - 收到 ``{"type":"ping"}`` → 回复 ``{"type":"pong"}``
    - 收到其他 JSON → 回复 ``{"type":"echo","data":<原消息>}``
    - 收到非 JSON 文本 → 回复 ``{"type":"echo","data":"<原文本>"}``
    - 连接断开 → 从 ws_notify 注销
    """
    await websocket.accept()
    # 注册到 ws_notify，使 broadcast/notify_session 能找到此连接
    await ws_notify.register(_DEFAULT_SESSION_ID, websocket)
    await websocket.send_json(
        {"type": "welcome", "message": "已连接知识工作助手后端 WebSocket"}
    )
    try:
        while True:
            raw = await websocket.receive_text()
            data: Any
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                data = raw

            if isinstance(data, dict) and data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            await websocket.send_json({"type": "echo", "data": data})
    except WebSocketDisconnect:
        logger.info("WebSocket 客户端断开")
    except Exception as exc:  # noqa: BLE001
        logger.warning("WebSocket 异常: %s", exc)
    finally:
        # 无论正常断开还是异常，都确保从注册表移除，避免 broadcast 向已关闭连接推送
        await ws_notify.unregister(_DEFAULT_SESSION_ID, websocket)

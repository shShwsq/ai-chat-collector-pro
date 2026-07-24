"""WebSocket 测试端点：/ws。

供前端 lib/ws.ts 联调：建立连接后后端推送 ``welcome`` 事件，
前端可发送任意 JSON 消息，后端回 ``echo``；发送 ``{"type":"ping"}`` 回 ``pong``。

后续业务 WebSocket（如流式对话 /api/ws/chat/{session_id}）会在本模块或独立模块扩展，
当前仅提供最小可收发测试通道。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws")
async def ws_test(websocket: WebSocket) -> None:
    """WebSocket 测试端点。

    协议：
    - 连接建立 → 推送 ``{"type":"welcome","message":"..."}``
    - 收到 ``{"type":"ping"}`` → 回复 ``{"type":"pong"}``
    - 收到其他 JSON → 回复 ``{"type":"echo","data":<原消息>}``
    - 收到非 JSON 文本 → 回复 ``{"type":"echo","data":"<原文本>"}``
    """
    await websocket.accept()
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

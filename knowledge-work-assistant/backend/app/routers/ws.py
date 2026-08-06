"""WebSocket 端点：/ws。

供前端 lib/ws.ts 连接：建立连接后后端推送 ``welcome`` 事件，
前端可发送任意 JSON 消息，后端回 ``echo``；发送 ``{"type":"ping"}`` 回 ``pong``。

**鉴权**：连接必须携带 ``?token=xxx`` 查询参数，token 由
``GET /api/auth/ws-token`` 签发（短期 HMAC token，15 分钟有效）。
未携带或校验失败时，握手阶段即以 code 4401 关闭，不进入消息循环。
这阻止了"同机任意进程猜 session_id 劫持他人会话流式 token"的攻击。

**session_id 注册**：鉴权通过后，前端可附带 ``?session_id=xxx`` 查询参数，
连接会注册到该 session_id 下，使后台流式任务（如 LLM 逐 token 推送）
能通过 :func:`ws_notify.notify_session` 精确推送到发起请求的前端连接。
未提供 session_id 时注册到 ``"default"`` 会话，仍可接收
:func:`ws_notify.broadcast` 的全局广播（如插件推送对话到达事件）。

连接生命周期内会注册到 :mod:`app.services.ws_notify`，使后台任务
（如插件推送对话到达后的全局广播、流式 LLM token 推送）能通过
:func:`ws_notify.broadcast` / :func:`ws_notify.notify_session`
向已连接前端推送事件。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.routers.auth import verify_ws_token
from app.services import ws_notify

logger = logging.getLogger(__name__)

router = APIRouter()

#: 默认会话 ID：未提供 session_id 查询参数时使用。
_DEFAULT_SESSION_ID = "default"

#: WS 鉴权失败关闭码（自定义码，4xxx 段，避免与标准码混淆）
#: 4401 = Unauthorized（类比 HTTP 401）
_WS_CLOSE_UNAUTHORIZED = 4401


@router.websocket("/ws")
async def ws_test(websocket: WebSocket) -> None:
    """WebSocket 端点。

    协议：
    - 鉴权：校验 ``?token=xxx``，失败则以 code 4401 关闭，不进入消息循环。
    - 连接建立 → 注册到 ws_notify（按 session_id 查询参数或 "default"）
      → 推送 ``{"type":"welcome","message":"..."}``
    - 收到 ``{"type":"ping"}`` → 回复 ``{"type":"pong"}``
    - 收到其他 JSON → 回复 ``{"type":"echo","data":<原消息>}``
    - 收到非 JSON 文本 → 回复 ``{"type":"echo","data":"<原文本>"}``
    - 连接断开 → 从 ws_notify 注销

    查询参数：
        token: **必填**。``GET /api/auth/ws-token`` 签发的短期 token。
        session_id: 可选。前端生成的唯一会话 ID，用于接收流式 LLM token。
                    未提供时注册到 "default" 会话，仅接收全局广播。
    """
    # ① 鉴权：校验 token
    token = websocket.query_params.get("token") or ""
    if not verify_ws_token(token):
        logger.warning("WebSocket 鉴权失败，拒绝连接 (token 缺失或无效)")
        # accept 后才能 close（Starlette 要求先 accept 才能发关闭帧）
        await websocket.accept()
        await websocket.close(
            code=_WS_CLOSE_UNAUTHORIZED, reason="未授权：token 缺失或无效"
        )
        return

    # ② 从查询参数获取 session_id（前端生成 UUID，用于精确推送流式 token）
    session_id = websocket.query_params.get("session_id") or _DEFAULT_SESSION_ID

    await websocket.accept()
    # 注册到 ws_notify，使 broadcast/notify_session 能找到此连接
    await ws_notify.register(session_id, websocket)
    await websocket.send_json(
        {
            "type": "welcome",
            "message": "已连接知识工作助手后端 WebSocket",
            "session_id": session_id,
        }
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
        logger.info("WebSocket 客户端断开 session_id=%s", session_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("WebSocket 异常 session_id=%s: %s", session_id, exc)
    finally:
        # 无论正常断开还是异常，都确保从注册表移除，避免向已关闭连接推送
        await ws_notify.unregister(session_id, websocket)

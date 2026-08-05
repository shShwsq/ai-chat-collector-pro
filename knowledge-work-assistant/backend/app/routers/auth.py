"""鉴权路由:WebSocket 短期 token 签发与校验。

本地应用安全模型
----------------
本项目运行在用户本机(127.0.0.1:8788),不对外暴露公网。WebSocket 鉴权的
目标是**阻止同机任意进程通过猜测 ``session_id`` 劫持他人会话的流式 token
推送**——这是当前最大的 WS 攻击面(见 ``routers/ws.py`` 旧实现)。

方案:**进程级 secret + 短期 HMAC token**

1. 后端启动时生成 32 字节随机 secret,保存在模块级变量(进程重启即失效,
   无需落盘)。
2. ``GET /api/auth/ws-token`` 返回短期 token:``base64(payload).base64(signature)``
   payload 为 ``{"exp": <unix_ts>}``,有效期 15 分钟;签名算法 HMAC-SHA256。
3. WebSocket 握手时由 ``routers/ws.py`` 调用 :func:`verify_ws_token` 校验
   query param ``token``,失败则拒绝连接(code 4401)。

为什么这样设计
~~~~~~~~~~~~~~

- **进程级 secret 不落盘**:避免新增密钥文件(已有 ``.encryption_key``),
  重启后旧 token 自动失效,无需轮转。
- **短期 token**:15 分钟过期,即使被截获也仅有短窗口可用;前端在连接前
  每次申请新 token,实际有效时间更短。
- **HMAC 无状态校验**:后端无需维护 token 黑名单/缓存,重启即清空。
- **``/api/auth/ws-token`` 暂不鉴权**:本地应用同机进程都能调用,但攻击面
  从"被动猜 session_id"收窄到"主动发 HTTP 请求"。未来接入全局认证时,
  给此端点加 ``Depends(get_current_user)`` 即可。
"""

from __future__ import annotations

import base64
import hmac
import hashlib
import logging
import secrets
import time

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

# ===== 进程级 secret =====
# 32 字节随机 secret,进程启动时生成一次,重启即失效。
# 不落盘:① 避免新增密钥管理负担;② 重启自动失效旧 token 更安全。
_WS_SECRET: bytes = secrets.token_bytes(32)

# token 有效期(秒)
_TOKEN_TTL = 15 * 60  # 15 分钟


class WsTokenResponse(BaseModel):
    """``GET /api/auth/ws-token`` 响应。"""

    token: str
    expires_at: int  # unix 时间戳(秒)


def _sign(payload_b64: str) -> str:
    """对 base64(payload) 做 HMAC-SHA256,返回 base64(signature)。"""
    mac = hmac.new(_WS_SECRET, payload_b64.encode("ascii"), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).rstrip(b"=").decode("ascii")


def issue_ws_token() -> str:
    """签发一个短期 WS token。

    格式:``{base64url(payload)}.{base64url(signature)}``
    payload = ``{"exp": <unix_ts>}`` (JSON)

    Returns:
        token 字符串。
    """
    exp = int(time.time()) + _TOKEN_TTL
    payload_json = f'{{"exp":{exp}}}'.encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_json).rstrip(b"=").decode("ascii")
    sig_b64 = _sign(payload_b64)
    return f"{payload_b64}.{sig_b64}"


def verify_ws_token(token: str) -> bool:
    """校验 WS token 的签名与有效期。

    Args:
        token: ``issue_ws_token`` 签发的字符串。

    Returns:
        ``True`` 表示签名正确且未过期;``False`` 表示无效(任一原因)。
    """
    if not token or "." not in token:
        return False
    parts = token.split(".")
    if len(parts) != 2:
        return False
    payload_b64, sig_b64 = parts

    # ① 常量时间比较签名,防时序攻击
    expected_sig = _sign(payload_b64)
    if not hmac.compare_digest(expected_sig, sig_b64):
        return False

    # ② 解析 payload 校验过期时间
    try:
        # 补齐 base64 padding
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(padded)
        import json

        payload = json.loads(payload_bytes)
        exp = int(payload["exp"])
    except (ValueError, KeyError, TypeError):
        return False

    return exp > time.time()


@router.get("/auth/ws-token", response_model=WsTokenResponse)
async def get_ws_token() -> WsTokenResponse:
    """签发一个短期 WebSocket 连接 token。

    前端在建立 WS 连接前调用此接口获取 token,通过 query param ``token``
    传给 ``/ws`` 端点。token 有效期 15 分钟,仅用于 WS 握手鉴权。

    **安全说明**:本端点当前不要求其他认证(本地应用)。未来接入全局认证后,
    给此端点加 ``Depends(get_current_user)`` 即可收窄到已登录用户。
    """
    token = issue_ws_token()
    exp = int(time.time()) + _TOKEN_TTL
    return WsTokenResponse(token=token, expires_at=exp)

"""LLM 管理 API 路由（请求队列 + 配置）。

为前端「LLM 设置 / 请求管理面板」提供后端支持，挂载在 ``/api`` 前缀下：

- ``GET  /api/llm/requests``                 返回当前活跃的 LLM 请求（status=queued/running）
- ``GET  /api/llm/requests/all``             返回最近所有请求（含已完成，limit=50）
- ``POST /api/llm/requests/{request_id}/cancel``  取消指定请求（标记为 cancelled）
- ``GET  /api/llm/config``                   返回当前 LLM 配置（base_url, model, api_key 脱敏）
- ``PUT  /api/llm/config``                   更新 LLM 配置（base_url, api_key, model）

设计要点：

1. **不破坏现有接口**：本路由仅新增端点，所有现有路由保持不变。LLM 配置
   通过 :mod:`app.services.settings_store` 写入 ``settings`` 表，与
   :func:`llm_factory.get_llm_client` 读取路径一致，无需重启即可生效
   （下次调用时按需重新构造 :class:`LLMClient`）。
2. **api_key 脱敏**：``GET /api/llm/config`` 返回 ``mask_secret(api_key)``，
   明文密钥永不出现在响应中；``PUT`` 接受明文，加密入库。
3. **请求注册表为内存级**：进程重启后 ``/api/llm/requests`` 返回空列表，
   这是预期行为（前端面板会展示「无活跃请求」）。
4. **取消语义**：``POST .../cancel`` 仅把请求标记为 ``cancelled``，实际
   中断由 :meth:`LLMClient.chat_stream` 在下一个 chunk 边界检查后执行。
   非流式调用无法实时中断，``cancel`` 仅作为「软」标记。返回 ``ok=True/False``
   便于前端区分请求是否存在 / 是否可取消。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as app_settings
from app.db import get_session
from app.services.llm_request_registry import llm_request_registry
from app.services.settings_store import (
    get_secret,
    get_setting,
    mask_secret,
    set_secret,
    set_setting,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# 请求管理
# ============================================================================


@router.get("/llm/requests")
async def list_active_requests() -> dict[str, Any]:
    """返回当前活跃的 LLM 请求列表（status=queued/running）。

    返回结构::

        {
          "requests": [
            {
              "id": str,
              "purpose": str,
              "status": "queued"|"running",
              "started_at": float,
              "node_id": str|null,
              "graph_id": str|null,
              "meta": {...}
            },
            ...
          ],
          "count": int
        }

    按注册时间升序排列。重启后返回空列表。
    """
    items = await llm_request_registry.list_active()
    return {
        "requests": [info.to_dict() for info in items],
        "count": len(items),
    }


@router.get("/llm/requests/all")
async def list_all_requests(limit: int = 50) -> dict[str, Any]:
    """返回最近所有 LLM 请求（含已完成 / 取消 / 失败）。

    Args:
        limit: 截断条数，默认 50，最大 200（避免内存级列表过大）。

    返回结构同 ``GET /api/llm/requests``，但 ``status`` 取值包含所有状态。
    按注册时间降序排列（最新的在前）。
    """
    if limit < 1:
        limit = 1
    if limit > 200:
        limit = 200
    items = await llm_request_registry.list_all(limit=limit)
    return {
        "requests": [info.to_dict() for info in items],
        "count": len(items),
    }


@router.post("/llm/requests/{request_id}/cancel")
async def cancel_request(request_id: str) -> dict[str, Any]:
    """取消指定的 LLM 请求。

    仅对 ``queued`` / ``running`` 状态生效。实际中断由调用方在流式循环
    中检查状态后自行处理；非流式调用无法实时中断。

    返回::

        {"ok": bool, "id": str, "status": str}

    - ``ok=True`` 且 ``status="cancelled"``：取消成功
    - ``ok=False`` 且 ``status="<原状态>"``：请求不存在或已终态（无法取消）
    """
    info = await llm_request_registry.get(request_id)
    if info is None:
        return {"ok": False, "id": request_id, "status": "not_found"}
    success = await llm_request_registry.cancel(request_id)
    return {
        "ok": success,
        "id": request_id,
        "status": "cancelled" if success else info.status,
    }


# ============================================================================
# 配置管理
# ============================================================================


class LlmConfigResponse(BaseModel):
    """LLM 配置响应（api_key 脱敏）。"""

    base_url: str = Field(..., description="OpenAI 兼容 API base URL")
    model: str = Field(..., description="默认对话模型名")
    api_key_masked: str = Field(
        ..., description="API Key 脱敏后的展示值（sk-***1234 形式）"
    )
    api_key_configured: bool = Field(
        ..., description="是否已配置 api_key（脱敏值非空不代表已配置）"
    )
    embedding_model: str = Field("", description="向量化模型名（未配置时为空）")


class LlmConfigUpdate(BaseModel):
    """LLM 配置更新请求。

    所有字段均为可选；未传字段保持原值不变。``api_key`` 接受明文，
    内部加密入库，永远不会原样返回。
    """

    base_url: str | None = Field(
        None, min_length=1, max_length=512, description="OpenAI 兼容 API base URL"
    )
    api_key: str | None = Field(
        None, min_length=1, max_length=2048, description="API Key 明文（加密入库）"
    )
    model: str | None = Field(
        None, min_length=1, max_length=128, description="默认对话模型名"
    )
    embedding_model: str | None = Field(
        None, max_length=128, description="向量化模型名（传空字符串则清空）"
    )


@router.get("/llm/config", response_model=LlmConfigResponse)
async def get_llm_config(
    session: AsyncSession = Depends(get_session),
) -> LlmConfigResponse:
    """返回当前 LLM 配置。

    读取顺序：``settings`` 表 → ``app.config.settings`` 兜底默认值。
    ``api_key`` 永远返回脱敏值（``sk-***1234`` 形式），明文不出现在响应中。
    """
    base_url = await get_setting(
        session, "llm.base_url", app_settings.llm_base_url
    )
    model = await get_setting(session, "llm.model", app_settings.llm_model)
    api_key_plain = await get_secret(
        session, "llm.api_key", app_settings.llm_api_key
    )
    embedding_model = await get_setting(session, "llm.embedding_model", "")

    return LlmConfigResponse(
        base_url=base_url or "",
        model=model or "",
        api_key_masked=mask_secret(api_key_plain),
        api_key_configured=bool(api_key_plain),
        embedding_model=embedding_model or "",
    )


@router.put("/llm/config", response_model=LlmConfigResponse)
async def update_llm_config(
    body: LlmConfigUpdate,
    session: AsyncSession = Depends(get_session),
) -> LlmConfigResponse:
    """更新 LLM 配置（写入 ``settings`` 表，立即生效）。

    - ``base_url`` / ``model`` / ``embedding_model``：明文 JSON 存储。
    - ``api_key``：加密后存储（``settings_store.set_secret``）。

    所有字段为可选；未传字段保持原值。``embedding_model`` 传空字符串视为
    清空该配置（回退到 ``text-embedding-3-small`` 默认值）。

    配置更新后无需重启：:func:`llm_factory.get_llm_client` 每次调用都会
    从 ``settings`` 表重新读取并构造 :class:`LLMClient`，下次 LLM 请求
    即使用新配置。
    """
    if body.base_url is not None:
        await set_setting(session, "llm.base_url", body.base_url)
    if body.model is not None:
        await set_setting(session, "llm.model", body.model)
    if body.api_key is not None:
        await set_secret(session, "llm.api_key", body.api_key)
    if body.embedding_model is not None:
        await set_setting(session, "llm.embedding_model", body.embedding_model)

    await session.commit()
    logger.info(
        "LLM 配置已更新: base_url=%s model=%s api_key_changed=%s embedding_model_changed=%s",
        body.base_url or "(unchanged)",
        body.model or "(unchanged)",
        body.api_key is not None,
        body.embedding_model is not None,
    )

    # 复用 GET 逻辑返回最新配置
    return await get_llm_config(session)  # type: ignore[arg-type]


# ============================================================================
# 连接测试
# ============================================================================


class LlmTestConnectionRequest(BaseModel):
    """LLM 连接测试请求（所有字段可选，未传则用已保存配置）。

    用于「测试连接」按钮：用户可在保存前填入新的 base_url / api_key / model，
    后端用这些临时值构造客户端并发送一条极简消息验证连通性。未传字段回退
    到 ``settings`` 表已保存的值，便于对已保存配置做连通性复查。
    """

    base_url: str | None = Field(
        None, min_length=1, max_length=512, description="测试用 base_url，未传则用已保存值"
    )
    api_key: str | None = Field(
        None, min_length=1, max_length=2048, description="测试用 api_key 明文，未传则用已保存值"
    )
    model: str | None = Field(
        None, min_length=1, max_length=128, description="测试用 model，未传则用已保存值"
    )


class LlmTestConnectionResponse(BaseModel):
    """LLM 连接测试响应。"""

    ok: bool = Field(..., description="连接是否成功")
    latency_ms: int = Field(..., description="请求耗时（毫秒）")
    model: str = Field(..., description="实际测试使用的模型名")
    base_url: str = Field(..., description="实际测试使用的 base_url")
    message: str = Field(..., description="结果说明（成功/失败原因）")
    reply: str = Field("", description="模型回复内容（成功时，截断 200 字）")


@router.post("/llm/test-connection", response_model=LlmTestConnectionResponse)
async def test_llm_connection(
    body: LlmTestConnectionRequest,
    session: AsyncSession = Depends(get_session),
) -> LlmTestConnectionResponse:
    """测试 LLM 连接是否可用（不抛 HTTP 异常，结果通过 ``ok`` 字段返回）。

    流程：
    1. 解析有效配置：请求体字段 > ``settings`` 表已保存值 > ``app_settings`` 兜底；
    2. 任一缺失则返回 ``ok=False`` 并列出缺失项；
    3. 构造测试用 :class:`LLMClient`（``max_output_tokens=16`` 保证响应快速）；
    4. 发送极简消息 ``ping``，按返回/异常类型映射为可读 ``message``。

    所有错误（鉴权 / 网络 / 限流 / 服务端）均通过 ``ok=False`` + ``message`` 返回，
    便于前端在「测试连接」按钮旁统一展示结果，不触发全局错误 Toast。
    """
    import time

    from app.services.llm_client import LLMClient
    from app.services.llm_errors import (
        LLMAuthError,
        LLMConnectionError,
        LLMError,
        LLMRateLimitError,
        LLMServerError,
    )

    # 解析有效配置：请求体 > 已保存 > app_settings 兜底
    base_url = body.base_url or await get_setting(
        session, "llm.base_url", app_settings.llm_base_url
    )
    api_key = body.api_key or await get_secret(
        session, "llm.api_key", app_settings.llm_api_key
    )
    model = body.model or await get_setting(
        session, "llm.model", app_settings.llm_model
    )

    if not base_url or not api_key or not model:
        missing = [
            name
            for name, val in [
                ("base_url", base_url),
                ("api_key", api_key),
                ("model", model),
            ]
            if not val
        ]
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=0,
            model=model or "",
            base_url=base_url or "",
            message=f"配置不完整，缺少：{', '.join(missing)}",
        )

    # 构造测试用客户端：max_output_tokens=16 保证响应快速
    client = LLMClient(
        base_url=base_url,
        api_key=api_key,
        model=model,
        max_output_tokens=16,
        default_temperature=0.0,
    )

    start = time.monotonic()
    try:
        result = await client.chat(
            messages=[{"role": "user", "content": "ping"}],
            temperature=0.0,
        )
    except LLMAuthError as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"鉴权失败：{exc.message}（请检查 API Key）",
        )
    except LLMConnectionError as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"连接失败：{exc.message}（请检查 base_url 与网络）",
        )
    except LLMRateLimitError as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"被限流：{exc.message}（请稍后重试）",
        )
    except LLMServerError as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"服务端错误：{exc.message}",
        )
    except LLMError as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"LLM 请求失败：{exc.message}",
        )
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.monotonic() - start) * 1000)
        return LlmTestConnectionResponse(
            ok=False,
            latency_ms=latency_ms,
            model=model,
            base_url=base_url,
            message=f"未知错误：{exc}",
        )

    latency_ms = int((time.monotonic() - start) * 1000)
    reply = (result.get("content") or "").strip()
    logger.info(
        "LLM 连接测试成功: model=%s latency_ms=%d reply=%s",
        model,
        latency_ms,
        reply[:60],
    )
    return LlmTestConnectionResponse(
        ok=True,
        latency_ms=latency_ms,
        model=model,
        base_url=base_url,
        message=f"连接成功（耗时 {latency_ms}ms）",
        reply=reply[:200],
    )


# ============================================================================
# 维护：清理过期请求（可选，供前端主动触发或后续接入定时任务）
# ============================================================================


@router.post("/llm/requests/cleanup")
async def cleanup_old_requests(max_age: int = 300) -> dict[str, Any]:
    """清理超过 ``max_age`` 秒的终态请求（completed/cancelled/failed）。

    默认 300 秒（5 分钟）。供前端调试用，后续可由 lifespan 后台任务
    定期调用。

    返回::

        {"removed": int, "max_age": int}
    """
    if max_age < 0:
        raise HTTPException(status_code=400, detail="max_age 不能为负数")
    removed = await llm_request_registry.cleanup_old(max_age=float(max_age))
    return {"removed": removed, "max_age": max_age}

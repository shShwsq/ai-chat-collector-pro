"""LLM 客户端工厂：从 settings 表读取配置并构造 ``LLMClient``。

对外暴露：
- ``get_llm_client(session) -> LLMClient``：读取 ``llm.base_url`` / ``llm.api_key``
  （解密）/ ``llm.model``，若任一缺失抛出 ``HTTPException(400)``。
- 模型属性（``max_output_tokens`` / ``default_temperature``）从
  :mod:`app.services.model_config` 的 ``ModelConfigRegistry`` 读取。
- ``context_window`` **不传给 LLMClient**：由用户在 Ollama Modelfile 中
  自行配置，后端仅在 ``ContextManager`` 层记录用于触发压缩 / rebuild。

本项目从步影 backend/app/services/llm_factory.py 适配拷贝而来，
依赖 settings_store / llm_client / model_config 均已就位。
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as app_settings
from app.services.llm_client import LLMClient
from app.services.model_config import get_model_config
from app.services.settings_store import get_secret, get_setting

# 向量化模型 settings key（可选）
_EMBEDDING_MODEL_KEY = "llm.embedding_model"


async def get_llm_client(session: AsyncSession) -> LLMClient:
    """从 settings 表读取 LLM 配置并返回 ``LLMClient`` 实例。

    Args:
        session: 数据库 AsyncSession。

    Returns:
        配置好的 ``LLMClient``（含 ``max_output_tokens`` / ``default_temperature``
        从 ``model_config.json`` 读取）。

    Raises:
        HTTPException(400): base_url / api_key / model 任一为空时抛出。
    """
    base_url = await get_setting(session, "llm.base_url", app_settings.llm_base_url)
    api_key = await get_secret(session, "llm.api_key", app_settings.llm_api_key)
    model = await get_setting(session, "llm.model", app_settings.llm_model)
    embedding_model = await get_setting(session, _EMBEDDING_MODEL_KEY, "")

    if not base_url or not api_key or not model:
        raise HTTPException(
            status_code=400,
            detail="LLM 未配置，请先在设置中填入 baseURL/apiKey/model",
        )

    # 从模型配置注册表读取模型属性
    # context_window 不传给 LLMClient（由用户在 Ollama Modelfile 中配置）
    model_cfg = get_model_config(model)

    return LLMClient(
        base_url=base_url,
        api_key=api_key,
        model=model,
        embedding_model=embedding_model or None,
        max_output_tokens=model_cfg.get("max_output_tokens"),
        default_temperature=model_cfg.get("default_temperature"),
    )

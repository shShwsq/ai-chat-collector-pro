"""模型配置注册表：从 ``backend/data/model_config.json`` 加载并缓存。

提供全局单例 ``_REGISTRY``，代码通过 ``get_model_config(model_name)`` 访问。
启动时由 ``app/main.py`` 调用 ``_REGISTRY.load()`` 加载；运行时可调用
``reload_model_config()`` 重载（配合 ``POST /api/config/models/reload``）。

模型配置用于：
1. ``LLMClient`` 构造时读取 ``max_output_tokens`` / ``default_temperature``
   （``context_window`` 不下发给 Ollama，由用户在 Modelfile 中自行配置）
2. ``ContextManager.model_window`` 决策何时触发压缩 / rebuild
3. 前端 UI 在设置页显示模型下拉列表
4. ``PATCH /api/config/llm`` 在 ``context_window < 8192`` 时返回 warning

配置优先级（高 → 低）：
1. DB settings 表的 ``llm.context_window``（运行时覆盖，由 PATCH /api/config/llm 设置）
2. ``model_config.json`` 中该模型的 ``context_window``
3. ``model_config.json`` 中 ``default`` 条目的 ``context_window``
4. 硬编码兜底（8192）
"""

from __future__ import annotations

import json
import logging
from threading import RLock
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# 配置文件路径：backend/data/model_config.json
_CONFIG_PATH = settings.data_dir / "model_config.json"

# 上下文长度推荐下限：低于此值会在 API 响应中返回 warning
MIN_RECOMMENDED_CONTEXT_WINDOW = 8192

# 硬编码兜底配置（文件不存在或解析失败时使用）
_FALLBACK_DEFAULT: dict[str, Any] = {
    "context_window": 8192,
    "max_output_tokens": 4096,
    "default_temperature": 0.7,
    "supports_tools": True,
    "supports_streaming": True,
    "vendor": "openai",
    "description": "硬编码兜底配置",
}


class ModelConfigRegistry:
    """单例注册表：模型名 → 配置 dict。

    线程安全（``RLock`` 保护读写）。启动时由 ``main.py`` 调用 ``load()``；
    首次访问时若未加载会自动调用 ``load()``。
    """

    def __init__(self) -> None:
        self._lock = RLock()
        self._models: dict[str, dict[str, Any]] = {}
        self._loaded: bool = False

    def load(self) -> None:
        """从 ``_CONFIG_PATH`` 加载配置。

        文件不存在或解析失败时回退到 ``_FALLBACK_DEFAULT``，不抛异常，
        确保后端能启动（仅记录 warning/error 日志）。
        """
        with self._lock:
            if not _CONFIG_PATH.exists():
                logger.warning(
                    "model_config.json 不存在，使用硬编码兜底: %s", _CONFIG_PATH
                )
                self._models = {"default": dict(_FALLBACK_DEFAULT)}
                self._loaded = True
                return
            try:
                data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
                models = data.get("models", {}) if isinstance(data, dict) else {}
                # 确保有 default 条目
                if "default" not in models:
                    logger.info(
                        "model_config.json 缺少 default 条目，使用硬编码兜底"
                    )
                    models["default"] = dict(_FALLBACK_DEFAULT)
                self._models = models
                self._loaded = True
                logger.info(
                    "model_config.json 已加载，共 %d 个模型: %s",
                    len(self._models),
                    list(self._models.keys()),
                )
            except (json.JSONDecodeError, OSError) as exc:
                logger.error(
                    "model_config.json 加载失败，使用硬编码兜底: %s", exc
                )
                self._models = {"default": dict(_FALLBACK_DEFAULT)}
                self._loaded = True

    def reload(self) -> None:
        """重新加载配置文件（运行时编辑后调用）。

        与 ``load()`` 相同，只是语义上表示"重新加载"。
        """
        self._loaded = False
        self.load()

    def get(self, model_name: str) -> dict[str, Any]:
        """查找模型配置。

        Args:
            model_name: 模型名（如 ``"qwen3.5-9b-uncensored-hauhaucs-aggressive"``）

        Returns:
            模型配置 dict 的副本（调用方可安全修改）。
            未命中时返回 ``default`` 条目；``default`` 也缺失返回 ``_FALLBACK_DEFAULT``。
        """
        if not self._loaded:
            self.load()
        with self._lock:
            if model_name in self._models:
                return dict(self._models[model_name])
            logger.info(
                "模型 %s 未在 model_config.json 中声明，使用 default", model_name
            )
            return dict(self._models.get("default") or _FALLBACK_DEFAULT)

    def list_models(self) -> list[dict[str, Any]]:
        """列出所有已声明的模型（含 default）。

        Returns:
            模型配置列表，每项含 ``name`` 字段 + 该模型的所有配置字段。
        """
        if not self._loaded:
            self.load()
        with self._lock:
            return [
                {"name": name, **cfg} for name, cfg in self._models.items()
            ]

    def get_context_warning(self, context_window: int | None) -> str | None:
        """检查 context_window 是否低于推荐值，返回 warning 字符串。

        Args:
            context_window: 待检查的上下文长度。

        Returns:
            warning 字符串（低于推荐值时）或 None（正常或为空）。
        """
        if context_window is None or context_window <= 0:
            return None
        if context_window < MIN_RECOMMENDED_CONTEXT_WINDOW:
            return (
                f"上下文长度 {context_window} 低于推荐值 "
                f"{MIN_RECOMMENDED_CONTEXT_WINDOW}，可能影响使用"
                "（系统提示词 + 多轮对话易超限）。"
                "建议在 Ollama Modelfile 中设置 PARAMETER num_ctx >= "
                f"{MIN_RECOMMENDED_CONTEXT_WINDOW}"
            )
        return None


# ============================================================================
# 全局单例 + 模块级便捷访问函数
# ============================================================================

_REGISTRY = ModelConfigRegistry()


def get_model_config(model_name: str) -> dict[str, Any]:
    """返回指定模型的配置 dict（未命中返回 default）。"""
    return _REGISTRY.get(model_name)


def list_available_models() -> list[dict[str, Any]]:
    """列出所有已声明的模型（含 default）。"""
    return _REGISTRY.list_models()


def reload_model_config() -> None:
    """重载 model_config.json（运行时编辑后调用）。"""
    _REGISTRY.reload()


def get_context_window_warning(context_window: int | None) -> str | None:
    """检查 context_window 是否低于推荐值，返回 warning 字符串。"""
    return _REGISTRY.get_context_warning(context_window)

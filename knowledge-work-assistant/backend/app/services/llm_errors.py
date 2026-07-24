"""LLM 客户端自定义异常体系。

所有 LLM 相关错误均继承自 ``LLMError``，便于上层统一捕获。
异常映射策略（由调用方按需转换为 HTTP 状态码或 WS 错误事件）：

- ``LLMConfigError``    配置缺失（base_url / api_key / model 未填写）
- ``LLMAuthError``       401 / 403 鉴权失败，不重试
- ``LLMRateLimitError``  429 限流，已耗尽重试次数
- ``LLMServerError``     5xx 服务端错误，已耗尽重试次数
- ``LLMConnectionError`` 网络连接 / 超时错误，已耗尽重试次数
- ``LLMStreamError``     流式响应中途中断
"""

from __future__ import annotations


class LLMError(Exception):
    """LLM 错误基类。"""

    def __init__(self, message: str = "", *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code

    def __str__(self) -> str:
        return self.message or self.__class__.__name__


class LLMConfigError(LLMError):
    """LLM 配置缺失或无效（base_url / api_key / model 未填写）。"""


class LLMAuthError(LLMError):
    """LLM 鉴权失败（401 / 403），不重试。"""

    def __init__(self, message: str = "", *, status_code: int = 401) -> None:
        super().__init__(message, status_code=status_code)


class LLMRateLimitError(LLMError):
    """LLM 限流（429），已耗尽重试次数。"""

    def __init__(self, message: str = "", *, status_code: int = 429) -> None:
        super().__init__(message, status_code=status_code)


class LLMConnectionError(LLMError):
    """LLM 网络连接 / 超时错误，已耗尽重试次数。"""

    def __init__(self, message: str = "", *, status_code: int = 503) -> None:
        super().__init__(message, status_code=status_code)


class LLMServerError(LLMError):
    """LLM 服务端错误（5xx），已耗尽重试次数。"""

    def __init__(self, message: str = "", *, status_code: int = 502) -> None:
        super().__init__(message, status_code=status_code)


class LLMStreamError(LLMError):
    """LLM 流式响应中途中断（连接断开 / 协议错误）。"""

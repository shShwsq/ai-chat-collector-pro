"""OpenAI 兼容 LLM 客户端。

基于 ``openai.AsyncOpenAI`` 实现流式 / 非流式对话与向量化，
封装统一的错误处理与重试策略：

- 网络错误（``httpx.ConnectError`` / ``httpx.ReadTimeout``）：最多重试 3 次，指数退避 1s/2s/4s
- 429 限流：尊重 ``Retry-After`` header（无则默认 5s），最多重试 2 次
- 401 / 403 鉴权错误：不重试，立即抛出 ``LLMAuthError``
- 其他 5xx：重试 2 次，指数退避
- 流式响应中途中断：抛出 ``LLMStreamError``，由调用方处理

事件流（``chat_stream`` 产出）：
    {"type": "token", "content": "..."}          内容增量
    {"type": "tool_call", "id": "...", "name": "...", "arguments": "..."}
                                                  工具调用（聚合 deltas 后产出完整 tool_call）
    {"type": "finish", "reason": "stop"|"tool_calls"|"length"|...}
                                                  完成原因
    {"type": "cancelled"}                        请求被外部取消
                                                 （仅当 request_id 传入且被 cancel 时）

请求注册表集成（可选）：
    调用方可在 ``chat`` / ``chat_stream`` / ``embed`` 传入 ``request_id`` 关联
    :mod:`app.services.llm_request_registry` 中的请求条目。流式调用会在每个
    chunk 边界检查 ``is_cancelled``，被取消时主动中断并产出 ``cancelled`` 事件，
    便于上层（如 ``graph_agent``）传递给前端。
"""

from __future__ import annotations

import asyncio
import email.utils
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any

import httpx
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)

from app.services.llm_errors import (
    LLMAuthError,
    LLMConnectionError,
    LLMError,
    LLMRateLimitError,
    LLMServerError,
    LLMStreamError,
)
from app.services.llm_request_registry import llm_request_registry

logger = logging.getLogger(__name__)

# 重试次数上限
_NETWORK_RETRIES = 3   # 网络错误（连接 / 超时）
_RATE_LIMIT_RETRIES = 2  # 429 限流
_SERVER_RETRIES = 2    # 5xx 服务端错误

# 默认退避基数（秒）
_DEFAULT_RATE_LIMIT_WAIT = 5.0
_DEFAULT_SERVER_BACKOFF = 1.0


class LLMClient:
    """OpenAI 兼容 LLM 客户端，封装对话 / 流式 / 向量化与重试。

    Args:
        base_url: OpenAI 兼容 API base URL（如 ``https://api.openai.com/v1``）
        api_key:  API Key 明文
        model:    默认对话模型名（如 ``gpt-4o-mini``）
        embedding_model: 向量化模型名，为空时回退到 ``text-embedding-3-small``
        max_output_tokens: 单次响应最大输出 tokens（传给 OpenAI 的 ``max_tokens``）。
            None 时不传 ``max_tokens``，由模型默认值决定。
        default_temperature: 默认采样温度，未显式传 temperature 时使用。
            None 时回退到 0.7。

    Note:
        ``context_window`` **不在 LLMClient 中传递**。上下文窗口由用户在
        Ollama Modelfile 中通过 ``PARAMETER num_ctx <值>`` 配置，后端仅在
        ``ContextManager`` 层记录该值用于触发压缩 / rebuild 决策。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        embedding_model: str | None = None,
        max_output_tokens: int | None = None,
        default_temperature: float | None = None,
    ) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.embedding_model = embedding_model or "text-embedding-3-small"
        self.max_output_tokens = max_output_tokens
        self.default_temperature = (
            default_temperature if default_temperature is not None else 0.7
        )
        # 构造 AsyncOpenAI 客户端，设置合理超时
        self._client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=httpx.Timeout(180.0, connect=10.0),
            max_retries=0,  # 由本类自行管理重试
        )
        # 本地 LLM 服务（如 LM Studio）通常无法并发处理多个大上下文请求，
        # 使用信号量将所有对话请求串行化。
        self._semaphore = asyncio.Semaphore(1)

    # ========================================================================
    # 公开方法
    # ========================================================================

    async def chat_stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        *,
        request_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式对话，逐 chunk 产出事件。

        产出的事件类型见模块文档字符串。
        工具调用的 deltas 按 ``index`` 聚合，在流结束（finish_reason 到达）后
        统一产出完整的 tool_call 事件。

        Args:
            messages: OpenAI 消息列表。
            tools:    工具 schema 列表（OpenAI function calling 格式）。
            temperature: 采样温度；None 时用 ``self.default_temperature``。
            request_id: 关联 :data:`llm_request_registry` 中的请求 id（可选）。
                传入后会在发起前更新状态为 ``running``，在每个 chunk 边界检查
                是否被取消；被取消时主动中断并产出 ``{"type": "cancelled"}`` 事件，
                同时把注册表状态更新为 ``cancelled``。调用方需在 ``finally`` 中
                捕获 ``cancelled`` 事件后清理自身资源。
        """
        temp = temperature if temperature is not None else self.default_temperature
        async with self._semaphore:
            kwargs: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "temperature": temp,
                "stream": True,
            }
            if tools:
                kwargs["tools"] = tools
            if self.max_output_tokens:
                kwargs["max_tokens"] = self.max_output_tokens
            # 注意：不传递 num_ctx / extra_body，由用户在 Ollama Modelfile 中自行配置

            # 注册表：进入 running 状态（HTTP 请求即将发起）
            if request_id is not None:
                await llm_request_registry.update(request_id, "running")

            # 初始连接走重试逻辑
            stream = await self._call_with_retry(
                lambda: self._client.chat.completions.create(**kwargs)
            )

            # tool_calls 聚合桶：index -> {"id", "name", "arguments"}
            tool_calls_acc: dict[int, dict[str, str]] = {}
            finish_reason: str | None = None
            cancelled = False

            try:
                async for chunk in stream:
                    # 在每个 chunk 边界检查取消标记
                    if request_id is not None and await llm_request_registry.is_cancelled(
                        request_id
                    ):
                        cancelled = True
                        break
                    if not chunk.choices:
                        continue
                    choice = chunk.choices[0]
                    delta = choice.delta

                    # 正文内容增量（仅 content 字段）
                    # reasoning_content（思维链）单独产出为 thinking 事件，
                    # 不与正文混在一起，便于前端独立折叠展示。
                    text = delta.content or ""
                    if text:
                        yield {"type": "token", "content": text}

                    # 思维链增量（reasoning 模型如 DeepSeek-R1 / Qwen-QwQ）
                    reasoning = getattr(delta, "reasoning_content", None)
                    if reasoning:
                        yield {"type": "thinking", "content": reasoning}

                    # 工具调用 delta 聚合
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            idx = tc.index
                            slot = tool_calls_acc.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.id:
                                slot["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    slot["name"] = tc.function.name
                                if tc.function.arguments:
                                    slot["arguments"] += tc.function.arguments

                    if choice.finish_reason:
                        finish_reason = choice.finish_reason
            except (APIConnectionError, APITimeoutError) as exc:
                if request_id is not None:
                    await llm_request_registry.update(
                        request_id, "failed", error=f"流式响应中断（网络错误）: {exc}"
                    )
                raise LLMStreamError(f"流式响应中断（网络错误）: {exc}") from exc
            except httpx.HTTPError as exc:
                if request_id is not None:
                    await llm_request_registry.update(
                        request_id, "failed", error=f"流式响应中断（HTTP 错误）: {exc}"
                    )
                raise LLMStreamError(f"流式响应中断（HTTP 错误）: {exc}") from exc
            except Exception as exc:
                # 非预期错误也视作流中断，避免裸异常外泄
                if isinstance(exc, LLMError):
                    if request_id is not None:
                        await llm_request_registry.update(
                            request_id, "failed", error=str(exc)
                        )
                    raise
                if request_id is not None:
                    await llm_request_registry.update(
                        request_id, "failed", error=f"流式响应中断: {exc}"
                    )
                raise LLMStreamError(f"流式响应中断: {exc}") from exc
            finally:
                # 显式关闭流，释放底层连接
                # 捕获 BaseException（包括 GeneratorExit）确保在 aclose 触发时也能关闭
                close = getattr(stream, "aclose", None)
                if close is not None:
                    try:
                        await close()
                    except BaseException:
                        pass

            if cancelled:
                # 注册表状态由 cancel() 已写入，这里只产出事件通知上层
                yield {"type": "cancelled"}
                return

            # 流正常结束：产出聚合后的完整 tool_call 事件
            for idx in sorted(tool_calls_acc):
                slot = tool_calls_acc[idx]
                yield {
                    "type": "tool_call",
                    "id": slot["id"],
                    "name": slot["name"],
                    "arguments": slot["arguments"],
                }

            # 完成事件
            yield {"type": "finish", "reason": finish_reason or "stop"}
            if request_id is not None:
                await llm_request_registry.update(request_id, "completed")

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        *,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """非流式对话，返回完整 message + tool_calls + finish_reason。

        Args:
            messages: OpenAI 消息列表。
            tools:    工具 schema 列表。
            temperature: 采样温度；None 时用 ``self.default_temperature``。
            request_id: 关联注册表请求 id（可选）。非流式调用一旦发起 HTTP 请求
                即不可中断，此处仅在调用前后更新状态：进入 ``running`` /
                ``completed`` / ``failed``，便于前端看到请求生命周期。
        """
        temp = temperature if temperature is not None else self.default_temperature
        async with self._semaphore:
            kwargs: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "temperature": temp,
                "stream": False,
            }
            if tools:
                kwargs["tools"] = tools
            if self.max_output_tokens:
                kwargs["max_tokens"] = self.max_output_tokens
            # 注意：不传递 num_ctx / extra_body，由用户在 Ollama Modelfile 中自行配置

            if request_id is not None:
                await llm_request_registry.update(request_id, "running")

            try:
                response = await self._call_with_retry(
                    lambda: self._client.chat.completions.create(**kwargs)
                )
            except Exception as exc:
                if request_id is not None:
                    await llm_request_registry.update(
                        request_id, "failed", error=str(exc)
                    )
                raise

            choice = response.choices[0]
            message = choice.message
            tool_calls_out: list[dict[str, Any]] = []
            if message.tool_calls:
                for tc in message.tool_calls:
                    tool_calls_out.append(
                        {
                            "id": tc.id,
                            "name": tc.function.name if tc.function else "",
                            "arguments": tc.function.arguments if tc.function else "",
                        }
                    )
            # 非流式响应：content 仅为正文，reasoning_content 单独放到 thinking 字段
            # （避免思维链污染正文，与流式版本行为对齐）
            content = message.content or ""
            thinking = getattr(message, "reasoning_content", None) or ""
            if request_id is not None:
                await llm_request_registry.update(request_id, "completed")
            return {
                "content": content,
                "thinking": thinking,
                "tool_calls": tool_calls_out,
                "finish_reason": choice.finish_reason,
            }

    async def embed(self, text: str, *, request_id: str | None = None) -> list[float]:
        """调用 embeddings 端点向量化文本（用于 RAG）。

        model 优先用构造时传入的 ``embedding_model``，否则回退到
        ``text-embedding-3-small``。

        Args:
            text: 待向量化的文本。
            request_id: 关联注册表请求 id（可选），用于状态追踪。
        """
        if request_id is not None:
            await llm_request_registry.update(request_id, "running")
        try:
            response = await self._call_with_retry(
                lambda: self._client.embeddings.create(
                    model=self.embedding_model,
                    input=text,
                )
            )
        except Exception as exc:
            if request_id is not None:
                await llm_request_registry.update(
                    request_id, "failed", error=str(exc)
                )
            raise
        if request_id is not None:
            await llm_request_registry.update(request_id, "completed")
        return list(response.data[0].embedding)

    # ========================================================================
    # 重试逻辑
    # ========================================================================

    async def _call_with_retry(
        self,
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> Any:
        """执行带重试的 API 调用。

        按错误类型分别计数：
        - 网络错误（连接 / 超时）：最多 ``_NETWORK_RETRIES`` 次，指数退避 1s/2s/4s
        - 429 限流：最多 ``_RATE_LIMIT_RETRIES`` 次，尊重 Retry-After
        - 5xx：最多 ``_SERVER_RETRIES`` 次，指数退避
        - 401 / 403：不重试，立即抛出 ``LLMAuthError``
        """
        network_attempts = 0
        rate_limit_attempts = 0
        server_attempts = 0

        while True:
            try:
                return await coro_factory()
            except (AuthenticationError, PermissionDeniedError) as exc:
                status = getattr(exc, "status_code", None) or 401
                raise LLMAuthError(
                    f"LLM 鉴权失败（{status}）: {self._extract_message(exc)}",
                    status_code=status,
                ) from exc
            except RateLimitError as exc:
                if rate_limit_attempts >= _RATE_LIMIT_RETRIES:
                    raise LLMRateLimitError(
                        f"LLM 限流，已重试 {rate_limit_attempts} 次仍失败: "
                        f"{self._extract_message(exc)}"
                    ) from exc
                rate_limit_attempts += 1
                wait = self._extract_retry_after(exc) or _DEFAULT_RATE_LIMIT_WAIT
                await asyncio.sleep(wait)
            except APITimeoutError as exc:
                if network_attempts >= _NETWORK_RETRIES:
                    raise LLMConnectionError(
                        f"LLM 请求超时，已重试 {network_attempts} 次仍失败: "
                        f"{self._extract_message(exc)}"
                    ) from exc
                network_attempts += 1
                await asyncio.sleep(2 ** (network_attempts - 1))
            except APIConnectionError as exc:
                if network_attempts >= _NETWORK_RETRIES:
                    raise LLMConnectionError(
                        f"LLM 连接失败，已重试 {network_attempts} 次仍失败: "
                        f"{self._extract_message(exc)}"
                    ) from exc
                network_attempts += 1
                await asyncio.sleep(2 ** (network_attempts - 1))
            except APIStatusError as exc:
                code = exc.status_code
                if 500 <= code < 600:
                    if server_attempts >= _SERVER_RETRIES:
                        raise LLMServerError(
                            f"LLM 服务端错误（{code}），已重试 "
                            f"{server_attempts} 次仍失败: "
                            f"{self._extract_message(exc)}",
                            status_code=502,
                        ) from exc
                    server_attempts += 1
                    await asyncio.sleep(_DEFAULT_SERVER_BACKOFF * (2 ** (server_attempts - 1)))
                else:
                    # 其他 4xx（非 401/403/429）不重试
                    raise LLMError(
                        f"LLM 请求失败（{code}）: {self._extract_message(exc)}",
                        status_code=code,
                    ) from exc
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.ReadError) as exc:
                # 兜底：底层 httpx 错误未被子类捕获时
                if network_attempts >= _NETWORK_RETRIES:
                    raise LLMConnectionError(
                        f"LLM 网络错误，已重试 {network_attempts} 次仍失败: {exc}"
                    ) from exc
                network_attempts += 1
                await asyncio.sleep(2 ** (network_attempts - 1))

    # ========================================================================
    # 辅助
    # ========================================================================

    @staticmethod
    def _extract_message(exc: Exception) -> str:
        """从 openai 异常中提取可读消息。"""
        msg = getattr(exc, "message", None) or str(exc)
        return msg or exc.__class__.__name__

    @staticmethod
    def _extract_retry_after(exc: RateLimitError) -> float | None:
        """从 429 响应中解析 Retry-After header（秒）。

        支持整数秒与 HTTP 日期两种格式；无法解析时返回 None。
        """
        response = getattr(exc, "response", None)
        if response is None:
            return None
        headers = getattr(response, "headers", None)
        if not headers:
            return None
        raw = headers.get("retry-after") or headers.get("Retry-After")
        if not raw:
            return None
        # 尝试整数秒
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            pass
        # 尝试 HTTP 日期
        try:
            dt = email.utils.parsedate_to_datetime(raw)
            if dt is None:
                return None
            import datetime as _dt

            now = _dt.datetime.now(dt.tzinfo) if dt.tzinfo else _dt.datetime.utcnow()
            delta = (dt - now).total_seconds()
            return max(0.0, delta)
        except (TypeError, ValueError, OverflowError):
            return None

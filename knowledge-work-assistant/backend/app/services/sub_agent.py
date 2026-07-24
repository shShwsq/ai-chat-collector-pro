"""子 Agent 与生命周期管理。

提供任务型子 Agent 的创建/销毁框架，与主 Agent 上下文完全隔离：

- :class:`SubAgent`：一次性任务型 Agent。持有独立 messages 列表（不与主 Agent 共享
  可变状态）与独立 :class:`LLMClient` 实例（同一份配置，新实例）。通过 :meth:`run`
  流式产出 ``token`` / ``tool_call`` / ``done`` 事件，完成后自动流转 ``status``。
- :class:`SubAgentManager`：管理所有活跃子 Agent 的注册表，提供
  ``create`` / ``get`` / ``list_active`` / ``cleanup_finished``。
- 全局单例 :data:`sub_agent_manager`。

设计要点：

1. **上下文隔离**：从 ``parent_context`` 拷贝**最近 N 条**作为种子，深拷贝避免共享
   可变结构；主 Agent 后续修改不会影响已派发的子 Agent。
2. **LLMClient 独立实例**：``LLMClient`` 本身无状态（仅封装 AsyncOpenAI），
   规范要求子 Agent 持有独立实例，故用同一份配置构造新的 ``LLMClient``。
3. **一次性任务**：``run`` 完成后立即 ``status="completed"``；``cleanup_finished``
   负责定期清理超过 ``max_age_seconds`` 的已结束记录，避免内存泄漏。
4. **取消语义**：``cancel()`` 通过 ``asyncio.Event`` 通知正在 ``run`` 的协程，
   下一次事件循环检查时退出并标记 ``status="cancelled"``。

本项目从步影 backend/app/services/sub_agent.py 适配拷贝而来，
依赖 llm_client / llm_errors 均已就位，可独立运行。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any

from app.services.llm_client import LLMClient
from app.services.llm_errors import LLMError

logger = logging.getLogger(__name__)

# 子 agent 从 parent_context 中拷贝的最近消息条数（种子上下文）
DEFAULT_PARENT_CONTEXT_SEED = 6

# 工具执行器签名：(tool_name, tool_args) -> result_dict
ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

# 默认工具循环最大轮数（防止无限循环）
_DEFAULT_MAX_TOOL_ITERATIONS = 5

# 工具结果回填的最大字符数（避免过长结果撑爆子 Agent 上下文）
_DEFAULT_TOOL_RESULT_MAX_CHARS = 2000

# 状态枚举（字符串常量，便于序列化与外部判断）
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

# 终态集合
_DONE_STATUSES = frozenset({STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED})


def _clone_llm_client(source: LLMClient) -> LLMClient:
    """用同一份配置构造新的 :class:`LLMClient` 实例。

    ``LLMClient`` 内部持有 ``AsyncOpenAI`` 客户端，非共享资源；克隆配置构造独立
    实例可彻底避免任何潜在的状态泄漏（即便 ``LLMClient`` 本身无状态）。

    同步 ``max_output_tokens`` / ``default_temperature``，确保 SubAgent 与
    主 Agent 使用一致的模型属性（来自 ``model_config.json``）。
    """
    return LLMClient(
        base_url=source.base_url,
        api_key=source.api_key,
        model=source.model,
        embedding_model=source.embedding_model,
        max_output_tokens=source.max_output_tokens,
        default_temperature=source.default_temperature,
    )


class SubAgent:
    """任务型子 Agent。

    一次 :meth:`run` 调用即一次完整任务，结束后 ``status`` 流转到
    ``completed`` / ``failed`` / ``cancelled``。持有：

    - 独立 ``messages`` 列表（system + 从 parent_context 拷贝的种子 + 本次 user）
    - 独立 :class:`LLMClient` 实例
    - ``created_at`` / ``completed_at`` / ``status`` 状态字段

    Args:
        agent_id: 唯一 ID（由 :class:`SubAgentManager.create` 用 ``uuid4().hex`` 注入）。
        agent_type: 类型标签，如 ``"summarize"`` / ``"search"`` / ``"writer"``。
        llm_client: 主 Agent 的 :class:`LLMClient`（仅用于读取配置，本类会构造独立实例）。
        system_prompt: 子 Agent 的系统提示词。
        parent_context: 主 Agent 最近上下文，将从中拷贝最近 ``seed_count`` 条作为种子。
        seed_count: 从 ``parent_context`` 末尾拷贝的消息条数，默认 6。
    """

    def __init__(
        self,
        agent_id: str,
        agent_type: str,
        llm_client: LLMClient,
        system_prompt: str,
        parent_context: list[dict[str, Any]] | None = None,
        *,
        seed_count: int = DEFAULT_PARENT_CONTEXT_SEED,
    ) -> None:
        self.agent_id: str = agent_id
        self.agent_type: str = agent_type
        # 独立 LLMClient 实例（同一配置）
        self.llm_client: LLMClient = _clone_llm_client(llm_client)
        self.system_prompt: str = system_prompt

        # 独立 messages 列表：system + 从 parent_context 拷贝的最近若干条
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt}
        ]
        if parent_context:
            seed = parent_context[-seed_count:] if seed_count > 0 else parent_context
            # 深拷贝避免共享可变结构（content 可能是 list/dict）
            self.messages.extend(copy.deepcopy(seed))

        # 状态字段
        self.created_at: float = time.time()
        self.completed_at: float | None = None
        self.status: str = STATUS_RUNNING

        # 工具循环结果（供调用方在 run 完成后读取）
        self.tool_calls_used: list[dict[str, Any]] = []
        self.final_content: str = ""

        # 取消信号
        self._cancel_event: asyncio.Event = asyncio.Event()

    # ------------------------------------------------------------------
    # 公开 API
    # ------------------------------------------------------------------

    async def run(
        self,
        user_message: str,
        tools: list[dict[str, Any]] | None = None,
        tool_executor: ToolExecutor | None = None,
        *,
        max_iterations: int = _DEFAULT_MAX_TOOL_ITERATIONS,
        temperature: float = 0.7,
        tool_result_max_chars: int = _DEFAULT_TOOL_RESULT_MAX_CHARS,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """执行一次性任务，产出事件流。

        支持两种模式：

        1. **工具循环模式**（``tools`` + ``tool_executor`` 均非 None）：
           使用非流式 ``chat()`` 执行 multi-turn function calling。
           每轮：LLM → tool_calls → 执行 → 回填 → LLM，直到无 tool_calls 或达到上限。

        2. **单次调用模式**（无 ``tools`` 或无 ``tool_executor``）：
           使用流式 ``chat_stream()``，向后兼容。

        事件类型：

        - ``{"type": "token", "content": "..."}`` 内容增量（仅单次调用模式）
        - ``{"type": "tool_call", "id", "name", "args"}`` 工具调用（执行前）
        - ``{"type": "tool_result", "tool", "result"}`` 工具执行结果
        - ``{"type": "error", "message"}`` 异常
        - ``{"type": "done", "reason", "answer", "tool_calls_used"}`` 结束

        生命周期：

        - 正常结束 → ``status="completed"``
        - 异常 → ``status="failed"``（产出 ``error`` + ``done`` 事件后退出）
        - 被 :meth:`cancel` → ``status="cancelled"``（产出 ``done(reason="cancelled")``）

        Args:
            user_message: 本次任务的 user 消息文本。
            tools: 可选的 OpenAI Function Calling 工具定义列表。
            tool_executor: 工具执行器 ``(name, args) -> result_dict``。
                与 ``tools`` 同时提供时启用工具循环模式。
            max_iterations: 工具循环最大轮数，默认 5。
            temperature: 采样温度，默认 0.7。
            tool_result_max_chars: 工具结果回填的最大字符数，默认 2000。
        """
        # 追加本次任务的 user 消息到独立 messages
        self.messages.append({"role": "user", "content": user_message})

        try:
            if self._cancel_event.is_set():
                self.status = STATUS_CANCELLED
                yield {"type": "done", "reason": "cancelled",
                       "answer": "", "tool_calls_used": self.tool_calls_used}
                return

            if tools and tool_executor:
                async for event in self._run_tool_loop(
                    tools, tool_executor, max_iterations,
                    temperature, tool_result_max_chars,
                ):
                    yield event
            else:
                async for event in self._run_single(tools, temperature):
                    yield event
        except asyncio.CancelledError:
            self.status = STATUS_CANCELLED
            yield {"type": "done", "reason": "cancelled",
                   "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
            raise
        except LLMError as exc:
            self.status = STATUS_FAILED
            logger.warning(
                "子 agent LLM 调用失败 id=%s type=%s: %s",
                self.agent_id,
                self.agent_type,
                exc,
            )
            yield {"type": "error", "message": str(exc)}
            yield {"type": "done", "reason": "error",
                   "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
        except Exception as exc:  # noqa: BLE001
            self.status = STATUS_FAILED
            logger.warning(
                "子 agent 异常 id=%s type=%s: %s",
                self.agent_id,
                self.agent_type,
                exc,
            )
            yield {"type": "error", "message": str(exc)}
            yield {"type": "done", "reason": "error",
                   "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
        finally:
            if self.completed_at is None:
                self.completed_at = time.time()

    async def _run_single(
        self,
        tools: list[dict[str, Any]] | None,
        temperature: float,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """单次调用模式：流式 ``chat_stream`` 透传 token / tool_call 事件。

        向后兼容原有行为：不执行工具，仅透传 LLM 产出的事件。
        """
        async for event in self.llm_client.chat_stream(
            self.messages, tools=tools, temperature=temperature
        ):
            if self._cancel_event.is_set():
                self.status = STATUS_CANCELLED
                yield {"type": "done", "reason": "cancelled",
                       "answer": "", "tool_calls_used": self.tool_calls_used}
                return
            etype = event.get("type")
            if etype == "finish":
                yield {"type": "done", "reason": event.get("reason", "stop"),
                       "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
                break
            if etype == "token":
                self.final_content += event.get("content", "")
            yield event

        if self.status == STATUS_RUNNING:
            self.status = STATUS_COMPLETED

    async def _run_tool_loop(
        self,
        tools: list[dict[str, Any]],
        tool_executor: ToolExecutor,
        max_iterations: int,
        temperature: float,
        tool_result_max_chars: int,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """工具循环模式：非流式 ``chat`` + multi-turn function calling。

        每轮：``chat()`` → 解析 tool_calls → 逐个执行 → 回填 → 继续。
        无 tool_calls 时 content 即为最终 answer。
        """
        for _iteration in range(max_iterations):
            if self._cancel_event.is_set():
                self.status = STATUS_CANCELLED
                yield {"type": "done", "reason": "cancelled",
                       "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
                return

            response = await self.llm_client.chat(
                self.messages, tools=tools, temperature=temperature
            )
            content = response.get("content", "") or ""
            tool_calls = response.get("tool_calls", [])

            # 回填 assistant 消息（含 tool_calls，OpenAI 格式要求配对）
            self.messages.append({
                "role": "assistant",
                "content": content,
                "tool_calls": [
                    {
                        "id": tc.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": tc.get("name", ""),
                            "arguments": tc.get("arguments", ""),
                        },
                    }
                    for tc in tool_calls
                ],
            })

            if not tool_calls:
                # 无工具调用：LLM 的 content 即为最终答案
                self.final_content = content
                logger.info(
                    "子 agent 工具循环结束 iteration=%d (无更多工具调用) id=%s",
                    _iteration, self.agent_id,
                )
                break

            # 逐个执行工具并回填结果
            for tc in tool_calls:
                if self._cancel_event.is_set():
                    break

                tool_name = tc.get("name", "")
                tool_call_id = tc.get("id", "")
                raw_args = tc.get("arguments", "")

                # 解析参数
                try:
                    args = json.loads(raw_args) if raw_args else {}
                except (json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    "子 agent 工具调用 iteration=%d tool=%s args=%s id=%s",
                    _iteration, tool_name, str(args)[:200], self.agent_id,
                )

                # 通知调用方即将执行工具
                yield {
                    "type": "tool_call",
                    "id": tool_call_id,
                    "name": tool_name,
                    "args": args,
                }

                # 执行工具（异常由执行器内部兜底，不中断循环）
                try:
                    result = await tool_executor(tool_name, args)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "子 agent 工具执行异常 tool=%s id=%s: %s",
                        tool_name, self.agent_id, exc,
                    )
                    result = {"status": "error", "message": f"工具执行异常: {exc}"}

                result_text = self._truncate_tool_result(result, tool_result_max_chars)

                self.tool_calls_used.append({
                    "tool": tool_name,
                    "args": args,
                    "status": result.get("status", "unknown"),
                })

                # 回填 tool 角色消息（OpenAI 要求 tool_call_id 对应）
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result_text,
                })

                yield {
                    "type": "tool_result",
                    "tool": tool_name,
                    "result": result,
                }

            if self._cancel_event.is_set():
                self.status = STATUS_CANCELLED
                yield {"type": "done", "reason": "cancelled",
                       "answer": self.final_content, "tool_calls_used": self.tool_calls_used}
                return

            # 继续下一轮 LLM 调用（带着工具结果）
        else:
            # 达到 max_iterations 仍未结束
            self.final_content = self.final_content or "(达到最大工具调用迭代次数)"
            logger.warning(
                "子 agent 达到最大迭代次数 %d id=%s", max_iterations, self.agent_id,
            )

        if self.status == STATUS_RUNNING:
            self.status = STATUS_COMPLETED
        yield {
            "type": "done",
            "reason": "stop",
            "answer": self.final_content,
            "tool_calls_used": self.tool_calls_used,
        }

    @staticmethod
    def _truncate_tool_result(result: dict[str, Any], max_chars: int) -> str:
        """将工具结果截断为合理长度的字符串，避免撑爆 LLM 上下文。"""
        try:
            text = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(result)
        if len(text) > max_chars:
            return text[:max_chars] + "...(已截断)"
        return text

    def cancel(self) -> None:
        """请求取消。

        置位 ``asyncio.Event``，正在 ``run`` 的协程将在下一次事件循环检查时退出。
        若 ``run`` 尚未启动或已结束，则仅更新 ``status`` 不会产生副作用。
        """
        self._cancel_event.set()
        if self.status == STATUS_RUNNING:
            self.status = STATUS_CANCELLED
            self.completed_at = time.time()

    def is_done(self) -> bool:
        """是否已结束（无论成功 / 失败 / 取消）。"""
        return self.status in _DONE_STATUSES

    # 供子类（包装模式）使用的内部钩子 ----------------------------------

    def _mark_done(self, status: str = STATUS_COMPLETED) -> None:
        """显式标记结束（供包装类在非流式任务完成后调用）。

        Args:
            status: 目标状态，默认 ``completed``；异常时传 ``failed``。
        """
        if self.status == STATUS_RUNNING:
            self.status = status
        self.completed_at = time.time()


class SubAgentManager:
    """子 Agent 生命周期管理器。

    维护所有活跃子 Agent 的注册表（``dict[agent_id, SubAgent]``），提供：

    - :meth:`create`：创建并注册一个 :class:`SubAgent`
    - :meth:`register`：注册一个已构造的 :class:`SubAgent`（供子类继承场景）
    - :meth:`get`：按 ID 获取
    - :meth:`list_active`：列出未结束的子 Agent
    - :meth:`cleanup_finished`：清理已结束超过 ``max_age_seconds`` 的记录

    所有方法均为同步（``cleanup_finished`` 例外，标记 ``async`` 便于未来扩展为
    涉及 IO 的清理逻辑）；CPython ``dict`` 操作原子，asyncio 单线程模型下无需加锁。
    """

    def __init__(self) -> None:
        self._agents: dict[str, SubAgent] = {}

    def create(
        self,
        agent_type: str,
        llm_client: LLMClient,
        system_prompt: str,
        parent_context: list[dict[str, Any]] | None = None,
        *,
        seed_count: int = DEFAULT_PARENT_CONTEXT_SEED,
    ) -> SubAgent:
        """创建并注册一个子 Agent。

        Args:
            agent_type: 类型标签（``"summarize"`` / ``"search"`` / ``"writer"`` 等）。
            llm_client: 主 Agent 的 :class:`LLMClient`，仅用于读取配置。
            system_prompt: 子 Agent 系统提示词。
            parent_context: 主 Agent 最近上下文，将从中拷贝 ``seed_count`` 条作为种子。
            seed_count: 种子消息条数，默认 :data:`DEFAULT_PARENT_CONTEXT_SEED`。

        Returns:
            已注册的 :class:`SubAgent` 实例。
        """
        agent_id = uuid.uuid4().hex
        agent = SubAgent(
            agent_id=agent_id,
            agent_type=agent_type,
            llm_client=llm_client,
            system_prompt=system_prompt,
            parent_context=parent_context,
            seed_count=seed_count,
        )
        self._agents[agent_id] = agent
        logger.info("创建子 agent id=%s type=%s", agent_id, agent_type)
        return agent

    def register(self, agent: SubAgent) -> SubAgent:
        """注册一个已构造的子 Agent（供子类继承场景使用）。

        Args:
            agent: 已构造的 :class:`SubAgent`（或其子类）实例。

        Returns:
            传入的 ``agent``（便于链式调用）。
        """
        self._agents[agent.agent_id] = agent
        logger.info(
            "注册子 agent id=%s type=%s", agent.agent_id, agent.agent_type
        )
        return agent

    def get(self, agent_id: str) -> SubAgent | None:
        """按 ID 获取子 Agent；不存在返回 ``None``。"""
        return self._agents.get(agent_id)

    def list_active(self) -> list[SubAgent]:
        """列出所有未结束的子 Agent（``status == running``）。"""
        return [a for a in self._agents.values() if not a.is_done()]

    def list_all(self) -> list[SubAgent]:
        """列出注册表中的全部子 Agent（含已结束）。"""
        return list(self._agents.values())

    async def cleanup_finished(self, max_age_seconds: int = 300) -> int:
        """清理已结束超过 ``max_age_seconds`` 秒的子 Agent。

        遍历注册表，对 ``is_done()`` 为真且 ``completed_at`` 距今超过阈值的记录删除。
        标记为 ``async`` 以便未来扩展为涉及 IO 的清理（如落盘审计日志）。

        Args:
            max_age_seconds: 已结束子 Agent 的保留时长（秒），默认 300s。

        Returns:
            本次清理的记录数。
        """
        now = time.time()
        to_remove: list[str] = []
        for aid, agent in self._agents.items():
            if not agent.is_done():
                continue
            end_at = agent.completed_at or agent.created_at
            if now - end_at >= max_age_seconds:
                to_remove.append(aid)
        for aid in to_remove:
            self._agents.pop(aid, None)
        if to_remove:
            logger.info("清理已结束子 agent %d 个", len(to_remove))
        return len(to_remove)


# 全局单例
sub_agent_manager = SubAgentManager()

"""主 Agent（Task 5 适配移植）。

多轮对话主循环，集成以下能力：

1. **多轮对话主循环**：保存用户消息 → 加载历史 → 上下文管理 → 流式调用 LLM →
   保存 assistant 消息。
2. **Study/Work 双模式 + Plan/Build 工具白名单**：``mode`` 控制 scenario
   （学习辅导 / 工作辅助），``plan_mode`` 控制工具白名单（plan 只读，build 全权）。
3. **图谱上下文注入**：若 ``graph_id`` 存在，调 ``graph_agent._build_context``
   作为系统提示的一部分注入。
4. **高风险工具拦截**：``graph_extract_from_observation`` 等高风险工具在 Plan
   模式直接拒绝；Build 模式通过 WS 推送确认请求，暂停工具循环等待用户响应 / 超时。
5. **Function Calling 调度**：本地工具（ToolRegistry）+ MCP 工具（命名空间
   ``mcp.{server}.{tool}``），支持 multi-turn function calling。

事件流（``chat_stream`` 产出）：
    {"type": "token", "content": "..."}              内容增量
    {"type": "tool_call", "id", "tool", "args"}      工具调用（执行前）
    {"type": "tool_result", "tool", "result"}        工具执行结果
    {"type": "tool_call_confirmation", ...}          高风险工具确认请求（WS 推送）
    {"type": "error", "message"}                     错误
    {"type": "done"}                                 完成

KWA 适配说明（相对步影原版）：
- **移除步影特有 import**：步影 main_agent.py 未直接 import notes/distill/dream，
  本模块保留全部步影 import（均与 KWA 兼容）。
- **新增 graph_id / mode / plan_mode 参数**（SubTask 5.2）：``mode`` 为 study/work
  scenario，``plan_mode`` 为 bool 控制 plan/build 工具白名单。``self.mode`` 保留为
  plan/build 字符串以兼容 ``tool_registry.get_tool_schemas(mode)``。
- **图谱上下文注入**（SubTask 5.3）：``_build_system_message`` 中若 ``graph_id``
  存在，调 ``graph_agent._build_context`` 注入图谱全貌。
- **高风险工具拦截**（SubTask 5.4）：工具循环中检查 ``HIGH_RISK_TOOLS``，Plan 模式
  直接拒绝，Build 模式通过 WS 推送 ``chat_tool_call_confirmation`` 并等待
  ``resolve_tool_confirmation`` 或 60s 超时。
- **全局单例**（SubTask 5.5）：``main_agent`` / ``get_main_agent()`` /
  ``init_main_agent()`` 对齐 ``graph_agent`` 模式。
"""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import re
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.config import settings
from app.db import AsyncSessionLocal
from app.models.db_models import FileMetadata as FileMetadataRow
from app.models.db_models import Message as MessageRow
from app.models.db_models import Session as SessionRow
from app.services.context_manager import ContextManager
from app.services.llm_client import LLMClient
from app.services.model_config import get_model_config
from app.services.multimodal.image_handler import encode_image_for_llm
# MCP 工具管理器（Task 2）：全局单例，提供 MCP 工具 schema 与调用入口
from app.services.mcp_manager import mcp_manager
from app.services.tool_registry import MCP_PREFIX, ToolRegistry, register_default_tools
from app.services.tools.task_tools import TaskStore
# 图谱 Agent（KWA 已有）：用于 _build_context 注入图谱上下文
from app.services.graph_agent import graph_agent
# WS 推送：用于高风险工具确认请求
from app.services.ws_notify import notify_session

logger = logging.getLogger(__name__)

# multi-turn function calling 最大迭代次数（防止无限循环）
MAX_TOOL_ITERATIONS = 10

# 高风险工具确认超时（秒）
TOOL_CONFIRMATION_TIMEOUT = 60.0

# 高风险工具集合（SubTask 7.5 在 graph_tools.py 定义，此处延迟导入 + fallback）
# Task 7 完成后从 graph_tools 导入；未完成时用 fallback 空集（不拦截）
try:
    from app.services.tools.graph_tools import HIGH_RISK_TOOLS as _GRAPH_HIGH_RISK_TOOLS
except ImportError:  # Task 7 未完成时 graph_tools 不存在
    _GRAPH_HIGH_RISK_TOOLS: set[str] = set()

# 对外暴露 HIGH_RISK_TOOLS（供 main.py / chat 路由 import）
HIGH_RISK_TOOLS: set[str] = set(_GRAPH_HIGH_RISK_TOOLS)
# 确保 graph_extract_from_observation 始终在高风险集合（即使 Task 7 未完成）
HIGH_RISK_TOOLS.add("graph_extract_from_observation")

# Qwen 等模型在不支持原生 function calling 时，会在文本中生成 <tool_call> XML。
# 正则匹配 <tool_call>...</tool_call> 块（DOTALL 跨行）。
_XML_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
# Qwen XML 格式：<function=name>...</function>
_XML_FUNCTION_RE = re.compile(r"<function=(\w[\w.]*)>(.*?)</function>", re.DOTALL)
# Qwen XML 格式：<parameter=key>value</parameter>
_XML_PARAM_RE = re.compile(r"<parameter=(\w+)>(.*?)</parameter>", re.DOTALL)


# ============================================================================
# 高风险工具确认机制（SubTask 5.4）
# ============================================================================

# 待确认的工具调用：request_id -> Future（resolved 时含 {approved, reason}）
_pending_confirmations: dict[str, asyncio.Future[dict[str, Any]]] = {}


async def request_tool_confirmation(
    session_id: str,
    tool_name: str,
    args: dict[str, Any],
    timeout: float = TOOL_CONFIRMATION_TIMEOUT,
) -> dict[str, Any]:
    """推送高风险工具确认请求到前端 WS，并等待用户响应。

    通过 :func:`ws_notify.notify_session` 推送
    ``{type: 'chat_tool_call_confirmation', op: 'chat', tool, args, request_id, timeout}``，
    前端弹确认对话框。用户通过 ``POST /api/chat/requests/{id}/confirm`` 调用
    :func:`resolve_tool_confirmation` 解析 Future。

    Args:
        session_id: 会话 ID（WS 推送目标）。
        tool_name: 工具名（如 ``graph_extract_from_observation``）。
        args: 工具调用参数（供前端展示摘要）。
        timeout: 超时秒数（默认 60）。

    Returns:
        ``{"approved": bool, "reason": str}``。超时返回
        ``{"approved": False, "reason": "用户确认超时，已取消"}``。
    """
    request_id = uuid.uuid4().hex
    loop = asyncio.get_event_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_confirmations[request_id] = future

    # 推送 WS 确认请求
    try:
        await notify_session(
            session_id,
            {
                "type": "chat_tool_call_confirmation",
                "op": "chat",
                "tool": tool_name,
                "args": args,
                "request_id": request_id,
                "timeout": int(timeout),
            },
        )
    except Exception as exc:  # noqa: BLE001 - WS 推送失败不应阻塞工具循环
        logger.warning(
            "推送工具确认 WS 失败 session=%s tool=%s: %s",
            session_id,
            tool_name,
            exc,
        )
        _pending_confirmations.pop(request_id, None)
        return {"approved": False, "reason": f"WS 推送失败: {exc}"}

    # 等待用户响应或超时
    try:
        result = await asyncio.wait_for(future, timeout=timeout)
        return result
    except asyncio.TimeoutError:
        logger.info(
            "工具确认超时 session=%s tool=%s request_id=%s",
            session_id,
            tool_name,
            request_id,
        )
        return {"approved": False, "reason": "用户确认超时，已取消"}
    finally:
        _pending_confirmations.pop(request_id, None)


def resolve_tool_confirmation(
    request_id: str,
    approved: bool,
    reason: str = "",
) -> bool:
    """解析待确认的工具调用（由 ``POST /api/chat/requests/{id}/confirm`` 调用）。

    Args:
        request_id: :func:`request_tool_confirmation` 生成的 request_id。
        approved: 用户是否同意。
        reason: 拒绝原因（approved=False 时有意义）。

    Returns:
        是否成功解析（request_id 不存在 / 已完成时返回 False）。
    """
    future = _pending_confirmations.get(request_id)
    if future is None or future.done():
        return False
    future.set_result({"approved": approved, "reason": reason})
    return True


# ============================================================================
# XML 工具调用解析（Qwen 等模型 fallback）
# ============================================================================

def _parse_xml_tool_calls(text: str) -> list[dict[str, Any]]:
    r"""从文本中解析 ``<tool_call>`` XML 块为工具调用列表。

    部分模型（如 Qwen）在 LM Studio 中可能不使用原生 function calling API，
    而是在文本内容中生成 ``<tool_call>`` XML。支持两种格式：

    1. Qwen XML 格式::

           <tool_call>
           <function=file_write>
           <parameter=path>C:/Users/test.txt</parameter>
           <parameter=content>hello</parameter>
           </function>
           </tool_call>

    2. JSON 格式::

           <tool_call>
           {"name": "file_write", "arguments": {"path": "...", "content": "..."}}
           </tool_call>

    Returns:
        工具调用列表，每项为 ``{"id", "name", "arguments"}``。
        ``arguments`` 为 JSON 字符串（与原生 tool_call 格式一致）。
    """
    tool_calls: list[dict[str, Any]] = []
    for match in _XML_TOOL_CALL_RE.finditer(text):
        raw = match.group(1).strip()

        # 先尝试 JSON 格式
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and "name" in data:
                args = data.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args else {}
                    except json.JSONDecodeError:
                        args = {"_raw": args}
                tool_calls.append({
                    "id": f"xml-{len(tool_calls)}",
                    "name": str(data["name"]),
                    "arguments": json.dumps(args, ensure_ascii=False),
                })
                continue
        except (json.JSONDecodeError, TypeError):
            pass

        # 再尝试 Qwen XML 格式
        func_match = _XML_FUNCTION_RE.search(raw)
        if func_match:
            func_name = func_match.group(1)
            func_body = func_match.group(2)
            args: dict[str, Any] = {}
            for param_match in _XML_PARAM_RE.finditer(func_body):
                args[param_match.group(1)] = param_match.group(2).strip()
            tool_calls.append({
                "id": f"xml-{len(tool_calls)}",
                "name": func_name,
                "arguments": json.dumps(args, ensure_ascii=False),
            })

    return tool_calls


# ============================================================================
# 系统提示词加载
# ============================================================================

_PROMPT_DIR = Path(__file__).resolve().parent / "prompts"


def _load_system_prompt() -> str:
    """加载主 Agent 系统提示词（``prompts/main_agent_system.md``）。

    首次调用后缓存到模块级变量，避免每次对话都读盘。
    """
    global _SYSTEM_PROMPT_CACHE
    cached = globals().get("_SYSTEM_PROMPT_CACHE")
    if cached is not None:
        return cached
    path = _PROMPT_DIR / "main_agent_system.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("读取主 Agent 系统提示词失败，使用空 prompt: %s", exc)
        text = ""
    globals()["_SYSTEM_PROMPT_CACHE"] = text
    return text


_SYSTEM_PROMPT_CACHE: str | None = None


# ============================================================================
# 工具函数
# ============================================================================

def _now() -> datetime:
    return datetime.now(UTC)


def _parse_attachments(raw: str | None) -> list[str]:
    """解析 DB 中的 attachments JSON 字符串为 file_id 列表。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [str(x) for x in data]


# ============================================================================
# MainAgent
# ============================================================================

class MainAgent:
    """主 Agent：处理用户多轮对话，集成上下文管理、图谱注入与 Function Calling。

    每个会话应复用同一实例（按 ``session_id`` 缓存），以保持
    ``context_manager`` 的 ``triggered_checkpoints`` 等状态跨多轮对话持续有效。

    Args:
        session_id: 会话 ID。
        llm_client: LLM 客户端（配置变更时通过 ``update_llm_client`` 刷新）。
        mode: 场景模式（``"study"` 学习辅导 / ``"work"`` 工作辅助）。
        plan_mode: 是否为 Plan 模式（True=只读规划，False=Build 可执行）。
        graph_id: 关联的知识图谱 ID（为 None 时不注入图谱上下文）。
        context_manager: 会话级上下文管理器（为 None 时自动创建）。
        tool_registry: 工具注册表（为 None 时创建含默认工具的独立注册表）。
    """

    def __init__(
        self,
        session_id: str,
        llm_client: LLMClient,
        mode: str = "work",
        plan_mode: bool = False,
        graph_id: str | None = None,
        context_manager: ContextManager | None = None,
        tool_registry: ToolRegistry | None = None,
    ) -> None:
        self.session_id = session_id
        self.llm_client = llm_client
        # 场景模式：study / work（KWA 新增，控制回答风格与工具组合倾向）
        self.scenario_mode: str = mode if mode in ("study", "work") else "work"
        # Plan/Build 模式：控制工具白名单（plan 只读，build 全权）
        self.plan_mode: bool = bool(plan_mode)
        # tool_registry 期望 "plan"/"build" 字符串，派生自 plan_mode
        self.mode: str = "plan" if self.plan_mode else "build"
        # 关联图谱 ID（为 None 时不注入图谱上下文）
        self.graph_id: str | None = graph_id
        # ContextManager.model_window 优先用 DB 的 llm.context_window（运行时覆盖），
        # 其次用 model_config.json 中该模型的 context_window，最后用硬编码 8192。
        if context_manager is not None:
            self.context_manager = context_manager
        else:
            model_cfg = get_model_config(llm_client.model)
            model_window = (
                settings.llm_context_window
                or model_cfg.get("context_window")
                or 8192
            )
            self.context_manager = ContextManager(
                session_id=session_id,
                llm_client=llm_client,
                model_window=model_window,
            )
        # 会话级 TaskStore（内存级任务列表，供 task_* 工具使用）
        self._task_store = TaskStore()
        # 工具注册表：为 None 时创建独立实例并注册默认工具（append_note 绑定本会话）
        if tool_registry is not None:
            self.tool_registry = tool_registry
        else:
            self.tool_registry = ToolRegistry()
            register_default_tools(
                self.tool_registry,
                session_id_getter=lambda: self.session_id,
                task_store_getter=lambda: self._task_store,
                llm_client_getter=lambda: self.llm_client,
            )
        self._system_prompt = _load_system_prompt()
        # 取消事件：cancel() 置位后，chat_stream 在下一个 token 边界退出
        self._cancel_event = asyncio.Event()
        # 串行化 chat_stream：保证同一 session 同时只有一个流式调用
        self._chat_lock = asyncio.Lock()
        # chat_stream 完成事件：供 cancel_and_wait 等待退出
        self._chat_done = asyncio.Event()
        self._chat_done.set()  # 初始：未在 chat

    # ==================================================================
    # 公开方法
    # ==================================================================

    def update_llm_client(self, client: LLMClient) -> None:
        """刷新 LLM 客户端（配置可能在会话进行中被修改）。"""
        self.llm_client = client
        self.context_manager.update_llm_client(client)

    def cancel(self) -> None:
        """取消当前正在进行的流式调用。"""
        self._cancel_event.set()

    async def cancel_and_wait(self, timeout: float = 30.0) -> None:
        """取消当前流式调用并等待其完全退出。"""
        self._cancel_event.set()
        try:
            await asyncio.wait_for(self._chat_done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "cancel_and_wait 超时 session=%s timeout=%.1f",
                self.session_id,
                timeout,
            )

    async def revoke_last_exchange(self) -> dict[str, str] | None:
        """删除该 session 最近一对 user+assistant 消息。

        Returns:
            ``{"user_id": ..., "assistant_id": ...}`` 或 None（无消息可删）。
        """
        try:
            async with AsyncSessionLocal() as db:
                # 取最近一条 user 消息
                result = await db.execute(
                    select(MessageRow)
                    .where(MessageRow.session_id == self.session_id)
                    .where(MessageRow.role == "user")
                    .order_by(
                        MessageRow.created_at.desc(),
                        MessageRow.id.desc(),
                    )
                    .limit(1)
                )
                user_row = result.scalar_one_or_none()
                if user_row is None:
                    return None

                # 取紧随其后的 assistant 消息（created_at >= user.created_at）
                result = await db.execute(
                    select(MessageRow)
                    .where(MessageRow.session_id == self.session_id)
                    .where(MessageRow.role == "assistant")
                    .where(MessageRow.created_at >= user_row.created_at)
                    .order_by(
                        MessageRow.created_at.asc(),
                        MessageRow.id.asc(),
                    )
                    .limit(1)
                )
                assistant_row = result.scalar_one_or_none()

                revoked: dict[str, str] = {"user_id": user_row.id}
                await db.delete(user_row)
                if assistant_row is not None:
                    revoked["assistant_id"] = assistant_row.id
                    await db.delete(assistant_row)
                await db.commit()
            logger.info(
                "revoke_last_exchange session=%s user=%s assistant=%s",
                self.session_id,
                revoked.get("user_id"),
                revoked.get("assistant_id"),
            )
            return revoked
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "revoke_last_exchange 失败 session=%s: %s",
                self.session_id,
                exc,
            )
            return None

    async def chat_stream_with_revoke(
        self,
        user_message: str,
        attachments: list[str] | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """回撤最近一轮 + 启动新一轮 chat_stream（拼接场景专用）。"""
        revoked = await self.revoke_last_exchange()
        if revoked:
            yield {"type": "chat_revoked", **revoked}
        async for event in self.chat_stream(user_message, attachments):
            yield event

    def get_tools(self) -> list[dict[str, Any]]:
        """返回当前模式下可用的工具 schema 列表（OpenAI function calling 格式）。

        本地工具来自会话级 ``tool_registry``（含 session 绑定的 append_note）；
        MCP 工具来自全局 :data:`mcp_manager`（``mcp.{server}.{tool}`` 命名空间）。
        两者合并后传给 ``LLMClient.chat_stream(tools=...)``。
        """
        tools = self.tool_registry.get_tool_schemas(self.mode)
        # 合并 MCP 工具（实时读取，反映运行时增删的服务器）
        tools.extend(mcp_manager.get_tool_schemas())
        return tools

    async def switch_plan_mode(self, plan_mode: bool) -> None:
        """切换 Plan/Build 模式。

        Args:
            plan_mode: True=Plan 只读，False=Build 可执行。
        """
        self.plan_mode = plan_mode
        self.mode = "plan" if plan_mode else "build"
        logger.info(
            "切换 Plan/Build 模式 session=%s plan_mode=%s mode=%s",
            self.session_id,
            plan_mode,
            self.mode,
        )

    async def switch_scenario_mode(self, mode: str) -> None:
        """切换场景模式（study / work）。

        Args:
            mode: ``"study"`` 或 ``"work"``。
        """
        if mode not in ("study", "work"):
            raise ValueError(f"无效的场景模式: {mode}，应为 study 或 work")
        self.scenario_mode = mode
        logger.info(
            "切换场景模式 session=%s scenario_mode=%s",
            self.session_id,
            mode,
        )

    def set_graph_id(self, graph_id: str | None) -> None:
        """设置关联的图谱 ID（为 None 时关闭图谱上下文注入）。"""
        self.graph_id = graph_id
        logger.debug("设置 graph_id session=%s graph_id=%s", self.session_id, graph_id)

    async def chat_stream(
        self,
        user_message: str,
        attachments: list[str] | None = None,
        *,
        graph_id: str | None = None,
        mode: str | None = None,
        plan_mode: bool | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式对话：处理用户消息并产出事件流。

        流程：
          1. 保存用户消息到 DB；
          2. 加载会话历史消息 → OpenAI messages 格式（含 attachments）；
          3. 上下文管理：文件原文替换 → 裁剪工具输出 → checkpoint（并发）→
             compaction → rebuild；
          4. 前置系统提示词（含图谱上下文注入）；
          5. multi-turn function calling 循环：LLM → tool_call → 执行（含高风险
             拦截）→ 回填结果 → 再次 LLM，直到无 tool_call 或达到迭代上限；
          6. 保存 assistant 消息到 DB → yield done。

        Args:
            user_message: 用户消息文本。
            attachments: 附件 file_id 列表。
            graph_id: 本次对话关联的图谱 ID（覆盖实例 ``self.graph_id``，
                为 None 时用实例值；显式传 ``""`` 可关闭注入）。
            mode: 本次对话的场景模式（``"study"``/``"work"``，覆盖实例值）。
            plan_mode: 本次对话是否 Plan 模式（覆盖实例值）。
        """
        # 应用 per-call 覆盖（不修改实例属性，避免影响后续调用）
        effective_graph_id = self.graph_id if graph_id is None else graph_id
        effective_scenario = self.scenario_mode if mode is None else mode
        if effective_scenario not in ("study", "work"):
            effective_scenario = "work"
        effective_plan_mode = self.plan_mode if plan_mode is None else bool(plan_mode)
        effective_mode = "plan" if effective_plan_mode else "build"

        # 等待前一轮 chat_stream 退出（如果 cancel_and_wait 还没等到）
        async with self._chat_lock:
            self._chat_done.clear()
            # 每次调用前重置取消标志
            self._cancel_event.clear()
            assistant_content_parts: list[str] = []

            try:
                # 1. 验证会话存在 + 保存用户消息
                session_exists = await self._save_user_message(user_message, attachments)
                if not session_exists:
                    yield {"type": "error", "message": f"会话不存在: {self.session_id}"}
                    yield {"type": "done"}
                    return

                # 2. 加载历史消息（含当前用户消息）
                messages = await self._load_history_messages(user_message, attachments)

                # 3. 上下文管理
                messages = await self._apply_context_management(messages)

                # 3.5 注入多模态图片附件
                messages = await self._inject_image_attachments(messages, attachments)

                # 4. 前置系统提示词（含图谱上下文 + scenario/plan 模式注入）
                existing_system_parts: list[str] = []
                non_system_messages: list[dict[str, Any]] = []
                for m in messages:
                    if m.get("role") == "system":
                        text = m.get("content", "")
                        if isinstance(text, list):
                            text = json.dumps(text, ensure_ascii=False)
                        elif not isinstance(text, str):
                            text = str(text)
                        existing_system_parts.append(text)
                    else:
                        non_system_messages.append(m)
                system_msg = self._build_system_message(
                    graph_id=effective_graph_id,
                    scenario_mode=effective_scenario,
                    plan_mode=effective_plan_mode,
                    tool_mode=effective_mode,
                )
                if existing_system_parts:
                    system_msg["content"] = (
                        system_msg["content"]
                        + "\n\n--- 上下文摘要（由上下文管理器注入） ---\n\n"
                        + "\n\n".join(existing_system_parts)
                    )
                messages = [system_msg] + non_system_messages

                # 5. multi-turn function calling 循环（传入 effective_mode 供高风险拦截）
                async for event in self._run_function_calling_loop(
                    messages,
                    assistant_content_parts,
                    tool_mode=effective_mode,
                    graph_id=effective_graph_id,
                ):
                    yield event

            except Exception as exc:  # noqa: BLE001
                logger.exception("MainAgent chat_stream 异常: %s", exc)
                yield {"type": "error", "message": str(exc)}
                yield {"type": "done"}
            finally:
                self._chat_done.set()

    async def chat(
        self,
        user_message: str,
        attachments: list[str] | None = None,
        *,
        graph_id: str | None = None,
        mode: str | None = None,
        plan_mode: bool | None = None,
    ) -> dict[str, Any]:
        """非流式对话：收集 chat_stream 全部事件后返回完整消息。

        Returns:
            ``{"content": str, "tool_calls": list, "error": str | None}``。
        """
        content_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        error: str | None = None
        async for event in self.chat_stream(
            user_message,
            attachments,
            graph_id=graph_id,
            mode=mode,
            plan_mode=plan_mode,
        ):
            etype = event.get("type")
            if etype == "token":
                content_parts.append(event.get("content", ""))
            elif etype == "tool_call":
                tool_calls.append(event)
            elif etype == "error":
                error = event.get("message", "")
        return {
            "content": "".join(content_parts),
            "tool_calls": tool_calls,
            "error": error,
        }

    # ==================================================================
    # 内部：消息持久化与加载
    # ==================================================================

    async def _save_user_message(
        self,
        user_text: str,
        attachments: list[str] | None,
    ) -> bool:
        """保存用户消息到 DB，返回会话是否存在。"""
        now = _now()
        async with AsyncSessionLocal() as db:
            session = await db.get(SessionRow, self.session_id)
            if session is None:
                return False
            db.add(
                MessageRow(
                    id=uuid.uuid4().hex,
                    session_id=self.session_id,
                    role="user",
                    content=user_text,
                    attachments=json.dumps(attachments or [], ensure_ascii=False),
                    created_at=now,
                )
            )
            session.updated_at = now
            await db.commit()
        return True

    async def _save_assistant_message(self, content: str) -> None:
        """保存 assistant 消息到 DB（内容为空则跳过）。"""
        if not content or not content.strip():
            return
        now = _now()
        async with AsyncSessionLocal() as db:
            session = await db.get(SessionRow, self.session_id)
            db.add(
                MessageRow(
                    id=uuid.uuid4().hex,
                    session_id=self.session_id,
                    role="assistant",
                    content=content,
                    attachments="[]",
                    created_at=now,
                )
            )
            if session is not None:
                session.updated_at = now
            await db.commit()

    async def _load_history_messages(
        self,
        user_text: str | None = None,
        user_attachments: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """加载会话历史消息。"""
        messages: list[dict[str, Any]] = []
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(MessageRow)
                .where(MessageRow.session_id == self.session_id)
                .order_by(MessageRow.created_at.asc(), MessageRow.id.asc())
            )
            rows = list(result.scalars().all())

        for row in rows:
            role = row.role if row.role in ("user", "assistant", "system") else "user"
            messages.append(
                {
                    "role": role,
                    "content": row.content,
                    "attachments": _parse_attachments(row.attachments),
                }
            )
        return messages

    # ==================================================================
    # 内部：上下文管理
    # ==================================================================

    async def _apply_context_management(
        self,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """应用上下文管理流程。

        顺序：token 估算 → 文件原文替换 → 裁剪工具输出 → 重算 token →
        checkpoint（并发派发 Writer，不阻塞）→ rebuild 优先（有 checkpoint 时
        从持久化种子恢复，lossless）→ compaction 仅 fallback（无 checkpoint
        或未达 rebuild 阈值时用 LLM 摘要压缩，lossy）。
        异常时回退到原始消息，不阻断主流程。
        """
        cm = self.context_manager
        try:
            cm.set_system_prompt(self._build_system_message().get("content", ""))
            await cm.estimate_tokens(messages)
            messages = await cm.replace_file_references(self.session_id, messages)
            messages = cm.prune(messages)
            await cm.estimate_tokens(messages)
            await cm.maybe_checkpoint(messages)
            if await cm.maybe_rebuild():
                await cm.wait_for_writer()
                await cm.flush_checkpoints(messages)
                if await cm.has_checkpoint():
                    messages = await cm.rebuild_context()
                else:
                    messages = await cm.maybe_compact(messages)
            else:
                messages = await cm.maybe_compact(messages)
        except Exception as exc:  # noqa: BLE001
            logger.warning("上下文管理异常，回退到原始消息: %s", exc)
        return messages

    # ==================================================================
    # 内部：多模态图片附件注入
    # ==================================================================

    async def _inject_image_attachments(
        self,
        messages: list[dict[str, Any]],
        attachments: list[str] | None,
    ) -> list[dict[str, Any]]:
        """若最新用户消息含图片附件，转为 OpenAI 多模态 content。"""
        if not attachments:
            return messages

        last_user_idx: int | None = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        if last_user_idx is None:
            return messages

        user_msg = messages[last_user_idx]
        content = user_msg.get("content", "")
        if isinstance(content, list):
            return messages
        if not isinstance(content, str):
            content = str(content) if content else ""

        image_parts = await self._build_image_content_parts(attachments)
        if not image_parts:
            return messages

        multimodal_content: list[dict[str, Any]] = []
        if content:
            multimodal_content.append({"type": "text", "text": content})
        multimodal_content.extend(image_parts)

        new_msg = dict(user_msg)
        new_msg["content"] = multimodal_content
        messages[last_user_idx] = new_msg
        logger.debug(
            "注入多模态图片 session=%s images=%d",
            self.session_id,
            len(image_parts),
        )
        return messages

    async def _build_image_content_parts(
        self,
        file_ids: list[str],
    ) -> list[dict[str, Any]]:
        """查询图片附件并编码为 OpenAI ``image_url`` content part 列表。"""
        parts: list[dict[str, Any]] = []
        if not file_ids:
            return parts
        async with AsyncSessionLocal() as db:
            for fid in file_ids:
                try:
                    meta = await db.get(FileMetadataRow, fid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "查询 FileMetadata 失败 file_id=%s: %s", fid, exc
                    )
                    continue
                if meta is None:
                    logger.debug("FileMetadata 不存在 file_id=%s", fid)
                    continue
                mime = (meta.mime_type or "").lower()
                if not mime.startswith("image/"):
                    continue
                saved_path = meta.saved_path
                if not saved_path:
                    continue
                try:
                    result = await encode_image_for_llm(saved_path)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "图片编码失败 file_id=%s: %s", fid, exc
                    )
                    continue
                data_url = result.get("data_url")
                if not data_url:
                    logger.warning(
                        "图片编码返回空 data_url file_id=%s error=%s",
                        fid,
                        result.get("error"),
                    )
                    continue
                parts.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    }
                )
        return parts

    # ==================================================================
    # 内部：系统提示词（含图谱上下文注入，SubTask 5.3）
    # ==================================================================

    def _build_system_message(
        self,
        *,
        graph_id: str | None = None,
        scenario_mode: str | None = None,
        plan_mode: bool | None = None,
        tool_mode: str | None = None,
    ) -> dict[str, Any]:
        """构造系统消息，注入当前模式、运行环境与图谱上下文。

        Args:
            graph_id: 图谱 ID（为 None 时用 ``self.graph_id``；显式传值覆盖）。
                非空时调 ``graph_agent._build_context`` 获取图谱全貌注入。
            scenario_mode: 场景模式（study/work，为 None 时用 ``self.scenario_mode``）。
            plan_mode: Plan 模式 flag（为 None 时用 ``self.plan_mode``）。
            tool_mode: 工具模式（plan/build，为 None 时用 ``self.mode``）。
        """
        eff_graph_id = self.graph_id if graph_id is None else graph_id
        eff_scenario = self.scenario_mode if scenario_mode is None else scenario_mode
        eff_plan_mode = self.plan_mode if plan_mode is None else plan_mode
        eff_tool_mode = self.mode if tool_mode is None else tool_mode

        # 模式描述
        scenario_desc = (
            "Study 模式（学习辅导）：循循善诱，鼓励思考，主动发起测验验证掌握程度。"
            if eff_scenario == "study"
            else "Work 模式（工作辅助）：简洁高效，注重结构化沉淀与可追溯性。"
        )
        tool_mode_desc = (
            "当前处于 Plan 模式（只读），仅可使用受限只读工具，禁止写入 / 命令执行 / "
            "修改图谱（graph_extract_from_observation 一律拒绝，不弹框）。"
            if eff_tool_mode == "plan"
            else "当前处于 Build 模式（可执行），可使用全部工具包括文件写入 / 命令执行 / "
            "修改图谱（高风险工具 graph_extract_from_observation 会弹确认框）。"
        )

        # 运行环境信息
        now = datetime.now()
        tz_name = now.astimezone().tzname() or "本地时间"
        home = Path.home()
        env_info = (
            f"当前时间：{now.strftime('%Y-%m-%d %H:%M:%S')} {tz_name}"
            f"（{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][now.weekday()]}）\n"
            f"操作系统：{platform.system()} {platform.release()}（{platform.machine()}）\n"
            f"用户目录：{home}\n"
            f"桌面路径：{home / 'Desktop'}\n"
            f"工作目录：{Path.cwd()}"
        )

        # 图谱上下文注入（SubTask 5.3）
        graph_context_block = ""
        if eff_graph_id:
            try:
                # graph_agent._build_context 是 async，但本方法是 sync（在 chat_stream
                # 同步段调用）。改为在 chat_stream 中预先 await 后传入，或用
                # asyncio.run 风险大。此处保留接口：若已预取则用预取值。
                # 实际注入在 chat_stream 中通过 _inject_graph_context 异步完成。
                pass
            except Exception as exc:  # noqa: BLE001
                logger.warning("图谱上下文注入失败 graph_id=%s: %s", eff_graph_id, exc)

        content = (
            f"{self._system_prompt}\n\n---\n\n## 运行环境\n\n{env_info}"
            f"\n\n## 当前模式\n\n- 场景：{scenario_desc}\n- 工具：{tool_mode_desc}"
        )
        return {"role": "system", "content": content}

    async def _build_graph_context_block(self, graph_id: str | None) -> str:
        """异步获取图谱上下文文本块（SubTask 5.3 实际注入逻辑）。

        Args:
            graph_id: 图谱 ID（为 None / 空字符串时返回空块）。

        Returns:
            图谱全貌文本块（含图谱名 / 节点列表 / 关系列系），失败时返回空字符串。
        """
        if not graph_id:
            return ""
        try:
            context_text = await graph_agent._build_context(graph_id)
            if context_text:
                return (
                    "\n\n## 关联知识图谱\n\n"
                    f"当前对话关联的知识图谱上下文（graph_id={graph_id}）：\n\n"
                    f"{context_text}"
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "图谱上下文注入失败 graph_id=%s: %s", graph_id, exc
            )
        return ""

    # ==================================================================
    # 内部：multi-turn function calling 循环（含高风险拦截，SubTask 5.4）
    # ==================================================================

    async def _run_function_calling_loop(
        self,
        messages: list[dict[str, Any]],
        assistant_content_parts: list[str],
        *,
        tool_mode: str | None = None,
        graph_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """执行 multi-turn function calling 循环。

        每次迭代：
          1. 调用 ``llm_client.chat_stream``，流式产出 token / tool_call / finish；
          2. finish 时若有 tool_calls：执行工具（含高风险拦截）→ 回填 tool 角色消息
             → 继续下一轮；
          3. 无 tool_calls：保存 assistant 消息 → yield done → 返回；
          4. 达到 ``MAX_TOOL_ITERATIONS``：强制结束。

        Args:
            messages: 对话消息列表（会被工具结果回填修改）。
            assistant_content_parts: 累积的 assistant 内容（跨迭代）。
            tool_mode: 工具模式（plan/build，为 None 时用 ``self.mode``）。
            graph_id: 图谱 ID（高风险拦截 WS 推送时附带）。
        """
        eff_tool_mode = self.mode if tool_mode is None else tool_mode
        eff_graph_id = self.graph_id if graph_id is None else graph_id

        # 图谱上下文注入（SubTask 5.3）：在循环开始前异步获取并追加到首条 system 消息
        graph_block = await self._build_graph_context_block(eff_graph_id)
        if graph_block and messages and messages[0].get("role") == "system":
            messages[0]["content"] = str(messages[0].get("content", "")) + graph_block

        # 临时切换 self.mode 供 get_tools() 使用（不修改实例属性，用临时变量）
        original_mode = self.mode
        if tool_mode is not None:
            self.mode = eff_tool_mode
        try:
            tools = self.get_tools()
        finally:
            self.mode = original_mode

        for _iteration in range(MAX_TOOL_ITERATIONS):
            iteration_tokens: list[str] = []
            pending_tool_calls: list[dict[str, Any]] = []
            finish_reason: str | None = None

            # ---- 流式调用 LLM ----
            gen = self.llm_client.chat_stream(messages, tools=tools)
            try:
                async for event in gen:
                    if self._cancel_event.is_set():
                        partial = "".join(iteration_tokens)
                        assistant_content_parts.append(partial)
                        await self._save_assistant_message(
                            "".join(assistant_content_parts)
                        )
                        yield {"type": "done"}
                        return

                    etype = event.get("type")
                    if etype == "token":
                        content = event.get("content", "")
                        iteration_tokens.append(content)
                        yield {"type": "token", "content": content}
                    elif etype == "tool_call":
                        pending_tool_calls.append(event)
                    elif etype == "finish":
                        finish_reason = event.get("reason")
            except Exception as exc:  # noqa: BLE001
                partial = "".join(iteration_tokens)
                assistant_content_parts.append(partial)
                await self._save_assistant_message("".join(assistant_content_parts))
                yield {"type": "error", "message": str(exc)}
                yield {"type": "done"}
                return
            finally:
                await gen.aclose()

            iteration_text = "".join(iteration_tokens)

            # 兜底：Qwen 等 LM Studio 模型可能用 <tool_call> XML 而非原生 API
            if not pending_tool_calls and iteration_text:
                xml_calls = _parse_xml_tool_calls(iteration_text)
                if xml_calls:
                    iteration_text = _XML_TOOL_CALL_RE.sub("", iteration_text).strip()
                    pending_tool_calls = xml_calls

            assistant_content_parts.append(iteration_text)

            # ---- 判断是否需要执行工具 ----
            if not pending_tool_calls:
                await self._save_assistant_message("".join(assistant_content_parts))
                yield {"type": "done"}
                return

            # ---- 执行工具调用 ----
            assistant_tool_msg = self._build_assistant_tool_call_message(
                iteration_text, pending_tool_calls
            )
            messages.append(assistant_tool_msg)

            # 逐个执行工具并回填结果
            for tc in pending_tool_calls:
                if self._cancel_event.is_set():
                    break

                tool_name = tc.get("name", "")
                tool_call_id = tc.get("id", "")
                raw_args = tc.get("arguments", "")

                try:
                    args = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError:
                    args = {}

                # 通知前端即将执行工具
                yield {
                    "type": "tool_call",
                    "id": tool_call_id,
                    "tool": tool_name,
                    "args": args,
                }

                # ---- 高风险工具拦截（SubTask 5.4）----
                if tool_name in HIGH_RISK_TOOLS:
                    result = await self._intercept_high_risk_tool(
                        tool_name=tool_name,
                        args=args,
                        tool_mode=eff_tool_mode,
                        graph_id=eff_graph_id,
                    )
                else:
                    # ---- 普通工具执行 ----
                    is_mcp = tool_name.startswith(MCP_PREFIX)
                    allowed = (
                        mcp_manager.has_tool(tool_name)
                        if is_mcp
                        else self.tool_registry.is_tool_allowed(tool_name, eff_tool_mode)
                    )
                    if not allowed:
                        result = {
                            "status": "error",
                            "message": f"工具 {tool_name} 在 {eff_tool_mode} 模式下不可用",
                        }
                    elif is_mcp:
                        result = await mcp_manager.call_tool(tool_name, args)
                    else:
                        result = await self.tool_registry.execute(
                            tool_name, args, mode=eff_tool_mode
                        )

                yield {
                    "type": "tool_result",
                    "tool": tool_name,
                    "result": result,
                }

                # 回填 tool 角色消息
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )

            if self._cancel_event.is_set():
                await self._save_assistant_message("".join(assistant_content_parts))
                yield {"type": "done"}
                return

            # 继续下一轮 LLM 调用（带着工具结果）

        # ---- 达到迭代上限：强制结束 ----
        logger.warning(
            "达到 function calling 迭代上限 %d session=%s",
            MAX_TOOL_ITERATIONS,
            self.session_id,
        )
        await self._save_assistant_message("".join(assistant_content_parts))
        yield {
            "type": "error",
            "message": f"达到工具调用迭代上限（{MAX_TOOL_ITERATIONS}），已强制结束",
        }
        yield {"type": "done"}

    async def _intercept_high_risk_tool(
        self,
        *,
        tool_name: str,
        args: dict[str, Any],
        tool_mode: str,
        graph_id: str | None,
    ) -> dict[str, Any]:
        """高风险工具拦截逻辑（SubTask 5.4）。

        - Plan 模式：直接返回拒绝原因（不弹框）。
        - Build 模式：通过 WS 推送确认请求，等待用户响应 / 60s 超时。
          - 同意 → 执行工具，返回真实结果。
          - 拒绝 / 超时 → 把拒绝原因作为工具结果回填。

        Args:
            tool_name: 工具名（属于 ``HIGH_RISK_TOOLS``）。
            args: 工具调用参数。
            tool_mode: 工具模式（plan/build）。
            graph_id: 图谱 ID（WS 推送时附带给前端展示上下文）。

        Returns:
            工具结果 dict（可能是真实执行结果，也可能是拒绝原因）。
        """
        # Plan 模式：一律拒绝，不弹框
        if tool_mode == "plan":
            logger.info(
                "高风险工具 %s 在 Plan 模式下被拒绝 session=%s",
                tool_name,
                self.session_id,
            )
            return {
                "status": "error",
                "message": (
                    f"Plan 模式下不允许执行修改图谱的操作（{tool_name}），"
                    "请切换到 Build 模式后再试。"
                ),
                "rejected_by": "plan_mode",
            }

        # Build 模式：WS 推送确认请求，等待用户响应
        logger.info(
            "高风险工具 %s 在 Build 模式下触发确认 session=%s",
            tool_name,
            self.session_id,
        )
        confirmation = await request_tool_confirmation(
            session_id=self.session_id,
            tool_name=tool_name,
            args=args,
            timeout=TOOL_CONFIRMATION_TIMEOUT,
        )

        if not confirmation.get("approved"):
            reason = confirmation.get("reason", "用户拒绝")
            logger.info(
                "高风险工具 %s 被用户拒绝/超时 session=%s reason=%s",
                tool_name,
                self.session_id,
                reason,
            )
            return {
                "status": "error",
                "message": f"用户未同意执行 {tool_name}：{reason}",
                "rejected_by": "user",
                "reason": reason,
            }

        # 用户同意：执行工具
        logger.info(
            "高风险工具 %s 用户已同意，开始执行 session=%s",
            tool_name,
            self.session_id,
        )
        is_mcp = tool_name.startswith(MCP_PREFIX)
        if is_mcp:
            return await mcp_manager.call_tool(tool_name, args)
        return await self.tool_registry.execute(tool_name, args, mode=tool_mode)

    @staticmethod
    def _build_assistant_tool_call_message(
        content: str,
        tool_calls: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """构造含 tool_calls 的 assistant 消息（OpenAI 格式）。"""
        return {
            "role": "assistant",
            "content": content or None,
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
        }


# ============================================================================
# 全局单例（SubTask 5.5，对齐 graph_agent 模式）
# ============================================================================

#: 全局 MainAgent 单例（延迟初始化，``init_main_agent`` 时创建）
_main_agent: MainAgent | None = None

#: 模块级 ``main_agent`` 引用（为 None 时表示未初始化；供 ``from app.services.main_agent import main_agent`` 导入）
main_agent: MainAgent | None = None


def get_main_agent() -> MainAgent:
    """依赖注入：返回全局 MainAgent 单例。

    抽成函数便于后续在测试中替换依赖。

    Raises:
        RuntimeError: ``main_agent`` 未初始化（未调用 :func:`init_main_agent`）。
    """
    global main_agent
    if main_agent is None:
        raise RuntimeError(
            "main_agent 未初始化，请先在 main.py lifespan 中调用 init_main_agent()"
        )
    return main_agent


def init_main_agent(llm_client: LLMClient | None = None) -> MainAgent:
    """显式初始化全局 MainAgent（在 main.py lifespan 启动时调用）。

    Args:
        llm_client: LLM 客户端（为 None 时从 ``app.config.settings`` 默认值构造）。

    Returns:
        初始化后的 MainAgent 单例。
    """
    global main_agent, _main_agent
    if llm_client is None:
        # 从 settings 默认值构造 LLMClient（api_key 可能为空，实际调用时会报错）
        llm_client = LLMClient(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
        )
    # 单例使用 "default" session_id，实际会话由路由层创建独立 MainAgent 实例
    main_agent = MainAgent(
        session_id="default",
        llm_client=llm_client,
        mode="work",
        plan_mode=False,
        graph_id=None,
    )
    _main_agent = main_agent
    logger.info("MainAgent 已初始化（main_agent 单例就绪）")
    return main_agent


__all__ = [
    # 类
    "MainAgent",
    # 常量
    "MAX_TOOL_ITERATIONS",
    "TOOL_CONFIRMATION_TIMEOUT",
    "HIGH_RISK_TOOLS",
    # 高风险确认机制
    "request_tool_confirmation",
    "resolve_tool_confirmation",
    # 单例
    "main_agent",
    "get_main_agent",
    "init_main_agent",
]

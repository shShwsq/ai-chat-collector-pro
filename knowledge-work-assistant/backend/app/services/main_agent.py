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

# 图谱 Agent（KWA 已有）：用于 _build_context 注入图谱上下文
from app.services.graph_agent import graph_agent
from app.services.llm_client import LLMClient

# MCP 工具管理器（Task 2）：全局单例，提供 MCP 工具 schema 与调用入口
from app.services.mcp_manager import mcp_manager
from app.services.model_config import get_model_config
from app.services.multimodal.image_handler import encode_image_for_llm
from app.services.tool_registry import MCP_PREFIX, ToolRegistry, register_default_tools
from app.services.tools.task_tools import TaskStore

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
HIGH_RISK_TOOLS.update({"graph_extract_from_observation", "command_exec"})

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

    支持逐条确认：用户可在前端对 ``graph_confirm_work_objects`` 的 ``objects``
    数组进行逐项勾选，同意时通过 ``modified_args`` 回传筛选后的对象子集，
    工具循环将使用修改后的参数执行。

    Args:
        session_id: 会话 ID（WS 推送目标）。
        tool_name: 工具名（如 ``graph_extract_from_observation``）。
        args: 工具调用参数（供前端展示摘要与逐条预览）。
        timeout: 超时秒数（默认 60）。

    Returns:
        ``{"approved": bool, "reason": str, "modified_args": dict | None}``。
        超时返回 ``{"approved": False, "reason": "用户确认超时，已取消"}``。
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
    except TimeoutError:
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
    modified_args: dict[str, Any] | None = None,
) -> bool:
    """解析待确认的工具调用（由 ``POST /api/chat/requests/{id}/confirm`` 调用）。

    支持逐条确认：``modified_args`` 非空时，工具循环将使用修改后的参数执行
    （如仅入图用户勾选的工作对象子集）。

    Args:
        request_id: :func:`request_tool_confirmation` 生成的 request_id。
        approved: 用户是否同意。
        reason: 拒绝原因（approved=False 时有意义）。
        modified_args: 修改后的工具参数（approved=True 时有意义；如逐条确认
            后仅保留勾选的 ``objects`` 子集）。

    Returns:
        是否成功解析（request_id 不存在 / 已完成时返回 False）。
    """
    future = _pending_confirmations.get(request_id)
    if future is None or future.done():
        return False
    future.set_result({
        "approved": approved,
        "reason": reason,
        "modified_args": modified_args,
    })
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


# 测验题内容剥离：当调用了 graph_generate_quiz 工具时，LLM 可能在正文中
# 手写题目与选项（违反系统提示词规则）。此函数检测并剥离这些内容，
# 替换为简短引导语，确保正文不重复工具产出物。
_QUIZ_CONTENT_PATTERNS = [
    r"##\s*📝",           # markdown 标题：## 📝
    r"##\s*新测验题",
    r"\*\*题目[:：\*]",   # **题目：
    r"\*\*A[\.\*]",       # **A.
    r"^A[\.\s]",          # A. (行首)
    r"请选择[你的]?",     # 请选择你
    r"已生成\s+\w+_choice\s+题",  # 已生成 single_choice 题
    r"已生成\s+feynman\s+题",     # 已生成 feynman 题
]
_QUIZ_CONTENT_RE = re.compile(
    "|".join(f"(?:{p})" for p in _QUIZ_CONTENT_PATTERNS),
    re.MULTILINE,
)


def _strip_quiz_content(
    content: str,
    tool_calls: list[dict[str, Any]] | None,
) -> str:
    """当调用了 graph_generate_quiz 工具时，从正文中剥离手写的测验题内容。

    检测 tool_calls 中是否包含 graph_generate_quiz。如果包含且正文中有
    测验题模式（题目/选项/答案），则截断到第一个测验题模式之前，
    并追加简短引导语。

    Args:
        content: assistant 响应正文。
        tool_calls: 工具调用记录列表。

    Returns:
        清理后的正文（若无测验题模式或未调用 quiz 工具，原样返回）。
    """
    if not content or not tool_calls:
        return content
    has_quiz_tool = any(
        tc.get("tool") == "graph_generate_quiz" for tc in tool_calls
    )
    if not has_quiz_tool:
        return content
    match = _QUIZ_CONTENT_RE.search(content)
    if not match:
        return content
    # 截断到第一个测验题模式之前，保留前导引导语
    cleaned = content[: match.start()].rstrip()
    # 如果截断后内容为空或过短，补充引导语
    if len(cleaned) < 5:
        cleaned = "已为你生成一道测验题，点击下方选项作答。"
    else:
        cleaned = cleaned + "\n\n已为你生成一道测验题，点击下方选项作答。"
    return cleaned


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
        # 后台标题生成任务引用集合：防止 Task 被 GC 回收导致"Task was destroyed"警告
        self._title_tasks: set[asyncio.Task] = set()

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
        except TimeoutError:
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
            # 这两个列表声明在 try 块外，便于异常时也能保存已累积的内容
            assistant_tool_calls: list[dict[str, Any]] = []
            assistant_thinking_parts: list[str] = []

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
                    assistant_tool_calls,
                    assistant_thinking_parts,
                    tool_mode=effective_mode,
                    graph_id=effective_graph_id,
                ):
                    yield event

            except Exception as exc:  # noqa: BLE001
                logger.exception("MainAgent chat_stream 异常: %s", exc)
                # 异常时也尝试保存已累积的内容（content / thinking / tool_calls
                # 三个列表在 try 块外声明，这里可访问；_run_function_calling_loop
                # 内部异常未捕获时会冒泡到这里，需保证部分内容也能落库）。
                try:
                    await self._save_assistant_message(
                        "".join(assistant_content_parts),
                        assistant_tool_calls,
                        "".join(assistant_thinking_parts),
                    )
                except Exception:  # noqa: BLE001
                    logger.warning("异常分支保存 assistant 消息失败", exc_info=True)
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
        """保存用户消息到 DB，返回会话是否存在。

        若为首条用户消息（会话此前无 user 消息），用 user_text 截断作为
        会话标题——替换创建时生成的"mode 对话 时间"占位，与主流对话产品
        体验一致（首句问什么就叫什么）。
        """
        now = _now()
        async with AsyncSessionLocal() as db:
            session = await db.get(SessionRow, self.session_id)
            if session is None:
                return False
            # 是否已有 user 消息：决定是否更新标题
            existing_user = await db.scalar(
                select(MessageRow.id)
                .where(MessageRow.session_id == self.session_id)
                .where(MessageRow.role == "user")
                .limit(1)
            )
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
            # 首条用户消息：先用截断文本作兜底标题，再后台用 LLM 生成精炼标题
            if not existing_user:
                stripped = user_text.strip().replace("\n", " ")
                if stripped:
                    session.title = stripped[:40] + ("…" if len(stripped) > 40 else "")
                    task = asyncio.create_task(
                        self._generate_session_title(user_text)
                    )
                    self._title_tasks.add(task)
                    task.add_done_callback(self._title_tasks.discard)
            session.updated_at = now
            await db.commit()
        return True

    async def _generate_session_title(self, first_user_text: str) -> None:
        """用 LLM 基于首条用户消息生成精炼会话标题（≤20 字）。

        异步后台执行，不阻塞对话主流程。任何失败（LLM 不可用 / 超时 /
        产出为空）都静默降级，保留 :meth:`_save_user_message` 中设置的
        截断兜底标题。
        """
        text = first_user_text.strip()
        if not text:
            return
        try:
            result = await self.llm_client.chat(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "你是对话标题生成器。根据用户的第一句话，生成一个"
                            "简洁的中文会话标题，不超过 20 个字，用于会话列表展示。"
                            "要求：只输出标题本身，不要引号、标点、编号、emoji 或解释。"
                        ),
                    },
                    {"role": "user", "content": text},
                ],
                temperature=0.2,
            )
        except Exception as exc:  # noqa: BLE001 - 标题生成失败不影响主流程
            logger.warning(
                "LLM 生成会话标题失败 session=%s: %s", self.session_id, exc
            )
            return
        raw_title = (result.get("content") or "").strip()
        raw_title = raw_title.strip("\"'“”「」")
        title = re.sub(r"[\r\n]+", " ", raw_title).strip()
        if not title:
            return
        title = title[:20]
        async with AsyncSessionLocal() as db:
            session = await db.get(SessionRow, self.session_id)
            if session is None:
                return
            session.title = title
            session.updated_at = _now()
            await db.commit()

    async def _save_assistant_message(
        self,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
        thinking: str = "",
    ) -> None:
        """保存 assistant 消息到 DB。

        只要 content / thinking / tool_calls 三者中任一非空即保存，
        避免以下场景丢失历史：
        - LLM 仅产出思维链（reasoning_content）而无正文 token（Qwen 等模型）；
        - LLM 在工具调用阶段被取消，正文为空但已有 thinking + tool_calls 记录；
        - LLM 返回空内容但携带了工具调用。

        Args:
            content: assistant 回答正文。
            tool_calls: 工具调用过程记录（含 tool / args / result / status），
                持久化为 JSON 字符串，便于前端重载会话时恢复工具调用卡片。
            thinking: 思维链内容，持久化为纯文本，便于前端重载时恢复折叠展示。
        """
        has_content = bool(content and content.strip())
        has_thinking = bool(thinking and thinking.strip())
        has_tool_calls = bool(tool_calls)
        if not (has_content or has_thinking or has_tool_calls):
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
                    # default=str 兜底：tool_calls 中的 result 可能包含 ORM 对象
                    # 携带的 datetime / UUID 等非 JSON 原生类型（例如
                    # graph_generate_quiz 返回的题目记录含 created_at），
                    # 避免序列化失败导致整个 assistant 消息无法落库。
                    tool_calls=json.dumps(
                        tool_calls or [], ensure_ascii=False, default=str
                    ),
                    thinking=thinking or "",
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
        # graph_agent._build_context 是 async，但本方法是 sync（在 chat_stream
        # 同步段调用）。实际注入在 chat_stream 中通过 _inject_graph_context 异步完成。
        # eff_graph_id 在此仅作为是否启用图谱上下文注入的标志，由 chat_stream 读取。
        if eff_graph_id:
            logger.debug("system_message 启用图谱上下文注入 graph_id=%s", eff_graph_id)

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
        assistant_tool_calls: list[dict[str, Any]],
        assistant_thinking_parts: list[str],
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
            assistant_tool_calls: 累积的工具调用记录（跨迭代，持久化用）。
            assistant_thinking_parts: 累积的思维链片段（跨迭代，持久化用）。
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
            iteration_thinking_parts: list[str] = []
            pending_tool_calls: list[dict[str, Any]] = []

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
                    elif etype == "thinking":
                        # 思维链增量：独立产出，不混入正文 token
                        thinking_content = event.get("content", "")
                        iteration_thinking_parts.append(thinking_content)
                        assistant_thinking_parts.append(thinking_content)
                        yield {"type": "thinking", "content": thinking_content}
                    elif etype == "tool_call":
                        pending_tool_calls.append(event)
                    elif etype == "finish":
                        # finish 事件仅标志本轮 LLM 调用结束，reason 字段当前未使用
                        pass
            except Exception as exc:  # noqa: BLE001
                partial = "".join(iteration_tokens)
                assistant_content_parts.append(partial)
                await self._save_assistant_message(
                    "".join(assistant_content_parts),
                    assistant_tool_calls,
                    "".join(assistant_thinking_parts),
                )
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
                final_content = "".join(assistant_content_parts)
                final_thinking = "".join(assistant_thinking_parts)
                # 后处理：剥离正文中手写的测验题内容（graph_generate_quiz 专属）
                cleaned_content = _strip_quiz_content(
                    final_content, assistant_tool_calls
                )
                if cleaned_content != final_content:
                    # 通知前端替换已显示的正文（流式 token 可能已推送过原始内容）
                    yield {"type": "content_replace", "content": cleaned_content}
                    final_content = cleaned_content
                await self._save_assistant_message(
                    final_content,
                    assistant_tool_calls,
                    final_thinking,
                )
                yield {"type": "done"}
                return

            # ---- 执行工具调用 ----
            assistant_tool_msg = self._build_assistant_tool_call_message(
                iteration_text, pending_tool_calls
            )
            messages.append(assistant_tool_msg)

            # ---- 执行工具调用（支持并行，SubTask 并行改造）----
            # 依赖分析：args 含 $prev / ${...} 占位符 → 串行；
            # 高风险工具 → 串行（需 WS 确认）；其余默认并行。
            force_serial = False
            for tc in pending_tool_calls:
                if tc.get("name", "") in HIGH_RISK_TOOLS:
                    force_serial = True
                    break
                _preview = self._parse_tool_call_args(tc.get("arguments", ""))
                _raw = json.dumps(_preview, ensure_ascii=False, default=str)
                if "$prev" in _raw or "${" in _raw:
                    force_serial = True
                    break

            if force_serial:
                # 串行执行（保持原顺序；高风险工具逐个 WS 确认）
                for tc in pending_tool_calls:
                    if self._cancel_event.is_set():
                        break
                    result, tc_event = await self._execute_tool_call(
                        tc, eff_tool_mode, eff_graph_id
                    )
                    tool_call_id = tc_event["id"]
                    tool_name = tc_event["tool"]
                    yield tc_event
                    assistant_tool_calls.append({
                        "id": tool_call_id,
                        "tool": tool_name,
                        "args": tc_event["args"],
                        "status": "pending",
                    })
                    yield {"type": "tool_result", "tool": tool_name, "result": result}
                    self._mark_tool_call_status(assistant_tool_calls, tool_call_id, result)
                    # 回填 tool 角色消息（default=str 兜底非 JSON 原生类型）
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": json.dumps(result, ensure_ascii=False, default=str),
                    })
            else:
                # 并行执行（无依赖且无高风险）
                if not self._cancel_event.is_set():
                    coros = [
                        self._execute_tool_call(tc, eff_tool_mode, eff_graph_id)
                        for tc in pending_tool_calls
                    ]
                    pairs = await asyncio.gather(*coros)
                    # 按原顺序产出事件与回填 tool 消息
                    # （顺序须与 assistant 消息中 tool_calls 一致）
                    for result, tc_event in pairs:
                        tool_call_id = tc_event["id"]
                        tool_name = tc_event["tool"]
                        yield tc_event
                        assistant_tool_calls.append({
                            "id": tool_call_id,
                            "tool": tool_name,
                            "args": tc_event["args"],
                            "status": "pending",
                        })
                        yield {"type": "tool_result", "tool": tool_name, "result": result}
                        self._mark_tool_call_status(
                            assistant_tool_calls, tool_call_id, result
                        )
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(result, ensure_ascii=False, default=str),
                        })

            if self._cancel_event.is_set():
                await self._save_assistant_message(
                    "".join(assistant_content_parts),
                    assistant_tool_calls,
                    "".join(assistant_thinking_parts),
                )
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
        # 逐条确认时，前端可能回传 modified_args（如仅勾选的工作对象子集），
        # 用修改后的参数执行，实现部分入图。
        modified_args = confirmation.get("modified_args")
        effective_args = args
        if modified_args and isinstance(modified_args, dict):
            logger.info(
                "高风险工具 %s 使用 modified_args 执行 session=%s",
                tool_name,
                self.session_id,
            )
            effective_args = modified_args
        if tool_name == "command_exec":
            effective_args = {**effective_args, "_confirmed": True}

        logger.info(
            "高风险工具 %s 用户已同意，开始执行 session=%s",
            tool_name,
            self.session_id,
        )
        is_mcp = tool_name.startswith(MCP_PREFIX)
        if is_mcp:
            return await mcp_manager.call_tool(tool_name, effective_args)
        return await self.tool_registry.execute(
            tool_name, effective_args, mode=tool_mode
        )

    # ==================================================================
    # 内部：工具调用解析 / 重试 / 分发（SubTask 重试 + 并行改造）
    # ==================================================================

    def _parse_tool_call_args(self, raw_args: str) -> dict[str, Any]:
        """解析工具调用参数 JSON，带多级修复尝试。

        修复顺序：
        1. 直接 ``json.loads``；
        2. 移除 markdown 代码块包装（```json ... ```）后解析；
        3. 正则提取首个 JSON 对象（``{...}``）后解析；
        4. ``json.loads(raw_args, strict=False)`` 容忍控制字符；
        5. 全部失败返回空 dict 并记录 warning（含原始 raw_args 前 200 字符）。

        Args:
            raw_args: LLM 返回的 arguments 字符串（可能为空 / 含 markdown
                包装 / 含控制字符 / 截断）。

        Returns:
            解析后的参数 dict。
        """
        if not raw_args:
            return {}
        # 1. 直接解析
        try:
            return json.loads(raw_args)
        except json.JSONDecodeError:
            pass
        # 2. 移除 markdown 代码块包装
        stripped = re.sub(r"^```(?:json)?\s*", "", raw_args.strip(), flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped).strip()
        if stripped and stripped != raw_args.strip():
            try:
                return json.loads(stripped)
            except json.JSONDecodeError:
                pass
        # 3. 提取首个 JSON 对象
        match = re.search(r"\{.*\}", raw_args, flags=re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
        # 4. strict=False 容忍控制字符
        try:
            return json.loads(raw_args, strict=False)
        except json.JSONDecodeError:
            pass
        # 5. 全部失败
        logger.warning(
            "工具参数 JSON 解析失败，使用空 dict。raw_args 前 200 字符: %r",
            raw_args[:200],
        )
        return {}

    async def _execute_tool_with_retry(
        self,
        tool_name: str,
        args: dict[str, Any],
        mode: str,
        max_retries: int = 2,
    ) -> dict[str, Any]:
        """执行普通工具，对瞬时失败重试。

        瞬时失败判定：返回 ``{"status": "error", "message": ...}`` 且 message 含
        ``timeout`` / ``temporarily`` / ``connection`` / ``EOF`` 之一。

        - 最多重试 ``max_retries`` 次，每次间隔 0.5s（``asyncio.sleep``）。
        - 非瞬时失败（参数错误 / 权限拒绝 / 资源不存在）不重试，直接返回。
        - 高风险工具不在此处重试（由 ``_intercept_high_risk_tool`` 单独处理）。
        - MCP 工具不在此处重试（可能涉及外部状态）。
        - 注入 ``_scenario`` 供 skill_* 等需要场景感知的工具使用。

        Args:
            tool_name: 工具名（非高风险、非 MCP）。
            args: 调用参数。
            mode: 工具模式（plan/build）。
            max_retries: 最大重试次数（默认 2）。

        Returns:
            工具执行结果 dict。
        """
        # 注入 _scenario（供 skill_list 等工具读取当前场景）
        call_args = dict(args or {})
        if "_scenario" not in call_args:
            call_args["_scenario"] = self.scenario_mode
        transient_markers = ("timeout", "temporarily", "connection", "EOF")
        last_result: dict[str, Any] = {}
        for attempt in range(max_retries + 1):
            result = await self.tool_registry.execute(tool_name, call_args, mode=mode)
            last_result = (
                result if isinstance(result, dict) else {"status": "ok", "result": result}
            )
            if last_result.get("status") == "error":
                msg = str(last_result.get("message", ""))
                if any(m in msg for m in transient_markers) and attempt < max_retries:
                    logger.info(
                        "工具 %s 瞬时失败(第 %d/%d 次)，0.5s 后重试: %s",
                        tool_name,
                        attempt + 1,
                        max_retries,
                        msg[:120],
                    )
                    await asyncio.sleep(0.5)
                    continue
            # 成功 / 非瞬时失败 / 重试耗尽
            if attempt > 0:
                logger.info(
                    "工具 %s 重试后最终状态: %s (重试 %d 次)",
                    tool_name,
                    last_result.get("status"),
                    attempt,
                )
            return last_result
        return last_result

    async def _execute_tool_call(
        self,
        tc: dict[str, Any],
        eff_tool_mode: str,
        eff_graph_id: str | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """执行单个工具调用，返回 ``(结果, tool_call 事件)``。

        解析参数 → 构造 tool_call 事件 → 按工具类型分发执行：
        - 高风险工具：``_intercept_high_risk_tool``（WS 确认）；
        - MCP 工具：``mcp_manager.call_tool``（不重试，可能涉及外部状态）；
        - 普通工具：``_execute_tool_with_retry``（瞬时失败重试 + _scenario 注入）。

        Args:
            tc: 工具调用事件 dict（含 id / name / arguments）。
            eff_tool_mode: 工具模式（plan/build）。
            eff_graph_id: 图谱 ID（高风险拦截 WS 推送时附带）。

        Returns:
            ``(result, tool_call_event)`` 元组。``tool_call_event`` 形如
            ``{"type": "tool_call", "id", "tool", "args"}``。
        """
        tool_name = tc.get("name", "")
        tool_call_id = tc.get("id", "")
        args = self._parse_tool_call_args(tc.get("arguments", ""))
        tool_call_event = {
            "type": "tool_call",
            "id": tool_call_id,
            "tool": tool_name,
            "args": args,
        }

        # 高风险工具拦截
        if tool_name in HIGH_RISK_TOOLS:
            result = await self._intercept_high_risk_tool(
                tool_name=tool_name,
                args=args,
                tool_mode=eff_tool_mode,
                graph_id=eff_graph_id,
            )
            return result, tool_call_event

        # 普通工具（本地 / MCP）
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
            # MCP 工具暂不重试（可能涉及外部状态）
            result = await mcp_manager.call_tool(tool_name, args)
        else:
            result = await self._execute_tool_with_retry(
                tool_name, args, mode=eff_tool_mode
            )
        return result, tool_call_event

    @staticmethod
    def _mark_tool_call_status(
        assistant_tool_calls: list[dict[str, Any]],
        tool_call_id: str,
        result: dict[str, Any],
    ) -> None:
        """更新累积列表中对应工具调用的状态与结果（持久化用）。

        找到最后一个同 id 且 pending 的条目，标记为 done / error 并写入 result。
        """
        for idx in range(len(assistant_tool_calls) - 1, -1, -1):
            tc_entry = assistant_tool_calls[idx]
            if (
                tc_entry.get("id") == tool_call_id
                and tc_entry.get("status") == "pending"
            ):
                status = (
                    "error"
                    if isinstance(result, dict) and result.get("status") == "error"
                    else "done"
                )
                tc_entry["status"] = status
                tc_entry["result"] = result
                break

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

#: 模块级 ``main_agent`` 引用（为 None 时表示未初始化；供
#: ``from app.services.main_agent import main_agent`` 导入）
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

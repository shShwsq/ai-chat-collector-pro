"""Function Calling 工具注册表（Task 2 适配移植）。

定义工具 schema（OpenAI function calling 格式）与统一执行框架：

- **本地工具**（Task 3 实现，见 :mod:`app.services.tools`）：
  file_read / file_write / file_list / command_exec / open_app /
  open_url / system_notification / screenshot / clipboard_read /
  clipboard_write / append_note / task_*
- **知识库检索**：``knowledge_search``（基于标签 + 关键词 + 描述句的三路检索，
  委托 KWA 已有的 :mod:`app.services.knowledge_store`）
- **图谱工具**（Task 7 实现，见 :mod:`app.services.tools.graph_tools`）：
  graph_query_nodes / graph_get_node_detail / graph_get_context /
  graph_extract_from_observation / graph_generate_quiz /
  graph_generate_trends / graph_generate_report
- **MCP 工具**：命名空间 ``mcp.{server_name}.{tool_name}``，由 :mod:`app.services.mcp_manager` 实现

KWA 适配说明（相对步影原版）：
- **裁剪未移植工具**（SubTask 3.4）：移除 ``web_search`` / ``skill_list`` /
  ``skill_activate`` / ``checkpoint_search`` / ``message_search`` / ``deep_search``
  的注册（依赖步影 ``tools/web_search`` / ``tools/skill_tools`` / ``tools/search_tools``
  / ``agents/search_agent``，KWA 暂不移植）。
- **append_note 改为 no-op**：步影原版调用 ``notes`` 模块落盘便签本；KWA 无 ``notes``
  模块，handler 改为仅返回成功消息不落盘（对齐 ``context_manager.append_note`` 的 no-op）。
- **全局 ``tool_registry`` 单例不再自动 ``register_default_tools``**：避免模块加载时
  触发 ``tools.file_tools`` 等未就位模块的导入。``MainAgent`` 实例化时会显式调用
  ``register_default_tools`` 注册到自己的会话级注册表；``mcp_manager`` 单独向全局
  ``tool_registry`` 注册 MCP 工具。

工具按 ``allowed_modes`` 过滤：
- plan 模式：仅返回受限只读工具（不可写文件、不可执行命令）；
  ``file_read`` 还会进一步限制只能读取用户上传目录（``data_dir/files/``）。
- build 模式：返回全部工具。

``ToolRegistry.execute`` 接受可选的 ``mode`` 参数并注入 ``args["_mode"]``，
供需要模式感知的 handler（如 ``file_read``）分支。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# 工具 handler 签名：(args: dict) -> result: dict
ToolHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

# MCP 工具命名前缀
MCP_PREFIX = "mcp."


@dataclass
class ToolEntry:
    """单个工具的注册条目。

    Attributes:
        name: 工具名（MCP 工具形如 ``mcp.{server}.{tool}``）。
        schema: OpenAI function calling 格式的完整 schema
            ``{"type": "function", "function": {"name", "description", "parameters"}}``。
        handler: 异步执行函数，接收 args dict，返回 result dict。
        allowed_modes: 允许使用的模式列表（``["plan", "build"]`` 的子集）。
        is_mcp: 是否为 MCP 工具。
    """

    name: str
    schema: dict[str, Any]
    handler: ToolHandler
    allowed_modes: list[str] = field(default_factory=lambda: ["plan", "build"])
    is_mcp: bool = False


class ToolRegistry:
    """工具注册表：管理本地工具与 MCP 工具的注册、查询与执行。

    用法::

        registry = ToolRegistry()
        register_default_tools(registry)
        schemas = registry.get_tool_schemas("build")
        result = await registry.execute("file_read", {"path": "/tmp/x.txt"})
    """

    def __init__(self) -> None:
        # name -> ToolEntry（本地工具与 MCP 工具统一存储）
        self._tools: dict[str, ToolEntry] = {}

    # ==================================================================
    # 注册
    # ==================================================================

    def register(
        self,
        name: str,
        schema: dict[str, Any],
        handler: ToolHandler,
        allowed_modes: list[str] | None = None,
    ) -> None:
        """注册一个工具。

        Args:
            name: 工具名（全局唯一，重复注册覆盖旧值）。
            schema: OpenAI function calling schema。若不含外层 ``type`` 包装，
                会自动补全为 ``{"type":"function","function": schema}``。
            handler: 异步执行函数 ``(args) -> result``。
            allowed_modes: 允许使用的模式，默认 ``["plan", "build"]``。
        """
        # 容错：允许传入裸 function schema（无 type 包装）
        if "function" not in schema and "name" in schema:
            schema = {"type": "function", "function": schema}
        entry = ToolEntry(
            name=name,
            schema=schema,
            handler=handler,
            allowed_modes=list(allowed_modes) if allowed_modes else ["plan", "build"],
            is_mcp=name.startswith(MCP_PREFIX),
        )
        self._tools[name] = entry
        logger.debug("注册工具 %s (modes=%s)", name, entry.allowed_modes)

    def register_mcp_tool(
        self,
        server_name: str,
        tool_name: str,
        schema: dict[str, Any],
        handler: ToolHandler,
        allowed_modes: list[str] | None = None,
    ) -> str:
        """注册一个 MCP 工具，返回完整工具名。

        MCP 工具命名空间：``mcp.{server_name}.{tool_name}``，避免与本地工具冲突。

        Args:
            server_name: MCP 服务器名。
            tool_name: MCP 工具名。
            schema: OpenAI function calling schema（裸 function 或含 type 包装均可）。
            handler: 异步执行函数。
            allowed_modes: 允许使用的模式，默认 ``["plan", "build"]``。

        Returns:
            完整工具名 ``mcp.{server_name}.{tool_name}``。
        """
        full_name = f"{MCP_PREFIX}{server_name}.{tool_name}"
        # 确保 schema 中 function.name 使用完整名
        if "function" in schema:
            schema["function"]["name"] = full_name
        elif "name" in schema:
            schema["name"] = full_name
        self.register(full_name, schema, handler, allowed_modes)
        return full_name

    def unregister(self, name: str) -> bool:
        """注销一个工具。返回是否曾存在。"""
        return self._tools.pop(name, None) is not None

    def unregister_mcp_server(self, server_name: str) -> int:
        """注销某 MCP 服务器的全部工具，返回注销数量。"""
        prefix = f"{MCP_PREFIX}{server_name}."
        names = [n for n in self._tools if n.startswith(prefix)]
        for n in names:
            self._tools.pop(n, None)
        return len(names)

    # ==================================================================
    # 查询
    # ==================================================================

    def get_tool_schemas(self, mode: str) -> list[dict[str, Any]]:
        """返回指定模式下可用的工具 schema 列表（OpenAI function calling 格式）。

        Args:
            mode: ``"plan"`` 或 ``"build"``。

        Returns:
            schema 列表，可直接传给 ``LLMClient.chat_stream(tools=...)``。
        """
        schemas: list[dict[str, Any]] = []
        for entry in self._tools.values():
            if mode in entry.allowed_modes:
                schemas.append(entry.schema)
        return schemas

    def get_tool_names(self, mode: str) -> list[str]:
        """返回指定模式下可用的工具名列表。"""
        return [
            entry.name
            for entry in self._tools.values()
            if mode in entry.allowed_modes
        ]

    def is_tool_allowed(self, name: str, mode: str) -> bool:
        """检查某工具在指定模式下是否可用。"""
        entry = self._tools.get(name)
        if entry is None:
            return False
        return mode in entry.allowed_modes

    def has_tool(self, name: str) -> bool:
        """是否注册了某工具。"""
        return name in self._tools

    # ==================================================================
    # 执行
    # ==================================================================

    async def execute(
        self, name: str, args: dict[str, Any], mode: str | None = None
    ) -> dict[str, Any]:
        """执行指定工具。

        Args:
            name: 工具名。
            args: 调用参数。
            mode: 当前会话模式（``"plan"`` / ``"build"``）。非 None 时注入
                ``args["_mode"]`` 副本，供需要模式感知的 handler（如
                ``file_read``）分支；为 None 时按 Build 语义处理（兼容独立调用）。

        Returns:
            工具执行结果 dict。工具不存在或 handler 异常时返回错误 dict，
            不抛异常（保证主流程不中断）。
        """
        entry = self._tools.get(name)
        if entry is None:
            return {
                "status": "error",
                "message": f"工具未注册: {name}",
            }
        # 模式权限校验：显式模式下，不在 allowed_modes 中的工具拒绝执行
        if mode is not None and mode not in entry.allowed_modes:
            return {
                "status": "error",
                "message": f"工具 {name} 在 {mode} 模式下不可用",
            }
        try:
            # 注入 _mode 供需要模式感知的 handler 使用（不污染调用方 args）
            call_args = dict(args or {})
            if mode is not None and "_mode" not in call_args:
                call_args["_mode"] = mode
            result = await entry.handler(call_args)
            if not isinstance(result, dict):
                # 统一为 dict
                result = {"status": "ok", "result": result}
            return result
        except Exception as exc:  # noqa: BLE001
            logger.exception("工具执行异常 %s: %s", name, exc)
            return {
                "status": "error",
                "message": f"工具执行异常: {exc}",
                "tool": name,
            }


# ======================================================================
# 占位 handler（保留供未来新增未实现工具使用；默认工具均已接入真实实现）
# ======================================================================

async def _placeholder_handler(args: dict[str, Any]) -> dict[str, Any]:
    """占位 handler：未实现工具返回 not_implemented。

    保留以备未来新增工具占位之用（如 Task 7 之前的图谱工具占位）。
    """
    return {"status": "not_implemented", "todo": "Task 3/7", "args": args}


async def _knowledge_search_handler(args: dict[str, Any]) -> dict[str, Any]:
    """knowledge_search 工具 handler：基于标签 + 关键词 + 描述句的三路检索。

    支持两种调用方式：
    1. 旧签名：``{"query": "...", "top_k": 5}``（query 作为关键词检索）
    2. 新签名：``{"tags": [...], "keywords": [...], "description": "...",
       "page": 1, "page_size": 10}``（三路检索 + 分页）

    新签名优先；当未提供 tags/keywords/description 时，query 作为 keyword。
    委托 KWA 已有的 :mod:`app.services.knowledge_store`。
    """
    from app.services.knowledge_store import knowledge_store

    query = args.get("query") or ""
    tags = args.get("tags") or []
    keywords = args.get("keywords") or []
    description = args.get("description") or ""
    page = int(args.get("page") or 1)
    top_k = int(args.get("top_k") or 0)
    page_size = int(args.get("page_size") or 0)
    # 兼容旧 top_k 参数
    if top_k and not page_size:
        page_size = top_k

    has_new_params = any([tags, keywords, description])
    if not has_new_params and not query:
        return {"status": "error", "message": "至少提供 query / tags / keywords / description 之一"}

    try:
        results = await knowledge_store.search(
            query=query,
            tags=tags if has_new_params else None,
            keywords=keywords if has_new_params else None,
            description=description,
            page=page,
            page_size=page_size if page_size else None,
            top_k=top_k,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("knowledge_search 工具执行失败 args=%r: %s", args, exc)
        return {"status": "error", "message": f"知识库检索失败: {exc}"}
    return {
        "status": "ok",
        "query": query,
        "results": results,
        "count": len(results),
    }


# ======================================================================
# 默认工具 schema 定义
# ======================================================================

def _build_schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    """构造 OpenAI function calling 格式的 schema。"""
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
            },
        },
    }


# 默认工具定义：(name, schema, allowed_modes)
# KWA 适配：已移除 web_search / skill_list / skill_activate / checkpoint_search /
# message_search / deep_search（依赖未移植模块，见 SubTask 3.4）
_DEFAULT_TOOL_DEFS: list[tuple[str, dict[str, Any], list[str]]] = [
    (
        "file_read",
        _build_schema(
            "file_read",
            "读取指定文件的内容。plan 与 build 模式均可用。"
            "返回文件文本内容（大文件会被截断）。\n"
            "plan 模式仅允许读取已上传文件目录（data_dir/files/）；"
            "build 模式可读任意路径（系统敏感目录除外）。",
            {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径（绝对路径或相对于 data_dir 的相对路径）",
                },
                "max_size": {
                    "type": "integer",
                    "description": "最多读取的字节数（可选，默认 100000，超出则截断）",
                },
            },
            required=["path"],
        ),
        ["plan", "build"],
    ),
    (
        "file_write",
        _build_schema(
            "file_write",
            "向指定文件写入内容（覆盖）。仅 build 模式可用。",
            {
                "path": {
                    "type": "string",
                    "description": "要写入的文件绝对路径",
                },
                "content": {
                    "type": "string",
                    "description": "要写入的完整内容",
                },
                "append": {
                    "type": "boolean",
                    "description": "是否追加模式（默认 false 覆盖）",
                },
            },
            required=["path", "content"],
        ),
        ["build"],
    ),
    (
        "file_list",
        _build_schema(
            "file_list",
            "列出指定目录下的文件与子目录。plan 与 build 模式均可用。"
            "返回每个条目的名称、大小、修改时间与是否目录。",
            {
                "path": {
                    "type": "string",
                    "description": "目录路径（可选，默认 data_dir；相对路径相对于 data_dir 解析）",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "是否递归列出子目录（可选，默认 false）",
                },
            },
            required=[],
        ),
        ["plan", "build"],
    ),
    (
        "command_exec",
        _build_schema(
            "command_exec",
            "在本地执行 shell 命令。仅 build 模式可用。"
            "执行有风险，请确认命令安全性后再调用。"
            "Windows 默认用 PowerShell 执行；超时默认 30 秒；"
            r"危险命令（rm -rf /、format、del /f /s /q C:\* 等）会被黑名单拒绝。",
            {
                "command": {
                    "type": "string",
                    "description": "要执行的命令（含参数）",
                },
                "cwd": {
                    "type": "string",
                    "description": "工作目录（可选）",
                },
                "timeout": {
                    "type": "integer",
                    "description": "超时秒数（可选，默认 30）",
                },
                "require_confirmation": {
                    "type": "boolean",
                    "description": (
                        "是否需要用户确认（可选，默认 true）。"
                        "当前实现自动确认直接执行，真正的确认 UI 由前端实现。"
                    ),
                },
            },
            required=["command"],
        ),
        ["build"],
    ),
    (
        "open_app",
        _build_schema(
            "open_app",
            "打开本地应用程序。仅 build 模式可用。",
            {
                "app_path": {
                    "type": "string",
                    "description": "应用名称或可执行路径",
                },
            },
            required=["app_path"],
        ),
        ["build"],
    ),
    (
        "open_url",
        _build_schema(
            "open_url",
            "用系统默认浏览器打开 URL。plan 与 build 模式均可用。",
            {
                "url": {
                    "type": "string",
                    "description": "要打开的 URL",
                },
            },
            required=["url"],
        ),
        ["plan", "build"],
    ),
    (
        "system_notification",
        _build_schema(
            "system_notification",
            "发送系统桌面通知。plan 与 build 模式均可用。",
            {
                "title": {
                    "type": "string",
                    "description": "通知标题",
                },
                "body": {
                    "type": "string",
                    "description": "通知正文",
                },
            },
            required=["title"],
        ),
        ["plan", "build"],
    ),
    (
        "screenshot",
        _build_schema(
            "screenshot",
            "截取当前屏幕全屏图像并返回路径。plan 与 build 模式均可用。",
            {
                "monitor": {
                    "type": "integer",
                    "description": "显示器编号（可选，默认 0 主屏）",
                },
            },
            required=[],
        ),
        ["plan", "build"],
    ),
    (
        "clipboard_read",
        _build_schema(
            "clipboard_read",
            "读取系统剪贴板内容。plan 与 build 模式均可用。",
            {
                "format": {
                    "type": "string",
                    "description": "剪贴板格式（text/image，默认 text）",
                },
            },
            required=[],
        ),
        ["plan", "build"],
    ),
    (
        "clipboard_write",
        _build_schema(
            "clipboard_write",
            "写入系统剪贴板。仅 build 模式可用。",
            {
                "content": {
                    "type": "string",
                    "description": "要写入剪贴板的文本",
                },
            },
            required=["content"],
        ),
        ["build"],
    ),
    (
        "knowledge_search",
        _build_schema(
            "knowledge_search",
            "本地知识库检索（基于标签 + 关键词 + 描述句的三路检索）。plan 与 build 模式均可用。"
            "用于检索已上传并索引的文件内容。\n"
            "返回按综合得分排序的结果（含 file_id / original_name / summary / tags / score）。",
            {
                "query": {
                    "type": "string",
                    "description": "检索查询（当未提供 tags/keywords/description 时作为关键词检索）",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "相关标签列表（在文件标签中匹配，命中权重高）",
                },
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "关键词列表（在 summary / original_name 中匹配）",
                },
                "description": {
                    "type": "string",
                    "description": "描述性句子：文档中可能包含的内容（非查询需求）。"
                    "正确示例：'5月的销售额为...'；错误示例：'销售额是多少'",
                },
                "page": {
                    "type": "integer",
                    "description": "页码（从 1 开始，默认 1）",
                },
                "page_size": {
                    "type": "integer",
                    "description": "每页条数（默认 10，最大 50）",
                },
            },
            required=[],
        ),
        ["plan", "build"],
    ),
    (
        "append_note",
        _build_schema(
            "append_note",
            "向便签本（notes.md）追加一条零散记录。plan 与 build 模式均可用。"
            "当你发现临时信息、用户偏好、待查项时，随手记入便签本，"
            "Writer Subagent 会在 checkpoint 时读取并路由到结构化字段。"
            "不要试图记忆所有细节，专注决策与回答用户问题。\n"
            "KWA 适配：当前为 no-op（不落盘），仅返回成功消息。",
            {
                "note": {
                    "type": "string",
                    "description": "要记录的内容（一句话即可）",
                },
            },
            required=["note"],
        ),
        ["plan", "build"],
    ),
    (
        "task_create",
        _build_schema(
            "task_create",
            "创建一个任务（会话内存级 TaskList）。plan 与 build 模式均可用。\n"
            "用于拆解复杂多步骤任务。返回任务的 id（用于后续 update/delete）。\n"
            "任务状态默认 pending，开始执行时用 task_update 标记 in_progress，"
            "完成时标记 completed。",
            {
                "subject": {
                    "type": "string",
                    "description": "任务标题（简短、具体、可执行，如'读取 report.pdf 并提取数据'）",
                },
                "description": {
                    "type": "string",
                    "description": "任务详细描述（可选，如所用工具与预期产出）",
                },
            },
            required=["subject"],
        ),
        ["plan", "build"],
    ),
    (
        "task_list",
        _build_schema(
            "task_list",
            "列出当前会话的全部任务（不含已删除）。plan 与 build 模式均可用。\n"
            "返回任务列表与数量，用于查看进度。",
            {},
            required=[],
        ),
        ["plan", "build"],
    ),
    (
        "task_update",
        _build_schema(
            "task_update",
            "更新任务的状态/标题/描述。plan 与 build 模式均可用。\n"
            "状态流转：pending → in_progress → completed；deleted 表示作废。\n"
            "开始执行任务时标记 in_progress，完成时标记 completed。",
            {
                "task_id": {
                    "type": "string",
                    "description": "任务 id（task_create 返回的 id）",
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "completed", "deleted"],
                    "description": "新状态（可选）",
                },
                "subject": {
                    "type": "string",
                    "description": "新标题（可选，留空则不改）",
                },
                "description": {
                    "type": "string",
                    "description": "新描述（可选，留空则不改）",
                },
            },
            required=["task_id"],
        ),
        ["plan", "build"],
    ),
    (
        "task_delete",
        _build_schema(
            "task_delete",
            "删除一个任务（标记为 deleted）。plan 与 build 模式均可用。\n"
            "任务作废时使用，区别于 task_update status=completed。",
            {
                "task_id": {
                    "type": "string",
                    "description": "要删除的任务 id",
                },
            },
            required=["task_id"],
        ),
        ["plan", "build"],
    ),
]


#: KWA 不暴露给 main_agent 的步影通用桌面工具集合。
#:
#: 这些工具移植自步影项目，针对桌面端 agent 设计（读写本地文件、执行 shell、
#: 操作剪贴板、截屏、桌面通知、打开应用/URL），但 KWA 是 Web/Electron 应用，
#: agent 在服务端运行，这些工具在 KWA 场景下无意义且部分有安全风险：
#:
#: - ``file_read / file_write / file_list``：服务端不该读写用户本地文件
#: - ``command_exec``：服务端不该执行 shell
#: - ``open_app / open_url``：前端职责（前端按需自行实现）
#: - ``system_notification / screenshot``：前端职责
#: - ``clipboard_read / clipboard_write``：前端职责
#: - ``append_note``：KWA 无 notes 模块，handler 已为 no-op
#:
#: **不修改 ``_DEFAULT_TOOL_DEFS`` 本身**：保留 schema 定义供 writer_agent
#: 复用（writer_agent 用独立 ToolRegistry 仅注册 file_read/write/list），
#: 也可供未来恢复 main_agent 通用工具能力时使用。
_KWA_SKIP_TOOLS: set[str] = {
    "file_read",
    "file_write",
    "file_list",
    "command_exec",
    "open_app",
    "open_url",
    "system_notification",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    "append_note",
}


def register_default_tools(
    registry: ToolRegistry,
    *,
    session_id_getter: Callable[[], str] | None = None,
    task_store_getter: Callable[[], Any] | None = None,
    llm_client_getter: Callable[[], Any] | None = None,
) -> None:
    """向注册表注册所有默认本地工具。

    KWA 适配版本（相对步影原版）：
    - **本土化裁剪**：跳过 :data:`_KWA_SKIP_TOOLS` 中的 11 个步影通用桌面工具
      （file_* / command_exec / open_app/url / system_notification / screenshot /
      clipboard_* / append_note）。这些工具在 KWA Web/Electron 场景下无意义，
      KWA 的真正业务能力通过 :mod:`app.services.tools.graph_tools` 的图谱工具暴露。
    - 保留 ``knowledge_search``（KWA knowledge_store 三路检索）+ ``task_*``
      （会话级任务追踪）+ 全部图谱工具（7 + 13 = 20 个）。
    - Task 7 在本函数末尾调用 ``register_graph_tools(registry)`` 注册图谱工具。

    Args:
        registry: 目标注册表。
        session_id_getter: 返回当前 session_id 的回调（保留供未来恢复 notes 模块时使用）。
        task_store_getter: 返回当前会话 TaskStore 的回调，用于 task_* 工具绑定会话。
            为 None 时 task_* 使用占位 handler（返回未绑定错误）。
        llm_client_getter: 返回当前 LLMClient 的回调（保留供未来扩展使用）。
    """
    # 真实实现的本地工具 handler 映射（file_* + system_tools）
    # 注：file_* / system_tools 已在 _KWA_SKIP_TOOLS 中跳过注册，
    # real_handlers 仍加载（无害），供未来如需恢复注册时直接复用。
    real_handlers = _load_real_handlers()

    # task_* handler：有 getter 时绑定会话，否则用占位
    if task_store_getter is not None:
        from app.services.tools.task_tools import make_task_handlers

        task_handlers = make_task_handlers(task_store_getter)
    else:
        from app.services.tools.task_tools import make_placeholder_task_handlers

        task_handlers = make_placeholder_task_handlers()

    for name, schema, allowed_modes in _DEFAULT_TOOL_DEFS:
        # KWA 本土化裁剪：跳过步影通用桌面工具
        if name in _KWA_SKIP_TOOLS:
            continue
        if name == "knowledge_search":
            # knowledge_search 接入 KWA knowledge_store 真实检索
            handler = _knowledge_search_handler
        elif name in task_handlers:
            # task_* 绑定会话级 TaskStore
            handler = task_handlers[name]
        elif name in real_handlers:
            handler = real_handlers[name]
        else:
            # 无匹配真实 handler 的工具走占位
            handler = _placeholder_handler
        registry.register(name, schema, handler, allowed_modes)

    # Task 7 将在此处追加：register_graph_tools(registry)
    try:
        from app.services.tools.graph_tools import register_graph_tools

        register_graph_tools(registry)
    except ImportError:
        # Task 7 未完成时 graph_tools 模块不存在，跳过（不阻断默认工具注册）
        logger.debug("graph_tools 未就位（Task 7 未完成），跳过图谱工具注册")
    except Exception as exc:  # noqa: BLE001
        logger.warning("注册图谱工具失败（Task 7 未完成？）: %s", exc)


def _load_real_handlers() -> dict[str, ToolHandler]:
    """加载本地工具的真实 handler（延迟导入避免循环依赖）。

    KWA 适配：仅加载 ``file_tools`` + ``system_tools``（Task 3 移植）。
    步影原版的 ``skill_tools`` / ``web_search`` 已移除（SubTask 3.4）。
    """
    from app.services.tools.file_tools import file_list, file_read, file_write
    from app.services.tools.system_tools import (
        clipboard_read,
        clipboard_write,
        command_exec,
        open_app,
        open_url,
        screenshot,
        system_notification,
    )

    return {
        "file_read": file_read,
        "file_write": file_write,
        "file_list": file_list,
        "command_exec": command_exec,
        "open_app": open_app,
        "open_url": open_url,
        "system_notification": system_notification,
        "screenshot": screenshot,
        "clipboard_read": clipboard_read,
        "clipboard_write": clipboard_write,
    }


def _make_append_note_handler(
    session_id_getter: Callable[[], str] | None,
) -> ToolHandler:
    """构造 append_note handler。

    KWA 适配：步影原版调用 ``notes_store.append_note`` 落盘便签本；KWA 无
    ``notes`` 模块，本 handler 改为 no-op（仅记录 debug 日志，返回成功消息），
    与 ``context_manager.append_note`` 的 no-op 行为对齐。

    Args:
        session_id_getter: 返回当前 session_id 的回调（保留参数兼容性，
            未来恢复 notes 模块时使用）。
    """

    async def _handler(args: dict[str, Any]) -> dict[str, Any]:
        note = args.get("note") or args.get("content") or ""
        if not note:
            return {"status": "error", "message": "note 不能为空"}
        sid = session_id_getter() if session_id_getter is not None else "<unbound>"
        logger.debug(
            "append_note no-op (KWA 无 notes 模块) session=%s note_len=%d",
            sid,
            len(str(note)),
        )
        return {"status": "ok", "message": "已记入便签本（KWA no-op，未落盘）"}

    return _handler


# ======================================================================
# 全局注册表实例
# ======================================================================

# 全局默认注册表（无 session 绑定）。
# KWA 适配：**不**在模块加载时调用 ``register_default_tools``（避免触发
# ``tools.file_tools`` 等未就位模块的导入）。``mcp_manager`` 单独向本注册表
# 注册 MCP 工具；``MainAgent`` 实例化时显式调用 ``register_default_tools``
# 注册到自己的会话级注册表。
tool_registry = ToolRegistry()

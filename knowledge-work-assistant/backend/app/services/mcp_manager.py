"""MCP 客户端管理器（Task 2 适配移植）。

管理 MCP（Model Context Protocol）服务器的全生命周期：启动、停止、重载，
并将服务器暴露的工具统一注册到主 Agent 的 Function Calling 命名空间。

核心组件：
- :class:`McpClientWrapper`：单个 MCP 服务器的客户端封装，基于 mcp SDK 的
  stdio 传输（``stdio_client`` + ``ClientSession``）。用 :class:`AsyncExitStack`
  长效持有 transport 与 session，使同一连接可被多次 ``call_tool`` 复用。
- :class:`McpManager`：全局管理器，维护 ``name → McpClientWrapper`` 字典，
  负责配置校验、超时控制、工具 schema 转换与命名空间注册
  （``mcp.{server}.{tool}``）。
- :data:`mcp_manager`：模块级全局单例，供 ``main.py`` lifespan、
  ``routers/config.py`` 与 ``MainAgent`` 共享。

KWA 适配说明（相对步影原版）：
- ``mcp`` Python 包**未在 KWA ``pyproject.toml`` 依赖中**（KWA 暂未接入 MCP 路由，
  ``McpServer`` 表仅保留结构）。本模块用 ``try/except`` 包裹 ``from mcp import ...``，
  使 ``from app.services.mcp_manager import mcp_manager`` 在无 mcp 包时也能成功
  （单例可用、``get_tool_schemas`` 返回空列表）。仅当实际调用
  ``start_server`` 时才会因 mcp 包缺失而返回 ``False``。
- ``McpServer`` 表字段与步影一致（name / command / args_json / env_json / enabled），
  ``start_all`` 读取逻辑无需修改。

设计要点：
1. **stdio 传输**：最通用的 MCP 传输方式，支持 filesystem / browser 等官方服务器。
2. **长效 session**：用 ``AsyncExitStack`` 进入 ``stdio_client`` 与
   ``ClientSession`` 上下文并在 ``stop`` 时统一 ``aclose``，避免每次调用都重连。
3. **容错**：单个服务器启动失败不影响主应用启动；``start_server`` 捕获所有异常
   并返回 ``False``，仅记录日志。
4. **超时**：启动 10s、调用 30s，超时后强制停止 / 取消。
5. **命名空间**：工具全名 ``mcp.{server}.{tool}``，通过 ``tool_registry`` 的
   ``register_mcp_tool`` 注册到全局注册表（handler 委托回 ``mcp_manager.call_tool``，
   便于任何持有注册表的消费者统一执行）。
6. **MCP 工具 inputSchema → OpenAI function parameters**：直接复用 MCP 工具的
   ``inputSchema``（本就是 JSON Schema），包裹为 ``{"type":"function","function":{...}}``。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from contextlib import AsyncExitStack
from typing import Any

from app.services.tool_registry import MCP_PREFIX, tool_registry

logger = logging.getLogger(__name__)

# 启动单个 MCP 服务器的超时（秒）
START_TIMEOUT_SECONDS = 10.0
# 单次工具调用的超时（秒）
CALL_TIMEOUT_SECONDS = 30.0

# ----------------------------------------------------------------------------
# mcp SDK 可选导入（KWA 未在 pyproject.toml 中声明 mcp 依赖）
# ----------------------------------------------------------------------------
# 用 try/except 包裹：mcp 包存在时正常导入；缺失时设为 None，McpClientWrapper.start()
# 会因 _MCP_AVAILABLE=False 返回错误，但模块本身可正常 import，mcp_manager 单例可用。
_MCP_AVAILABLE = False
try:
    from mcp import ClientSession, StdioServerParameters  # type: ignore[import-not-found]
    from mcp.client.stdio import stdio_client  # type: ignore[import-not-found]

    _MCP_AVAILABLE = True
except ImportError:
    ClientSession = None  # type: ignore[assignment, misc]
    StdioServerParameters = None  # type: ignore[assignment, misc]
    stdio_client = None  # type: ignore[assignment, misc]
    logger.info(
        "mcp Python 包未安装，McpManager 将以降级模式运行（start_server 会返回 False）；"
        "如需 MCP 功能请执行 `uv add mcp`"
    )


class McpClientWrapper:
    """单个 MCP 服务器的客户端封装。

    基于 stdio 传输：用 ``stdio_client(params)`` 拉起子进程，用
    ``ClientSession`` 完成 MCP 握手。transport 与 session 的生命周期由
    :class:`AsyncExitStack` 管理，使同一连接可被多次 ``call_tool`` 复用，
    直到显式 :meth:`stop`。

    Args:
        name: 服务器名（用于日志与命名空间）。
        command: 可执行命令（如 ``npx`` / ``python`` / ``node``）。
        args: 命令行参数列表。
        env: 环境变量字典（与默认环境合并；为空则用默认环境）。
    """

    def __init__(
        self,
        name: str,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.name = name
        self.command = command
        self.args = list(args or [])
        # 统一为 dict[str, str]；StdioServerParameters 会与默认环境合并
        self.env: dict[str, str] = {
            str(k): str(v) for k, v in (env or {}).items()
        }
        self._stack: AsyncExitStack | None = None
        self._session: Any = None  # ClientSession | None（mcp 缺失时为 Any）
        # 缓存服务器声明的能力（工具列表）
        self._tools_cache: list[dict[str, Any]] = []
        self._running = False

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """启动 MCP 服务器并完成 MCP 握手。

        流程：
          1. 构造 :class:`StdioServerParameters`；
          2. 进入 ``stdio_client`` 上下文，获得 ``(read, write)`` 流；
          3. 进入 ``ClientSession`` 上下文，调用 ``initialize()`` 完成握手；
          4. ``list_tools()`` 拉取并缓存工具列表。

        重复调用时先停止旧实例。异常向上抛出，由 :class:`McpManager` 统一兜底。

        Raises:
            RuntimeError: mcp 包未安装（KWA 降级模式）。
        """
        if not _MCP_AVAILABLE:
            raise RuntimeError(
                "mcp Python 包未安装，无法启动 MCP 服务器；请执行 `uv add mcp`"
            )

        # 幂等：若已在运行，先停止
        if self._running:
            await self.stop()

        stack = AsyncExitStack()
        try:
            params = StdioServerParameters(
                command=self.command,
                args=self.args,
                env=self.env if self.env else None,
            )
            # stdio_client 是 @asynccontextmanager，进入后获得双向流
            read, write = await stack.enter_async_context(stdio_client(params))
            # ClientSession 的 __aenter__ 返回自身
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()

            # 拉取工具列表并缓存为 [{name, description, inputSchema}]
            result = await session.list_tools()
            self._tools_cache = [
                {
                    "name": tool.name,
                    "description": tool.description or "",
                    "inputSchema": tool.inputSchema or {"type": "object", "properties": {}},
                }
                for tool in result.tools
            ]

            self._stack = stack
            self._session = session
            self._running = True
            logger.info(
                "MCP 服务器 %s 启动成功，发现 %d 个工具",
                self.name,
                len(self._tools_cache),
            )
        except Exception:
            # 启动失败：清理已打开的上下文，避免资源泄漏
            await stack.aclose()
            self._session = None
            self._stack = None
            self._running = False
            raise

    async def stop(self) -> None:
        """停止 MCP 服务器：关闭 session 与 transport（终止子进程）。

        幂等，重复调用安全。异常仅记录日志不向上抛出。
        """
        if self._stack is None:
            self._running = False
            self._session = None
            return
        stack = self._stack
        self._stack = None
        self._session = None
        self._running = False
        self._tools_cache = []
        try:
            await stack.aclose()
        except Exception as exc:  # noqa: BLE001 - 停止失败不应影响主流程
            logger.warning("MCP 服务器 %s 停止时异常: %s", self.name, exc)
        logger.info("MCP 服务器 %s 已停止", self.name)

    # ------------------------------------------------------------------
    # 调用与查询
    # ------------------------------------------------------------------

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """调用服务器上的一个工具，返回解析后的 dict。

        Args:
            tool_name: 服务器声明的工具名（不含 ``mcp.`` 前缀）。
            arguments: 调用参数。

        Returns:
            ``{"content": [...], "text": str, "isError": bool,
            "structuredContent": dict | None}``。其中 ``text`` 为所有文本块拼接，
            便于 LLM 直接阅读；``content`` 为完整内容块列表（含 image 等）。

        Raises:
            RuntimeError: 服务器未运行。
        """
        if not self._running or self._session is None:
            raise RuntimeError(f"MCP 服务器 {self.name} 未运行")
        result = await self._session.call_tool(tool_name, arguments)
        return self._parse_call_result(result)

    @staticmethod
    def _parse_call_result(result: Any) -> dict[str, Any]:
        """将 MCP ``CallToolResult`` 解析为 JSON 可序列化的 dict。"""
        blocks: list[dict[str, Any]] = []
        text_parts: list[str] = []
        for block in getattr(result, "content", []) or []:
            if hasattr(block, "model_dump"):
                data = block.model_dump(exclude_none=True)
            elif isinstance(block, dict):
                data = block
            else:
                data = {"raw": str(block)}
            blocks.append(data)
            if getattr(block, "type", None) == "text":
                text_parts.append(getattr(block, "text", ""))
        return {
            "content": blocks,
            "text": "\n".join(text_parts),
            "isError": bool(getattr(result, "isError", False)),
            "structuredContent": getattr(result, "structuredContent", None),
        }

    def list_tools(self) -> list[dict[str, Any]]:
        """返回缓存工具列表 ``[{name, description, inputSchema}]``。"""
        return list(self._tools_cache)

    def is_running(self) -> bool:
        """服务器是否处于运行态。"""
        return self._running


class McpManager:
    """MCP 服务器全局管理器。

    维护 ``name → McpClientWrapper`` 字典，负责配置校验、超时控制、
    工具 schema 转换与命名空间注册。所有方法均为 async，启动失败返回 ``False``
    且仅记录日志，不抛出异常（保证主应用可用）。
    """

    def __init__(self) -> None:
        # name → McpClientWrapper
        self._wrappers: dict[str, McpClientWrapper] = {}
        # full_name → (server_name, tool_name) 反向索引，避免解析歧义
        self._tool_index: dict[str, tuple[str, str]] = {}
        # full_name → OpenAI function schema
        self._tool_schemas: dict[str, dict[str, Any]] = {}
        # name → 启动时使用的配置（用于 restart）
        self._configs: dict[str, dict[str, Any]] = {}

    # ==================================================================
    # 单服务器管理
    # ==================================================================

    async def start_server(self, config: dict[str, Any]) -> bool:
        """启动一个 MCP 服务器并注册其工具。

        Args:
            config: ``{"name", "command", "args", "env"}``。

        Returns:
            成功返回 ``True``；校验失败 / 启动超时 / 异常 / mcp 包缺失返回 ``False``。
        """
        if not _MCP_AVAILABLE:
            logger.warning(
                "mcp Python 包未安装，无法启动 MCP 服务器 %s",
                config.get("name", "<unknown>"),
            )
            return False

        name = str(config.get("name", "")).strip()
        command = str(config.get("command", "")).strip()
        args = list(config.get("args") or [])
        env = dict(config.get("env") or {})

        # ---- 配置校验 ----
        if not name:
            logger.warning("MCP 服务器配置缺少 name，跳过启动")
            return False
        if not command:
            logger.warning("MCP 服务器 %s 的 command 为空，跳过启动", name)
            return False
        if not self._command_exists(command):
            logger.warning(
                "MCP 服务器 %s 的 command %r 在 PATH 中未找到，跳过启动",
                name,
                command,
            )
            return False

        # 若同名服务器已在运行，先停止
        if name in self._wrappers:
            await self.stop_server(name)

        wrapper = McpClientWrapper(name, command, args, env)
        try:
            await asyncio.wait_for(wrapper.start(), timeout=START_TIMEOUT_SECONDS)
        except TimeoutError:
            logger.warning(
                "MCP 服务器 %s 启动超时（%ds），强制停止",
                name,
                int(START_TIMEOUT_SECONDS),
            )
            await wrapper.stop()
            return False
        except Exception as exc:  # noqa: BLE001 - 启动失败不影响主应用
            logger.warning("MCP 服务器 %s 启动失败: %s", name, exc)
            await wrapper.stop()
            return False

        # ---- 注册到内部索引与全局 tool_registry ----
        self._wrappers[name] = wrapper
        self._configs[name] = {
            "name": name,
            "command": command,
            "args": args,
            "env": env,
        }
        self._register_tools(name, wrapper)
        return True

    async def stop_server(self, name: str) -> bool:
        """停止一个 MCP 服务器并注销其工具。"""
        wrapper = self._wrappers.pop(name, None)
        if wrapper is None:
            return False
        await wrapper.stop()
        self._unregister_tools(name)
        self._configs.pop(name, None)
        return True

    async def restart_server(self, name: str) -> bool:
        """重启服务器（用缓存的配置）。"""
        config = self._configs.get(name)
        if config is None:
            logger.warning("MCP 服务器 %s 未运行，无法 restart", name)
            return False
        await self.stop_server(name)
        return await self.start_server(config)

    # ==================================================================
    # 工具查询与调用
    # ==================================================================

    def list_all_tools(self) -> list[dict[str, Any]]:
        """聚合所有运行中服务器的工具（``{name, description, inputSchema}``）。"""
        tools: list[dict[str, Any]] = []
        for wrapper in self._wrappers.values():
            if wrapper.is_running():
                tools.extend(wrapper.list_tools())
        return tools

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """返回所有 MCP 工具的 OpenAI function schema（供 LLM tools 参数）。"""
        return list(self._tool_schemas.values())

    def has_tool(self, full_name: str) -> bool:
        """是否注册了某 MCP 工具（按完整名 ``mcp.{server}.{tool}``）。"""
        return full_name in self._tool_index

    async def call_tool(self, full_name: str, args: dict[str, Any]) -> dict[str, Any]:
        """按完整名调用 MCP 工具。

        Args:
            full_name: ``mcp.{server}.{tool}``。
            args: 调用参数。

        Returns:
            工具结果 dict。工具不存在 / 超时 / 异常时返回 ``{"error": ...}``，
            不抛异常（保证 Function Calling 主流程不中断）。
        """
        index = self._tool_index.get(full_name)
        if index is None:
            return {"error": "tool not found", "tool": full_name}
        server_name, tool_name = index
        wrapper = self._wrappers.get(server_name)
        if wrapper is None or not wrapper.is_running():
            return {"error": f"server {server_name} not running", "tool": full_name}

        try:
            result = await asyncio.wait_for(
                wrapper.call_tool(tool_name, args), timeout=CALL_TIMEOUT_SECONDS
            )
            return result
        except TimeoutError:
            logger.warning(
                "MCP 工具 %s 调用超时（%ds）", full_name, int(CALL_TIMEOUT_SECONDS)
            )
            return {"error": "tool call timeout", "tool": full_name}
        except Exception as exc:  # noqa: BLE001 - 调用异常不影响主流程
            logger.warning("MCP 工具 %s 调用异常: %s", full_name, exc)
            return {"error": str(exc), "tool": full_name}

    # ==================================================================
    # 批量管理
    # ==================================================================

    async def start_all(self) -> None:
        """从 DB 读取所有 enabled 的 McpServer，依次启动。

        单个服务器启动失败不影响其他服务器与主应用启动。
        """
        # 延迟导入避免循环依赖
        from sqlalchemy import select

        from app.db import AsyncSessionLocal
        from app.models.db_models import McpServer

        try:
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(McpServer).where(McpServer.enabled == True)  # noqa: E712
                )
                rows = list(result.scalars().all())
        except Exception as exc:  # noqa: BLE001 - DB 异常不阻断启动
            logger.exception("读取 MCP 服务器配置失败: %s", exc)
            return

        for row in rows:
            try:
                args = json.loads(row.args_json) if row.args_json else []
                env = json.loads(row.env_json) if row.env_json else {}
            except (json.JSONDecodeError, TypeError):
                args, env = [], {}

            config = {
                "name": row.name,
                "command": row.command,
                "args": args,
                "env": env,
            }
            await self.start_server(config)

    async def stop_all(self) -> None:
        """停止所有运行中的 MCP 服务器。"""
        names = list(self._wrappers.keys())
        for name in names:
            await self.stop_server(name)

    # ==================================================================
    # 内部：工具注册 / 注销
    # ==================================================================

    def _register_tools(self, server_name: str, wrapper: McpClientWrapper) -> None:
        """将 wrapper 的工具注册到内部索引、schema 缓存与全局 tool_registry。

        MCP 工具的 ``inputSchema``（JSON Schema）直接作为 OpenAI function 的
        ``parameters``；工具名加 ``mcp.{server}.{tool}`` 命名空间前缀。
        注册到全局 ``tool_registry`` 的 handler 委托回 ``self.call_tool``，
        使任何持有注册表的消费者都能统一执行。
        """
        for tool in wrapper.list_tools():
            tool_name = str(tool.get("name", ""))
            if not tool_name:
                continue
            full_name = f"{MCP_PREFIX}{server_name}.{tool_name}"
            description = str(tool.get("description", "")) or f"MCP tool {tool_name}"
            input_schema = tool.get("inputSchema") or {
                "type": "object",
                "properties": {},
            }
            schema = {
                "type": "function",
                "function": {
                    "name": full_name,
                    "description": description,
                    "parameters": input_schema,
                },
            }
            self._tool_index[full_name] = (server_name, tool_name)
            self._tool_schemas[full_name] = schema

            # 注册到全局 tool_registry（handler 委托回 mcp_manager.call_tool）
            # 闭包捕获 full_name；strip 掉 tool_registry.execute 注入的 _mode
            def _make_handler(fn: str):
                async def _handler(arguments: dict[str, Any]) -> dict[str, Any]:
                    clean_args = {
                        k: v for k, v in arguments.items() if k != "_mode"
                    }
                    return await self.call_tool(fn, clean_args)

                return _handler

            try:
                tool_registry.register_mcp_tool(
                    server_name=server_name,
                    tool_name=tool_name,
                    schema=schema,
                    handler=_make_handler(full_name),
                    allowed_modes=["plan", "build"],
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "注册 MCP 工具 %s 到 tool_registry 失败: %s", full_name, exc
                )

    def _unregister_tools(self, server_name: str) -> None:
        """注销某服务器的全部工具（内部索引 + 全局 tool_registry）。"""
        # 移除内部索引与 schema
        full_names = [
            fn for fn, (sn, _) in self._tool_index.items() if sn == server_name
        ]
        for fn in full_names:
            self._tool_index.pop(fn, None)
            self._tool_schemas.pop(fn, None)
        # 移除全局 tool_registry 中的条目
        try:
            tool_registry.unregister_mcp_server(server_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "注销 MCP 服务器 %s 的工具失败: %s", server_name, exc
            )

    # ==================================================================
    # 内部：校验
    # ==================================================================

    @staticmethod
    def _command_exists(command: str) -> bool:
        """校验 command 可执行：在 PATH 中或为存在的绝对路径。

        Windows 下 ``shutil.which`` 会自动处理 ``.cmd`` / ``.bat`` 后缀解析。
        """
        if not command:
            return False
        # 绝对路径且存在
        from pathlib import Path

        p = Path(command)
        if p.is_absolute() and p.exists():
            return True
        # 在 PATH 中
        return shutil.which(command) is not None


# 全局单例：供 main.py lifespan、routers/config.py 与 MainAgent 共享
mcp_manager = McpManager()

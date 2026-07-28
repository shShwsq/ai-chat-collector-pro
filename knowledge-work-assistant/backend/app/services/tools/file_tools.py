r"""文件读写工具（Task 3.2 适配移植）。

提供三个 handler，供 :class:`app.services.tool_registry.ToolRegistry` 注册：

- :func:`file_read`：读取文件内容。Plan 模式仅允许读取用户上传目录
  （``settings.data_dir/files/``），Build 模式可读任意路径（系统敏感目录除外）。
- :func:`file_write`：写入文件（仅 Build 模式，自动创建父目录）。
- :func:`file_list`：列出目录内容（Plan + Build 均可用）。

另提供 :func:`register_file_tools` 便捷注册函数，将上述三个工具连同 schema
注册到指定 ``ToolRegistry``，供 writer_agent 工具循环等场景独立使用
（无需经过 ``register_default_tools`` 全量注册）。

设计要点：

- 所有同步 IO 包裹在 ``asyncio.to_thread`` 中，避免阻塞事件循环。
- 路径解析：绝对路径直接使用；相对路径相对于 ``settings.data_dir`` 解析，
  便于 Agent 用简短名（如 ``test.txt``）操作数据目录内文件。
- 安全：路径中不允许出现 ``..``（防目录穿越）；Build 模式下禁止读取
  ``C:\Windows\System32\config`` 等系统敏感目录。
- 模式感知：handler 从 ``args["_mode"]`` 读取当前模式（由
  ``ToolRegistry.execute`` 注入；未注入时按 Build 模式处理，保证可独立调用）。

KWA 适配：本模块无步影特有依赖（仅依赖 ``app.config.settings.data_dir``，
KWA ``Settings.data_dir`` 字段已存在），从 ``步影/backend/app/services/tools/file_tools.py``
直接适配拷贝，保留全部注释与 docstring，并追加 :func:`register_file_tools`。
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# 上传文件目录名（Plan 模式下 file_read 仅允许读取此目录下的文件）
_UPLOADS_DIR_NAME = "files"

# Build 模式下也禁止读取的系统敏感目录（小写前缀匹配）
_FORBIDDEN_READ_PREFIXES: tuple[str, ...] = (
    r"c:\windows\system32\config",
    r"c:/windows/system32/config",
)

# 单文件默认最大读取字节数（约 100KB）
_DEFAULT_MAX_SIZE = 100_000


# ======================================================================
# 内部工具函数
# ======================================================================

def _is_path_traversal(path_str: str) -> bool:
    """检查路径是否包含目录穿越片段 ``..``。

    将反斜杠统一为正斜杠后按路径段检查，避免误判合法文件名中的 ``..``。
    """
    if not path_str:
        return False
    normalized = path_str.replace("\\", "/")
    return ".." in normalized.split("/")


def _resolve_path(path_str: str) -> Path:
    """将路径解析为绝对路径。

    - 绝对路径：直接 ``resolve()``。
    - 相对路径：相对于 ``settings.data_dir`` 解析后再 ``resolve()``。
    """
    p = Path(path_str)
    if p.is_absolute():
        return p.resolve()
    return (settings.data_dir / p).resolve()


def _is_under(dir_path: Path, target: Path) -> bool:
    """检查 ``target`` 是否位于 ``dir_path`` 之下（含自身）。"""
    try:
        target.relative_to(dir_path)
        return True
    except ValueError:
        return False


def _is_forbidden_system_path(path: Path) -> bool:
    """检查路径是否在系统敏感目录中（Build 模式下也禁止读取）。"""
    s = str(path).lower()
    return any(s.startswith(prefix.lower()) for prefix in _FORBIDDEN_READ_PREFIXES)


def _read_bytes_sync(path: Path, max_size: int) -> tuple[bytes, bool]:
    """同步读取文件字节，截断到 ``max_size``。

    Returns:
        ``(data, truncated)``：``data`` 最多 ``max_size`` 字节；
        ``truncated`` 表示文件是否还有更多字节未读。
    """
    with path.open("rb") as f:
        data = f.read(max_size)
        # 再读 1 字节判断是否截断（避免 stat 与 read 间的竞态）
        extra = f.read(1)
    return data, bool(extra)


def _write_bytes_sync(path: Path, data: bytes, append: bool) -> int:
    """同步写入文件字节，自动创建父目录。返回写入字节数。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "ab" if append else "wb"
    with path.open(mode) as f:
        f.write(data)
    return len(data)


def _list_dir_sync(path: Path, recursive: bool) -> list[dict[str, Any]]:
    """同步列出目录内容。"""
    iterator = path.rglob("*") if recursive else path.iterdir()
    entries: list[dict[str, Any]] = []
    for child in sorted(iterator, key=lambda p: (p.is_file(), p.name.lower())):
        try:
            stat = child.stat()
            is_dir = child.is_dir()
            entries.append(
                {
                    "name": child.name,
                    "path": str(child),
                    "size": 0 if is_dir else stat.st_size,
                    "modified": stat.st_mtime,
                    "is_dir": is_dir,
                }
            )
        except OSError as exc:
            logger.debug("跳过无法访问的路径 %s: %s", child, exc)
            continue
    return entries


# ======================================================================
# file_read
# ======================================================================

async def file_read(args: dict[str, Any]) -> dict[str, Any]:
    r"""读取文件内容。

    Args（来自 schema）:
        path: 文件路径（绝对或相对 ``settings.data_dir``）。
        max_size: 最多读取字节数，默认 100000。

    模式行为:
        - Plan（``args["_mode"] == "plan"``）：仅允许读取
          ``settings.data_dir/files/`` 下的文件（用户已上传）。
        - Build（``args["_mode"]`` 缺省或为 ``"build"``）：可读任意路径，
          但禁止读取系统敏感目录（如 ``C:\Windows\System32\config``）。

    Returns:
        成功：``{"path", "content", "size", "truncated"}``；
        失败：``{"error": "..."}``。
    """
    path_str = str(args.get("path") or "")
    max_size = int(args.get("max_size") or _DEFAULT_MAX_SIZE)
    mode = args.get("_mode")

    if not path_str:
        return {"error": "path is required"}

    if _is_path_traversal(path_str):
        return {"error": "path traversal (..) is not allowed"}

    path = _resolve_path(path_str)
    uploads_dir = (settings.data_dir / _UPLOADS_DIR_NAME).resolve()

    # Plan 模式：只允许读取上传目录下的文件
    if mode == "plan" and not _is_under(uploads_dir, path):
        return {"error": "plan mode restricts to uploaded files only"}

    # Build 模式：禁止读取系统敏感目录
    if mode != "plan" and _is_forbidden_system_path(path):
        return {"error": f"reading system path is forbidden: {path}"}

    if not path.exists():
        return {"error": f"file not found: {path}"}
    if path.is_dir():
        return {"error": f"path is a directory, not a file: {path}"}

    try:
        size = path.stat().st_size
        content_bytes, truncated = await asyncio.to_thread(
            _read_bytes_sync, path, max_size
        )
    except OSError as exc:
        logger.warning("file_read 读取失败 %s: %s", path, exc)
        return {"error": f"read failed: {exc}"}

    # 解码为文本（容错：非 UTF-8 文件用 replace 避免崩溃）
    try:
        content = content_bytes.decode("utf-8")
    except UnicodeDecodeError:
        content = content_bytes.decode("utf-8", errors="replace")
        # 二进制文件提示
        if "\x00" in content:
            content = "(binary file, not displayed)"

    return {
        "path": str(path),
        "content": content,
        "size": size,
        "truncated": truncated,
    }


# ======================================================================
# file_write
# ======================================================================

async def file_write(args: dict[str, Any]) -> dict[str, Any]:
    """写入文件（仅 Build 模式；模式过滤由 ToolRegistry 保证）。

    Args（来自 schema）:
        path: 文件路径（绝对或相对 ``settings.data_dir``）。
        content: 要写入的文本内容。
        append: 是否追加模式（默认 False 覆盖）。

    自动创建父目录。

    Returns:
        成功：``{"path", "bytes_written", "created"}``；
        失败：``{"error": "..."}``。
    """
    path_str = str(args.get("path") or "")
    content = args.get("content")
    append = bool(args.get("append", False))

    if not path_str:
        return {"error": "path is required"}
    if content is None:
        return {"error": "content is required"}
    if not isinstance(content, str):
        return {"error": "content must be a string"}

    if _is_path_traversal(path_str):
        return {"error": "path traversal (..) is not allowed"}

    path = _resolve_path(path_str)
    existed = path.exists()
    data = content.encode("utf-8")

    try:
        bytes_written = await asyncio.to_thread(_write_bytes_sync, path, data, append)
    except OSError as exc:
        logger.warning("file_write 写入失败 %s: %s", path, exc)
        return {"error": f"write failed: {exc}"}

    return {
        "path": str(path),
        "bytes_written": bytes_written,
        "created": not existed,
    }


# ======================================================================
# file_list
# ======================================================================

async def file_list(args: dict[str, Any]) -> dict[str, Any]:
    """列出目录内容。

    Args（来自 schema）:
        path: 目录路径（默认 ``settings.data_dir``）。
        recursive: 是否递归列出子目录（默认 False）。

    Returns:
        成功：``{"path", "entries": [{"name", "path", "size", "modified",
        "is_dir"}, ...]}``；失败：``{"error": "..."}``。
    """
    path_str = str(args.get("path") or "")
    recursive = bool(args.get("recursive", False))

    if not path_str:
        path = settings.data_dir.resolve()
    else:
        if _is_path_traversal(path_str):
            return {"error": "path traversal (..) is not allowed"}
        path = _resolve_path(path_str)

    if not path.exists():
        return {"error": f"path not found: {path}"}
    if not path.is_dir():
        return {"error": f"path is not a directory: {path}"}

    try:
        entries = await asyncio.to_thread(_list_dir_sync, path, recursive)
    except OSError as exc:
        logger.warning("file_list 列出失败 %s: %s", path, exc)
        return {"error": f"list failed: {exc}"}

    return {
        "path": str(path),
        "entries": entries,
    }


# ======================================================================
# register_file_tools（KWA 适配新增：便捷注册函数）
# ======================================================================

def _build_file_schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    """构造 OpenAI function calling 格式的 schema（与 tool_registry 保持一致）。"""
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


def register_file_tools(
    registry: Any,
    *,
    file_read_modes: list[str] | None = None,
    file_write_modes: list[str] | None = None,
    file_list_modes: list[str] | None = None,
) -> None:
    """向注册表注册 file_read / file_write / file_list 三个工具。

    KWA 适配新增的便捷函数（步影原版无此函数）：将三个文件工具的 schema 与
    handler 自包含地注册到指定 ``ToolRegistry``，供 writer_agent 工具循环
    等仅需文件工具的场景独立使用，无需经过 ``register_default_tools`` 全量注册。

    schema 与 ``app.services.tool_registry._DEFAULT_TOOL_DEFS`` 中的定义保持
    一致（若两者 diverge 会导致 LLM 看到的工具描述不一致，需同步维护）。

    Args:
        registry: 目标注册表（需实现 ``register(name, schema, handler, allowed_modes)``）。
        file_read_modes: file_read 允许的模式，默认 ``["plan", "build"]``。
        file_write_modes: file_write 允许的模式，默认 ``["build"]``。
        file_list_modes: file_list 允许的模式，默认 ``["plan", "build"]``。
    """
    file_read_schema = _build_file_schema(
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
    )
    file_write_schema = _build_file_schema(
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
    )
    file_list_schema = _build_file_schema(
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
    )

    registry.register(
        "file_read",
        file_read_schema,
        file_read,
        file_read_modes if file_read_modes is not None else ["plan", "build"],
    )
    registry.register(
        "file_write",
        file_write_schema,
        file_write,
        file_write_modes if file_write_modes is not None else ["build"],
    )
    registry.register(
        "file_list",
        file_list_schema,
        file_list,
        file_list_modes if file_list_modes is not None else ["plan", "build"],
    )


__all__ = [
    "file_read",
    "file_write",
    "file_list",
    "register_file_tools",
]

r"""系统交互工具（Task 3.3 适配移植）。

提供 7 个 handler，供 :class:`app.services.tool_registry.ToolRegistry` 注册：

- :func:`command_exec`：执行 shell 命令（仅 Build，异步 + 超时 + 黑名单）。
- :func:`open_app`：打开本地应用程序（仅 Build）。
- :func:`open_url`：用默认浏览器打开 URL（Plan + Build）。
- :func:`system_notification`：发送系统桌面通知（Plan + Build，PowerShell toast）。
- :func:`screenshot`：截取主屏并保存 PNG（Plan + Build，PIL.ImageGrab）。
- :func:`clipboard_read`：读取剪贴板文本（Plan + Build，PowerShell Get-Clipboard）。
- :func:`clipboard_write`：写入剪贴板文本（仅 Build，PowerShell Set-Clipboard）。

设计要点：

- 阻塞调用（subprocess、PIL.ImageGrab）一律包裹在 ``asyncio.to_thread`` 或
  ``asyncio.create_subprocess_*`` 中，避免阻塞事件循环。
- Windows 为主平台：剪贴板 / 通知用 PowerShell；命令执行用 ``subprocess``
  argv 模式直接调用可执行文件（不再经 PowerShell 解释器）。
- 安全：``command_exec`` 采用 **白名单 + argv 参数化执行** 模型——
  ① 可执行文件名必须在 :data:`_ALLOWED_COMMANDS` 白名单内；
  ② 命令字符串中不得出现 shell 元字符（``;`` / ``|`` / ``&`` / `` ` `` /
  ``$`` / ``()`` / ``<>`` / 换行），防止命令串联与替换；
  ③ 用 ``subprocess.run([cmd, *args])`` 直接执行，**完全绕过 shell 解释器**
  （不再 ``powershell -Command <字符串>``）；
  ④ 工作目录不得为系统敏感目录（``C:\Windows`` / ``/`` / ``/etc`` 等）。
  ``open_url`` 校验 http/https 协议。
- ``require_confirmation``：本任务实现"自动确认"——返回
  ``confirmation_required=True`` 但直接执行；真正的用户确认弹窗由前端在收到
  ``tool_call`` 事件时实现（Task 18 联调）。

KWA 适配：本模块无步影特有依赖（仅依赖 ``app.config.settings.data_dir`` 与
标准库 / Pillow），从 ``步影/backend/app/services/tools/system_tools.py`` 直接
适配拷贝，保留全部注释与 docstring。
"""

from __future__ import annotations

import asyncio
import logging
import shlex
import subprocess
import sys
import time
import webbrowser
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# 截屏保存子目录名
_SCREENSHOTS_DIR_NAME = "screenshots"

# 默认命令执行超时（秒）
_DEFAULT_TIMEOUT = 30

# 允许执行的可执行文件名白名单（小写匹配，不含路径）。
# 选取原则：① 仅常用开发/查看类命令；② 不含格式化、关机、注册表、计划任务等
# 系统破坏类工具；③ 不含 ``del`` / ``rm`` / ``format`` / ``shutdown`` / ``reg`` /
# ``diskpart`` / ``schtasks`` / ``cmd`` / ``powershell`` / ``wsl`` 等可被绕过或
# 危险的解释器与系统工具。
# 跨平台：Windows 与 POSIX 命令名都收录（``dir``/``ls``、``type``/``cat`` 等）。
_ALLOWED_COMMANDS: frozenset[str] = frozenset({
    # 目录/文件查看
    "ls", "dir", "tree", "pwd",
    "cat", "type", "head", "tail", "wc", "stat", "file",
    "find", "where", "which",
    # 文本搜索
    "grep", "findstr", "rg",
    # 开发工具
    "git", "node", "npm", "npx", "pnpm", "yarn", "pnpx",
    "python", "python3", "py", "pip", "uv", "ruff", "mypy",
    "code", "code-insiders",
    # 目录操作（非递归删除由参数控制；如 ``rmdir`` 默认不递归）
    "mkdir", "md", "rmdir", "rd", "touch",
    # 文件复制/移动（非删除）
    "cp", "copy", "mv", "move",
    # 系统信息（只读）
    "whoami", "hostname", "date", "time", "echo",
})

# 禁止出现的 shell 元字符（命令串联、管道、替换、重定向、子 shell）。
# 一旦命中即拒绝执行，防止 ``git status; rm -rf /`` 这类串联注入。
# 注意：换行符（\n / \r）也属此列，防止多行命令。
_SHELL_METACHARS: frozenset[str] = frozenset(
    ";|&`$()<>\\\n\r"
)

# 工作目录黑名单（系统敏感目录，resolve 后前缀匹配）。
# 跨平台覆盖 Windows 与 POSIX。
_FORBIDDEN_CWD_PREFIXES: tuple[str, ...] = (
    # Windows
    "c:\\windows",
    "c:\\",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    # POSIX
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/root",
    "/var",
)


# ======================================================================
# 内部工具函数
# ======================================================================

def _has_shell_metachar(s: str) -> bool:
    """检查字符串是否包含任一 shell 元字符。"""
    return any(ch in _SHELL_METACHARS for ch in s)


def _is_forbidden_cwd(path: Path) -> bool:
    """检查工作目录是否落在系统敏感目录下。"""
    try:
        resolved = str(path.resolve()).lower()
    except (OSError, RuntimeError):
        return True
    return any(resolved == prefix or resolved.startswith(prefix.rstrip("\\/") + "\\")
               or resolved.startswith(prefix.rstrip("\\/") + "/")
               for prefix in _FORBIDDEN_CWD_PREFIXES)


def _parse_command_argv(command: str) -> list[str]:
    """把命令字符串解析为 argv 列表。

    - Windows 上用 ``shlex(posix=False)`` 保留反斜杠（``C:\\foo`` 不被转义）；
    - POSIX 上用默认 ``shlex``（处理引号与转义）。

    返回空列表表示解析失败（如引号不闭合）。
    """
    try:
        posix_mode = sys.platform != "win32"
        return shlex.split(command, posix=posix_mode)
    except ValueError:
        return []


async def _run_subprocess(
    cmd: list[str],
    *,
    stdin_data: bytes | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes, bytes]:
    """在线程池中同步运行子进程，兼容 SelectorEventLoop。

    Windows 上 uvicorn --reload 使用 SelectorEventLoop，不支持
    ``asyncio.create_subprocess_exec``（抛 NotImplementedError）。
    用 ``asyncio.to_thread`` + ``subprocess.run`` 绕过此限制。

    Returns:
        ``(returncode, stdout_bytes, stderr_bytes)``
    """
    def _run() -> tuple[int, bytes, bytes]:
        r = subprocess.run(
            cmd,
            input=stdin_data,
            capture_output=True,
            timeout=timeout,
        )
        return r.returncode, r.stdout, r.stderr

    return await asyncio.to_thread(_run)


def _ps_single_quote_escape(s: str) -> str:
    """转义为 PowerShell 单引号字符串内容（``'`` -> ``''``），并去掉换行。"""
    return s.replace("\r", " ").replace("\n", " ").replace("'", "''")


def _strip_bom(data: bytes) -> bytes:
    """去除 UTF-8 / UTF-16 BOM。"""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:]
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le", errors="replace").encode("utf-8")
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", errors="replace").encode("utf-8")
    return data


# ======================================================================
# command_exec
# ======================================================================

async def command_exec(args: dict[str, Any]) -> dict[str, Any]:
    """执行受限白名单命令（仅 Build 模式；模式过滤由 ToolRegistry 保证）。

    Args（来自 schema）:
        command: 要执行的命令（含参数）。**不允许** shell 元字符
            （``;`` / ``|`` / ``&`` / `` ` `` / ``$`` / ``()`` / ``<>`` /
            换行），可执行文件名必须在白名单内。
        cwd: 工作目录（可选，不得为系统敏感目录）。
        timeout: 超时秒数（可选，默认 30）。
        require_confirmation: 是否需要用户确认（默认 True）。本任务实现
            "自动确认"——直接执行并在结果中标记 ``confirmation_required``；
            真正的确认 UI 由前端在收到 ``tool_call`` 事件时实现。

    安全：① 白名单匹配可执行文件名；② 拒绝 shell 元字符；③ ``subprocess``
    argv 模式执行，不经 shell 解释器；④ cwd 不得为系统敏感目录；⑤ 超时杀进程。

    Returns:
        成功：``{"command", "exit_code", "stdout", "stderr", "duration_ms",
        "confirmation_required"}``；失败：``{"error": "..."}``。
    """
    command = str(args.get("command") or "")
    cwd = args.get("cwd")
    timeout = int(args.get("timeout") or _DEFAULT_TIMEOUT)
    require_confirmation = bool(args.get("require_confirmation", True))

    if not command:
        return {"error": "command is required"}

    # ① 拒绝 shell 元字符（命令串联 / 管道 / 替换 / 重定向 / 子 shell / 换行）
    if _has_shell_metachar(command):
        return {
            "error": (
                "command contains forbidden shell metacharacters "
                "(; | & ` $ ( ) < > \\ newline); "
                "use a single command without piping/redirection"
            ),
            "command": command,
        }

    # ② 解析为 argv，绕过 shell 解释器
    argv = _parse_command_argv(command)
    if not argv:
        return {
            "error": "command failed to parse (check quotes/escaping)",
            "command": command,
        }

    # ③ 白名单匹配可执行文件名（不含路径，小写）
    executable = Path(argv[0]).name.lower()
    if executable not in _ALLOWED_COMMANDS:
        return {
            "error": (
                f"executable not in whitelist: {argv[0]!r} "
                f"(allowed: {sorted(_ALLOWED_COMMANDS)})"
            ),
            "command": command,
        }

    # ④ 校验工作目录
    cwd_path: str | None = None
    if cwd:
        cwd_p = Path(str(cwd))
        if not cwd_p.exists():
            return {"error": f"cwd not found: {cwd}", "command": command}
        if _is_forbidden_cwd(cwd_p):
            return {
                "error": f"cwd is a forbidden system directory: {cwd}",
                "command": command,
            }
        cwd_path = str(cwd_p.resolve())

    # ⑤ 用 argv 直接执行，shell=False（默认）
    start = time.perf_counter()

    def _run_sync() -> tuple[int, bytes, bytes]:
        """在线程中同步执行命令，返回 (exit_code, stdout, stderr)。"""
        r = subprocess.run(
            argv,
            capture_output=True,
            cwd=cwd_path,
            timeout=timeout,
        )
        return r.returncode, r.stdout, r.stderr

    try:
        exit_code, stdout_bytes, stderr_bytes = await asyncio.to_thread(_run_sync)
    except subprocess.TimeoutExpired:
        duration_ms = int((time.perf_counter() - start) * 1000)
        return {
            "command": command,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"timeout after {timeout}s",
            "duration_ms": duration_ms,
            "timeout": True,
            "confirmation_required": require_confirmation,
        }
    except OSError as exc:
        logger.warning("command_exec 启动失败 %s: %s", command, exc)
        return {"error": f"failed to start: {exc}", "command": command}

    duration_ms = int((time.perf_counter() - start) * 1000)
    stdout = _strip_bom_safe(stdout_bytes).decode("utf-8", errors="replace")
    stderr = _strip_bom_safe(stderr_bytes).decode("utf-8", errors="replace")

    return {
        "command": command,
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "duration_ms": duration_ms,
        "confirmation_required": require_confirmation,
    }


def _strip_bom_safe(data: bytes) -> bytes:
    """对外部字节流去 BOM（包装层，吞掉异常）。"""
    try:
        return _strip_bom(data)
    except Exception:  # noqa: BLE001
        return data


# ======================================================================
# open_app
# ======================================================================

def _open_app_sync(app: str) -> tuple[int, bool]:
    """同步启动应用，返回 ``(pid, started)``。

    Windows 用 ``cmd /c start`` 以 detached 方式启动；POSIX 直接 ``Popen``。
    """
    if sys.platform == "win32":
        # start "" "app"  —— 第一个空引号是 start 的窗口标题占位
        proc = subprocess.Popen(
            ["cmd", "/c", "start", "", app],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    else:
        proc = subprocess.Popen(
            [app],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    return proc.pid, True


async def open_app(args: dict[str, Any]) -> dict[str, Any]:
    """打开本地应用程序（仅 Build 模式）。

    Args（来自 schema）:
        app_path: 应用名称或可执行路径（兼容旧字段 ``app``）。

    Returns:
        成功：``{"app", "pid", "started"}``；
        失败：``{"error": "...", "app", "pid": 0, "started": False}``。
    """
    app = str(args.get("app_path") or args.get("app") or "")
    if not app:
        return {"error": "app_path is required", "app": "", "pid": 0, "started": False}

    try:
        pid, started = await asyncio.to_thread(_open_app_sync, app)
    except OSError as exc:
        logger.warning("open_app 启动失败 %s: %s", app, exc)
        return {
            "error": f"failed to start: {exc}",
            "app": app,
            "pid": 0,
            "started": False,
        }

    return {"app": app, "pid": pid, "started": started}


# ======================================================================
# open_url
# ======================================================================

async def open_url(args: dict[str, Any]) -> dict[str, Any]:
    """用系统默认浏览器打开 URL（Plan + Build）。

    Args（来自 schema）:
        url: 要打开的 URL（必须 http/https）。

    Returns:
        ``{"url", "opened"}``；失败：``{"url", "opened": False, "error"}``。
    """
    url = str(args.get("url") or "")
    if not url:
        return {"error": "url is required", "url": "", "opened": False}
    if not (url.startswith("http://") or url.startswith("https://")):
        return {
            "error": f"invalid url (must start with http/https): {url}",
            "url": url,
            "opened": False,
        }

    try:
        opened = await asyncio.to_thread(webbrowser.open, url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("open_url 失败 %s: %s", url, exc)
        return {"url": url, "opened": False, "error": str(exc)}

    return {"url": url, "opened": bool(opened)}


# ======================================================================
# system_notification
# ======================================================================

_NOTIFICATION_PS_TEMPLATE = (
    "Add-Type -AssemblyName System.Windows.Forms; "
    "$balloon = New-Object System.Windows.Forms.NotifyIcon; "
    "$balloon.Icon = [System.Drawing.SystemIcons]::Information; "
    "$balloon.BalloonTipTitle = '{title}'; "
    "$balloon.BalloonTipText = '{body}'; "
    "$balloon.Visible = $true; "
    "$balloon.ShowBalloonTip(5000); "
    "Start-Sleep -Seconds 6; "
    "$balloon.Dispose()"
)


def _build_notification_ps_script(title: str, body: str) -> str:
    """构造显示 toast 通知的 PowerShell 脚本（单引号字符串已转义）。"""
    return _NOTIFICATION_PS_TEMPLATE.format(
        title=_ps_single_quote_escape(title),
        body=_ps_single_quote_escape(body),
    )


async def system_notification(args: dict[str, Any]) -> dict[str, Any]:
    """发送系统桌面通知（Plan + Build）。

    Windows 用 PowerShell + ``System.Windows.Forms.NotifyIcon`` 显示气泡通知；
    macOS 用 ``osascript display notification``；Linux 用 ``notify-send``。

    Args（来自 schema）:
        title: 通知标题。
        body: 通知正文（可选）。

    Returns:
        ``{"title", "body", "shown"}``；失败时 ``shown=False``。
    """
    title = str(args.get("title") or "")
    body = str(args.get("body") or "")
    if not title:
        return {"error": "title is required", "title": "", "body": body, "shown": False}

    shown = False
    try:
        if sys.platform == "win32":
            script = _build_notification_ps_script(title, body)
            try:
                rc, _, stderr_bytes = await _run_subprocess(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                    timeout=15,
                )
            except subprocess.TimeoutExpired:
                logger.warning("system_notification PowerShell 超时")
            else:
                shown = rc == 0
                if not shown and stderr_bytes:
                    logger.warning(
                        "system_notification PowerShell 失败: %s",
                        stderr_bytes.decode("utf-8", errors="replace"),
                    )
        elif sys.platform == "darwin":
            esc_body = _ps_single_quote_escape(body)
            esc_title = _ps_single_quote_escape(title)
            script = (
                f'display notification "{esc_body}" with title "{esc_title}"'
            )
            rc, _, _ = await _run_subprocess(["osascript", "-e", script], timeout=15)
            shown = rc == 0
        else:
            rc, _, _ = await _run_subprocess(["notify-send", title, body], timeout=15)
            shown = rc == 0
    except OSError as exc:
        logger.warning("system_notification 启动失败: %s", exc)
        shown = False

    return {"title": title, "body": body, "shown": shown}


# ======================================================================
# screenshot
# ======================================================================

def _grab_and_save_sync(saved_path: Path) -> tuple[int, str]:
    """同步抓取主屏并保存为 PNG，返回 ``(size, captured_at)``。"""
    # 延迟导入，避免无 GUI 环境下加载 PIL 失败影响模块导入
    from PIL import ImageGrab  # type: ignore[import-not-found]

    captured_at = datetime.now(UTC).strftime("%Y%m%d_%H%M%S_%f")
    img = ImageGrab.grab()  # 主屏
    img.save(str(saved_path), "PNG")
    size = saved_path.stat().st_size if saved_path.exists() else 0
    return size, captured_at


async def screenshot(args: dict[str, Any]) -> dict[str, Any]:
    """截取当前主屏并保存 PNG（Plan + Build）。

    保存到 ``settings.data_dir/screenshots/{timestamp}.png``。

    Args（来自 schema）:
        monitor: 显示器编号（可选，当前实现忽略，固定主屏）。

    Returns:
        成功：``{"path", "size", "captured_at"}``；
        失败：``{"error": "..."}``。
    """
    screenshots_dir = settings.data_dir / _SCREENSHOTS_DIR_NAME
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S_%f")
    saved_path = screenshots_dir / f"{timestamp}.png"

    try:
        size, captured_at = await asyncio.to_thread(_grab_and_save_sync, saved_path)
    except Exception as exc:  # noqa: BLE001
        logger.warning("screenshot 失败: %s", exc)
        return {"error": f"screenshot failed: {exc}"}

    return {
        "path": str(saved_path),
        "size": size,
        "captured_at": captured_at,
    }


# ======================================================================
# clipboard_read
# ======================================================================

_CLIPBOARD_READ_PS = (
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
    "Get-Clipboard -Format Text -Raw"
)


async def clipboard_read(args: dict[str, Any]) -> dict[str, Any]:
    """读取系统剪贴板文本（Plan + Build）。

    Windows 用 PowerShell ``Get-Clipboard``；macOS 用 ``pbpaste``；
    Linux 用 ``xclip``。

    Args（来自 schema）:
        format: 剪贴板格式（当前仅支持 ``text``，忽略其他值）。

    Returns:
        成功：``{"content", "type": "text"}``；失败：``{"error": "..."}``。
    """
    content = ""

    try:
        if sys.platform == "win32":
            _, stdout_bytes, _ = await _run_subprocess(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", _CLIPBOARD_READ_PS],
                timeout=10,
            )
            content = _strip_bom_safe(stdout_bytes).decode("utf-8", errors="replace")
            content = content.rstrip("\r\n")
        elif sys.platform == "darwin":
            _, stdout_bytes, _ = await _run_subprocess(["pbpaste"], timeout=10)
            content = stdout_bytes.decode("utf-8", errors="replace")
        else:
            _, stdout_bytes, _ = await _run_subprocess(
                ["xclip", "-selection", "clipboard", "-o"], timeout=10
            )
            content = stdout_bytes.decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return {"error": "clipboard read timeout"}
    except OSError as exc:
        logger.warning("clipboard_read 失败: %s", exc)
        return {"error": f"clipboard read failed: {exc}"}

    return {"content": content, "type": "text"}


# ======================================================================
# clipboard_write
# ======================================================================

_CLIPBOARD_WRITE_PS = (
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; "
    "$text = [Console]::In.ReadToEnd(); "
    "Set-Clipboard -Value $text"
)


async def clipboard_write(args: dict[str, Any]) -> dict[str, Any]:
    """写入系统剪贴板文本（仅 Build 模式）。

    Windows 用 PowerShell ``Set-Clipboard``（通过 stdin 传入，避免命令行
    长度限制与引号转义问题）；macOS 用 ``pbcopy``；Linux 用 ``xclip``。

    Args（来自 schema）:
        content: 要写入剪贴板的文本。

    Returns:
        成功：``{"written", "content_length"}``；失败：``{"error": "..."}``。
    """
    content = args.get("content")
    if content is None:
        return {"error": "content is required"}
    if not isinstance(content, str):
        return {"error": "content must be a string"}

    data = content.encode("utf-8")
    written = False

    try:
        if sys.platform == "win32":
            try:
                rc, _, stderr_bytes = await _run_subprocess(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", _CLIPBOARD_WRITE_PS],
                    stdin_data=data,
                    timeout=10,
                )
            except subprocess.TimeoutExpired:
                return {"error": "clipboard write timeout"}
            written = rc == 0
            if not written and stderr_bytes:
                logger.warning(
                    "clipboard_write PowerShell 失败: %s",
                    stderr_bytes.decode("utf-8", errors="replace"),
                )
        elif sys.platform == "darwin":
            rc, _, _ = await _run_subprocess(["pbcopy"], stdin_data=data, timeout=10)
            written = rc == 0
        else:
            rc, _, _ = await _run_subprocess(
                ["xclip", "-selection", "clipboard"], stdin_data=data, timeout=10
            )
            written = rc == 0
    except OSError as exc:
        logger.warning("clipboard_write 失败: %s", exc)
        return {"error": f"clipboard write failed: {exc}"}

    return {"written": written, "content_length": len(content)}


__all__ = [
    "command_exec",
    "open_app",
    "open_url",
    "system_notification",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
]

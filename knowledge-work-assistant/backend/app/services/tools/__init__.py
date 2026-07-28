"""本地工具集（Task 3 适配移植）。

按职责拆分为三个模块：

- :mod:`app.services.tools.file_tools`：文件读写与目录列表
  （``file_read`` / ``file_write`` / ``file_list``），并提供
  :func:`register_file_tools` 便捷注册函数（writer_agent 工具循环依赖）。
- :mod:`app.services.tools.system_tools`：系统交互
  （``command_exec`` / ``open_app`` / ``open_url`` /
  ``system_notification`` / ``screenshot`` /
  ``clipboard_read`` / ``clipboard_write``）
- :mod:`app.services.tools.task_tools`：会话内存级任务列表
  （``TaskStore`` + ``task_create`` / ``task_list`` /
  ``task_update`` / ``task_delete`` handler 工厂）

所有 handler 签名统一为 ``(args: dict) -> dict``，供
:class:`app.services.tool_registry.ToolRegistry` 注册。

模式感知：``ToolRegistry.execute`` 会将当前模式注入 ``args["_mode"]``
（``"plan"`` / ``"build"``，未传入时缺省为 ``"build"`` 语义），需要模式感知的
handler（如 ``file_read``）据此分支。

KWA 适配说明（相对步影原版）：
- **裁剪未移植工具**（SubTask 3.4）：移除 ``web_search`` / ``search_tools`` /
  ``skill_tools`` 的导入与注册（依赖步影未移植模块）。
- 保留 ``file_tools`` / ``system_tools`` / ``task_tools`` 的完整能力
  （无步影特有依赖，可直接适配拷贝）。
"""

from __future__ import annotations

from app.services.tools.file_tools import (
    file_list,
    file_read,
    file_write,
    register_file_tools,
)
from app.services.tools.system_tools import (
    clipboard_read,
    clipboard_write,
    command_exec,
    open_app,
    open_url,
    screenshot,
    system_notification,
)
from app.services.tools.task_tools import (
    TaskStore,
    make_placeholder_task_handlers,
    make_task_handlers,
)

__all__ = [
    # file tools
    "file_read",
    "file_write",
    "file_list",
    "register_file_tools",
    # system tools
    "command_exec",
    "open_app",
    "open_url",
    "system_notification",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    # task tools
    "TaskStore",
    "make_task_handlers",
    "make_placeholder_task_handlers",
]

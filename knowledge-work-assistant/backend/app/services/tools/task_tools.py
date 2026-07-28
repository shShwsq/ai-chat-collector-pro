r"""task 工具：会话内存级任务列表（TaskList / plan 功能）。

提供 :class:`TaskStore` 与四个 handler 工厂，供
:class:`app.services.tool_registry.ToolRegistry` 注册：

- ``task_create``：创建任务，返回 id
- ``task_list``：列出全部任务
- ``task_update``：更新任务状态/标题/描述
- ``task_delete``：删除任务

任务存于 :class:`TaskStore` 实例（MainAgent 每会话一个，内存级，会话结束即清空）。
handler 通过 ``task_store_getter`` 闭包绑定会话，仿 ``append_note`` 的
``session_id_getter`` 模式。plan 与 build 模式均可用（规划是只读操作）。

KWA 适配：本模块无步影特有依赖，从 ``步影/backend/app/services/tools/task_tools.py``
直接适配拷贝，保留全部注释与 docstring。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from app.services.tool_registry import ToolHandler

logger = logging.getLogger(__name__)

# 合法任务状态
_VALID_STATUSES = ("pending", "in_progress", "completed", "deleted")


class TaskStore:
    """会话内存级任务列表。

    存于 MainAgent 实例 attribute，会话结束即释放。非线程安全
    （单会话单事件循环，无需加锁）。

    任务结构::

        {"id": "1", "subject": "...", "description": "...", "status": "pending"}
    """

    def __init__(self) -> None:
        self._tasks: list[dict[str, Any]] = []
        self._counter: int = 0

    def create(self, subject: str, description: str = "") -> dict[str, Any]:
        """创建一个任务，返回任务 dict。"""
        self._counter += 1
        task: dict[str, Any] = {
            "id": str(self._counter),
            "subject": subject,
            "description": description,
            "status": "pending",
        }
        self._tasks.append(task)
        return dict(task)

    def list_all(self) -> list[dict[str, Any]]:
        """返回全部任务（不含 deleted）。"""
        return [dict(t) for t in self._tasks if t["status"] != "deleted"]

    def get(self, task_id: str) -> dict[str, Any] | None:
        """按 id 查找任务（含 deleted）。"""
        for t in self._tasks:
            if t["id"] == task_id:
                return t
        return None

    def update(
        self,
        task_id: str,
        status: str | None = None,
        subject: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any] | None:
        """更新任务字段。返回更新后的任务 dict（副本），不存在返回 None。"""
        task = self.get(task_id)
        if task is None:
            return None
        if status is not None:
            if status not in _VALID_STATUSES:
                return None  # 调用方应处理 None 为非法状态
            task["status"] = status
        if subject is not None:
            task["subject"] = subject
        if description is not None:
            task["description"] = description
        return dict(task)

    def delete(self, task_id: str) -> bool:
        """删除任务（标记 deleted）。返回是否曾存在。"""
        task = self.get(task_id)
        if task is None:
            return False
        task["status"] = "deleted"
        return True

    def clear(self) -> None:
        """清空全部任务。"""
        self._tasks.clear()
        self._counter = 0


def _no_store_error() -> dict[str, Any]:
    """无 task_store_getter 绑定时的错误返回。"""
    return {
        "status": "error",
        "message": "task 工具未绑定会话（task_store_getter 未提供）",
    }


def make_task_handlers(
    task_store_getter: Callable[[], TaskStore],
) -> dict[str, ToolHandler]:
    """构造 task_* 四个 handler，绑定到指定会话的 TaskStore。

    Args:
        task_store_getter: 返回当前会话 TaskStore 的回调。

    Returns:
        ``{"task_create", "task_list", "task_update", "task_delete"}`` 映射。
    """
    store_getter = task_store_getter

    async def task_create(args: dict[str, Any]) -> dict[str, Any]:
        subject = str(args.get("subject", "")).strip()
        if not subject:
            return {"status": "error", "message": "subject 不能为空"}
        description = str(args.get("description", "") or "").strip()
        task = store_getter().create(subject, description)
        logger.debug("task_create id=%s subject=%s", task["id"], subject)
        return {"status": "ok", "task": task}

    async def task_list_handler(args: dict[str, Any]) -> dict[str, Any]:
        tasks = store_getter().list_all()
        return {"status": "ok", "tasks": tasks, "count": len(tasks)}

    async def task_update(args: dict[str, Any]) -> dict[str, Any]:
        task_id = str(args.get("task_id", "")).strip()
        if not task_id:
            return {"status": "error", "message": "task_id 不能为空"}
        status = args.get("status")
        if status is not None:
            status = str(status).strip()
            if status not in _VALID_STATUSES:
                return {
                    "status": "error",
                    "message": f"非法状态: {status}，合法值: {list(_VALID_STATUSES)}",
                }
        subject = args.get("subject")
        if subject is not None:
            subject = str(subject).strip() if str(subject).strip() else None
        description = args.get("description")
        if description is not None:
            description = str(description).strip()
        updated = store_getter().update(
            task_id,
            status=status,
            subject=subject,
            description=description,
        )
        if updated is None:
            return {"status": "error", "message": f"任务不存在: {task_id}"}
        logger.debug("task_update id=%s status=%s", task_id, status)
        return {"status": "ok", "task": updated}

    async def task_delete(args: dict[str, Any]) -> dict[str, Any]:
        task_id = str(args.get("task_id", "")).strip()
        if not task_id:
            return {"status": "error", "message": "task_id 不能为空"}
        ok = store_getter().delete(task_id)
        if not ok:
            return {"status": "error", "message": f"任务不存在: {task_id}"}
        return {"status": "ok", "deleted": True, "task_id": task_id}

    return {
        "task_create": task_create,
        "task_list": task_list_handler,
        "task_update": task_update,
        "task_delete": task_delete,
    }


def make_placeholder_task_handlers() -> dict[str, ToolHandler]:
    """无会话绑定时使用的占位 handler（返回错误，供全局注册表使用）。"""

    async def _err(args: dict[str, Any]) -> dict[str, Any]:
        return _no_store_error()

    return {
        "task_create": _err,
        "task_list": _err,
        "task_update": _err,
        "task_delete": _err,
    }


__all__ = [
    "TaskStore",
    "make_task_handlers",
    "make_placeholder_task_handlers",
]

"""应用级后台任务注册表，负责停止接单与关停收敛。"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TaskMeta:
    request_id: str | None = None
    session_id: str | None = None
    op: str | None = None


class BackgroundTaskRegistry:
    """持有后台任务强引用，并在应用退出时有界取消、等待。"""

    def __init__(self) -> None:
        self._tasks: dict[asyncio.Task[Any], TaskMeta] = {}
        self._accepting = True

    @property
    def accepting(self) -> bool:
        return self._accepting

    def start_accepting(self) -> None:
        self._accepting = True

    def create_task(
        self,
        coroutine: Coroutine[Any, Any, Any],
        *,
        request_id: str | None = None,
        session_id: str | None = None,
        op: str | None = None,
    ) -> asyncio.Task[Any]:
        if not self._accepting:
            coroutine.close()
            raise RuntimeError("应用正在关停，暂不接受新的后台任务")

        task = asyncio.create_task(coroutine, name=f"kwa:{op or 'background'}")
        self._tasks[task] = TaskMeta(request_id, session_id, op)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        meta = self._tasks.pop(task, None)
        if task.cancelled():
            return
        try:
            error = task.exception()
        except asyncio.CancelledError:
            return
        if error is not None:
            logger.error("后台任务异常 op=%s request=%s: %s", meta.op if meta else None,
                         meta.request_id if meta else None, error)

    async def shutdown(self, timeout: float = 8.0) -> int:
        """停止接单，取消当前任务并最多等待 ``timeout`` 秒。"""
        self._accepting = False
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        if not tasks:
            return 0

        done, pending = await asyncio.wait(tasks, timeout=timeout)
        if pending:
            logger.warning("应用关停等待超时，仍有 %d 个后台任务未退出", len(pending))
        # 读取已完成任务结果，避免未检索异常警告。
        await asyncio.gather(*done, return_exceptions=True)
        return len(tasks)

    def active_count(self) -> int:
        return sum(not task.done() for task in self._tasks)

    def forget(self, task: asyncio.Task[Any]) -> None:
        """主动移除已完成任务，供路由维护 request 映射。"""
        self._tasks.pop(task, None)


background_tasks = BackgroundTaskRegistry()

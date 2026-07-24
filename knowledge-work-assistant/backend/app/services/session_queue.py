"""会话级消息等待队列（内存）。

每个 session 拥有一个 :class:`SessionQueueManager` 实例，存储待处理消息队列与会话状态。
重启后丢失可接受（用户确认）；运行期通过 WS ``queue_update`` 事件同步给前端。

数据流：
  1. WS 收到消息时，按 ``status`` 分流：
     - ``idle`` → 直接 ``chat_stream``；
     - ``chatting`` → 按来源/类型入队或中断当前回复（参见 ``_handle_busy_message``）。
  2. ``chat_stream`` 完成后由流式路由取队首推进；
     若是文件且 ``summarize_done=False``，等待概括子 Agent 完成回调标记。
  3. 任意 enqueue/dequeue/remove/clear 都通过 ``notify_session`` 推 ``queue_update``。

并发安全：``asyncio.Lock`` 保护状态变更与队列操作，避免在事件循环中交错。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from app.services.ws_notify import notify_session

logger = logging.getLogger(__name__)

QueueItemType = Literal["text", "file"]
MessageSource = Literal["island", "window"]
SessionStatus = Literal["idle", "chatting", "processing_queue"]

# 灵动岛文件打断当前回复的时间窗口（秒）：15s 内立即拼接，否则退化为子情况2
ISLAND_FILE_INTERRUPT_WINDOW_S = 15.0


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class QueueItem:
    """队列项：待处理的一条用户消息（文本或文件）。"""

    id: str
    type: QueueItemType
    content: str
    source: MessageSource
    created_at: datetime = field(default_factory=_now)
    file_id: str | None = None
    file_name: str | None = None
    file_size: int = 0
    mime_type: str = ""
    # 文件类型：概括子 Agent 是否已完成（概括完毕才能进入 MainAgent）
    summarize_done: bool = False
    # 跟踪概括任务，便于在 revoke/clear 时取消
    summarize_task: asyncio.Task[Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """序列化为前端可消费的 dict（不含 task 引用）。"""
        return {
            "id": self.id,
            "type": self.type,
            "content": self.content,
            "source": self.source,
            "created_at": self.created_at.isoformat(),
            "file_id": self.file_id,
            "file_name": self.file_name,
            "file_size": self.file_size,
            "mime_type": self.mime_type,
            "summarize_done": self.summarize_done,
        }


class SessionQueueManager:
    """会话级队列管理器：维护待处理消息列表与会话状态。

    实例由 :func:`get_queue` 按 ``session_id`` 创建并缓存。
    """

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._queue: list[QueueItem] = []
        self._status: SessionStatus = "idle"
        self._lock = asyncio.Lock()
        # 当前 chat_stream 开始时间，用于 15 秒窗口判定
        self._chat_started_at: datetime | None = None
        # 待处理的中断请求（子情况1/3）：chat_stream 退出后立即执行 revoke + 重启
        self._pending_interrupt: QueueItem | None = None

    @property
    def status(self) -> SessionStatus:
        return self._status

    @property
    def is_busy(self) -> bool:
        """是否正在处理 chat_stream（chatting / processing_queue）。"""
        return self._status in ("chatting", "processing_queue")

    @property
    def chat_started_at(self) -> datetime | None:
        return self._chat_started_at

    @property
    def pending_interrupt(self) -> QueueItem | None:
        return self._pending_interrupt

    def set_pending_interrupt(self, item: QueueItem | None) -> None:
        """设置/清除待处理中断项（非锁保护，仅在持锁后调用）。"""
        self._pending_interrupt = item

    async def set_status(
        self,
        status: SessionStatus,
        *,
        chat_started: bool = False,
        notify: bool = True,
    ) -> None:
        """更新会话状态，可选推 queue_update 事件。"""
        async with self._lock:
            self._status = status
            if chat_started:
                self._chat_started_at = _now()
            elif status == "idle":
                self._chat_started_at = None
        if notify:
            await self.push_update()

    async def enqueue(self, item: QueueItem) -> None:
        """入队一条消息。自动推 queue_update。"""
        async with self._lock:
            self._queue.append(item)
        await self.push_update()

    async def dequeue(self) -> QueueItem | None:
        """取出队首。返回 None 表示队空。"""
        async with self._lock:
            if not self._queue:
                return None
            return self._queue.pop(0)
        # push_update 由调用方在处理后触发

    async def peek(self) -> QueueItem | None:
        """查看队首但不移除。"""
        async with self._lock:
            return self._queue[0] if self._queue else None

    async def remove(self, item_id: str) -> bool:
        """按 id 移除队列项。取消关联的 summarize_task（若有）。返回是否成功。"""
        async with self._lock:
            for i, item in enumerate(self._queue):
                if item.id == item_id:
                    if item.summarize_task and not item.summarize_task.done():
                        item.summarize_task.cancel()
                    self._queue.pop(i)
                    break
            else:
                return False
        await self.push_update()
        return True

    async def mark_summarize_done(self, item_id: str) -> None:
        """标记某个文件项的概括子 Agent 完成。"""
        async with self._lock:
            for item in self._queue:
                if item.id == item_id:
                    item.summarize_done = True
                    break
            else:
                # 队列中没找到，可能已被消费或取消
                return
        await self.push_update()

    async def mark_summarize_done_by_file_id(self, file_id: str) -> bool:
        """按 file_id 标记队列项的概括子 Agent 完成。

        用于 upload 路由的概括完成回调（按 file_id 查找而非 item_id）。

        Returns:
            True 表示找到并标记成功；False 表示队列中无此 file_id 的项
            （可能已被消费或取消，静默处理）。
        """
        async with self._lock:
            for item in self._queue:
                if item.file_id == file_id:
                    item.summarize_done = True
                    break
            else:
                return False
        await self.push_update()
        return True

    async def pop_island_items(self) -> list[QueueItem]:
        """取出并移除队列中所有 source='island' 的队列项。

        用于"情况一"：空闲态用户发新消息时，将待处理的 island 文件
        拼接到新消息前一起发送给主 Agent。

        不取消关联的 summarize_task（入库操作应继续完成，供 RAG 检索）。
        """
        async with self._lock:
            island_items = [item for item in self._queue if item.source == "island"]
            if not island_items:
                return []
            self._queue = [item for item in self._queue if item.source != "island"]
        await self.push_update()
        return island_items

    async def clear(self) -> None:
        """清空队列（取消所有 summarize_task）。"""
        async with self._lock:
            for item in self._queue:
                if item.summarize_task and not item.summarize_task.done():
                    item.summarize_task.cancel()
            self._queue.clear()
            self._pending_interrupt = None
        await self.push_update()

    async def snapshot(self) -> dict[str, Any]:
        """返回当前队列快照（含状态、items）。"""
        async with self._lock:
            return {
                "type": "queue_update",
                "status": self._status,
                "items": [item.to_dict() for item in self._queue],
                "chat_started_at": (
                    self._chat_started_at.isoformat()
                    if self._chat_started_at
                    else None
                ),
            }

    async def push_update(self) -> None:
        """推送 queue_update 事件给该 session 的所有 WS 连接。"""
        event = await self.snapshot()
        try:
            await notify_session(self.session_id, event)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "queue_update 推送失败 session=%s: %s", self.session_id, exc
            )

    def should_interrupt_for_island_file(self) -> bool:
        """判断灵动岛文件打断是否落在 15s 窗口内（应立即拼接）。

        非锁保护：仅读 ``_chat_started_at`` 与当前时间比较，允许少量误差。
        """
        if self._chat_started_at is None:
            return False
        elapsed = (_now() - self._chat_started_at).total_seconds()
        return elapsed < ISLAND_FILE_INTERRUPT_WINDOW_S


# 全局队列管理器注册表：session_id -> SessionQueueManager
_SESSION_QUEUES: dict[str, SessionQueueManager] = {}


def get_queue(session_id: str) -> SessionQueueManager:
    """获取或创建会话级队列管理器。"""
    mgr = _SESSION_QUEUES.get(session_id)
    if mgr is None:
        mgr = SessionQueueManager(session_id)
        _SESSION_QUEUES[session_id] = mgr
    return mgr


def remove_queue(session_id: str) -> None:
    """会话删除时清理注册表（避免内存泄漏）。"""
    mgr = _SESSION_QUEUES.pop(session_id, None)
    if mgr is not None:
        # 异步清理不能 await（调用方可能不在 async 上下文），
        # summarize_task 由 GC 自动回收
        _ = mgr


def make_text_item(
    content: str,
    source: MessageSource,
) -> QueueItem:
    """构造文本队列项。"""
    return QueueItem(
        id=uuid.uuid4().hex,
        type="text",
        content=content,
        source=source,
    )


def make_file_item(
    file_id: str,
    file_name: str,
    file_size: int,
    mime_type: str,
    source: MessageSource,
    summarize_task: asyncio.Task[Any] | None = None,
    content: str = "",
) -> QueueItem:
    """构造文件队列项。"""
    return QueueItem(
        id=uuid.uuid4().hex,
        type="file",
        content=content or f"文件: {file_name}",
        file_id=file_id,
        file_name=file_name,
        file_size=file_size,
        mime_type=mime_type,
        source=source,
        summarize_done=False,
        summarize_task=summarize_task,
    )

"""LLM 请求注册表（内存级）。

为前端「LLM 请求管理面板」提供全局可见的请求视图：每个 LLM 调用在
发起前向注册表登记一条 :class:`LlmRequestInfo`，调用结束后更新状态。
流式调用在中途可被 :meth:`LlmRequestRegistry.cancel` 标记为 ``cancelled``，
LLM 客户端在下一个 chunk 边界检查并主动中断。

设计要点：

1. **线程安全**：所有写操作通过 :class:`asyncio.Lock` 串行化，避免并发更新
   导致状态不一致。读操作（``list_active`` / ``list_all``）也走锁，确保
   拿到的快照一致（注册表条目数有限，锁开销可忽略）。
2. **内存级 / 无持久化**：进程重启后注册表清空。前端可定期轮询
   ``GET /api/llm/requests`` 获取最新快照。
3. **id 唯一性**：使用 ``uuid4().hex[:16]`` 作为请求 id，碰撞概率极低且
   短，便于前端 URL 与日志引用。
4. **自动清理**：:meth:`cleanup_old` 删除 ``completed`` / ``cancelled`` /
   ``failed`` 状态中超过 ``max_age`` 秒（默认 300s）的条目，避免内存无限
   增长。可由 lifespan 或后台任务定期调用。
5. **取消语义**：``cancel`` 仅将 ``queued`` / ``running`` 状态标记为
   ``cancelled``，实际中断由调用方在流式循环中检查状态后自行 ``break``。
   非流式调用（``chat`` / ``embed``）一旦发起 HTTP 请求即不可中断，``cancel``
   仅作为「软」标记，调用方在下一次机会检查时丢弃结果。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# 终态集合：进入这些状态后，请求不再可被取消
_TERMINAL_STATES: frozenset[str] = frozenset(
    {"completed", "cancelled", "failed"}
)
# 活跃状态集合：list_active 仅返回这些状态
_ACTIVE_STATES: frozenset[str] = frozenset({"queued", "running"})


@dataclass
class LlmRequestInfo:
    """单次 LLM 请求的元信息。

    Attributes:
        id: 请求唯一标识（``uuid4().hex[:16]``）。
        purpose: 调用用途标签，如 ``generate_node_detail`` / ``extend_node`` /
            ``generate_quiz`` / ``grade_feynman`` / ``generate_trends`` /
            ``generate_report`` / ``answer_question`` / ``extract_work_objects`` /
            ``extract_nodes`` / ``generate_directions`` 等。
        node_id: 关联的节点 ID（可选，用于前端定位节点）。
        graph_id: 关联的图谱 ID（可选）。
        status: 请求状态，取值：
            ``queued``    —— 已注册，尚未发起实际 HTTP 请求
            ``running``   —— HTTP 请求已发起，正在流式 / 等待响应
            ``completed`` —— 正常结束
            ``cancelled`` —— 被用户取消（标记）
            ``failed``    —— 异常结束
        started_at: 注册时的时间戳（``time.time()``）。
        completed_at: 进入终态时的时间戳；活跃请求为 ``None``。
        error: ``failed`` 时的错误消息，其它状态为 ``None``。
    """

    id: str
    purpose: str
    status: str
    started_at: float
    node_id: str | None = None
    graph_id: str | None = None
    completed_at: float | None = None
    error: str | None = None
    # 附加元数据（如 model / 标题），便于前端展示；不参与状态判断
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 友好的 dict（前端响应体直接使用）。"""
        return {
            "id": self.id,
            "purpose": self.purpose,
            "status": self.status,
            "started_at": self.started_at,
            "node_id": self.node_id,
            "graph_id": self.graph_id,
            "completed_at": self.completed_at,
            "error": self.error,
            "meta": dict(self.meta),
        }


class LlmRequestRegistry:
    """全局 LLM 请求注册表（线程安全，内存级单例）。

    典型用法::

        rid = await registry.register(
            "generate_node_detail", node_id="n1", graph_id="g1"
        )
        try:
            await registry.update(rid, "running")
            result = await llm_client.chat(...)
            await registry.update(rid, "completed")
        except Exception as exc:
            await registry.update(rid, "failed", error=str(exc))
            raise
    """

    def __init__(self) -> None:
        # 请求 id -> LlmRequestInfo
        self._requests: dict[str, LlmRequestInfo] = {}
        # 所有读写均通过此锁串行化
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # 注册 / 更新 / 取消
    # ------------------------------------------------------------------

    async def register(
        self,
        purpose: str,
        *,
        node_id: str | None = None,
        graph_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> str:
        """注册一次新的 LLM 请求，初始状态为 ``queued``。

        Args:
            purpose: 调用用途标签（见 :class:`LlmRequestInfo` 文档）。
            node_id: 关联节点 ID（可选）。
            graph_id: 关联图谱 ID（可选）。
            meta: 附加展示元数据（如节点标题、模型名等）。

        Returns:
            新请求的 id（16 位十六进制字符串）。
        """
        rid = uuid.uuid4().hex[:16]
        info = LlmRequestInfo(
            id=rid,
            purpose=purpose,
            status="queued",
            started_at=time.time(),
            node_id=node_id,
            graph_id=graph_id,
            meta=dict(meta) if meta else {},
        )
        async with self._lock:
            self._requests[rid] = info
        logger.debug(
            "LlmRequestRegistry: register id=%s purpose=%s node=%s graph=%s",
            rid,
            purpose,
            node_id,
            graph_id,
        )
        return rid

    async def update(
        self,
        rid: str,
        status: str,
        *,
        error: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> bool:
        """更新请求状态。

        进入终态（``completed`` / ``cancelled`` / ``failed``）时自动写入
        ``completed_at``。``error`` 仅在 ``failed`` 状态下有意义，但允许在
        其它状态传入（用于记录非致命告警，不会覆盖已有 error）。

        Args:
            rid: 请求 id。
            status: 新状态。
            error: 错误消息（可选）。
            meta: 待合并的元数据（可选，键级合并，不覆盖既有值时传 None）。

        Returns:
            更新成功返回 True；请求不存在返回 False。
        """
        async with self._lock:
            info = self._requests.get(rid)
            if info is None:
                return False
            info.status = status
            if status in _TERMINAL_STATES and info.completed_at is None:
                info.completed_at = time.time()
            if error:
                info.error = error
            if meta:
                # 键级合并，避免传入空 dict 清空既有元数据
                for k, v in meta.items():
                    if v is not None:
                        info.meta[k] = v
            return True

    async def cancel(self, rid: str) -> bool:
        """取消指定请求（标记为 ``cancelled``）。

        仅对 ``queued`` / ``running`` 状态生效；已进入终态的请求不会被
        重复取消。实际中断由调用方在流式循环中检查状态后自行处理。

        Returns:
            取消成功返回 True；请求不存在或已终态返回 False。
        """
        async with self._lock:
            info = self._requests.get(rid)
            if info is None:
                return False
            if info.status in _TERMINAL_STATES:
                return False
            info.status = "cancelled"
            info.completed_at = time.time()
        logger.info(
            "LlmRequestRegistry: cancel id=%s purpose=%s",
            rid,
            info.purpose,
        )
        return True

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    async def get(self, rid: str) -> LlmRequestInfo | None:
        """按 id 获取请求信息（不存在返回 None）。"""
        async with self._lock:
            return self._requests.get(rid)

    async def is_cancelled(self, rid: str) -> bool:
        """快速判断请求是否已被取消（流式循环中高频调用）。

        不存在的 id 视为未取消，避免误中断合法请求。
        """
        async with self._lock:
            info = self._requests.get(rid)
            return info is not None and info.status == "cancelled"

    async def list_active(self) -> list[LlmRequestInfo]:
        """返回所有活跃请求（``queued`` / ``running``），按 started_at 升序。"""
        async with self._lock:
            items = [
                info
                for info in self._requests.values()
                if info.status in _ACTIVE_STATES
            ]
        items.sort(key=lambda x: x.started_at)
        return items

    async def list_all(self, limit: int = 50) -> list[LlmRequestInfo]:
        """返回最近所有请求（含已完成），按 started_at 降序，截断到 ``limit``。"""
        async with self._lock:
            items = list(self._requests.values())
        items.sort(key=lambda x: x.started_at, reverse=True)
        if limit > 0:
            items = items[:limit]
        return items

    # ------------------------------------------------------------------
    # 清理
    # ------------------------------------------------------------------

    async def cleanup_old(self, max_age: float = 300.0) -> int:
        """清理超过 ``max_age`` 秒的终态请求。

        Args:
            max_age: 最大保留时长（秒），默认 300（5 分钟）。

        Returns:
            被清理的条目数。
        """
        now = time.time()
        cutoff = now - max_age
        removed = 0
        async with self._lock:
            # 遍历时复制键，避免修改 dict 时迭代错误
            for rid in list(self._requests.keys()):
                info = self._requests.get(rid)
                if info is None:
                    continue
                if info.status in _TERMINAL_STATES and info.completed_at is not None:
                    if info.completed_at < cutoff:
                        del self._requests[rid]
                        removed += 1
        if removed:
            logger.debug(
                "LlmRequestRegistry: cleanup_old removed %d entries (max_age=%ss)",
                removed,
                max_age,
            )
        return removed

    async def clear(self) -> int:
        """清空所有请求记录（仅供测试或管理接口使用）。

        Returns:
            清空前条目数。
        """
        async with self._lock:
            n = len(self._requests)
            self._requests.clear()
        return n


#: 全局 LLM 请求注册表单例。
#:
#: 所有 LLM 调用方（``llm_client`` / ``graph_agent``）共享此实例，
#: 由 :mod:`app.routers.llm_admin` 暴露给前端管理面板。
llm_request_registry = LlmRequestRegistry()

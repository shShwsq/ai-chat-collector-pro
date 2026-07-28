"""无限上下文管理器（Task 1 核心移植）。

实现 MiMo-Code 风格的"显式存储 + 按需检索"上下文管理，由四类机制协同：

1. **Checkpoint + Writer Subagent**：在上下文窗口的固定比例位置（20% / 45% / 70%）
   自动触发；Writer 在独立上下文中读取全量对话 + 便签本，输出 11 个结构化字段，
   落库 + 落盘，**并发执行不阻塞主 Agent**。
2. **Rebuild + Cycle**：上下文接近上限（85%）时切断窗口，用最新 checkpoint +
   项目记忆 + 任务进度 + 近期保留消息重建；cycle_index 自增并记录到 Checkpoint 表。
3. **Compaction**：兜底层，接近上限时将旧消息压缩为摘要；配合 Prune 裁剪旧工具输出。
4. **文件原文替换**：主 agent 专属，文件原文在对话中保留三轮后替换为本地路径引用 +
   摘要，原文按需读取。

token 估算暂用"字符数 / _CHARS_PER_TOKEN"（不引入 tiktoken 依赖），后续可平滑替换为精确分词。

KWA 适配说明（相对步影原版）：
- 裁剪 ``notes`` 模块依赖（KWA 无此模块）。``_dispatch_writer`` 中 ``notes`` 入参
  固定为空串；``append_note`` 方法保留为 no-op（仅记录 debug 日志），供
  ``context_manager`` API 兼容，但不再落盘便签本。
- 保留 ``WriterAgent`` 的 import 与 ``_writer`` 实例化（Task 6 移植完整 writer_agent）。
- 保留 ``compaction`` 模块（已适配移植到 KWA ``services/compaction.py``）。
- ``Checkpoint`` / ``Message`` / ``FileMetadata`` 表 KWA 已有，字段对齐一致。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import desc, select

from app.config import settings
from app.db import AsyncSessionLocal
from app.models.db_models import Checkpoint, FileMetadata, Message as MessageRow
from app.services.compaction import Compactor, prune_tool_outputs
from app.services.llm_client import LLMClient
from app.services.writer_agent import CHECKPOINT_FIELDS, WriterAgent

logger = logging.getLogger(__name__)

# 默认模型上下文窗口（gpt-4o-mini 约为 128000）
DEFAULT_MODEL_WINDOW = 128000
# 字符 -> token 的粗略换算系数。
# 实测 qwen3.5 tokenizer 对中文混合内容约 1.2 字符/token；用 1.5 偏保守
# （宁可高估 token 数、提早触发 checkpoint/rebuild，也不要低估导致超窗口）。
_CHARS_PER_TOKEN = 1.5
# 触发 checkpoint 的窗口占用比例
DEFAULT_CHECKPOINT_THRESHOLDS: list[float] = [0.20, 0.45, 0.70]
# 触发 compaction 的窗口占用比例
COMPACT_THRESHOLD = 0.85
# 触发 rebuild 的窗口占用比例
REBUILD_THRESHOLD = 0.85
# 重建上下文的总 token 预算占窗口的比例（留另一半给新对话）
# MiMo-Code 的 caps 是固定值（checkpoint 11K + memory 10K + notes 6K + recent 16K），
# 针对大窗口；我们按窗口比例缩放以适配 8K 小窗口
REBUILD_BUDGET_RATIO = 0.5
# 各类记忆在重建预算中的占比（checkpoint > memory > task > recent 的重要性体现）
_BUDGET_RATIOS = {"checkpoint": 0.40, "memory": 0.20, "task": 0.15, "recent": 0.25}
# 重建时从 DB 加载的最近消息条数上限（再按 token 预算筛选）
REBUILD_LOAD_RECENT_MAX = 50
# MiMo-Code 风格的 tail 边界预算（按 8192 窗口等比缩放；大窗口可上调）
TAIL_MIN_TOKENS = 2500
TAIL_MAX_TOKENS = 5000
TAIL_MIN_TEXT_MESSAGES = 5
# Writer 输入的 token 安全上限（大窗口时的固定上限；小窗口下按 model_window*0.5 缩放）
WRITER_INPUT_BUDGET_TOKENS = 6000
# Writer 预算占窗口的比例（为 system prompt + 输出留出另一半空间）
WRITER_BUDGET_WINDOW_RATIO = 0.5
# 文件原文替换策略：文件被引入后需经历的完整对话轮数
ROUNDS_BEFORE_FILE_REPLACE = 3
# 内联文件原文检测：base64 data URL（图片等内联二进制）
_BASE64_DATA_URL_RE = re.compile(
    r"data:[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+"
)
# 内联文件原文检测：显式 marker 块（由上传/解析流程内联的文本原文）
_FILE_MARKER_BLOCK_RE = re.compile(r"\[文件内容开始\][\s\S]*?\[文件内容结束\]")


def _estimate_text_tokens(text: str) -> int:
    """字符数 / _CHARS_PER_TOKEN 的粗略 token 估算。"""
    if not text:
        return 0
    return max(1, int(len(text) // _CHARS_PER_TOKEN))


def _truncate_to_tokens(text: str, token_budget: int) -> str:
    """按 token 预算截断文本，超长则尾部标注已截断。"""
    if not text:
        return ""
    max_chars = int(max(0, token_budget) * _CHARS_PER_TOKEN)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...(已截断)"


def _message_content_text(content: Any) -> str:
    """从 message.content 提取可估算的文本（str / list / dict 统一处理）。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(content)


class ContextManager:
    """会话级上下文管理器。

    每个会话应复用同一实例（按 ``session_id`` 缓存），以保持 ``triggered_checkpoints``
    等状态跨多轮对话持续有效。

    Args:
        session_id: 会话 ID。
        llm_client: 主 Agent 使用的 ``LLMClient``（Writer / Compactor 复用，因 LLMClient
            无状态，上下文隔离通过独立 messages 数组实现）。
        model_window: 模型上下文窗口大小（token），默认 128000。
        system_prompt: 主 system prompt 文本（不在 messages 列表内，单独计入 token 总量）。
    """

    def __init__(
        self,
        session_id: str,
        llm_client: LLMClient,
        model_window: int = DEFAULT_MODEL_WINDOW,
        system_prompt: str = "",
    ) -> None:
        self.session_id = session_id
        self.llm_client = llm_client
        self.model_window = model_window
        # 当前对话估算 token 数（由 estimate_tokens 更新）
        self.current_tokens: int = 0
        self.checkpoint_thresholds: list[float] = list(DEFAULT_CHECKPOINT_THRESHOLDS)
        # 已触发的 checkpoint 阈值索引（避免同一阈值重复触发）
        self.triggered_checkpoints: set[int] = set()
        # 当前 messages 列表中已被 checkpoint 处理到的索引（MiMo-Code 的
        # last_checkpoint_message_id 的内存等价物；Writer 只处理该索引之后的消息）
        self.last_checkpoint_idx: int = 0
        # 主 system prompt（OpenAI 消息列表外的系统提示词），单独保存以便
        # 跨轮复用；estimate_tokens 会将其 token 计入总量。
        self.system_prompt: str = system_prompt
        self.system_prompt_tokens: int = _estimate_text_tokens(system_prompt)
        # 子组件
        self._writer = WriterAgent(llm_client)
        self._compactor = Compactor()
        # 后台任务引用（防止被 GC 回收）
        self._pending_tasks: set[asyncio.Task[Any]] = set()
        # Writer 是否在运行（MiMo-Code isWriterRunning 等价物；防止并发 Writer
        # 竞态写入同一 cycle_index）
        self._writer_running: bool = False

    def set_system_prompt(self, text: str) -> None:
        """设置主 system prompt；estimate_tokens 会把它一并计入 token 总量。"""
        self.system_prompt = text
        self.system_prompt_tokens = _estimate_text_tokens(text)

    def update_llm_client(self, client: LLMClient) -> None:
        """刷新 LLMClient（配置可能在会话进行中被修改）。

        ``LLMClient`` 无状态，更新主 Agent 与 Writer 的引用即可；Compactor 每次
        ``compact`` 时显式传入 client，无需在此更新。
        """
        self.llm_client = client
        self._writer.llm_client = client

    # ==================================================================
    # Token 估算
    # ==================================================================

    async def estimate_tokens(self, messages: list[dict[str, Any]]) -> int:
        """估算 messages 的 token 数（含主 system prompt）。

        暂用"字符数 / _CHARS_PER_TOKEN"近似（不引入 tiktoken）。同步实现，标记 async 以便未来
        替换为精确分词（如 ``tiktoken.encoding_for_model``）而不改调用方。
        """
        total = self.system_prompt_tokens
        for m in messages:
            total += _estimate_text_tokens(_message_content_text(m.get("content", "")))
            # attachments 等额外字段不计入（已折叠进 content 或为元数据）
        self.current_tokens = max(1, total)
        return self.current_tokens

    @staticmethod
    def compute_boundary(
        messages: list[dict[str, Any]],
        tail_min_tokens: int = TAIL_MIN_TOKENS,
        tail_max_tokens: int = TAIL_MAX_TOKENS,
        tail_min_text: int = TAIL_MIN_TEXT_MESSAGES,
    ) -> int:
        """计算应保留的 tail 起始索引（参考 MiMo-Code computeBoundary）。

        返回 ``idx`` 表示：``messages[idx:]`` 作为最近现场上下文保留，
        ``messages[:idx]`` 交给 Writer 做增量 checkpoint。

        策略：
          1. 从最后一个 assistant 消息往前数，初始候选 tail 起点为
             ``last_asst_idx - 1``；
          2. 若该 tail 已 >= ``tail_max_tokens`` 则保持不变（软上限，不破坏
             tool 调用配对）；
          3. 否则向前扩展，直到满足 ``tail_min_tokens`` 且至少
             ``tail_min_text`` 条文本消息，或到达开头。

        Args:
            messages: 当前 delta 切片内的消息（已去掉此前 checkpoint 过的前缀）。
            tail_min_tokens: tail 最小 token 数。
            tail_max_tokens: tail 软最大 token 数。
            tail_min_text: tail 最少文本消息条数。

        Returns:
            tail 起始索引（0 <= idx <= len(messages)）。
        """
        if not messages:
            return 0
        # 找到最后一个 assistant 消息
        last_asst_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "assistant":
                last_asst_idx = i
                break
        if last_asst_idx <= 0:
            return 0

        tokens = [_estimate_text_tokens(_message_content_text(m.get("content", ""))) for m in messages]

        start_idx = max(0, last_asst_idx - 1)
        tail_sum = sum(tokens[start_idx:])
        text_count = sum(
            1
            for m in messages[start_idx:]
            if _message_content_text(m.get("content", "")).strip()
        )

        # 自然 tail 已经过大，不向前扩展
        if tail_sum >= tail_max_tokens:
            return start_idx

        # tail 太小，向前扩展直到满足最低要求或到达开头
        while (
            start_idx > 0
            and tail_sum < tail_max_tokens
            and (tail_sum < tail_min_tokens or text_count < tail_min_text)
        ):
            start_idx -= 1
            tail_sum += tokens[start_idx]
            if _message_content_text(messages[start_idx].get("content", "")).strip():
                text_count += 1

        return start_idx

    # ==================================================================
    # SubTask 10.2：自动 checkpoint 决策
    # ==================================================================

    async def maybe_checkpoint(self, messages: list[dict[str, Any]]) -> bool:
        """检查是否应触发 checkpoint。

        当 ``current_tokens / model_window`` 超过某个未触发的阈值时，派发 Writer
        Subagent（**并发，不 await**），记录阈值索引避免重复触发。

        **Writer 守卫**（对齐 MiMo-Code ``fireCheckpoints`` prune.ts:277-282）：
        若 Writer 仍在运行，**直接返回不标记任何阈值**，下次调用时 Writer 可能
        已完成，重新检查所有阈值。之前的实现先标记再派发，若被守卫跳过则该阈值
        永不重试，导致 45%/70% checkpoint 在快速注入场景下永远丢失。

        Args:
            messages: 当前对话全量消息（供 Writer 读取）。

        Returns:
            是否触发了本次 checkpoint。
        """
        if self.model_window <= 0:
            return False
        # Writer running 时跳过整个检查（MiMo-Code fireCheckpoints 风格）。
        # 下次调用时 Writer 可能已完成，重新检查所有阈值。
        if self._writer_running:
            logger.info(
                "Writer 仍在运行，跳过 checkpoint 检查 session=%s", self.session_id
            )
            return False
        ratio = self.current_tokens / self.model_window
        for idx, threshold in enumerate(self.checkpoint_thresholds):
            if ratio >= threshold and idx not in self.triggered_checkpoints:
                self.triggered_checkpoints.add(idx)
                await self._dispatch_writer(messages)
                logger.info(
                    "触发 checkpoint session=%s threshold=%.0f%% tokens=%d/%d",
                    self.session_id,
                    threshold * 100,
                    self.current_tokens,
                    self.model_window,
                )
                return True
        return False

    async def maybe_rebuild(self) -> bool:
        """检查是否应触发 rebuild（窗口占用 >= 85%）。"""
        if self.model_window <= 0:
            return False
        return self.current_tokens / self.model_window >= REBUILD_THRESHOLD

    async def has_checkpoint(self) -> bool:
        """检查会话是否有可用的 checkpoint（对齐 MiMo-Code ``hasCheckpoint``）。

        overflow 时，有 checkpoint 走 rebuild（lossless），无 checkpoint 走
        compaction（lossy）。若无 checkpoint 却走 rebuild，rebuild_context
        只能返回 recent messages（无结构化种子），前文摘要全部丢失——
        这比 compaction 的 LLM 摘要更差。

        rebuild marker（``_rebuild=True``）保留了种子 checkpoint 的 11 字段，
        仍可作为有效种子，因此返回 True。只有完全无 checkpoint 或空 rebuild
        marker（11 字段全空）才返回 False。
        """
        _, data = await self._load_latest_checkpoint()
        if not data:
            return False
        return any(data.get(f) for f in CHECKPOINT_FIELDS)

    async def wait_for_writer(self) -> None:
        """等待所有在途 Writer 任务完成（对齐 MiMo-Code ``waitForWriter``）。

        MiMo-Code 在 overflow 时先检查 ``hasCheckpoint``，有 checkpoint 则
        ``waitForWriter`` 确保 latest checkpoint 已写入，再 ``insertRebuildBoundary``。

        我们的 compaction 是**破坏性**的（LLM 摘要替换 messages），而
        MiMo-Code 的 ``compaction.create`` 只插入边界标记（不删消息）。因此
        我们必须在 ``has_checkpoint`` **之前**等待在途 Writer，确保第一个
        checkpoint 已写入 DB。否则：Writer 正在写 cycle 0 → ``has_checkpoint``
        返回 False → 走 compaction → needle 消息被摘要替换 → 后续 checkpoint
        基于 compacted 消息（无 needle）→ rebuild 加载最新 checkpoint（无 needle）
        → needle 永久丢失。

        ``rebuild_context`` 内部也会调用等待，但此处提前到 ``has_checkpoint``
        之前是为了避免误判"无 checkpoint"而走破坏性 compaction。
        """
        if self._pending_tasks:
            logger.info(
                "等待 %d 个在途 Writer 完成 session=%s",
                len(self._pending_tasks),
                self.session_id,
            )
            await asyncio.gather(*self._pending_tasks, return_exceptions=True)
            self._pending_tasks.clear()

    async def flush_checkpoints(self, messages: list[dict[str, Any]]) -> bool:
        """Writer 完成后补 fire 被跳过的 checkpoint 阈值。

        对齐 MiMo-Code ``fireCheckpoints`` 在 runLoop 每次迭代调用的设计。
        MiMo-Code 的 Writer 跑在独立 fork 子会话，主 runLoop 每次迭代都会
        调用 ``fireCheckpoints``，Writer 完成后自然在下一次迭代中补 fire
        被跳过的阈值。

        我们的 Writer 与主 Agent 共用 ``LLMClient``（Semaphore(1)），且
        ``maybe_checkpoint`` 仅在 ``_apply_context_management`` 中调用一次。
        若 Writer 运行期间 45%/70% 阈值被 ``_writer_running`` 守卫跳过，
        ``wait_for_writer`` 完成后不重新检查，阈值就永久丢失——rebuild
        会重置所有阈值，取餐码等关键信息从未被任何 checkpoint 捕获。

        本方法在 ``wait_for_writer`` 之后调用，用最新 messages 重新检查
        阈值。若 45%/70% 未触发且 token 比例已超过，则补发 Writer。
        ``rebuild_context`` 内部的 ``await asyncio.gather(*_pending_tasks)``
        会等待补发的 Writer 完成，确保 rebuild 加载到含最新信息的 checkpoint。

        Args:
            messages: 当前对话全量消息（与 ``maybe_checkpoint`` 相同）。

        Returns:
            是否触发了新的 checkpoint。
        """
        if self._writer_running:
            return False
        return await self.maybe_checkpoint(messages)

    # ==================================================================
    # SubTask 10.3 集成：并发派发 Writer
    # ==================================================================

    async def _dispatch_writer(self, messages: list[dict[str, Any]]) -> None:
        """派发 Writer Subagent 并发执行（不阻塞主 Agent）。

        参考 MiMo-Code 的 delta-only Writer：只把 **从上一次 checkpoint 到当前
        boundary** 之间的消息（head）交给 Writer；boundary 之后的消息作为 tail
        保留在主 Agent 上下文中，确保现场连续性。

        - 计算 tail 边界，head 进入 Writer；
        - 深拷贝 head 快照，避免主 Agent 后续修改影响 Writer；
        - 读取便签本（清空由 Writer 在落盘后负责）；
        - ``asyncio.create_task`` 启动，保存引用防 GC，完成后自动从集合移除。

        KWA 适配：步影原版读取 ``notes`` 便签本（KWA 无此模块），此处固定为空串。
        """
        # 1. 取 delta：自上次 checkpoint 之后的消息
        delta = messages[self.last_checkpoint_idx :]
        if not delta:
            return

        # 1b. 始终将 rebuild 后的 system 摘要（messages[0]）包含在 delta 中。
        #     rebuild 后 messages[0] 是 Checkpoint 状态快照（含 key_info 等
        #     结构化字段），后续 checkpoint 的 delta 若不含它，Writer 无法看到
        #     上一轮 checkpoint 保留的关键信息（如取餐码/ID/验证码），导致信息
        #     在第二次 rebuild 后永久丢失。对齐 MiMo-Code fork 子会话继承完整
        #     上下文的设计。
        if (
            self.last_checkpoint_idx > 0
            and messages
            and messages[0].get("role") == "system"
            and delta[0] is not messages[0]
        ):
            delta = [messages[0]] + delta

        # 1a. Writer 并发守卫：若上一个 Writer 仍在运行，跳过本次（MiMo-Code
        #     isWriterRunning 等价物）。避免两个 Writer 竞态写入同一 cycle_index
        #     或覆盖彼此的 checkpoint.md。
        if self._writer_running:
            logger.info(
                "Writer 仍在运行，跳过本次 checkpoint session=%s", self.session_id
            )
            return

        # 2. 计算边界：boundary 之前交给 Writer，boundary 之后保留为 tail
        boundary_rel = self.compute_boundary(delta)
        boundary_abs = self.last_checkpoint_idx + boundary_rel

        # 至少保留一条消息作为 tail，避免 Writer 收到空输入或全量输入
        if boundary_rel <= 0:
            boundary_rel = self.compute_boundary(delta, tail_min_tokens=0, tail_min_text=1)
            boundary_abs = self.last_checkpoint_idx + boundary_rel
        if boundary_rel <= 0 or boundary_rel >= len(delta):
            logger.info(
                "Writer delta 无需切分 session=%s delta_msgs=%d",
                self.session_id,
                len(delta),
            )
            head = delta
            boundary_abs = len(messages)
        else:
            head = delta[:boundary_rel]

        # 3. 更新 checkpoint 进度；tail 留在当前 messages 中继续参与后续对话
        self.last_checkpoint_idx = boundary_abs

        # 4. 并发派发 Writer（仅处理 head）
        #    Writer 预算按窗口缩放：8192 窗口 → 4096；128K 窗口 → 6000（上限）
        #    MiMo-Code 的 Writer 跑在独立 fork 子会话有完整窗口，我们复用同一
        #    LLMClient，必须为 system prompt + 输出预留空间，否则溢出致 JSON 截断。
        snapshot = copy.deepcopy(head)
        # KWA 适配：步影原版 ``notes = await notes_store.read_notes(self.session_id)``，
        # KWA 无 notes 模块，固定为空串。Writer 仍能基于 delta 生成 checkpoint。
        notes = ""
        writer_budget = min(
            WRITER_INPUT_BUDGET_TOKENS,
            int(self.model_window * WRITER_BUDGET_WINDOW_RATIO),
        )
        self._writer_running = True

        async def _run_writer() -> dict[str, Any]:
            try:
                return await self._writer.write_checkpoint(
                    self.session_id,
                    snapshot,
                    notes,
                    input_budget_tokens=writer_budget,
                )
            finally:
                self._writer_running = False

        task = asyncio.create_task(_run_writer())
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)
        logger.info(
            "派发 Writer session=%s head_msgs=%d tail_msgs=%d last_checkpoint_idx=%d",
            self.session_id,
            len(head),
            len(messages) - boundary_abs,
            self.last_checkpoint_idx,
        )
        # 不 await：主 Agent 立即继续

    # ==================================================================
    # SubTask 10.5：预算化注入与重要性排序
    # ==================================================================

    async def budget_inject(
        self,
        items: list[tuple[str, int, float]],
        budget: int,
    ) -> list[str]:
        """按重要性降序贪心填充，直到预算耗尽。

        Args:
            items: ``[(content, token_count, importance_score), ...]``。
            budget: token 预算上限。

        Returns:
            注入的内容列表（按重要性优先；同分时优先放入 token 数小的，以塞入更多项）。
        """
        # 重要性降序，token 数升序（同分小者优先，利于塞入更多项）
        ordered = sorted(items, key=lambda it: (-it[2], it[1]))
        injected: list[str] = []
        remaining = budget
        for content, tokens, _imp in ordered:
            if tokens <= remaining:
                injected.append(content)
                remaining -= tokens
        return injected

    # ==================================================================
    # SubTask 10.4：上下文重建
    # ==================================================================

    async def rebuild_context(self) -> list[dict[str, Any]]:
        """重建上下文：切断旧窗口，用持久化种子拼装新 messages。

        流程：
          1. 加载最新 checkpoint（DB）；
          2. 加载 project memory（``data/MEMORY.md`` + ``data/sessions/{sid}/MEMORY.md``）；
          3. 加载 task progress（``data/sessions/{sid}/progress.md``）；
          4. 加载最近最多 ``REBUILD_LOAD_RECENT_MAX`` 条消息，再按 token 预算筛选；
          5. 按 ``_BUDGET_RATIOS`` 分配各类预算，budget_inject 贪心填充；
          6. 拼装为 system 摘要 + 近期消息的新 messages 数组；
          7. ``cycle_index`` 自增并记录 rebuild 边界到 Checkpoint 表；
          8. 重置 ``triggered_checkpoints`` 与 ``last_checkpoint_idx``（新 cycle 可再次触发 20/45/70%）。

        **重要契约**：调用方必须用返回值**替换**而非追加到原 messages 列表
        （``messages = await cm.rebuild_context()``）。MiMo-Code 通过
        ``filterCompacted`` 边界标记自动切片来做安全网；我们依赖调用方遵守
        replace 契约。若调用方追加，``current_tokens`` 不会下降，触发死循环。

        Returns:
            重建后的 messages 数组（调用方必须用它替换原列表）。
        """
        pre_rebuild_tokens = self.current_tokens
        # 0. 等待所有在途 Writer 任务完成，确保加载最新 checkpoint
        #    （MiMo-Code 的 rebuild 前调用 waitForWriter；否则可能加载到上一轮
        #    旧 checkpoint，丢失本轮 70% checkpoint 刚提取的结构化状态）
        if self._pending_tasks:
            logger.info(
                "rebuild 前等待 %d 个在途 Writer 任务 session=%s",
                len(self._pending_tasks),
                self.session_id,
            )
            await asyncio.gather(*self._pending_tasks, return_exceptions=True)
            self._pending_tasks.clear()
        # 1. 最新 checkpoint
        ck_text, ck_data = await self._load_latest_checkpoint()

        # 2. project memory
        memory_text = await self._load_memory()

        # 3. task progress
        progress_text = await self._load_progress()

        # 4. 最近保留消息：先多取一些，再按 token 预算筛选（MiMo-Code 的 tail 思想）
        recent = await self._load_recent_messages(REBUILD_LOAD_RECENT_MAX)

        # 5. 分类预算：先按比例截断各类内容，再用 budget_inject 按重要性排序注入。
        #    预算按 model_window 缩放（MiMo-Code 用固定 caps 针对大窗口；8K 窗口需缩放）。
        rebuild_budget = int(self.model_window * REBUILD_BUDGET_RATIO)
        ck_budget = int(rebuild_budget * _BUDGET_RATIOS["checkpoint"])
        mem_budget = int(rebuild_budget * _BUDGET_RATIOS["memory"])
        task_budget = int(rebuild_budget * _BUDGET_RATIOS["task"])
        recent_budget = int(rebuild_budget * _BUDGET_RATIOS["recent"])

        # 截断（避免单类内容挤爆预算），保留头部信息
        ck_text = _truncate_to_tokens(ck_text, ck_budget)
        memory_text = _truncate_to_tokens(memory_text, mem_budget)
        progress_text = _truncate_to_tokens(progress_text, task_budget)

        # 结构化三类按重要性（checkpoint 1.0 > memory 0.8 > task 0.6）贪心注入；
        # 因各自已截断至其配额且配额之和 = struct_budget，通常全部入选，体现重要性排序
        struct_items: list[tuple[str, int, float]] = []
        if ck_text:
            struct_items.append((ck_text, _estimate_text_tokens(ck_text), 1.0))
        if memory_text:
            struct_items.append((memory_text, _estimate_text_tokens(memory_text), 0.8))
        if progress_text:
            struct_items.append((progress_text, _estimate_text_tokens(progress_text), 0.6))
        struct_budget = ck_budget + mem_budget + task_budget
        struct_injected = await self.budget_inject(struct_items, struct_budget)
        struct_used = sum(_estimate_text_tokens(s) for s in struct_injected)

        # recent：按"最近优先"分配预算，并可吃掉结构化类未用完的余量以提升利用率。
        # 超长单条消息截断到剩余预算（而非整条跳过），确保最近现场不被完全丢失。
        recent_avail = max(recent_budget, rebuild_budget - struct_used)
        recent_msgs: list[dict[str, Any]] = []
        remaining = recent_avail
        for m in reversed(recent):  # 最近优先
            content = m.get("content", "")
            t = _estimate_text_tokens(_message_content_text(content))
            if t <= remaining:
                recent_msgs.append({"role": m.get("role", "user"), "content": content})
                remaining -= t
            elif remaining > 100:
                # 超长消息截断到剩余预算，保留部分现场而非整条跳过
                truncated = _truncate_to_tokens(content, remaining)
                recent_msgs.append({"role": m.get("role", "user"), "content": truncated})
                remaining = 0
                break
            else:
                break
        recent_msgs.reverse()  # 恢复时间正序

        # 6. 拼装：结构化类按 budget_inject 产出的重要性顺序追加为 system 消息
        out: list[dict[str, Any]] = []
        for injected_text, label in (
            (ck_text, "## Checkpoint 状态快照（由 Writer Subagent 生成）"),
            (memory_text, "## Project Memory（MEMORY.md）"),
            (progress_text, "## Task Progress"),
        ):
            if injected_text and injected_text in struct_injected:
                out.append({"role": "system", "content": f"{label}\n{injected_text}"})
        out.extend(recent_msgs)

        # 7. 记录 rebuild 边界（cycle 链）
        await self._record_rebuild_checkpoint(ck_data)

        # 8. 重置阈值与 checkpoint 进度，重算 token
        self.triggered_checkpoints.clear()
        self.last_checkpoint_idx = 0
        await self.estimate_tokens(out)
        # 死循环检测：rebuild 后 token 应显著低于 rebuild 前。若未下降，说明
        # 调用方很可能未用返回值替换 messages（追加而非替换），或种子过大。
        # MiMo-Code 的 filterCompacted 边界标记可自动兜底；此处仅告警，不阻断。
        if pre_rebuild_tokens > 0 and self.current_tokens >= pre_rebuild_tokens:
            logger.warning(
                "rebuild 未减少 token session=%s pre=%d post=%d — "
                "调用方是否未用返回值替换 messages？将触发死循环",
                self.session_id,
                pre_rebuild_tokens,
                self.current_tokens,
            )
        logger.info(
            "rebuild 完成 session=%s pre_tokens=%d post_tokens=%d 注入消息数=%d",
            self.session_id,
            pre_rebuild_tokens,
            self.current_tokens,
            len(out),
        )
        return out

    # ==================================================================
    # SubTask 10.7 集成：compaction
    # ==================================================================

    async def maybe_compact(
        self, messages: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """接近上限时压缩：旧消息 -> 摘要 + 最近消息。

        触发条件：``current_tokens / model_window >= COMPACT_THRESHOLD``。
        压缩后重算 ``current_tokens``，便于后续 ``maybe_rebuild`` 判断。
        """
        if self.model_window <= 0:
            return messages
        ratio = self.current_tokens / self.model_window
        if ratio < COMPACT_THRESHOLD:
            return messages
        compacted = await self._compactor.compact(messages, self.llm_client)
        await self.estimate_tokens(compacted)
        logger.info(
            "compaction 完成 session=%s 压缩后 tokens=%d",
            self.session_id,
            self.current_tokens,
        )
        return compacted

    def prune(self, messages: list[dict[str, Any]], keep_recent: int = 4) -> list[dict[str, Any]]:
        """裁剪旧工具输出（实例方法，便于链式调用）。"""
        return prune_tool_outputs(messages, keep_recent)

    # ==================================================================
    # SubTask 10.6：便签本 notes.md（KWA 适配：no-op）
    # ==================================================================

    async def append_note(self, note: str) -> None:
        """向便签本追加一行（主 Agent 随手记录零散发现）。

        KWA 适配：步影原版调用 ``notes_store.append_note`` 落盘
        ``data/sessions/{sid}/notes.md``；KWA 无 ``notes`` 模块，本方法保留为
        no-op（仅记录 debug 日志），保持 API 兼容但不落盘。如后续需要便签本
        能力，可在此处恢复 ``notes`` 模块的调用。
        """
        logger.debug(
            "append_note no-op (KWA 无 notes 模块) session=%s note_len=%d",
            self.session_id,
            len(note) if note else 0,
        )

    # ==================================================================
    # SubTask 10.8：文件原文替换策略
    # ==================================================================

    async def replace_file_references(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """三轮对话后将文件原文替换为本地路径引用 + 摘要。

        触发条件：文件被引入（user 消息 ``attachments`` 含 ``file_id``）后，对话已累计
        ``ROUNDS_BEFORE_FILE_REPLACE`` 个完整轮次（1 user + 1 assistant = 1 轮）。

        替换策略（**安全替换，保留用户问题**）：
          1. 优先替换消息中可识别的文件原文片段（base64 data URL、``[文件内容开始]...``
             marker 块），将其替换为引用块；用户的问题文本保持不动。
          2. 若消息中未检测到内联原文（当前流水线下常见情形：文件原文未内联进消息，
             仅以 ``attachments`` 元数据存在），则**前置**引用块到用户问题之前，确保
             LLM 仍可定位文件，但绝不覆盖用户问题。

        引用块格式::

            [文件: {original_name}]
            路径: {saved_path}
            摘要: {summary}

        并在 DB 中记录该文件已进入"引用模式"。

        Args:
            session_id: 会话 ID。
            messages: 当前对话消息（每条可含 ``attachments: list[str]``）。

        Returns:
            处理后的消息列表（仅保留 ``role`` / ``content``，便于直接发送给 LLM）。
        """
        # 1. 统计完整轮次与每个文件的引入轮次
        complete_rounds = 0
        file_intro_round: dict[str, int] = {}
        round_no = 0
        for i, m in enumerate(messages):
            role = m.get("role", "")
            if role == "user":
                # 是否构成一个完整轮次（后跟 assistant）
                if i + 1 < len(messages) and messages[i + 1].get("role") == "assistant":
                    round_no += 1
                    complete_rounds = round_no
                    atts = m.get("attachments") or []
                    if isinstance(atts, list):
                        for fid in atts:
                            if fid not in file_intro_round:
                                file_intro_round[fid] = round_no
            # assistant 不单独计轮次

        if not file_intro_round:
            # 无文件引用：返回仅含 role/content 的干净副本
            return [self._clean_msg(m) for m in messages]

        # 2. 找出需替换的文件（引入后已经历 >= ROUNDS_BEFORE_FILE_REPLACE 轮）
        to_replace: dict[str, int] = {}  # file_id -> intro round
        for fid, intro in file_intro_round.items():
            if complete_rounds - intro >= ROUNDS_BEFORE_FILE_REPLACE:
                to_replace[fid] = intro

        # 3. 加载文件元数据 + 记录"已替换"
        references: dict[str, str] = {}  # file_id -> 引用块文本
        if to_replace:
            async with AsyncSessionLocal() as db:
                for fid in to_replace:
                    meta = await db.get(FileMetadata, fid)
                    if meta is None:
                        continue
                    ref = (
                        f"[文件: {meta.original_name}]\n"
                        f"路径: {meta.saved_path}\n"
                        f"摘要: {meta.summary or '(暂无摘要)'}"
                    )
                    references[fid] = ref
                    await self._mark_file_replaced(db, fid)
                await db.commit()

        # 4. 重写消息：仅替换可识别的内联原文；找不到则前置引用块；始终保留用户问题
        out: list[dict[str, Any]] = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            atts = m.get("attachments") or []
            if (
                role == "user"
                and isinstance(atts, list)
                and references
                and isinstance(content, str)
            ):
                # 该消息引用的所有"需替换"文件
                replaced_here = [fid for fid in atts if fid in references]
                if replaced_here:
                    new_content = content
                    for fid in replaced_here:
                        new_content = self._replace_inline_or_prepend(
                            new_content, references[fid]
                        )
                    content = new_content
            out.append({"role": role, "content": content})
        return out

    # ==================================================================
    # 内部：加载各类记忆
    # ==================================================================

    async def _load_latest_checkpoint(self) -> tuple[str, dict[str, Any]]:
        """加载会话最新 checkpoint，返回 (可读文本, 结构化 dict)。无则返回 ("", {})。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Checkpoint)
                .where(Checkpoint.session_id == self.session_id)
                .order_by(desc(Checkpoint.cycle_index), desc(Checkpoint.created_at))
                .limit(1)
            )
            row = result.scalars().first()
        if row is None:
            return "", {}
        try:
            data = json.loads(row.content) if row.content else {}
        except (json.JSONDecodeError, TypeError):
            data = {}
        return self._render_checkpoint_text(data), data

    @staticmethod
    def _render_checkpoint_text(data: dict[str, Any]) -> str:
        """将 11 字段 dict 渲染为可注入的紧凑文本。"""
        if not data:
            return ""
        lines: list[str] = []
        for field in CHECKPOINT_FIELDS:
            value = data.get(field)
            if value is None or value == "" or value == []:
                continue
            if isinstance(value, list):
                rendered = "; ".join(
                    json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else str(v)
                    for v in value
                )
            else:
                rendered = str(value)
            lines.append(f"- {field}: {rendered}")
        return "\n".join(lines)

    async def _load_memory(self) -> str:
        """加载 project memory：``data/MEMORY.md``（项目级）+
        ``data/sessions/{sid}/MEMORY.md``（会话级，覆盖项目级）。"""
        parts: list[str] = []
        project_path = settings.data_dir / "MEMORY.md"
        session_path = settings.data_dir / "sessions" / self.session_id / "MEMORY.md"
        for path in (project_path, session_path):
            text = await self._read_text_file(path)
            if text:
                parts.append(text)
        return "\n\n".join(parts)

    async def _load_progress(self) -> str:
        """加载任务进度 ``data/sessions/{sid}/progress.md``。"""
        return await self._read_text_file(
            settings.data_dir / "sessions" / self.session_id / "progress.md"
        )

    async def _load_recent_messages(self, n: int) -> list[dict[str, Any]]:
        """加载最近 n 条消息（按时间正序返回）。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(MessageRow)
                .where(MessageRow.session_id == self.session_id)
                .order_by(desc(MessageRow.created_at), desc(MessageRow.id))
                .limit(n)
            )
            rows = list(result.scalars().all())
        rows.reverse()  # 由新到旧 -> 由旧到新
        return [{"role": r.role, "content": r.content} for r in rows]

    async def _record_rebuild_checkpoint(
        self, seed_data: dict[str, Any]
    ) -> None:
        """记录 rebuild 边界到 Checkpoint 表（cycle_index 自增）。

        content 在种子 checkpoint 数据基础上加 ``_rebuild=True`` 与 ``rebuilt_at``，
        便于回放 cycle 链时识别"新窗口起点"。
        """
        content = {k: v for k, v in seed_data.items() if k in CHECKPOINT_FIELDS}
        content["_rebuild"] = True
        content["rebuilt_at"] = datetime.now(UTC).isoformat()
        content_json = json.dumps(content, ensure_ascii=False)
        # 复用 WriterAgent 的 cycle 推算以保持一致
        cycle_index = await self._writer._next_cycle_index(self.session_id)
        async with AsyncSessionLocal() as db:
            db.add(
                Checkpoint(
                    id=uuid.uuid4().hex,
                    session_id=self.session_id,
                    content=content_json,
                    cycle_index=cycle_index,
                    created_at=datetime.now(UTC),
                )
            )
            await db.commit()

    # ==================================================================
    # 内部：文件替换状态记录
    # ==================================================================

    async def _mark_file_replaced(self, db, file_id: str) -> None:
        """在 Setting 表记录文件已进入"引用模式"（key: ``file_replaced.{file_id}``）。

        复用 settings 表避免给 FileMetadata 增列；幂等写入。
        """
        from app.services.settings_store import set_setting

        await set_setting(db, f"file_replaced.{file_id}", True)

    # ==================================================================
    # 内部：文件读取
    # ==================================================================

    @staticmethod
    async def _read_text_file(path: Path) -> str:
        """异步读取文本文件；不存在返回空串。"""
        if not path.exists():
            return ""
        try:
            return await asyncio.to_thread(path.read_text, "utf-8")
        except OSError as exc:
            logger.warning("读取文件失败 %s: %s", path, exc)
            return ""

    @staticmethod
    def _clean_msg(m: dict[str, Any]) -> dict[str, Any]:
        """提取仅含 role/content 的干净消息（剥离 attachments 等非 OpenAI 字段）。"""
        return {"role": m.get("role", "user"), "content": m.get("content", "")}

    @staticmethod
    def _replace_inline_or_prepend(content: str, ref_block: str) -> str:
        """将消息中可识别的文件原文片段替换为引用块；找不到则前置引用块。

        **始终保留用户问题文本**，绝不整体覆盖：

        - 优先用 ``ref_block`` 替换消息内可识别的内联原文（base64 data URL、
          ``[文件内容开始]...[文件内容结束]`` marker 块）；
        - 若未检测到内联原文（当前流水线下常见情形：文件原文未内联进消息，
          仅以 ``attachments`` 元数据存在），则把 ``ref_block`` 前置到用户问题之前，
          便于 LLM 仍能定位文件。

        Args:
            content: 用户消息原文。
            ref_block: 形如 ``[文件: name]\\n路径: ...\\n摘要: ...`` 的引用块。

        Returns:
            处理后的内容（含引用块）。
        """
        if not content:
            return ref_block
        replaced = _FILE_MARKER_BLOCK_RE.sub(ref_block, content)
        replaced = _BASE64_DATA_URL_RE.sub(ref_block, replaced)
        if replaced != content:
            # 检测到并替换了内联原文：直接返回（用户问题文本未被触碰）
            return replaced
        # 未检测到内联原文：前置引用块，保留用户问题
        return f"{ref_block}\n\n{content}"

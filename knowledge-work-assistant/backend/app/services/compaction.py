"""上下文压缩（Compaction）服务。

在 Checkpoint / Rebuild 之外的兜底层机制：

- **自动压缩**：上下文接近窗口上限时，由隐藏的 ``Compactor`` 将旧消息压缩为摘要，
  保留最近若干条原消息，从而在低信息损失下释放 token。
- **手动触发**：``/compact``（别名 ``/summarize``）。
- **Prune 模式**：删除旧的工具调用结果（``tool_result`` / ``tool`` 角色），保留最近若干个，
  避免长日志/大文件输出挤占窗口。

与 Checkpoint/Rebuild 的关系：Compaction 是简单摘要压缩（远处信息会有损失），
Checkpoint/Rebuild 是结构化持久化（不丢关键信息）。两者互补。

本模块从步影 backend/app/services/compaction.py 适配拷贝而来，KWA 的
``LLMClient`` / ``LLMError`` 与步影接口一致，无需修改。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.services.llm_client import LLMClient
from app.services.llm_errors import LLMError

logger = logging.getLogger(__name__)

# 压缩时保留的最近原消息条数（与 MiMo-Code 默认一致）
DEFAULT_KEEP_RECENT = 6
# Prune 时保留的最近工具输出条数
DEFAULT_KEEP_TOOL_RECENT = 4
# token 估算系数（与 context_manager 保持一致：字符数 / 1.5，适配 qwen 中文 tokenizer）
_CHARS_PER_TOKEN = 1.5
# 默认压缩输入 token 预算（预留 system prompt + 输出空间，按 8192 窗口估算）
DEFAULT_SUMMARY_BUDGET_TOKENS = 4000

_COMPACT_SYSTEM_PROMPT = (
    "你是一个上下文压缩器（Compaction Agent）。请将给定的对话历史压缩为一份精炼摘要，"
    "保留：关键决策、已确认的事实、未完成的待办、重要约束与错误修复。"
    "丢弃寒暄、重复内容与已无意义的中间过程。直接输出 Markdown 摘要正文，"
    "不要任何前后缀说明。"
)


def _is_tool_message(message: dict[str, Any]) -> bool:
    """判断一条消息是否为工具调用**结果**（应被 prune 裁剪）。

    仅匹配承载工具输出的消息：
    - ``role`` 为 ``tool`` / ``function``（OpenAI / 旧式 function calling 结果）；
    - ``content`` 为结构化列表且含 ``type=tool_result`` 片段（多模态结果）。

    注意：assistant 发起工具调用的消息（``tool_calls`` 字段 / ``tool_use`` 片段）
    **不**在此列，因其体积小且承载推理，予以保留。当其对应的工具结果被裁剪后，
    调用方应负责配对裁剪（当前 pipeline 尚未持久化 tool 角色消息，暂不涉及）。
    """
    role = message.get("role", "")
    if role in ("tool", "function"):
        return True
    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "tool_result":
                return True
    return False


def prune_tool_outputs(
    messages: list[dict[str, Any]],
    keep_recent: int = DEFAULT_KEEP_TOOL_RECENT,
) -> list[dict[str, Any]]:
    """裁剪旧的工具调用结果，仅保留最近 ``keep_recent`` 个。

    非工具消息不受影响；工具消息（``role=tool/function``、含 ``tool_calls``、
    或 content 中含 ``tool_result``/``tool_use`` 的）按出现顺序从新到旧保留
    ``keep_recent`` 个，更早的整条删除（不保留占位，因 OpenAI 要求 tool 消息
    与 tool_call 一一对应，调用方应在压缩后重建对应关系）。

    Args:
        messages: 原始消息列表（不修改，返回新列表）。
        keep_recent: 保留的最近工具消息数。

    Returns:
        裁剪后的新消息列表。
    """
    if not messages:
        return list(messages)
    # 找出所有工具消息的索引（从旧到新）
    tool_indices = [i for i, m in enumerate(messages) if _is_tool_message(m)]
    if len(tool_indices) <= keep_recent:
        return list(messages)
    # 需要删除的索引：除最后 keep_recent 个之外的工具消息
    to_delete = set(tool_indices[: len(tool_indices) - keep_recent])
    return [m for i, m in enumerate(messages) if i not in to_delete]


def _estimate_tokens(text: str) -> int:
    """字符数 / _CHARS_PER_TOKEN 的粗略 token 估算。"""
    if not text:
        return 0
    return max(1, int(len(text) // _CHARS_PER_TOKEN))


def _truncate_verbatim(text: str, cap_tokens: int) -> str:
    """对超长单条消息做头尾保留（参考 MiMo-Code truncateVerbatimUserMsg）。"""
    if _estimate_tokens(text) <= cap_tokens:
        return text
    cap_chars = int(cap_tokens * _CHARS_PER_TOKEN)
    head_chars = max(0, int(cap_chars * 0.6))
    tail_chars = max(0, int(cap_chars * 0.3))
    head = text[:head_chars]
    tail = text[-tail_chars:] if tail_chars else ""
    elided = _estimate_tokens(text) - _estimate_tokens(head) - _estimate_tokens(tail)
    return f"{head}\n[…elided ~{elided} tokens…]\n{tail}"


def _render_messages_for_summary(
    messages: list[dict[str, Any]],
    budget_tokens: int = DEFAULT_SUMMARY_BUDGET_TOKENS,
) -> str:
    """将消息渲染为 LLM 可读的对话文本（用于压缩 prompt）。

    受 token 预算控制，超出时保留开头 2 条（常含初始请求/关键约束）和最近若干条，
    中间消息按整条丢弃，避免破坏单条消息完整性；单条超长消息使用头尾保留。
    """
    per_msg_cap = (int(budget_tokens * _CHARS_PER_TOKEN) // max(1, len(messages))) if messages else 0
    per_msg_cap = max(per_msg_cap, 600)  # 最低约 400 tokens（/1.5）

    lines: list[str] = []
    for i, m in enumerate(messages, 1):
        role = m.get("role", "unknown")
        content = m.get("content", "")
        if not isinstance(content, str):
            try:
                content = json.dumps(content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = str(content)
        # 单条超长做头尾保留
        if _estimate_tokens(content) > per_msg_cap:
            content = _truncate_verbatim(content, per_msg_cap)
        lines.append(f"[{i}] {role}: {content}")

    # 总 token 截断：保留开头 2 条 + 最近若干条
    head_keep = 2
    head = lines[:head_keep]
    tail = lines[head_keep:]
    head_tokens = sum(_estimate_tokens(line) for line in head)
    budget_remaining = max(0, budget_tokens - head_tokens)

    kept_tail: list[str] = []
    tail_tokens = 0
    for line in reversed(tail):
        t = _estimate_tokens(line)
        if tail_tokens + t <= budget_remaining and len(kept_tail) < len(tail):
            kept_tail.append(line)
            tail_tokens += t
        else:
            break
    kept_tail.reverse()

    if len(kept_tail) < len(tail):
        omitted = len(tail) - len(kept_tail)
        kept_tail.insert(
            0,
            f"[…{omitted} 条中间消息因 token 预算被省略…]",
        )

    return "\n".join(head + kept_tail)


class Compactor:
    """上下文压缩器：将旧消息压缩为摘要 + 保留最近消息。

    Args:
        keep_recent: 压缩时保留的最近原消息条数。
    """

    def __init__(self, keep_recent: int = DEFAULT_KEEP_RECENT) -> None:
        self.keep_recent = keep_recent

    async def compact(
        self,
        messages: list[dict[str, Any]],
        llm_client: LLMClient,
    ) -> list[dict[str, Any]]:
        """将旧消息压缩为一条摘要，拼接最近消息后返回。

        流程：
          1. 若消息数 <= ``keep_recent``，无需压缩，原样返回副本；
          2. 否则把前段（除最近 ``keep_recent`` 条）渲染为文本，交 LLM 压缩为摘要；
          3. 以 ``system`` 角色封装摘要，拼接最近 ``keep_recent`` 条原消息返回；
          4. LLM 调用失败时回退为"前段整体丢弃 + 保留最近消息"，保证不阻塞主流程。

        Args:
            messages: 原始消息列表。
            llm_client: 用于压缩的 LLM 客户端。

        Returns:
            压缩后的新消息列表 ``[summary_system_msg, *recent]``。
        """
        if len(messages) <= self.keep_recent:
            return list(messages)

        old_messages = messages[: len(messages) - self.keep_recent]
        recent_messages = messages[len(messages) - self.keep_recent :]

        summary = await self._summarize(old_messages, llm_client)
        summary_msg: dict[str, Any] = {
            "role": "system",
            "content": (
                "以下是此前对话的压缩摘要，供你恢复上下文：\n\n" + summary
            ),
        }
        return [summary_msg, *recent_messages]

    async def _summarize(
        self,
        old_messages: list[dict[str, Any]],
        llm_client: LLMClient,
    ) -> str:
        """调用 LLM 将旧消息压缩为摘要文本。"""
        transcript = _render_messages_for_summary(old_messages)
        logger.info("Compaction 输入消息数=%d 渲染长度=%d", len(old_messages), len(transcript))
        llm_messages: list[dict[str, Any]] = [
            {"role": "system", "content": _COMPACT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "请将以下对话历史压缩为一份精炼摘要：\n\n" + transcript
                ),
            },
        ]
        try:
            response = await llm_client.chat(llm_messages, temperature=0.3)
            summary = response.get("content", "") or ""
        except LLMError as exc:
            logger.warning("Compaction LLM 调用失败，回退为简短摘要: %s", exc)
            summary = ""
        except Exception as exc:  # noqa: BLE001
            logger.warning("Compaction LLM 调用异常，回退为简短摘要: %s", exc)
            summary = ""

        if not summary:
            # 兜底：用每条消息首行拼一个极简摘要，避免完全丢失前文
            summary = "（压缩失败，前文摘要不可用）涉及消息：\n" + "\n".join(
                f"- [{m.get('role', '?')}] "
                + str(m.get("content", ""))[:80]
                for m in old_messages
            )
        return summary

    def prune(
        self,
        messages: list[dict[str, Any]],
        keep_recent: int = DEFAULT_KEEP_TOOL_RECENT,
    ) -> list[dict[str, Any]]:
        """裁剪旧工具输出（实例方法，便于链式调用）。"""
        return prune_tool_outputs(messages, keep_recent)

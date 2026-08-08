"""Writer Subagent：带工具循环的结构化状态记录员（Task 6 完整移植）。

对齐 MiMo-Code 的 checkpoint-writer 子 agent 设计：

- **工具循环**：Writer 拥有 file_read / file_write / file_list 工具，可自主读取
  checkpoint.md 模板、写入更新后的内容，而非单次 LLM 调用输出 JSON。
- **delta as messages**：对话切片（delta）作为真正的 messages 数组传递给 LLM，
  而非序列化为文本。LLM 看到的是 role + content 的真实对话历史。
- **文件解析**：工具循环结束后，从 checkpoint.md 文件读取内容，解析 markdown
  为 11 字段 dict，存入 DB。
- **JSON fallback**：如果文件不存在或解析失败，从 LLM 最终输出解析 JSON。

设计要点（来自 MiMo-Code checkpoint.ts）：
- ``composeWriterPrompt`` 风格的 ABSOLUTE PATHS 前言，防止 LLM 编造路径。
- ``truncateVerbatimUserMsg`` 风格的单条消息头尾保留。
- ``userMsgText`` 风格的 content 压缩（图片/文件 → 占位符）。
- 工具循环最多 ``WRITER_MAX_ITERATIONS`` 轮，防止无限循环。

KWA 适配说明（相对步影原版）：
- **移除 ``notes`` 模块依赖**（SubTask 6.1）：步影原版在 ``write_checkpoint`` 末尾调用
  ``notes_store.clear_notes(session_id)`` 清空便签本；KWA 无 ``notes`` 模块，
  ``context_manager._dispatch_writer`` 已将 ``notes`` 入参固定为空串，此处删除
  ``clear_notes`` 调用（注释保留以示出处）。
- **Checkpoint 表字段对齐**（SubTask 6.2）：KWA ``Checkpoint`` 表含
  ``id`` / ``session_id`` / ``content`` / ``cycle_index`` / ``created_at`` 五个字段，
  与步影原版一致，``_persist`` 方法无需修改。
- **全局单例**（SubTask 6.3）：保留 ``writer_agent`` / ``get_writer_agent()`` /
  ``init_writer_agent()``，对齐 ``main_agent`` / ``graph_agent`` 模式。
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.config import settings
from app.db import AsyncSessionLocal
from app.models.db_models import Checkpoint
from app.services.llm_client import LLMClient
from app.services.llm_errors import LLMError

logger = logging.getLogger(__name__)

# token 估算系数（与 context_manager 保持一致：字符数 / 1.5，适配 qwen 中文 tokenizer）
_CHARS_PER_TOKEN = 1.5
# 内联图片检测：base64 data URL（图片等内联二进制，单张可能数万字符）
_BASE64_DATA_URL_RE = re.compile(
    r"data:[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+"
)
# 文件原文检测：显式 marker 块（由上传/解析流程内联的文本原文）
_FILE_MARKER_BLOCK_RE = re.compile(r"\[文件内容开始\][\s\S]*?\[文件内容结束\]")

# 11 个结构化字段（固定顺序，便于序列化与重建时引用）
# 通用化命名：覆盖编程/办公/生活场景，不偏编程
CHECKPOINT_FIELDS: list[str] = [
    "current_intent",
    "next_action",
    "constraints",
    "artifacts_touched",
    "problems_and_solutions",
    "decisions_made",
    "user_preferences",
    "open_questions",
    "key_info",
    "progress_summary",
    "watchouts",
]

# 标量字段（值为 str），其余为 list
_SCALAR_FIELDS = {"current_intent", "next_action", "progress_summary"}

_PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

# 工具循环最大轮数
WRITER_MAX_ITERATIONS = 5


def _load_system_prompt() -> str:
    """加载 Writer 系统提示词（``prompts/writer_system.md``）。"""
    global _SYSTEM_PROMPT_CACHE
    cached = globals().get("_SYSTEM_PROMPT_CACHE")
    if cached is not None:
        return cached
    path = _PROMPT_DIR / "writer_system.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("读取 Writer 系统提示词失败，使用空 prompt: %s", exc)
        text = ""
    globals()["_SYSTEM_PROMPT_CACHE"] = text
    return text


_SYSTEM_PROMPT_CACHE: str | None = None


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


def _compress_content(content: Any) -> str:
    """压缩消息 content 中的超长二进制/文件原文。

    参考 MiMo-Code ``userMsgText``（只拉 text parts，过滤 tool/file/image 等 parts）。
    """
    if content is None:
        return ""
    if isinstance(content, str):
        def _img_repl(m: re.Match[str]) -> str:
            return f"[图片已省略，原长度 {len(m.group(0))} 字符]"
        compressed = _BASE64_DATA_URL_RE.sub(_img_repl, content)
        compressed = _FILE_MARKER_BLOCK_RE.sub(
            "[文件原文已省略，可通过文件路径引用读取]", compressed
        )
        return compressed
    if isinstance(content, list):
        parts_out: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                parts_out.append(str(part)[:500])
                continue
            ptype = part.get("type", "")
            if ptype == "text":
                parts_out.append(part.get("text", "") or "")
            elif ptype == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                parts_out.append(f"[图片已省略，原长度 {len(url)} 字符]")
            elif ptype == "file":
                parts_out.append("[文件 part 已省略]")
            else:
                try:
                    s = json.dumps(part, ensure_ascii=False)
                except (TypeError, ValueError):
                    s = str(part)
                parts_out.append(s[:500])
        return "\n".join(p for p in parts_out if p)
    try:
        s = json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(content)
    return s[:500]


def _compress_messages(
    messages: list[dict[str, Any]], budget_tokens: int | None = None
) -> list[dict[str, Any]]:
    """压缩 delta messages 数组（不丢弃任何消息，对齐 MiMo-Code delta-as-messages）。

    - 每条消息的 content 经 ``_compress_content`` 压缩（图片/文件 → 占位符）
    - **tool 角色消息**转换为 user 角色（去掉 tool_call_id，避免 OpenAI API 配对报错）
    - **assistant 的 tool_calls**字段去掉（只保留 content 文本）
    - 合并连续同角色消息（Qwen chat template 要求 user/assistant 交替）
    - 总 token 超预算时，前 2 条完整保留，其余按比例分配 per-msg cap（头尾截断）
    - **不丢弃任何消息**（避免 needle 在位置 3 被截断丢失）
    """
    rendered: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "user")
        # tool 消息转为 user（去掉 tool_call_id 避免 API 配对校验失败）
        if role == "tool":
            role = "user"
        # system 消息转为 user：Writer 已有自己的 system prompt 在开头，
        # delta 中的 system（如 rebuild 摘要）若保留会导致 Qwen 模板报错
        # "System message must be at the beginning"
        if role == "system":
            role = "user"
        content = _compress_content(m.get("content", ""))
        # 合并连续同角色消息
        if rendered and rendered[-1]["role"] == role:
            rendered[-1]["content"] += "\n" + content
        else:
            rendered.append({"role": role, "content": content})

    if budget_tokens is None:
        return rendered

    total = sum(_estimate_tokens(m["content"]) for m in rendered)
    if total <= budget_tokens:
        return rendered

    head_keep = 2
    head = rendered[:head_keep]
    tail = rendered[head_keep:]
    head_tokens = sum(_estimate_tokens(m["content"]) for m in head)
    remaining = max(0, budget_tokens - head_tokens)

    result = list(head)
    if tail:
        per_msg_cap = max(266, remaining // len(tail))
        for m in tail:
            if _estimate_tokens(m["content"]) > per_msg_cap:
                m = {**m, "content": _truncate_verbatim(m["content"], per_msg_cap)}
            result.append(m)
    return result


def _parse_checkpoint_markdown(text: str) -> dict[str, Any]:
    """从 checkpoint.md markdown 文本解析为 11 字段 dict。

    按 ``## field_name`` 分割 section，标量字段取纯文本，列表字段取 ``- `` 开头的行。
    """
    data: dict[str, Any] = {}
    # 按 ## 标题分割
    sections = re.split(r"^## ", text, flags=re.MULTILINE)
    for section in sections[1:]:  # 跳过第一部分（# Session checkpoint 标题区）
        lines = section.strip().split("\n")
        if not lines:
            continue
        # 字段名 = 第一行去掉可能的尾部空格
        field_name = lines[0].strip().lower().replace(" ", "_")
        if field_name not in CHECKPOINT_FIELDS:
            continue
        body = "\n".join(lines[1:]).strip()
        if field_name in _SCALAR_FIELDS:
            data[field_name] = body if body else ""
        else:
            # 列表字段：收集 - 开头的行
            items: list[Any] = []
            for line in body.split("\n"):
                line = line.strip()
                if line.startswith("- "):
                    item_text = line[2:].strip()
                    # 尝试解析 problem: ... solution: ... 格式
                    if field_name == "problems_and_solutions" and item_text.startswith("problem:"):
                        sol_match = re.match(
                            r"problem:\s*(.+?)\s*solution:\s*(.+)", item_text, re.DOTALL
                        )
                        if sol_match:
                            items.append({
                                "problem": sol_match.group(1).strip(),
                                "solution": sol_match.group(2).strip(),
                            })
                        else:
                            items.append(item_text)
                    else:
                        items.append(item_text)
            data[field_name] = items
    # 补齐缺失字段
    for f in CHECKPOINT_FIELDS:
        if f not in data:
            data[f] = "" if f in _SCALAR_FIELDS else []
    return data


def _parse_checkpoint_json(raw: str) -> dict[str, Any]:
    """从 LLM 输出中解析 JSON（fallback 用）。"""
    text = raw.strip()
    if text.startswith("```"):
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    try:
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("checkpoint JSON 顶层不是对象")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("checkpoint JSON 解析失败，使用兜底结构: %s", exc)
        data = {}
    for field in CHECKPOINT_FIELDS:
        if field not in data:
            data[field] = [] if field not in _SCALAR_FIELDS else ""
    return data


def _checkpoint_to_markdown(cycle: int, data: dict[str, Any], created_at: str) -> str:
    """将结构化 checkpoint dict 渲染为 Markdown。"""
    lines = [
        "# Session checkpoint",
        "",
        f"> cycle {cycle} · {created_at}",
        "",
        "## current_intent",
        data.get("current_intent") or "(none)",
        "",
        "## next_action",
        data.get("next_action") or "(none)",
        "",
    ]
    for field in CHECKPOINT_FIELDS:
        if field in ("current_intent", "next_action", "progress_summary"):
            continue
        value = data.get(field)
        lines.append(f"## {field}")
        if isinstance(value, list):
            if not value:
                lines.append("(none)")
            else:
                for item in value:
                    if isinstance(item, dict):
                        lines.append(f"- {json.dumps(item, ensure_ascii=False)}")
                    else:
                        lines.append(f"- {item}")
        elif value is None:
            lines.append("(none)")
        else:
            lines.append(str(value))
        lines.append("")
    lines.append("## progress_summary")
    lines.append(data.get("progress_summary") or "(none)")
    return "\n".join(lines)


# ======================================================================
# Writer 工具 schema（file_read / file_write / file_list）
# ======================================================================

def _writer_tool_schemas() -> list[dict[str, Any]]:
    """构造 Writer 可用的工具 schema（对齐 MiMo-Code checkpoint-writer agent 的工具集）。"""
    return [
        {
            "type": "function",
            "function": {
                "name": "file_read",
                "description": "读取指定文件的内容。用于读取 checkpoint.md 等文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "要读取的文件绝对路径",
                        },
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "file_write",
                "description": "向指定文件写入内容（覆盖）。用于写入 checkpoint.md。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "要写入的文件绝对路径",
                        },
                        "content": {
                            "type": "string",
                            "description": "要写入的完整内容",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "file_list",
                "description": "列出指定目录下的文件与子目录。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录路径",
                        },
                    },
                    "required": ["path"],
                },
            },
        },
    ]


async def _execute_writer_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """执行 Writer 工具调用（复用 app.services.tools 的真实 handler）。"""
    from app.services.tools.file_tools import file_list, file_read, file_write

    handlers = {
        "file_read": file_read,
        "file_write": file_write,
        "file_list": file_list,
    }
    handler = handlers.get(name)
    if handler is None:
        return {"status": "error", "message": f"Writer 未知工具: {name}"}
    try:
        return await handler(args)
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "message": str(exc)}


class WriterAgent:
    """Writer Subagent：带工具循环的结构化状态记录员。

    对齐 MiMo-Code checkpoint-writer 子 agent：
    - delta 作为真正的 messages 数组传递（不序列化为文本）
    - 工具循环：LLM 调用 → tool_calls → 执行（file_read/file_write）→ LLM 调用 → finish
    - 从 checkpoint.md 文件解析结构化数据
    - JSON fallback

    Args:
        llm_client: 用于调用 LLM 的客户端。
    """

    def __init__(self, llm_client: LLMClient) -> None:
        self.llm_client = llm_client

    async def write_checkpoint(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
        notes: str,
        input_budget_tokens: int | None = None,
    ) -> dict[str, Any]:
        """生成一个 checkpoint（带工具循环）。

        流程：
          1. 压缩 delta messages（图片/文件 → 占位符，不丢弃整条消息）
          2. 构造 Writer messages：system + delta + 指令 user
          3. 工具循环（最多 ``WRITER_MAX_ITERATIONS`` 轮）
          4. 从 checkpoint.md 文件解析为 11 字段 dict
          5. JSON fallback（文件解析失败时）
          6. 落库 + 落盘

        KWA 适配：步影原版在末尾调用 ``notes_store.clear_notes(session_id)`` 清空
        便签本；KWA 无 ``notes`` 模块，``context_manager._dispatch_writer`` 已将
        ``notes`` 入参固定为空串，此处不再调用 ``clear_notes``。
        """
        # 1. 预计算 cycle_index + checkpoint 路径
        created_at = datetime.now(UTC)
        cycle_index = await self._next_cycle_index(session_id)
        checkpoint_path = self._checkpoint_path(session_id, cycle_index)

        # 2. 压缩 delta messages
        compressed = _compress_messages(messages, input_budget_tokens)
        total_tokens = sum(_estimate_tokens(m["content"]) for m in compressed)
        logger.info(
            "Writer 输入消息数=%d 压缩后tokens=%d budget=%s",
            len(compressed),
            total_tokens,
            input_budget_tokens,
        )

        # 3. 构造 Writer messages
        system_prompt = _load_system_prompt()
        notes_block = notes.strip() if notes and notes.strip() else "(空)"
        instruction = (
            f"CHECKPOINT_PATH = {checkpoint_path}\n\n"
            f"便签本 notes.md：\n{notes_block}\n\n"
            "请先用 file_read 读取 CHECKPOINT_PATH（若不存在则从模板创建），"
            "然后根据以上对话历史用 file_write 更新 checkpoint.md。\n"
            "完成后回复 done。"
        )
        writer_messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            *compressed,
            {"role": "user", "content": instruction},
        ]

        # 4. 工具循环
        tools = _writer_tool_schemas()
        final_content = ""
        wrote_file = False
        for iteration in range(WRITER_MAX_ITERATIONS):
            try:
                response = await self.llm_client.chat(
                    writer_messages, tools=tools, temperature=0.2
                )
            except LLMError as exc:
                logger.warning("Writer LLM 调用失败 iteration=%d: %s", iteration, exc)
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning("Writer LLM 调用异常 iteration=%d: %s", iteration, exc)
                break

            final_content = response.get("content", "") or ""
            tool_calls = response.get("tool_calls", [])

            if not tool_calls:
                if not wrote_file and iteration < WRITER_MAX_ITERATIONS - 1:
                    logger.info(
                        "Writer 未调用 file_write，强制要求 iteration=%d", iteration
                    )
                    writer_messages.append({
                        "role": "user",
                        "content": (
                            "你还没有用 file_write 写入 checkpoint.md。"
                            "请立即用 file_write 将 checkpoint 内容写入 CHECKPOINT_PATH，"
                            "然后回复 done。"
                        ),
                    })
                    continue
                logger.info("Writer 工具循环结束 iteration=%d (无更多工具调用)", iteration)
                break

            # 回填 assistant tool_calls 消息
            writer_messages.append({
                "role": "assistant",
                "content": final_content,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": tc["arguments"],
                        },
                    }
                    for tc in tool_calls
                ],
            })

            # 逐个执行工具并回填结果
            for tc in tool_calls:
                tool_name = tc.get("name", "")
                raw_args = tc.get("arguments", "")
                try:
                    args = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError:
                    args = {}

                if tool_name == "file_write":
                    wrote_file = True

                logger.info(
                    "Writer 工具调用 iteration=%d tool=%s args=%s",
                    iteration,
                    tool_name,
                    str(args)[:200],
                )
                result = await _execute_writer_tool(tool_name, args)
                writer_messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(result, ensure_ascii=False)[:2000],
                })
        else:
            logger.warning("Writer 达到最大迭代次数 %d", WRITER_MAX_ITERATIONS)

        # 5. 从 checkpoint.md 文件解析
        data = await self._try_parse_checkpoint_file(checkpoint_path)

        # 6. JSON fallback
        if not data or not any(data.get(f) for f in CHECKPOINT_FIELDS):
            logger.info("checkpoint.md 解析为空，尝试从 LLM 最终输出解析 JSON")
            data = _parse_checkpoint_json(final_content)

        # 6a. LLM 失败 + 文件不存在 → data 全空。不落库，避免空 checkpoint
        #     覆盖上一个有效 checkpoint（rebuild 会加载最新 checkpoint，
        #     空 checkpoint 会导致取餐码等关键信息永久丢失）。
        if not any(data.get(f) for f in CHECKPOINT_FIELDS):
            logger.warning(
                "Writer 未能生成有效 checkpoint，跳过落库 session=%s cycle=%d",
                session_id,
                cycle_index,
            )
            return {
                "status": "skipped",
                "cycle_index": cycle_index,
                "reason": "llm_failed_empty_checkpoint",
            }

        # 7. 落库 + 落盘
        data["cycle_index"] = cycle_index
        data["created_at"] = created_at.isoformat()
        await self._persist(session_id, data, cycle_index, created_at)

        # 8. 清空便签本（KWA 适配：步影原版 ``await notes_store.clear_notes(session_id)``，
        #    KWA 无 notes 模块，且 context_manager 已将 notes 固定为空串，此处 no-op）

        logger.info(
            "Writer checkpoint 完成 session=%s cycle=%d",
            session_id,
            cycle_index,
        )
        return data

    async def _try_parse_checkpoint_file(self, path: Path) -> dict[str, Any]:
        """尝试从 checkpoint.md 文件读取并解析。失败时返回空 dict。"""
        try:
            if not path.exists():
                return {}
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                return {}
            data = _parse_checkpoint_markdown(text)
            if any(data.get(f) for f in CHECKPOINT_FIELDS):
                return data
        except Exception as exc:  # noqa: BLE001
            logger.warning("checkpoint.md 解析失败: %s", exc)
        return {}

    async def _next_cycle_index(self, session_id: str) -> int:
        """查询该会话已有 checkpoint 的最大 cycle_index，返回 +1（首个为 0）。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(func.max(Checkpoint.cycle_index)).where(
                    Checkpoint.session_id == session_id
                )
            )
            current = result.scalar()
            return int(current) + 1 if current is not None else 0

    async def _persist(
        self,
        session_id: str,
        data: dict[str, Any],
        cycle_index: int,
        created_at: datetime,
    ) -> None:
        """写入 ``checkpoints`` 表与磁盘 ``checkpoint_{cycle}.md``。"""
        content_json = json.dumps(
            {k: v for k, v in data.items() if k in CHECKPOINT_FIELDS},
            ensure_ascii=False,
        )
        async with AsyncSessionLocal() as db:
            db.add(
                Checkpoint(
                    id=uuid.uuid4().hex,
                    session_id=session_id,
                    content=content_json,
                    cycle_index=cycle_index,
                    created_at=created_at,
                )
            )
            await db.commit()

        # 落盘 Markdown（若 Writer 已通过 file_write 写入则跳过）
        try:
            path = self._checkpoint_path(session_id, cycle_index)
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                md = _checkpoint_to_markdown(cycle_index, data, data["created_at"])
                path.write_text(md, encoding="utf-8")
        except OSError as exc:
            logger.warning(
                "checkpoint 落盘失败 session=%s cycle=%d: %s",
                session_id,
                cycle_index,
                exc,
            )

    @staticmethod
    def _checkpoint_path(session_id: str, cycle_index: int) -> Path:
        # 必须返回绝对路径：Writer 子 agent 用此路径调用 file_write，
        # 而 file_tools._resolve_path 会将相对路径前置 data_dir，
        # 若此处返回相对路径（data/sessions/...）会变成 data/data/sessions/...。
        return (
            settings.data_dir
            / "sessions"
            / session_id
            / f"checkpoint_{cycle_index}.md"
        ).resolve()


# ============================================================================
# 全局单例（SubTask 6.3，对齐 main_agent / graph_agent 模式）
# ============================================================================

#: 全局 WriterAgent 单例（延迟初始化，``init_writer_agent`` 时创建）
_writer_agent: WriterAgent | None = None

#: 模块级 ``writer_agent`` 引用（为 None 时表示未初始化；
#: 供 ``from app.services.writer_agent import writer_agent`` 导入）
writer_agent: WriterAgent | None = None


def get_writer_agent() -> WriterAgent:
    """依赖注入：返回全局 WriterAgent 单例。

    抽成函数便于后续在测试中替换依赖。

    Raises:
        RuntimeError: ``writer_agent`` 未初始化（未调用 :func:`init_writer_agent`）。
    """
    global writer_agent
    if writer_agent is None:
        raise RuntimeError(
            "writer_agent 未初始化，请先在 main.py lifespan 中调用 init_writer_agent()"
        )
    return writer_agent


def init_writer_agent(llm_client: LLMClient) -> WriterAgent:
    """显式初始化全局 WriterAgent（在 main.py lifespan 启动时调用）。

    Args:
        llm_client: LLM 客户端。

    Returns:
        初始化后的 WriterAgent 单例。
    """
    global writer_agent, _writer_agent
    writer_agent = WriterAgent(llm_client)
    _writer_agent = writer_agent
    logger.info("WriterAgent 已初始化（writer_agent 单例就绪）")
    return writer_agent


__all__ = [
    # 常量
    "CHECKPOINT_FIELDS",
    "WRITER_MAX_ITERATIONS",
    # 类
    "WriterAgent",
    # 单例
    "writer_agent",
    "get_writer_agent",
    "init_writer_agent",
]

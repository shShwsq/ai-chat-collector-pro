"""图谱 AI Agent（Task 17）。

封装所有图谱相关的 AI 操作，为后续节点抽取、延伸生成、测验、风口、报告、
提问等功能提供统一服务层。

设计要点：

1. **不修改 main_agent / sub_agent / graph_store**：本模块仅通过
   :func:`llm_factory.get_llm_client` 获取客户端、通过 :class:`GraphStore`
   读写图谱数据，对步影 Agent 模块与图谱存储层均为只读调用。

2. **LLM 客户端按调用获取**：每个方法内部通过 :meth:`_get_llm_client` 取客户端
   （凭据缺失时返回 None 并记日志），LLMClient 本身无状态，按调用构造可保证
   配置实时生效且避免持有过期凭据。

3. **统一降级策略**：所有方法在 LLM 不可用（凭据缺失 / 调用失败 / JSON 解析失败）
   时返回明确的降级结果（空列表 / 空结构 / 兜底文本），不向上抛异常，确保后端
   不崩溃。调用方通过返回值中的 ``degraded`` / ``error`` 字段判断是否走降级路径。

4. **JSON 容错解析**：:meth:`_call_llm_json` 会剥离 markdown 代码块包裹、尝试
   ``json.loads``，失败时记录原始文本并返回 None，调用方据此走降级。

5. **流式方法**：``generate_node_detail_stream`` / ``answer_question_stream`` /
   ``generate_report_stream`` 通过 :meth:`LLMClient.chat_stream` 逐 token 产出，
   同时通过 :func:`ws_notify.notify_session` 推送给前端（按 ``graph_id`` 路由）。

6. **上下文构建**：:meth:`_build_context` 将图谱节点 / 边序列化为紧凑文本，
   作为 LLM 的上下文输入，避免 token 浪费。

7. **类型推断**：:meth:`generate_node_detail` 在 ``node_type`` 为通用兜底时，
   利用 ``neighbors`` 上下文让 LLM 推断更具体的类型，并据此选择模板。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import HTTPException

from app.config import settings
from app.db import AsyncSessionLocal
from app.models.node_types import (
    GRAPH_TYPE_STUDY,
    GRAPH_TYPE_WORK,
    NODE_SOURCE_AGENT,
    NODE_SOURCE_EXTENSION,
    STUDY_SUBJECTS,
    STUDY_SUBJECT_GENERAL,
    STUDY_TEMPLATES,
    WORK_OBJECTS,
    WORK_TEMPLATES,
    get_template,
    is_valid_node_type,
)
from app.services.graph_store import GraphStore, graph_store
from app.services.llm_client import LLMClient
from app.services.llm_errors import LLMError
from app.services.llm_factory import get_llm_client
from app.services.llm_request_registry import llm_request_registry
from app.services.model_config import get_model_config
from app.services.ws_notify import notify_session

logger = logging.getLogger(__name__)


# ============================================================================
# 常量
# ============================================================================

# 延伸节点生成上限（mode="all" 时）
_MAX_EXTENSIONS_ALL = 8
_MIN_EXTENSIONS_ALL = 6

# 详情卡重要点 / 延伸方向数量约束
_IMPORTANT_POINTS_MIN = 3
_IMPORTANT_POINTS_MAX = 6
_EXTENSION_DIRECTIONS_MIN = 3
_EXTENSION_DIRECTIONS_MAX = 6

# 标题相似度归一化：用于去重时的小写 + 去空白比较
_SIMILAR_THRESHOLD = 0.8  # 简单子串包含或归一化相等即视为重复

# 长对话分块抽取参数（块大小动态由 _resolve_chunk_config 按 context_window 计算，
# 修复 Issue #9：graph_agent 长对话静默截断丢失节点）
_MAX_EXISTING_NODES_HINT = 50     # 注入 prompt 的已有节点标题上限（用于同义归一）

# 动态块大小计算的兜底与边界
_FALLBACK_CONTEXT_WINDOW = 8192   # context_window 解析失败时的兜底值
_MIN_CHUNK_CHARS = 2000           # 块字符数下限（避免块过小导致调用次数爆炸）
_MAX_CHUNK_CHARS = 200_000        # 块字符数上限（避免极端配置导致单块过大 LLM 卡死）
_EXTRACT_SYSTEM_PROMPT_TOKENS = 1500  # 抽取 system prompt 的 token 估算
_CHARS_PER_TOKEN = 1.5            # 中文约 1.5 字符/token（保守值）
_CONTEXT_SAFETY_RATIO = 0.85      # 上下文安全系数（扣除 system prompt + 角色边界开销）

# 角色标记正则：兼容 H2/H3、有无 emoji、有无粗体（生产格式 ### **🧑 用户** / 兜底 ## 用户）
_ROLE_MARKER_PATTERN = re.compile(
    r'^(?:#{2,3}\s*\**\s*(?:🧑\s*)?用户|#{2,3}\s*\**\s*(?:🤖\s*)?助手)',
    re.MULTILINE,
)


# ============================================================================
# 工具函数
# ============================================================================


def _normalize_title(title: str) -> str:
    """归一化标题用于相似度比较：去空白、转小写。"""
    return re.sub(r"\s+", "", title or "").strip().lower()


def _titles_similar(a: str, b: str) -> bool:
    """简单标题相似度判断：归一化后相等，或一方包含另一方。"""
    na, nb = _normalize_title(a), _normalize_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    # 子串包含（覆盖"乘法" vs "乘法运算"这类延伸场景）
    return na in nb or nb in na


def _strip_code_fence(text: str) -> str:
    """剥离 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）。"""
    if not text:
        return text
    s = text.strip()
    # 匹配开头的 ```json / ```yaml / ``` 等
    fence_match = re.match(r"^```[a-zA-Z]*\n?(.*?)\n?```$", s, re.DOTALL)
    if fence_match:
        return fence_match.group(1).strip()
    # 兜底：去掉首尾的 ``` （不完整代码块）
    if s.startswith("```"):
        s = s.split("\n", 1)[-1] if "\n" in s else s[3:]
    if s.endswith("```"):
        s = s[:-3]
    return s.strip()


def _extract_json_object(text: str) -> str:
    """从可能含前后说明文字的文本中提取首个 JSON 对象片段。

    找到第一个 ``{`` 与匹配的最后一个 ``}``（贪婪到末尾），用于 LLM 偶尔
    在 JSON 前后添加解释性文字时的兜底解析。
    """
    if not text:
        return text
    start = text.find("{")
    if start < 0:
        return text
    end = text.rfind("}")
    if end < 0 or end <= start:
        return text
    return text[start : end + 1]


def _resolve_chunk_config(client: LLMClient) -> tuple[int, int]:
    """根据当前 LLM 上下文窗口动态计算切块参数。

    优先级链与 :mod:`app.services.main_agent` 保持一致：
    ``settings.llm_context_window`` → ``model_config.json`` 中该模型 → 兜底 8192。

    Returns:
        ``(chunk_chars, overlap_chars)``：
        - ``chunk_chars``：每块字符数上限（下限 2000，上限 200000）。
        - ``overlap_chars``：块间重叠字符数（约 10%，上限 1000）。
    """
    model_cfg = get_model_config(client.model)
    context_window = (
        settings.llm_context_window
        or model_cfg.get("context_window")
        or _FALLBACK_CONTEXT_WINDOW
    )
    max_output_tokens = model_cfg.get("max_output_tokens") or 4096

    # 可用 token = 上下文 × 安全系数 - system prompt - 输出预留
    usable_tokens = max(
        1024,
        int(context_window * _CONTEXT_SAFETY_RATIO)
        - _EXTRACT_SYSTEM_PROMPT_TOKENS
        - max_output_tokens,
    )
    # 中文约 1.5 字符/token（保守值）
    chunk_chars = int(usable_tokens * _CHARS_PER_TOKEN)
    chunk_chars = max(_MIN_CHUNK_CHARS, min(_MAX_CHUNK_CHARS, chunk_chars))
    overlap_chars = min(chunk_chars // 10, 1000)
    return chunk_chars, overlap_chars


def _split_by_char_fallback(
    text: str, chunk_chars: int, overlap_chars: int
) -> list[str]:
    """纯字符切分兜底（无角色标记或单单元超限时使用）。

    优先在换行处断开避免割裂句子。短于一块返回单元素列表。空文本返回空列表。
    """
    if not text:
        return []
    if len(text) <= chunk_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + chunk_chars, n)
        # 优先在换行处断开（向前回溯半块找最近的 \n）
        if end < n:
            look_back_start = start + chunk_chars // 2
            nl = text.rfind("\n", look_back_start, end)
            if nl > look_back_start:
                end = nl + 1
        chunks.append(text[start:end])
        if end >= n:
            break
        start = max(0, end - overlap_chars)
    return chunks


def _parse_messages(text: str) -> list[tuple[str, str]]:
    """按角色标记把对话切分成消息列表。

    兼容生产格式（``### **🧑 用户**``）与兜底格式（``## 用户``）。
    每条消息返回 ``(role, content)``，role 为 ``"user"`` / ``"assistant"``。
    首条消息前的头部元信息（``# 标题`` / ``> 平台:...``）归到首条消息前导，
    单独成块时并入第一条。

    无任何角色标记时返回空列表（调用方回退到字符切分）。
    """
    matches = list(_ROLE_MARKER_PATTERN.finditer(text))
    if not matches:
        return []

    messages: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        # 判定角色：包含"用户" → user，包含"助手" → assistant
        line = m.group(0)
        role = "user" if "用户" in line else "assistant"
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        # 首条消息前的头部归入首条消息内容前导
        if i == 0 and start > 0:
            content = text[:end]
        else:
            # content 含角色行本身（便于 LLM 识别角色）
            content = text[start:end]
        messages.append((role, content))
    return messages


def _pair_qa_units(
    messages: list[tuple[str, str]],
) -> list[str]:
    """把消息列表按 Q&A 配对组装成原子单元。

    规则：
    - 「用户消息 + 紧随的助手回复」合并为一个单元。
    - 用户消息后无助手回复 → 单独成单元。
    - 首条是助手消息（无配对用户）→ 单独成单元。
    - 连续多条同角色消息 → 合并到当前单元（不强制配对）。

    Returns:
        单元文本列表（每个单元含角色标记与正文）。
    """
    if not messages:
        return []

    units: list[str] = []
    i = 0
    n = len(messages)
    while i < n:
        role, content = messages[i]
        if role == "user":
            # 贪心吸收后续连续的 user 消息
            parts = [content]
            j = i + 1
            while j < n and messages[j][0] == "user":
                parts.append(messages[j][1])
                j += 1
            # 若紧随 assistant 消息，也吸收进同一单元
            if j < n and messages[j][0] == "assistant":
                parts.append(messages[j][1])
                j += 1
                # 继续吸收连续的 assistant 消息
                while j < n and messages[j][0] == "assistant":
                    parts.append(messages[j][1])
                    j += 1
            units.append("".join(parts))
            i = j
        else:
            # 首条是 assistant（无配对 user）→ 单独成单元
            parts = [content]
            j = i + 1
            while j < n and messages[j][0] == "assistant":
                parts.append(messages[j][1])
                j += 1
            units.append("".join(parts))
            i = j
    return units


def _split_conversation(
    text: str, chunk_chars: int, overlap_chars: int
) -> list[str]:
    """将长对话切分为多块，块间保留若干完整 Q&A 单元作为重叠。

    切分策略：
    1. 按角色标记解析消息列表（兼容 H2/H3、有无 emoji/粗体）。
    2. 按 Q&A 配对组装原子单元（用户消息 + 紧随助手回复）。
    3. 贪心打包：当前块加入下一单元后 ≤ ``chunk_chars`` 则加入，否则开新块。
    4. 重叠区 = 上一块末尾的若干完整单元（按 ``overlap_chars`` 反推，至少 1 个）。
    5. 单个单元本身超过 ``chunk_chars`` 时，对该单元回退字符切分。

    无角色标记时回退到 :func:`_split_by_char_fallback`（保持向后兼容）。
    短于一块返回单元素列表。空文本返回空列表。
    """
    if not text:
        return []
    if len(text) <= chunk_chars:
        return [text]

    messages = _parse_messages(text)
    if not messages:
        # 无角色标记 → 回退字符切分
        return _split_by_char_fallback(text, chunk_chars, overlap_chars)

    units = _pair_qa_units(messages)
    if not units:
        return _split_by_char_fallback(text, chunk_chars, overlap_chars)

    # 单个单元超限 → 对该单元字符切分，sub 块各自独立参与打包
    expanded_units: list[list[str]] = []
    for unit in units:
        if len(unit) > chunk_chars:
            sub = _split_by_char_fallback(unit, chunk_chars, overlap_chars)
            expanded_units.append(sub)
        else:
            expanded_units.append([unit])

    # 贪心打包：把所有 sub 块拍平成序列，逐个加入当前块
    flat_parts: list[str] = []
    for parts in expanded_units:
        flat_parts.extend(parts)

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for part in flat_parts:
        part_len = len(part)
        if current and current_len + part_len > chunk_chars:
            # 收尾当前块
            chunks.append("".join(current))
            # 重叠：保留当前块末尾若干部分填满 overlap_chars
            overlap_parts: list[str] = []
            ov_len = 0
            for back in reversed(current):
                if ov_len >= overlap_chars:
                    break
                overlap_parts.insert(0, back)
                ov_len += len(back)
            current = list(overlap_parts) if overlap_parts else []
            current_len = sum(len(p) for p in current)
        current.append(part)
        current_len += part_len

    if current:
        chunks.append("".join(current))
    return chunks


def _merge_nodes(chunk_results: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """合并多个分块的抽取结果，按 :func:`_titles_similar` 去重。

    保留首次出现的版本（前块优先），后续相似标题直接丢弃。这保证跨块重复
    的同一概念只保留一个节点，与单次抽取的去重语义一致。

    Args:
        chunk_results: 每个分块抽取出的节点列表（已清洗）。

    Returns:
        合并去重后的节点列表。
    """
    merged: list[dict[str, Any]] = []
    for chunk in chunk_results:
        for node in chunk:
            title = node.get("title", "")
            if any(_titles_similar(title, m.get("title", "")) for m in merged):
                continue
            merged.append(node)
    return merged


# ============================================================================
# GraphAgent
# ============================================================================


class GraphAgent:
    """图谱 AI Agent：封装所有图谱相关的 AI 操作。

    所有方法均为 async，内部通过 :meth:`_get_llm_client` 获取 LLM 客户端，
    通过注入的 :class:`GraphStore` 实例读写图谱数据。

    Args:
        store: 图谱存储层实例，默认使用全局 :data:`graph_store` 单例。
    """

    def __init__(self, store: GraphStore | None = None) -> None:
        self.store: GraphStore = store or graph_store

    # ------------------------------------------------------------------
    # 工具函数
    # ------------------------------------------------------------------

    async def _get_llm_client(self) -> LLMClient | None:
        """获取 LLM 客户端，凭据缺失或调用失败时返回 None 并记日志。

        从 ``settings`` 表读取 ``llm.base_url`` / ``llm.api_key`` / ``llm.model``，
        任一缺失由 :func:`llm_factory.get_llm_client` 抛 ``HTTPException(400)``，
        本方法捕获后返回 None。
        """
        try:
            async with AsyncSessionLocal() as session:
                return await get_llm_client(session)
        except HTTPException as exc:
            logger.warning("GraphAgent: LLM 客户端不可用: %s", exc.detail)
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("GraphAgent: 获取 LLM 客户端异常: %s", exc)
            return None

    async def _call_llm_json(
        self,
        client: LLMClient,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = 0.3,
        request_id: str | None = None,
    ) -> dict[str, Any] | None:
        """调用 LLM 并解析 JSON 输出，失败返回 None。

        容错链路：
        1. 调用 ``client.chat()``（非流式），捕获 :class:`LLMError` 与其它异常。
        2. 剥离 markdown 代码块包裹。
        3. 尝试 ``json.loads``；失败时再尝试提取首个 JSON 对象片段后解析。
        4. 仍失败则记录原始文本（截断）并返回 None。

        Args:
            request_id: 关联 :data:`llm_request_registry` 中的请求 id（可选）。
                传入时把 LLM 调用与请求条目绑定；调用失败或解析失败时把
                注册表状态更新为 ``failed`` 并记录 error，便于前端看到原因。
                正常完成的状态更新由 :meth:`LLMClient.chat` 在内部完成。
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        try:
            response = await client.chat(
                messages, temperature=temperature, request_id=request_id
            )
        except LLMError as exc:
            logger.warning("GraphAgent: LLM 调用失败: %s", exc)
            if request_id is not None:
                await llm_request_registry.update(
                    request_id, "failed", error=str(exc)
                )
            return None
        except Exception as exc:  # noqa: BLE001
            logger.warning("GraphAgent: LLM 调用异常: %s", exc)
            if request_id is not None:
                await llm_request_registry.update(
                    request_id, "failed", error=str(exc)
                )
            return None

        content = (response.get("content") or "").strip()
        if not content:
            logger.warning("GraphAgent: LLM 返回空内容")
            if request_id is not None:
                await llm_request_registry.update(
                    request_id, "failed", error="LLM 返回空内容"
                )
            return None

        # 第一次尝试：剥离代码块后直接解析
        cleaned = _strip_code_fence(content)
        try:
            return json.loads(cleaned)
        except (json.JSONDecodeError, TypeError):
            pass

        # 第二次尝试：提取首个 JSON 对象片段
        extracted = _extract_json_object(cleaned)
        if extracted != cleaned:
            try:
                return json.loads(extracted)
            except (json.JSONDecodeError, TypeError):
                pass

        logger.warning(
            "GraphAgent: JSON 解析失败，原始内容（截断）: %s",
            content[:500],
        )
        if request_id is not None:
            await llm_request_registry.update(
                request_id, "failed", error="LLM 返回 JSON 解析失败"
            )
        return None

    async def _build_context(self, graph_id: str) -> str:
        """将图谱节点 / 边序列化为 LLM 上下文字符串。

        格式示例::

            图谱名称：XXX（work）
            节点列表：
            1. [commitment] 承诺A - 一句话概括
               详情：{key_info: ..., related_persons: ...}
            2. [key_person] 张三 - 关键人
            ...
            关系列系：
            - 承诺A --承诺给--> 张三
            - 事件B --涉及--> 张三
        """
        full = await self.store.get_full_graph(graph_id)
        if full is None:
            return "（图谱不存在或为空）"

        graph = full.get("graph", {})
        nodes = full.get("nodes", [])
        edges = full.get("edges", [])

        lines: list[str] = []
        lines.append(f"图谱名称：{graph.get('name', '')}（{graph.get('type', '')}）")
        lines.append(f"节点总数：{len(nodes)}，边总数：{len(edges)}")

        if nodes:
            lines.append("")
            lines.append("节点列表：")
            # 构建 id -> node 索引，便于边序列化
            id_to_title: dict[str, str] = {}
            for i, n in enumerate(nodes, 1):
                nid = n.get("id", "")
                title = n.get("title", "")
                ntype = n.get("type", "")
                summary = n.get("summary", "")
                id_to_title[nid] = title
                detail = n.get("detail_payload") or {}
                # 仅取非空详情字段，避免上下文过长
                detail_brief = {
                    k: v for k, v in detail.items() if v not in ("", None, [], {})
                }
                line = f"{i}. [{ntype}] {title}"
                if summary:
                    line += f" - {summary}"
                if detail_brief:
                    try:
                        line += "\n   详情：" + json.dumps(
                            detail_brief, ensure_ascii=False
                        )
                    except (TypeError, ValueError):
                        pass
                lines.append(line)

        if edges:
            lines.append("")
            lines.append("关系列系：")
            id_to_title = {
                n.get("id", ""): n.get("title", "") for n in nodes
            }
            for e in edges:
                src = id_to_title.get(e.get("src_id", ""), "?")
                dst = id_to_title.get(e.get("dst_id", ""), "?")
                rel = e.get("relation", "related")
                lines.append(f"- {src} --{rel}--> {dst}")

        return "\n".join(lines)

    def _resolve_template(
        self, graph_type: str, node_type: str
    ) -> tuple[list[dict[str, str]], str]:
        """解析节点类型对应的详情卡模板。

        Returns:
            ``(template, template_used_label)`` 元组。``template_used_label``
            为 ``"default"`` 表示走了通用兜底，否则为具体类型名。
        """
        if graph_type == GRAPH_TYPE_STUDY:
            if node_type in STUDY_TEMPLATES:
                return STUDY_TEMPLATES[node_type], node_type
            return get_template(graph_type, node_type), "default"
        if graph_type == GRAPH_TYPE_WORK:
            if node_type in WORK_TEMPLATES:
                return WORK_TEMPLATES[node_type], node_type
            return get_template(graph_type, node_type), "default"
        return get_template(graph_type, node_type), "default"

    def _format_template_fields(self, template: list[dict[str, str]]) -> str:
        """将模板字段格式化为 LLM 可读的说明文本。"""
        if not template:
            return "（无模板字段，请生成概括性内容）"
        parts: list[str] = []
        for field in template:
            key = field.get("key", "")
            label = field.get("label", "")
            placeholder = field.get("placeholder", "")
            parts.append(f"- {key}（{label}）：{placeholder}")
        return "\n".join(parts)

    # ------------------------------------------------------------------
    # 1. 节点抽取
    # ------------------------------------------------------------------

    async def extract_nodes_from_observation(
        self, observation_id: str, graph_type: str
    ) -> dict[str, Any]:
        """从一条 Observation 对话中抽取候选节点。

        对长对话采用**分块抽取 + 合并去重**策略（修复 Issue #9：长对话静默
        截断丢失节点）：块大小由 :func:`_resolve_chunk_config` 按当前 LLM 上下文
        窗口动态计算，按 Q&A 配对切分（保证消息不被切断），每块独立调用 LLM 抽取，
        最后用 :func:`_titles_similar` 跨块去重合并，再由
        :meth:`_merge_candidates_with_existing` 与图谱已有节点做语义合并。
        短对话（<= 一块）走单次调用原路径。

        同义归一：抽取前从 :meth:`store.list_nodes` 加载当前图谱已有节点标题
        （最多 :data:`_MAX_EXISTING_NODES_HINT` 个）注入 prompt，要求 LLM 优先
        复用已有标题，避免产出"乘法"与"乘法运算"这类同义重复节点。

        Args:
            observation_id: 观察记录 ID。
            graph_type: 图谱模式（``study`` / ``work``），决定抽取目标与子类型枚举。

        Returns:
            ``{nodes, count, truncated, segment_count, original_length}``。

            - ``nodes``: ``[{title, summary, type, detail_payload, confidence,
              source_reason}]`` 清洗后节点列表。
            - ``count``: 节点数量。
            - ``truncated``: 是否触发分块抽取（即原对话长度超过单块上限）。
            - ``segment_count``: 实际分块数（短对话为 1）。
            - ``original_length``: 原对话字符数。

            LLM 不可用或解析失败时 ``nodes`` 为空列表，其余字段仍正常返回。
        """
        observation = await self.store.get_observation(observation_id)
        if observation is None:
            logger.warning("GraphAgent: 观察记录不存在: %s", observation_id)
            return {
                "nodes": [],
                "count": 0,
                "truncated": False,
                "segment_count": 0,
                "original_length": 0,
            }

        conversation = observation.get("conversation_markdown", "") or ""
        original_length = len(conversation)
        if not conversation.strip():
            logger.warning("GraphAgent: 观察记录对话内容为空: %s", observation_id)
            return {
                "nodes": [],
                "count": 0,
                "truncated": False,
                "segment_count": 0,
                "original_length": original_length,
            }

        client = await self._get_llm_client()
        if client is None:
            logger.warning("GraphAgent: LLM 不可用，extract_nodes 返回空列表")
            return {
                "nodes": [],
                "count": 0,
                "truncated": False,
                "segment_count": 0,
                "original_length": original_length,
            }

        # 子类型枚举与提示
        if graph_type == GRAPH_TYPE_STUDY:
            sub_types = list(STUDY_SUBJECTS)
            type_desc = "学科知识点（如数学/物理/编程/大模型等）"
        else:
            sub_types = list(WORK_OBJECTS)
            type_desc = "工作对象（如线索/关键人/承诺/期望/事件/决策/风险等）"

        # 同义归一：加载当前图谱已有节点标题（前 50 个）注入 prompt
        existing_titles: list[str] = []
        graph_id = observation.get("graph_id")
        if graph_id:
            try:
                existing_nodes = await self.store.list_nodes(graph_id)
                existing_titles = [
                    n.get("title", "")
                    for n in existing_nodes[:_MAX_EXISTING_NODES_HINT]
                    if n.get("title")
                ]
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "GraphAgent: 加载已有节点失败 graph=%s: %s", graph_id, exc
                )
                existing_titles = []

        # 动态计算块大小（按 LLM 上下文窗口）
        chunk_chars, overlap_chars = _resolve_chunk_config(client)
        logger.info(
            "GraphAgent: 块配置 chunk_chars=%d overlap_chars=%d model=%s",
            chunk_chars,
            overlap_chars,
            client.model,
        )

        # 分块：短对话返回单元素列表，长对话按 Q&A 配对切分为多块
        chunks = _split_conversation(conversation, chunk_chars, overlap_chars)
        truncated = len(chunks) > 1
        if not chunks:
            return {
                "nodes": [],
                "count": 0,
                "truncated": False,
                "segment_count": 0,
                "original_length": original_length,
            }

        # 逐块抽取（顺序调用，避免并发打满 LLM 配额）
        chunk_results: list[list[dict[str, Any]]] = []
        for idx, chunk_text in enumerate(chunks):
            cleaned = await self._extract_nodes_from_chunk(
                client=client,
                chunk_text=chunk_text,
                graph_type=graph_type,
                sub_types=sub_types,
                type_desc=type_desc,
                existing_titles=existing_titles,
                observation_id=observation_id,
                chunk_index=idx,
                chunk_total=len(chunks),
            )
            chunk_results.append(cleaned)

        # 跨块规则去重（标题子串包含兜底）
        if len(chunk_results) == 1:
            nodes = chunk_results[0]
        else:
            nodes = _merge_nodes(chunk_results)
            logger.info(
                "GraphAgent: 长对话分块抽取完成 obs=%s chunks=%d raw=%d merged=%d",
                observation_id,
                len(chunks),
                sum(len(c) for c in chunk_results),
                len(nodes),
            )

        # 与图谱已有节点语义合并（LLM agent 决策 keep/merge_into/drop）
        if nodes and graph_id:
            nodes = await self._merge_candidates_with_existing(
                client, nodes, graph_id
            )

        return {
            "nodes": nodes,
            "count": len(nodes),
            "truncated": truncated,
            "segment_count": len(chunks),
            "original_length": original_length,
        }

    async def _extract_nodes_from_chunk(
        self,
        *,
        client: LLMClient,
        chunk_text: str,
        graph_type: str,
        sub_types: list[str],
        type_desc: str,
        existing_titles: list[str],
        observation_id: str,
        chunk_index: int,
        chunk_total: int,
    ) -> list[dict[str, Any]]:
        """对单块对话文本调用 LLM 抽取节点并清洗。

        抽取 prompt 注入已有节点标题（同义归一提示）与分块上下文（当前块序号），
        让 LLM 在长对话后段也能识别出前段已抽过的同义概念。

        LLM 调用失败或 JSON 解析失败时返回空列表（降级，不抛异常）。
        """
        system_prompt = (
            "你是一个严格的「知识图谱节点抽取器」。从用户提供的对话原文中识别出"
            f"值得记录的{type_desc}，每个节点输出为一个 JSON 对象。\n\n"
            "输出要求：\n"
            "1. 仅输出一个 JSON 对象，键为 `nodes`，值为节点数组，不要添加任何"
            "解释性文字或 markdown 代码块。\n"
            "2. 每个节点包含字段：\n"
            "   - title: 节点标题（简洁，<=30 字）\n"
            "   - summary: 一句话概括（<=60 字）\n"
            "   - type: 节点子类型，必须从给定枚举中选择\n"
            "   - detail_payload: 详情字段对象，键为模板字段名（如 what_is / "
            "key_points / extensions），值为字符串\n"
            "   - confidence: 置信度 0.0-1.0\n"
            "   - source_reason: 从对话中识别出该节点的依据（一句话）\n"
            "3. 若对话无明确可抽取内容，返回 {\"nodes\": []}。\n"
            "4. 同一概念只抽取一次，避免重复。\n"
            f"5. type 必须是以下枚举之一：{sub_types}\n"
        )

        # 同义归一提示：若图谱中已有节点标题，要求 LLM 优先复用
        if existing_titles:
            system_prompt += (
                "6. 图谱中已有以下节点标题，若对话中出现的概念与其中某条同义或"
                "指代同一对象，请直接复用该标题（不要产出同义重复节点）：\n"
                f"{existing_titles}\n"
            )

        # 分块上下文提示：让 LLM 知道这是长对话的第几块
        if chunk_total > 1:
            user_prompt = (
                f"图谱模式：{graph_type}\n"
                f"子类型枚举：{sub_types}\n\n"
                f"（这是长对话的第 {chunk_index + 1}/{chunk_total} 块，"
                "可能包含前一块结尾的重叠内容，请只抽取本块中明确出现的概念，"
                "不要凭空补全。）\n\n"
                "对话原文：\n"
                f"{chunk_text}\n\n"
                "请输出 JSON："
            )
        else:
            user_prompt = (
                f"图谱模式：{graph_type}\n"
                f"子类型枚举：{sub_types}\n\n"
                "对话原文：\n"
                f"{chunk_text}\n\n"
                "请输出 JSON："
            )

        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.2,
            request_id=await llm_request_registry.register(
                "extract_nodes",
                meta={
                    "observation_id": observation_id,
                    "graph_type": graph_type,
                    "chunk_index": chunk_index,
                    "chunk_total": chunk_total,
                },
            ),
        )
        if result is None:
            return []

        nodes_raw = result.get("nodes") if isinstance(result, dict) else None
        if not isinstance(nodes_raw, list):
            logger.warning(
                "GraphAgent: extract_nodes 返回的 JSON 中 nodes 字段非列表: %s",
                str(result)[:200],
            )
            return []

        # 清洗与校验
        cleaned: list[dict[str, Any]] = []
        valid_types = set(sub_types)
        for item in nodes_raw:
            if not isinstance(item, dict):
                continue
            title = (item.get("title") or "").strip()
            if not title:
                continue
            ntype = item.get("type") or ""
            if ntype not in valid_types:
                # 尝试归一化为 general（study）/ 跳过
                if graph_type == GRAPH_TYPE_STUDY:
                    ntype = STUDY_SUBJECT_GENERAL
                else:
                    continue
            confidence = item.get("confidence", 0.7)
            try:
                confidence = max(0.0, min(1.0, float(confidence)))
            except (TypeError, ValueError):
                confidence = 0.7
            detail_payload = item.get("detail_payload") or {}
            if not isinstance(detail_payload, dict):
                detail_payload = {}
            cleaned.append(
                {
                    "title": title[:255],
                    "summary": (item.get("summary") or "").strip()[:500],
                    "type": ntype,
                    "detail_payload": detail_payload,
                    "confidence": confidence,
                    "source_reason": (item.get("source_reason") or "").strip(),
                }
            )
        return cleaned

    async def _merge_candidates_with_existing(
        self,
        client: LLMClient,
        candidates: list[dict[str, Any]],
        graph_id: str,
    ) -> list[dict[str, Any]]:
        """用 LLM agent 对候选节点与图谱已有节点做语义合并去重。

        对每个候选节点决定：
        - ``keep``：作为新节点保留。
        - ``merge_into``：补充到已有节点（合并 detail_payload 字段，不覆盖已有内容），
          候选节点不入图，已有节点 ``incr_mention``。
        - ``drop``：丢弃重复候选节点。
        - ``need_detail``：需查看指定已有节点的 detail_payload 才能决策（触发二次调用）。

        prompt 约束避免合并出超大卡片（merge_fields 仅补充空字段、每字段 ≤200 字、
        重叠度高优先 drop）。

        LLM 不可用或解析失败时回退到 :func:`_merge_nodes` + :func:`_titles_similar`
        纯规则去重（返回 candidates 原样，仅做跨候选去重）。
        """
        if not candidates:
            return candidates

        # 加载已有节点（前 N 个），构造 brief 供 LLM 决策
        try:
            existing_nodes = await self.store.list_nodes(graph_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "GraphAgent: 合并 agent 加载已有节点失败 graph=%s: %s",
                graph_id,
                exc,
            )
            return self._rule_based_dedup(candidates)

        existing_brief: list[dict[str, Any]] = []
        title_to_node: dict[str, dict[str, Any]] = {}
        for n in existing_nodes[:_MAX_EXISTING_NODES_HINT]:
            title = n.get("title", "")
            if not title:
                continue
            existing_brief.append(
                {
                    "title": title,
                    "summary": (n.get("summary") or "")[:200],
                    "type": n.get("type", ""),
                }
            )
            title_to_node[title] = n

        # 无已有节点 → 无需合并，直接返回（仍做候选间去重）
        if not existing_brief:
            return self._rule_based_dedup(candidates)

        # 截断候选 detail_payload 避免 prompt 过长
        candidates_brief = []
        for i, c in enumerate(candidates):
            dp = c.get("detail_payload") or {}
            dp_brief = {
                k: (str(v)[:200] if v else "") for k, v in dp.items()
            } if isinstance(dp, dict) else {}
            candidates_brief.append(
                {
                    "index": i,
                    "title": c.get("title", ""),
                    "summary": (c.get("summary") or "")[:200],
                    "type": c.get("type", ""),
                    "detail_payload": dp_brief,
                }
            )

        system_prompt = (
            "你是一个「知识图谱节点合并决策器」。对每个候选节点，判断它与已有节点"
            "是否指代同一概念，给出决策。输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出格式：{\"decisions\": [{\"candidate_index\", \"action\", ...}]}\n"
            "action 取值：\n"
            "- \"keep\": 候选是新概念，作为新节点保留\n"
            "- \"merge_into\": 候选与已有节点指代同一对象但有补充信息，合并到已有节点\n"
            "  （需提供 target_title 与 merge_fields）\n"
            "- \"drop\": 候选与已有节点完全重复，丢弃\n"
            "- \"need_detail\": 需查看指定已有节点的完整 detail_payload 才能判断\n"
            "  （需提供 target_title）\n\n"
            "重要约束（避免合并出超大卡片）：\n"
            "1. merge_fields 仅在已有节点该字段为空或明显不完整时才补充，"
            "不要合并已有内容。\n"
            "2. 单次 merge_fields 的每个字段值不超过 200 字。\n"
            "3. 若候选与已有节点内容重叠度高，优先 drop 而非 merge_into。\n"
            "4. 宁可 keep 两个相近但不同的节点，也不要 merge_into 出一个信息过载的"
            "超级卡片。\n"
            "5. merge_fields 的 key 必须来自已有节点的 detail_payload 现有字段。\n"
            "6. target_title 必须精确匹配已有节点标题列表中的某一项。\n"
        )
        user_prompt = (
            f"已有节点列表（前 {len(existing_brief)} 个）：\n"
            f"{json.dumps(existing_brief, ensure_ascii=False, indent=2)}\n\n"
            f"候选节点列表（共 {len(candidates_brief)} 个）：\n"
            f"{json.dumps(candidates_brief, ensure_ascii=False, indent=2)}\n\n"
            "请对每个候选节点给出决策，输出 JSON："
        )

        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.2,
            request_id=await llm_request_registry.register(
                "merge_candidates",
                graph_id=graph_id,
                meta={
                    "candidate_count": len(candidates),
                    "existing_count": len(existing_brief),
                },
            ),
        )
        if result is None:
            logger.warning(
                "GraphAgent: 合并 agent 首轮调用失败，回退规则去重"
            )
            return self._rule_based_dedup(candidates)

        decisions_raw = result.get("decisions") if isinstance(result, dict) else None
        if not isinstance(decisions_raw, list):
            logger.warning(
                "GraphAgent: 合并 agent 返回 decisions 非列表，回退规则去重"
            )
            return self._rule_based_dedup(candidates)

        # 解析首轮决策
        decisions: list[dict[str, Any]] = []
        for d in decisions_raw:
            if not isinstance(d, dict):
                continue
            decisions.append(d)

        # 处理 need_detail：二次调用补全
        need_detail_items = [
            d for d in decisions if d.get("action") == "need_detail"
        ]
        if need_detail_items:
            # 收集需要查看详情的已有节点
            detail_map: dict[str, dict[str, Any]] = {}
            for d in need_detail_items:
                t = (d.get("target_title") or "").strip()
                if t and t in title_to_node:
                    node = title_to_node[t]
                    dp = node.get("detail_payload") or {}
                    # 截断每个字段值避免 prompt 过长
                    detail_map[t] = {
                        k: (str(v)[:300] if v else "")
                        for k, v in dp.items()
                    } if isinstance(dp, dict) else {}

            if detail_map:
                second_prompt = (
                    "以下是需查看的已有节点完整 detail_payload，请对每个 need_detail "
                    "候选给出最终决策（keep / merge_into / drop）：\n\n"
                    f"已有节点详情：\n{json.dumps(detail_map, ensure_ascii=False, indent=2)}\n\n"
                    f"待决策候选（need_detail 项）：\n"
                    f"{json.dumps(need_detail_items, ensure_ascii=False, indent=2)}\n\n"
                    "请输出 JSON：{\"decisions\": [{\"candidate_index\", \"action\", ...}]}，"
                    "action 仅限 keep / merge_into / drop。"
                )
                second_result = await self._call_llm_json(
                    client,
                    system_prompt,
                    second_prompt,
                    temperature=0.2,
                    request_id=await llm_request_registry.register(
                        "merge_candidates_detail",
                        graph_id=graph_id,
                        meta={"need_detail_count": len(need_detail_items)},
                    ),
                )
                if second_result is not None:
                    second_decisions = second_result.get("decisions")
                    if isinstance(second_decisions, list):
                        # 用二次决策替换 need_detail 项
                        second_by_idx = {
                            d.get("candidate_index"): d
                            for d in second_decisions
                            if isinstance(d, dict)
                        }
                        decisions = [
                            second_by_idx.get(d.get("candidate_index"), d)
                            if d.get("action") == "need_detail"
                            else d
                            for d in decisions
                        ]

        # 应用决策
        kept: list[dict[str, Any]] = []
        merged_count = 0
        dropped_count = 0
        for d in decisions:
            idx = d.get("candidate_index")
            if not isinstance(idx, int) or idx < 0 or idx >= len(candidates):
                continue
            candidate = candidates[idx]
            action = d.get("action", "keep")
            if action == "keep":
                kept.append(candidate)
            elif action == "merge_into":
                target_title = (d.get("target_title") or "").strip()
                merge_fields = d.get("merge_fields") or {}
                if not isinstance(merge_fields, dict):
                    merge_fields = {}
                # 截断每个字段值到 200 字
                merge_fields = {
                    k: (str(v)[:200] if v else "")
                    for k, v in merge_fields.items()
                }
                target_node = title_to_node.get(target_title)
                if target_node and merge_fields:
                    try:
                        await self.store.update_node(
                            target_node["id"],
                            detail_payload=merge_fields,
                        )
                        await self.store.incr_mention(target_node["id"])
                        merged_count += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "GraphAgent: 合并 agent update_node 失败 target=%s: %s",
                            target_title,
                            exc,
                        )
                        # 合并失败则保留候选作为新节点
                        kept.append(candidate)
                else:
                    # target 不存在或无 merge_fields → 保留候选
                    kept.append(candidate)
            elif action == "drop":
                dropped_count += 1
            else:
                # 未知 action → 保留
                kept.append(candidate)

        # 决策数与候选数不匹配时，未覆盖的候选默认保留
        decided_indices = {
            d.get("candidate_index")
            for d in decisions
            if isinstance(d.get("candidate_index"), int)
        }
        for i, c in enumerate(candidates):
            if i not in decided_indices:
                kept.append(c)

        logger.info(
            "GraphAgent: 合并 agent 完成 graph=%s candidates=%d kept=%d "
            "merged=%d dropped=%d",
            graph_id,
            len(candidates),
            len(kept),
            merged_count,
            dropped_count,
        )
        return kept

    def _rule_based_dedup(
        self, candidates: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """规则兜底去重（合并 agent 不可用时使用）。

        复用 :func:`_titles_similar` 对候选列表内部去重，前优先保留。
        """
        if not candidates:
            return []
        kept: list[dict[str, Any]] = []
        for c in candidates:
            title = c.get("title", "")
            if any(_titles_similar(title, k.get("title", "")) for k in kept):
                continue
            kept.append(c)
        return kept

    # ------------------------------------------------------------------
    # 2. 节点详情生成
    # ------------------------------------------------------------------

    async def generate_node_detail(
        self,
        node_title: str,
        node_type: str,
        graph_type: str,
        neighbors: list[dict[str, Any]] | None = None,
        *,
        node_id: str | None = None,
        graph_id: str | None = None,
    ) -> dict[str, Any]:
        """为节点生成详情卡内容。

        Args:
            node_title: 节点标题。
            node_type: 节点子类型（若为通用兜底，可通过 neighbors 推断）。
            graph_type: 图谱模式。
            neighbors: 邻居节点列表，用于上下文推断类型与生成延伸方向。
            node_id: 节点 ID（可选，仅用于注册到 LLM 请求管理面板）。
            graph_id: 图谱 ID（可选，仅用于注册到 LLM 请求管理面板）。

        Returns:
            ``{summary, important_points, extension_directions, template_used}``
            LLM 不可用时返回兜底结构。
        """
        client = await self._get_llm_client()
        if client is None:
            return self._fallback_node_detail(
                node_title, node_type, graph_type, reason="LLM 不可用"
            )

        # 利用 neighbors 推断更具体的类型（当 node_type 为通用兜底时）
        inferred_type = node_type
        if neighbors and self._is_generic_type(node_type, graph_type):
            inferred_type = self._infer_type_from_neighbors(
                node_title, node_type, graph_type, neighbors
            )

        template, template_used = self._resolve_template(
            graph_type, inferred_type
        )
        template_desc = self._format_template_fields(template)

        # 邻居上下文
        neighbor_desc = ""
        if neighbors:
            parts = []
            for nb in neighbors[:10]:
                parts.append(
                    f"- [{nb.get('type', '')}] {nb.get('title', '')}"
                    + (f"：{nb.get('summary', '')}" if nb.get("summary") else "")
                )
            neighbor_desc = "邻居节点（用于推断关联与延伸方向）：\n" + "\n".join(
                parts
            )

        system_prompt = (
            "你是一个「知识详情卡生成器」。根据节点标题与上下文，生成结构化的"
            "详情内容。输出严格 JSON，不要添加解释性文字或 markdown 代码块。\n\n"
            "输出字段：\n"
            "- summary: 一句话概括节点（<=80 字）\n"
            "- important_points: 重要点数组（3-6 个，每个为字符串）\n"
            "- extension_directions: 延伸方向数组（3-6 个），每项为 "
            "{\"name\": \"方向名\", \"reason\": \"为何值得延伸\"}\n"
            "- detail_fields: 详情字段对象，键来自给定模板，值为字符串内容\n"
            "- inferred_type: 若推断出更具体的类型则填写，否则留空\n"
        )

        user_prompt = (
            f"节点标题：{node_title}\n"
            f"当前类型：{node_type}\n"
            f"图谱模式：{graph_type}\n\n"
            f"详情卡模板字段：\n{template_desc}\n\n"
        )
        if neighbor_desc:
            user_prompt += neighbor_desc + "\n\n"
        user_prompt += "请输出 JSON："

        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.5,
            request_id=await llm_request_registry.register(
                "generate_node_detail",
                node_id=node_id,
                graph_id=graph_id,
                meta={"node_title": node_title, "node_type": node_type},
            ),
        )
        if result is None:
            return self._fallback_node_detail(
                node_title, inferred_type, graph_type, reason="LLM 返回解析失败"
            )

        # 若 LLM 推断了合法类型，则再次解析模板
        inferred = (result.get("inferred_type") or "").strip()
        if inferred and inferred != inferred_type and is_valid_node_type(
            graph_type, inferred
        ):
            inferred_type = inferred
            template, template_used = self._resolve_template(
                graph_type, inferred_type
            )

        important_points = result.get("important_points") or []
        if not isinstance(important_points, list):
            important_points = []
        important_points = [
            str(p).strip() for p in important_points if p
        ][:_IMPORTANT_POINTS_MAX]

        ext_dirs = result.get("extension_directions") or []
        if not isinstance(ext_dirs, list):
            ext_dirs = []
        extension_directions = []
        for d in ext_dirs:
            if isinstance(d, dict):
                name = (d.get("name") or "").strip()
                if name:
                    extension_directions.append(
                        {
                            "name": name[:100],
                            "reason": (d.get("reason") or "").strip()[:300],
                        }
                    )
            elif isinstance(d, str) and d.strip():
                extension_directions.append({"name": d.strip()[:100], "reason": ""})
        extension_directions = extension_directions[:_EXTENSION_DIRECTIONS_MAX]

        detail_fields = result.get("detail_fields") or {}
        if not isinstance(detail_fields, dict):
            detail_fields = {}

        return {
            "summary": (result.get("summary") or "").strip()[:500],
            "important_points": important_points,
            "extension_directions": extension_directions,
            "detail_fields": detail_fields,
            "template_used": template_used,
            "inferred_type": inferred_type,
            "degraded": False,
        }

    def _is_generic_type(self, node_type: str, graph_type: str) -> bool:
        """判断节点类型是否为通用兜底（需要推断）。"""
        if graph_type == GRAPH_TYPE_STUDY:
            return node_type == STUDY_SUBJECT_GENERAL or node_type not in STUDY_TEMPLATES
        if graph_type == GRAPH_TYPE_WORK:
            return node_type not in WORK_TEMPLATES
        return True

    def _infer_type_from_neighbors(
        self,
        node_title: str,
        node_type: str,
        graph_type: str,
        neighbors: list[dict[str, Any]],
    ) -> str:
        """从邻居类型中统计最常见的具体类型作为推断结果（简单启发式）。

        仅在邻居中存在具体类型时采用，避免无依据地切换。
        """
        if not neighbors:
            return node_type
        type_counts: dict[str, int] = {}
        for nb in neighbors:
            nb_type = nb.get("type", "")
            if not nb_type or nb_type == node_type:
                continue
            if graph_type == GRAPH_TYPE_STUDY and nb_type == STUDY_SUBJECT_GENERAL:
                continue
            type_counts[nb_type] = type_counts.get(nb_type, 0) + 1
        if not type_counts:
            return node_type
        # 取出现次数最多的类型
        best = max(type_counts.items(), key=lambda kv: kv[1])
        if best[1] >= 1 and is_valid_node_type(graph_type, best[0]):
            return best[0]
        return node_type

    def _fallback_node_detail(
        self,
        node_title: str,
        node_type: str,
        graph_type: str,
        *,
        reason: str = "",
    ) -> dict[str, Any]:
        """生成降级详情卡（LLM 不可用时使用）。"""
        template, template_used = self._resolve_template(graph_type, node_type)
        return {
            "summary": f"{node_title}（详情生成服务暂不可用）",
            "important_points": [],
            "extension_directions": [],
            "detail_fields": {f["key"]: "" for f in template},
            "template_used": template_used,
            "inferred_type": node_type,
            "degraded": True,
            "degrade_reason": reason,
        }

    # ------------------------------------------------------------------
    # 3. 延伸节点生成
    # ------------------------------------------------------------------

    async def generate_extensions(
        self,
        node_id: str,
        graph_id: str,
        mode: str = "all",
        direction_name: str | None = None,
    ) -> list[dict[str, Any]]:
        """基于节点的延伸方向推荐生成延伸节点。

        Args:
            node_id: 源节点 ID。
            graph_id: 所属图谱 ID。
            mode: ``all`` 生成全部延伸（限 6-8 个）；``single`` 仅生成指定方向。
            direction_name: mode="single" 时指定的方向名。

        Returns:
            ``[{title, summary, type, is_gray: True, existing: bool, direction_name}]``
            LLM 不可用或节点不存在时返回空列表。
        """
        node = await self.store.get_node(node_id)
        if node is None or node.get("graph_id") != graph_id:
            logger.warning(
                "GraphAgent: 节点不存在或不属于图谱 node=%s graph=%s",
                node_id,
                graph_id,
            )
            return []

        # 获取图谱模式
        graph = await self.store.get_graph(graph_id)
        if graph is None:
            return []
        graph_type = graph.get("type", GRAPH_TYPE_STUDY)

        # 从 detail_payload 中提取延伸方向
        detail_payload = node.get("detail_payload") or {}
        directions = self._extract_directions(detail_payload)

        # single 模式：仅保留指定方向
        if mode == "single":
            if not direction_name:
                logger.warning("GraphAgent: single 模式需提供 direction_name")
                return []
            directions = [
                d for d in directions
                if _titles_similar(d.get("name", ""), direction_name)
            ] or [{"name": direction_name, "reason": ""}]

        # all 模式：限制数量
        if mode == "all" and len(directions) > _MAX_EXTENSIONS_ALL:
            directions = directions[:_MAX_EXTENSIONS_ALL]

        if not directions:
            # 无延伸方向：让 LLM 现场生成
            directions = await self._generate_directions_on_demand(
                node, graph_type, graph_id
            )
            if mode == "all" and len(directions) > _MAX_EXTENSIONS_ALL:
                directions = directions[:_MAX_EXTENSIONS_ALL]

        if not directions:
            return []

        # 获取现有节点标题，用于去重
        existing_nodes = await self.store.list_nodes(graph_id)
        existing_titles = [n.get("title", "") for n in existing_nodes if n.get("title")]

        client = await self._get_llm_client()
        if client is None:
            # 降级：仅返回标记 existing 的方向（不实际生成）
            return self._fallback_extensions(
                directions, node, graph_type, existing_titles
            )

        # 让 LLM 为每个方向生成具体的节点
        source_title = node.get("title", "")
        source_summary = node.get("summary", "")
        sub_types = list(STUDY_SUBJECTS if graph_type == GRAPH_TYPE_STUDY else WORK_OBJECTS)

        system_prompt = (
            "你是一个「延伸节点生成器」。基于源节点与延伸方向，为每个方向生成一个"
            "具体的延伸节点。输出严格 JSON，不要添加解释文字或 markdown 代码块。\n\n"
            "输出格式：{\"extensions\": [{\"title\", \"summary\", \"type\", "
            "\"direction_name\"}]}\n"
            "要求：\n"
            "- title: 简洁具体（<=30 字），体现延伸方向\n"
            "- summary: 一句话概括（<=60 字）\n"
            "- type: 必须从给定枚举中选择\n"
            "- direction_name: 对应的延伸方向名\n"
            "- 每个方向只生成一个节点\n"
        )

        directions_desc = "\n".join(
            f"- {d.get('name', '')}"
            + (f"（{d.get('reason', '')}）" if d.get("reason") else "")
            for d in directions
        )

        user_prompt = (
            f"源节点：{source_title}"
            + (f"（{source_summary}）" if source_summary else "")
            + "\n"
            f"源节点类型：{node.get('type', '')}\n"
            f"图谱模式：{graph_type}\n"
            f"类型枚举：{sub_types}\n\n"
            f"延伸方向：\n{directions_desc}\n\n"
            "请为每个方向生成一个延伸节点，输出 JSON："
        )

        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.6,
            request_id=await llm_request_registry.register(
                "extend_node",
                node_id=node_id,
                graph_id=graph_id,
                meta={
                    "source_title": source_title,
                    "mode": mode,
                    "direction_name": direction_name or "",
                },
            ),
        )
        if result is None:
            return self._fallback_extensions(
                directions, node, graph_type, existing_titles
            )

        ext_raw = result.get("extensions") if isinstance(result, dict) else None
        if not isinstance(ext_raw, list):
            return []

        # 组装结果，标记已存在的节点
        output: list[dict[str, Any]] = []
        valid_types = set(sub_types)
        src_type = node.get("type", "")
        for item in ext_raw:
            if not isinstance(item, dict):
                continue
            title = (item.get("title") or "").strip()
            if not title:
                continue
            ntype = item.get("type") or src_type
            if ntype not in valid_types:
                ntype = src_type
            # 去重：与现有节点标题相似则标记 existing
            is_existing = any(
                _titles_similar(title, et) for et in existing_titles
            )
            output.append(
                {
                    "title": title[:255],
                    "summary": (item.get("summary") or "").strip()[:500],
                    "type": ntype,
                    "is_gray": True,
                    "existing": is_existing,
                    "direction_name": (item.get("direction_name") or "").strip(),
                    "source_node_id": node_id,
                }
            )
        return output

    def _extract_directions(
        self, detail_payload: dict[str, Any]
    ) -> list[dict[str, str]]:
        """从 detail_payload 中提取延伸方向列表。

        优先读取 ``_extension_directions``（节点详情路由 generate_node_detail
        写入的元数据键，带下划线前缀避免与模板字段冲突），兼容旧的无下划线
        ``extension_directions`` 键；其次尝试解析 ``extensions`` 模板字段
        （字符串/列表）。
        """
        directions: list[dict[str, str]] = []
        # 详情路由以 _DETAIL_KEY_EXTENSIONS = "_extension_directions" 落库，
        # 这里必须读取带下划线的键才能复用详情卡已生成的延伸方向。
        ext_dirs = (
            detail_payload.get("_extension_directions")
            if isinstance(detail_payload, dict)
            else None
        )
        if not isinstance(ext_dirs, list):
            # 兼容旧数据 / 外部直接写入的无下划线键
            ext_dirs = detail_payload.get("extension_directions") if isinstance(
                detail_payload, dict
            ) else None
        if isinstance(ext_dirs, list):
            for d in ext_dirs:
                if isinstance(d, dict):
                    name = (d.get("name") or "").strip()
                    if name:
                        directions.append(
                            {"name": name, "reason": (d.get("reason") or "").strip()}
                        )
                elif isinstance(d, str) and d.strip():
                    directions.append({"name": d.strip(), "reason": ""})

        if directions:
            return directions

        # 兜底：解析 extensions 字段
        ext = detail_payload.get("extensions")
        if isinstance(ext, str) and ext.strip():
            # 按换行或顿号分割
            for part in re.split(r"[\n、；;,，]+", ext):
                part = part.strip()
                if part:
                    directions.append({"name": part, "reason": ""})
        elif isinstance(ext, list):
            for d in ext:
                if isinstance(d, dict) and (d.get("name") or "").strip():
                    directions.append(
                        {"name": d["name"].strip(), "reason": (d.get("reason") or "").strip()}
                    )
                elif isinstance(d, str) and d.strip():
                    directions.append({"name": d.strip(), "reason": ""})
        return directions

    async def _generate_directions_on_demand(
        self,
        node: dict[str, Any],
        graph_type: str,
        graph_id: str,
    ) -> list[dict[str, str]]:
        """当 detail_payload 无延伸方向时，调用 LLM 现场生成方向。"""
        client = await self._get_llm_client()
        if client is None:
            return []

        system_prompt = (
            "你是一个「延伸方向推荐器」。基于给定节点，推荐 3-6 个值得深入探索的"
            "延伸方向。输出严格 JSON：{\"directions\": [{\"name\", \"reason\"}]}。"
            "不要添加解释文字或 markdown 代码块。"
        )
        user_prompt = (
            f"节点标题：{node.get('title', '')}\n"
            f"节点概括：{node.get('summary', '')}\n"
            f"节点类型：{node.get('type', '')}\n"
            f"图谱模式：{graph_type}\n\n"
            "请推荐延伸方向，输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.5,
            request_id=await llm_request_registry.register(
                "generate_directions",
                node_id=node.get("id"),
                graph_id=graph_id,
                meta={"node_title": node.get("title", "")},
            ),
        )
        if result is None:
            return []
        dirs_raw = result.get("directions") if isinstance(result, dict) else None
        if not isinstance(dirs_raw, list):
            return []
        out: list[dict[str, str]] = []
        for d in dirs_raw:
            if isinstance(d, dict) and (d.get("name") or "").strip():
                out.append(
                    {"name": d["name"].strip()[:100], "reason": (d.get("reason") or "").strip()}
                )
            elif isinstance(d, str) and d.strip():
                out.append({"name": d.strip()[:100], "reason": ""})
        return out[:_EXTENSION_DIRECTIONS_MAX]

    def _fallback_extensions(
        self,
        directions: list[dict[str, str]],
        node: dict[str, Any],
        graph_type: str,
        existing_titles: list[str],
    ) -> list[dict[str, Any]]:
        """LLM 不可用时降级：把方向名直接作为延伸节点标题，标记 degraded。"""
        src_type = node.get("type", "")
        output: list[dict[str, Any]] = []
        for d in directions:
            name = d.get("name", "").strip()
            if not name:
                continue
            is_existing = any(_titles_similar(name, et) for et in existing_titles)
            output.append(
                {
                    "title": name[:255],
                    "summary": f"{node.get('title', '')}的延伸方向：{name}"
                    f"（LLM 不可用，仅生成占位节点）",
                    "type": src_type,
                    "is_gray": True,
                    "existing": is_existing,
                    "direction_name": name,
                    "source_node_id": node.get("id", ""),
                    "degraded": True,
                }
            )
        return output

    # ------------------------------------------------------------------
    # 4. 测验生成
    # ------------------------------------------------------------------

    async def generate_quiz(
        self,
        graph_id: str,
        node_ids: list[str] | None = None,
        quiz_type: str = "single_choice",
    ) -> dict[str, Any]:
        """基于图谱节点生成测验题。

        Args:
            graph_id: 所属图谱 ID。
            node_ids: 限定题目涉及的节点列表；None 则从全图随机选取。
            quiz_type: ``single_choice`` / ``multi_choice`` / ``feynman``。

        Returns:
            选择题：``{type, question, options, correct_answers, explanation, node_id}``
            费曼题：``{type, prompt, node_id, reference_points}``
            LLM 不可用时返回 ``{degraded: True, ...}`` 占位结构。
        """
        # 获取题目素材节点
        nodes = await self._collect_quiz_nodes(graph_id, node_ids)
        if not nodes:
            return {
                "type": quiz_type,
                "degraded": True,
                "degrade_reason": "无可用的节点素材",
                "node_id": "",
            }

        client = await self._get_llm_client()
        if client is None:
            return self._fallback_quiz(quiz_type, nodes)

        # 节点素材文本
        material = self._format_nodes_material(nodes)

        # 注册到 LLM 请求管理面板（统一 purpose=generate_quiz）
        primary_node_id = (
            nodes[0].get("id") if nodes and nodes[0].get("id") else None
        )
        request_id = await llm_request_registry.register(
            "generate_quiz",
            node_id=primary_node_id,
            graph_id=graph_id,
            meta={
                "quiz_type": quiz_type,
                "node_count": len(nodes),
            },
        )

        if quiz_type == "feynman":
            return await self._generate_feynman_quiz(
                client, graph_id, nodes, material, request_id=request_id
            )
        return await self._generate_choice_quiz(
            client, graph_id, nodes, material, quiz_type, request_id=request_id
        )

    async def _collect_quiz_nodes(
        self, graph_id: str, node_ids: list[str] | None
    ) -> list[dict[str, Any]]:
        """收集用于出题的节点列表。"""
        if node_ids:
            nodes: list[dict[str, Any]] = []
            for nid in node_ids[:5]:
                n = await self.store.get_node(nid)
                if n and n.get("graph_id") == graph_id:
                    nodes.append(n)
            return nodes
        # 无指定：取图谱前若干节点
        all_nodes = await self.store.list_nodes(graph_id)
        # 优先取非灰色节点（已有详情）
        non_gray = [n for n in all_nodes if not n.get("is_gray")]
        pool = non_gray or all_nodes
        return pool[:5]

    def _format_nodes_material(self, nodes: list[dict[str, Any]]) -> str:
        """把节点列表格式化为出题素材文本。"""
        parts: list[str] = []
        for i, n in enumerate(nodes, 1):
            title = n.get("title", "")
            summary = n.get("summary", "")
            detail = n.get("detail_payload") or {}
            detail_brief = {
                k: v for k, v in detail.items() if v not in ("", None, [], {})
            }
            line = f"{i}. {title}"
            if summary:
                line += f"：{summary}"
            if detail_brief:
                try:
                    line += "\n   " + json.dumps(detail_brief, ensure_ascii=False)
                except (TypeError, ValueError):
                    pass
            parts.append(line)
        return "\n".join(parts)

    async def _generate_choice_quiz(
        self,
        client: LLMClient,
        graph_id: str,
        nodes: list[dict[str, Any]],
        material: str,
        quiz_type: str,
        *,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """生成选择题（单选 / 多选）。"""
        is_multi = quiz_type == "multi_choice"
        answer_count = "2-4 个" if is_multi else "1 个"

        system_prompt = (
            "你是一个「测验题出题器」。基于给定知识点素材出一道"
            f"{'多选' if is_multi else '单选'}题。输出严格 JSON，不要添加解释文字"
            "或 markdown 代码块。\n\n"
            "输出字段：\n"
            "- question: 题干\n"
            "- options: 选项数组，每项为 {\"id\": \"A\"|\"B\"|\"C\"|\"D\", \"text\": \"选项内容\"}\n"
            "- correct_answers: 正确选项 id 数组（"
            f"{answer_count}）\n"
            "- explanation: 答案解析\n"
            "- node_id: 题目主要考查的节点标题（用于回填）\n"
            "要求：4 个选项（A/B/C/D），干扰项应具有迷惑性但明确错误。\n"
        )
        user_prompt = (
            f"图谱 ID：{graph_id}\n"
            f"题型：{quiz_type}\n\n"
            f"知识点素材：\n{material}\n\n"
            "请输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.4,
            request_id=request_id,
        )
        if result is None:
            return self._fallback_quiz(quiz_type, nodes)

        options = result.get("options") or []
        if not isinstance(options, list):
            options = []
        # 规范化 options
        norm_options = []
        for opt in options:
            if isinstance(opt, dict):
                norm_options.append(
                    {
                        "id": (opt.get("id") or "").strip(),
                        "text": (opt.get("text") or "").strip(),
                    }
                )

        correct = result.get("correct_answers") or []
        if not isinstance(correct, list):
            correct = [correct] if correct else []
        correct = [str(c).strip() for c in correct if c]

        # 单选题确保只有一个正确答案
        if not is_multi and len(correct) > 1:
            correct = correct[:1]
        if is_multi and len(correct) < 2 and norm_options:
            # 多选题兜底：至少 2 个
            correct = correct or [norm_options[0].get("id", "A")]

        primary_node = nodes[0] if nodes else {}
        return {
            "type": quiz_type,
            "question": (result.get("question") or "").strip(),
            "options": norm_options,
            "correct_answers": correct,
            "explanation": (result.get("explanation") or "").strip(),
            "node_id": primary_node.get("id", ""),
            "degraded": False,
        }

    async def _generate_feynman_quiz(
        self,
        client: LLMClient,
        graph_id: str,
        nodes: list[dict[str, Any]],
        material: str,
        *,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """生成费曼解释题。"""
        primary = nodes[0] if nodes else {}
        title = primary.get("title", "")

        system_prompt = (
            "你是一个「费曼解释题出题器」。基于给定知识点出一道费曼题，要求用户"
            "用自己的话解释该知识点。输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出字段：\n"
            "- prompt: 题目提示语（如「请用自己的话解释 XX」）\n"
            "- reference_points: 参考要点数组（3-6 个，每个为字符串），用于后续判分\n"
            "- node_id: 题目主要考查的节点标题\n"
        )
        user_prompt = (
            f"图谱 ID：{graph_id}\n\n"
            f"知识点素材：\n{material}\n\n"
            "请输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.4,
            request_id=request_id,
        )
        if result is None:
            return self._fallback_quiz("feynman", nodes)

        ref_points = result.get("reference_points") or []
        if not isinstance(ref_points, list):
            ref_points = []
        ref_points = [str(p).strip() for p in ref_points if p]

        return {
            "type": "feynman",
            "prompt": (result.get("prompt") or f"请用自己的话解释 {title}").strip(),
            "node_id": primary.get("id", ""),
            "reference_points": ref_points,
            "degraded": False,
        }

    def _fallback_quiz(
        self, quiz_type: str, nodes: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """LLM 不可用时的测验降级结构。"""
        primary = nodes[0] if nodes else {}
        title = primary.get("title", "")
        if quiz_type == "feynman":
            return {
                "type": "feynman",
                "prompt": f"请用自己的话解释 {title}" if title else "（题目生成服务暂不可用，请稍后重试）",
                "node_id": primary.get("id", ""),
                "reference_points": [],
                "degraded": True,
                "degrade_reason": "LLM 服务暂不可用，当前为占位题。配置好 LLM 后重新生成即可获得正常题目。",
            }
        # 选择题降级：提供4个占位选项，正确答案为A（明确告知用户这是占位题）
        node_title = title or "当前知识点"
        return {
            "type": quiz_type,
            "question": f"【占位题】关于「{node_title}」，以下哪项描述正确？（LLM 服务暂不可用，请配置后重试）",
            "options": [
                {"id": "A", "text": f"这是关于{node_title}的占位选项（服务恢复后可重新生成）"},
                {"id": "B", "text": "占位选项 B"},
                {"id": "C", "text": "占位选项 C"},
                {"id": "D", "text": "占位选项 D"},
            ],
            "correct_answers": ["A"],
            "explanation": "本题为 LLM 服务不可用时的降级占位题，答案固定为 A。请检查 LLM 配置后重新生成测验题。",
            "node_id": primary.get("id", ""),
            "degraded": True,
            "degrade_reason": "LLM 服务暂不可用，当前为占位题。配置好 LLM 后重新生成即可获得正常题目。",
        }

    # ------------------------------------------------------------------
    # 5. 费曼判分
    # ------------------------------------------------------------------

    async def grade_feynman(
        self, quiz_id: str, user_answer: str
    ) -> dict[str, Any]:
        """对费曼题用户回答进行语义判分。

        Args:
            quiz_id: 测验 ID。
            user_answer: 用户回答文本。

        Returns:
            ``{score, understanding_level, feedback, missed_points}``
            LLM 不可用时返回基于关键词匹配的降级判分。
        """
        quiz = await self.store.get_quiz(quiz_id)
        if quiz is None:
            return {
                "score": 0,
                "understanding_level": "poor",
                "feedback": "测验不存在",
                "missed_points": [],
                "degraded": True,
                "degrade_reason": "测验不存在",
            }

        if quiz.get("type") != "feynman":
            return {
                "score": 0,
                "understanding_level": "poor",
                "feedback": "该测验不是费曼题，无法判分",
                "missed_points": [],
                "degraded": True,
            }

        payload = quiz.get("payload") or {}
        reference_points = payload.get("reference_points") or []
        prompt = payload.get("prompt") or ""

        if not user_answer.strip():
            return {
                "score": 0,
                "understanding_level": "poor",
                "feedback": "用户回答为空",
                "missed_points": reference_points,
                "degraded": False,
            }

        client = await self._get_llm_client()
        if client is None:
            return self._fallback_grade_feynman(user_answer, reference_points)

        system_prompt = (
            "你是一个「费曼解释题判分器」。基于参考要点对用户的解释进行语义判分。"
            "输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出字段：\n"
            "- score: 0-100 整数\n"
            "- understanding_level: \"good\" | \"partial\" | \"poor\"\n"
            "  （good: >=80, partial: 50-79, poor: <50）\n"
            "- feedback: 反馈文本（指出优点与不足）\n"
            "- missed_points: 未覆盖的参考要点数组\n"
            "判分标准：语义覆盖度（不是关键词匹配），表述清晰度，准确性。\n"
        )
        user_prompt = (
            f"题目：{prompt}\n\n"
            f"参考要点：\n"
            + "\n".join(f"- {p}" for p in reference_points)
            + "\n\n"
            f"用户回答：\n{user_answer[:4000]}\n\n"
            "请输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.2,
            request_id=await llm_request_registry.register(
                "grade_feynman",
                meta={
                    "quiz_id": quiz_id,
                    "answer_length": len(user_answer),
                },
            ),
        )
        if result is None:
            return self._fallback_grade_feynman(user_answer, reference_points)

        try:
            score = int(result.get("score", 0))
        except (TypeError, ValueError):
            score = 0
        score = max(0, min(100, score))

        level = result.get("understanding_level", "poor")
        if level not in ("good", "partial", "poor"):
            level = "good" if score >= 80 else ("partial" if score >= 50 else "poor")

        missed = result.get("missed_points") or []
        if not isinstance(missed, list):
            missed = [str(missed)] if missed else []
        missed = [str(m).strip() for m in missed if m]

        return {
            "score": score,
            "understanding_level": level,
            "feedback": (result.get("feedback") or "").strip(),
            "missed_points": missed,
            "degraded": False,
        }

    def _fallback_grade_feynman(
        self, user_answer: str, reference_points: list[str]
    ) -> dict[str, Any]:
        """LLM 不可用时基于关键词覆盖率的降级判分。"""
        if not reference_points:
            return {
                "score": 50,
                "understanding_level": "partial",
                "feedback": "（LLM 不可用，无法进行语义判分，默认给中等分数）",
                "missed_points": [],
                "degraded": True,
                "degrade_reason": "LLM 不可用",
            }
        answer_lower = user_answer.lower()
        covered = 0
        missed: list[str] = []
        for point in reference_points:
            # 简单关键词匹配：取要点中长度 >=2 的词
            keywords = re.findall(r"[\w\u4e00-\u9fff]{2,}", point.lower())
            if keywords and any(kw in answer_lower for kw in keywords):
                covered += 1
            else:
                missed.append(point)
        ratio = covered / len(reference_points)
        score = int(ratio * 100)
        level = "good" if score >= 80 else ("partial" if score >= 50 else "poor")
        return {
            "score": score,
            "understanding_level": level,
            "feedback": f"（LLM 不可用，基于关键词覆盖率判分：覆盖 {covered}/{len(reference_points)} 个要点）",
            "missed_points": missed,
            "degraded": True,
            "degrade_reason": "LLM 不可用",
        }

    # ------------------------------------------------------------------
    # 6. 行业风口生成
    # ------------------------------------------------------------------

    async def generate_trends(self, graph_id: str) -> list[dict[str, Any]]:
        """基于当前 work 图谱分析并生成行业风口推荐。

        Args:
            graph_id: work 图谱 ID。

        Returns:
            ``[{title, reason, relevance, suggested_actions}]``
            LLM 不可用时返回空列表。
        """
        graph = await self.store.get_graph(graph_id)
        if graph is None:
            return []
        if graph.get("type") != GRAPH_TYPE_WORK:
            logger.warning("GraphAgent: generate_trends 仅支持 work 图谱")
            return []

        context = await self._build_context(graph_id)
        client = await self._get_llm_client()
        if client is None:
            return []

        system_prompt = (
            "你是一个「行业风口分析师」。基于用户的工作图谱（含线索/关键人/承诺/"
            "事件/决策/风险等），分析当前工作方向可能对应的行业风口与机会。"
            "输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出格式：{\"trends\": [{\"title\", \"reason\", \"relevance\", "
            "\"suggested_actions\"}]}\n"
            "字段要求：\n"
            "- title: 风口/机会名称（简洁）\n"
            "- reason: 为何认为这是风口（结合图谱内容）\n"
            "- relevance: 与用户工作的相关度 \"high\" | \"medium\" | \"low\"\n"
            "- suggested_actions: 建议行动数组（2-4 个具体动作）\n"
            "推荐 3-5 个风口。\n"
        )
        user_prompt = (
            f"当前工作图谱上下文：\n{context[:6000]}\n\n"
            "请分析并输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.6,
            request_id=await llm_request_registry.register(
                "generate_trends",
                graph_id=graph_id,
            ),
        )
        if result is None:
            return []

        trends_raw = result.get("trends") if isinstance(result, dict) else None
        if not isinstance(trends_raw, list):
            return []

        output: list[dict[str, Any]] = []
        for t in trends_raw:
            if not isinstance(t, dict):
                continue
            title = (t.get("title") or "").strip()
            if not title:
                continue
            relevance = t.get("relevance", "medium")
            if relevance not in ("high", "medium", "low"):
                relevance = "medium"
            actions = t.get("suggested_actions") or []
            if not isinstance(actions, list):
                actions = [str(actions)] if actions else []
            actions = [str(a).strip() for a in actions if a]
            output.append(
                {
                    "title": title[:255],
                    "reason": (t.get("reason") or "").strip()[:1000],
                    "relevance": relevance,
                    "suggested_actions": actions,
                }
            )
        return output

    # ------------------------------------------------------------------
    # 7. 工作报告生成
    # ------------------------------------------------------------------

    async def generate_report(
        self, graph_id: str, period: str = "weekly"
    ) -> dict[str, Any]:
        """基于当前 work 图谱生成工作报告。

        Args:
            graph_id: work 图谱 ID。
            period: 报告周期（``weekly`` / ``monthly`` 等）。

        Returns:
            ``{markdown, sections: {progress, plan, risks, commitments}}``
            LLM 不可用时返回兜底报告。
        """
        graph = await self.store.get_graph(graph_id)
        if graph is None:
            return self._fallback_report(graph_id, period, "图谱不存在")
        if graph.get("type") != GRAPH_TYPE_WORK:
            return self._fallback_report(graph_id, period, "仅支持 work 图谱")

        context = await self._build_context(graph_id)
        client = await self._get_llm_client()
        if client is None:
            return self._fallback_report(graph_id, period, "LLM 不可用")

        period_label = {"weekly": "周报", "monthly": "月报"}.get(period, "报告")

        system_prompt = (
            f"你是一个「工作报告撰写助手」。基于用户的工作图谱，生成一份结构化的"
            f"{period_label}。输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出字段：\n"
            "- markdown: 完整的 Markdown 格式报告\n"
            "- sections: 结构化分段对象\n"
            "  - progress: 进展数组（已完成 / 推进中的工作）\n"
            "  - plan: 计划数组（下一步计划）\n"
            "  - risks: 风险数组（识别到的风险）\n"
            "  - commitments: 承诺数组（待兑现的承诺与截止）\n"
            "报告应基于图谱中的节点信息，不要编造不存在的事实。\n"
        )
        user_prompt = (
            f"报告周期：{period}（{period_label}）\n\n"
            f"工作图谱上下文：\n{context[:6000]}\n\n"
            "请生成报告，输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.5,
            request_id=await llm_request_registry.register(
                "generate_report",
                graph_id=graph_id,
                meta={"period": period},
            ),
        )
        if result is None:
            return self._fallback_report(graph_id, period, "LLM 返回解析失败")

        sections = result.get("sections") or {}
        if not isinstance(sections, dict):
            sections = {}
        # 规范化各段
        norm_sections: dict[str, list[str]] = {}
        for key in ("progress", "plan", "risks", "commitments"):
            val = sections.get(key) or []
            if not isinstance(val, list):
                val = [str(val)] if val else []
            norm_sections[key] = [str(v).strip() for v in val if v]

        markdown = (result.get("markdown") or "").strip()
        if not markdown:
            # 用 sections 拼一个兜底 markdown
            markdown = self._sections_to_markdown(norm_sections, period_label)

        return {
            "markdown": markdown,
            "sections": norm_sections,
            "period": period,
            "degraded": False,
        }

    def _sections_to_markdown(
        self, sections: dict[str, list[str]], period_label: str
    ) -> str:
        """把结构化分段拼成 Markdown 报告。"""
        lines: list[str] = [f"# 工作{period_label}", ""]
        labels = {
            "progress": "本期进展",
            "plan": "下期计划",
            "risks": "风险提示",
            "commitments": "待兑现承诺",
        }
        for key, label in labels.items():
            items = sections.get(key) or []
            lines.append(f"## {label}")
            if not items:
                lines.append("- （无）")
            else:
                for it in items:
                    lines.append(f"- {it}")
            lines.append("")
        return "\n".join(lines)

    def _fallback_report(
        self, graph_id: str, period: str, reason: str
    ) -> dict[str, Any]:
        """LLM 不可用时的兜底报告。"""
        period_label = {"weekly": "周报", "monthly": "月报"}.get(period, "报告")
        return {
            "markdown": f"# 工作{period_label}\n\n（报告生成服务暂不可用：{reason}）\n",
            "sections": {
                "progress": [],
                "plan": [],
                "risks": [],
                "commitments": [],
            },
            "period": period,
            "degraded": True,
            "degrade_reason": reason,
        }

    # ------------------------------------------------------------------
    # 8. 提问回答
    # ------------------------------------------------------------------

    async def answer_question(
        self, graph_id: str, question: str
    ) -> dict[str, Any]:
        """基于工作图谱上下文回答用户提问。

        Args:
            graph_id: 图谱 ID。
            question: 用户提问。

        Returns:
            ``{answer, sources, confidence}``
            LLM 不可用时返回兜底回答。
        """
        if not question.strip():
            return {
                "answer": "问题为空",
                "sources": [],
                "confidence": 0.0,
                "degraded": True,
            }

        context = await self._build_context(graph_id)
        client = await self._get_llm_client()
        if client is None:
            return {
                "answer": "（问答服务暂不可用：LLM 未配置）",
                "sources": [],
                "confidence": 0.0,
                "degraded": True,
                "degrade_reason": "LLM 不可用",
            }

        system_prompt = (
            "你是一个「工作图谱问答助手」。基于用户的工作图谱上下文回答提问。"
            "输出严格 JSON，不要解释文字或代码块。\n\n"
            "输出字段：\n"
            "- answer: 回答文本（基于图谱内容，不要编造）\n"
            "- sources: 引用来源数组，每项为 {\"node_title\", \"relevance\": \"high\"|\"medium\"|\"low\"}\n"
            "- confidence: 置信度 0.0-1.0（图谱中无相关信息时给低值）\n"
            "若图谱中无相关信息，answer 应说明无法回答，confidence 给低值。\n"
        )
        user_prompt = (
            f"工作图谱上下文：\n{context[:6000]}\n\n"
            f"用户提问：{question}\n\n"
            "请输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.4,
            request_id=await llm_request_registry.register(
                "answer_question",
                graph_id=graph_id,
                meta={"question_length": len(question)},
            ),
        )
        if result is None:
            return {
                "answer": "（问答服务返回解析失败）",
                "sources": [],
                "confidence": 0.0,
                "degraded": True,
                "degrade_reason": "LLM 返回解析失败",
            }

        sources_raw = result.get("sources") or []
        if not isinstance(sources_raw, list):
            sources_raw = []
        sources: list[dict[str, Any]] = []
        for s in sources_raw:
            if isinstance(s, dict):
                title = (s.get("node_title") or "").strip()
                if title:
                    rel = s.get("relevance", "medium")
                    if rel not in ("high", "medium", "low"):
                        rel = "medium"
                    sources.append({"node_title": title, "relevance": rel})

        # TODO: 提问命中节点时调用 self.store.incr_mention(node_id) 累加提及计数。
        #       当前 sources 仅含 node_title，需按标题在 graph_id 下查表解析为
        #       node_id 后再调用 incr_mention，涉及跨图谱重名与模糊匹配等边界，
        #       暂留待后续实现（避免过度修改 Agent 主流程）。

        try:
            confidence = float(result.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))

        return {
            "answer": (result.get("answer") or "").strip(),
            "sources": sources,
            "confidence": confidence,
            "degraded": False,
        }

    # ------------------------------------------------------------------
    # 9. 工作对象抽取
    # ------------------------------------------------------------------

    async def extract_work_objects(
        self, text: str, graph_id: str
    ) -> list[dict[str, Any]]:
        """从用户输入文本中抽取工作对象。

        Args:
            text: 用户输入文本。
            graph_id: 所属 work 图谱 ID（用于去重与上下文）。

        Returns:
            ``[{title, summary, type, relations: [{to_title, relation}]}]``
            LLM 不可用时返回空列表。
        """
        if not text.strip():
            return []

        # 获取现有节点标题，供 LLM 去重参考
        existing_nodes = await self.store.list_nodes(graph_id)
        existing_brief = [
            f"- [{n.get('type', '')}] {n.get('title', '')}"
            for n in existing_nodes[:50]
            if n.get("title")
        ]
        existing_desc = "\n".join(existing_brief) if existing_brief else "（图谱暂无节点）"

        client = await self._get_llm_client()
        if client is None:
            return []

        system_prompt = (
            "你是一个「工作对象抽取器」。从用户输入文本中识别工作对象（线索/关键人/"
            "承诺/期望/事件/决策/风险/资料/偏好/复盘）及其关系。输出严格 JSON，"
            "不要解释文字或代码块。\n\n"
            "输出格式：{\"objects\": [{\"title\", \"summary\", \"type\", "
            "\"relations\": [{\"to_title\", \"relation\"}]}]}\n"
            "字段要求：\n"
            "- title: 对象名称（简洁，<=30 字）\n"
            "- summary: 一句话概括（<=60 字）\n"
            "- type: 必须从枚举中选择\n"
            "- relations: 与其他对象的关系数组（to_title 为另一对象标题，"
            "relation 从给定枚举选择；可为空数组）\n"
            f"- type 枚举：{list(WORK_OBJECTS)}\n"
            f"- relation 枚举：related/belongs_to/involves/committed_to/depends_on/"
            "waiting_for/influences/source_of/alternative_to\n"
            "要求：\n"
            "1. 同一对象只抽取一次\n"
            "2. 已存在于图谱中的对象（见下方列表）可仍抽取但需在 relations 中"
            "关联到现有对象标题\n"
            "3. relations 中的 to_title 可以是本次抽取的其他对象标题，也可以是"
            "现有图谱节点标题\n"
        )
        user_prompt = (
            f"图谱现有节点：\n{existing_desc}\n\n"
            f"用户输入：\n{text[:6000]}\n\n"
            "请抽取工作对象，输出 JSON："
        )
        result = await self._call_llm_json(
            client,
            system_prompt,
            user_prompt,
            temperature=0.3,
            request_id=await llm_request_registry.register(
                "extract_work_objects",
                graph_id=graph_id,
                meta={"text_length": len(text)},
            ),
        )
        if result is None:
            return []

        objects_raw = result.get("objects") if isinstance(result, dict) else None
        if not isinstance(objects_raw, list):
            return []

        valid_types = set(WORK_OBJECTS)
        valid_relations = {
            "related", "belongs_to", "involves", "committed_to", "depends_on",
            "waiting_for", "influences", "source_of", "alternative_to",
            "prerequisite", "extends",
        }
        output: list[dict[str, Any]] = []
        for obj in objects_raw:
            if not isinstance(obj, dict):
                continue
            title = (obj.get("title") or "").strip()
            if not title:
                continue
            otype = obj.get("type") or ""
            if otype not in valid_types:
                otype = "thread"  # 兜底为线索
            relations_raw = obj.get("relations") or []
            if not isinstance(relations_raw, list):
                relations_raw = []
            relations: list[dict[str, str]] = []
            for r in relations_raw:
                if isinstance(r, dict):
                    to_title = (r.get("to_title") or "").strip()
                    if not to_title:
                        continue
                    rel = r.get("relation") or "related"
                    if rel not in valid_relations:
                        rel = "related"
                    relations.append({"to_title": to_title[:255], "relation": rel})
            output.append(
                {
                    "title": title[:255],
                    "summary": (obj.get("summary") or "").strip()[:500],
                    "type": otype,
                    "relations": relations,
                }
            )
        return output

    # ------------------------------------------------------------------
    # 流式方法
    # ------------------------------------------------------------------

    async def _stream_llm(
        self,
        client: LLMClient,
        messages: list[dict[str, Any]],
        *,
        op: str,
        graph_id: str,
        session_id: str | None = None,
        node_id: str | None = None,
        temperature: float = 0.6,
        request_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """通用流式 LLM 调用：逐 token 产出并推送 WS。

        yields:
            ``{"type": "token", "content": "..."}`` 每个 token
            ``{"type": "done", "full_text": "..."}`` 完成
            ``{"type": "cancelled", "full_text": "..."}`` 被外部取消
            ``{"type": "error", "message": "..."}`` 失败
        """
        ws_target = session_id or graph_id
        full_text_parts: list[str] = []
        seq = 0
        try:
            async for event in client.chat_stream(
                messages, temperature=temperature, request_id=request_id
            ):
                etype = event.get("type")
                if etype == "token":
                    chunk = event.get("content", "")
                    if chunk:
                        full_text_parts.append(chunk)
                        yield {"type": "token", "content": chunk}
                        # 推送 WS
                        ws_event: dict[str, Any] = {
                            "type": "graph_agent_token",
                            "op": op,
                            "graph_id": graph_id,
                            "content": chunk,
                            "seq": seq,
                        }
                        if node_id:
                            ws_event["node_id"] = node_id
                        seq += 1
                        try:
                            await notify_session(ws_target, ws_event)
                        except Exception as exc:  # noqa: BLE001
                            logger.debug(
                                "GraphAgent: WS token 推送失败 op=%s: %s",
                                op,
                                exc,
                            )
                elif etype == "cancelled":
                    # 流式被外部 cancel：通知 WS 并产出 cancelled 事件
                    full_text = "".join(full_text_parts)
                    cancel_event: dict[str, Any] = {
                        "type": "graph_agent_cancelled",
                        "op": op,
                        "graph_id": graph_id,
                        "full_text": full_text,
                    }
                    if node_id:
                        cancel_event["node_id"] = node_id
                    try:
                        await notify_session(ws_target, cancel_event)
                    except Exception as exc:  # noqa: BLE001
                        logger.debug(
                            "GraphAgent: WS cancel 推送失败 op=%s: %s", op, exc
                        )
                    yield {"type": "cancelled", "full_text": full_text}
                    return
                elif etype == "finish":
                    break
        except LLMError as exc:
            logger.warning("GraphAgent: 流式调用失败 op=%s: %s", op, exc)
            err_event = {
                "type": "graph_agent_error",
                "op": op,
                "graph_id": graph_id,
                "message": str(exc),
            }
            try:
                await notify_session(ws_target, err_event)
            except Exception:  # noqa: BLE001
                pass
            yield {"type": "error", "message": str(exc)}
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning("GraphAgent: 流式调用异常 op=%s: %s", op, exc)
            yield {"type": "error", "message": str(exc)}
            return

        full_text = "".join(full_text_parts)
        done_event: dict[str, Any] = {
            "type": "graph_agent_done",
            "op": op,
            "graph_id": graph_id,
            "full_text": full_text,
        }
        if node_id:
            done_event["node_id"] = node_id
        try:
            await notify_session(ws_target, done_event)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "GraphAgent: WS done 推送失败 op=%s: %s", op, exc
            )
        yield {"type": "done", "full_text": full_text}

    async def generate_node_detail_stream(
        self,
        node_title: str,
        node_type: str,
        graph_type: str,
        neighbors: list[dict[str, Any]] | None = None,
        session_id: str | None = None,
        *,
        node_id: str | None = None,
        graph_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """节点详情卡的流式版本。

        yields:
            ``{"type": "token", "content": "..."}`` 每个 token
            ``{"type": "done", "full_text": "..."}`` 完成
            ``{"type": "cancelled", "full_text": "..."}`` 被外部取消
            ``{"type": "error", "message": "..."}`` 失败

        流式产出详情卡的 Markdown 文本（包含概括、重要点、延伸方向）。
        """
        client = await self._get_llm_client()
        if client is None:
            yield {
                "type": "error",
                "message": "LLM 不可用",
            }
            return

        template, template_used = self._resolve_template(graph_type, node_type)
        template_desc = self._format_template_fields(template)
        neighbor_desc = ""
        if neighbors:
            parts = [
                f"- [{nb.get('type', '')}] {nb.get('title', '')}"
                for nb in neighbors[:10]
            ]
            neighbor_desc = "邻居节点：\n" + "\n".join(parts)

        system_prompt = (
            "你是一个「知识详情卡生成器」。基于节点标题与上下文，以 Markdown 格式"
            "输出详情卡内容，包含以下小节：\n"
            "## 概括\n## 重要点\n## 延伸方向\n\n"
            "重要点 3-6 个，延伸方向 3-6 个（每个附简短理由）。"
            "直接输出 Markdown，不要包裹在代码块中。\n"
        )
        user_prompt = (
            f"节点标题：{node_title}\n"
            f"节点类型：{node_type}\n"
            f"图谱模式：{graph_type}\n\n"
            f"详情卡模板字段（参考）：\n{template_desc}\n\n"
        )
        if neighbor_desc:
            user_prompt += neighbor_desc + "\n\n"
        user_prompt += "请输出详情卡 Markdown："

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        request_id = await llm_request_registry.register(
            "generate_node_detail_stream",
            node_id=node_id,
            graph_id=graph_id,
            meta={"node_title": node_title, "node_type": node_type},
        )

        async for event in self._stream_llm(
            client,
            messages,
            op="generate_node_detail",
            graph_id=graph_id or "",
            session_id=session_id,
            node_id=node_id,
            temperature=0.5,
            request_id=request_id,
        ):
            yield event

    async def answer_question_stream(
        self,
        graph_id: str,
        question: str,
        session_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """问答的流式版本。

        yields:
            ``{"type": "token", "content": "..."}`` 每个 token
            ``{"type": "done", "full_text": "..."}`` 完成
            ``{"type": "cancelled", "full_text": "..."}`` 被外部取消
            ``{"type": "error", "message": "..."}`` 失败
        """
        if not question.strip():
            yield {"type": "error", "message": "问题为空"}
            return

        context = await self._build_context(graph_id)
        client = await self._get_llm_client()
        if client is None:
            yield {"type": "error", "message": "LLM 不可用"}
            return

        system_prompt = (
            "你是一个「工作图谱问答助手」。基于用户的工作图谱上下文回答提问。"
            "直接输出回答文本（Markdown 格式），不要包裹在代码块中。"
            "若图谱中无相关信息，明确说明无法回答。不要编造不存在的事实。\n"
        )
        user_prompt = (
            f"工作图谱上下文：\n{context[:6000]}\n\n"
            f"用户提问：{question}\n\n"
            "请回答："
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        request_id = await llm_request_registry.register(
            "answer_question_stream",
            graph_id=graph_id,
            meta={"question_length": len(question)},
        )

        async for event in self._stream_llm(
            client,
            messages,
            op="answer_question",
            graph_id=graph_id,
            session_id=session_id,
            temperature=0.4,
            request_id=request_id,
        ):
            yield event

    async def generate_report_stream(
        self,
        graph_id: str,
        period: str = "weekly",
        session_id: str | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """工作报告的流式版本。

        yields:
            ``{"type": "token", "content": "..."}`` 每个 token
            ``{"type": "done", "full_text": "..."}`` 完成
            ``{"type": "cancelled", "full_text": "..."}`` 被外部取消
            ``{"type": "error", "message": "..."}`` 失败
        """
        graph = await self.store.get_graph(graph_id)
        if graph is None:
            yield {"type": "error", "message": "图谱不存在"}
            return
        if graph.get("type") != GRAPH_TYPE_WORK:
            yield {"type": "error", "message": "仅支持 work 图谱"}
            return

        context = await self._build_context(graph_id)
        client = await self._get_llm_client()
        if client is None:
            yield {"type": "error", "message": "LLM 不可用"}
            return

        period_label = {"weekly": "周报", "monthly": "月报"}.get(period, "报告")
        system_prompt = (
            f"你是一个「工作报告撰写助手」。基于用户的工作图谱，以 Markdown 格式"
            f"输出一份结构化的{period_label}，包含以下小节：\n"
            "## 本期进展\n## 下期计划\n## 风险提示\n## 待兑现承诺\n\n"
            "直接输出 Markdown，不要包裹在代码块中。基于图谱中的节点信息，"
            "不要编造不存在的事实。\n"
        )
        user_prompt = (
            f"报告周期：{period}（{period_label}）\n\n"
            f"工作图谱上下文：\n{context[:6000]}\n\n"
            "请生成报告 Markdown："
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        request_id = await llm_request_registry.register(
            "generate_report_stream",
            graph_id=graph_id,
            meta={"period": period},
        )

        async for event in self._stream_llm(
            client,
            messages,
            op="generate_report",
            graph_id=graph_id,
            session_id=session_id,
            temperature=0.5,
            request_id=request_id,
        ):
            yield event


# ============================================================================
# 全局单例
# ============================================================================

#: 全局 GraphAgent 单例（无状态，所有方法按调用获取 LLM 客户端）
graph_agent = GraphAgent()


def get_graph_agent() -> GraphAgent:
    """依赖注入：返回全局 GraphAgent 单例。

    抽成函数便于后续在测试中替换依赖。
    """
    return graph_agent


def init_graph_agent() -> GraphAgent:
    """显式初始化全局 GraphAgent（在 main.py lifespan 启动时调用）。

    GraphAgent 本身无状态，本函数主要确保模块已加载、单例已构造，
    便于在启动日志中确认 Agent 服务就绪。
    """
    logger.info("GraphAgent 已初始化（graph_agent 单例就绪）")
    return graph_agent

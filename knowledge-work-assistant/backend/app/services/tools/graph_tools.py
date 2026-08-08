"""图谱工具封装（Task 7 + 本土化扩展）：把 GraphAgent / GraphStore / KWA 业务
路由能力包装为 Function Calling 工具。

提供 21 个图谱工具，每个工具 handler 签名统一为 ``(args: dict) -> dict``，
供 :class:`app.services.tool_registry.ToolRegistry` 注册：

**基础图谱工具（7 个，Task 7）**

- ``graph_query_nodes``：按关键词查询图谱节点（只读，plan/build 均可用）
- ``graph_get_node_detail``：获取节点详情（只读，plan/build 均可用）
- ``graph_get_context``：获取图谱全貌上下文（只读，plan/build 均可用）
- ``graph_extract_from_observation``：从观察对话抽取节点（**高风险**，仅 build；
  plan 模式由 ``main_agent._intercept_high_risk_tool`` 直接拒绝，build 模式弹确认框）
- ``graph_generate_quiz``：基于图谱生成测验题（只读，plan/build 均可用）
- ``graph_generate_trends``：分析行业风口（只读，仅 work 图谱；plan/build 均可用）
- ``graph_generate_report``：生成工作报告（只读，仅 work 图谱；plan/build 均可用）

**节点行为工具（6 个，本土化扩展）**

- ``graph_extend_node``：节点延伸生成并落库（写入，仅 build）
- ``graph_touch_node``：标记复习（更新 last_reviewed_at + review_count；写入，仅 build）
- ``graph_star_node`` / ``graph_unstar_node``：星标管理（写入，仅 build）
- ``graph_set_reminder`` / ``graph_clear_reminder``：提醒管理（写入，仅 build）

**学习闭环工具（4 个，本土化扩展）**

- ``graph_answer_quiz``：测验作答并判分（写入；仅 build）
- ``graph_list_quiz_history``：测验历史（只读，plan/build 均可用）
- ``graph_get_quiz_detail``：测验详情（只读，已剥离答案字段；plan/build 均可用）
- ``graph_add_user_fill``：留白追加（写入；仅 build）

**智能推荐工具（1 个，本土化扩展）**

- ``graph_get_recommendations``：智能推荐（只读，plan/build 均可用）

**工作对象工具（2 个，本土化扩展）**

- ``graph_extract_work_objects``：抽取工作对象候选（只读，不入图；plan/build 均可用）
- ``graph_confirm_work_objects``：确认批量入图（**高风险**，仅 build）

**观察记录工具（1 个，本土化扩展）**

- ``graph_list_observations``：列出观察记录（只读，plan/build 均可用）

设计要点：

- **延迟导入**：``graph_agent`` / ``graph_store`` 在 handler 内部导入，避免
  ``tool_registry.register_default_tools`` → ``register_graph_tools`` →
  ``graph_agent`` 的循环依赖（``MainAgent.__init__`` 同时 import graph_agent
  与 tool_registry）。
- **统一错误兜底**：每个 handler 捕获所有异常返回 ``{"status": "error", ...}``，
  不抛异常给工具循环（对齐 ``ToolRegistry.execute`` 的契约）。
- **模式白名单**：``HIGH_RISK_TOOLS`` 含 ``graph_extract_from_observation`` 与
  ``graph_confirm_work_objects`` 两个高风险工具，供 ``main_agent`` 拦截逻辑查询；
  ``get_tools_for_mode`` 提供按场景模式（study/work）+ plan_mode 的白名单过滤。
- **落库策略**：
  - 只读工具（query/get/list/get_recommendations/extract_work_objects）
    不直接落库，返回结果给 agent。
  - 写入工具（extend/touch/star/remind/user_fill/answer_quiz）落库到图谱
    节点 / 边 / 测验，全部仅 build 可用。
  - 高风险工具（extract_from_observation / confirm_work_objects）落库新节点。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

# ============================================================================
# 高风险工具集合（SubTask 7.5）
# ============================================================================

#: 高风险工具集合：会修改图谱状态的工具，调用前需用户确认。
#:
#: - ``graph_extract_from_observation``：抽取节点会向图谱写入新节点，
#:   属于修改性操作，标记为高风险。
#: - ``graph_confirm_work_objects``：批量创建工作对象节点 + 边到图谱，
#:   属于修改性操作，标记为高风险。
#:
#: 供 :mod:`app.services.main_agent` 的 ``_intercept_high_risk_tool`` 查询：
#: - Plan 模式：直接拒绝（不弹框）
#: - Build 模式：通过 WS 推送 ``chat_tool_call_confirmation``，等待用户确认 / 60s 超时
HIGH_RISK_TOOLS: set[str] = {
    "graph_extract_from_observation",
    "graph_confirm_work_objects",
}


# ============================================================================
# 工具 handler 实现（SubTask 7.1）
# ============================================================================

async def graph_query_nodes(args: dict[str, Any]) -> dict[str, Any]:
    """按关键词查询图谱节点。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        keyword: 过滤关键词（可选，空则返回全部）。匹配 title / summary / type 字段。
        node_type: 节点类型过滤（可选，如 ``concept`` / ``key_person``）。
        limit: 最多返回条数（可选，默认 20，上限 100）。

    Returns:
        ``{"status": "ok", "graph_id", "nodes": [...], "count": N}``；
        失败返回 ``{"status": "error", "message": ...}``。

    委托 :meth:`graph_store.GraphStore.list_nodes`，再做关键词过滤 + limit。
    """
    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    keyword = str(args.get("keyword") or "").strip().lower()
    node_type = args.get("node_type")
    if node_type is not None:
        node_type = str(node_type).strip() or None
    limit = int(args.get("limit") or 20)
    limit = max(1, min(limit, 100))

    try:
        from app.services.graph_store import graph_store

        nodes = await graph_store.list_nodes(graph_id, node_type=node_type)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_query_nodes 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"查询图谱节点失败: {exc}"}

    # 关键词过滤（title / summary / type 任一字段命中）
    if keyword:
        filtered: list[dict[str, Any]] = []
        for n in nodes:
            title = str(n.get("title") or "").lower()
            summary = str(n.get("summary") or "").lower()
            ntype = str(n.get("type") or "").lower()
            if keyword in title or keyword in summary or keyword in ntype:
                filtered.append(n)
        nodes = filtered

    nodes = nodes[:limit]
    return {
        "status": "ok",
        "graph_id": graph_id,
        "nodes": nodes,
        "count": len(nodes),
    }


async def graph_get_node_detail(args: dict[str, Any]) -> dict[str, Any]:
    """获取节点详情。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；
        节点不存在返回 ``{"status": "not_found"}``。

    委托 :meth:`graph_store.GraphStore.get_node`。
    """
    node_id = str(args.get("node_id") or "")
    if not node_id:
        return {"status": "error", "message": "node_id is required"}

    try:
        from app.services.graph_store import graph_store

        node = await graph_store.get_node(node_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_get_node_detail 调用失败 node_id=%s: %s", node_id, exc)
        return {"status": "error", "message": f"获取节点详情失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node}


async def graph_get_context(args: dict[str, Any]) -> dict[str, Any]:
    """获取图谱全貌上下文（用于让 LLM 了解图谱当前状态）。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。

    Returns:
        ``{"status": "ok", "graph_id", "context": "..."}``；
        失败返回 ``{"status": "error", "message": ...}``。

    委托 :meth:`graph_agent.GraphAgent._build_context`，返回序列化的图谱全貌文本。
    """
    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    try:
        from app.services.graph_agent import graph_agent

        context_text = await graph_agent._build_context(graph_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_get_context 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"获取图谱上下文失败: {exc}"}

    return {
        "status": "ok",
        "graph_id": graph_id,
        "context": context_text,
    }


async def graph_extract_from_observation(args: dict[str, Any]) -> dict[str, Any]:
    """从一条观察对话中抽取候选节点（**高风险**：会向图谱写入新节点）。

    Args（来自 schema）:
        observation_id: 观察记录 ID（必填）。
        graph_type: 图谱模式（``study`` / ``work``，决定抽取目标与子类型枚举）。

    Returns:
        ``{"status": "ok", "observation_id", "graph_type", "nodes": [...],
        "count": N, "truncated": bool, "segment_count": int,
        "original_length": int}``；LLM 不可用或解析失败返回空 nodes 列表。

        - ``truncated``: 是否触发分块抽取（长对话）。
        - ``segment_count``: 实际分块数（短对话为 1）。
        - ``original_length``: 原对话字符数。

    委托 :meth:`graph_agent.GraphAgent.extract_nodes_from_observation`，
    透传其返回的 ``truncated`` / ``segment_count`` / ``original_length``
    元数据字段，便于 agent 与前端识别长对话分块抽取场景。

    .. note::
        本工具被列入 :data:`HIGH_RISK_TOOLS`，调用前由
        :meth:`main_agent.MainAgent._intercept_high_risk_tool` 拦截：
        - Plan 模式：直接拒绝（不弹框）
        - Build 模式：通过 WS 推送 ``chat_tool_call_confirmation``，等待用户确认 / 60s 超时
    """
    observation_id = str(args.get("observation_id") or "")
    if not observation_id:
        return {"status": "error", "message": "observation_id is required"}

    graph_type = str(args.get("graph_type") or "work").strip().lower()
    if graph_type not in ("study", "work"):
        return {
            "status": "error",
            "message": f"无效的 graph_type: {graph_type}，应为 study 或 work",
        }

    try:
        from app.services.graph_agent import graph_agent

        result = await graph_agent.extract_nodes_from_observation(
            observation_id, graph_type
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_extract_from_observation 调用失败 obs=%s type=%s: %s",
            observation_id,
            graph_type,
            exc,
        )
        return {"status": "error", "message": f"从观察抽取节点失败: {exc}"}

    # 兼容 dict 返回（新版本）与 list 返回（旧版本，理论上已不存在）
    if isinstance(result, dict):
        nodes = result.get("nodes", []) or []
        truncated = bool(result.get("truncated", False))
        segment_count = int(result.get("segment_count", 1) or 1)
        original_length = int(result.get("original_length", 0) or 0)
    else:
        nodes = result or []
        truncated = False
        segment_count = 1 if nodes else 0
        original_length = 0

    return {
        "status": "ok",
        "observation_id": observation_id,
        "graph_type": graph_type,
        "nodes": nodes,
        "count": len(nodes),
        "truncated": truncated,
        "segment_count": segment_count,
        "original_length": original_length,
    }


async def graph_generate_quiz(args: dict[str, Any]) -> dict[str, Any]:
    """基于图谱节点生成测验题并持久化（落库，获得 quiz_id）。

    与 REST API ``POST /api/graphs/{graph_id}/quiz/generate`` 行为一致：
    生成 → 落库（``graph_store.create_quiz``）→ 脱敏（剥离 ``correct_answers``
    / ``reference_points``）→ 返回 ``quiz_id`` + 脱敏后的题目数据。

    前端据此渲染交互式测验卡（点击选项作答），而非让 agent 把题目当作
    markdown 文本输出。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        quiz_type: 题型（``single_choice`` / ``multi_choice`` / ``feynman``，默认 single_choice）。
        node_ids: 限定题目涉及的节点 ID 列表（可选，空则从全图随机选取）。

    Returns:
        ``{"status": "ok", "quiz_id": str, "quiz": {...脱敏后}}``；
        LLM 不可用时返回 ``degraded`` 占位结构（仍落库）。

    委托 :meth:`graph_agent.GraphAgent.generate_quiz` +
    :meth:`graph_store.GraphStore.create_quiz`。
    """
    import json

    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    quiz_type = str(args.get("quiz_type") or "single_choice").strip().lower()
    if quiz_type not in ("single_choice", "multi_choice", "feynman"):
        quiz_type = "single_choice"

    node_ids_raw = args.get("node_ids") or []
    if not isinstance(node_ids_raw, list):
        node_ids_raw = [node_ids_raw]
    node_ids = [str(n) for n in node_ids_raw if n] or None

    try:
        from app.services.graph_agent import graph_agent

        quiz_data = await graph_agent.generate_quiz(
            graph_id, node_ids=node_ids, quiz_type=quiz_type
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_generate_quiz 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"生成测验题失败: {exc}"}

    qtype = quiz_data.get("type", quiz_type)
    degraded = bool(quiz_data.get("degraded"))
    node_id = quiz_data.get("node_id", "") or ""

    # 降级且无 node_id 时：取图谱首个节点兜底，满足 create_quiz 的外键约束
    if not node_id:
        try:
            from app.services.graph_store import graph_store

            nodes_list = await graph_store.list_nodes(graph_id)
            if nodes_list:
                node_id = nodes_list[0].get("id", "")
        except Exception as exc:  # noqa: BLE001
            logger.warning("graph_generate_quiz 兜底取节点失败: %s", exc)
    if not node_id:
        return {
            "status": "error",
            "message": "图谱下无节点，无法生成测验。请先添加或抽取节点后再试。",
        }

    # 构造 payload 与 answer（与 quiz router 逻辑一致）
    if qtype == "feynman":
        payload = {
            "prompt": quiz_data.get("prompt", ""),
            "reference_points": quiz_data.get("reference_points", []),
            "degraded": degraded,
            "degrade_reason": quiz_data.get("degrade_reason", ""),
        }
        answer = ""
    else:
        correct_answers = quiz_data.get("correct_answers", []) or []
        payload = {
            "question": quiz_data.get("question", ""),
            "options": quiz_data.get("options", []) or [],
            "explanation": quiz_data.get("explanation", ""),
            "correct_answers": correct_answers,
            "degraded": degraded,
            "degrade_reason": quiz_data.get("degrade_reason", ""),
        }
        answer = json.dumps(correct_answers, ensure_ascii=False)

    # 落库
    try:
        from app.services.graph_store import graph_store

        quiz = await graph_store.create_quiz(
            graph_id=graph_id,
            node_id=node_id,
            quiz_type=qtype,
            payload=payload,
            answer=answer,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_generate_quiz 落库失败: %s", exc)
        return {"status": "error", "message": f"测验落库失败: {exc}"}

    # 脱敏：剥离 correct_answers / reference_points，避免泄题给前端 / agent
    quiz_id = quiz.get("id", "")
    sanitized = _sanitize_quiz_for_tool(quiz)

    return {
        "status": "ok",
        "quiz_id": quiz_id,
        "quiz": sanitized,
    }


def _sanitize_quiz_for_tool(quiz: dict[str, Any]) -> dict[str, Any]:
    """剥离 quiz 中的答案字段，避免泄露给前端 / agent（与 quiz router 脱敏逻辑一致）。

    - 选择题：从 ``payload`` 移除 ``correct_answers``，并清空 ``answer`` 字段。
    - 费曼题：从 ``payload`` 移除 ``reference_points``（作答前不可见参考要点）。
    """
    payload = quiz.get("payload") or {}
    sanitized_payload = dict(payload)
    qtype = quiz.get("type", "")
    if qtype in ("single_choice", "multi_choice"):
        sanitized_payload.pop("correct_answers", None)
    elif qtype == "feynman":
        sanitized_payload.pop("reference_points", None)

    out = dict(quiz)
    out["payload"] = sanitized_payload
    if qtype in ("single_choice", "multi_choice") and not quiz.get("answered"):
        out["answer"] = ""
    return out


async def graph_generate_trends(args: dict[str, Any]) -> dict[str, Any]:
    """分析行业风口（仅 work 图谱）。

    Args（来自 schema）:
        graph_id: work 图谱 ID（必填）。

    Returns:
        ``{"status": "ok", "trends": [...], "count": N}``；
        非 work 图谱或 LLM 不可用返回空列表。

    委托 :meth:`graph_agent.GraphAgent.generate_trends`。
    """
    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    try:
        from app.services.graph_agent import graph_agent

        trends = await graph_agent.generate_trends(graph_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_generate_trends 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"生成风口分析失败: {exc}"}

    return {
        "status": "ok",
        "graph_id": graph_id,
        "trends": trends,
        "count": len(trends),
    }


async def graph_generate_report(args: dict[str, Any]) -> dict[str, Any]:
    """生成工作报告（仅 work 图谱）。

    Args（来自 schema）:
        graph_id: work 图谱 ID（必填）。
        period: 报告周期（``weekly`` / ``monthly`` 等，默认 weekly）。

    Returns:
        ``{"status": "ok", "report": {...}}``；
        LLM 不可用时返回兜底报告。

    委托 :meth:`graph_agent.GraphAgent.generate_report`。
    """
    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    period = str(args.get("period") or "weekly").strip().lower() or "weekly"

    try:
        from app.services.graph_agent import graph_agent

        report = await graph_agent.generate_report(graph_id, period=period)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_generate_report 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"生成工作报告失败: {exc}"}

    return {"status": "ok", "graph_id": graph_id, "report": report}


# ============================================================================
# 节点行为工具（本土化扩展）
# ============================================================================

async def graph_extend_node(args: dict[str, Any]) -> dict[str, Any]:
    """节点延伸：基于源节点的延伸方向生成新节点并落库。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        node_id: 源节点 ID（必填）。
        mode: ``all`` 生成全部延伸（限 6-8 个）；``single`` 仅生成指定方向。
        direction_name: mode="single" 时的方向名（可选）。

    Returns:
        ``{"status": "ok", "graph_id", "node_id", "extensions": [...], "count": N}``；
        无延伸方向或 LLM 不可用时返回空列表。

    委托 :meth:`graph_agent.GraphAgent.generate_extensions`，再调
    ``graph_store.create_node`` + ``create_edge`` 落库（与现有
    ``POST /graphs/{gid}/nodes/{nid}/extend`` 路由行为一致）。**已存在
    标题的节点不重复创建**。
    """
    graph_id = str(args.get("graph_id") or "")
    node_id = str(args.get("node_id") or "")
    if not graph_id or not node_id:
        return {
            "status": "error",
            "message": "graph_id 与 node_id 均必填",
        }

    mode = str(args.get("mode") or "all").strip().lower()
    if mode not in ("all", "single"):
        mode = "all"
    direction_name = args.get("direction_name")
    if direction_name is not None:
        direction_name = str(direction_name).strip() or None

    try:
        from app.models.node_types import EDGE_EXTENDS, NODE_SOURCE_EXTENSION
        from app.services.graph_agent import _titles_similar, graph_agent
        from app.services.graph_store import graph_store

        candidates = await graph_agent.generate_extensions(
            node_id=node_id,
            graph_id=graph_id,
            mode=mode,
            direction_name=direction_name,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_extend_node 调用失败 graph=%s node=%s: %s",
            graph_id, node_id, exc,
        )
        return {"status": "error", "message": f"节点延伸失败: {exc}"}

    created: list[dict[str, Any]] = []
    existing_hit: list[dict[str, Any]] = []
    try:
        existing_nodes = await graph_store.list_nodes(graph_id)
        existing_map = {n.get("title", ""): n for n in existing_nodes if n.get("title")}

        for cand in candidates:
            title = str(cand.get("title") or "").strip()
            if not title:
                continue
            # 已存在节点：不重复创建，仅记 hit 供前端高亮
            matched_existing = None
            for exist_title, exist_node in existing_map.items():
                if _titles_similar(title, exist_title):
                    matched_existing = exist_node
                    break
            if matched_existing:
                existing_hit.append({
                    "existing": True,
                    "title": title,
                    "node_id": matched_existing.get("id"),
                })
                continue

            new_node = await graph_store.create_node(
                graph_id=graph_id,
                title=title,
                summary=str(cand.get("summary") or ""),
                node_type=str(cand.get("type") or ""),
                source=NODE_SOURCE_EXTENSION,
            )
            edge = await graph_store.create_edge(
                graph_id=graph_id,
                src_id=node_id,
                dst_id=new_node.get("id", ""),
                relation=EDGE_EXTENDS,
            )
            created.append({
                "existing": False,
                "title": title,
                "node_id": new_node.get("id"),
                "edge_id": edge.get("id") if edge else None,
                "direction_name": cand.get("direction_name", ""),
            })
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_extend_node 落库失败 graph=%s node=%s: %s",
            graph_id, node_id, exc,
        )
        return {
            "status": "error",
            "message": f"延伸节点落库失败: {exc}",
            "candidates": candidates,
        }

    return {
        "status": "ok",
        "graph_id": graph_id,
        "node_id": node_id,
        "extensions": created,
        "existing_hit": existing_hit,
        "count": len(created),
    }


async def graph_touch_node(args: dict[str, Any]) -> dict[str, Any]:
    """复习追踪：更新 ``last_reviewed_at`` 为当前时间，``review_count`` +1。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``。

    委托 :meth:`graph_store.GraphStore.touch_node`。
    """
    node_id = str(args.get("node_id") or "")
    if not node_id:
        return {"status": "error", "message": "node_id is required"}

    try:
        from app.services.graph_store import graph_store

        node = await graph_store.touch_node(node_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_touch_node 调用失败 node_id=%s: %s", node_id, exc)
        return {"status": "error", "message": f"复习追踪失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node}


async def graph_star_node(args: dict[str, Any]) -> dict[str, Any]:
    """星标节点（``is_starred=True``）。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``。
    """
    return await _set_star(args, True)


async def graph_unstar_node(args: dict[str, Any]) -> dict[str, Any]:
    """取消星标（``is_starred=False``）。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``。
    """
    return await _set_star(args, False)


async def _set_star(args: dict[str, Any], is_starred: bool) -> dict[str, Any]:
    """``graph_star_node`` / ``graph_unstar_node`` 共用实现。"""
    node_id = str(args.get("node_id") or "")
    if not node_id:
        return {"status": "error", "message": "node_id is required"}

    try:
        from app.services.graph_store import graph_store

        node = await graph_store.set_star(node_id, is_starred)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_set_star(node=%s, starred=%s) 失败: %s",
            node_id, is_starred, exc,
        )
        return {"status": "error", "message": f"星标操作失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node, "is_starred": is_starred}


async def graph_set_reminder(args: dict[str, Any]) -> dict[str, Any]:
    """设置节点提醒时间。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。
        remind_at: 提醒时间 ISO8601 字符串（必填，如 ``2026-07-25T10:00:00``）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``。

    委托 :meth:`graph_store.GraphStore.set_remind`。
    """
    node_id = str(args.get("node_id") or "")
    remind_at_raw = args.get("remind_at")
    if not node_id:
        return {"status": "error", "message": "node_id is required"}
    if not remind_at_raw:
        return {"status": "error", "message": "remind_at is required"}

    try:
        from datetime import datetime

        from app.services.graph_store import graph_store

        remind_at = datetime.fromisoformat(str(remind_at_raw))
        node = await graph_store.set_remind(node_id, remind_at)
    except ValueError as exc:
        return {"status": "error", "message": f"remind_at 格式无效: {exc}"}
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_set_reminder(node=%s, at=%s) 失败: %s",
            node_id, remind_at_raw, exc,
        )
        return {"status": "error", "message": f"设置提醒失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node}


async def graph_clear_reminder(args: dict[str, Any]) -> dict[str, Any]:
    """清除节点提醒时间（置 null）。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``。
    """
    node_id = str(args.get("node_id") or "")
    if not node_id:
        return {"status": "error", "message": "node_id is required"}

    try:
        from app.services.graph_store import graph_store

        node = await graph_store.clear_remind(node_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_clear_reminder(node=%s) 失败: %s", node_id, exc)
        return {"status": "error", "message": f"清除提醒失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node}


# ============================================================================
# 学习闭环工具（本土化扩展）
# ============================================================================

async def graph_answer_quiz(args: dict[str, Any]) -> dict[str, Any]:
    """测验作答并判分（选择题本地判分 / 费曼题语义判分）。

    Args（来自 schema）:
        quiz_id: 测验 ID（必填）。
        answer: 用户答案。选择题为选项 id 数组（如 ``["A"]`` / ``["A","C"]``），
            费曼题为解释文本字符串。

    Returns:
        ``{"status": "ok", "quiz_id", "type", "correct", "score", "explanation", ...}``；
        测验不存在 / 已答 / 题型不支持返回 ``{"status": "error"}``。

    选择题本地判分：对比 ``payload.correct_answers``，多选题部分对算错。
    费曼题调 :meth:`graph_agent.GraphAgent.grade_feynman` 语义判分。
    结果经 :meth:`graph_store.GraphStore.update_quiz_result` 落库。
    """
    quiz_id = str(args.get("quiz_id") or "")
    answer = args.get("answer")
    if not quiz_id:
        return {"status": "error", "message": "quiz_id is required"}
    if answer is None:
        return {"status": "error", "message": "answer is required"}

    try:
        import json

        from app.services.graph_store import graph_store

        quiz = await graph_store.get_quiz(quiz_id)
        if quiz is None:
            return {"status": "not_found", "quiz_id": quiz_id}
        if quiz.get("answered"):
            return {
                "status": "error",
                "message": "测验已作答，不可重复作答",
                "quiz_id": quiz_id,
            }

        qtype = quiz.get("type", "")
        payload = quiz.get("payload") or {}

        if qtype in ("single_choice", "multi_choice"):
            # 选择题本地判分
            correct_answers = payload.get("correct_answers") or []
            if not correct_answers and quiz.get("answer"):
                try:
                    correct_answers = json.loads(quiz["answer"])
                except (json.JSONDecodeError, TypeError):
                    correct_answers = []
            correct_set = {str(c).strip() for c in correct_answers if c}

            # 归一化用户答案
            user_answer = _normalize_choice_answer(answer)
            user_set = {a for a in user_answer}

            if qtype == "multi_choice":
                correct = user_set == correct_set and len(user_set) > 0
            else:
                correct = len(user_set) == 1 and user_set == correct_set

            explanation = payload.get("explanation", "") or ""
            degraded = bool(payload.get("degraded"))
            result = {
                "user_answer": user_answer,
                "correct_answers": list(correct_answers),
                "correct": correct,
                "explanation": explanation,
                "degraded": degraded,
            }
            updated = await graph_store.update_quiz_result(quiz_id, result)
            if updated is None:
                return {"status": "not_found", "quiz_id": quiz_id}

            return {
                "status": "ok",
                "quiz_id": quiz_id,
                "type": qtype,
                "correct": correct,
                "user_answer": user_answer,
                "correct_answers": list(correct_answers),
                "explanation": explanation,
                "degraded": degraded,
            }

        if qtype == "feynman":
            # 费曼题语义判分
            if isinstance(answer, list):
                user_answer_text = "\n".join(str(x) for x in answer)
            elif not isinstance(answer, str):
                user_answer_text = str(answer) if answer is not None else ""
            else:
                user_answer_text = answer
            user_answer_text = user_answer_text.strip()
            if not user_answer_text:
                return {
                    "status": "error",
                    "message": "费曼题作答不能为空",
                    "quiz_id": quiz_id,
                }

            from app.services.graph_agent import graph_agent

            try:
                grade = await graph_agent.grade_feynman(quiz_id, user_answer_text)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "graph_answer_quiz grade_feynman 失败 quiz=%s: %s",
                    quiz_id, exc,
                )
                grade = {
                    "score": 0,
                    "understanding_level": "poor",
                    "feedback": f"判分服务异常: {exc}",
                    "missed_points": [],
                    "degraded": True,
                    "degrade_reason": str(exc),
                }

            reference_points = payload.get("reference_points") or []
            result = {
                "user_answer": user_answer_text,
                "score": grade.get("score", 0),
                "understanding_level": grade.get("understanding_level", ""),
                "feedback": grade.get("feedback", ""),
                "missed_points": grade.get("missed_points", []),
                "reference_points": reference_points,
                "degraded": grade.get("degraded", False),
                "degrade_reason": grade.get("degrade_reason", ""),
            }
            updated = await graph_store.update_quiz_result(quiz_id, result)
            if updated is None:
                return {"status": "not_found", "quiz_id": quiz_id}

            return {
                "status": "ok",
                "quiz_id": quiz_id,
                "type": qtype,
                "score": grade.get("score", 0),
                "understanding_level": grade.get("understanding_level", ""),
                "feedback": grade.get("feedback", ""),
                "missed_points": grade.get("missed_points", []),
                "reference_points": reference_points,
                "degraded": grade.get("degraded", False),
            }

        return {
            "status": "error",
            "message": f"不支持的题型: {qtype}",
            "quiz_id": quiz_id,
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_answer_quiz 调用失败 quiz=%s: %s", quiz_id, exc,
        )
        return {"status": "error", "message": f"测验作答失败: {exc}"}


def _normalize_choice_answer(answer: Any) -> list[str]:
    """把用户答案归一化为选项 id 字符串数组。

    接受：选项 id 数组 / 索引数组 / 单个 id 字符串 / 单个索引整数 / JSON 数组字符串。
    """
    if answer is None:
        return []
    if isinstance(answer, str):
        s = answer.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                import json

                return _normalize_choice_answer(json.loads(s))
            except (json.JSONDecodeError, TypeError):
                pass
        return [s]
    if isinstance(answer, (int, float)):
        idx = int(answer)
        if 0 <= idx < 26:
            return [chr(ord("A") + idx)]
        return [str(idx)]
    if isinstance(answer, list):
        out: list[str] = []
        for item in answer:
            if isinstance(item, str):
                s = item.strip()
                if s:
                    out.append(s)
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                idx = int(item)
                if 0 <= idx < 26:
                    out.append(chr(ord("A") + idx))
                else:
                    out.append(str(idx))
        return out
    return []


async def graph_list_quiz_history(args: dict[str, Any]) -> dict[str, Any]:
    """列出测验历史。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        node_id: 可选节点过滤。
        answered: 可选作答状态过滤（true 仅已答 / false 仅未答 / 不传全部）。
        limit: 最多返回条数（可选，默认 50，上限 200）。

    Returns:
        ``{"status": "ok", "quizzes": [...], "count": N}``。

    委托 :meth:`graph_store.GraphStore.list_quizzes`。返回结果已剥离答案字段
    （参考 :func:`app.routers.quiz._sanitize_quiz_for_client`）。
    """
    graph_id = str(args.get("graph_id") or "")
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}

    node_id = args.get("node_id")
    if node_id is not None:
        node_id = str(node_id).strip() or None
    answered = args.get("answered")
    if answered is not None:
        answered = bool(answered)
    limit = int(args.get("limit") or 50)
    limit = max(1, min(limit, 200))

    try:
        from app.services.graph_store import graph_store

        quizzes = await graph_store.list_quizzes(
            graph_id=graph_id,
            node_id=node_id,
            answered=answered,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_list_quiz_history 失败 graph=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"列出测验历史失败: {exc}"}

    quizzes = quizzes[:limit]
    # 剥离答案字段，避免泄题
    sanitized = [_sanitize_quiz_for_client(q) for q in quizzes]
    return {
        "status": "ok",
        "graph_id": graph_id,
        "quizzes": sanitized,
        "count": len(sanitized),
    }


async def graph_get_quiz_detail(args: dict[str, Any]) -> dict[str, Any]:
    """获取测验详情（已剥离答案字段）。

    Args（来自 schema）:
        quiz_id: 测验 ID（必填）。

    Returns:
        ``{"status": "ok", "quiz": {...}}``；测验不存在返回 ``{"status": "not_found"}``。
    """
    quiz_id = str(args.get("quiz_id") or "")
    if not quiz_id:
        return {"status": "error", "message": "quiz_id is required"}

    try:
        from app.services.graph_store import graph_store

        quiz = await graph_store.get_quiz(quiz_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_get_quiz_detail 失败 quiz=%s: %s", quiz_id, exc)
        return {"status": "error", "message": f"获取测验详情失败: {exc}"}

    if quiz is None:
        return {"status": "not_found", "quiz_id": quiz_id}
    return {"status": "ok", "quiz": _sanitize_quiz_for_client(quiz)}


def _sanitize_quiz_for_client(quiz: dict[str, Any]) -> dict[str, Any]:
    """剥离 quiz 中的答案字段，避免泄露给 agent（与 quiz.py 路由一致）。

    - 选择题：从 ``payload`` 移除 ``correct_answers``，未作答时清空 ``answer``。
    - 费曼题：从 ``payload`` 移除 ``reference_points``（作答前不可见）。
    - ``result`` 字段为作答结果，作答后保留（含解析）。
    """
    payload = quiz.get("payload") or {}
    sanitized_payload = dict(payload)
    qtype = quiz.get("type", "")
    if qtype in ("single_choice", "multi_choice"):
        sanitized_payload.pop("correct_answers", None)
    elif qtype == "feynman":
        sanitized_payload.pop("reference_points", None)

    out = dict(quiz)
    out["payload"] = sanitized_payload
    if qtype in ("single_choice", "multi_choice") and not quiz.get("answered"):
        out["answer"] = ""
    return out


async def graph_add_user_fill(args: dict[str, Any]) -> dict[str, Any]:
    """向节点 ``user_fill`` 的指定类型追加一条内容。

    Args（来自 schema）:
        node_id: 节点 ID（必填）。
        fill_type: 留白类型，必须为 ``doubt/association/exam_point/error_point/note``
            之一（必填）。
        content: 留白内容（必填）。

    Returns:
        ``{"status": "ok", "node": {...}}``；节点不存在返回 ``{"status": "not_found"}``；
        fill_type 非法返回 ``{"status": "error"}``。

    委托 :meth:`graph_store.GraphStore.append_user_fill`。
    """
    node_id = str(args.get("node_id") or "")
    fill_type = str(args.get("fill_type") or "").strip().lower()
    content = str(args.get("content") or "").strip()
    if not node_id:
        return {"status": "error", "message": "node_id is required"}
    if not fill_type:
        return {"status": "error", "message": "fill_type is required"}
    if not content:
        return {"status": "error", "message": "content is required"}

    try:
        from app.services.graph_store import graph_store

        node = await graph_store.append_user_fill(node_id, fill_type, content)
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_add_user_fill 失败 node=%s type=%s: %s",
            node_id, fill_type, exc,
        )
        return {"status": "error", "message": f"追加留白失败: {exc}"}

    if node is None:
        return {"status": "not_found", "node_id": node_id}
    return {"status": "ok", "node": node}


# ============================================================================
# 智能推荐工具（本土化扩展）
# ============================================================================

async def graph_get_recommendations(args: dict[str, Any]) -> dict[str, Any]:
    """智能推荐：按 study/work 模式返回推荐节点列表。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        mode: 场景模式（``study`` / ``work``，必填）。
        limit: 最多返回条数（可选，默认 20，上限 100）。

    Returns:
        ``{"status": "ok", "recommendations": [...], "count": N}``；
        每项含节点字段 + ``reason`` 推荐理由 + ``score`` 综合分（study 模式）。

    复用 :file:`app/routers/recommendations.py` 的算法（提取为本地实现避免重复）。
    """
    graph_id = str(args.get("graph_id") or "")
    mode = str(args.get("mode") or "study").strip().lower()
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}
    if mode not in ("study", "work"):
        return {
            "status": "error",
            "message": f"无效 mode: {mode}，应为 study 或 work",
        }
    limit = int(args.get("limit") or 20)
    limit = max(1, min(limit, 100))

    try:
        from datetime import datetime, timedelta

        from app.models.node_types import (
            WORK_OBJECT_COMMITMENT,
            WORK_OBJECT_EVENT,
            WORK_OBJECT_RISK,
        )
        from app.services.graph_store import graph_store

        graph = await graph_store.get_graph(graph_id)
        if graph is None:
            return {"status": "not_found", "message": f"图谱不存在: {graph_id}"}

        nodes = await graph_store.list_nodes(graph_id)
        if not nodes:
            return {
                "status": "ok",
                "graph_id": graph_id,
                "recommendations": [],
                "count": 0,
            }

        now = datetime.now(UTC)
        recommendations: list[dict[str, Any]] = []

        if mode == "study":
            # Study 推荐：遗忘分 + 热度分 + 错误率分（综合分 0-100）
            # 简化实现：不查 quiz 表，仅按复习与热度计算
            quizzes_by_node: dict[str, list[dict[str, Any]]] = {}
            try:
                quizzes = await graph_store.list_quizzes(graph_id=graph_id)
                for q in quizzes:
                    nid = q.get("node_id", "")
                    if nid:
                        quizzes_by_node.setdefault(nid, []).append(q)
            except Exception:  # noqa: BLE001 - quiz 查询失败不阻断推荐
                pass

            for n in nodes:
                nid = n.get("id", "")
                last_reviewed = n.get("last_reviewed_at")
                review_count = n.get("review_count", 0) or 0
                mention_count = n.get("mention_count", 0) or 0

                # 遗忘分 0-40
                if last_reviewed is None:
                    forgetting_score = 40
                else:
                    days_since = max(0, (now - _to_aware_utc(last_reviewed)).days)
                    forgetting_score = min(40, days_since * 2 * (1 - review_count * 0.1))
                    forgetting_score = max(0, forgetting_score)

                # 热度分 0-20
                heat_score = max(0, 20 - mention_count * 2)
                if mention_count > 10:
                    heat_score = 5

                # 错误率分 0-40
                node_quizzes = quizzes_by_node.get(nid, [])
                if not node_quizzes:
                    error_score = 15
                else:
                    error_count = sum(
                        1 for q in node_quizzes
                        if q.get("answered") and
                        not (q.get("result") or {}).get("correct", False)
                    )
                    error_rate = error_count / max(1, len(node_quizzes))
                    error_score = int(error_rate * 40)

                total = forgetting_score + heat_score + error_score
                # 主要贡献项
                scores = {
                    "forgetting": forgetting_score,
                    "heat": heat_score,
                    "error_rate": error_score,
                }
                top_factor = max(scores, key=scores.get)
                days_since = (
                    int((now - _to_aware_utc(last_reviewed)).days)
                    if last_reviewed
                    else "∞"
                )
                reason_map = {
                    "forgetting": f"已 {days_since} 天未复习",
                    "heat": f"提及 {mention_count} 次待巩固",
                    "error_rate": f"历史错误率 {int(error_score / 40 * 100)}%",
                }
                recommendations.append({
                    **n,
                    "score": round(total, 1),
                    "reason": reason_map[top_factor],
                    "scores": scores,
                })

            recommendations.sort(key=lambda r: r["score"], reverse=True)
        else:
            # Work 推荐：到期优先 → 临近 → 星标 → 类型权重
            now_local = now
            for n in nodes:
                remind_at = n.get("remind_at")
                is_starred = bool(n.get("is_starred", False))
                node_type = n.get("type", "")

                is_overdue = False
                is_upcoming = False
                if remind_at is not None:
                    remind_aware = _to_aware_utc(remind_at)
                    if remind_aware <= now_local:
                        is_overdue = True
                    elif remind_aware <= now_local + timedelta(hours=24):
                        is_upcoming = True

                type_weight = {
                    WORK_OBJECT_COMMITMENT: 4,
                    WORK_OBJECT_RISK: 3,
                    WORK_OBJECT_EVENT: 2,
                }.get(node_type, 1)

                score = 0
                if is_overdue:
                    score += 100
                elif is_upcoming:
                    score += 60
                if is_starred:
                    score += 20
                score += type_weight * 5

                reasons: list[str] = []
                if is_overdue:
                    reasons.append("提醒已到期")
                elif is_upcoming:
                    reasons.append("24h 内临近")
                if is_starred:
                    reasons.append("星标关注")
                if node_type == WORK_OBJECT_COMMITMENT:
                    reasons.append("承诺待跟进")
                elif node_type == WORK_OBJECT_RISK:
                    reasons.append("风险关注")

                recommendations.append({
                    **n,
                    "score": score,
                    "is_overdue": is_overdue,
                    "is_upcoming": is_upcoming,
                    "is_starred": is_starred,
                    "reason": "、".join(reasons) if reasons else "常规推荐",
                })

            recommendations.sort(key=lambda r: r["score"], reverse=True)

        recommendations = recommendations[:limit]
        return {
            "status": "ok",
            "graph_id": graph_id,
            "mode": mode,
            "recommendations": recommendations,
            "count": len(recommendations),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_get_recommendations 失败 graph=%s mode=%s: %s",
            graph_id, mode, exc,
        )
        return {"status": "error", "message": f"获取推荐失败: {exc}"}


def _to_aware_utc(dt: Any) -> datetime:
    """把 naive datetime 补 UTC 时区，aware 直接返回。"""
    if dt is None:
        return datetime.now(UTC)
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC)
        return dt
    # 字符串：尝试解析
    try:
        return datetime.fromisoformat(str(dt))
    except ValueError:
        return datetime.now(UTC)


# ============================================================================
# 工作对象工具（本土化扩展）
# ============================================================================

async def graph_extract_work_objects(args: dict[str, Any]) -> dict[str, Any]:
    """从用户输入文本抽取工作对象候选（不入图）。

    Args（来自 schema）:
        graph_id: work 图谱 ID（必填）。
        text: 用户输入文本（必填，长度 1-6000 字符）。

    Returns:
        ``{"status": "ok", "graph_id", "objects": [...], "count": N}``；
        每个对象含 ``title / summary / type / relations``。
        LLM 不可用或文本为空返回空列表。

    委托 :meth:`graph_agent.GraphAgent.extract_work_objects`。
    """
    graph_id = str(args.get("graph_id") or "")
    text = str(args.get("text") or "").strip()
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}
    if not text:
        return {"status": "error", "message": "text is required"}

    try:
        from app.services.graph_agent import graph_agent

        objects = await graph_agent.extract_work_objects(text, graph_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_extract_work_objects 失败 graph=%s: %s", graph_id, exc,
        )
        return {"status": "error", "message": f"抽取工作对象失败: {exc}"}

    return {
        "status": "ok",
        "graph_id": graph_id,
        "objects": objects,
        "count": len(objects),
    }


async def graph_confirm_work_objects(args: dict[str, Any]) -> dict[str, Any]:
    """**高风险**：确认工作对象批量入图（创建节点 + 边）。

    Args（来自 schema）:
        graph_id: work 图谱 ID（必填）。
        objects: 工作对象数组，每项含 ``title / summary / type / relations``。
            relations 为 ``[{to_title, relation}]``。

    Returns:
        ``{"status": "ok", "graph_id", "created": [...], "edges": [...],
        "skipped_existing": [...], "created_count": N}``。

    .. note::
        本工具列入 :data:`HIGH_RISK_TOOLS`，调用前由
        :meth:`main_agent.MainAgent._intercept_high_risk_tool` 拦截：
        - Plan 模式：直接拒绝（不弹框）
        - Build 模式：弹确认框，用户同意后执行
    """
    graph_id = str(args.get("graph_id") or "")
    objects_raw = args.get("objects") or []
    if not graph_id:
        return {"status": "error", "message": "graph_id is required"}
    if not isinstance(objects_raw, list) or not objects_raw:
        return {
            "status": "error",
            "message": "objects 必须是非空数组",
        }

    try:
        from app.services.graph_agent import _titles_similar
        from app.services.graph_store import graph_store

        existing_nodes = await graph_store.list_nodes(graph_id)
        existing_map = {n.get("title", ""): n for n in existing_nodes if n.get("title")}

        created: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        skipped_existing: list[dict[str, Any]] = []
        title_to_id: dict[str, str] = {n.get("title", ""): n.get("id", "") for n in existing_nodes}

        # 第一遍：创建所有节点（先建后连边，避免依赖未创建的节点）
        for obj in objects_raw:
            if not isinstance(obj, dict):
                continue
            title = str(obj.get("title") or "").strip()
            if not title:
                continue

            # 已存在节点（标题相似）：跳过创建，仅记 mention
            matched_existing = None
            for exist_title, exist_node in existing_map.items():
                if _titles_similar(title, exist_title):
                    matched_existing = exist_node
                    break
            if matched_existing:
                try:
                    await graph_store.incr_mention(matched_existing.get("id", ""))
                except Exception:  # noqa: BLE001
                    pass
                skipped_existing.append({
                    "title": title,
                    "node_id": matched_existing.get("id"),
                })
                title_to_id[title] = matched_existing.get("id", "")
                continue

            new_node = await graph_store.create_node(
                graph_id=graph_id,
                title=title,
                summary=str(obj.get("summary") or ""),
                node_type=str(obj.get("type") or ""),
                source="agent",
            )
            created.append({
                "title": title,
                "node_id": new_node.get("id"),
                "type": obj.get("type", ""),
            })
            title_to_id[title] = new_node.get("id", "")

        # 第二遍：建立关系边
        valid_relations = {
            "related", "belongs_to", "involves", "committed_to", "depends_on",
            "waiting_for", "influences", "source_of", "alternative_to",
        }
        for obj in objects_raw:
            if not isinstance(obj, dict):
                continue
            from_title = str(obj.get("title") or "").strip()
            from_id = title_to_id.get(from_title, "")
            if not from_id:
                continue
            relations = obj.get("relations") or []
            if not isinstance(relations, list):
                continue
            for rel in relations:
                if not isinstance(rel, dict):
                    continue
                to_title = str(rel.get("to_title") or "").strip()
                relation = str(rel.get("relation") or "related").strip().lower()
                if relation not in valid_relations:
                    relation = "related"
                to_id = title_to_id.get(to_title, "")
                if not to_id:
                    # 关联到现有节点（如果 to_title 命中 existing_map）
                    matched = None
                    for exist_title, exist_node in existing_map.items():
                        if _titles_similar(to_title, exist_title):
                            matched = exist_node
                            break
                    if matched:
                        to_id = matched.get("id", "")
                        title_to_id[to_title] = to_id
                if not to_id or to_id == from_id:
                    continue
                edge = await graph_store.create_edge(
                    graph_id=graph_id,
                    src_id=from_id,
                    dst_id=to_id,
                    relation=relation,
                )
                edges.append({
                    "from_title": from_title,
                    "to_title": to_title,
                    "relation": relation,
                    "edge_id": edge.get("id") if edge else None,
                })

        return {
            "status": "ok",
            "graph_id": graph_id,
            "created": created,
            "edges": edges,
            "skipped_existing": skipped_existing,
            "created_count": len(created),
            "edge_count": len(edges),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "graph_confirm_work_objects 失败 graph=%s: %s", graph_id, exc,
        )
        return {"status": "error", "message": f"批量入图失败: {exc}"}


# ============================================================================
# 观察记录工具（本土化扩展）
# ============================================================================

async def graph_list_observations(args: dict[str, Any]) -> dict[str, Any]:
    """列出观察记录。

    Args（来自 schema）:
        graph_id: 可选图谱过滤。
        source: 可选来源过滤（``plugin`` / ``import`` / ``manual``）。
        processed: 可选处理状态过滤（``true`` 仅已处理 / ``false`` 仅未处理 /
            不传全部）。默认 ``false``（仅未处理）。
        limit: 最多返回条数（可选，默认 50，上限 200）。

    Returns:
        ``{"status": "ok", "observations": [...], "count": N}``。

    委托 :meth:`graph_store.GraphStore.list_observations`。
    """
    graph_id = args.get("graph_id")
    if graph_id is not None:
        graph_id = str(graph_id).strip() or None
    source = args.get("source")
    if source is not None:
        source = str(source).strip() or None
    processed = args.get("processed")
    if processed is None:
        processed = False  # 默认仅未处理
    else:
        processed = bool(processed)
    limit = int(args.get("limit") or 50)
    limit = max(1, min(limit, 200))

    try:
        from app.services.graph_store import graph_store

        observations = await graph_store.list_observations(
            graph_id=graph_id,
            source=source,
            processed=processed,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_list_observations 失败: %s", exc)
        return {"status": "error", "message": f"列出观察记录失败: {exc}"}

    return {
        "status": "ok",
        "observations": observations,
        "count": len(observations),
    }


# ============================================================================
# 工具 schema 构造（SubTask 7.2）
# ============================================================================

def _build_schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    """构造 OpenAI function calling 格式的 schema（与 tool_registry 保持一致）。"""
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
            },
        },
    }


# 7 个图谱工具的 schema 定义：(name, schema, allowed_modes, handler)
# - 6 个只读工具：plan / build 均可用
# - graph_extract_from_observation：仅 build（plan 模式由 main_agent 拦截层直接拒绝）
_GRAPH_TOOL_DEFS: list[tuple[str, dict[str, Any], list[str], Any]] = [
    (
        "graph_query_nodes",
        _build_schema(
            "graph_query_nodes",
            "查询知识图谱中的节点列表。plan 与 build 模式均可用。\n"
            "可按关键词过滤（匹配 title / summary / type 字段），按节点类型过滤，并限制返回条数。\n"
            "用于让 agent 了解图谱当前包含哪些节点。",
            {
                "graph_id": {
                    "type": "string",
                    "description": "图谱 ID",
                },
                "keyword": {
                    "type": "string",
                    "description": "过滤关键词（可选，匹配 title / summary / type）",
                },
                "node_type": {
                    "type": "string",
                    "description": "节点类型过滤（可选，如 concept / key_person / commitment）",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（可选，默认 20，上限 100）",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_query_nodes,
    ),
    (
        "graph_get_node_detail",
        _build_schema(
            "graph_get_node_detail",
            "获取知识图谱中某个节点的详情（含 title / summary / detail_payload / type 等）。"
            "plan 与 build 模式均可用。\n"
            "用于让 agent 深入了解某个节点的具体内容。",
            {
                "node_id": {
                    "type": "string",
                    "description": "节点 ID",
                },
            },
            required=["node_id"],
        ),
        ["plan", "build"],
        graph_get_node_detail,
    ),
    (
        "graph_get_context",
        _build_schema(
            "graph_get_context",
            "获取知识图谱的全貌上下文（含图谱名 / 节点列表 / 关系列系）。"
            "plan 与 build 模式均可用。\n"
            "用于让 agent 在回答前了解图谱整体结构与节点间关系，"
            "避免逐个查询节点。返回的 context 文本可直接作为回答依据。",
            {
                "graph_id": {
                    "type": "string",
                    "description": "图谱 ID",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_get_context,
    ),
    (
        "graph_extract_from_observation",
        _build_schema(
            "graph_extract_from_observation",
            "**高风险操作**：从一条观察对话（observation）中抽取候选节点并写入图谱。\n"
            "会修改图谱状态（新增节点），调用前需用户确认。\n"
            "Plan 模式下被一律拒绝（不弹框）；Build 模式下弹确认框，用户同意后才执行。\n"
            "graph_type 决定抽取目标：study=学科知识点，work=工作对象（线索/关键人/承诺等）。",
            {
                "observation_id": {
                    "type": "string",
                    "description": "观察记录 ID（要从中抽取节点的对话记录）",
                },
                "graph_type": {
                    "type": "string",
                    "enum": ["study", "work"],
                    "description": "图谱模式：study=学科知识点，work=工作对象",
                },
            },
            required=["observation_id", "graph_type"],
        ),
        ["build"],  # 仅 Build 模式可见；Plan 模式由 main_agent 拦截层拒绝
        graph_extract_from_observation,
    ),
    (
        "graph_generate_quiz",
        _build_schema(
            "graph_generate_quiz",
            "基于知识图谱节点生成测验题（单选 / 多选 / 费曼讲解）。"
            "plan 与 build 模式均可用。\n"
            "Study 模式下用于验证用户对知识点的掌握程度；"
            "Work 模式下较少使用（除非用户主动要求测验）。",
            {
                "graph_id": {
                    "type": "string",
                    "description": "图谱 ID",
                },
                "quiz_type": {
                    "type": "string",
                    "enum": ["single_choice", "multi_choice", "feynman"],
                    "description": "题型（默认 single_choice）",
                },
                "node_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "限定题目涉及的节点 ID 列表（可选，空则从全图随机选取）",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_generate_quiz,
    ),
    (
        "graph_generate_trends",
        _build_schema(
            "graph_generate_trends",
            "基于当前 work 图谱分析并生成行业风口推荐。plan 与 build 模式均可用。\n"
            "仅支持 work 图谱（study 图谱调用返回空列表）。\n"
            "返回 3-5 个风口/机会，每个含 title / reason / relevance / suggested_actions。",
            {
                "graph_id": {
                    "type": "string",
                    "description": "work 图谱 ID",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_generate_trends,
    ),
    (
        "graph_generate_report",
        _build_schema(
            "graph_generate_report",
            "基于当前 work 图谱生成工作报告（周报 / 月报等）。plan 与 build 模式均可用。\n"
            "仅支持 work 图谱。\n"
            "返回 markdown 格式报告与结构化 sections（progress / plan / risks / commitments）。",
            {
                "graph_id": {
                    "type": "string",
                    "description": "work 图谱 ID",
                },
                "period": {
                    "type": "string",
                    "description": "报告周期（weekly / monthly 等，默认 weekly）",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_generate_report,
    ),
    # ========================================================================
    # 节点行为工具（6 个，本土化扩展）
    # ========================================================================
    (
        "graph_extend_node",
        _build_schema(
            "graph_extend_node",
            "节点延伸：基于源节点生成新节点并落库"
            "（与 POST /graphs/{gid}/nodes/{nid}/extend 行为一致）。\n"
            "仅 build 模式可用（会落库新建节点 / 边，属于图谱修改操作）。\n"
            "mode=all 生成全部延伸方向（6-8 个）；mode=single 仅生成指定方向。\n"
            "已存在相似标题的节点不重复创建，仅记 existing_hit 供前端高亮。",
            {
                "graph_id": {"type": "string", "description": "图谱 ID"},
                "node_id": {"type": "string", "description": "源节点 ID"},
                "mode": {
                    "type": "string",
                    "enum": ["all", "single"],
                    "description": "all=生成全部延伸（默认）；single=仅生成指定方向",
                },
                "direction_name": {
                    "type": "string",
                    "description": "mode=single 时的方向名（可选）",
                },
            },
            required=["graph_id", "node_id"],
        ),
        ["build"],
        graph_extend_node,
    ),
    (
        "graph_touch_node",
        _build_schema(
            "graph_touch_node",
            "复习追踪：更新节点 last_reviewed_at 为当前时间，review_count +1。\n"
            "仅 build 模式可用（修改节点字段，属于图谱修改操作）。\n"
            "用于在学习 / 工作场景中追踪用户对节点的复习频率。",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
            },
            required=["node_id"],
        ),
        ["build"],
        graph_touch_node,
    ),
    (
        "graph_star_node",
        _build_schema(
            "graph_star_node",
            "星标节点（is_starred=True），用于标记重要节点。\n"
            "仅 build 模式可用（修改节点状态）。",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
            },
            required=["node_id"],
        ),
        ["build"],
        graph_star_node,
    ),
    (
        "graph_unstar_node",
        _build_schema(
            "graph_unstar_node",
            "取消星标（is_starred=False）。\n"
            "仅 build 模式可用。",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
            },
            required=["node_id"],
        ),
        ["build"],
        graph_unstar_node,
    ),
    (
        "graph_set_reminder",
        _build_schema(
            "graph_set_reminder",
            "设置节点提醒时间（remind_at 字段）。\n"
            "仅 build 模式可用。\n"
            "用于工作场景中设定节点跟进提醒（如承诺到期、风险关注等）。",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
                "remind_at": {
                    "type": "string",
                    "description": "提醒时间 ISO8601 字符串，如 2026-07-25T10:00:00",
                },
            },
            required=["node_id", "remind_at"],
        ),
        ["build"],
        graph_set_reminder,
    ),
    (
        "graph_clear_reminder",
        _build_schema(
            "graph_clear_reminder",
            "清除节点提醒时间（remind_at 置 null）。\n"
            "仅 build 模式可用。",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
            },
            required=["node_id"],
        ),
        ["build"],
        graph_clear_reminder,
    ),
    # ========================================================================
    # 学习闭环工具（4 个，本土化扩展）
    # ========================================================================
    (
        "graph_answer_quiz",
        _build_schema(
            "graph_answer_quiz",
            "测验作答并判分（选择题本地判分 / 费曼题语义判分），结果落库。\n"
            "仅 build 模式可用（写入作答结果，且同一测验不可重复作答）。\n"
            "- 选择题：answer 为选项 id 数组（如 [\"A\"] 或 [\"A\",\"C\"]），"
            "本地对比 correct_answers 严格集合相等判分。\n"
            "- 费曼题：answer 为用户解释文本，调 graph_agent.grade_feynman 语义判分，"
            "返回 score/understanding_level/feedback。\n"
            "返回值含 correct / score / explanation / correct_answers 等字段。",
            {
                "quiz_id": {"type": "string", "description": "测验 ID"},
                "answer": {
                    "type": ["string", "array"],
                    "description": (
                        "用户答案：选择题为选项 id 数组（如 [\"A\",\"C\"]）；"
                        "费曼题为解释文本"
                    ),
                },
            },
            required=["quiz_id", "answer"],
        ),
        ["build"],
        graph_answer_quiz,
    ),
    (
        "graph_list_quiz_history",
        _build_schema(
            "graph_list_quiz_history",
            "列出图谱的测验历史（按创建时间倒序）。\n"
            "plan 与 build 模式均可用。\n"
            "返回结果已剥离答案字段（避免泄题），仅含题目、用户作答、判分结果。",
            {
                "graph_id": {"type": "string", "description": "图谱 ID"},
                "node_id": {"type": "string", "description": "可选节点过滤"},
                "answered": {
                    "type": "boolean",
                    "description": "可选：true 仅已答 / false 仅未答 / 不传全部",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 50，上限 200）",
                },
            },
            required=["graph_id"],
        ),
        ["plan", "build"],
        graph_list_quiz_history,
    ),
    (
        "graph_get_quiz_detail",
        _build_schema(
            "graph_get_quiz_detail",
            "获取测验详情（已剥离答案字段，未作答时 correct_answers / reference_points 不可见）。\n"
            "plan 与 build 模式均可用。",
            {
                "quiz_id": {"type": "string", "description": "测验 ID"},
            },
            required=["quiz_id"],
        ),
        ["plan", "build"],
        graph_get_quiz_detail,
    ),
    (
        "graph_add_user_fill",
        _build_schema(
            "graph_add_user_fill",
            "向节点 user_fill 的指定类型追加一条内容（写入）。\n"
            "仅 build 模式可用。\n"
            "fill_type 必须是 doubt / association / exam_point / error_point / note 之一：\n"
            "- doubt：疑点（学习时遇到的疑问）\n"
            "- association：联想（与其它知识的关联）\n"
            "- exam_point：考点（考试重点）\n"
            "- error_point：错点（之前做错的点）\n"
            "- note：笔记（补充说明）",
            {
                "node_id": {"type": "string", "description": "节点 ID"},
                "fill_type": {
                    "type": "string",
                    "enum": ["doubt", "association", "exam_point", "error_point", "note"],
                    "description": "留白类型",
                },
                "content": {"type": "string", "description": "留白内容"},
            },
            required=["node_id", "fill_type", "content"],
        ),
        ["build"],
        graph_add_user_fill,
    ),
    # ========================================================================
    # 智能推荐工具（1 个，本土化扩展）
    # ========================================================================
    (
        "graph_get_recommendations",
        _build_schema(
            "graph_get_recommendations",
            "智能推荐：按 study / work 模式返回推荐节点列表（含 reason / score）。\n"
            "plan 与 build 模式均可用。\n"
            "- study 模式：遗忘分（40）+ 热度分（20）+ 错误率分（40），"
            "综合分 0-100 排序，推荐需复习的节点。\n"
            "- work 模式：到期优先（100）→ 24h 临近（60）→ 星标（20）→ "
            "类型权重（commitment/risk/event 5-20）。",
            {
                "graph_id": {"type": "string", "description": "图谱 ID"},
                "mode": {
                    "type": "string",
                    "enum": ["study", "work"],
                    "description": "场景模式",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 20，上限 100）",
                },
            },
            required=["graph_id", "mode"],
        ),
        ["plan", "build"],
        graph_get_recommendations,
    ),
    # ========================================================================
    # 工作对象工具（2 个，本土化扩展）
    # ========================================================================
    (
        "graph_extract_work_objects",
        _build_schema(
            "graph_extract_work_objects",
            "从用户输入文本抽取工作对象候选（不入图，仅返回候选列表）。\n"
            "plan 与 build 模式均可用（只读，不入图）。\n"
            "每个候选含 title / summary / type / relations，"
            "供 graph_confirm_work_objects 确认入图。",
            {
                "graph_id": {"type": "string", "description": "work 图谱 ID"},
                "text": {"type": "string", "description": "用户输入文本（1-6000 字符）"},
            },
            required=["graph_id", "text"],
        ),
        ["plan", "build"],
        graph_extract_work_objects,
    ),
    (
        "graph_confirm_work_objects",
        _build_schema(
            "graph_confirm_work_objects",
            "**高风险操作**：确认工作对象批量入图（创建节点 + 关系边）。\n"
            "会修改图谱状态（批量新增节点 + 边），调用前需用户确认。\n"
            "Plan 模式下被一律拒绝（不弹框）；Build 模式下弹确认框，用户同意后才执行。\n"
            "已存在相似标题的节点不重复创建，仅 incr mention_count。",
            {
                "graph_id": {"type": "string", "description": "work 图谱 ID"},
                "objects": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "工作对象数组，每项含 title / summary / type / relations",
                },
            },
            required=["graph_id", "objects"],
        ),
        ["build"],  # 高风险工具，仅 Build 模式可见
        graph_confirm_work_objects,
    ),
    # ========================================================================
    # 观察记录工具（1 个，本土化扩展）
    # ========================================================================
    (
        "graph_list_observations",
        _build_schema(
            "graph_list_observations",
            "列出观察记录（来源：plugin 推送 / import 导入 / manual 手动）。\n"
            "plan 与 build 模式均可用。\n"
            "默认仅返回未处理（processed=false）的记录；传 processed=true 仅返回已处理。",
            {
                "graph_id": {"type": "string", "description": "可选图谱过滤"},
                "source": {
                    "type": "string",
                    "enum": ["plugin", "import", "manual"],
                    "description": "可选来源过滤",
                },
                "processed": {
                    "type": "boolean",
                    "description": "可选处理状态过滤（默认 false=仅未处理）",
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数（默认 50，上限 200）",
                },
            },
            required=[],
        ),
        ["plan", "build"],
        graph_list_observations,
    ),
]


# ============================================================================
# 注册函数（SubTask 7.2 / 7.3）
# ============================================================================

def register_graph_tools(registry: Any) -> None:
    """向注册表注册 21 个图谱工具（7 基础 + 14 本土化扩展）。

    由 :func:`app.services.tool_registry.register_default_tools` 在末尾调用，
    使图谱工具成为默认工具集的一部分。也可单独调用以注册到指定注册表。

    工具的 ``allowed_modes``：
    - 11 个只读工具：``["plan", "build"]``（查询 / 详情 / 上下文 / 测验生成 /
      风口 / 报告 / 测验历史 / 测验详情 / 推荐 / 工作对象抽取 / 观察列表）
    - 10 个写入工具：``["build"]``（延伸 / 复习 / 星标 / 取消星标 / 提醒 / 清除提醒 /
      作答 / 留白 / 高风险抽取 / 入图确认）
      - Plan 模式由 :meth:`main_agent.MainAgent._intercept_high_risk_tool` 拦截层直接拒绝
      - Build 模式下高风险工具（``graph_extract_from_observation`` /
        ``graph_confirm_work_objects``）走用户确认弹框

    Args:
        registry: 目标注册表（需实现 ``register(name, schema, handler, allowed_modes)``）。
    """
    for name, schema, allowed_modes, handler in _GRAPH_TOOL_DEFS:
        registry.register(name, schema, handler, allowed_modes)
    logger.debug("已注册 %d 个图谱工具", len(_GRAPH_TOOL_DEFS))


# ============================================================================
# 模式白名单过滤（SubTask 7.4）
# ============================================================================

#: 全部 21 个图谱工具名（按注册顺序）
ALL_GRAPH_TOOLS: list[str] = [name for name, _, _, _ in _GRAPH_TOOL_DEFS]

#: 11 个只读图谱工具名（allowed_modes 含 plan 的工具，不含 build-only 写入工具）
READONLY_GRAPH_TOOLS: list[str] = [
    name for name, _, modes, _ in _GRAPH_TOOL_DEFS
    if "plan" in modes  # plan 模式可见即只读
]


def get_tools_for_mode(scenario_mode: str, plan_mode: bool) -> list[str]:
    """返回指定场景模式 + plan/build 模式下可用的图谱工具名列表。

    实现 SubTask 7.4 的白名单过滤逻辑：

    - **Study 模式**（任何 plan/build）：暴露全部 21 个图谱工具
      （写入工具由 :class:`ToolRegistry` 的 ``allowed_modes`` 过滤层在 Plan 模式下隐藏；
      高风险工具 ``graph_extract_from_observation`` / ``graph_confirm_work_objects``
      走 :meth:`main_agent.MainAgent._intercept_high_risk_tool` 拦截：
      Study Plan → 拒绝不弹框；Study Build → 弹确认框）
    - **Work 模式 Build**：暴露全部 21 个图谱工具（默认值，高风险工具走拦截）
    - **Work 模式 Plan**：仅暴露 11 个只读工具
      （**写入工具与高风险工具一律拒绝**，不弹框，直接回填拒绝原因；
      通过 ``allowed_modes=["build"]`` 使其在 plan 模式下不可见，
      ``main_agent`` 拦截层兜底拒绝）

    Args:
        scenario_mode: 场景模式（``"study"`` / ``"work"``）。
        plan_mode: 是否为 Plan 模式（True=只读规划，False=Build 可执行）。

    Returns:
        可用工具名列表。无效 scenario_mode 默认按 work 模式处理。
    """
    scenario = scenario_mode if scenario_mode in ("study", "work") else "work"

    # Study 模式：任何 plan/build 都暴露全部 21 个工具（plan/build 过滤由 registry 兜底）
    if scenario == "study":
        return list(ALL_GRAPH_TOOLS)

    # Work 模式 Build：暴露全部 21 个工具
    if not plan_mode:
        return list(ALL_GRAPH_TOOLS)

    # Work 模式 Plan：仅暴露 11 个只读工具（不含 build-only 写入工具）
    return list(READONLY_GRAPH_TOOLS)


__all__ = [
    # 常量
    "HIGH_RISK_TOOLS",
    "ALL_GRAPH_TOOLS",
    "READONLY_GRAPH_TOOLS",
    # 基础图谱工具 handler（7 个，Task 7）
    "graph_query_nodes",
    "graph_get_node_detail",
    "graph_get_context",
    "graph_extract_from_observation",
    "graph_generate_quiz",
    "graph_generate_trends",
    "graph_generate_report",
    # 节点行为工具 handler（6 个，本土化扩展）
    "graph_extend_node",
    "graph_touch_node",
    "graph_star_node",
    "graph_unstar_node",
    "graph_set_reminder",
    "graph_clear_reminder",
    # 学习闭环工具 handler（4 个，本土化扩展）
    "graph_answer_quiz",
    "graph_list_quiz_history",
    "graph_get_quiz_detail",
    "graph_add_user_fill",
    # 智能推荐工具 handler（1 个，本土化扩展）
    "graph_get_recommendations",
    # 工作对象工具 handler（2 个，本土化扩展）
    "graph_extract_work_objects",
    "graph_confirm_work_objects",
    # 观察记录工具 handler（1 个，本土化扩展）
    "graph_list_observations",
    # 注册函数
    "register_graph_tools",
    # 模式白名单
    "get_tools_for_mode",
]

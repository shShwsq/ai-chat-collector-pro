"""图谱工具封装（Task 7）：把 GraphAgent / GraphStore 能力包装为 Function Calling 工具。

提供 7 个图谱工具，每个工具 handler 签名统一为 ``(args: dict) -> dict``，
供 :class:`app.services.tool_registry.ToolRegistry` 注册：

- ``graph_query_nodes``：按关键词查询图谱节点（只读，plan/build 均可用）
- ``graph_get_node_detail``：获取节点详情（只读，plan/build 均可用）
- ``graph_get_context``：获取图谱全貌上下文（只读，plan/build 均可用）
- ``graph_extract_from_observation``：从观察对话抽取节点（**高风险**，仅 build；
  plan 模式由 ``main_agent._intercept_high_risk_tool`` 直接拒绝，build 模式弹确认框）
- ``graph_generate_quiz``：基于图谱生成测验题（只读，plan/build 均可用）
- ``graph_generate_trends``：分析行业风口（只读，仅 work 图谱；plan/build 均可用）
- ``graph_generate_report``：生成工作报告（只读，仅 work 图谱；plan/build 均可用）

设计要点：

- **延迟导入**：``graph_agent`` / ``graph_store`` 在 handler 内部导入，避免
  ``tool_registry.register_default_tools`` → ``register_graph_tools`` →
  ``graph_agent`` 的循环依赖（``MainAgent.__init__`` 同时 import graph_agent
  与 tool_registry）。
- **统一错误兜底**：每个 handler 捕获所有异常返回 ``{"status": "error", ...}``，
  不抛异常给工具循环（对齐 ``ToolRegistry.execute`` 的契约）。
- **模式白名单**：``HIGH_RISK_TOOLS = {"graph_extract_from_observation"}`` 在
  模块顶部定义，供 ``main_agent`` 拦截逻辑查询；``get_tools_for_mode`` 提供
  按场景模式（study/work）+ plan_mode 的白名单过滤。
- **落库由 GraphAgent 内部负责**：本模块只做参数透传与结果包装，不直接操作 DB。
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ============================================================================
# 高风险工具集合（SubTask 7.5）
# ============================================================================

#: 高风险工具集合：会修改图谱状态的工具，调用前需用户确认。
#:
#: - ``graph_extract_from_observation``：抽取节点会向图谱写入新节点，
#:   属于修改性操作，标记为高风险。
#:
#: 供 :mod:`app.services.main_agent` 的 ``_intercept_high_risk_tool`` 查询：
#: - Plan 模式：直接拒绝（不弹框）
#: - Build 模式：通过 WS 推送 ``chat_tool_call_confirmation``，等待用户确认 / 60s 超时
HIGH_RISK_TOOLS: set[str] = {"graph_extract_from_observation"}


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
        ``{"status": "ok", "observation_id", "nodes": [...], "count": N}``；
        LLM 不可用或解析失败返回空 nodes 列表。

    委托 :meth:`graph_agent.GraphAgent.extract_nodes_from_observation`。

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

        nodes = await graph_agent.extract_nodes_from_observation(
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

    return {
        "status": "ok",
        "observation_id": observation_id,
        "graph_type": graph_type,
        "nodes": nodes,
        "count": len(nodes),
    }


async def graph_generate_quiz(args: dict[str, Any]) -> dict[str, Any]:
    """基于图谱节点生成测验题。

    Args（来自 schema）:
        graph_id: 图谱 ID（必填）。
        quiz_type: 题型（``single_choice`` / ``multi_choice`` / ``feynman``，默认 single_choice）。
        node_ids: 限定题目涉及的节点 ID 列表（可选，空则从全图随机选取）。

    Returns:
        ``{"status": "ok", "quiz": {...}}``；
        LLM 不可用时返回 ``degraded`` 占位结构。

    委托 :meth:`graph_agent.GraphAgent.generate_quiz`。
    """
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

        quiz = await graph_agent.generate_quiz(
            graph_id, node_ids=node_ids, quiz_type=quiz_type
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("graph_generate_quiz 调用失败 graph_id=%s: %s", graph_id, exc)
        return {"status": "error", "message": f"生成测验题失败: {exc}"}

    return {"status": "ok", "quiz": quiz}


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
]


# ============================================================================
# 注册函数（SubTask 7.2 / 7.3）
# ============================================================================

def register_graph_tools(registry: Any) -> None:
    """向注册表注册 7 个图谱工具。

    由 :func:`app.services.tool_registry.register_default_tools` 在末尾调用，
    使图谱工具成为默认工具集的一部分。也可单独调用以注册到指定注册表。

    工具的 ``allowed_modes``：
    - 6 个只读工具：``["plan", "build"]``
    - ``graph_extract_from_observation``：``["build"]``（Plan 模式由
      :meth:`main_agent.MainAgent._intercept_high_risk_tool` 拦截层直接拒绝）

    Args:
        registry: 目标注册表（需实现 ``register(name, schema, handler, allowed_modes)``）。
    """
    for name, schema, allowed_modes, handler in _GRAPH_TOOL_DEFS:
        registry.register(name, schema, handler, allowed_modes)
    logger.debug("已注册 %d 个图谱工具", len(_GRAPH_TOOL_DEFS))


# ============================================================================
# 模式白名单过滤（SubTask 7.4）
# ============================================================================

#: 全部 7 个图谱工具名（按注册顺序）
ALL_GRAPH_TOOLS: list[str] = [name for name, _, _, _ in _GRAPH_TOOL_DEFS]

#: 6 个只读图谱工具名（不含高风险的 graph_extract_from_observation）
READONLY_GRAPH_TOOLS: list[str] = [
    name for name, _, modes, _ in _GRAPH_TOOL_DEFS
    if "plan" in modes  # plan 模式可见即只读
]


def get_tools_for_mode(scenario_mode: str, plan_mode: bool) -> list[str]:
    """返回指定场景模式 + plan/build 模式下可用的图谱工具名列表。

    实现 SubTask 7.4 的白名单过滤逻辑：

    - **Study 模式**（任何 plan/build）：暴露全部 7 个图谱工具
      （含 ``graph_extract_from_observation``，但调用时走高风险拦截：
      Study Plan → 拒绝不弹框；Study Build → 弹确认框）
    - **Work 模式 Build**：暴露全部 7 个图谱工具（默认值，高风险工具走拦截）
    - **Work 模式 Plan**：仅暴露 6 个只读工具
      （**高风险工具一律拒绝**，不弹框，直接回填拒绝原因；通过 ``allowed_modes=["build"]``
      使其在 plan 模式下不可见，``main_agent`` 拦截层兜底拒绝）

    Args:
        scenario_mode: 场景模式（``"study"`` / ``"work"``）。
        plan_mode: 是否为 Plan 模式（True=只读规划，False=Build 可执行）。

    Returns:
        可用工具名列表。无效 scenario_mode 默认按 work 模式处理。
    """
    scenario = scenario_mode if scenario_mode in ("study", "work") else "work"

    # Study 模式：任何 plan/build 都暴露全部 7 个工具
    if scenario == "study":
        return list(ALL_GRAPH_TOOLS)

    # Work 模式 Build：暴露全部 7 个工具
    if not plan_mode:
        return list(ALL_GRAPH_TOOLS)

    # Work 模式 Plan：仅暴露 6 个只读工具（不含 graph_extract_from_observation）
    return list(READONLY_GRAPH_TOOLS)


__all__ = [
    # 常量
    "HIGH_RISK_TOOLS",
    "ALL_GRAPH_TOOLS",
    "READONLY_GRAPH_TOOLS",
    # 工具 handler
    "graph_query_nodes",
    "graph_get_node_detail",
    "graph_get_context",
    "graph_extract_from_observation",
    "graph_generate_quiz",
    "graph_generate_trends",
    "graph_generate_report",
    # 注册函数
    "register_graph_tools",
    # 模式白名单
    "get_tools_for_mode",
]

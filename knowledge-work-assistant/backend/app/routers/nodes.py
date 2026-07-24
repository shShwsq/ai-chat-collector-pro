"""节点详情与留白路由（Task 7 / Task 9）。

提供节点详情卡内容生成与用户留白追加接口，挂载在 ``/api`` 前缀下：

- ``POST /api/graphs/{graph_id}/nodes/{node_id}/detail``    生成（或复用缓存）节点详情卡内容
- ``POST /api/graphs/{graph_id}/nodes/{node_id}/user-fill``  向 user_fill 追加一条内容

节点行为接口（复习追踪 / 提醒 / 星标），按节点 ID 直接操作，无需 graph_id：

- ``POST   /api/nodes/{node_id}/touch``   复习追踪：last_reviewed_at 置当前时间、review_count+1
- ``POST   /api/nodes/{node_id}/remind``  设置提醒时间（body: {"remind_at": "ISO8601"}）
- ``DELETE /api/nodes/{node_id}/remind``  清除提醒时间
- ``POST   /api/nodes/{node_id}/star``    星标节点（is_starred=True）
- ``DELETE /api/nodes/{node_id}/star``    取消星标（is_starred=False）

设计要点：

1. **detail_payload 缓存策略**：生成结果以加下划线前缀的特殊键（``_important_points``
   等）写入 ``node.detail_payload``，避免与模板字段名冲突。再次调用时若已含
   ``_important_points`` 键，直接返回缓存结果，不重复调用 LLM。
2. **降级透明传递**：``graph_agent.generate_node_detail`` 在 LLM 不可用时返回
   ``degraded=True`` 的兜底结构，本层原样透传，前端据此显示「AI 内容暂不可用」
   提示但仍可编辑。
3. **类型推断回写**：若 LLM 推断了更具体的合法类型（``inferred_type``），则一并
   更新 ``node.type``，前端下次渲染即可命中更精确的模板。
4. **邻居上下文**：通过 ``graph_store.get_full_graph`` 收集节点邻居，传给 Agent
   用于类型推断与延伸方向生成。
5. **行为接口统一风格**：touch / remind / star 均返回更新后的 ``NodeResponse``，
   节点不存在统一抛 404，与 detail / user-fill 路由保持一致。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.models.node_types import is_valid_node_type
from app.models.schemas import NodeResponse, UserFillAppend
from app.services.graph_agent import GraphAgent, get_graph_agent
from app.services.graph_store import GraphStore, graph_store

router = APIRouter()


# detail_payload 中存放生成结果的特殊键（加下划线前缀避免与模板字段冲突）
_DETAIL_KEY_IMPORTANT = "_important_points"
_DETAIL_KEY_EXTENSIONS = "_extension_directions"
_DETAIL_KEY_SUMMARY = "_generated_summary"
_DETAIL_KEY_DEGRADED = "_degraded"
_DETAIL_KEY_REASON = "_degrade_reason"
_DETAIL_KEY_TEMPLATE = "_template_used"


def get_graph_store() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store


def get_agent() -> GraphAgent:
    """依赖注入：返回全局 GraphAgent 单例。"""
    return get_graph_agent()


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


async def _resolve_node_and_graph(
    graph_id: str, node_id: str, store: GraphStore
) -> tuple[dict[str, Any], dict[str, Any]]:
    """校验节点存在且属于图谱，返回 (node, graph) dict。"""
    node = await store.get_node(node_id)
    if node is None or node.get("graph_id") != graph_id:
        raise _not_found(f"节点不存在或不属于图谱 {graph_id}: {node_id}")
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    return node, graph


async def _collect_neighbors(
    graph_id: str, node_id: str, store: GraphStore
) -> list[dict[str, Any]]:
    """收集节点的邻居节点列表（通过边关系），供 Agent 上下文推断。"""
    full = await store.get_full_graph(graph_id)
    if full is None:
        return []
    nodes = full.get("nodes", [])
    edges = full.get("edges", [])
    id_to_node = {n.get("id"): n for n in nodes if n.get("id")}
    neighbor_ids: set[str] = set()
    for e in edges:
        s = e.get("src_id")
        t = e.get("dst_id")
        if s == node_id and t:
            neighbor_ids.add(t)
        if t == node_id and s:
            neighbor_ids.add(s)
    return [id_to_node[nid] for nid in neighbor_ids if nid in id_to_node]


def _strip_meta_keys(payload: dict[str, Any]) -> dict[str, Any]:
    """剔除 detail_payload 中的下划线前缀元数据键，返回纯模板字段。"""
    return {k: v for k, v in payload.items() if not k.startswith("_")}


@router.post("/graphs/{graph_id}/nodes/{node_id}/detail")
async def generate_node_detail(
    graph_id: str,
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
    agent: GraphAgent = Depends(get_agent),
) -> dict[str, Any]:
    """生成（或复用缓存）节点详情卡内容。

    若节点 ``detail_payload`` 已含 ``_important_points`` 键，直接返回缓存；
    否则调用 ``graph_agent.generate_node_detail`` 生成，并把结果合并写入
    ``detail_payload`` 后返回。

    返回结构::

        {
          "node": NodeResponse,           # 更新后的节点
          "detail": {
            "summary": str,
            "important_points": [str],
            "extension_directions": [{"name","reason"}],
            "detail_fields": {template_key: value},
            "template_used": str,
            "inferred_type": str,
            "degraded": bool,
            "degrade_reason": str,
            "cached": bool
          }
        }
    """
    node, graph = await _resolve_node_and_graph(graph_id, node_id, store)
    graph_type = graph.get("type", "study")
    detail_payload = node.get("detail_payload") or {}

    # 已生成过：直接返回缓存（前端可删除节点重建以强制重生成）
    if isinstance(detail_payload, dict) and _DETAIL_KEY_IMPORTANT in detail_payload:
        return {
            "node": NodeResponse(**node),
            "detail": {
                "summary": detail_payload.get(
                    _DETAIL_KEY_SUMMARY, node.get("summary", "")
                ),
                "important_points": detail_payload.get(
                    _DETAIL_KEY_IMPORTANT, []
                ),
                "extension_directions": detail_payload.get(
                    _DETAIL_KEY_EXTENSIONS, []
                ),
                "detail_fields": _strip_meta_keys(detail_payload),
                "template_used": detail_payload.get(_DETAIL_KEY_TEMPLATE, ""),
                "inferred_type": node.get("type", ""),
                "degraded": detail_payload.get(_DETAIL_KEY_DEGRADED, False),
                "degrade_reason": detail_payload.get(_DETAIL_KEY_REASON, ""),
                "cached": True,
            },
        }

    neighbors = await _collect_neighbors(graph_id, node_id, store)
    result = await agent.generate_node_detail(
        node_title=node.get("title", ""),
        node_type=node.get("type", ""),
        graph_type=graph_type,
        neighbors=neighbors,
        node_id=node_id,
        graph_id=graph_id,
    )

    # 合并生成结果到 detail_payload：先保留已有模板字段，再覆盖 LLM 产出的字段
    merged: dict[str, Any] = _strip_meta_keys(detail_payload)
    detail_fields = result.get("detail_fields") or {}
    if isinstance(detail_fields, dict):
        merged.update(detail_fields)
    # 写入元数据键
    merged[_DETAIL_KEY_SUMMARY] = result.get("summary", "")
    merged[_DETAIL_KEY_IMPORTANT] = result.get("important_points", [])
    merged[_DETAIL_KEY_EXTENSIONS] = result.get("extension_directions", [])
    merged[_DETAIL_KEY_DEGRADED] = result.get("degraded", False)
    merged[_DETAIL_KEY_REASON] = result.get("degrade_reason", "")
    merged[_DETAIL_KEY_TEMPLATE] = result.get("template_used", "")

    # 若 LLM 推断了更具体的合法类型，则一并更新 node.type
    inferred_type = result.get("inferred_type") or ""
    update_type: str | None = None
    if (
        inferred_type
        and inferred_type != node.get("type", "")
        and inferred_type != "general"
        and is_valid_node_type(graph_type, inferred_type)
    ):
        update_type = inferred_type

    try:
        updated = await store.update_node(
            node_id,
            detail_payload=merged,
            node_type=update_type,
        )
    except ValueError as exc:
        # 类型推断回写失败时降级：仅写 detail_payload，不切换类型
        updated = await store.update_node(node_id, detail_payload=merged)
        if updated is None:
            raise _bad_request(f"更新节点详情失败: {exc}") from exc

    if updated is None:
        updated = node

    return {
        "node": NodeResponse(**updated),
        "detail": {
            "summary": result.get("summary", ""),
            "important_points": result.get("important_points", []),
            "extension_directions": result.get("extension_directions", []),
            "detail_fields": detail_fields if isinstance(detail_fields, dict) else {},
            "template_used": result.get("template_used", ""),
            "inferred_type": result.get("inferred_type", ""),
            "degraded": result.get("degraded", False),
            "degrade_reason": result.get("degrade_reason", ""),
            "cached": False,
        },
    }


@router.post(
    "/graphs/{graph_id}/nodes/{node_id}/user-fill",
    response_model=NodeResponse,
)
async def append_user_fill(
    graph_id: str,
    node_id: str,
    body: UserFillAppend,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """向节点 ``user_fill`` 的指定类型追加一条内容。

    ``fill_type`` 必须是 ``doubt/association/exam_point/error_point/note`` 之一，
    校验由 ``graph_store.append_user_fill`` 完成。
    """
    node = await store.get_node(node_id)
    if node is None or node.get("graph_id") != graph_id:
        raise _not_found(f"节点不存在或不属于图谱 {graph_id}: {node_id}")
    try:
        updated = await store.append_user_fill(
            node_id, body.fill_type, body.content
        )
    except ValueError as exc:
        msg = str(exc)
        if "不存在" in msg:
            raise _not_found(msg) from exc
        raise _bad_request(msg) from exc
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)


# ============================================================================
# 节点行为接口（复习追踪 / 提醒 / 星标）
#
# 与 detail / user-fill 不同，这些接口按节点 ID 直接操作，URL 不含 graph_id，
# 适用于前端在任意视图（图谱画布 / 推荐列表 / 提醒面板）中触发的节点行为。
# ============================================================================


class RemindRequest(BaseModel):
    """设置节点提醒时间请求。"""

    remind_at: datetime = Field(
        ..., description="提醒时间，ISO8601 字符串（如 2026-07-25T10:00:00）"
    )


@router.post("/nodes/{node_id}/touch", response_model=NodeResponse)
async def touch_node(
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """复习追踪：更新 ``last_reviewed_at`` 为当前时间，``review_count`` +1。

    用户打开节点详情卡时调用，用于追踪复习行为与智能推荐权重。
    """
    updated = await store.touch_node(node_id)
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)


@router.post("/nodes/{node_id}/remind", response_model=NodeResponse)
async def set_remind(
    node_id: str,
    body: RemindRequest,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """设置节点提醒时间。

    请求体 ``{"remind_at": "2026-07-25T10:00:00"}``，用于 Work 模式节点的
    定时提醒（如某承诺的兑现截止时间）。
    """
    updated = await store.set_remind(node_id, body.remind_at)
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)


@router.delete("/nodes/{node_id}/remind", response_model=NodeResponse)
async def clear_remind(
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """清除节点提醒时间（置 null）。"""
    updated = await store.clear_remind(node_id)
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)


@router.post("/nodes/{node_id}/star", response_model=NodeResponse)
async def star_node(
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """星标节点（``is_starred=True``）。"""
    updated = await store.set_star(node_id, True)
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)


@router.delete("/nodes/{node_id}/star", response_model=NodeResponse)
async def unstar_node(
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """取消星标（``is_starred=False``）。"""
    updated = await store.set_star(node_id, False)
    if updated is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**updated)

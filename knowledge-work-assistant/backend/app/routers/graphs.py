"""图谱管理路由（Task 4）。

提供知识图谱及其节点 / 边的 CRUD 接口，挂载在 ``/api`` 前缀下：

- ``POST   /api/graphs``                    创建图谱（body: {name, type}）
- ``GET    /api/graphs?mode=study|work``    按模式列出图谱（study/work 隔离）
- ``GET    /api/graphs/{graph_id}``         获取单个图谱
- ``GET    /api/graphs/{graph_id}/full``    获取完整图谱（含 nodes/edges/stats）
- ``PATCH  /api/graphs/{graph_id}``         重命名图谱
- ``DELETE /api/graphs/{graph_id}``         删除图谱（级联清理）
- ``GET    /api/graphs/{graph_id}/stats``   图谱统计
- ``POST   /api/graphs/{graph_id}/nodes``   创建节点
- ``GET    /api/graphs/{graph_id}/nodes``   列出节点（可按 type 过滤）
- ``PATCH  /api/graphs/{graph_id}/nodes/{node_id}``  更新节点
- ``DELETE /api/graphs/{graph_id}/nodes/{node_id}``  删除节点
- ``POST   /api/graphs/{graph_id}/edges``   创建边
- ``GET    /api/graphs/{graph_id}/edges``   列出边
- ``DELETE /api/graphs/{graph_id}/edges/{edge_id}``  删除边

设计要点：

1. **依赖注入 graph_store**：所有路由通过 ``Depends(get_graph_store)`` 拿到全局
   ``GraphStore`` 单例，便于测试时替换。
2. **study/work 隔离**：``list_graphs`` 按 ``mode`` 查询参数过滤；节点 / 边操作
   均以 ``graph_id`` 为锚点，天然隔离（不会跨图谱）。
3. **错误映射**：``graph_store`` 抛 ``ValueError`` 表示业务校验失败，本层映射为
   HTTP 异常（消息含"不存在"→ 404，含"非法"→ 422，其余 → 400）。资源不存在
   的返回值（``None`` / ``False``）由路由显式判断并抛 404。
4. **不修改 graph_store / db_models**：本层仅做参数校验与 HTTP 适配。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.models.node_types import GRAPH_TYPES
from app.models.schemas import (
    EdgeCreate,
    EdgeResponse,
    FullGraphResponse,
    GraphCreate,
    GraphResponse,
    GraphStatsResponse,
    GraphUpdate,
    NodeCreate,
    NodeResponse,
    NodeUpdate,
)
from app.services.graph_store import GraphStore, graph_store

router = APIRouter()


def get_graph_store() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。

    抽成函数便于后续在测试中替换依赖（``app.dependency_overrides``）。
    """
    return graph_store


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _handle_value_error(exc: ValueError) -> HTTPException:
    """将 graph_store 抛出的 ValueError 映射为合适的 HTTP 异常。

    - 消息含"不存在" → 404（资源缺失）
    - 消息含"非法"   → 422（语义校验失败，与 Pydantic 422 风格一致）
    - 其余           → 400（通用业务校验失败）
    """
    msg = str(exc)
    if "不存在" in msg:
        return _not_found(msg)
    if "非法" in msg:
        return HTTPException(status_code=422, detail=msg)
    return _bad_request(msg)


# ============================================================================
# 图谱 CRUD
# ============================================================================


@router.post("/graphs", response_model=GraphResponse, status_code=201)
async def create_graph(
    body: GraphCreate,
    store: GraphStore = Depends(get_graph_store),
) -> GraphResponse:
    """创建图谱。``type`` 必须是 ``study`` 或 ``work``。"""
    if body.type not in GRAPH_TYPES:
        raise _bad_request(f"非法图谱类型: {body.type}（允许: {GRAPH_TYPES}）")
    try:
        data = await store.create_graph(name=body.name, graph_type=body.type)
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    return GraphResponse(**data)


@router.get("/graphs", response_model=list[GraphResponse])
async def list_graphs(
    mode: str | None = Query(
        None, description="按模式过滤：study / work，用于前后端模式切换时隔离图谱列表"
    ),
    store: GraphStore = Depends(get_graph_store),
) -> list[GraphResponse]:
    """列出图谱，可选按 ``mode`` 过滤（实现 study/work 数据隔离）。"""
    if mode is not None and mode not in GRAPH_TYPES:
        raise _bad_request(f"非法模式: {mode}（允许: {GRAPH_TYPES}）")
    try:
        items = await store.list_graphs(graph_type=mode)
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    return [GraphResponse(**g) for g in items]


@router.get("/graphs/{graph_id}", response_model=GraphResponse)
async def get_graph(
    graph_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> GraphResponse:
    """获取单个图谱。"""
    data = await store.get_graph(graph_id)
    if data is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    return GraphResponse(**data)


@router.get("/graphs/{graph_id}/full", response_model=FullGraphResponse)
async def get_full_graph(
    graph_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> FullGraphResponse:
    """获取完整图谱（含 nodes / edges / stats），供前端可视化一次性加载。"""
    data = await store.get_full_graph(graph_id)
    if data is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    return FullGraphResponse(
        graph=GraphResponse(**data["graph"]),
        nodes=[NodeResponse(**n) for n in data["nodes"]],
        edges=[EdgeResponse(**e) for e in data["edges"]],
        stats=GraphStatsResponse(**data["stats"]),
    )


@router.patch("/graphs/{graph_id}", response_model=GraphResponse)
async def rename_graph(
    graph_id: str,
    body: GraphUpdate,
    store: GraphStore = Depends(get_graph_store),
) -> GraphResponse:
    """重命名图谱。"""
    data = await store.rename_graph(graph_id, body.name)
    if data is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    return GraphResponse(**data)


@router.delete("/graphs/{graph_id}")
async def delete_graph(
    graph_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> dict[str, Any]:
    """删除图谱（级联清理其下节点 / 边 / 测验）。"""
    ok = await store.delete_graph(graph_id)
    if not ok:
        raise _not_found(f"图谱不存在: {graph_id}")
    return {"deleted": True, "id": graph_id}


@router.post("/graphs/clear")
async def clear_graphs(
    mode: str | None = Query(
        None, description="按模式过滤：study / work，省略则清空全部"
    ),
    store: GraphStore = Depends(get_graph_store),
) -> dict[str, Any]:
    """批量清空图谱（级联清理各图谱下的节点 / 边 / 测验）。

    用 ``POST /graphs/clear`` 而非 ``DELETE /graphs`` 以避免与单条
    ``DELETE /graphs/{graph_id}`` 动态路由冲突。observations 表的
    ``graph_id`` 外键为 ``ondelete=SET NULL``，故相关 observations 不会被删除，
    仅解绑（``graph_id`` 置空）——如需一并清空 observations，由前端额外调用
    ``POST /observations/clear``。

    幂等：无匹配数据时返回 ``deleted_count=0``。
    """
    if mode is not None and mode not in GRAPH_TYPES:
        raise _bad_request(f"非法模式: {mode}（允许: {GRAPH_TYPES}）")
    try:
        count = await store.delete_graphs_by_type(mode)
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    return {"ok": True, "deleted_count": count, "mode": mode}


@router.get("/graphs/{graph_id}/stats", response_model=GraphStatsResponse)
async def get_graph_stats(
    graph_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> GraphStatsResponse:
    """获取图谱统计：节点数 / 边数 / 测验数。"""
    if await store.get_graph(graph_id) is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    data = await store.get_graph_stats(graph_id)
    return GraphStatsResponse(**data)


# ============================================================================
# 节点 CRUD
# ============================================================================


@router.post(
    "/graphs/{graph_id}/nodes", response_model=NodeResponse, status_code=201
)
async def create_node(
    graph_id: str,
    body: NodeCreate,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """在指定图谱下创建节点。

    节点 ``type`` 必须与图谱模式匹配（Study 走学科枚举，Work 走工作对象枚举），
    校验由 ``graph_store.create_node`` 完成，不匹配抛 400。
    """
    try:
        data = await store.create_node(
            graph_id=graph_id,
            node_type=body.type,
            title=body.title,
            summary=body.summary,
            detail_payload=body.detail_payload,
            is_gray=body.is_gray,
            user_fill=body.user_fill,
            source=body.source,
            confidence=body.confidence,
        )
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    return NodeResponse(**data)


@router.get("/graphs/{graph_id}/nodes", response_model=list[NodeResponse])
async def list_nodes(
    graph_id: str,
    type: str | None = Query(None, description="按节点子类型过滤"),
    store: GraphStore = Depends(get_graph_store),
) -> list[NodeResponse]:
    """列出图谱下的节点，可按 ``type`` 过滤。"""
    if await store.get_graph(graph_id) is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    items = await store.list_nodes(graph_id, node_type=type)
    return [NodeResponse(**n) for n in items]


@router.patch(
    "/graphs/{graph_id}/nodes/{node_id}", response_model=NodeResponse
)
async def update_node(
    graph_id: str,
    node_id: str,
    body: NodeUpdate,
    store: GraphStore = Depends(get_graph_store),
) -> NodeResponse:
    """更新节点字段（仅更新非 None 字段）。"""
    existing = await store.get_node(node_id)
    if existing is None or existing["graph_id"] != graph_id:
        raise _not_found(f"节点不存在或不属于图谱 {graph_id}: {node_id}")
    try:
        data = await store.update_node(
            node_id,
            title=body.title,
            summary=body.summary,
            detail_payload=body.detail_payload,
            is_gray=body.is_gray,
            user_fill=body.user_fill,
            node_type=body.type,
            confidence=body.confidence,
        )
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    if data is None:
        raise _not_found(f"节点不存在: {node_id}")
    return NodeResponse(**data)


@router.delete("/graphs/{graph_id}/nodes/{node_id}")
async def delete_node(
    graph_id: str,
    node_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> dict[str, Any]:
    """删除节点（级联清理相关边与测验）。"""
    existing = await store.get_node(node_id)
    if existing is None or existing["graph_id"] != graph_id:
        raise _not_found(f"节点不存在或不属于图谱 {graph_id}: {node_id}")
    ok = await store.delete_node(node_id)
    if not ok:
        raise _not_found(f"节点不存在: {node_id}")
    return {"deleted": True, "id": node_id}


# ============================================================================
# 边 CRUD
# ============================================================================


@router.post(
    "/graphs/{graph_id}/edges", response_model=EdgeResponse, status_code=201
)
async def create_edge(
    graph_id: str,
    body: EdgeCreate,
    store: GraphStore = Depends(get_graph_store),
) -> EdgeResponse:
    """在指定图谱下创建无向边。

    要求 ``src_id`` / ``dst_id`` 均属于该图谱；同图谱同两端同关系的边不重复创建
    （幂等，返回已存在边）。
    """
    try:
        data = await store.create_edge(
            graph_id=graph_id,
            src_id=body.src_id,
            dst_id=body.dst_id,
            relation=body.relation,
        )
    except ValueError as exc:
        raise _handle_value_error(exc) from exc
    return EdgeResponse(**data)


@router.get("/graphs/{graph_id}/edges", response_model=list[EdgeResponse])
async def list_edges(
    graph_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> list[EdgeResponse]:
    """列出图谱下的全部边。"""
    if await store.get_graph(graph_id) is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    items = await store.list_edges(graph_id)
    return [EdgeResponse(**e) for e in items]


@router.delete("/graphs/{graph_id}/edges/{edge_id}")
async def delete_edge(
    graph_id: str,
    edge_id: str,
    store: GraphStore = Depends(get_graph_store),
) -> dict[str, Any]:
    """删除边。"""
    # 校验边存在且属于该图谱（list_edges 已按 graph_id 过滤）
    edges = await store.list_edges(graph_id)
    if not any(e["id"] == edge_id for e in edges):
        raise _not_found(f"边不存在或不属于图谱 {graph_id}: {edge_id}")
    ok = await store.delete_edge(edge_id)
    if not ok:
        raise _not_found(f"边不存在: {edge_id}")
    return {"deleted": True, "id": edge_id}

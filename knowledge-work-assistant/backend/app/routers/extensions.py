"""节点延伸路由（Task 8）。

提供节点延伸生成与撤销接口，挂载在 ``/api`` 前缀下：

- ``POST /api/graphs/{graph_id}/nodes/{node_id}/extend``
  基于源节点生成延伸节点：双击 ``mode=all`` 生成全部延伸（灰色），
  单击方向 ``mode=single`` 仅生成指定方向。
- ``POST /api/graphs/{graph_id}/nodes/{node_id}/extend-revoke``
  撤销上一次全部延伸（删除该批新节点与边）。

设计要点：

1. **不修改 graph_store / graph_agent**：仅通过 ``graph_agent.generate_extensions``
   拿候选节点列表，再调用 ``graph_store.create_node`` / ``create_edge`` 落库。
2. **已存在节点不重复创建**：``generate_extensions`` 已基于标题相似度
   （``_titles_similar``）标记 ``existing=True``；本层再二次查表确认，
   把已存在节点 id 一并返回给前端做高亮闪烁提示。
3. **撤销机制**：用进程内字典 ``_extension_batches`` 记录 ``batch_id →
   {node_ids, edge_ids}``。重启丢失可接受；后续如需持久化可改为 DB 表
   或在节点 ``source`` 字段加 ``extension_batch`` 元数据。
4. **仅 ``mode=all`` 记录 batch**：单点延伸不进 batch（不可撤销，因其
   通常作为有意识的添加）。前端据此控制「撤销」按钮显隐。
5. **降级透明**：``generate_extensions`` 在 LLM 不可用时返回降级结果
   （``direction_name`` 直接作为标题），本层照常落库，前端可正常使用。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.models.node_types import EDGE_EXTENDS, NODE_SOURCE_EXTENSION
from app.services.graph_agent import GraphAgent, _titles_similar, get_graph_agent
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# 进程内 batch 记录（撤销用）
# ============================================================================

#: ``batch_id -> {graph_id, source_node_id, node_ids, edge_ids, mode}``
#:
#: 仅记录 ``mode=all`` 的延伸批次，重启丢失可接受。
_extension_batches: dict[str, dict[str, Any]] = {}


def _new_batch_id() -> str:
    return uuid.uuid4().hex


# ============================================================================
# 依赖注入
# ============================================================================


def get_graph_store_dep() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store


def get_agent() -> GraphAgent:
    """依赖注入：返回全局 GraphAgent 单例。"""
    return get_graph_agent()


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# ============================================================================
# 请求 / 响应模型
# ============================================================================


class ExtendRequest(BaseModel):
    """延伸请求。"""

    mode: Literal["all", "single"] = Field(
        "all", description="all=全部延伸（双击，可撤销）；single=单点延伸（指定方向）"
    )
    direction_name: str | None = Field(
        None, description="mode=single 时指定的延伸方向名；mode=all 时忽略"
    )


class ExtendRevokeRequest(BaseModel):
    """撤销延伸请求。"""

    batch_id: str = Field(..., description="extend 接口返回的 batch_id")


class ExtendResultItem(BaseModel):
    """单个延伸节点结果（新建或已存在）。"""

    node_id: str
    title: str
    summary: str = ""
    type: str = ""
    direction_name: str = ""
    is_gray: bool = True
    existing: bool = False


class ExtendResponse(BaseModel):
    """延伸响应。"""

    created: list[ExtendResultItem] = Field(
        default_factory=list, description="本次新建的延伸节点列表"
    )
    existing: list[ExtendResultItem] = Field(
        default_factory=list, description="命中已存在节点（不重复创建）的列表"
    )
    batch_id: str = Field("", description="本次延伸的批次 ID（仅 mode=all 且有新建时返回）")
    revoked_batch_id: str = Field(
        "", description="同 batch_id，兼容字段名，供前端撤销使用"
    )
    degraded: bool = Field(False, description="是否走 LLM 降级路径")
    mode: str = Field("all", description="本次延伸模式")


class ExtendRevokeResponse(BaseModel):
    """撤销延伸响应。"""

    deleted_nodes: int
    deleted_edges: int
    batch_id: str


# ============================================================================
# 路由
# ============================================================================


@router.post(
    "/graphs/{graph_id}/nodes/{node_id}/extend", response_model=ExtendResponse
)
async def extend_node(
    graph_id: str,
    node_id: str,
    body: ExtendRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> ExtendResponse:
    """基于源节点生成延伸节点。

    流程：
    1. 校验源节点存在且属于图谱。
    2. 调用 ``graph_agent.generate_extensions`` 得到候选节点列表
       （已含 ``existing`` 标记，基于标题相似度去重）。
    3. 对每个候选：
       - ``existing=False`` → ``create_node(is_gray=True, source=extension)``
         + ``create_edge(relation=extends)`` 连接源节点。
       - ``existing=True`` → 不重复创建，二次查表确认已存在节点 id，
         加入 ``existing`` 列表供前端高亮闪烁。
    4. ``mode=all`` 且有新建节点时，生成 ``batch_id`` 记入 ``_extension_batches``。
    """
    node = await store.get_node(node_id)
    if node is None or node.get("graph_id") != graph_id:
        raise _not_found(
            f"节点不存在或不属于图谱 {graph_id}: {node_id}"
        )
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")

    # 延伸命中源节点：提及 +1（智能推荐权重）。失败不阻断主流程。
    try:
        await store.incr_mention(node_id)
    except Exception as exc:  # noqa: BLE001
        logger.debug("incr_mention 失败 node=%s: %s", node_id, exc)

    # 调用 Agent 生成候选
    try:
        candidates = await agent.generate_extensions(
            node_id, graph_id, mode=body.mode, direction_name=body.direction_name
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("extend: generate_extensions 异常: %s", exc)
        candidates = []

    if not candidates:
        return ExtendResponse(
            created=[], existing=[], batch_id="", mode=body.mode
        )

    # 二次查表，避免与已有节点重复（Agent 已做过，这里兜底）
    existing_nodes = await store.list_nodes(graph_id)

    created_items: list[ExtendResultItem] = []
    existing_items: list[ExtendResultItem] = []
    created_node_ids: list[str] = []
    created_edge_ids: list[str] = []
    degraded = False

    for cand in candidates:
        title = (cand.get("title") or "").strip()
        if not title:
            continue
        if cand.get("degraded"):
            degraded = True

        # 二次确认是否已存在（覆盖 Agent 与库之间的时序差异）
        dup_node_id = ""
        for n in existing_nodes:
            if _titles_similar(n.get("title", ""), title):
                dup_node_id = n.get("id", "")
                break

        if cand.get("existing") or dup_node_id:
            existing_items.append(
                ExtendResultItem(
                    node_id=dup_node_id or "",
                    title=title,
                    summary=cand.get("summary", ""),
                    type=cand.get("type", ""),
                    direction_name=cand.get("direction_name", ""),
                    is_gray=True,
                    existing=True,
                )
            )
            continue

        # 新建灰色延伸节点 + extends 边
        try:
            new_node = await store.create_node(
                graph_id=graph_id,
                node_type=cand.get("type", node.get("type", "general")),
                title=title,
                summary=cand.get("summary", ""),
                detail_payload=cand.get("detail_payload"),
                is_gray=True,
                source=NODE_SOURCE_EXTENSION,
                confidence=float(cand.get("confidence", 0.7)),
            )
        except ValueError as exc:
            logger.warning("extend: create_node 失败 title=%s err=%s", title, exc)
            existing_items.append(
                ExtendResultItem(
                    node_id="",
                    title=title,
                    summary=cand.get("summary", ""),
                    type=cand.get("type", ""),
                    direction_name=cand.get("direction_name", ""),
                    is_gray=True,
                    existing=True,
                )
            )
            continue

        try:
            edge = await store.create_edge(
                graph_id=graph_id,
                src_id=node_id,
                dst_id=new_node["id"],
                relation=EDGE_EXTENDS,
            )
            created_edge_ids.append(edge["id"])
        except ValueError as exc:
            logger.warning("extend: create_edge 失败 src=%s dst=%s err=%s",
                           node_id, new_node["id"], exc)

        created_items.append(
            ExtendResultItem(
                node_id=new_node["id"],
                title=title,
                summary=new_node.get("summary", ""),
                type=new_node.get("type", ""),
                direction_name=cand.get("direction_name", ""),
                is_gray=True,
                existing=False,
            )
        )
        created_node_ids.append(new_node["id"])
        # 把新建节点加入 existing_nodes，防止本批内重复创建同标题节点
        existing_nodes.append(new_node)

    # 仅 mode=all 且有新建时记录 batch
    batch_id = ""
    if body.mode == "all" and created_node_ids:
        batch_id = _new_batch_id()
        _extension_batches[batch_id] = {
            "graph_id": graph_id,
            "source_node_id": node_id,
            "node_ids": created_node_ids,
            "edge_ids": created_edge_ids,
            "mode": body.mode,
        }

    return ExtendResponse(
        created=created_items,
        existing=existing_items,
        batch_id=batch_id,
        revoked_batch_id=batch_id,
        degraded=degraded,
        mode=body.mode,
    )


@router.post(
    "/graphs/{graph_id}/nodes/{node_id}/extend-revoke",
    response_model=ExtendRevokeResponse,
)
async def revoke_extend(
    graph_id: str,
    node_id: str,
    body: ExtendRevokeRequest,
    store: GraphStore = Depends(get_graph_store_dep),
) -> ExtendRevokeResponse:
    """撤销上一次全部延伸。

    删除该批新节点与对应边。``batch_id`` 必须与 ``graph_id`` / 源 ``node_id``
    匹配；不匹配或不存在返回 404。
    """
    batch = _extension_batches.get(body.batch_id)
    if batch is None:
        raise _not_found(f"撤销批次不存在: {body.batch_id}")
    if batch.get("graph_id") != graph_id:
        raise _not_found("批次不属于该图谱")
    if batch.get("source_node_id") != node_id:
        raise _not_found("批次不属于该源节点")

    deleted_nodes = 0
    deleted_edges = 0

    # 先删边再删节点（节点删除会级联清边，但显式删边可记录条数）
    for eid in batch.get("edge_ids", []):
        if await store.delete_edge(eid):
            deleted_edges += 1
    for nid in batch.get("node_ids", []):
        if await store.delete_node(nid):
            deleted_nodes += 1

    del _extension_batches[body.batch_id]

    logger.info(
        "extend-revoke: batch=%s graph=%s node=%s deleted_nodes=%d deleted_edges=%d",
        body.batch_id, graph_id, node_id, deleted_nodes, deleted_edges,
    )

    return ExtendRevokeResponse(
        deleted_nodes=deleted_nodes,
        deleted_edges=deleted_edges,
        batch_id=body.batch_id,
    )

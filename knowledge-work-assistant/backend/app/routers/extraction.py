"""Study 对话节点抽取路由（Task 11）。

提供观察记录列表、节点抽取与批量入图接口，挂载在 ``/api`` 前缀下：

- ``GET  /api/observations``                              列出观察记录（默认未处理）
- ``POST /api/observations/{observation_id}/extract``     抽取候选节点（不入图，返回待确认列表）
- ``POST /api/graphs/{graph_id}/nodes/batch``             批量创建已确认节点（归一去重）
- ``POST /api/observations/{observation_id}/extract-and-confirm``  一步抽取并直接入图

设计要点：

1. **抽取不入图**：``extract`` 仅调用 ``graph_agent.extract_nodes_from_observation``
   返回候选节点列表（含 ``source_reason``），由前端展示后用户确认再调
   ``batch`` 真正落库。这样保留用户对 AI 抽取结果的掌控。
2. **归一去重**：``batch`` 接口在创建前对每个候选节点标题做相似度判断
   （复用 ``graph_agent._titles_similar``），与现有节点标题相似的跳过，
   并返回 ``existing_node_id`` 供前端高亮提示。重复命中也会对已存在节点
   调 ``incr_mention`` 累计热度，让智能推荐感知到该节点被反复提及。
3. **graph_type 推断**：``extract`` 时根据 ``graph_id`` 查 ``graph.type``
   传给 Agent，决定抽取目标（学科 / 工作对象）。
4. **不修改 graph_store / graph_agent**：仅组合调用既有方法。
5. **extract-and-confirm**：便捷接口，内部依次调 extract + batch，返回合并结果。
6. **observation 标记**：``extract-and-confirm`` 成功后调
   ``mark_observation_processed`` 标记已处理；``extract`` 不标记（用户可能
   取消），由 ``batch`` 成功后或前端显式调用清理接口标记。这里在 batch
   成功后尝试根据 ``observation_id``（前端传）标记。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.models.node_types import NODE_SOURCE_AGENT, OBSERVATION_SOURCES
from app.models.schemas import NodeResponse, ObservationResponse
from app.services.graph_agent import GraphAgent, _titles_similar, get_graph_agent
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter()


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


class ExtractRequest(BaseModel):
    """抽取请求。"""

    graph_id: str = Field(..., description="目标图谱 ID，决定抽取目标与子类型")


class CandidateNodeCreate(BaseModel):
    """单个候选节点（待确认或已确认入图）。"""

    title: str = Field(..., min_length=1, max_length=255)
    summary: str = Field("", description="一句话概括")
    type: str = Field(..., description="节点子类型")
    detail_payload: dict[str, Any] | None = Field(None)
    confidence: float = Field(0.7, ge=0.0, le=1.0)
    source_reason: str = Field("", description="抽取依据（供用户判断）")


class BatchCreateRequest(BaseModel):
    """批量创建节点请求。"""

    nodes: list[CandidateNodeCreate] = Field(..., min_length=1)
    observation_id: str | None = Field(
        None, description="可选：成功后标记该 observation 为已处理"
    )


class ExtractResponse(BaseModel):
    """抽取响应。"""

    observation_id: str
    graph_id: str
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    degraded: bool = False


class SkippedItem(BaseModel):
    """批量创建时跳过的节点（已存在或失败）。"""

    title: str
    existing_node_id: str | None = None
    error: str | None = None


class BatchCreateResponse(BaseModel):
    """批量创建响应。"""

    created: list[NodeResponse] = Field(default_factory=list)
    skipped: list[SkippedItem] = Field(default_factory=list)
    created_count: int
    skipped_count: int
    observation_processed: bool = False


# ============================================================================
# 路由
# ============================================================================


@router.get("/observations", response_model=list[ObservationResponse])
async def list_observations(
    processed: bool | None = Query(
        None, description="处理状态过滤：True 仅已处理，False 仅未处理，None 全部"
    ),
    source: str | None = Query(None, description="来源过滤：plugin/import/manual"),
    graph_id: str | None = Query(None, description="图谱过滤"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    store: GraphStore = Depends(get_graph_store_dep),
) -> list[ObservationResponse]:
    """列出观察记录，默认按创建时间倒序。

    前端「待抽取」入口通常传 ``processed=false`` 拉取未处理列表。
    """
    items = await store.list_observations(
        graph_id=graph_id,
        source=source,
        processed=processed,
        limit=limit,
        offset=offset,
    )
    return [ObservationResponse(**o) for o in items]


@router.post("/observations/clear")
async def clear_observations(
    source: str | None = Query(
        None,
        description="按来源过滤：plugin / import / manual，省略则清空全部",
    ),
    store: GraphStore = Depends(get_graph_store_dep),
) -> dict[str, Any]:
    """批量清空观察记录。

    observations 表无 mode 字段，故按 ``source`` 过滤；``source=None`` 清全部。
    observations 是抽取图谱的源材料，与图谱解耦（删图谱时其 ``graph_id`` 被
    SET NULL），故本操作不影响图谱数据。

    幂等：无匹配数据时返回 ``deleted_count=0``。
    """
    if source is not None and source not in OBSERVATION_SOURCES:
        raise _bad_request(f"非法来源: {source}（允许: {OBSERVATION_SOURCES}）")
    try:
        count = await store.delete_observations_by_source(source)
    except ValueError as exc:
        # delete_observations_by_source 对非法 source 抛 ValueError，映射为 400
        raise _bad_request(str(exc)) from exc
    return {"ok": True, "deleted_count": count, "source": source}


@router.post(
    "/observations/{observation_id}/extract", response_model=ExtractResponse
)
async def extract_nodes(
    observation_id: str,
    body: ExtractRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> ExtractResponse:
    """从一条 Observation 对话中抽取候选节点（不入图）。

    返回候选节点列表，每项含 ``title / summary / type / detail_payload /
    confidence / source_reason``，由前端展示供用户确认。
    """
    observation = await store.get_observation(observation_id)
    if observation is None:
        raise _not_found(f"观察记录不存在: {observation_id}")

    graph = await store.get_graph(body.graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {body.graph_id}")

    graph_type = graph.get("type", "study")
    try:
        result = await agent.extract_nodes_from_observation(
            observation_id, graph_type
        )
        # 新版本返回 dict；做一次 isinstance 兜底以防降级路径返回 list
        candidates = (
            result.get("nodes", []) if isinstance(result, dict) else (result or [])
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("extract: agent 抽取异常: %s", exc)
        candidates = []

    # 标记是否降级（空列表时也可能是 LLM 不可用）
    degraded = len(candidates) == 0

    return ExtractResponse(
        observation_id=observation_id,
        graph_id=body.graph_id,
        candidates=candidates,
        degraded=degraded,
    )


@router.post(
    "/graphs/{graph_id}/nodes/batch", response_model=BatchCreateResponse
)
async def batch_create_nodes(
    graph_id: str,
    body: BatchCreateRequest,
    store: GraphStore = Depends(get_graph_store_dep),
) -> BatchCreateResponse:
    """批量创建已确认节点。

    归一去重：对每个候选节点标题与现有节点做 ``_titles_similar`` 比较，
    相似的跳过并返回 ``existing_node_id``，不重复创建。

    若 ``observation_id`` 提供，成功创建至少一个节点后标记该 observation
    为已处理（避免重复抽取）。
    """
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")

    existing_nodes = await store.list_nodes(graph_id)

    created: list[NodeResponse] = []
    skipped: list[SkippedItem] = []

    for cand in body.nodes:
        title = cand.title.strip()
        if not title:
            continue

        # 归一去重：与现有节点（含本批已建）标题相似则跳过
        dup_id: str | None = None
        for n in existing_nodes:
            if _titles_similar(n.get("title", ""), title):
                dup_id = n.get("id")
                break
        if dup_id:
            skipped.append(
                SkippedItem(title=title, existing_node_id=dup_id)
            )
            # 重复命中也计热度：对已存在节点提及计数 +1，
            # 让智能推荐感知到该节点仍被频繁提及。失败不阻断主流程。
            try:
                await store.incr_mention(dup_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "incr_mention 失败 dup node=%s: %s", dup_id, exc
                )
            continue

        try:
            node = await store.create_node(
                graph_id=graph_id,
                node_type=cand.type,
                title=title,
                summary=cand.summary,
                detail_payload=cand.detail_payload,
                is_gray=False,
                source=NODE_SOURCE_AGENT,
                confidence=cand.confidence,
            )
        except ValueError as exc:
            skipped.append(SkippedItem(title=title, error=str(exc)))
            continue

        created.append(NodeResponse(**node))
        # 抽取入图：节点被提及 +1（智能推荐权重）。失败不阻断主流程。
        try:
            await store.incr_mention(node["id"])
        except Exception as exc:  # noqa: BLE001
            logger.debug("incr_mention 失败 node=%s: %s", node.get("id"), exc)
        # 加入 existing_nodes 防止批内重复
        existing_nodes.append(node)

    # 成功创建后标记 observation 为已处理
    observation_processed = False
    if body.observation_id and created:
        updated = await store.mark_observation_processed(body.observation_id)
        observation_processed = updated is not None

    return BatchCreateResponse(
        created=created,
        skipped=skipped,
        created_count=len(created),
        skipped_count=len(skipped),
        observation_processed=observation_processed,
    )


@router.post(
    "/observations/{observation_id}/extract-and-confirm",
    response_model=BatchCreateResponse,
)
async def extract_and_confirm(
    observation_id: str,
    body: ExtractRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> BatchCreateResponse:
    """一步抽取并直接入图（简化流程）。

    内部依次调 ``extract_nodes_from_observation`` + ``batch create_node``，
    成功后标记 observation 为已处理。返回 ``created`` 与 ``skipped`` 列表。
    """
    observation = await store.get_observation(observation_id)
    if observation is None:
        raise _not_found(f"观察记录不存在: {observation_id}")
    graph = await store.get_graph(body.graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {body.graph_id}")

    graph_type = graph.get("type", "study")
    try:
        result = await agent.extract_nodes_from_observation(
            observation_id, graph_type
        )
        # 新版本返回 dict；做一次 isinstance 兜底以防降级路径返回 list
        candidates = (
            result.get("nodes", []) if isinstance(result, dict) else (result or [])
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("extract-and-confirm: agent 抽取异常: %s", exc)
        candidates = []

    if not candidates:
        return BatchCreateResponse(
            created=[], skipped=[], created_count=0, skipped_count=0
        )

    # 复用 batch 逻辑：构造 BatchCreateRequest 调内部函数
    batch_body = BatchCreateRequest(
        nodes=[
            CandidateNodeCreate(
                title=c.get("title", ""),
                summary=c.get("summary", ""),
                type=c.get("type", "general"),
                detail_payload=c.get("detail_payload"),
                confidence=float(c.get("confidence", 0.7)),
                source_reason=c.get("source_reason", ""),
            )
            for c in candidates
            if c.get("title")
        ],
        observation_id=observation_id,
    )
    return await batch_create_nodes(body.graph_id, batch_body, store)

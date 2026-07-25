"""流式触发路由。

提供 LLM 流式输出的 HTTP 触发端点：前端发起请求后立即返回 ``request_id``，
后台异步调用 ``GraphAgent`` 的流式方法，逐 token 通过 WebSocket 推送给
发起请求的前端连接（按 ``session_id`` 路由）。

端点：

- ``POST /api/graphs/{graph_id}/nodes/{node_id}/detail-stream``
  节点详情卡流式生成（Markdown，逐 token 推送）。
- ``POST /api/graphs/{graph_id}/work/ask-stream``
  Work 问答流式生成（基于图谱上下文回答，逐 token 推送）。
- ``POST /api/graphs/{graph_id}/work/report-stream``
  Work 工作报告流式生成（Markdown，逐 token 推送）。

设计要点：

1. **HTTP 即返回**：端点收到请求后通过 ``asyncio.create_task`` 启动后台
   流式任务，立即返回 ``{request_id, started: true}``，避免长连接超时。
2. **WS 推送**：流式 token 通过 :func:`ws_notify.notify_session` 推送至
   前端建立连接时传入的 ``session_id``。前端监听 ``graph_agent_token`` /
   ``graph_agent_done`` / ``graph_agent_cancelled`` / ``graph_agent_error``
   事件并实时渲染。
3. **取消支持**：返回的 ``request_id`` 可用于通过
   ``POST /api/llm/requests/{id}/cancel`` 取消，流式调用在下一个 chunk
   边界主动中断并产出 ``cancelled`` 事件。
4. **降级透明**：LLM 不可用时流式方法产出 ``error`` 事件，前端据此显示
   降级提示但仍可继续操作（如手工编辑详情卡）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.models.node_types import GRAPH_TYPE_WORK
from app.services.graph_agent import GraphAgent, get_graph_agent
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


async def _ensure_graph(graph_id: str, store: GraphStore) -> dict[str, Any]:
    """校验图谱存在，返回图谱 dict。"""
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    return graph


async def _ensure_work_graph(graph_id: str, store: GraphStore) -> dict[str, Any]:
    """校验图谱存在且为 work 模式，返回图谱 dict。"""
    graph = await _ensure_graph(graph_id, store)
    if graph.get("type") != GRAPH_TYPE_WORK:
        raise _bad_request(f"该接口仅支持 work 图谱: {graph_id}")
    return graph


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


# ============================================================================
# 请求模型
# ============================================================================


class DetailStreamRequest(BaseModel):
    """节点详情流式生成请求。"""

    session_id: str = Field(
        ...,
        description=(
            "前端 WebSocket 连接时使用的 session_id，"
            "后端按此推送流式 token 到对应前端连接。"
        ),
    )


class AskStreamRequest(BaseModel):
    """Work 问答流式请求。"""

    question: str = Field(..., min_length=1, description="用户提问")
    session_id: str = Field(..., description="前端 WebSocket session_id")


class ReportStreamRequest(BaseModel):
    """工作报告流式请求。"""

    period: Literal["weekly", "monthly"] = Field(
        "weekly", description="报告周期：weekly 周报 / monthly 月报"
    )
    session_id: str = Field(..., description="前端 WebSocket session_id")


class StreamStartedResponse(BaseModel):
    """流式任务已启动响应。"""

    started: bool = True
    request_id: str | None = Field(
        None,
        description=(
            "LLM 请求 id（可用于通过 /api/llm/requests/{id}/cancel 取消）。"
            "LLM 不可用时为 None，前端将立即收到 error 事件。"
        ),
    )
    op: str = Field(..., description="流式操作类型（generate_node_detail/answer_question/generate_report）")


# ============================================================================
# 后台任务包装
# ============================================================================


async def _run_detail_stream(
    agent: GraphAgent,
    graph_id: str,
    node_id: str,
    session_id: str,
) -> None:
    """后台运行节点详情流式生成，吞掉异常（仅记日志）。

    所有 token / done / error 事件已由 :meth:`GraphAgent._stream_llm`
    通过 :func:`ws_notify.notify_session` 推送给前端，此处仅需消费
    生成器避免协程泄漏。
    """
    try:
        store = agent.store
        node = await store.get_node(node_id)
        if node is None or node.get("graph_id") != graph_id:
            await _notify_error(session_id, "generate_node_detail", graph_id,
                                "节点不存在或不属于该图谱", node_id=node_id)
            return
        graph = await store.get_graph(graph_id)
        if graph is None:
            await _notify_error(session_id, "generate_node_detail", graph_id,
                                "图谱不存在", node_id=node_id)
            return
        graph_type = graph.get("type", "study")
        neighbors = await _collect_neighbors(graph_id, node_id, store)

        async for _event in agent.generate_node_detail_stream(
            node_title=node.get("title", ""),
            node_type=node.get("type", ""),
            graph_type=graph_type,
            neighbors=neighbors,
            session_id=session_id,
            node_id=node_id,
            graph_id=graph_id,
        ):
            # 事件已由 _stream_llm 推送 WS，此处仅需消费生成器
            pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("detail-stream 后台任务异常: %s", exc)
        await _notify_error(session_id, "generate_node_detail", graph_id,
                            f"后台任务异常: {exc}", node_id=node_id)


async def _run_ask_stream(
    agent: GraphAgent,
    graph_id: str,
    question: str,
    session_id: str,
) -> None:
    """后台运行 Work 问答流式生成。"""
    try:
        async for _event in agent.answer_question_stream(
            graph_id, question, session_id=session_id
        ):
            pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("ask-stream 后台任务异常: %s", exc)
        await _notify_error(session_id, "answer_question", graph_id,
                            f"后台任务异常: {exc}")


async def _run_report_stream(
    agent: GraphAgent,
    graph_id: str,
    period: str,
    session_id: str,
) -> None:
    """后台运行工作报告流式生成。"""
    try:
        async for _event in agent.generate_report_stream(
            graph_id, period=period, session_id=session_id
        ):
            pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("report-stream 后台任务异常: %s", exc)
        await _notify_error(session_id, "generate_report", graph_id,
                            f"后台任务异常: {exc}")


async def _notify_error(
    session_id: str,
    op: str,
    graph_id: str,
    message: str,
    *,
    node_id: str | None = None,
) -> None:
    """向前端推送 error 事件（后台任务异常时兜底）。"""
    from app.services.ws_notify import notify_session

    event: dict[str, Any] = {
        "type": "graph_agent_error",
        "op": op,
        "graph_id": graph_id,
        "message": message,
    }
    if node_id:
        event["node_id"] = node_id
    try:
        await notify_session(session_id, event)
    except Exception:  # noqa: BLE001
        pass


# ============================================================================
# 端点
# ============================================================================


@router.post(
    "/graphs/{graph_id}/nodes/{node_id}/detail-stream",
    response_model=StreamStartedResponse,
)
async def stream_node_detail(
    graph_id: str,
    node_id: str,
    body: DetailStreamRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> StreamStartedResponse:
    """触发节点详情卡流式生成。

    前端发起请求后立即返回 ``request_id``，后台异步调用
    :meth:`GraphAgent.generate_node_detail_stream`，逐 token 通过
    WebSocket 推送至 ``session_id`` 对应的前端连接。

    WS 事件类型：
    - ``graph_agent_token``：每个 token（含 ``op``、``graph_id``、``node_id``、``content``、``seq``）
    - ``graph_agent_done``：流式完成（含 ``full_text``）
    - ``graph_agent_cancelled``：被外部取消
    - ``graph_agent_error``：失败（含 ``message``）
    """
    await _ensure_graph(graph_id, store)
    node = await store.get_node(node_id)
    if node is None or node.get("graph_id") != graph_id:
        raise _not_found(f"节点不存在或不属于图谱 {graph_id}: {node_id}")

    # 启动后台流式任务（不等待，立即返回）
    asyncio.create_task(
        _run_detail_stream(agent, graph_id, node_id, body.session_id)
    )

    # request_id 无法在端点层预知（在 GraphAgent 内部 register 后才生成），
    # 此处返回 op 标识，前端可通过 WS 的 done 事件拿到 request_id 关联。
    return StreamStartedResponse(
        started=True,
        request_id=None,
        op="generate_node_detail",
    )


@router.post(
    "/graphs/{graph_id}/work/ask-stream",
    response_model=StreamStartedResponse,
)
async def stream_ask_question(
    graph_id: str,
    body: AskStreamRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> StreamStartedResponse:
    """触发 Work 问答流式生成。

    前端发起请求后立即返回，后台异步调用
    :meth:`GraphAgent.answer_question_stream`，逐 token 通过 WebSocket
    推送至 ``session_id`` 对应的前端连接。
    """
    await _ensure_work_graph(graph_id, store)

    asyncio.create_task(
        _run_ask_stream(agent, graph_id, body.question, body.session_id)
    )

    return StreamStartedResponse(
        started=True,
        request_id=None,
        op="answer_question",
    )


@router.post(
    "/graphs/{graph_id}/work/report-stream",
    response_model=StreamStartedResponse,
)
async def stream_generate_report(
    graph_id: str,
    body: ReportStreamRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> StreamStartedResponse:
    """触发工作报告流式生成。

    前端发起请求后立即返回，后台异步调用
    :meth:`GraphAgent.generate_report_stream`，逐 token 通过 WebSocket
    推送至 ``session_id`` 对应的前端连接。
    """
    await _ensure_work_graph(graph_id, store)

    asyncio.create_task(
        _run_report_stream(agent, graph_id, body.period, body.session_id)
    )

    return StreamStartedResponse(
        started=True,
        request_id=None,
        op="generate_report",
    )

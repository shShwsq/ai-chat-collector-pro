"""Chat 对话路由（Task 8）。

为前端 ChatPanel 多轮对话提供后端支持，挂载在 ``/api/chat`` 前缀下：

- ``POST /api/chat/sessions``                       创建会话（mode + graph_id?）
- ``GET  /api/chat/sessions?mode=study|work``        列出当前模式会话
- ``PATCH /api/chat/sessions/{id}``                 更新会话字段（重命名）
- ``DELETE /api/chat/sessions/{id}``                 删除会话（级联清理）
- ``GET  /api/chat/sessions/{id}/messages``          获取会话消息历史
- ``POST /api/chat/sessions/{id}/stream``           流式对话（HTTP 立即返回 request_id）
- ``POST /api/chat/sessions/{id}/checkpoint``       手动触发 writer_agent 生成 checkpoint
- ``GET  /api/chat/sessions/{id}/checkpoint``       获取最新 checkpoint 内容
- ``POST /api/chat/requests/{id}/cancel``          取消流式对话（复用 llm_request_registry）
- ``POST /api/chat/requests/{id}/confirm``         确认高风险工具调用（唤醒暂停的工具循环）

设计要点：

1. **会话级 MainAgent 缓存**：每个 chat session 拥有独立的 :class:`MainAgent`
   实例（按 ``session_id`` 缓存到模块级 dict），保留 ``context_manager`` 等会话级
   状态跨多轮对话持续有效。
2. **HTTP 即返回**：流式端点收到请求后通过 ``asyncio.create_task`` 启动后台
   流式任务，立即返回 ``{request_id, started: true}``，避免长连接超时。
3. **WS 推送（op="chat"）**：流式 token 通过 :func:`ws_notify.notify_session`
   推送至前端建立连接时传入的 ``session_id``。复用现有 ``graph_agent_token``
   协议但 ``op="chat"``，前端按 ``op`` 区分。新增 ``chat_tool_call`` /
   ``chat_tool_result`` / ``chat_tool_call_confirmation`` 事件类型。
4. **取消支持**：返回的 ``request_id`` 可用于通过
   ``POST /api/chat/requests/{id}/cancel`` 取消；同时调用 ``MainAgent.cancel()``
   触发流式调用在下一个 chunk 边界主动中断。
5. **高风险确认**：``POST /api/chat/requests/{id}/confirm`` 调用
   :func:`main_agent.resolve_tool_confirmation` 唤醒暂停的工具循环。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.db import AsyncSessionLocal
from app.models.db_models import Checkpoint as CheckpointRow
from app.models.db_models import Message as MessageRow
from app.models.db_models import Session as SessionRow
from app.services.llm_factory import get_llm_client
from app.services.llm_request_registry import llm_request_registry
from app.services.main_agent import MainAgent, resolve_tool_confirmation
from app.services.task_registry import background_tasks
from app.services.ws_notify import is_session_online, notify_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


# ============================================================================
# 模块级状态
# ============================================================================

#: 会话级 MainAgent 缓存：session_id -> MainAgent 实例
#: 每个 chat session 拥有独立实例以保留 context_manager 等会话级状态
_session_agents: dict[str, MainAgent] = {}

#: 流式任务注册表：request_id -> asyncio.Task（用于取消时 await）
_chat_tasks: dict[str, asyncio.Task[None]] = {}

#: request_id -> session_id 映射（用于 cancel 端点定位 MainAgent）
_request_sessions: dict[str, str] = {}

# 同一 chat session 的 MainAgent 含有可变的模式与取消状态，同一时间只允许
# 一个流式请求占用它。这里仅记录正在运行的 request，不把请求排队到未知时长。
_session_active_requests: dict[str, str] = {}
_session_admission_lock = asyncio.Lock()


# ============================================================================
# 工具函数
# ============================================================================


def _now() -> datetime:
    return datetime.now(UTC)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


async def _get_session_row(session_id: str) -> SessionRow | None:
    """查询会话记录。"""
    async with AsyncSessionLocal() as db:
        return await db.get(SessionRow, session_id)


async def _build_llm_client() -> Any:
    """构造 LLMClient（从 settings 表读取配置）。

    LLMClient 不缓存到 MainAgent 单例，因为用户可能在前端「设置面板」
    修改 LLM 配置；每次创建会话或新建 MainAgent 时重新读取，使配置变更
    即时生效。

    Returns:
        LLMClient 实例。base_url/api_key/model 缺失时抛 HTTPException(400)。
    """
    async with AsyncSessionLocal() as db:
        return await get_llm_client(db)


async def _get_or_create_session_agent(session: SessionRow) -> MainAgent:
    """获取或创建会话级 MainAgent 实例（按 session_id 缓存）。

    配置变更后通过 :meth:`MainAgent.update_llm_client` 刷新实例的 LLMClient，
    避免长期缓存导致配置无法生效。

    Args:
        session: 会话 DB 记录（含 mode / graph_id）。

    Returns:
        与该 session 绑定的 MainAgent 实例。
    """
    cached = _session_agents.get(session.id)
    if cached is not None:
        # 配置可能在前端被修改，每次取用时刷新 LLMClient
        try:
            new_client = await _build_llm_client()
            cached.update_llm_client(new_client)
        except HTTPException:
            # LLM 未配置时保留旧 client（chat_stream 调用时会报错）
            pass
        # 同步 mode / graph_id / plan_mode 到实例（用户可能切换图谱或 Plan/Build）
        scenario_mode = session.mode if session.mode in ("study", "work") else "work"
        await cached.switch_scenario_mode(scenario_mode)
        cached.set_graph_id(session.graph_id)
        return cached

    # 新建 MainAgent 实例
    try:
        llm_client = await _build_llm_client()
    except HTTPException as exc:
        # LLM 未配置：仍创建 MainAgent 实例（chat_stream 调用时会 yield error 事件）
        logger.warning("创建会话 MainAgent 时 LLM 未配置: %s", exc.detail)
        from app.config import settings
        from app.services.llm_client import LLMClient
        llm_client = LLMClient(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
        )

    agent = MainAgent(
        session_id=session.id,
        llm_client=llm_client,
        mode=session.mode if session.mode in ("study", "work") else "work",
        plan_mode=False,  # 默认 Build；用户可切换 Plan/Build 模式
        graph_id=session.graph_id,
    )
    _session_agents[session.id] = agent
    logger.info(
        "创建会话 MainAgent session=%s mode=%s graph_id=%s",
        session.id,
        agent.scenario_mode,
        session.graph_id,
    )
    return agent


async def _run_chat_stream(
    agent: MainAgent,
    session_id: str,
    ws_session_id: str,
    request_id: str,
    user_message: str,
    plan_mode: bool,
    graph_id: str | None,
    mode: str,
) -> None:
    """后台运行 chat_stream，吞掉异常（仅记日志）。

    所有 token / tool_call / done / error 事件通过 :func:`ws_notify.notify_session`
    推送给前端。token 序号由本地维护（``seq`` 字段）。

    Args:
        session_id: chat 会话 ID（用于 DB 操作与日志）。
        ws_session_id: 前端 WebSocket 连接注册时的 session_id，WS 事件
            必须推送到此 ID 才能被前端接收（与 chat session_id 不同）。
    """
    full_text_parts: list[str] = []
    seq = 0
    failed = False

    # 标记 LLM 请求为 running
    await llm_request_registry.update(request_id, "running")

    # 预检：LLM 未配置（api_key / base_url 为空）时立即推送错误，避免等待重试
    llm = getattr(agent, "llm_client", None)
    if llm is not None and (not llm.api_key or not llm.base_url):
        message = "LLM 服务未配置，请在设置面板中填入 baseURL / apiKey / model 后重试。"
        await _push_ws(
            ws_session_id,
            {
                "type": "graph_agent_error",
                "op": "chat",
                "session_id": session_id,
                "request_id": request_id,
                "message": message,
            },
        )
        await llm_request_registry.update(request_id, "failed", error=message)
        _chat_tasks.pop(request_id, None)
        _request_sessions.pop(request_id, None)
        async with _session_admission_lock:
            if _session_active_requests.get(session_id) == request_id:
                _session_active_requests.pop(session_id, None)
        return

    try:
        async for event in agent.chat_stream(
            user_message,
            graph_id=graph_id,
            mode=mode,
            plan_mode=plan_mode,
        ):
            etype = event.get("type")

            if etype == "token":
                content = event.get("content", "")
                full_text_parts.append(content)
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "graph_agent_token",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "content": content,
                        "seq": seq,
                    },
                )
                seq += 1

            elif etype == "thinking":
                # 思维链增量：独立 WS 事件，前端单独折叠显示
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "chat_thinking",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "content": event.get("content", ""),
                    },
                )

            elif etype == "tool_call":
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "chat_tool_call",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "tool": event.get("tool", ""),
                        "args": event.get("args", {}),
                        "tool_call_id": event.get("id", ""),
                    },
                )

            elif etype == "tool_result":
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "chat_tool_result",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "tool": event.get("tool", ""),
                        "result": event.get("result", {}),
                    },
                )

            elif etype == "content_replace":
                # 后处理剥离测验题内容：替换前端已显示的正文
                cleaned = event.get("content", "")
                full_text_parts.clear()
                full_text_parts.append(cleaned)
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "chat_content_replace",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "content": cleaned,
                    },
                )

            elif etype == "tool_call_confirmation":
                # 高风险工具确认请求：已在 main_agent.request_tool_confirmation 中推送
                # 此处不再重复推送，仅记日志
                logger.info(
                    "chat 高风险工具确认已推送 session=%s tool=%s",
                    session_id,
                    event.get("tool"),
                )

            elif etype == "error":
                message = _friendly_error_message(event.get("message", "未知错误"))
                failed = True
                await _push_ws(
                    ws_session_id,
                    {
                        "type": "graph_agent_error",
                        "op": "chat",
                        "session_id": session_id,
                        "request_id": request_id,
                        "message": message,
                    },
                )
                await llm_request_registry.update(
                    request_id, "failed", error=message
                )

            elif etype == "done":
                # 检查是否被取消
                cancelled = await llm_request_registry.is_cancelled(request_id)
                full_text = "".join(full_text_parts)
                if cancelled:
                    await _push_ws(
                        ws_session_id,
                        {
                            "type": "graph_agent_cancelled",
                            "op": "chat",
                            "session_id": session_id,
                            "request_id": request_id,
                            "full_text": full_text,
                        },
                    )
                    await llm_request_registry.update(request_id, "cancelled")
                else:
                    await _push_ws(
                        ws_session_id,
                        {
                            "type": "graph_agent_done",
                            "op": "chat",
                            "session_id": session_id,
                            "request_id": request_id,
                            "full_text": full_text,
                        },
                    )
                    if not failed:
                        await llm_request_registry.update(request_id, "completed")
                return

    except asyncio.CancelledError:
        # 任务被外部取消（cancel 端点触发 StopCommand 或 asyncio.Task.cancel）
        full_text = "".join(full_text_parts)
        await _push_ws(
            ws_session_id,
            {
                "type": "graph_agent_cancelled",
                "op": "chat",
                "session_id": session_id,
                "request_id": request_id,
                "full_text": full_text,
            },
        )
        await llm_request_registry.update(request_id, "cancelled")
        raise

    except Exception as exc:  # noqa: BLE001
        logger.exception("chat_stream 后台任务异常 session=%s: %s", session_id, exc)
        message = _friendly_error_message(str(exc))
        await _push_ws(
            ws_session_id,
            {
                "type": "graph_agent_error",
                "op": "chat",
                "session_id": session_id,
                "request_id": request_id,
                "message": message,
            },
        )
        await llm_request_registry.update(request_id, "failed", error=str(exc))

    finally:
        _chat_tasks.pop(request_id, None)
        _request_sessions.pop(request_id, None)
        async with _session_admission_lock:
            if _session_active_requests.get(session_id) == request_id:
                _session_active_requests.pop(session_id, None)


def _friendly_error_message(raw: str) -> str:
    """将 LLM 异常技术信息转为用户可读的提示。

    LLM 未上线 / 未配置时，底层错误包含连接失败 / 鉴权失败等关键字，
    这里统一映射为前端友好的中文提示，便于用户理解并采取行动。
    """
    if not raw:
        return "LLM 服务不可用，请检查设置中的配置。"
    lower = raw.lower()
    if "连接失败" in raw or "connection" in lower or "connect" in lower or "refused" in lower:
        return "LLM 服务未上线或地址不可达，请在设置中检查 baseURL 并确认服务已启动。"
    if "鉴权失败" in raw or "auth" in lower or "401" in raw or "api key" in lower:
        return "LLM 鉴权失败，请在设置中检查 API Key 是否正确。"
    if "超时" in raw or "timeout" in lower:
        return "LLM 请求超时，服务可能过载或未启动，请稍后重试或检查服务状态。"
    if "限流" in raw or "rate" in lower or "429" in raw:
        return "LLM 服务限流，请稍后重试。"
    return raw


async def _push_ws(session_id: str, event: dict[str, Any]) -> None:
    """向前端 WS 推送事件，吞掉异常（连接不可达时静默忽略）。"""
    try:
        await notify_session(session_id, event)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "chat WS 推送失败 session=%s event_type=%s: %s",
            session_id,
            event.get("type"),
            exc,
        )


# ============================================================================
# 请求 / 响应模型
# ============================================================================


class CreateSessionRequest(BaseModel):
    """创建会话请求。"""

    mode: Literal["study", "work"] = Field(
        ..., description="场景模式：study 学习 / work 工作"
    )
    graph_id: str | None = Field(
        None, description="关联图谱 ID（可空：纯闲聊会话无图谱上下文）"
    )
    title: str | None = Field(None, description="会话标题（可空，自动生成）")


class SessionResponse(BaseModel):
    """会话响应。"""

    id: str
    title: str
    mode: str
    graph_id: str | None = None
    created_at: str
    updated_at: str


class MessageResponse(BaseModel):
    """单条消息响应。"""

    id: str
    session_id: str
    role: str
    content: str
    attachments: list[str] = []
    created_at: str
    # 工具调用过程记录（仅 assistant 消息；JSON 字符串，前端 JSON.parse 后使用）
    tool_calls: list[dict[str, Any]] = []
    # 思维链内容（仅 assistant 消息；空字符串表示无思维链）
    thinking: str = ""


class ListMessagesResponse(BaseModel):
    """消息历史响应。"""

    messages: list[MessageResponse]
    count: int


class ListSessionsResponse(BaseModel):
    """会话列表响应。"""

    sessions: list[SessionResponse]
    count: int


class UpdateSessionRequest(BaseModel):
    """更新会话请求（部分字段更新，目前仅支持 title）。

    字段全部可选，未传字段保持原值。为后续扩展其他可更新字段留口。
    """

    title: str | None = Field(
        None, min_length=1, max_length=255, description="新会话标题"
    )


class DeleteSessionResponse(BaseModel):
    """删除会话响应。"""

    ok: bool = Field(..., description="是否成功删除")
    session_id: str


class StreamRequest(BaseModel):
    """流式对话请求。"""

    content: str = Field(..., min_length=1, description="用户消息内容")
    session_id: str = Field(
        ...,
        description=(
            "前端 WebSocket 连接时使用的 session_id，"
            "后端按此推送流式 token 到对应前端连接。"
        ),
    )
    plan_mode: bool | None = Field(
        None, description="本次对话是否 Plan 模式（None 时用会话默认值）"
    )


class StreamStartedResponse(BaseModel):
    """流式任务已启动响应。"""

    started: bool = True
    request_id: str = Field(..., description="LLM 请求 id（可用于取消）")
    session_id: str = Field(..., description="关联会话 id")
    op: str = "chat"


class ConfirmRequest(BaseModel):
    """高风险工具确认请求。"""

    approved: bool = Field(..., description="是否同意执行")
    reason: str = Field("", description="拒绝原因（approved=false 时有意义）")
    modified_args: dict[str, Any] | None = Field(
        None,
        description="修改后的工具参数（approved=true 时有意义；逐条确认场景下"
        "仅保留用户勾选的 objects 子集）",
    )


class ConfirmResponse(BaseModel):
    """确认结果响应。"""

    ok: bool = Field(..., description="是否成功解析（request_id 存在且未完成）")
    request_id: str
    approved: bool


class CancelResponse(BaseModel):
    """取消结果响应。"""

    ok: bool = Field(..., description="是否成功标记取消")
    request_id: str


class CheckpointResponse(BaseModel):
    """Checkpoint 响应。"""

    session_id: str
    cycle_index: int = 0
    content: dict[str, Any] = {}
    created_at: str | None = None
    has_checkpoint: bool = False


class TriggerCheckpointResponse(BaseModel):
    """手动触发 checkpoint 响应。"""

    ok: bool
    session_id: str
    cycle_index: int | None = None
    reason: str | None = None


# ============================================================================
# 端点
# ============================================================================


@router.post("/sessions", response_model=SessionResponse)
async def create_session(body: CreateSessionRequest) -> SessionResponse:
    """创建新会话。

    Args:
        body: 会话参数（mode + 可选 graph_id + 可选 title）。

    Returns:
        新创建的会话记录。
    """
    session_id = uuid.uuid4().hex
    now = _now()
    title = body.title or f"{body.mode} 对话 {now.strftime('%Y-%m-%d %H:%M')}"

    async with AsyncSessionLocal() as db:
        row = SessionRow(
            id=session_id,
            title=title,
            mode=body.mode,
            graph_id=body.graph_id,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        await db.commit()

    logger.info(
        "创建 chat 会话 id=%s mode=%s graph_id=%s",
        session_id,
        body.mode,
        body.graph_id,
    )
    return SessionResponse(
        id=session_id,
        title=title,
        mode=body.mode,
        graph_id=body.graph_id,
        created_at=now.isoformat(),
        updated_at=now.isoformat(),
    )


@router.get("/sessions", response_model=ListSessionsResponse)
async def list_sessions(
    mode: str | None = None,
    graph_id: str | None = None,
    limit: int = 50,
) -> ListSessionsResponse:
    """列出会话（按 created_at 倒序，可按 mode / graph_id 过滤）。

    Args:
        mode: 可选，按场景模式过滤（study / work）。
        graph_id: 可选，按关联图谱过滤。
        limit: 截断条数，默认 50，最大 200。
    """
    if limit < 1:
        limit = 1
    if limit > 200:
        limit = 200

    async with AsyncSessionLocal() as db:
        stmt = select(SessionRow).order_by(
            SessionRow.created_at.desc(), SessionRow.id.desc()
        )
        if mode is not None:
            stmt = stmt.where(SessionRow.mode == mode)
        if graph_id is not None:
            stmt = stmt.where(SessionRow.graph_id == graph_id)
        stmt = stmt.limit(limit)
        result = await db.execute(stmt)
        rows = list(result.scalars().all())

    return ListSessionsResponse(
        sessions=[
            SessionResponse(
                id=r.id,
                title=r.title,
                mode=r.mode,
                graph_id=r.graph_id,
                created_at=r.created_at.isoformat() if r.created_at else "",
                updated_at=r.updated_at.isoformat() if r.updated_at else "",
            )
            for r in rows
        ],
        count=len(rows),
    )


@router.get("/sessions/{session_id}/messages", response_model=ListMessagesResponse)
async def list_messages(session_id: str) -> ListMessagesResponse:
    """获取会话消息历史（按 created_at 升序）。"""
    session = await _get_session_row(session_id)
    if session is None:
        raise _not_found(f"会话不存在: {session_id}")

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(MessageRow)
            .where(MessageRow.session_id == session_id)
            .order_by(MessageRow.created_at.asc(), MessageRow.id.asc())
        )
        rows = list(result.scalars().all())

    return ListMessagesResponse(
        messages=[
            MessageResponse(
                id=r.id,
                session_id=r.session_id,
                role=r.role,
                content=r.content,
                attachments=json.loads(r.attachments) if r.attachments else [],
                created_at=r.created_at.isoformat() if r.created_at else "",
                tool_calls=json.loads(r.tool_calls) if r.tool_calls else [],
                thinking=r.thinking or "",
            )
            for r in rows
        ],
        count=len(rows),
    )


@router.patch("/sessions/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: str,
    body: UpdateSessionRequest,
) -> SessionResponse:
    """更新会话字段（目前仅支持 title）。

    字段全部可选，未传字段保持原值。返回更新后的会话快照。
    """
    async with AsyncSessionLocal() as db:
        session = await db.get(SessionRow, session_id)
        if session is None:
            raise _not_found(f"会话不存在: {session_id}")
        if body.title is not None:
            title = body.title.strip()
            if not title:
                raise _bad_request("标题不能为空")
            session.title = title[:255]
        session.updated_at = _now()
        await db.commit()
        await db.refresh(session)
        return SessionResponse(
            id=session.id,
            title=session.title,
            mode=session.mode,
            graph_id=session.graph_id,
            created_at=session.created_at.isoformat() if session.created_at else "",
            updated_at=session.updated_at.isoformat() if session.updated_at else "",
        )


@router.delete("/sessions/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(session_id: str) -> DeleteSessionResponse:
    """删除会话。

    级联清理关联数据：
    - messages 表（外键 ondelete=CASCADE，DB 层自动清理）；
    - checkpoints 表（外键 ondelete=CASCADE，DB 层自动清理）；
    - 模块级 MainAgent 缓存（``_session_agents``）与活跃请求映射
      （避免删除后旧 agent 仍占用资源 / 残留映射）。

    若会话不存在，按幂等语义返回 ok=true（重复删除不报错）。
    """
    async with AsyncSessionLocal() as db:
        session = await db.get(SessionRow, session_id)
        if session is not None:
            await db.delete(session)
            await db.commit()

    # 清理模块级缓存与活跃请求映射
    _session_agents.pop(session_id, None)
    req_id = _session_active_requests.pop(session_id, None)
    if req_id is not None:
        _chat_tasks.pop(req_id, None)
        _request_sessions.pop(req_id, None)

    logger.info("删除 chat 会话 id=%s", session_id)
    return DeleteSessionResponse(ok=True, session_id=session_id)


@router.post("/sessions/{session_id}/stream", response_model=StreamStartedResponse)
async def stream_chat(
    session_id: str,
    body: StreamRequest,
) -> StreamStartedResponse:
    """触发流式对话。

    前端发起请求后立即返回 ``request_id``，后台异步调用
    :meth:`MainAgent.chat_stream`，逐 token 通过 WebSocket 推送至
    ``session_id`` 对应的前端连接。

    WS 事件类型（``op="chat"``）：
    - ``graph_agent_token``：每个 token（含 ``content``、``seq``）
    - ``chat_tool_call``：工具调用开始（含 ``tool``、``args``）
    - ``chat_tool_result``：工具执行结果（含 ``tool``、``result``）
    - ``chat_tool_call_confirmation``：高风险工具确认请求
      （含 ``tool``、``args``、``request_id``、``timeout``）
    - ``graph_agent_done``：流式完成（含 ``full_text``）
    - ``graph_agent_cancelled``：被外部取消
    - ``graph_agent_error``：失败（含 ``message``）
    """
    session = await _get_session_row(session_id)
    if session is None:
        raise _not_found(f"会话不存在: {session_id}")

    if not await is_session_online(body.session_id):
        raise HTTPException(status_code=409, detail="WebSocket 会话未连接，请先建立连接")

    async with _session_admission_lock:
        active_request_id = _session_active_requests.get(session_id)
        if active_request_id is not None:
            raise HTTPException(
                status_code=409,
                detail=f"该聊天会话已有流式请求运行中: {active_request_id}",
            )

    # 获取或创建会话级 MainAgent
    agent = await _get_or_create_session_agent(session)

    # 应用 per-call Plan/Build 模式覆盖；占用标记在创建任务前写入，避免两个
    # 并发请求都通过预检后同时修改同一个 MainAgent。
    effective_plan_mode = body.plan_mode if body.plan_mode is not None else agent.plan_mode

    # 注册 LLM 请求（便于前端管理面板展示与取消）
    request_id = await llm_request_registry.register(
        purpose="chat",
        graph_id=session.graph_id,
        meta={
            "session_id": session_id,
            "mode": session.mode,
            "plan_mode": effective_plan_mode,
        },
    )

    async with _session_admission_lock:
        if session_id in _session_active_requests:
            await llm_request_registry.cancel(request_id)
            raise HTTPException(status_code=409, detail="该聊天会话已有流式请求运行中")
        _session_active_requests[session_id] = request_id

    try:
        await agent.switch_plan_mode(effective_plan_mode)

        # 启动后台流式任务
        # body.session_id 是前端 WebSocket 连接的 session_id，WS 事件必须推送到此 ID
        task = background_tasks.create_task(
            _run_chat_stream(
                agent=agent,
                session_id=session_id,
                ws_session_id=body.session_id,
                request_id=request_id,
                user_message=body.content,
                plan_mode=effective_plan_mode,
                graph_id=session.graph_id,
                mode=session.mode if session.mode in ("study", "work") else "work",
            ),
            request_id=request_id,
            session_id=session_id,
            op="chat",
        )
    except Exception:
        await llm_request_registry.cancel(request_id)
        async with _session_admission_lock:
            if _session_active_requests.get(session_id) == request_id:
                _session_active_requests.pop(session_id, None)
        raise
    _chat_tasks[request_id] = task
    _request_sessions[request_id] = session_id

    logger.info(
        "启动 chat 流式任务 session=%s request_id=%s plan_mode=%s",
        session_id,
        request_id,
        effective_plan_mode,
    )
    return StreamStartedResponse(
        started=True,
        request_id=request_id,
        session_id=session_id,
        op="chat",
    )


@router.post("/sessions/{session_id}/checkpoint", response_model=TriggerCheckpointResponse)
async def trigger_checkpoint(session_id: str) -> TriggerCheckpointResponse:
    """手动触发 writer_agent 生成 checkpoint。

    通常由 context_manager 在阈值触发时自动派发；此端点供用户主动触发，
    便于在关键节点保存上下文快照。
    """
    session = await _get_session_row(session_id)
    if session is None:
        raise _not_found(f"会话不存在: {session_id}")

    # 延迟导入避免循环依赖
    from app.services.writer_agent import get_writer_agent

    try:
        writer = get_writer_agent()
    except RuntimeError as exc:
        return TriggerCheckpointResponse(
            ok=False,
            session_id=session_id,
            reason=f"writer_agent 未初始化: {exc}",
        )

    # 加载会话消息作为 delta
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(MessageRow)
            .where(MessageRow.session_id == session_id)
            .order_by(MessageRow.created_at.asc(), MessageRow.id.asc())
        )
        rows = list(result.scalars().all())

    if not rows:
        return TriggerCheckpointResponse(
            ok=False,
            session_id=session_id,
            reason="会话无消息，无需生成 checkpoint",
        )

    messages = [
        {
            "role": r.role,
            "content": r.content,
            "attachments": json.loads(r.attachments) if r.attachments else [],
        }
        for r in rows
    ]

    try:
        result_data = await writer.write_checkpoint(
            session_id=session_id,
            messages=messages,
            notes="",  # KWA 无 notes 模块
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("手动触发 checkpoint 失败 session=%s: %s", session_id, exc)
        return TriggerCheckpointResponse(
            ok=False,
            session_id=session_id,
            reason=f"writer 调用异常: {exc}",
        )

    if isinstance(result_data, dict) and result_data.get("status") == "skipped":
        return TriggerCheckpointResponse(
            ok=False,
            session_id=session_id,
            reason=result_data.get("reason", "writer 跳过生成"),
        )

    cycle_index = result_data.get("cycle_index") if isinstance(result_data, dict) else None
    return TriggerCheckpointResponse(
        ok=True,
        session_id=session_id,
        cycle_index=cycle_index,
    )


@router.get("/sessions/{session_id}/checkpoint", response_model=CheckpointResponse)
async def get_checkpoint(session_id: str) -> CheckpointResponse:
    """获取会话最新的 checkpoint 内容。"""
    session = await _get_session_row(session_id)
    if session is None:
        raise _not_found(f"会话不存在: {session_id}")

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(CheckpointRow)
            .where(CheckpointRow.session_id == session_id)
            .order_by(CheckpointRow.cycle_index.desc(), CheckpointRow.created_at.desc())
            .limit(1)
        )
        row = result.scalar_one_or_none()

    if row is None:
        return CheckpointResponse(
            session_id=session_id,
            has_checkpoint=False,
        )

    try:
        content = json.loads(row.content) if row.content else {}
    except (json.JSONDecodeError, TypeError):
        content = {}

    return CheckpointResponse(
        session_id=session_id,
        cycle_index=row.cycle_index,
        content=content,
        created_at=row.created_at.isoformat() if row.created_at else None,
        has_checkpoint=True,
    )


@router.post("/requests/{request_id}/cancel", response_model=CancelResponse)
async def cancel_chat(request_id: str) -> CancelResponse:
    """取消流式对话。

    - 标记 LLM 请求为 ``cancelled``（流式循环在下一个 chunk 边界检查后中断）；
    - 调用 :meth:`MainAgent.cancel()` 触发会话级取消事件；
    - 不等待后台任务完全退出（HTTP 即返回，前端通过 ``graph_agent_cancelled``
      事件感知取消完成）。
    """
    session_id = _request_sessions.get(request_id)
    if session_id is None:
        # 可能是已结束的请求或不存在
        ok = await llm_request_registry.cancel(request_id)
        return CancelResponse(ok=ok, request_id=request_id)

    # 标记 LLM 请求为 cancelled
    ok = await llm_request_registry.cancel(request_id)
    if not ok:
        return CancelResponse(ok=False, request_id=request_id)

    # 触发 MainAgent 取消事件
    agent = _session_agents.get(session_id)
    if agent is not None:
        agent.cancel()
        # 异步等待退出（不阻塞 HTTP 响应）
        background_tasks.create_task(
            agent.cancel_and_wait(timeout=5.0),
            request_id=request_id,
            session_id=session_id,
            op="chat-cancel-wait",
        )

    return CancelResponse(ok=True, request_id=request_id)


@router.post("/requests/{request_id}/confirm", response_model=ConfirmResponse)
async def confirm_tool_call(
    request_id: str,
    body: ConfirmRequest,
) -> ConfirmResponse:
    """确认高风险工具调用。

    唤醒 :func:`main_agent.request_tool_confirmation` 暂停的工具循环：

    - 用户同意（``approved=true``）：执行工具，结果回填给 agent 继续。
    - 用户拒绝（``approved=false``）：把拒绝原因作为工具结果回填，agent 据此
      调整后续对话（如改用查询工具或说明无法抽取）。

    Args:
        request_id: :func:`main_agent.request_tool_confirmation` 生成的 request_id。
        body: 确认请求体。
    """
    ok = resolve_tool_confirmation(
        request_id=request_id,
        approved=body.approved,
        reason=body.reason,
        modified_args=body.modified_args,
    )
    if not ok:
        raise _not_found(
            f"确认请求不存在或已完成: {request_id}"
        )
    return ConfirmResponse(ok=True, request_id=request_id, approved=body.approved)


__all__ = ["router"]

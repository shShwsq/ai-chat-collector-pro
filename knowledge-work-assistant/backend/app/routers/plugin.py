"""浏览器插件对接路由。

为浏览器扩展（如 web-ai-chat-collector）提供对话推送接口，挂载在
``/api/plugin`` 前缀下：

- ``POST /api/plugin/conversations``          接收插件推送的对话，持久化为 Observation
- ``GET  /api/plugin/contract``               返回接口契约说明（供插件方对接参考）
- ``GET  /api/plugin/conversations/recent``   返回最近 N 条 source='plugin' 的记录
- ``GET  /api/plugin/health``                 联调自检端点（版本 / 平台 / 队列规模）

设计要点：

1. **平台白名单**：``platform`` 必须命中 :data:`SUPPORTED_PLATFORMS`，否则 400。
2. **metadata 类型校验**：``metadata`` 中 ``title / url / model`` 若提供必须为
   string，否则 422（Pydantic 的 ``dict[str, Any]`` 不约束值类型，需在路由层
   手动校验）。
3. **幂等去重**：若 ``metadata.conversation_id`` 存在，组合
   ``{platform}:{conversation_id}`` 作为 ``dedup_key``，查最近 24h 是否已落库；
   命中则返回 ``deduplicated: true``，不写新记录、不广播。
4. **WebSocket 广播**：成功落库后通过 :func:`ws_notify.broadcast` 向所有前端
   连接推送 ``plugin.conversation_received`` 事件，供前端 Toast / 刷新列表。
5. **当前阶段不触发节点抽取**：抽取逻辑在后续迭代由 Agent 实现。
6. **依赖注入 graph_store**：与 graphs 路由保持一致风格。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.models.node_types import OBSERVATION_SOURCE_PLUGIN
from app.models.schemas import (
    PluginConversationRequest,
    PluginConversationResponse,
    PluginHealthResponse,
    PluginRecentConversationItem,
    PluginRecentConversationsResponse,
)
from app.services import ws_notify
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugin", tags=["plugin"])

#: 插件对接 API 版本。
PLUGIN_API_VERSION = "1.0"

#: 支持的来源平台白名单（``platform`` 字段必须命中其一，否则返回 400）。
#: ``custom`` 用于插件自定义 / 未列举的平台兜底。
SUPPORTED_PLATFORMS = frozenset(
    {
        "chatgpt",
        "claude",
        "gemini",
        "deepseek",
        "qwen",
        "doubao",
        "kimi",
        "fudan",
        "yuanbao",
        "custom",
    }
)

#: metadata 中需校验为 string 的字段集合（若提供则必须为 str）。
_METADATA_STRING_FIELDS = ("title", "url", "model")

#: 幂等去重时间窗口（小时）。
_DEDUP_WITHIN_HOURS = 24


def get_graph_store() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store


def _parse_timestamp(raw: str) -> datetime | None:
    """解析 ISO8601 时间戳，失败返回 None（不阻断接收）。

    支持带时区与不带时区两种写法，``datetime.fromisoformat`` 在 Python 3.11+
    已能处理大多数 ISO8601 变体。
    """
    try:
        return datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return None


def _validate_metadata(metadata: dict[str, Any] | None) -> None:
    """校验 metadata 中 ``title / url / model`` 字段类型必须为 string。

    Pydantic 的 ``dict[str, Any]`` 不约束值类型，故在路由层手动校验；
    不符合则抛 422。

    Args:
        metadata: 请求体中的 metadata 字段。

    Raises:
        HTTPException: 422 当存在非 string 的目标字段。
    """
    if not metadata:
        return
    for key in _METADATA_STRING_FIELDS:
        if key in metadata and not isinstance(metadata[key], str):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"metadata.{key} must be string, got "
                    f"{type(metadata[key]).__name__}"
                ),
            )


def _compute_dedup_key(platform: str, metadata: dict[str, Any] | None) -> str | None:
    """根据 ``metadata.conversation_id`` 计算幂等去重键。

    若 ``metadata`` 含 ``conversation_id`` 字段且为 string，则返回
    ``f"{platform}:{conversation_id}"``；否则返回 None（不去重）。

    Args:
        platform: 来源平台（已通过白名单校验）。
        metadata: 请求体中的 metadata 字段。

    Returns:
        dedup_key 字符串或 None。
    """
    if not metadata:
        return None
    conv_id = metadata.get("conversation_id")
    if isinstance(conv_id, str) and conv_id:
        return f"{platform}:{conv_id}"
    return None


@router.post(
    "/conversations", response_model=PluginConversationResponse
)
async def push_conversation(
    body: PluginConversationRequest,
    store: GraphStore = Depends(get_graph_store),
) -> PluginConversationResponse:
    """接收浏览器插件推送的对话。

    流程：
    1. 校验 ``platform`` 命中白名单（否则 400）。
    2. 校验 ``metadata`` 中 ``title / url / model`` 类型（否则 422）。
    3. 计算 ``dedup_key``（基于 ``metadata.conversation_id``）。
    4. 若 ``dedup_key`` 命中最近 24h 已有记录 → 返回
       ``{received: true, deduplicated: true, observation_id: <existing>}``，
       不写新记录、不广播。
    5. 否则合并 ``_dedup_key`` 到 metadata → ``create_observation`` 落库 →
       通过 :func:`ws_notify.broadcast` 广播 ``plugin.conversation_received``。
    6. 返回 ``{received: true, deduplicated: false, observation_id: <new>}``。

    当前阶段不触发节点抽取（抽取在后续迭代实现）。
    """
    # 1. 平台白名单校验
    if body.platform not in SUPPORTED_PLATFORMS:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported platform: {body.platform}",
        )

    # 2. metadata 类型校验
    _validate_metadata(body.metadata)

    # 3. 计算 dedup_key
    dedup_key = _compute_dedup_key(body.platform, body.metadata)

    # 4. 幂等去重
    if dedup_key is not None:
        existing = await store.find_observation_by_dedup_key(
            dedup_key, within_hours=_DEDUP_WITHIN_HOURS
        )
        if existing is not None:
            logger.info(
                "插件推送命中去重: platform=%s dedup_key=%s existing=%s",
                body.platform,
                dedup_key,
                existing["id"],
            )
            return PluginConversationResponse(
                received=True,
                deduplicated=True,
                observation_id=existing["id"],
            )

    # 5. 解析 timestamp + 合并 _dedup_key 到 metadata
    occurred_at = _parse_timestamp(body.timestamp)
    if occurred_at is None:
        logger.warning(
            "插件推送对话 timestamp 解析失败，落库 occurred_at=None: %s",
            body.timestamp,
        )

    merged_metadata: dict[str, Any] = dict(body.metadata) if body.metadata else {}
    if dedup_key is not None:
        merged_metadata["_dedup_key"] = dedup_key

    try:
        obs = await store.create_observation(
            conversation_markdown=body.conversation_markdown,
            platform=body.platform,
            source=OBSERVATION_SOURCE_PLUGIN,
            occurred_at=occurred_at,
            metadata=merged_metadata,
            graph_id=None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    logger.info(
        "插件推送对话已接收: platform=%s observation_id=%s bytes=%d",
        body.platform,
        obs["id"],
        len(body.conversation_markdown),
    )

    # 6. WebSocket 广播
    title = ""
    if body.metadata:
        title = body.metadata.get("title", "") or ""
    await ws_notify.broadcast(
        {
            "type": "plugin.conversation_received",
            "payload": {
                "observation_id": obs["id"],
                "platform": body.platform,
                "title": title,
                "timestamp": occurred_at.isoformat() if occurred_at else None,
            },
        }
    )

    return PluginConversationResponse(
        received=True,
        deduplicated=False,
        observation_id=obs["id"],
    )


@router.get("/contract")
async def get_contract() -> dict[str, Any]:
    """返回插件对接接口契约说明（供插件方对接参考）。

    以结构化 JSON 文档形式返回端点、请求 / 响应字段、错误码、注意事项、
    版本、支持平台与推送示例，插件方可据此生成请求代码或做联调自检。
    """
    return {
        "endpoint": "POST /api/plugin/conversations",
        "summary": (
            "浏览器插件推送采集到的 AI 对话，后端持久化为 Observation 原始记录，"
            "待 Agent 抽取知识点。"
        ),
        "stage": "接收 + 持久化 + 幂等去重 + WebSocket 广播；不触发节点抽取",
        "version": PLUGIN_API_VERSION,
        "supported_platforms": sorted(SUPPORTED_PLATFORMS),
        "request": {
            "platform": {
                "type": "string",
                "required": True,
                "description": (
                    "来源平台标识，必须在 supported_platforms 白名单内，"
                    "否则返回 400"
                ),
            },
            "timestamp": {
                "type": "string",
                "required": True,
                "description": (
                    "对话发生时间，ISO8601 格式，如 2025-01-01T12:00:00+08:00；"
                    "解析失败时落库 occurred_at 为空，不阻断接收"
                ),
            },
            "conversation_markdown": {
                "type": "string",
                "required": True,
                "description": "对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料",
            },
            "metadata": {
                "type": "object",
                "required": False,
                "description": (
                    "可选附加元数据。title / url / model 若提供必须为 string（否则 422）；"
                    "conversation_id（string）若提供将用于 24h 幂等去重，"
                    "去重键为 '{platform}:{conversation_id}'"
                ),
            },
        },
        "response": {
            "received": {
                "type": "boolean",
                "description": "是否已接收，固定为 true",
            },
            "observation_id": {
                "type": "string",
                "description": (
                    "持久化后的观察记录 ID（32 位十六进制）；"
                    "命中去重时为既有记录 ID"
                ),
            },
            "deduplicated": {
                "type": "boolean",
                "description": "是否命中幂等去重（最近 24h 内同 dedup_key 已存在）",
            },
        },
        "errors": {
            "400": "平台不在白名单内（unsupported platform: xxx）",
            "422": "请求体不符合契约（字段缺失 / 类型错误 / metadata 字段类型不符）",
        },
        "notes": [
            "成功落库后通过 WebSocket 广播 plugin.conversation_received 事件给所有前端连接",
            "同一 conversation_id 在 24h 内重复推送返回 deduplicated: true，不写新记录",
            "conversation_markdown 建议参考 web-ai-chat-collector 的导出格式",
            "CORS 已允许 http://localhost:5174 与 file:// 来源，插件直连后端时需自行处理跨域",
            "本轮暂不鉴权，仅本机环境使用；后续迭代可加 token",
        ],
        "push_examples": [
            {
                "platform": "chatgpt",
                "timestamp": "2025-01-01T12:00:00+08:00",
                "conversation_markdown": (
                    "## 用户\n什么是知识图谱？\n\n"
                    "## 助手\n知识图谱是一种用图结构组织知识的方式……"
                ),
                "metadata": {
                    "conversation_id": "chat-openai-abc123",
                    "title": "什么是知识图谱",
                    "url": "https://chat.openai.com/c/abc123",
                    "model": "gpt-4o-mini",
                },
            },
            {
                "platform": "deepseek",
                "timestamp": "2025-01-02T09:30:00+08:00",
                "conversation_markdown": (
                    "## 用户\n请解释一下 RAG 检索增强生成。\n\n"
                    "## 助手\nRAG 通过外部知识库检索再交由 LLM 生成……"
                ),
                "metadata": {
                    "conversation_id": "deepseek-chat-def456",
                    "title": "RAG 检索增强生成",
                    "url": "https://chat.deepseek.com/c/def456",
                    "model": "deepseek-chat",
                },
            },
        ],
    }


@router.get(
    "/conversations/recent",
    response_model=PluginRecentConversationsResponse,
)
async def list_recent_conversations(
    limit: int = Query(20, ge=1, le=100),
    store: GraphStore = Depends(get_graph_store),
) -> PluginRecentConversationsResponse:
    """返回最近 N 条 ``source='plugin'`` 的 Observation 元数据。

    用于前端「插件对接」分区展示最近推送历史，按 ``created_at`` 倒序。
    不返回对话原文，仅返回元数据（platform / title / timestamp / dedup_key 等）。
    """
    items_raw = await store.list_observations_by_source(
        OBSERVATION_SOURCE_PLUGIN, limit=limit
    )
    items: list[PluginRecentConversationItem] = []
    for raw in items_raw:
        meta = raw.get("metadata") or {}
        items.append(
            PluginRecentConversationItem(
                observation_id=raw["id"],
                platform=raw["platform"],
                title=meta.get("title", "") if isinstance(meta, dict) else "",
                timestamp=raw.get("occurred_at"),
                dedup_key=meta.get("_dedup_key") if isinstance(meta, dict) else None,
                created_at=raw["created_at"],
                processed=raw.get("processed", False),
            )
        )
    return PluginRecentConversationsResponse(items=items, total=len(items))


@router.get("/health", response_model=PluginHealthResponse)
async def plugin_health() -> PluginHealthResponse:
    """插件对接联调自检端点。

    供插件方在对接前快速验证后端可达、API 版本与支持的平台范围，并观察
    后端当前 LLM 请求队列规模（活跃 queued/running 数量，用于判断后端
    是否繁忙）。
    """
    # llm_request_registry 无 active_count 方法，使用 list_active 长度兜底。
    from app.services.llm_request_registry import llm_request_registry

    active_requests = await llm_request_registry.list_active()
    queue_size = len(active_requests)
    return PluginHealthResponse(
        ok=True,
        version=PLUGIN_API_VERSION,
        supported_platforms=sorted(SUPPORTED_PLATFORMS),
        queue_size=queue_size,
    )

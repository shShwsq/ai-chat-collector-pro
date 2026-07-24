"""浏览器插件对接路由（Task 10）。

为浏览器扩展（如 web-ai-chat-collector）提供对话推送接口，挂载在
``/api/plugin`` 前缀下：

- ``POST /api/plugin/conversations``  接收插件推送的对话，持久化为 Observation
- ``GET  /api/plugin/contract``       返回接口契约说明（供插件方对接参考）

设计要点：

1. **当前阶段为"空实现"**：仅做接收 + 持久化（``graph_store.create_observation``，
   ``source='plugin'``），**不触发节点抽取**。抽取逻辑在 Task 11 由 Agent 实现，
   届时在本路由或独立服务中调用 ``main_agent`` 抽取节点并 ``mark_observation_processed``。
2. **契约校验**：请求体由 :class:`PluginConversationRequest`（Pydantic）校验，
   字段缺失 / 类型错误 → 422；``timestamp`` 解析失败不阻断接收（落库
   ``occurred_at=None``）。
3. **幂等性**：当前不去重，同一对话重复推送会生成多条 Observation 记录。后续如需
   去重可在 metadata 中传 ``conversation_id``，由本层查重。
4. **依赖注入 graph_store**：与 graphs 路由保持一致风格。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.models.node_types import OBSERVATION_SOURCE_PLUGIN
from app.models.schemas import (
    PluginConversationRequest,
    PluginConversationResponse,
)
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugin", tags=["plugin"])


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


@router.post(
    "/conversations", response_model=PluginConversationResponse
)
async def push_conversation(
    body: PluginConversationRequest,
    store: GraphStore = Depends(get_graph_store),
) -> PluginConversationResponse:
    """接收浏览器插件推送的对话。

    流程：校验契约 → 解析 timestamp → ``create_observation(source='plugin')``
    持久化 → 返回 ``{received: true, observation_id}``。

    当前阶段不触发节点抽取（抽取在 Task 11 实现）。
    """
    occurred_at = _parse_timestamp(body.timestamp)
    if occurred_at is None:
        logger.warning(
            "插件推送对话 timestamp 解析失败，落库 occurred_at=None: %s",
            body.timestamp,
        )

    try:
        obs = await store.create_observation(
            conversation_markdown=body.conversation_markdown,
            platform=body.platform,
            source=OBSERVATION_SOURCE_PLUGIN,
            occurred_at=occurred_at,
            metadata=body.metadata,
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

    return PluginConversationResponse(
        received=True,
        observation_id=obs["id"],
    )


@router.get("/contract")
async def get_contract() -> dict[str, Any]:
    """返回插件对接接口契约说明（供插件方对接参考）。

    以结构化 JSON 文档形式返回端点、请求 / 响应字段、错误码与注意事项，
    插件方可据此生成请求代码或做联调自检。
    """
    return {
        "endpoint": "POST /api/plugin/conversations",
        "summary": "浏览器插件推送采集到的 AI 对话，后端持久化为 Observation 原始记录，待 Agent 抽取知识点。",
        "stage": "Task 10 预留：仅接收与持久化，不触发节点抽取（抽取在 Task 11 实现）",
        "request": {
            "platform": {
                "type": "string",
                "required": True,
                "description": "来源平台标识，如 chatgpt / claude / gemini / deepseek / qwen / doubao / kimi",
            },
            "timestamp": {
                "type": "string",
                "required": True,
                "description": "对话发生时间，ISO8601 格式，如 2025-01-01T12:00:00+08:00；解析失败时落库 occurred_at 为空，不阻断接收",
            },
            "conversation_markdown": {
                "type": "string",
                "required": True,
                "description": "对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料",
            },
            "metadata": {
                "type": "object",
                "required": False,
                "description": "可选附加元数据，如对话标题、URL、模型名、用户标签等，原样以 JSON 存入 observations.metadata_json",
            },
        },
        "response": {
            "received": {
                "type": "boolean",
                "description": "是否已接收，固定为 true",
            },
            "observation_id": {
                "type": "string",
                "description": "持久化后的观察记录 ID（32 位十六进制）",
            },
        },
        "errors": {
            "422": "请求体不符合契约（字段缺失 / 类型错误 / 空字符串）",
            "400": "业务校验失败（如非法来源标记）",
        },
        "notes": [
            "当前阶段仅持久化原始对话，不触发节点抽取（抽取在 Task 11 实现）",
            "同一对话可重复推送，每次生成新的 Observation 记录（当前不去重）",
            "conversation_markdown 建议参考 web-ai-chat-collector 的导出格式",
            "CORS 已允许 http://localhost:5174 与 file:// 来源，插件直连后端时需自行处理跨域",
        ],
        "example_request": {
            "platform": "chatgpt",
            "timestamp": "2025-01-01T12:00:00+08:00",
            "conversation_markdown": "## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是一种用图结构组织知识的方式……",
            "metadata": {
                "title": "什么是知识图谱",
                "url": "https://chat.openai.com/c/abc123",
                "model": "gpt-4o-mini",
            },
        },
    }

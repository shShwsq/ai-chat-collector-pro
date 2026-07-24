"""API 请求 / 响应 Pydantic schema 定义。

当前为联调骨架，仅定义健康检查等最小模型；后续业务路由（会话、知识库、
图谱等）上线时在此扩展，并与 frontend/src/lib/types.ts 一一对应。

Task 2 新增图谱相关 schema：Graph / Node / Edge / Observation / Quiz 的请求与
响应模型，供后续 Task 4（图谱管理路由）等使用。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """健康检查响应。"""

    status: str
    service: str
    version: str


class WsTestMessage(BaseModel):
    """WebSocket 测试消息体（前后端联调用）。"""

    type: str
    payload: dict | None = None


# ============================================================================
# 图谱相关 schema（Task 2 新增）
# ============================================================================


class GraphCreate(BaseModel):
    """创建图谱请求。"""

    name: str = Field(..., min_length=1, max_length=255, description="图谱名称")
    type: str = Field(..., description="图谱模式：study / work")


class GraphUpdate(BaseModel):
    """更新图谱请求（目前仅支持重命名）。"""

    name: str = Field(..., min_length=1, max_length=255, description="新图谱名称")


class GraphResponse(BaseModel):
    """图谱响应。"""

    id: str
    name: str
    type: str
    created_at: datetime
    updated_at: datetime


class NodeCreate(BaseModel):
    """创建节点请求。"""

    type: str = Field(..., description="节点子类型（Study 学科 / Work 工作对象）")
    title: str = Field(..., min_length=1, max_length=255, description="节点标题")
    summary: str = Field("", description="一句话概括")
    detail_payload: dict[str, Any] | None = Field(
        None, description="详情字段 dict，不传则按类型模板初始化"
    )
    is_gray: bool = Field(False, description="是否为延伸生成的灰色节点")
    user_fill: dict[str, Any] | None = Field(None, description="用户留白 dict")
    source: str = Field("user", description="来源标记")
    confidence: float = Field(1.0, ge=0.0, le=1.0, description="置信度")


class NodeUpdate(BaseModel):
    """更新节点请求（仅更新非 None 字段）。"""

    title: str | None = Field(None, min_length=1, max_length=255)
    summary: str | None = None
    detail_payload: dict[str, Any] | None = None
    is_gray: bool | None = None
    user_fill: dict[str, Any] | None = None
    type: str | None = Field(None, description="切换节点类型")
    confidence: float | None = Field(None, ge=0.0, le=1.0)


class NodeResponse(BaseModel):
    """节点响应。"""

    id: str
    graph_id: str
    type: str
    title: str
    summary: str
    detail_payload: dict[str, Any]
    is_gray: bool
    user_fill: dict[str, Any]
    source: str
    confidence: float
    # 智能推荐相关字段（旧数据兜底取默认值）
    last_reviewed_at: datetime | None = None
    review_count: int = 0
    mention_count: int = 0
    remind_at: datetime | None = None
    is_starred: bool = False
    created_at: datetime
    updated_at: datetime


class UserFillAppend(BaseModel):
    """向节点 user_fill 追加一条内容。"""

    fill_type: str = Field(..., description="留白类型：doubt/association/exam_point/error_point/note")
    content: str = Field(..., min_length=1, description="留白内容")


class EdgeCreate(BaseModel):
    """创建边请求。"""

    src_id: str = Field(..., description="源节点 ID")
    dst_id: str = Field(..., description="目标节点 ID")
    relation: str = Field("related", description="边关系语义")


class EdgeResponse(BaseModel):
    """边响应。"""

    id: str
    graph_id: str
    src_id: str
    dst_id: str
    relation: str
    created_at: datetime


class ObservationCreate(BaseModel):
    """创建观察记录请求（插件推送 / 手动导入）。"""

    conversation_markdown: str = Field(..., description="对话原文 Markdown")
    platform: str = Field("manual", description="来源平台")
    source: str = Field("manual", description="来源标记：plugin/import/manual")
    occurred_at: datetime | None = Field(None, description="对话发生时间")
    metadata: dict[str, Any] | None = Field(None, description="附加元数据")
    graph_id: str | None = Field(None, description="关联图谱（可选）")


class ObservationResponse(BaseModel):
    """观察记录响应。"""

    id: str
    platform: str
    occurred_at: datetime | None
    conversation_markdown: str
    metadata: dict[str, Any]
    source: str
    graph_id: str | None
    processed: bool
    created_at: datetime


class QuizCreate(BaseModel):
    """创建测验题目请求。"""

    node_id: str = Field(..., description="关联节点 ID")
    type: str = Field(..., description="题型：single_choice/multi_choice/feynman")
    payload: dict[str, Any] | None = Field(None, description="题目 JSON")
    answer: str = Field("", description="标准答案")


class QuizUpdateResult(BaseModel):
    """更新测验作答结果请求。"""

    result: dict[str, Any] = Field(..., description="作答结果 JSON")
    answer: str | None = Field(None, description="可选，更新标准答案")


class QuizResponse(BaseModel):
    """测验题目响应。"""

    id: str
    graph_id: str
    node_id: str
    type: str
    payload: dict[str, Any]
    answer: str
    result: dict[str, Any]
    answered: bool
    created_at: datetime
    answered_at: datetime | None


class GraphStatsResponse(BaseModel):
    """图谱统计响应。"""

    node_count: int
    edge_count: int
    quiz_count: int


class FullGraphResponse(BaseModel):
    """完整图谱响应（含节点与边），供前端可视化一次性加载。"""

    graph: GraphResponse
    nodes: list[NodeResponse]
    edges: list[EdgeResponse]
    stats: GraphStatsResponse


# ============================================================================
# 浏览器插件对接 schema（Task 10 新增）
# ============================================================================


class PluginConversationRequest(BaseModel):
    """浏览器插件推送对话请求。

    契约参考 web-AI-chat-collector 导出格式：插件采集到一段 AI 对话后，
    将平台、时间戳、对话原文 Markdown（与可选元数据）推送到后端，由后端
    持久化为 :class:`Observation` 原始记录，待 Agent 抽取知识点（Task 11）。

    字段说明：
    - ``platform``：来源平台标识，如 ``chatgpt`` / ``claude`` / ``gemini`` /
      ``deepseek`` / ``qwen`` / ``doubao`` / ``kimi`` 等。
    - ``timestamp``：对话发生时间，ISO8601 字符串（如
      ``2025-01-01T12:00:00+08:00``）；解析失败时落库 ``occurred_at=None``，
      不阻断接收。
    - ``conversation_markdown``：对话原文 Markdown（非空），作为 Agent 抽取
      知识点的源材料。
    - ``metadata``：可选附加元数据，如对话标题、URL、模型名、用户标签等，
      原样以 JSON 存入 ``observations.metadata_json``。
    """

    platform: str = Field(..., min_length=1, description="来源平台标识")
    timestamp: str = Field(
        ..., min_length=1, description="对话发生时间，ISO8601 字符串"
    )
    conversation_markdown: str = Field(
        ..., min_length=1, description="对话原文 Markdown（非空）"
    )
    metadata: dict[str, Any] | None = Field(
        None, description="可选附加元数据"
    )


class PluginConversationResponse(BaseModel):
    """浏览器插件推送对话响应。"""

    received: bool = Field(..., description="是否已接收，固定为 True")
    observation_id: str = Field(
        ..., description="持久化后的观察记录 ID（32 位十六进制）"
    )

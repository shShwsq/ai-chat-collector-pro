"""API 请求 / 响应 Pydantic schema 定义。

定义全部业务路由的请求与响应模型（健康检查、图谱、节点、延伸、测验、
Work、插件对接、LLM 配置、数据管理等），与 frontend/src/lib/types.ts 一一对应。
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

    fill_type: str = Field(
        ...,
        description="留白类型：doubt/association/exam_point/error_point/note",
    )
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
    - ``platform``：来源平台标识，必须命中白名单 ``deepseek`` / ``qwen`` /
      ``doubao`` / ``kimi`` / ``yuanbao`` / ``wenxin`` 之一。
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
        ..., description="持久化后的观察记录 ID（32 位十六进制）；命中去重时为既有记录 ID"
    )
    deduplicated: bool = Field(
        False,
        description="是否命中幂等去重（最近 24h 内同 dedup_key 已存在）",
    )


class PluginBatchConversationItem(BaseModel):
    """批量导入中的单条对话项（与 :class:`PluginConversationRequest` 字段一致，去掉 platform）。"""

    timestamp: str = Field(..., min_length=1, description="对话发生时间，ISO8601 字符串")
    conversation_markdown: str = Field(
        ..., min_length=1, description="对话原文 Markdown（非空）"
    )
    metadata: dict[str, Any] | None = Field(None, description="可选附加元数据")


class PluginBatchImportRequest(BaseModel):
    """批量导入对话请求（手动导入功能，一次提交多条以避免逐条 HTTP 开销）。"""

    platform: str = Field(..., min_length=1, description="来源平台标识")
    conversations: list[PluginBatchConversationItem] = Field(
        ..., description="待导入对话列表（单次上限见路由 MAX_BATCH_SIZE）"
    )


class PluginBatchImportResponse(BaseModel):
    """批量导入对话响应：汇总 imported / deduplicated / failed。"""

    received: bool = Field(..., description="是否已接收，固定为 True")
    total: int = Field(..., description="本次提交的对话总数")
    imported: int = Field(..., description="新增落库条数")
    deduplicated: int = Field(..., description="命中 24h 幂等去重跳过条数")
    failed: int = Field(..., description="失败条数")
    errors: list[str] = Field(
        default_factory=list, description="失败原因（最多 5 条）"
    )


class PluginHealthResponse(BaseModel):
    """插件对接联调自检端点响应（``GET /api/plugin/health``）。

    供插件方在对接前快速验证后端可达、版本与支持的平台范围，并观察后端
    当前 LLM 请求队列规模（用于判断后端是否繁忙）。
    """

    ok: bool = Field(..., description="后端是否就绪，固定为 True")
    version: str = Field(..., description="插件对接 API 版本，如 '1.0'")
    supported_platforms: list[str] = Field(
        ..., description="支持的平台标识列表（已排序）"
    )
    queue_size: int = Field(
        ..., description="当前 LLM 请求活跃数量（queued/running 计数）"
    )


class PluginRecentConversationItem(BaseModel):
    """单条最近插件推送记录的元数据（不含对话原文）。

    对应 ``observations`` 表中 ``source='plugin'`` 的一条记录，用于前端
    「插件对接」分区展示最近推送历史。
    """

    observation_id: str = Field(..., description="观察记录 ID")
    platform: str = Field(..., description="来源平台标识")
    title: str = Field("", description="对话标题（取自 metadata.title）")
    timestamp: datetime | None = Field(
        None, description="对话发生时间（occurred_at）"
    )
    dedup_key: str | None = Field(
        None, description="幂等去重键（metadata._dedup_key）"
    )
    created_at: datetime = Field(..., description="记录入库时间")
    processed: bool = Field(False, description="是否已被 Agent 抽取处理")


class PluginRecentConversationsResponse(BaseModel):
    """最近插件推送记录列表响应（``GET /api/plugin/conversations/recent``）。"""

    items: list[PluginRecentConversationItem] = Field(
        default_factory=list, description="最近推送记录列表（按 created_at 倒序）"
    )
    total: int = Field(..., description="返回条目数（等于 items 长度）")

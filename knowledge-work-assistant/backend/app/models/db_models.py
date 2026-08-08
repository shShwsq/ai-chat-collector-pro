"""SQLAlchemy 2.0 ORM 模型。

表清单（从步影 backend/app/models/db_models.py 适配，供 services 层使用）：
- ``sessions``       会话主表
- ``messages``       会话消息（user/assistant/system）
- ``checkpoints``    Agent 循环 checkpoint（结构化 JSON 内容）
- ``file_metadata``  已索引文件元数据
- ``tags``           标签库（全局唯一，去重）
- ``file_tags``      文件-标签多对多关联
- ``mcp_servers``    MCP Server 配置（保留表结构，本项目暂未接入 MCP 路由）
- ``settings``       通用设置（key/value，JSON 序列化）

本项目新增图谱相关表（Task 2）：
- ``graphs``         知识图谱主表（study / work 双模式）
- ``nodes``          图谱节点（小卡片，含标题/概括/详情/留白/置信度）
- ``edges``          图谱无向边（src/dst + relation）
- ``observations``   原始观察/对话记录（插件推送或手动导入）
- ``quizzes``        测验记录（单选/多选/费曼），关联节点用于复盘

FTS5 虚拟表（全文检索）在 ``app.db.init_db`` 中用 raw SQL 创建，并通过触发器与
基础表保持同步（不在此声明为 ORM 类，因其为 SQLite 虚拟表，无法用标准 Mapped 映射）：

- ``messages_fts``         关联 ``messages.content``
- ``checkpoints_fts``     关联 ``checkpoints.content``
- ``file_metadata_fts``    关联 ``file_metadata.original_name`` 与 ``file_metadata.summary``
- ``observations_fts``    关联 ``observations.conversation_markdown``
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

logger = logging.getLogger(__name__)


def _now() -> datetime:
    """UTC 当前时间，作为时间戳默认值。"""
    return datetime.now(UTC)


class Session(Base):
    """会话主表。"""

    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), default="新会话")
    # 会话场景模式（study/work，Task 8 chat 路由用，旧库通过 migrate_session_columns 补列）
    mode: Mapped[str] = mapped_column(String(16), default="work", nullable=False)
    # 关联图谱 ID（可空：纯闲聊会话无图谱上下文）
    graph_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    messages: Mapped[list[Message]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    checkpoints: Mapped[list[Checkpoint]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Message(Base):
    """单条会话消息。"""

    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, default="")
    # JSON 字符串：附件 file_id 列表，例如 ["<uuid>", "<uuid>"]
    attachments: Mapped[str] = mapped_column(Text, default="[]")
    # JSON 字符串：assistant 消息的工具调用过程记录（含 tool / args / result / status）
    # 空数组 "[]" 表示无工具调用；user 消息恒为 "[]"
    tool_calls: Mapped[str] = mapped_column(Text, default="[]")
    # 思维链内容（仅 assistant 消息；user 消息恒为空字符串）
    thinking: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)

    session: Mapped[Session] = relationship(back_populates="messages")


class Checkpoint(Base):
    """Agent 循环 checkpoint：保存某一轮的结构化上下文，便于回放与恢复。"""

    __tablename__ = "checkpoints"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 结构化字段 JSON 字符串（消息历史摘要、工具调用栈等）
    content: Mapped[str] = mapped_column(Text, default="{}")
    cycle_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    session: Mapped[Session] = relationship(back_populates="checkpoints")


class FileMetadata(Base):
    """已索引文件的元数据。"""

    __tablename__ = "file_metadata"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    saved_path: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(
        String(128), default="application/octet-stream"
    )
    size: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(Text, default="")
    indexed_at: Mapped[datetime] = mapped_column(default=_now, index=True)
    # 可空外键：文件可不绑定到某个会话
    session_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("sessions.id", ondelete="SET NULL"),
        nullable=True,
    )

    tags: Mapped[list[Tag]] = relationship(
        secondary="file_tags",
        back_populates="files",
        lazy="selectin",
        cascade="save-update, merge",
        passive_deletes=True,
    )


class Tag(Base):
    """标签库（全局唯一，去重）。

    用于 RAG 检索的标签机制：文件概括时生成 3-5 个标签，
    并参考本表去重（同义词归一），保证标签一致性。
    """

    __tablename__ = "tags"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)

    files: Mapped[list[FileMetadata]] = relationship(
        secondary="file_tags",
        back_populates="tags",
        lazy="selectin",
        passive_deletes=True,
    )


class FileTag(Base):
    """文件-标签多对多关联表。"""

    __tablename__ = "file_tags"

    file_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("file_metadata.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tag_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    )


class McpServer(Base):
    """MCP Server 配置（保留表结构，本项目暂未接入 MCP 路由）。"""

    __tablename__ = "mcp_servers"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    command: Mapped[str] = mapped_column(String(255), nullable=False)
    # JSON 字符串：启动参数列表
    args_json: Mapped[str] = mapped_column(Text, default="[]")
    # JSON 字符串：环境变量字典
    env_json: Mapped[str] = mapped_column(Text, default="{}")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


class Setting(Base):
    """通用设置项：key/value 形式，value 为 JSON 序列化字符串。

    约定的 key 命名空间：
    - ``llm.base_url`` / ``llm.api_key``（加密）/ ``llm.model``
    - ``theme`` / ``plan_mode`` 等
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)


# ============================================================================
# 图谱相关模型（Task 2 新增）
# ============================================================================


class Graph(Base):
    """知识图谱主表。

    一个图谱绑定一个 ``type``（``study`` 或 ``work``），不同类型的图谱互不互通，
    切换模式时仅展示对应类型的图谱列表。

    - ``study``：学科知识图谱，节点为学科知识点（语文/数学/...）
    - ``work``：工作对象图谱，节点为工作对象（线索/关键人/承诺/...）
    """

    __tablename__ = "graphs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="未命名图谱")
    # ``study`` 或 ``work``，对应右上角模式切换开关
    type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    nodes: Mapped[list[Node]] = relationship(
        back_populates="graph",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edges: Mapped[list[Edge]] = relationship(
        back_populates="graph",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    quizzes: Mapped[list[Quiz]] = relationship(
        back_populates="graph",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Node(Base):
    """图谱节点（小卡片）。

    节点渲染为无向图中的小卡片：常显标题（``title``）+ 一句话概括（``summary``）
    + 类型标签（``type``）。悬停时弹出详情卡，详情由 ``detail_payload``（JSON）按
    学科/工作模板渲染。

    字段说明：
    - ``type``：节点子类型，Study 模式为学科（如 ``math`` / ``physics``），
      Work 模式为工作对象（如 ``commitment`` / ``key_person``）。具体取值见
      :mod:`app.models.node_types`。
    - ``detail_payload``：详情字段 JSON 字符串，按节点类型对应的模板填充
      （如学科模板的"它是什么/为什么重要/关键内容/常见场景/延伸方向"）。
    - ``is_gray``：是否为延伸生成的灰色节点（双击全部延伸 / 单击单点延伸生成）。
    - ``user_fill``：用户留白区内容 JSON 字符串（doubt/association/exam_point/
      error_point/note，详见 :mod:`app.models.node_types`）。
    - ``source``：来源标记（``agent`` / ``user`` / ``plugin`` / ``extension``）。
    - ``confidence``：Agent 抽取的置信度（0.0-1.0），用于 Work 模式标注信息可信度。
    """

    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    graph_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("graphs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 节点子类型：Study 为学科 enum，Work 为工作对象 enum
    type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    # 详情字段 JSON 字符串（按类型对应模板填充）
    detail_payload: Mapped[str] = mapped_column(Text, default="{}")
    # 是否为延伸生成的灰色节点
    is_gray: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # 用户留白区 JSON（doubt/association/exam_point/error_point/note）
    user_fill: Mapped[str] = mapped_column(Text, default="{}")
    # 来源：agent / user / plugin / extension
    source: Mapped[str] = mapped_column(String(16), default="user")
    # 置信度 0.0-1.0，Agent 抽取时给出，Work 模式用于标注可信度
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    # 智能推荐相关字段（支撑后续推荐功能）
    # 最后复习时间（用户打开详情卡时更新）
    last_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    # 复习次数
    review_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    # 被提及次数（Agent 抽取/延伸/提问命中时 +1）
    mention_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    # 提醒时间（Work 模式节点用）
    remind_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    # 星标（用户手动标记）
    is_starred: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    graph: Mapped[Graph] = relationship(back_populates="nodes")
    quizzes: Mapped[list[Quiz]] = relationship(
        back_populates="node",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Edge(Base):
    """图谱无向边。

    表达节点间的关联关系，``src_id`` 与 ``dst_id`` 顺序不区分（无向图）。
    ``relation`` 描述边的语义类型，Work 模式取值参考设计方案.md：
    属于 / 涉及 / 承诺给 / 依赖 / 等待 / 影响 / 来源 / 替代 等；
    Study 模式通常为 ``related`` / ``prerequisite`` / ``extends`` 等。
    """

    __tablename__ = "edges"
    __table_args__ = (
        Index(
            "uq_edges_graph_endpoints_relation",
            "graph_id",
            "src_id",
            "dst_id",
            "relation",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    graph_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("graphs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    src_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    dst_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 边的语义类型，如 related / prerequisite / extends / belongs_to / involves 等
    relation: Mapped[str] = mapped_column(String(64), default="related")
    created_at: Mapped[datetime] = mapped_column(default=_now)

    graph: Mapped[Graph] = relationship(back_populates="edges")


class Observation(Base):
    """原始观察 / 对话记录。

    来源：
    - 浏览器插件推送（``POST /api/plugin/conversations``，``source='plugin'``）
    - 手动导入（``source='import'``）
    - 用户在应用内输入（``source='manual'``）

    Agent 会从 ``conversation_markdown`` 中抽取候选知识点作为图谱节点（Study 模式）
    或工作对象（Work 模式）。``processed`` 标记是否已被 Agent 处理过，避免重复抽取。
    """

    __tablename__ = "observations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    # 来源平台：chatgpt / claude / gemini / manual / import 等
    platform: Mapped[str] = mapped_column(String(32), default="manual", index=True)
    # 对话发生时间（来自插件推送，可空）
    occurred_at: Mapped[datetime | None] = mapped_column(nullable=True, index=True)
    # 对话原文（Markdown），Agent 抽取知识点的源材料
    conversation_markdown: Mapped[str] = mapped_column(Text, default="")
    # 附加元数据 JSON 字符串（如对话标题、URL、模型名、用户标签等）
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    # 原子幂等键：没有 conversation_id 的历史数据保持 NULL
    dedup_key: Mapped[str | None] = mapped_column(
        String(512), nullable=True, unique=True, index=True
    )
    # 来源标记：plugin / import / manual
    source: Mapped[str] = mapped_column(String(16), default="manual", index=True)
    # 关联图谱（可选，抽取后绑定的目标图谱）
    graph_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("graphs.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 是否已被 Agent 处理（抽取节点）
    processed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


class Quiz(Base):
    """测验记录。

    类型：
    - ``single_choice``：单选题
    - ``multi_choice``：多选题
    - ``feynman``：费曼解释题（用户用自己的话解释知识点，Agent 语义判分）

    ``payload``：题目 JSON（题干 + 选项 / 提示），由 Agent 生成。
    ``answer``：标准答案（选择题为选项 ID 列表，费曼题为参考解释）。
    ``result``：用户作答结果 JSON（用户答案 + 得分 + 解析 + Agent 反馈）。
    """

    __tablename__ = "quizzes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    graph_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("graphs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 题型：single_choice / multi_choice / feynman
    type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    # 题目 JSON（题干 + 选项 / 提示）
    payload: Mapped[str] = mapped_column(Text, default="{}")
    # 标准答案（选择题为选项 ID 列表，费曼题为参考解释）
    answer: Mapped[str] = mapped_column(Text, default="")
    # 用户作答结果 JSON（用户答案 + 得分 + 解析 + Agent 反馈）
    result: Mapped[str] = mapped_column(Text, default="{}")
    # 是否已被用户作答
    answered: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)
    answered_at: Mapped[datetime | None] = mapped_column(nullable=True)

    graph: Mapped[Graph] = relationship(back_populates="quizzes")
    node: Mapped[Node] = relationship(back_populates="quizzes")


# ============================================================================
# 表结构迁移（智能推荐字段）
# ============================================================================


# nodes 表需补充的列：(列名, SQLite DDL 类型定义)
# SQLite ALTER TABLE 仅支持 ADD COLUMN，无法修改/删除已有列，故只做加列
_NODE_MIGRATION_COLUMNS: list[tuple[str, str]] = [
    ("last_reviewed_at", "DATETIME"),
    ("review_count", "INTEGER NOT NULL DEFAULT 0"),
    ("mention_count", "INTEGER NOT NULL DEFAULT 0"),
    ("remind_at", "DATETIME"),
    ("is_starred", "BOOLEAN NOT NULL DEFAULT 0"),
]


async def migrate_node_columns(engine: AsyncEngine) -> None:
    """检查 nodes 表并补充智能推荐所需的 5 个列（幂等）。

    ``Base.metadata.create_all`` 不会为已存在的表补列，旧库需通过本函数显式迁移。
    检查方式：``PRAGMA table_info(nodes)`` 比对已有列名，缺失的列用
    ``ALTER TABLE nodes ADD COLUMN ...`` 添加。多次执行不会报错。

    Args:
        engine: 异步引擎（通常为 ``app.db.engine``）。
    """
    async with engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info(nodes)"))
        existing = {row[1] for row in result.all()}
        for col_name, col_type in _NODE_MIGRATION_COLUMNS:
            if col_name in existing:
                continue
            await conn.execute(
                text(f"ALTER TABLE nodes ADD COLUMN {col_name} {col_type}")
            )
            logger.info("nodes 表迁移：新增列 %s", col_name)


# sessions 表需补充的列（Task 8 chat 路由用）：(列名, SQLite DDL 类型定义)
# SQLite ALTER TABLE 仅支持 ADD COLUMN，无法修改/删除已有列，故只做加列
_SESSION_MIGRATION_COLUMNS: list[tuple[str, str]] = [
    ("mode", "TEXT NOT NULL DEFAULT 'work'"),
    ("graph_id", "TEXT"),
]


async def migrate_session_columns(engine: AsyncEngine) -> None:
    """检查 sessions 表并补充 chat 路由所需的 mode / graph_id 列（幂等）。

    与 :func:`migrate_node_columns` 同模式：``PRAGMA table_info(sessions)``
    比对已有列名，缺失的列用 ``ALTER TABLE sessions ADD COLUMN ...`` 添加。
    多次执行不会报错。

    Args:
        engine: 异步引擎（通常为 ``app.db.engine``）。
    """
    async with engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info(sessions)"))
        existing = {row[1] for row in result.all()}
        for col_name, col_type in _SESSION_MIGRATION_COLUMNS:
            if col_name in existing:
                continue
            await conn.execute(
                text(f"ALTER TABLE sessions ADD COLUMN {col_name} {col_type}")
            )
            logger.info("sessions 表迁移：新增列 %s", col_name)

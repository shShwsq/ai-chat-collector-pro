# models/ 数据模型开发指南

> 一句话定位：本目录是 KWA 后端的数据模型层，包含三个文件：`db_models.py`（SQLAlchemy 2.0 ORM，12 张基础表 + 5 张图谱表）、`schemas.py`（Pydantic 请求 / 响应模型，与前端 `types.ts` 一一对应）、`node_types.py`（节点类型枚举 + 详情卡模板 + 边关系语义 + 留白 / 测验 / 观察来源枚举）。本目录的文件**只描述数据结构与约束**，不写业务逻辑（CRUD 放 `services/graph_store.py`，校验放 `routers/`）。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是后端数据模型层，与插件侧 [web-ai-chat-collector](../../../web-ai-chat-collector/DEVELOPMENT.md) 的对接关系如下：

- **`observations` 表存储推送数据**：collector 推送的对话持久化到 `observations` 表，关键字段：
  - `platform`：与 collector 的 `platformName` 对齐（`deepseek/qwen/doubao/kimi/fudan` 等）
  - `conversation_markdown`：collector 推送的 `## 用户` / `## 助手` 分段 Markdown 原文
  - `source`：固定为 `'plugin'`（区别于 `'import'` / `'manual'`）
  - `metadata_json`：JSON 字段，存 collector 传来的 `conversation_id` / `title` / `url` / `model` 等
- **`OBSERVATION_SOURCES` 枚举**：`node_types.py` 定义 `('plugin', 'import', 'manual')`，`'plugin'` 专用于 collector 推送的数据。
- **`NODE_SOURCES` 枚举**：`('agent', 'user', 'plugin', 'extension')`，`'plugin'` 标记节点来源是 collector 推送的对话经 `graph_agent` 抽取后入图的。
- **`PluginConversationRequest` schema**：`schemas.py` 中定义的 Pydantic 请求模型，字段与 collector 的 [kwa-push.js](../../../knowledge-work-assistant/plugin-sdk/kwa-push.js) 推送 payload 一一对应（`platform` / `timestamp` / `conversation_markdown` / `metadata`）。
- **FTS5 全文检索**：`observations_fts` 虚拟表索引 `observations.conversation_markdown`，供用户在 KWA 中全文搜索 collector 推送的对话内容。
- **幂等去重字段**：`observations` 表的 `dedup_key`（由 `routers/plugin.py` 组合 `{platform}:{conversation_id}` 生成）保证 24h 内不重复落库。

跨子工程任务（调整对话格式、新增平台、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
models/
├── __init__.py        # 仅一行 docstring，不聚合导出（避免循环导入）
├── db_models.py       # SQLAlchemy ORM：12 张基础表 + 5 张图谱表 + migrate_node_columns
├── node_types.py      # 节点类型 / 边关系 / 留白 / 测验 / 观察来源的枚举与模板
└── schemas.py         # Pydantic schema：API 请求 / 响应模型
```

三个文件互不依赖（`db_models` 与 `schemas` 不互相 import；`node_types` 只被 `db_models` / `schemas` / `services` / `routers` 引用），可在任意顺序下加载。

## 关键文件

### `db_models.py`：SQLAlchemy ORM

12 张基础表（由前期项目骨架适配而来）+ 5 张图谱表（本项目新增）：

**基础表**（与图谱业务无直接关联，但保留以兼容 services 层依赖）：

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `sessions` | 会话主表 | `id` / `title` / `mode: String(16), default="work", nullable=False`（会话场景模式 study / work，Task 8 chat 路由用）/ `graph_id: String(32) \| None, index=True`（关联图谱 ID，可空：纯闲聊会话无图谱上下文）/ `created_at` / `updated_at`；`messages` / `checkpoints` 反向关系 |
| `messages` | 会话消息 | `id` / `session_id`（CASCADE）/ `role`（user/assistant/system）/ `content` / `attachments`（JSON 数组）/ `created_at` |
| `checkpoints` | Agent 循环 checkpoint | `id` / `session_id`（CASCADE）/ `content`（JSON）/ `cycle_index` / `created_at` |
| `file_metadata` | 已索引文件元数据 | `id` / `original_name` / `saved_path` / `mime_type` / `size` / `summary` / `indexed_at` / `session_id`（SET NULL）/ `tags`（多对多） |
| `tags` | 标签库（全局唯一） | `id` / `name`（unique）/ `created_at`；`files` 多对多反向 |
| `file_tags` | 文件-标签多对多关联 | `file_id`（CASCADE）/ `tag_id`（CASCADE）联合主键 |
| `mcp_servers` | MCP Server 配置（保留表，暂未接入路由） | `name` / `command` / `args_json` / `env_json` / `enabled` / `created_at` |
| `settings` | 通用设置 key/value | `key`（主键）/ `value`（JSON 序列化）/ `updated_at`；约定命名空间 `llm.*` / `theme` / `plan_mode` 等 |

**图谱表**（本项目 Task 2 新增）：

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `graphs` | 知识图谱主表 | `id` / `name` / `type`（`study` / `work`）/ `created_at` / `updated_at`；`nodes` / `edges` / `quizzes` 反向关系（CASCADE） |
| `nodes` | 图谱节点 | `id` / `graph_id`（CASCADE）/ `type`（学科或工作对象枚举）/ `title` / `summary` / `detail_payload`（JSON）/ `is_gray` / `user_fill`（JSON）/ `source` / `confidence` / 智能推荐 5 列（`last_reviewed_at` / `review_count` / `mention_count` / `remind_at` / `is_starred`）/ `created_at` / `updated_at` |
| `edges` | 图谱无向边 | `id` / `graph_id`（CASCADE）/ `src_id`（CASCADE）/ `dst_id`（CASCADE）/ `relation` / `created_at` |
| `observations` | 原始观察 / 对话记录 | `id` / `platform` / `occurred_at` / `conversation_markdown` / `metadata_json` / `source`（`plugin` / `import` / `manual`）/ `graph_id`（SET NULL）/ `processed` / `created_at` |
| `quizzes` | 测验记录 | `id` / `graph_id`（CASCADE）/ `node_id`（CASCADE）/ `type`（`single_choice` / `multi_choice` / `feynman`）/ `payload`（JSON）/ `answer` / `result`（JSON）/ `answered` / `created_at` / `answered_at` |

**FTS5 虚拟表**（在 `app/db.init_db` 中用 raw SQL 创建，不在 ORM 中声明）：
- `messages_fts`（关联 `messages.content`）
- `checkpoints_fts`（关联 `checkpoints.content`）
- `file_metadata_fts`（关联 `file_metadata.original_name` 与 `file_metadata.summary`）
- `observations_fts`（关联 `observations.conversation_markdown`）

**迁移函数**：
- `migrate_node_columns(engine)`：幂等检查 `nodes` 表的 5 个智能推荐列，缺失则 `ALTER TABLE nodes ADD COLUMN ...`；多次执行不报错。`_NODE_MIGRATION_COLUMNS` 列表登记需迁移的列名与 SQLite DDL 类型。
- `migrate_session_columns(engine)`：与 `migrate_node_columns` 同模式，幂等检查 `sessions` 表的 `mode` / `graph_id` 两列（Task 8 chat 路由用），缺失则 `ALTER TABLE sessions ADD COLUMN ...`；多次执行不报错。`_SESSION_MIGRATION_COLUMNS = [("mode", "TEXT NOT NULL DEFAULT 'work'"), ("graph_id", "TEXT")]` 列表登记需迁移的列名与 SQLite DDL 类型。

### `node_types.py`：节点类型与模板

集中管理图谱节点的子类型枚举与详情模板：

- **图谱模式**：`GRAPH_TYPES = ('study', 'work')`。
- **Study 学科枚举**：`STUDY_SUBJECTS`（11 个学科 + 1 个 `general` 兜底）+ `STUDY_SUBJECT_LABELS`（中文名映射）+ `STUDY_TEMPLATES`（学科 → 详情卡字段模板）+ `STUDY_TEMPLATE_DEFAULT`（通用兜底模板）。
- **Work 工作对象枚举**：`WORK_OBJECTS`（10 个工作对象）+ `WORK_OBJECT_LABELS` + `WORK_TEMPLATES` + `WORK_TEMPLATE_DEFAULT`。
- **用户留白类型**：`USER_FILL_TYPES = ('doubt', 'association', 'exam_point', 'error_point', 'note')` + `USER_FILL_LABELS`。
- **节点来源标记**：`NODE_SOURCES = ('agent', 'user', 'plugin', 'extension')`。
- **边关系语义**：`EDGE_RELATIONS`（11 个枚举：`related` / `prerequisite` / `extends` / `belongs_to` / `involves` / `committed_to` / `depends_on` / `waiting_for` / `influences` / `source_of` / `alternative_to`）+ `EDGE_RELATION_LABELS`。
- **测验题型**：`QUIZ_TYPES = ('single_choice', 'multi_choice', 'feynman')` + `QUIZ_TYPE_LABELS`。
- **观察来源**：`OBSERVATION_SOURCES = ('plugin', 'import', 'manual')`。
- **工具函数**：`get_study_template` / `get_work_template` / `get_template` / `get_node_label` / `is_valid_node_type` / `default_detail_payload` / `default_user_fill`。

**设计要点**：
1. 图谱类型与节点类型解耦：`Graph.type` 仅区分 `study` / `work`，节点的具体子类型由 `Node.type` 表达。
2. 未命中走通用兜底：所有模板查询都应通过 `get_template` 等函数获取，未命中时返回默认模板，确保详情卡不空白、不报错。
3. `Node.type` 字段在 DB 中是 `String(32)`，不强制约束枚举（SQLite 不强制 CHECK），但 services / 路由层应使用本模块常量，避免拼写分歧。

### `schemas.py`：Pydantic schema

API 请求 / 响应模型，与 [../../../frontend/src/lib/types.ts](../../../frontend/src/lib/types.ts) 一一对应：

- **健康检查 / WebSocket**：`HealthResponse` / `WsTestMessage`。
- **图谱**：`GraphCreate` / `GraphUpdate` / `GraphResponse` / `GraphStatsResponse` / `FullGraphResponse`。
- **节点**：`NodeCreate` / `NodeUpdate` / `NodeResponse` / `UserFillAppend` / `NodeDetailResponse`。
- **边**：`EdgeCreate` / `EdgeResponse`。
- **观察**：`ObservationResponse` / `ObservationListResponse` / `PluginConversationRequest` / `PluginConversationResponse` / `PluginHealthResponse` / `PluginRecentConversationItem` / `PluginRecentConversationsResponse`。
- **测验**：`QuizGenerateRequest` / `QuizAnswerRequest` / `QuizResponse` / `QuizGradeResult`。
- **延伸**：`ExtendRequest` / `ExtendResponse` / `ExtendRevokeResponse`。
- **抽取**：`ExtractRequest` / `ExtractResponse` / `BatchCreateNodesRequest` / `BatchCreateNodesResponse`。
- **Work 模式**：`WorkExtractRequest` / `WorkExtractResponse` / `WorkConfirmRequest` / `WorkConfirmResponse` / `TrendsResponse` / `TrendAddResponse` / `ReportRequest` / `ReportResponse` / `WorkAskRequest` / `WorkAskResponse`。
- **流式**：`StreamStartedResponse`。
- **推荐**：`RecommendationsResponse` / `RecommendationItem`。
- **LLM 配置**：`LlmConfig` / `LlmConfigUpdate` / `LlmConfigUpdateResponse` / `LlmRequestInfo` / `LlmCancelResponse`。
- **通用**：`DeleteResult`。

## 开发工作流

### 修改 ORM 模型

- 改 `db_models.py` 的表结构后（加字段 / 改类型 / 删字段），需要 `rm backend/data/app.db` 重启（开发期用 `create_all`，不会改已存在的表）。
- 若只是给 `nodes` 表加列：登记到 `db_models._NODE_MIGRATION_COLUMNS` 列表（`(col_name, col_type)` 元组），`migrate_node_columns(engine)` 会幂等迁移；新列必须有 `NOT NULL DEFAULT ...` 或允许 NULL，否则旧数据迁移失败。
- 其他表的 schema 变更：开发期 `rm data/app.db` 重启（会丢数据）；生产环境需接入 Alembic 迁移（当前未配置）。

### 修改节点类型枚举

1. 在 [node_types.py](./node_types.py) 的 `STUDY_SUBJECTS`（或 `WORK_OBJECTS`）元组加新枚举值，同步更新 `STUDY_SUBJECT_LABELS`（或 `WORK_OBJECT_LABELS`）加中文名映射。
2. 在 `STUDY_TEMPLATES`（或 `WORK_TEMPLATES`）加新模板：`detail_payload` 字段结构（list of `{key, label, placeholder}`）。
3. 在 [../../../frontend/src/lib/nodeTemplates.ts](../../../frontend/src/lib/nodeTemplates.ts) 同步加前端模板（用于 NodeEditor 渲染表单字段）。
4. 在 [../../../frontend/src/components/graph/NodeEditor.tsx](../../../frontend/src/components/graph/NodeEditor.tsx) 检查表单渲染逻辑，必要时为新模板字段加特殊 UI（如 select / multiline）。
5. 跑种子脚本 `cd backend && powershell -File seed-graph.ps1` 注入含新类型节点的图谱，前端切换到图谱视图确认渲染正常。

### 修改 Pydantic schema

1. 在 [schemas.py](./schemas.py) 加新类（继承 `BaseModel`），用 `Field(...)` 标注约束与文档。
2. 同步改 [../../../frontend/src/lib/types.ts](../../../frontend/src/lib/types.ts)（命名用 PascalCase，字段用 camelCase 以匹配 TS 习惯）。
3. 如需在 API 中使用，在 [routers/](../routers/) 加对应端点，service 层加对应方法。
4. 访问 `/docs` 确认 Swagger UI 自动反映了新 schema。

## 代码约定

### 命名

- **模块文件**：全小写下划线（`db_models.py` / `node_types.py` / `schemas.py`）。
- **ORM 类**：PascalCase 单数（`Graph` / `Node` / `Edge` / `Observation` / `Quiz`）；表名用复数（`graphs` / `nodes` / `edges` / `observations` / `quizzes`）。
- **Pydantic schema**：动作 + 时间（`GraphCreate` / `GraphUpdate` / `GraphResponse` / `NodeCreate` / `NodeUpdate` / `NodeResponse`）；请求后缀 `Create` / `Update` / `Request`，响应用 `Response` 或不带后缀。
- **常量**：全大写下划线（`GRAPH_TYPES` / `STUDY_SUBJECTS` / `WORK_OBJECTS` / `EDGE_RELATIONS` / `NODE_SOURCES` / `OBSERVATION_SOURCES` / `QUIZ_TYPES` / `USER_FILL_TYPES`）；私有常量加下划线前缀（`_NODE_MIGRATION_COLUMNS`）。
- **字段**：snake_case（`graph_id` / `node_id` / `detail_payload` / `created_at`），与 DB 列名一致；Pydantic schema 字段也用 snake_case，由 FastAPI 自动序列化（前端 `types.ts` 用 camelCase，由前端做转换或后端配置 alias）。

### 类型注解

- `from __future__ import annotations` 在文件首行（在 docstring 之后）。
- ORM 用 `Mapped[T]` / `mapped_column(...)`（SQLAlchemy 2.0 风格）。
- Pydantic schema 用 `Field(...)` 标注约束（`min_length` / `max_length` / `ge` / `le` / `description`）。
- 可空字段用 `T | None`（Python 3.10+ 语法），不写 `Optional[T]`。

### ID 风格

- 所有主键 ID 用 `String(32)` + `uuid.uuid4().hex`（32 位十六进制无连字符）。
- 不要混用 `str(uuid.uuid4())`（带连字符的 36 位格式），会导致前端 `Node.id` 字段类型校验失败。
- 外键用 `ForeignKey("xxx.id", ondelete="CASCADE")`（强关联）或 `ondelete="SET NULL"`（弱关联，如 `observations.graph_id`）。

### JSON 字段透明序列化

`detail_payload` / `user_fill` / `metadata_json` / `payload` / `result` / `attachments` / `args_json` / `env_json` / `content`（checkpoint）在 DB 中以 TEXT 存 JSON 字符串，service 层在读取时反序列化为 dict，写入时序列化为 JSON 字符串。调用方无需关心序列化细节。

## 常见任务

### 任务 1：新增一张图谱相关表

**场景**：要存"节点学习计划"（NodeStudyPlan），关联到节点。

**步骤**：
1. 在 [db_models.py](./db_models.py) 加新类，继承 `Base`：
   ```python
   class NodeStudyPlan(Base):
       """节点学习计划。"""
       __tablename__ = "node_study_plans"
       id: Mapped[str] = mapped_column(String(32), primary_key=True)
       node_id: Mapped[str] = mapped_column(
           String(32), ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True
       )
       planned_at: Mapped[datetime] = mapped_column(default=_now, index=True)
       notes: Mapped[str] = mapped_column(Text, default="")
   ```
2. 在 `Node` 类加反向关系：`study_plans: Mapped[list[NodeStudyPlan]] = relationship(back_populates="node", cascade="all, delete-orphan")`，新类加 `node: Mapped[Node] = relationship(back_populates="study_plans")`。
3. **删除 `data/app.db` 重启**（开发期 `create_all` 不会改已存在的表），表会自动创建。
4. 在 [schemas.py](./schemas.py) 加 `NodeStudyPlanCreate` / `NodeStudyPlanResponse`。
5. 在 [../services/graph_store.py](../services/graph_store.py) 加 CRUD 方法（`create_study_plan` / `list_study_plans` / `delete_study_plan`）。
6. 在 [../routers/](../routers/) 加对应路由（或在 `nodes.py` 加嵌套路由 `POST /api/graphs/{id}/nodes/{nid}/study-plans`）。
7. 前端同步加类型、api 方法、UI 组件。

**验证**：`data/app.db` 中能看到新表；Swagger UI 能调新接口；前端能创建/查看学习计划。

### 任务 2：新增一个 Study 学科

**场景**：Study 模式新增"哲学"学科。

**步骤**：
1. 在 [node_types.py](./node_types.py) 加 `STUDY_SUBJECT_PHILOSOPHY = "philosophy"` 常量。
2. 把它加入 `STUDY_SUBJECTS` 元组与 `STUDY_SUBJECT_LABELS` 字典（`"philosophy": "哲学"`）。
3. 在 `STUDY_TEMPLATES` 加 `STUDY_SUBJECT_PHILOSOPHY` 的模板（如哲学关注"哲学家 / 流派 / 核心命题 / 经典著作 / 延伸方向"）。
4. 在 [../../../frontend/src/lib/nodeTemplates.ts](../../../frontend/src/lib/nodeTemplates.ts) 同步加前端模板。
5. 跑种子脚本注入含新学科的图谱，前端切换到 study 模式确认 NodeEditor 下拉选项与详情卡渲染正常。

**验证**：NodeEditor 中选择"哲学" → 详情字段按模板渲染 → 保存后 `nodes.detail_payload` 落库正确 → 重新打开详情卡显示一致。

### 任务 3：新增一个边关系语义

**场景**：Work 模式新增"竞争"关系（A 与 B 竞争）。

**步骤**：
1. 在 [node_types.py](./node_types.py) 加 `EDGE_COMPETES_WITH = "competes_with"` 常量。
2. 把它加入 `EDGE_RELATIONS` 元组与 `EDGE_RELATION_LABELS` 字典（`"competes_with": "竞争"`）。
3. 在前端 [../../../frontend/src/components/graph/graphUtils.ts](../../../frontend/src/components/graph/graphUtils.ts) 检查边渲染逻辑是否需要为新关系加特殊样式（如不同颜色 / 虚线）。
4. 在 NodeEditor / EdgeEditor 的关系下拉选项中加新枚举（如已动态读取 `EDGE_RELATIONS` 则无需改）。

**验证**：创建一条 `competes_with` 关系的边 → 图谱视图正确渲染 → 详情卡显示"竞争"中文名。

### 任务 4：扩展 Observation 的 metadata 字段

**场景**：希望插件推送时携带"用户标签"字段，存入 `observations.metadata_json`。

**步骤**：
1. `observations.metadata_json` 是 JSON 字符串，不强约束结构，无需改 ORM。
2. 在 [schemas.py](./schemas.py) 的 `PluginConversationRequest.metadata` 字段说明中加 `user_tags` 子字段（仍是 `dict` 不强约束，但文档化）。
3. 在 [../routers/plugin.py](../routers/plugin.py) 的 `POST /api/plugin/conversations` 实现中，把 `metadata.user_tags` 原样存入 `observations.metadata_json`（无需特殊处理，已透明序列化）。
4. 在 [../services/graph_agent.py](../services/graph_agent.py) 的 `extract_candidates_from_observation` 中，把 `user_tags` 加入 prompt 上下文（如"用户已标注此对话为：xxx"）。
5. 在 [../../../frontend/src/components/graph/PendingNodes.tsx](../../../frontend/src/components/graph/PendingNodes.tsx) 的待抽取列表项中显示 `metadata.user_tags`（如有）。
6. 同步更新 [../../../plugin-sdk/kwa-push.d.ts](../../../plugin-sdk/kwa-push.d.ts) 的 `metadata` 类型注释与 [../../../plugin-sdk/README.md](../../../plugin-sdk/README.md) 的"请求字段说明"表。

**验证**：用 `kwa-push.js` 推送一条带 `user_tags` 的对话 → 后端落库 → 前端待抽取列表显示标签 → 抽取候选节点时 prompt 含标签。

## 扩展点

### 新增 ORM 模型

参考"任务 1"。要点：
- 继承 `Base`，用 `Mapped[T]` / `mapped_column(...)` 声明字段。
- 表名用复数。
- 主键统一 `String(32)` + `uuid.uuid4().hex`。
- 外键用 `ForeignKey("xxx.id", ondelete="CASCADE")`，确保级联删除。
- 关系用 `relationship(back_populates="xxx", cascade="all, delete-orphan", passive_deletes=True)`。

### 新增 Pydantic schema

- 请求后缀 `Create` / `Update` / `Request`，响应用 `Response` 或不带后缀。
- 字段用 `Field(..., min_length=1, max_length=255, description="...")` 标注约束与文档。
- 与 [../../../frontend/src/lib/types.ts](../../../frontend/src/lib/types.ts) 一一对应。

### 新增节点类型 / 边关系 / 留白类型 / 测验类型

参考"任务 2" / "任务 3"。要点：
- 在 `node_types.py` 加常量 + 加入对应枚举元组 + 加入中文标签映射 + 加入模板（如适用）。
- 同步更新前端 `nodeTemplates.ts` / `types.ts`。

## 注意事项（坑）

### `Node.type` 不强制约束枚举

`Node.type` 字段在 DB 中是 `String(32)`，SQLite 不强制 CHECK 约束，理论上可存任意字符串。但 `services/graph_store.create_node` / `update_node` 会调 `is_valid_node_type(graph_type, node_type)` 校验，非法类型抛 `ValueError`。前端 `NodeEditor` 的下拉选项应从 `STUDY_SUBJECTS` / `WORK_OBJECTS` 读取，避免提交非法值。

### `detail_payload` 中的特殊键

`routers/nodes.py` 在生成节点详情时，会把 LLM 生成结果以加下划线前缀的特殊键写入 `detail_payload`：
- `_important_points`：重要点列表
- `_extension_directions`：延伸方向列表
- `_generated_summary`：AI 生成的概括
- `_degraded`：是否降级（LLM 不可用）
- `_degrade_reason`：降级原因
- `_template_used`：使用的模板名

这些键与模板字段名（`what_is` / `key_points` 等）不冲突。**新增 detail_payload 字段时不要用下划线前缀**，避免与缓存键冲突。

### `migrate_node_columns` 只能加列

SQLite 的 `ALTER TABLE` 仅支持 `ADD COLUMN`，无法修改 / 删除已有列。`migrate_node_columns` 是幂等的 ADD COLUMN 迁移，**只能加列，不能改 / 删列**。其他变更需 `rm data/app.db` 重启（开发期）或接入 Alembic（生产环境，当前未配置）。

### 时间戳用 UTC

`_now()` 返回 `datetime.now(timezone.utc)`，所有时间戳字段默认值用此函数。前端展示时需转本地时间（`new Date(isoString).toLocaleString()`）；查询比较时注意时区（`occurred_at` / `remind_at` 等可空字段为 `DateTime`，存 UTC）。

### 加密字段不在 ORM 中声明

`settings` 表的 `value` 字段是 TEXT，存 JSON 序列化字符串；敏感字段（如 `llm.api_key`）在 `services/settings_store.py` 中先加密为 Fernet token，再 JSON 序列化存入。**ORM 层不感知加密**，`Setting.value` 仍是普通 TEXT，加密 / 解密在 service 层完成。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改路由 / 新增 API 端点 | [../routers/DEVELOPMENT.md](../routers/DEVELOPMENT.md) |
| 要改服务层 / graph_agent / LLM 调用 / 图谱存储 | [../services/DEVELOPMENT.md](../services/DEVELOPMENT.md) |
| 要看应用入口 / 配置 / DB 初始化 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要改前端 React 组件 / 图谱可视化 | [../../../frontend/DEVELOPMENT.md](../../../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../../../plugin-sdk/DEVELOPMENT.md](../../../plugin-sdk/DEVELOPMENT.md) |
| 要看后端整体架构 | [../../DEVELOPMENT.md](../../DEVELOPMENT.md) |

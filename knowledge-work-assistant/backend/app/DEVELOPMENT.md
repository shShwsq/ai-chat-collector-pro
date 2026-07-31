# app/ 应用主包开发指南

> 一句话定位：本目录是 KWA 后端的 FastAPI 应用主包，承担"装配与声明"职责——`main.py` 装配生命周期与路由、`config.py` 声明配置、`db.py` 初始化异步 DB 与 FTS5；业务逻辑下沉到三个子包 `models/` / `routers/` / `services/`，分别有独立的 DEVELOPMENT.md。本文件只描述应用顶层骨架，子包细节请见各自 DEVELOPMENT.md。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是后端应用主包，与插件侧 [web-ai-chat-collector](../../../web-ai-chat-collector/DEVELOPMENT.md) 的对接关系如下：

- **路由装配**：`main.py` 挂载的 14 个 router 中，[routers/plugin.py](./routers/plugin.py) 是专门接收 collector 推送的入口（`POST /api/plugin/conversations`）；`ws.py` 的 WebSocket 端点在 collector 推送成功后向前端广播 `plugin.conversation_received` 事件；`chat.py` 是新增的多轮对话入口（`POST /api/chat/sessions/{id}/stream` 等），token 通过 `op="chat"` 事件推送。
- **生命周期**：`lifespan` 启动时不主动连接 collector（collector 是被动推送方，KWA 后端是接收方）；`_REGISTRY.load()` 加载的 `model_config.json` 与 collector 的 `models.json` 独立维护。
- **CORS 配置**：`config.py` 的 `cors_origins = ["http://localhost:5174","file://"]` 仅允许前端来源；collector 推送走 `POST /api/plugin/conversations`，由 `plugin.py` 路由处理，**不受 CORS 限制**（collector 用 `kwa-push.js` 在 Service Worker 中发起 fetch，CORS 不适用）。
- **数据库初始化**：`db.py` 的 `init_db()` 创建的 `observations_fts` FTS5 虚拟表索引 `observations.conversation_markdown`，供用户在 KWA 中全文搜索 collector 推送的对话。

跨子工程任务（启用推送、同步 LLM Provider、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
app/
├── __init__.py          # 仅声明 __version__ = "0.0.0"
├── main.py              # FastAPI 入口：lifespan + CORS + 14 个 router 挂载 + /ws
├── config.py            # pydantic-settings Settings 类 + ensure_dirs()
├── db.py                # 异步引擎 + AsyncSessionLocal + FTS5 虚拟表 + 触发器
├── models/              # ORM + Pydantic schema + 节点类型枚举（详见 models/DEVELOPMENT.md）
├── routers/             # 14 个 FastAPI 路由模块（详见 routers/DEVELOPMENT.md）
└── services/            # 21+ 个业务 service 模块（详见 services/DEVELOPMENT.md）
    ├── tools/           #   LLM 工具调用子包（chat 路由工具实现）
    ├── multimodal/      #   多模态能力子包（图片 / 文件处理等）
    └── prompts/         #   Prompt 模板子包（按场景复用）
```

顶层三个文件（`main.py` / `config.py` / `db.py`）只负责"装配与声明"，不写业务逻辑；任何具体的 CRUD / LLM 调用 / 业务规则都应放 `services/` 或 `routers/`，避免顶层文件膨胀。

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| `__init__.py` | 包标识 | 仅 `__version__ = "0.0.0"`，由 `main.py` 与 `/api/health` 引用；勿在此聚合导出，避免循环导入 |
| `main.py` | FastAPI 入口 | `lifespan`（加载 `_REGISTRY.load()` → `await init_db()` → `await migrate_node_columns(engine)` → `await migrate_session_columns(engine)` → `try: init_main_agent(); init_writer_agent(...) except: logging.warning` → `init_graph_agent()`）；CORS 允许 `["http://localhost:5174","file://"]`；按 `/api` 前缀挂载 14 个 router + `/ws`；`if __name__ == "__main__"` 提供 `uv run python -m app.main` 便捷入口（生产推荐用 `uvicorn` 命令） |
| `config.py` | 配置 | `Settings(BaseSettings)`：`app_env` / `cors_origins` / `llm_base_url` / `llm_api_key` / `llm_model` / `llm_context_window` / `data_dir` / `database_url` / `backend_port=8788` / `encryption_key`；`ensure_dirs()` 创建 `data/`、`data/files/`、`data/sessions/`；`model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")` |
| `db.py` | 异步 DB | `Base(DeclarativeBase)` 所有 ORM 模型的基类；`engine = create_async_engine(settings.database_url, future=True)`；`AsyncSessionLocal = async_sessionmaker(...)`；`configure_sqlite_engine(async_engine)` 为 engine 安装 `_set_sqlite_pragma` 连接级监听器（**当前启用 4 项 PRAGMA**：`foreign_keys=ON` 确保 ON DELETE CASCADE 生效 / `busy_timeout=5000ms` 忙等待避免 database is locked / `journal_mode=WAL` 允许读写并发 / `synchronous=NORMAL` 平衡性能与原子性）；**并发安全**：`with_sqlite_lock_retry[T]()` 泛型包装器对 `database is locked` 做指数退避重试（`SQLITE_LOCK_RETRIES=4`，初始 delay 50ms），供易争用的写入路径使用；`init_db()` 调 `Base.metadata.create_all` + 增强列迁移 `_migrate_add_columns`（observations 表回填 `dedup_key` 列并建部分唯一索引 `uq_observations_dedup_key`、edges 表规范化端点方向 + 去重 + 建 `uq_edges_graph_endpoints_relation` 唯一索引、messages 表添加 `tool_calls` / `thinking` 列）+ 创建 4 张 FTS5 虚拟表（`messages_fts` / `checkpoints_fts` / `file_metadata_fts` / `observations_fts`）+ INSERT/UPDATE/DELETE 触发器；`get_session()` FastAPI 依赖 |

## 应用生命周期（lifespan）

`main.py` 的 `lifespan` 严格按顺序执行，**顺序不能乱**：

1. `_REGISTRY.load()`：加载 `backend/data/model_config.json`，文件缺失或损坏时回退到 `_FALLBACK_DEFAULT` 硬编码兜底，不阻断启动。
2. `await init_db()`：调用 `Base.metadata.create_all` 创建所有表（已存在的表不修改），随后创建 4 张 FTS5 虚拟表与同步触发器，并调 `settings.ensure_dirs()` 确保 `data/` / `data/files/` / `data/sessions/` 目录存在。
3. `await migrate_node_columns(engine)`：幂等迁移 `nodes` 表 5 个智能推荐列（`last_reviewed_at` / `review_count` / `mention_count` / `remind_at` / `is_starred`），旧库启动不报错，只能加列不能改/删列。
4. `await migrate_session_columns(engine)`：幂等迁移 `sessions` 表 `mode` / `graph_id` 两列（Task 8 chat 路由用），与 `migrate_node_columns` 同模式，缺失则 `ALTER TABLE sessions ADD COLUMN ...`。
5. `try: init_main_agent(); init_writer_agent(...) except Exception: logging.warning(...)`：初始化 MainAgent / WriterAgent 单例；LLM 未配置或调不通时**降级跳过**（仅记 warning，不阻断启动）。
6. `init_graph_agent()`：初始化全局 `GraphAgent` 单例（无状态，仅确保模块加载与启动日志）。

shutdown 当前无额外资源需释放；后续接入 MCP / 后台任务时在此清理。

## 路由装配

`main.py` 用 `app.include_router(..., prefix="/api", tags=[...])` 挂载所有业务路由，前缀统一 `/api`；`ws.py` 挂载在根路径 `/ws`。14 个 router 按业务域拆分（详见 [routers/DEVELOPMENT.md](./routers/DEVELOPMENT.md)）：

| router 文件 | 前缀 | 主要端点 |
|------------|------|---------|
| `health.py` | `/api` | `GET /api/health` |
| `graphs.py` | `/api` | `/api/graphs`、`/api/graphs/{id}/nodes|edges|full|stats` |
| `nodes.py` | `/api` | `/api/graphs/{id}/nodes/{nid}/detail|user-fill`、`/api/nodes/{nid}/touch|remind|star` |
| `extensions.py` | `/api` | `/api/graphs/{id}/nodes/{nid}/extend|extend-revoke` |
| `extraction.py` | `/api` | `/api/observations`、`/api/graphs/{id}/nodes/batch` |
| `quiz.py` | `/api` | `/api/graphs/{id}/quiz/generate|answer`、`/api/graphs/{id}/quiz[/{qid}]` |
| `work.py` | `/api` | `/api/graphs/{id}/work/extract|confirm|trends|report|ask` |
| `recommendations.py` | `/api` | `/api/graphs/{id}/recommendations?mode=study|work` |
| `plugin.py` | `/api/plugin`（router 自带 `/plugin` 前缀，叠加 `/api` 后为 `/api/plugin/*`） | `POST /api/plugin/conversations`、`GET /api/plugin/contract|health|conversations/recent` |
| `llm_admin.py` | `/api` | `/api/llm/requests`、`/api/llm/requests/{id}/cancel`、`/api/llm/config`、`/api/llm/test-connection`（保存前验证 LLM 连通性，返回 ok/latency/message/reply，不抛 HTTP 异常） |
| `stream.py` | `/api` | `/api/graphs/{id}/nodes/{nid}/detail-stream`、`/api/graphs/{id}/work/ask-stream|report-stream` |
| `chat.py` | `/api` | `/api/chat/sessions`、`/api/chat/sessions/{id}/messages\|stream\|checkpoint`、`/api/chat/requests/{id}/cancel\|confirm` |
| `ws.py` | （无前缀） | `WS /ws?session_id=<uuid32>` |

## 开发工作流

### 修改顶层文件

- 改 `main.py` 的路由装配：加新 router 后访问 `/docs` 确认契约同步。
- 改 `config.py`：新增字段后需同步更新 [../.env.example](../.env.example) 的注释与默认值；前端若需读取，加对应 API 端点暴露（不要直接暴露 `.env` 内容）。
- 改 `db.py` 的 FTS5 DDL：仅在 `init_db` 失败时观察 `uvicorn` 控制台的 `WARNING app.db:_create_fts5` 日志；用 `SELECT sqlite_compileoption_used('ENABLE_FTS5')` 检查 SQLite 是否启用 FTS5。

### 修改 ORM 模型

- 改 `models/db_models.py` 的表结构后（加字段 / 改类型 / 删字段），需要 `rm backend/data/app.db` 重启（开发期用 `create_all`，不会改已存在的表）。
- 若只是给 `nodes` 表加列，登记到 `db_models._NODE_MIGRATION_COLUMNS` 列表，`migrate_node_columns(engine)` 会幂等迁移；其他表 schema 变更需 `rm data/app.db` 重启（开发期可接受）或后续接入 Alembic（当前未配置）。

### 修改 Pydantic schema

- 改 `models/schemas.py` 后，需同步改 [../../frontend/src/lib/types.ts](../../frontend/src/lib/types.ts)（两者一一对应，命名用 PascalCase，字段用 camelCase 以匹配 TS 习惯）。
- Swagger UI（`/docs`）会自动反映 schema 变更，无需手动维护接口文档。

## 代码约定

### 顶层文件不写业务逻辑

- `main.py` 仅做装配（lifespan + CORS + 路由挂载），不写 CRUD / LLM 调用。
- `config.py` 仅声明字段与默认值，不做复杂初始化（`ensure_dirs` 是简单 mkdir，可接受）。
- `db.py` 仅做引擎 / session 工厂 / 表结构初始化，不写业务查询；业务查询放 `services/`。

### 异步栈

- 所有 DB 操作走 `AsyncSessionLocal`；顶层不直接 `import openai` 或调外部 API，相关逻辑放 `services/`。
- `get_session()` 作为 FastAPI 依赖提供请求级 `AsyncSession`，service 层方法可接收 `session` 参数或自管理 session（`graph_store` 自管理，便于跨请求复用单例）。

### ID 风格

- 所有主键 ID 用 `uuid.uuid4().hex`（32 位十六进制无连字符），与 sessions / messages 风格一致。
- WebSocket 的 `session_id` 也用 32 位十六进制（前端 `generateSessionId()` 生成）；`TestSocket.connect(sessionId)` 通过查询参数传给后端。

## 常见任务

### 任务 1：新增一个环境变量

1. 在 [config.py](./config.py) 的 `Settings` 类加新字段（含默认值与注释），如 `feature_x_enabled: bool = False`。
2. 在 [../.env.example](../.env.example) 加对应条目与说明。
3. 重启后端生效；前端若需读取，加对应 API 端点暴露（如 `GET /api/config/feature-x` 返回 `{"enabled": settings.feature_x_enabled}`）。
4. 若该字段涉及敏感信息（如 API Key），改用 `services/crypto.py` 加密存到 `settings` 表，而非放 `.env`。

**验证**：重启后端，`/api/health` 仍 200；新字段在 `Settings()` 实例中可读。

### 任务 2：新增一个 FastAPI 路由模块

1. 在 [routers/](./routers/) 加新文件，如 `feature_x.py`，导出 `router = APIRouter()`。
2. 在 [main.py](./main.py) 加 `from app.routers import feature_x as feature_x_router` + `app.include_router(feature_x_router.router, prefix="/api", tags=["feature-x"])`。
3. 路由通过 `Depends(get_xxx_store)` 拿全局单例，便于测试时用 `app.dependency_overrides` 替换。
4. 统一用 `_handle_value_error` 把 service 抛的 `ValueError` 映射为 HTTP 异常（404/422/400）。
5. 访问 `/docs` 确认契约同步；前端 [../../frontend/src/lib/api.ts](../../frontend/src/lib/api.ts) 加对应方法。

**验证**：Swagger UI 看到新端点；前端调用返回预期结果。

### 任务 3：调整 lifespan 初始化顺序

仅在新增 service 需要在启动期初始化时改 `lifespan`：

1. 在 `lifespan` 内按依赖顺序加 `await xxx_init()`。
2. **顺序约束**：`init_db` 必须在 `migrate_node_columns` 之前（否则 `nodes` 表不存在）；`_REGISTRY.load()` 必须在 `init_graph_agent()` 之前（否则 `graph_agent` 用空注册表）。
3. 新增的初始化函数应幂等（多次执行不报错），且失败时降级而非崩溃（参考 `_REGISTRY.load` 的兜底逻辑）。

**验证**：`uv run uvicorn app.main:app --reload` 启动后日志按预期顺序输出，`/api/health` 返回 200。

### 任务 4：调整 CORS 允许来源

1. 在 [config.py](./config.py) 的 `Settings.cors_origins` 加新来源（如 `"http://192.168.1.100:5174"`）。
2. 或在 [../.env](../.env) 设置 `CORS_ORIGINS=["http://192.168.1.100:5174"]`（JSON 数组格式）。
3. 重启后端生效；浏览器插件（Chrome extension）通过 `chrome-extension://<id>` 访问后端时，**扩展的 host_permissions 可豁免 CORS**，无需把扩展 ID 加入 `cors_origins`。

**验证**：从新来源发请求，浏览器 Console 无 CORS 错误。

## 扩展点

### 新增数据库表

参考 [models/DEVELOPMENT.md](./models/DEVELOPMENT.md) 的"新增 ORM 模型"章节。

### 新增 service 模块

参考 [services/DEVELOPMENT.md](./services/DEVELOPMENT.md) 的"新增 service 模块"章节。

### 新增 WebSocket 事件类型

1. 在 `services/ws_notify.py` 的 `notify_session` 调用处加新事件类型（如 `{"type": "feature_x.done", ...}`）。
2. 在 [routers/ws.py](./routers/ws.py) 的 welcome 消息中加文档说明（可选）。
3. 在前端 [../../frontend/src/lib/ws.ts](../../frontend/src/lib/ws.ts) 的 `WsEvent` 类型加新事件分支；在 [../../frontend/src/App.tsx](../../frontend/src/App.tsx) 的 `onEvent` 回调中分发到 store action。
4. 在 [../../frontend/src/store/useAppStore.ts](../../frontend/src/store/useAppStore.ts) 加对应 action 处理事件。

## 注意事项（坑）

### lifespan 顺序不能乱

`init_db` → `migrate_node_columns` → `migrate_session_columns` → `init_main_agent` / `init_writer_agent` → `init_graph_agent` 的顺序基于依赖关系：
- `migrate_node_columns` 用 `PRAGMA table_info(nodes)` 检查列，必须在 `init_db` 创建 `nodes` 表之后。
- `migrate_session_columns` 同模式检查 `sessions` 表，必须在 `init_db` 创建 `sessions` 表之后。
- `init_main_agent` / `init_writer_agent` / `init_graph_agent` 内部可能调 `llm_factory.get_llm_client`，依赖 `model_config._REGISTRY` 已加载；前两者用 `try / except` 降级，后者不降级。
顺序乱会导致启动期异常或运行时 `graph_agent` / `MainAgent` 用空注册表。

### `create_all` 不会改已存在的表

开发期改 ORM 模型后，`Base.metadata.create_all` 不会修改已存在的表结构：
- 简单加列：登记到 `db_models._NODE_MIGRATION_COLUMNS`，`migrate_node_columns` 会幂等 ADD COLUMN。
- 其他变更：`rm data/app.db` 重启（开发期可接受，会丢数据）；生产环境需接入 Alembic 迁移（当前未配置）。

### FTS5 不可用时静默降级

部分 SQLite 编译版本不含 FTS5（罕见），`init_db._create_fts5` 会捕获异常并跳过，仅记录 `WARNING` 日志，不阻断启动。此时 `messages_fts` / `observations_fts` 等表不存在，`knowledge_store` / `tag_store` 的全文检索会失效，但图谱 CRUD 等核心功能仍可用。用 `SELECT sqlite_compileoption_used('ENABLE_FTS5')` 检查是否启用。

### SQLite 外键级联与并发配置

SQLAlchemy 默认不开启 SQLite 的 `PRAGMA foreign_keys`，本项目在 [db.py](./db.py) 通过 `configure_sqlite_engine(async_engine)` 为 engine 安装连接级监听器 `_set_sqlite_pragma`，**每次连接同时设置 4 项 PRAGMA**：

1. `PRAGMA foreign_keys=ON`：确保 `ON DELETE CASCADE` 生效；
2. `PRAGMA busy_timeout=5000`：忙等待 5 秒，避免多连接下出现 `database is locked`；
3. `PRAGMA journal_mode=WAL`：写前日志模式，允许读写并发，显著降低阻塞；
4. `PRAGMA synchronous=NORMAL`：平衡性能与原子性（WAL 下安全）。

> **注意**：`busy_timeout` 仅在** SQLite 3.37+**（`PRAGMA` 支持变量）下生效；旧版本会解析失败。若手动用 DB Browser for SQLite 操作数据库，默认上述 PRAGMA 均未开启，删除图谱不会级联清理 nodes / edges，且并发写入容易锁库；需要在 DB Browser 的"Execute SQL"中先跑：
> ```sql
> PRAGMA foreign_keys=ON;
> PRAGMA journal_mode=WAL;
> ```

### 端口隔离约定

后端固定 **8788**、前端固定 **5174**，与本地其他项目相互隔离。**改端口需同步改 4 处**：[config.py](./config.py)（`backend_port` + `cors_origins`）+ [../.env.example](../.env.example) + [../../frontend/vite.config.ts](../../frontend/vite.config.ts)（`server.port` + `proxy.target`）+ [../../frontend/electron/launcher.ts](../../frontend/electron/launcher.ts)（`DEFAULT_BACKEND_PORT`），否则 dev / 生产 / 代理 / IPC 任一环失配都会让前端连不上后端。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 ORM 模型 / Pydantic schema / 节点类型枚举 | [models/DEVELOPMENT.md](./models/DEVELOPMENT.md) |
| 要改路由 / 新增 API 端点 | [routers/DEVELOPMENT.md](./routers/DEVELOPMENT.md) |
| 要改服务层 / graph_agent / LLM 调用 / 图谱存储 | [services/DEVELOPMENT.md](./services/DEVELOPMENT.md) |
| 要看后端整体架构 / 启动流程 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要改前端 / 联调 | [../../frontend/DEVELOPMENT.md](../../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../../web-ai-chat-collector/bg/DEVELOPMENT.md](../../web-ai-chat-collector/bg/DEVELOPMENT.md)（`bg/local-app.js` 段落） |

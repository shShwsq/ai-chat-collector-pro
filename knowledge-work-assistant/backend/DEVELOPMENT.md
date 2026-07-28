# backend/ 后端开发指南

> 一句话定位：本目录是 KWA 的 Python 3.12 + FastAPI 后端，监听 8788 端口，提供图谱 CRUD、节点延伸、Study 测验、Work 风口/报告/提问、浏览器插件对接、流式 LLM 触发等 API；用 SQLAlchemy 2.0 异步 ORM + aiosqlite 操作 SQLite（含 FTS5 全文检索），uv 管理依赖。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是 KWA 软件侧的后端，与插件侧 [web-ai-chat-collector](../../web-ai-chat-collector/DEVELOPMENT.md) 的对接关系如下：

- **接收推送**：[app/routers/plugin.py](./app/routers/plugin.py) 的 `POST /api/plugin/conversations` 端点接收 collector 二次开发后通过 [plugin-sdk/kwa-push.js](../plugin-sdk/kwa-push.js) 推送的对话，落库为 `Observation`（`source='plugin'`）。详见 [app/routers/DEVELOPMENT.md](./app/routers/DEVELOPMENT.md) 的 `plugin.py` 章节。
- **平台白名单对齐**：`routers/plugin.py` 的 `SUPPORTED_PLATFORMS = ['chatgpt','claude','gemini','deepseek','qwen','doubao','kimi','fudan','custom']` 与 collector 实际采集的 5 平台（`deepseek/qianwen/fudan/doubao/kimi`）取交集；`qianwen` 与 `qwen` 视为同义，collector 推送时统一用 `qwen`。
- **对话格式契约**：collector 推送的 `conversation_markdown` 使用 `## 用户` / `## 助手` 分段的 Markdown，本后端 [app/services/graph_agent.py](./app/services/graph_agent.py) 据此解析角色与内容。
- **LLM 厂商清单独立维护**：本后端 [app/services/model_config.py](./app/services/model_config.py) 加载 `model_config.json`，与 collector 的 [models.json](../../web-ai-chat-collector/models.json) 是**两份独立清单**；同步新增厂商时需两侧各改一处（详见工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"任务 1"）。
- **鉴权风险**：`POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，仅适用于本机 loopback（`127.0.0.1:8788`）；部署到公网 / 局域网需自行加反代鉴权。

跨子工程任务（启用推送、同步 LLM Provider、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

`backend/` 的代码全部在 `app/` 包内，根目录只放配置与脚本：

- **`app/`**：FastAPI 应用主包，详见 [app/DEVELOPMENT.md](./app/DEVELOPMENT.md)。
  - `app/main.py`：应用入口（lifespan + CORS + 14 个 router 挂载；新增 `chat.py` 提供多轮对话能力，详见 [app/routers/DEVELOPMENT.md](./app/routers/DEVELOPMENT.md) 的 `chat.py` 章节）
  - `app/config.py`：pydantic-settings 配置
  - `app/db.py`：异步引擎 + FTS5 虚拟表 + 触发器
  - `app/models/`：ORM + Pydantic schema + 节点类型枚举，详见 [app/models/DEVELOPMENT.md](./app/models/DEVELOPMENT.md)
  - `app/routers/`：14 个 FastAPI router，详见 [app/routers/DEVELOPMENT.md](./app/routers/DEVELOPMENT.md)
  - `app/services/`：21+ 个业务 service + `tools/` / `multimodal/` / `prompts/` 子包，详见 [app/services/DEVELOPMENT.md](./app/services/DEVELOPMENT.md)
- **`.env.example`**：环境变量模板（`cp .env.example .env` 后按需修改）
- **`.python-version`**：3.12（uv 自动按此版本建虚拟环境）
- **`pyproject.toml`**：依赖声明（uv 管理），含 ruff / pytest 配置
- **`uv.lock`**：依赖锁定文件（提交进仓库，保证可复现安装）
- **`seed-graph.ps1`**：PowerShell 脚本，调 API 注入最小 study 图谱，用于开发自检

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| `app/main.py` | FastAPI 入口 | `lifespan`（加载 `_REGISTRY.load()` → `init_db()` → `migrate_node_columns(engine)` → `init_graph_agent()`）；CORS 允许 `["http://localhost:5174","file://"]`；按 `/api` 前缀挂载 11 个 router + `/ws` |
| `app/config.py` | 配置 | `Settings(BaseSettings)`：`backend_port=8788` / `data_dir=./data` / `database_url=sqlite+aiosqlite:///./data/app.db` / `cors_origins=["http://localhost:5174","file://"]` / `encryption_key`（空时由 crypto 自动生成）；`ensure_dirs()` 创建 `data/`、`data/files/`、`data/sessions/` |
| `app/db.py` | 异步 DB | `engine = create_async_engine(settings.database_url, future=True)`；`AsyncSessionLocal = async_sessionmaker(...)`；`init_db()` 调 `Base.metadata.create_all` + 创建 4 张 FTS5 虚拟表 + 同步触发器；`get_session()` FastAPI 依赖；`_set_sqlite_pragma` 监听器确保 `PRAGMA foreign_keys=ON` |
| `pyproject.toml` | 依赖声明 | `requires-python >= 3.12`；运行依赖：fastapi/uvicorn[standard]/openai/httpx/sqlalchemy/aiosqlite/pypdf/python-docx/Pillow/pydantic/pydantic-settings/cryptography/python-multipart/python-pptx/python-dotenv；dev：ruff/pytest/pytest-asyncio；`ruff.line-length=100` `target-version=py312`；`pytest.ini_options.asyncio_mode=auto` |
| `.env.example` | 环境变量模板 | `APP_ENV / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_CONTEXT_WINDOW / DATA_DIR / DATABASE_URL / APP_ENCRYPTION_KEY / CORS_ORIGINS / BACKEND_PORT`，每项含注释 |
| `seed-graph.ps1` | 种子脚本 | 调 `POST /api/graphs` + `POST /api/graphs/{id}/nodes` + `POST /api/graphs/{id}/edges` 注入一个最小 study 图谱（3 节点 + 2 边），用于开发自检 |

## 开发工作流

### 首次启动

```bash
cd knowledge-work-assistant/backend

# 复制环境变量模板
cp .env.example .env
# 按需编辑 .env，至少填 LLM_API_KEY 才能让 graph_agent 正常工作

# 安装依赖（uv 会自动创建 .venv 并按 .python-version 选 3.12）
uv sync

# 启动后端（监听 8788，热重载）
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8788
```

启动后：
- 健康检查：<http://127.0.0.1:8788/api/health> 应返回 `{"status":"ok","service":"knowledge-work-assistant-backend","version":"0.0.0"}`
- Swagger UI：<http://127.0.0.1:8788/docs> 查看所有 API 契约
- ReDoc：<http://127.0.0.1:8788/redoc> 替代风格文档

### 日常开发

- 改任何 `.py` 文件后，`uvicorn --reload` 自动重启；控制台输出 `[INFO] Uvicorn running on http://127.0.0.1:8788` 与各模块日志。
- 改 `app/models/db_models.py` 的表结构后（增删字段），需要 `rm backend/data/app.db` 重启（开发期用 `create_all`，不会改已存在的表）。
  - 若只是给 `nodes` 表加列，可用 `migrate_node_columns(engine)`（幂等的 ADD COLUMN 迁移）；新增列需在 `_NODE_MIGRATION_COLUMNS` 列表里登记。
- 改 `app/services/*.py` 后，触发对应路由验证；流式 LLM 任务可在 Swagger UI 直接试调（`/api/graphs/{id}/nodes/{nid}/detail-stream` 等会立即返回 `request_id`，实际 token 走 WebSocket）。
- 改 `app/routers/*.py` 后，访问 `/docs` 确认契约同步。
- LLM 调用日志观察：`uvicorn` 控制台 `[graph_agent]` 前缀；前端 DevTools → Network → WS 看 token 流。

### 常用命令

```bash
# 跑测试（已有 e2e 测试套件覆盖插件推送链路，见 tests/e2e/）
uv run pytest

# Lint
uv run ruff check .

# Format
uv run ruff format .

# 种子数据自检
powershell -File seed-graph.ps1

# 直接运行（用 settings.backend_port，与 uvicorn --port 等效）
uv run python -m app.main
```

### 调试技巧

- **后端日志**：`uvicorn` 控制台输出；`logger = logging.getLogger(__name__)` 各模块独立日志；流式 LLM 推送时观察 `[graph_agent]` 前缀。
- **数据库内容**：用 DB Browser for SQLite 打开 `backend/data/app.db`，查看 `graphs/nodes/edges/observations/quizzes/sessions/messages/settings/tags/file_metadata/file_tags/mcp_servers/checkpoints` 等表；FTS5 虚拟表（`messages_fts` / `checkpoints_fts` / `file_metadata_fts` / `observations_fts`）也可查询。
- **加密 key**：`backend/data/.encryption_key` 是 Fernet 密钥，**该文件丢失则历史加密字段无法解密**（如 `settings.llm.api_key`），需重新配置 LLM 凭据。
- **Swagger UI 调试**：`/docs` 页面直接点 "Try it out" 测任意接口；流式端点会立即返回 `request_id`，要看 token 流需在前端 DevTools → Network → WS 看。
- **种子脚本失败**：检查后端是否启动、`/api/health` 是否 200；`seed-graph.ps1` 用 `Invoke-RestMethod` 调 API，PowerShell 版本需 ≥ 5.1。

## 代码约定

### Python 风格

- **Python 版本**：3.12（`.python-version` 锁定）。
- **类型注解**：全量 `from __future__ import annotations`；ORM 用 `Mapped[T]` / `mapped_column(...)`；Pydantic schema 用 `Field(...)` 标注约束。
- **异步栈**：FastAPI + SQLAlchemy 2.0 异步 ORM + aiosqlite；所有 DB 操作走 `AsyncSessionLocal`；service 层方法均 `async def`。
- **错误处理**：service 层抛 `ValueError` 表示业务校验失败；router 层用 `_handle_value_error` 映射为 HTTP 404/422/400；LLM 调用失败由 `graph_agent` 统一降级（返回空列表 / 兜底文本 + `degraded: true`），不向上抛。
- **JSON 字段透明序列化**：`detail_payload` / `user_fill` / `metadata_json` / `payload` / `result` 在 DB 中以 TEXT 存 JSON 字符串，service 层在读取时反序列化为 dict，写入时序列化为 JSON 字符串。
- **ID 风格**：32 位十六进制（`uuid.uuid4().hex`）。
- **导入顺序**：标准库 → 第三方 → 本项目（`from app.xxx import yyy`）；`from __future__ import annotations` 在文件首行（在 docstring 之后）。

### 命名规范

- **模块文件**：全小写下划线（`graph_store.py` / `llm_client.py` / `node_types.py`）。
- **类**：PascalCase（`GraphStore` / `LLMClient` / `GraphAgent` / `PluginConversationRequest`）。
- **函数 / 方法**：snake_case（`extract_candidates` / `mark_observation_processed` / `get_llm_client`）；私有方法下划线前缀（`_call_llm_json` / `_build_context` / `_handle_value_error`）。
- **常量**：全大写下划线（`GRAPH_TYPES` / `SUPPORTED_PLATFORMS` / `STUDY_SUBJECTS` / `WORK_OBJECTS` / `_MAX_EXTENSIONS_ALL`）。
- **Pydantic schema**：动作 + 时间（`GraphCreate` / `GraphUpdate` / `GraphResponse` / `NodeCreate` / `NodeUpdate` / `NodeResponse`）；请求后缀 `Create` / `Update` / `Request`，响应用 `Response` 或不带后缀。

### ruff 配置

`pyproject.toml` 中：
- `line-length = 100`
- `target-version = "py312"`
- `lint.select = ["E", "F", "W", "I", "UP", "B"]`（pycodestyle errors/warnings + Pyflakes + isort + pyupgrade + flake8-bugbear）

### pytest 配置

- `asyncio_mode = "auto"`：异步测试无需 `@pytest.mark.asyncio` 装饰器。
- 当前测试较少，主要靠 `seed-graph.ps1` 端到端自检 + Swagger UI 手动验证。

## 常见任务

### 任务 1：新增一个 API 端点

**场景**：在已有路由上加一个新端点，如 `GET /api/graphs/{id}/nodes/{nid}/related`（查询相关节点）。

**步骤**：
1. 在 [app/services/graph_store.py](./app/services/graph_store.py) 加 `async def get_related_nodes(self, graph_id, node_id, depth=1) -> list[dict]`：查询与 `node_id` 直接相邻的节点（通过 `edges` 表 `src_id` / `dst_id` 双向匹配）。
2. 在 [app/routers/nodes.py](./app/routers/nodes.py) 或 [app/routers/graphs.py](./app/routers/graphs.py) 加：
   ```python
   @router.get(
       "/graphs/{graph_id}/nodes/{node_id}/related",
       response_model=list[NodeResponse],
   )
   async def get_related_nodes(
       graph_id: str,
       node_id: str,
       depth: int = Query(1, ge=1, le=3),
       store: GraphStore = Depends(get_graph_store),
   ):
       try:
           return await store.get_related_nodes(graph_id, node_id, depth)
       except ValueError as exc:
           raise _handle_value_error(exc) from exc
   ```
3. 在 [app/models/schemas.py](./app/models/schemas.py) 检查 `NodeResponse` 是否够用；如需额外字段（如 `relation` / `distance`），新建 `RelatedNodeResponse(NodeResponse)` 子类。
4. 在 [frontend/src/lib/api.ts](../frontend/src/lib/api.ts) 加 `getRelatedNodes(graphId, nodeId, depth?)` 方法。
5. 在 [frontend/src/lib/types.ts](../frontend/src/lib/types.ts) 加对应类型。
6. 在前端组件中调用并渲染。

**验证**：Swagger UI 访问 `/api/graphs/{id}/nodes/{nid}/related` 返回相关节点列表；前端组件显示正确。

### 任务 2：新增一个数据库表

**场景**：要存"节点学习计划"（NodeStudyPlan），关联到节点。

**步骤**：
1. 在 [app/models/db_models.py](./app/models/db_models.py) 加新类：
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
       # ...
   ```
2. 在 `Node` 类加反向关系：`study_plans: Mapped[list[NodeStudyPlan]] = relationship(back_populates="node", cascade="all, delete-orphan")`，新类加 `node: Mapped[Node] = relationship(back_populates="study_plans")`。
3. **删除 `data/app.db` 重启**（开发期 `create_all` 不会改已存在的表），表会自动创建。
4. 在 [app/models/schemas.py](./app/models/schemas.py) 加 `NodeStudyPlanCreate` / `NodeStudyPlanResponse`。
5. 在 [app/services/graph_store.py](./app/services/graph_store.py) 加 CRUD 方法（`create_study_plan` / `list_study_plans` / `delete_study_plan`）。
6. 在 [app/routers/](./app/routers/) 加对应路由（或在 `nodes.py` 加嵌套路由 `POST /api/graphs/{id}/nodes/{nid}/study-plans`）。
7. 前端同步加类型、api 方法、UI 组件。

**验证**：`data/app.db` 中能看到新表；Swagger UI 能调新接口；前端能创建/查看学习计划。

### 任务 3：新增一个 LLM 调用场景

**场景**：希望 graph_agent 提供"节点重要性评分"能力。

**步骤**：
1. 在 [app/services/graph_agent.py](./app/services/graph_agent.py) 加 `async def score_node_importance(self, graph_id, node_id) -> dict`：
   ```python
   async def score_node_importance(self, graph_id: str, node_id: str) -> dict:
       client = await self._get_llm_client()
       if client is None:
           return {"score": 0.5, "reason": "LLM 不可用，返回默认分", "degraded": True}
       node = await graph_store.get_node(graph_id, node_id)
       neighbors = await graph_store.get_neighbors(graph_id, node_id)
       prompt = self._build_importance_prompt(node, neighbors)
       try:
           result = await self._call_llm_json(client, prompt)
           return {"score": float(result.get("score", 0.5)), "reason": result.get("reason", ""), "degraded": False}
       except Exception as exc:
           logger.warning("节点重要性评分失败: %s", exc)
           return {"score": 0.5, "reason": "LLM 调用失败", "degraded": True}
   ```
2. 在 [app/routers/](./app/routers/) 加 `POST /api/graphs/{id}/nodes/{nid}/score` 路由。
3. 在 [app/main.py](./app/main.py) 注册新 router（若新建文件）。
4. 前端加 api 方法、UI 入口。

**验证**：触发评分接口 → 返回 score 与 reason → degraded 字段在 LLM 不可用时为 true。

### 任务 4：调整 LLM 兜底模型清单

**场景**：希望加一个新厂商到 `model_config.json` 注册表。

**步骤**：
1. 找到 `app/services/model_config.json`（若不存在，看 [app/services/model_config.py](./app/services/model_config.py) 的 `_FALLBACK_REGISTRY` 兜底硬编码）。
2. 加新条目：
   ```json
   {
     "id": "newprovider",
     "name": "New Provider",
     "base_url": "https://api.newprovider.com/v1",
     "models": [
       {"id": "newmodel", "name": "New Model", "context_window": 128000}
     ]
   }
   ```
3. 重启后端，`_REGISTRY.load()` 会重新加载。
4. 在前端 SettingsPanel 的 LLM 配置区可看到新选项（如已实现动态下拉）。
5. **同步更新 collector 侧**的 [web-ai-chat-collector/models.json](../../web-ai-chat-collector/models.json)，确保两端一致（参考工作区根 DEVELOPMENT.md 的"任务 1"）。

**验证**：在前端 SettingsPanel 选择新厂商 → 填 API Key → 测试连通性返回成功 → 触发一次节点详情生成确认流式正常。

### 任务 5：调试 SQLite + FTS5 问题

**场景**：启动时报 `FTS5 虚拟表创建失败` 或全文检索不工作。

**步骤**：
1. 看 `uvicorn` 控制台是否有 `WARNING app.db:_create_fts5: FTS5 虚拟表创建失败` 日志。
2. 用 `uv run python -c "import sqlite3; conn = sqlite3.connect(':memory:'); print(conn.execute(\"SELECT sqlite_compileoption_used('ENABLE_FTS5')\").fetchone())"` 检查 SQLite 是否编译了 FTS5。
3. 若返回 `(0,)` 或 `(None,)`，说明 SQLite 未启用 FTS5：
   - Windows：默认 Python 的 SQLite 应含 FTS5；若没含，升级 Python 到 3.12+ 或换 pysqlite3-binary。
   - macOS：系统 Python 的 SQLite 可能不含 FTS5，用 `brew install python@3.12` 装新版。
   - Linux：用包管理器装 `libsqlite3-dev`（含 FTS5）后重装 Python。
4. 若 FTS5 不可用，后端会跳过创建虚拟表与触发器，`messages_fts` / `observations_fts` 等表不存在；`knowledge_store` / `tag_store` 的全文检索会失效，但应用仍能启动。
5. 重启后端确认 `data/app.db` 中有 `*_fts` 表（用 DB Browser for SQLite 查看）。

**验证**：用 `SELECT * FROM observations_fts WHERE observations_fts MATCH '知识'` 能查到包含"知识"的对话。

## 扩展点

### 新增 service 模块

- 在 `app/services/` 加新文件，遵循既有风格：顶部 docstring → `from __future__ import annotations` → 类型注解 → `logger = logging.getLogger(__name__)` → 业务函数。
- 需要全局状态的 service 用模块级单例（`xxx_store = XxxStore()`），便于 router 通过 `Depends(get_xxx_store)` 注入。
- LLM 调用必须经 `llm_factory.get_llm_client()` 获取客户端，不要直接 `import openai`。
- service 层方法均 `async def`，DB 操作走 `AsyncSessionLocal`（`async with AsyncSessionLocal() as session: ...`）。

### 新增 router 模块

- 在 `app/routers/` 加新文件，导出 `router = APIRouter()`。
- 在 [app/main.py](./app/main.py) 加 `from app.routers import xxx as xxx_router` + `app.include_router(xxx_router.router, prefix="/api", tags=["xxx"])`。
- 路由通过 `Depends(get_xxx_store)` 拿全局单例，便于测试时用 `app.dependency_overrides` 替换。
- 统一用 `_handle_value_error` 把 service 抛的 ValueError 映射为 HTTP 异常（404/422/400）。

### 新增 ORM 模型

- 在 [app/models/db_models.py](./app/models/db_models.py) 加新类，继承 `Base`，用 `Mapped[T]` / `mapped_column(...)` 声明字段。
- 表名用复数（`nodes` / `edges` / `observations`）。
- 主键统一 `String(32)` + `uuid.uuid4().hex`（32 位十六进制）。
- 外键用 `ForeignKey("xxx.id", ondelete="CASCADE")`，确保级联删除。
- 关系用 `relationship(back_populates="xxx", cascade="all, delete-orphan", passive_deletes=True)`。
- 若只是给 `nodes` 表加列，登记到 `_NODE_MIGRATION_COLUMNS` 列表，`migrate_node_columns(engine)` 会幂等迁移；其他表的 schema 变更需 `rm data/app.db` 重启（开发期）或后续接入 Alembic。

### 新增 Pydantic schema

- 在 [app/models/schemas.py](./app/models/schemas.py) 加新类，继承 `BaseModel`。
- 请求后缀 `Create` / `Update` / `Request`，响应用 `Response` 或不带后缀。
- 字段用 `Field(..., min_length=1, max_length=255, description="...")` 标注约束与文档。
- 与 `frontend/src/lib/types.ts` 一一对应（命名用 PascalCase，字段用 camelCase 以匹配 TS 习惯，由 FastAPI 自动序列化为 camelCase 或前端做转换）。

### 新增环境变量

- 在 [app/config.py](./app/config.py) 的 `Settings` 类加新字段（含默认值与注释）。
- 在 [.env.example](./.env.example) 加对应条目与说明。
- 重启后端生效；前端若需读取，加对应 API 端点暴露（不要直接暴露 `.env` 内容）。

## 注意事项（坑）

### SQLite 外键级联需手动开启

- SQLAlchemy 默认不开启 SQLite 的 `PRAGMA foreign_keys`，本项目在 [app/db.py](./app/db.py) 用 `event.listens_for(engine.sync_engine, "connect")` 监听器在每次连接时执行 `PRAGMA foreign_keys=ON`。
- 若手动用 DB Browser for SQLite 操作数据库，默认 `PRAGMA foreign_keys=OFF`，删除图谱不会级联清理 nodes / edges；需要在 DB Browser 的"Execute SQL"中先跑 `PRAGMA foreign_keys=ON;`。

### FTS5 不可用时静默降级

- 部分 SQLite 编译版本不含 FTS5（罕见），`init_db` 会捕获异常并跳过，仅记录日志，不阻断启动。
- 此时 `messages_fts` / `observations_fts` 等表不存在，`knowledge_store` / `tag_store` 的全文检索会失效，但图谱 CRUD 等核心功能仍可用。
- 用 `SELECT sqlite_compileoption_used('ENABLE_FTS5')` 检查是否启用。

### `create_all` 不会改已存在的表

- 开发期改 ORM 模型（加字段 / 改类型 / 删字段）后，`Base.metadata.create_all` 不会修改已存在的表结构。
- 解决方案：
  - 简单加列：登记到 `_NODE_MIGRATION_COLUMNS`，`migrate_node_columns(engine)` 会幂等 ADD COLUMN（SQLite 不支持 DROP COLUMN / ALTER COLUMN）。
  - 其他变更：`rm data/app.db` 重启（开发期可接受，会丢数据）；生产环境需接入 Alembic 迁移（当前未配置）。

### LLM 凭据的两种来源

- **开发期**：`backend/.env` 的 `LLM_API_KEY`（明文，仅 dev 用），由 [app/config.py](./app/config.py) 的 `Settings.llm_api_key` 读取。
- **生产 / 用户配置**：前端 SettingsPanel 保存到后端 `settings` 表（`llm.api_key` 加密为 Fernet 密文存储），由 [app/services/llm_factory.py](./app/services/llm_factory.py) 的 `get_llm_client()` 解密读取。
- `llm_factory.get_llm_client()` 优先用 settings 表的配置（若存在），否则回退到 `.env`。
- `APP_ENCRYPTION_KEY` 留空时由 [app/services/crypto.py](./app/services/crypto.py) 自动生成并落盘到 `data/.encryption_key`，**该文件丢失则历史加密字段无法解密**。

### 流式 LLM 任务的双通道

- 流式端点（`/api/graphs/{id}/nodes/{nid}/detail-stream` 等）的 HTTP 响应**只**返回 `StreamStartedResponse { request_id }`，立即结束。
- 实际 token 流通过 **WebSocket** 推送（按 `session_id` 路由），前端通过 `streamingSessionId` 绑定连接。
- 前端若未连 WebSocket（`sessionId` 为 null），store 内会自动回退到非流式接口（`/api/graphs/{id}/nodes/{nid}/detail` 等同步接口）。
- 取消流式任务：`POST /api/llm/requests/{request_id}/cancel`，后端 `llm_request_registry` 持有 `asyncio.Task` 引用，取消时 `task.cancel()`。

### lifespan 中的初始化顺序

`app/main.py` 的 `lifespan` 按顺序执行：
1. `_REGISTRY.load()`：加载 `model_config.json`，失败回退到 `_FALLBACK_REGISTRY` 硬编码。
2. `await init_db()`：创建所有表 + FTS5 虚拟表 + 触发器 + 确保 `data/` / `data/files/` / `data/sessions/` 目录存在。
3. `await migrate_node_columns(engine)`：幂等迁移 nodes 表 5 个智能推荐列。
4. `await migrate_session_columns(engine)`：幂等迁移 `sessions` 表 `mode` / `graph_id` 两列（Task 8 chat 路由用），与 `migrate_node_columns` 同模式。
5. `try: init_main_agent(); init_writer_agent(...) except Exception: logging.warning(...)`：初始化 MainAgent / WriterAgent 单例；LLM 未配置或调不通时**降级跳过**（仅记 warning，不阻断启动）。
6. `init_graph_agent()`：初始化全局 GraphAgent 单例（无状态，仅确保模块加载与启动日志）。

**顺序不能乱**：`init_db` 必须在 `migrate_node_columns` / `migrate_session_columns` 之前（否则对应表不存在）；`_REGISTRY.load` 必须在 `init_main_agent` / `init_writer_agent` / `init_graph_agent` 之前（否则依赖 `model_config` 的 agent 用空注册表）。

### 32 位十六进制 ID 不能含连字符

- 本项目所有主键 ID 用 `uuid.uuid4().hex`（32 位十六进制无连字符）。
- 不要混用 `str(uuid.uuid4())`（带连字符的 36 位格式），会导致前端 `Node.id` 字段类型校验失败。
- WebSocket 的 `session_id` 也用 32 位十六进制（前端 `generateSessionId()` 生成）。

### CORS 配置

- 默认 `cors_origins = ["http://localhost:5174", "file://"]`，允许前端 Vite dev server 与 Electron file:// 加载的打包产物。
- 浏览器插件（Chrome extension）通过 `chrome-extension://<id>` 访问后端时，**扩展的 host_permissions 可豁免 CORS**，所以无需把扩展 ID 加入 `cors_origins`。
- 若部署到局域网，需把客户端访问域名加入 `cors_origins`（JSON 数组格式，如 `["http://192.168.1.100:5174"]`）。

### 推送端点的鉴权风险

- `POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，仅适用于本机 loopback（`127.0.0.1:8788`）。
- 若将后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必自行在反向代理层（如 Nginx / Caddy）加 token / Origin 白名单 / IP 限制。
- 详见 [plugin-sdk/README.md](../plugin-sdk/README.md) 的"风险提示"章节。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 ORM 模型 / Pydantic schema / 节点类型枚举 | [app/models/DEVELOPMENT.md](./app/models/DEVELOPMENT.md) |
| 要改路由 / 新增 API 端点 | [app/routers/DEVELOPMENT.md](./app/routers/DEVELOPMENT.md) |
| 要改服务层 / graph_agent / LLM 调用 / 图谱存储 | [app/services/DEVELOPMENT.md](./app/services/DEVELOPMENT.md) |
| 要看应用入口 / 配置 / DB 初始化 | [app/DEVELOPMENT.md](./app/DEVELOPMENT.md) |
| 要改前端 / 联调 | [../frontend/DEVELOPMENT.md](../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../plugin-sdk/DEVELOPMENT.md](../plugin-sdk/DEVELOPMENT.md) |
| 要看项目整体架构 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |

# knowledge-work-assistant 项目开发指南

> 一句话定位：这是「复赛工作区」的**软件侧**——双模式（Study / Work）知识图谱桌面软件，由 Electron + React + TypeScript 前端 + Python 3.12 + FastAPI 后端组成；通过 `POST /api/plugin/conversations` 接收插件侧 [web-ai-chat-collector](../web-ai-chat-collector/DEVELOPMENT.md) 推送的对话，由 `graph_agent` 抽取知识点形成图谱，并提供 Study 模式（测验 / 费曼解释）与 Work 模式（风口推荐 / 工作报告 / 用户提问）两类业务能力。本文件是项目根目录的全局导航，三个子目录（`backend/`、`frontend/`、`plugin-sdk/`）各有自己的 `DEVELOPMENT.md`。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本项目是「复赛工作区」的**软件侧**，与**插件侧** [web-ai-chat-collector](../web-ai-chat-collector/DEVELOPMENT.md) 构成一个完整项目：

- **数据来源**：本项目后端的 `Observation` 表接收两类来源——(a) 浏览器插件推送（`source='plugin'`，由 collector 二次开发后通过 [plugin-sdk/kwa-push.js](./plugin-sdk/kwa-push.js) 推送）；(b) 用户手动导入 / 应用内输入（`source='import'` / `'manual'`）。
- **抽取链路**：`observations.conversation_markdown` → `graph_agent.extract_candidates_from_observation` → 候选节点 → 用户确认批量入图 → `nodes` / `edges` 表 → 前端图谱可视化。
- **共享约定**：
  - 平台白名单：本项目 `routers/plugin.py` 的 `SUPPORTED_PLATFORMS = ['chatgpt','claude','gemini','deepseek','qwen','doubao','kimi','fudan','custom']`，与 collector 实际采集的 5 平台（`deepseek/qianwen/fudan/doubao/kimi`）取交集；`qianwen` 与 `qwen` 视为同义，collector 推送时统一用 `qwen`。
  - 对话格式：collector 推送与导出均使用 `## 用户` / `## 助手` 分段的 Markdown，本项目 `graph_agent` 据此解析角色与内容。
  - LLM 厂商清单：本项目 `backend/app/services/model_config.py` 启动时加载 `backend/app/services/model_config.json`；与 collector 的 `models.json` **独立维护**，同步新增厂商时两侧各改一处。

跨子工程任务（同步新增 LLM Provider、启用推送能力、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

根目录只承担"装配与声明"职责，本身不含业务逻辑。三个子目录各有自己的 `DEVELOPMENT.md`：

```
knowledge-work-assistant/
├── backend/                # Python 3.12 + FastAPI 后端（监听 8788）
│   ├── app/
│   │   ├── main.py         # FastAPI 应用入口（lifespan + 路由装配 + CORS）
│   │   ├── config.py       # pydantic-settings 配置（端口 / 数据目录 / CORS / LLM 兜底）
│   │   ├── db.py           # SQLAlchemy 异步引擎 + AsyncSessionLocal + FTS5 虚拟表
│   │   ├── models/         #   ORM 模型 + Pydantic schema + 节点类型枚举
│   │   ├── routers/        #   FastAPI 路由（health/graphs/nodes/edges/quiz/work/plugin/stream/llm_admin/ws）
│   │   └── services/       #   业务服务层（graph_store / graph_agent / llm_client / ws_notify / ...）
│   ├── .env.example        # 环境变量模板
│   ├── .python-version     # 3.12
│   ├── pyproject.toml      # uv 管理的依赖声明
│   └── seed-graph.ps1      # PowerShell 脚本：调 API 注入种子图谱（开发自检用）
│
├── frontend/               # Electron + React + TypeScript + Vite 前端（Vite 5174）
│   ├── electron/           #   主进程 / preload / 后端启动器
│   ├── src/
│   │   ├── App.tsx         #   根组件（header + SideNav + 主内容区 + Toast）
│   │   ├── main.tsx        #   React 入口
│   │   ├── components/     #   React 组件（含 graph/ 子目录：图谱可视化与节点编辑）
│   │   ├── lib/            #   api / ws / types / electron.d.ts / nodeTemplates
│   │   ├── store/          #   Zustand 全局状态（useAppStore）
│   │   └── styles/         #   animations.css + app.css
│   ├── index.html
│   ├── package.json        # pnpm 管理，含 dev / dev:electron / build / dist scripts
│   ├── vite.config.ts      # 端口 5174，代理 /api、/ws 到 127.0.0.1:8788
│   └── tsconfig.json
│
└── plugin-sdk/             # 推送 SDK + UI 样式包 + 二次开发 patch（桥梁层）
    ├── kwa-push.js         #   UMD 推送 SDK（兼容 CommonJS / AMD / 浏览器全局 KwaPush）
    ├── kwa-push.d.ts       #   TypeScript 类型定义
    ├── ui/                 #   统一样式包 kwa-plugin.css + 视觉规范 style-guide.md
    ├── example/            #   最小可运行 Chrome MV3 示例扩展
    └── secondary-dev/      #   对原 collector 的二次开发 patch + PATCH-GUIDE.md
```

## 关键文件

| 文件 / 目录 | 职责 | 关键内容 |
|------|------|---------|
| `backend/app/main.py` | FastAPI 入口 | `lifespan`（加载 model_config → init_db → migrate_node_columns → init_graph_agent）；CORS 允许 `http://localhost:5174` 与 `file://`；按 `/api` 前缀挂载 11 个路由（health/graphs/nodes/extensions/extraction/quiz/work/recommendations/plugin/llm_admin/stream）+ `/ws` |
| `backend/app/config.py` | 配置 | `Settings` 类（pydantic-settings）：`backend_port=8788` / `data_dir=./data` / `database_url=sqlite+aiosqlite:///./data/app.db` / `cors_origins=["http://localhost:5174","file://"]` / `encryption_key`（空时由 crypto 自动生成并落盘）；`ensure_dirs()` 创建 `data/`、`data/files/`、`data/sessions/` |
| `backend/app/db.py` | 异步 DB | `engine = create_async_engine(settings.database_url, future=True)`；`AsyncSessionLocal`；`init_db()` 调 `Base.metadata.create_all` + 创建 4 张 FTS5 虚拟表（`messages_fts` / `checkpoints_fts` / `file_metadata_fts` / `observations_fts`）+ 同步触发器；`get_session()` FastAPI 依赖 |
| `backend/app/models/db_models.py` | ORM | 12 张表：`sessions/messages/checkpoints/file_metadata/tags/file_tags/mcp_servers/settings`（基础表，由前期项目骨架适配而来）+ `graphs/nodes/edges/observations/quizzes`（本项目新增图谱表）；`migrate_node_columns()` 幂等迁移 nodes 表 5 个智能推荐列 |
| `backend/app/models/schemas.py` | Pydantic | API 请求 / 响应模型，与 `frontend/src/lib/types.ts` 一一对应；含 GraphCreate/Update/Response、NodeCreate/Update/Response、EdgeCreate/Response、Observation 系列、Quiz 系列、PluginConversationRequest/Response 等 |
| `backend/app/models/node_types.py` | 节点类型枚举 | `GRAPH_TYPES = ('study','work')`；`STUDY_SUBJECTS` / `WORK_OBJECTS` 各自的 enum + 模板（`STUDY_TEMPLATES` / `WORK_TEMPLATES`）；`is_valid_node_type` / `default_detail_payload` / `default_user_fill` / `get_template` |
| `backend/app/routers/` | 路由层 | 13 个 router 模块，按业务域拆分；每个 router 通过 `Depends(get_xxx_store)` 拿全局单例；统一用 `_handle_value_error` 把 service 抛的 ValueError 映射为 404/422/400 |
| `backend/app/services/` | 服务层 | 16 个 service 模块；`graph_store`（图谱 CRUD + JSON 透明序列化）+ `graph_agent`（图谱 AI Agent，封装 LLM 调用 + 流式 + 降级）+ `llm_client`/`llm_factory`/`llm_errors`/`llm_request_registry`/`model_config` + `crypto`/`settings_store` + `ws_notify`/`session_queue` + `tag_store`/`knowledge_store`/`file_storage`/`sub_agent` |
| `frontend/electron/main.ts` | 主进程 | 创建 1280×820 窗口；`registerIpcHandlers` 注册 `backend:get-url` / `backend:get-ws-url` 同步 IPC；`startBackendAndWait()` 生产环境拉起后端子进程 |
| `frontend/electron/preload.ts` | 桥接 | `contextBridge.exposeInMainWorld('electronAPI', { backend: { getUrl, getWsUrl } })`，渲染进程通过 `window.electronAPI.backend.getUrl()` 获取后端地址 |
| `frontend/electron/launcher.ts` | 后端启动器 | 生产环境 spawn `python -m uvicorn app.main:app --port 8788`；轮询 `/api/health` 30s 超时；`getBackendBaseUrl()` / `getBackendWsUrl()` 供 IPC 同步返回 |
| `frontend/src/App.tsx` | 根组件 | 布局：header（标题 + 健康徽章 + ModeSwitch）+ SideNav（对话/图谱/设置三栏切换）+ 主内容区（GraphList + ContentToolbar + GraphView/CardView + 5 个浮层面板）+ Toast + footer；启动时连 `/ws?session_id=<uuid>` 订阅 `plugin.conversation_received` 与 `graph_agent_*` 流式事件 |
| `frontend/src/store/useAppStore.ts` | Zustand 全局状态 | 集中管理 mode/view/currentGraphId/fullGraph/graphs/loading/error + 延伸批次 + 候选节点抽取 + 测验三段式 + 流式文本（qa/report/nodeDetail）+ Toast；所有 action 捕获异常后写 `error` 状态，不中断渲染 |
| `frontend/src/lib/api.ts` | HTTP 客户端 | 自动 `/api` 前缀；file:// 通过 `window.electronAPI.backend.getUrl()` 取后端地址；dev 用相对路径走 Vite 代理；统一抛 `ApiError` |
| `frontend/src/lib/ws.ts` | WebSocket 客户端 | `TestSocket` 类：`connect(sessionId)` / `send(obj)` / `onEvent(cb)`；`generateSessionId()` 生成 32 位十六进制 |
| `frontend/src/lib/types.ts` | 类型定义 | 与 `backend/app/models/schemas.py` 一一对应；含 Graph/Node/Edge/Observation/Quiz/Trend/RecommendationItem 等 |
| `frontend/vite.config.ts` | Vite 配置 | `base: './'`（便于 Electron file:// 加载）；`server.port: 5174 strictPort: true`；proxy `/api` → `http://127.0.0.1:8788`、`/ws` → `ws://127.0.0.1:8788`，超时 5min（流式 LLM 用） |
| `frontend/package.json` | 前端依赖 | `react 18.3` / `react-markdown 9` / `remark-gfm 4` / `d3-force 3` / `react-force-graph-2d 1.25` / `zustand 4.5`；scripts: `dev` / `dev:electron` / `build` / `dist`（electron-builder + NSIS） |
| `plugin-sdk/kwa-push.js` | 推送 SDK | UMD 模块；`pushConversation` / `configure` / `createClient` / `SUPPORTED_PLATFORMS`；超时 + 指数退避 + AbortSignal 取消；camelCase ↔ snake_case 自动转换 |
| `plugin-sdk/kwa-push.d.ts` | 类型定义 | 与 `kwa-push.js` 运行时导出一一对应；`KwaPushError` / `KwaPushValidationError` |
| `plugin-sdk/ui/kwa-plugin.css` | UI 样式包 | 定义 `--kwa-accent` 等 CSS 变量（study 墨绿 / work 琥珀双模式）+ `.kwa-btn` 等组件类 |
| `plugin-sdk/secondary-dev/` | 二次开发 patch | 4 个 patch 文件 + `PATCH-GUIDE.md`；不修改原 collector，仅在副本上应用 |

## 开发工作流

### 启动后端

```bash
cd knowledge-work-assistant/backend

# 首次：复制环境变量模板（按需修改 LLM_API_KEY 等）
cp .env.example .env

# 安装 Python 依赖（uv 会自动创建 .venv 并锁定依赖）
uv sync

# 启动后端（监听 8788 端口，热重载）
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8788
```

启动后访问 <http://127.0.0.1:8788/api/health>，应返回：

```json
{"status":"ok","service":"knowledge-work-assistant-backend","version":"0.0.0"}
```

### 启动前端

打开新终端：

```bash
cd knowledge-work-assistant/frontend

# 安装前端依赖
pnpm install

# 方式 A：仅启动 Vite dev server（纯浏览器联调，不启动 Electron）
pnpm dev
# → 浏览器访问 http://localhost:5174

# 方式 B：同时启动 Vite + Electron（dev:electron 会先等 Vite 就绪再启动 Electron）
pnpm dev:electron
```

打开应用后界面结构：

- **header**：标题 + 副标题 ｜ 健康徽章（绿点 / 红点 + 后端版本号） ｜ ModeSwitch（study / work 切换）
- **SideNav**（最左 56px 窄栏）：从上到下「对话 / 图谱 / 设置」三个图标按钮
- **主内容区**（按 activeNav 切换）：
  - `graph` → GraphList（左）+ content-area（ContentToolbar + GraphView/CardView 双视图 + PendingNodes/QuizPanel/WorkInput/TrendsSidebar/ReportPanel/QAPanel 浮层）
  - `chat` → ChatPanel（Work 模式内嵌对话，Study 模式提示）
  - `settings` → SettingsPanel（LLM API 配置 + 请求队列管理）

### 改后端代码后

- `--reload` 自动重启；若改了 `models/db_models.py` 的表结构，需要手动 `rm backend/data/app.db` 重启（开发期用 `create_all`，不走 Alembic 迁移）。
- 改 `services/graph_agent.py` 后，触发流式 LLM 任务时观察 SW DevTools（Electron 下：主窗口右键 → 检查 → Network 与 Console）。
- 改 `routers/*.py` 后，访问 `/docs`（Swagger UI）确认接口契约同步。

### 改前端代码后

- Vite HMR 自动热替换；改 React 组件后页面即时刷新。
- 改 `electron/main.ts` / `preload.ts` / `launcher.ts` 后需要重新 `pnpm dev:electron`（Electron 主进程不支持 HMR）。
- 改 `store/useAppStore.ts` 的 action 后，触发对应 UI 操作看 Console 日志与 Toast 提示。
- 改 `lib/types.ts` 后，需同步改 `backend/app/models/schemas.py`（两者一一对应）。
- TypeScript 类型检查：`pnpm typecheck`（不输出文件，仅校验）；ESLint：`pnpm lint`。

### 联调：插件推送链路

1. 启动后端（监听 8788）
2. 按 [plugin-sdk/secondary-dev/PATCH-GUIDE.md](./plugin-sdk/secondary-dev/PATCH-GUIDE.md) 把 patch 应用到 collector 副本
3. 加载 patched 后的 collector 扩展
4. 在任一受支持 AI 平台发起对话 → collector 采集 → 自动推送 → 前端会收到 WebSocket 事件 `plugin.conversation_received` 并弹 Toast
5. 在 study 模式图谱视图打开"待抽取"侧栏，确认 Observation 进入候选列表

### 调试技巧

- **后端日志**：`uv run uvicorn ... --reload` 控制台输出；`logger = logging.getLogger(__name__)` 各模块独立日志；流式 LLM 推送时观察 `[graph_agent]` 前缀。
- **WebSocket 日志**：前端 DevTools → Network → WS → 看 `ws://localhost:5174/ws?session_id=...` 的帧（`plugin.conversation_received` / `graph_agent_token` / `graph_agent_done` / `graph_agent_cancelled` / `graph_agent_error`）。
- **数据库内容**：用 DB Browser for SQLite 打开 `backend/data/app.db`，查看 `graphs/nodes/edges/observations/quizzes/sessions/messages/settings` 等表；FTS5 虚拟表（`messages_fts` 等）也可查询。
- **Electron 主进程日志**：`pnpm dev:electron` 启动时的终端输出（`[main]` 前缀）；后端子进程的 stdout 也会被重定向到这里。
- **生产模式调试**：`pnpm dist` 打包后安装运行，Electron 主进程日志在 `%APPDATA%/知识工作助手/logs/main.log`（如启用 electron-log）。
- **种子数据自检**：`cd backend && powershell -File seed-graph.ps1` 注入一个最小 study 图谱，用于验证图谱可视化是否正常。

## 代码约定

### 后端（Python）

- **Python 版本**：3.12（`.python-version` 锁定，uv 自动按此版本建虚拟环境）。
- **包管理**：uv（`uv sync` 安装依赖、`uv add xxx` 新增依赖、`uv run python -m xxx` 运行）。
- **异步栈**：FastAPI + SQLAlchemy 2.0 异步 ORM + aiosqlite；所有 DB 操作走 `AsyncSessionLocal`；service 层方法均 `async def`。
- **类型注解**：全量 `from __future__ import annotations`；ORM 用 `Mapped[T]` / `mapped_column(...)`；Pydantic schema 用 `Field(...)` 标注约束。
- **错误处理**：service 层抛 `ValueError` 表示业务校验失败；router 层用 `_handle_value_error` 映射为 HTTP 404/422/400；LLM 调用失败由 `graph_agent` 统一降级（返回空列表 / 兜底文本 + `degraded: true`），不向上抛。
- **JSON 字段透明序列化**：`detail_payload` / `user_fill` / `metadata_json` / `payload` / `result` 在 DB 中以 TEXT 存 JSON 字符串，service 层在读取时反序列化为 dict，写入时序列化为 JSON 字符串，调用方无需关心。
- **ID 风格**：32 位十六进制（`uuid.uuid4().hex`），与 sessions / messages 风格一致。
- **命名**：模块全小写下划线（`graph_store.py` / `llm_client.py`）；类 PascalCase（`GraphStore` / `LLMClient`）；函数 snake_case（`extract_candidates` / `mark_observation_processed`）；常量全大写下划线（`GRAPH_TYPES` / `SUPPORTED_PLATFORMS`）。
- **导入**：`from __future__ import annotations` 在文件首行（在 docstring 之后）；标准库 → 第三方 → 本项目（`from app.xxx import yyy`）。

### 前端（TypeScript + React）

- **TypeScript**：严格模式（`tsconfig.json` 的 `strict: true`）；所有 `lib/*.ts` 与 `components/*.tsx` 都需通过 `pnpm typecheck`。
- **状态管理**：Zustand（`store/useAppStore.ts` 单一 store），不使用 Redux / Context。组件通过 `useAppStore((s) => s.xxx)` 订阅切片。
- **样式**：CSS（`src/styles/app.css` + `animations.css`），不用 CSS-in-JS；BEM 风格命名（`app-header__title` / `health-badge--ok`）。
- **图谱渲染**：`react-force-graph-2d`（基于 d3-force）+ 自定义节点 / 边绘制（`components/graph/graphUtils.ts`）。
- **Markdown 渲染**：`react-markdown` + `remark-gfm`，统一在 `NodeDetailCard.tsx` / `QAPanel.tsx` / `ReportPanel.tsx` 中使用。
- **HTTP 客户端**：`lib/api.ts` 单例 `api`，所有请求经此发出；自动处理 `/api` 前缀与 file:// 环境的地址解析；统一抛 `ApiError`。
- **WebSocket**：`lib/ws.ts` 的 `TestSocket` 类，单例（在 `App.tsx` 的 `useRef` 中持有）；`onEvent(cb)` 订阅事件，回调返回 `off` 取消函数。
- **命名**：组件文件 PascalCase（`GraphView.tsx` / `NodeDetailCard.tsx`）；普通 lib 文件 camelCase（`api.ts` / `ws.ts`）；React 组件用 `function XxxYyy()` 而非箭头函数；Hook 用 `useXxx`；类型用 PascalCase（`Graph` / `Node` / `Observation`）。
- **目录**：组件放 `components/`（图谱相关子组件放 `components/graph/`）；库放 `lib/`；状态放 `store/`；样式放 `styles/`；Electron 主进程放 `electron/`。

### 通信协议

#### HTTP（`/api/*`）

- 开发环境（Vite dev server 5174）：前端用相对路径 `/api/health`，由 `vite.config.ts` 的 `server.proxy` 转发到 `http://127.0.0.1:8788`。
- 生产环境（Electron `file://` 加载打包产物）：前端通过 `window.electronAPI.backend.getUrl()` 获取后端基地址（`http://127.0.0.1:8788`），由 `electron/launcher.ts` 启动后端子进程。
- 流式 LLM 任务（`/api/graphs/{id}/nodes/{nid}/detail-stream` / `/api/graphs/{id}/work/ask-stream` / `/api/graphs/{id}/work/report-stream`）的 SSE 端点返回 `StreamStartedResponse { request_id }`，实际 token 通过 WebSocket 推送（按 `session_id` 路由），前端通过 `streamingSessionId` 绑定连接。

#### WebSocket（`/ws`）

- 开发环境：`ws://localhost:5174/ws?session_id=<uuid32>`，由 Vite 代理转发到 `ws://127.0.0.1:8788/ws`。
- 生产环境：`ws://127.0.0.1:8788/ws?session_id=<uuid32>`，通过 `window.electronAPI.backend.getWsUrl()` 获取。
- 事件类型：
  - `welcome` / `pong` / `echo`：联调测试通道。
  - `plugin.conversation_received`：后端 `POST /api/plugin/conversations` 推送成功后广播，前端弹 Toast + 刷新待抽取列表。
  - `graph_agent_token` / `graph_agent_done` / `graph_agent_cancelled` / `graph_agent_error`：流式 LLM 任务的 token 推送 / 完成 / 取消 / 失败事件，前端按 `op` 字段（`detail` / `ask` / `report`）分发到对应的流式文本切片。

## 常见任务

### 任务 1：新增一个图谱节点类型（Study 学科 / Work 工作对象）

**场景**：Study 模式新增"哲学"学科，或 Work 模式新增"风险"工作对象。

**步骤**：
1. 在 [backend/app/models/node_types.py](./backend/app/models/node_types.py) 的 `STUDY_SUBJECTS`（或 `WORK_OBJECTS`）元组加新枚举值。
2. 在 `STUDY_TEMPLATES`（或 `WORK_TEMPLATES`）加新模板：`detail_payload` 字段结构（"它是什么 / 为什么重要 / 关键内容 / 常见场景 / 延伸方向"）+ `user_fill` 字段结构（doubt / association / exam_point / error_point / note）。
3. 在 [frontend/src/lib/nodeTemplates.ts](./frontend/src/lib/nodeTemplates.ts) 同步加前端模板（用于 NodeEditor 渲染表单字段）。
4. 在 [frontend/src/components/graph/NodeEditor.tsx](./frontend/src/components/graph/NodeEditor.tsx) 检查表单渲染逻辑，必要时为新模板字段加特殊 UI（如 select / multiline）。
5. 跑种子脚本 `cd backend && powershell -File seed-graph.ps1` 注入含新类型节点的图谱，前端切换到图谱视图确认渲染正常。

**验证**：在 NodeEditor 中选择新类型 → 详情字段按模板渲染 → 保存后 `nodes.detail_payload` 落库正确 → 重新打开详情卡显示一致。

### 任务 2：新增一个图谱 AI 能力（如"节点合并建议"）

**场景**：希望 graph_agent 提供"合并相似节点"的 AI 建议。

**步骤**：
1. 在 [backend/app/services/graph_agent.py](./backend/app/services/graph_agent.py) 加 `async def suggest_merge(graph_id, node_id) -> dict`：构造 prompt（含目标节点 + 邻居节点）→ `_call_llm_json` → 返回候选合并节点 ID 列表 + 置信度。
2. 在 [backend/app/routers/](./backend/app/routers/) 新建 `merge.py` 或在 `extensions.py` 加 `POST /api/graphs/{id}/nodes/{nid}/merge-suggest` 路由，调 `graph_agent.suggest_merge`。
3. 在 [backend/app/main.py](./backend/app/main.py) 注册新 router（`app.include_router(merge.router, prefix="/api", tags=["merge"])`）。
4. 在 [frontend/src/lib/api.ts](./frontend/src/lib/api.ts) 加 `suggestMerge(graphId, nodeId)` 方法。
5. 在 [frontend/src/lib/types.ts](./frontend/src/lib/types.ts) 加 `MergeSuggestionResponse` 类型，与后端 schema 对齐。
6. 在 [frontend/src/components/graph/NodeDetailCard.tsx](./frontend/src/components/graph/NodeDetailCard.tsx) 加"合并建议"按钮，触发后弹列表让用户确认。
7. 在 [frontend/src/store/useAppStore.ts](./frontend/src/store/useAppStore.ts) 加 `suggestMerge` action + `mergeSuggestions` 状态。

**验证**：选中一个节点 → 点"合并建议"按钮 → 看到候选合并节点列表 → 确认后调用 `nodes.batch` 接口合并 → 图谱视图刷新。

### 任务 3：新增一个流式 LLM 端点（如"节点对比"）

**场景**：希望对比两个节点的异同，结果流式输出。

**步骤**：
1. 在 [backend/app/services/graph_agent.py](./backend/app/services/graph_agent.py) 加 `async def compare_nodes_stream(graph_id, node_a_id, node_b_id, session_id) -> AsyncGenerator[str, None]`：构造 prompt → `LLMClient.chat_stream` → 每个 token `yield` 同时 `await notify_session(session_id, {"type": "graph_agent_token", "op": "compare", "delta": token, ...})`。
2. 在 [backend/app/routers/stream.py](./backend/app/routers/stream.py) 加 `POST /api/graphs/{id}/nodes/compare-stream` 路由，接收 `{node_a_id, node_b_id, session_id}` → 立即返回 `StreamStartedResponse { request_id }` → 后台 asyncio.create_task 跑 `graph_agent.compare_nodes_stream`。
3. 在 [backend/app/services/llm_request_registry.py](./backend/app/services/llm_request_registry.py) 注册 request_id 用于取消。
4. 在 [frontend/src/lib/api.ts](./frontend/src/lib/api.ts) 加 `compareNodesStream(graphId, nodeIdA, nodeIdB, sessionId)`。
5. 在 [frontend/src/store/useAppStore.ts](./frontend/src/store/useAppStore.ts) 加 `compareStreamingText` 状态 + `handleGraphAgentToken(event)` 中按 `op === 'compare'` 分发。
6. 在 [frontend/src/components/graph/](./frontend/src/components/graph/) 新建 `ComparePanel.tsx`，订阅 `compareStreamingText` 渲染打字机效果。
7. 在 [frontend/src/App.tsx](./frontend/src/App.tsx) 渲染 `<ComparePanel />` 浮层。

**验证**：选中两个节点 → 右键"对比" → 弹出 ComparePanel → 文本逐字流出 → 完成后可关闭。

### 任务 4：扩展插件推送契约（新增 metadata 字段）

**场景**：希望插件推送时携带"用户标签"字段，前端在待抽取列表显示。

**步骤**：
1. 在 [backend/app/models/schemas.py](./backend/app/models/schemas.py) 的 `PluginConversationRequest.metadata` 字段说明中加 `user_tags` 子字段（仍是 `dict` 不强约束，但文档化）。
2. 在 [backend/app/routers/plugin.py](./backend/app/routers/plugin.py) 的 `POST /api/plugin/conversations` 实现中，把 `metadata.user_tags` 原样存入 `observations.metadata_json`（无需特殊处理，已透明序列化）。
3. 在 [backend/app/services/graph_agent.py](./backend/app/services/graph_agent.py) 的 `extract_candidates_from_observation` 中，把 `user_tags` 加入 prompt 上下文（如"用户已标注此对话为：xxx"）。
4. 在 [frontend/src/components/graph/PendingNodes.tsx](./frontend/src/components/graph/PendingNodes.tsx) 的待抽取列表项中显示 `metadata.user_tags`（如有）。
5. 同步更新 [plugin-sdk/kwa-push.d.ts](./plugin-sdk/kwa-push.d.ts) 的 `metadata` 类型注释。
6. 同步更新 [plugin-sdk/README.md](./plugin-sdk/README.md) 的"请求字段说明"表。

**验证**：用 [plugin-sdk/kwa-push.js](./plugin-sdk/kwa-push.js) 推送一条带 `user_tags` 的对话 → 后端落库 → 前端待抽取列表显示标签 → 抽取候选节点时 prompt 含标签。

### 任务 5：调整 Work 模式风口推荐算法

**场景**：Work 模式风口推荐结果不理想，想调整权重。

**步骤**：
1. 在 [backend/app/routers/recommendations.py](./backend/app/routers/recommendations.py) 找到 Work 模式推荐分计算逻辑（`mode='work'` 分支）。
2. 调整权重因子：`mention_count` / `last_reviewed_at` / `remind_at` / `is_starred` / `confidence` 等。
3. 在 [frontend/src/components/graph/TrendsSidebar.tsx](./frontend/src/components/graph/TrendsSidebar.tsx) 看是否需要同步 UI 变化（如显示推荐理由）。
4. 跑种子脚本注入 Work 图谱，前端切到 Work 模式查看 TrendsSidebar。

**验证**：TrendsSidebar 中推荐项的顺序与分数符合预期；点击推荐项能跳到对应节点。

## 扩展点

### 后端服务层扩展

- `services/` 目录新增模块时遵循既有风格：模块顶部 docstring 说明职责 → `from __future__ import annotations` → 类型注解 → `logger = logging.getLogger(__name__)` → 业务函数。
- 需要持有全局状态（如 `graph_store` / `llm_request_registry`）的 service 用模块级单例（`graph_store = GraphStore()`），便于 router 通过 `Depends(get_xxx_store)` 注入。
- LLM 调用必须经 `llm_factory.get_llm_client()` 获取客户端（凭据从 settings 表读取，加密存储），不要直接 `import openai`。

### 前端组件扩展

- 新组件放 `components/`（图谱相关放 `components/graph/`），用 `function XxxYyy()` 声明，导出 `export function XxxYyy()` 或 `export default function XxxYyy()`。
- 需要全局状态时通过 `useAppStore((s) => s.xxx)` 订阅切片，不要用 Context / prop drilling。
- 需要触发后端调用时调 `api.xxx()`，错误由 store 的 action 捕获并写 `error` 状态，组件层据此显示。
- 浮层面板（PendingNodes / QuizPanel / WorkInput / TrendsSidebar / ReportPanel / QAPanel）参考既有模式：组件内 `if (!panelOpen) return null` 控制显隐，store 中 `xxxPanelOpen` 状态 + `setXxxPanelOpen` action。

### 插件对接扩展

- 新增推送字段：参考"任务 4"流程，同步改 schemas / plugin router / graph_agent prompt / 前端 PendingNodes / plugin-sdk 类型与文档。
- 新增推送来源（如桌面客户端直接推送）：在 `routers/plugin.py` 加新端点或在现有端点用 `metadata.source` 区分；`observations.source` 字段保留 `plugin / import / manual` 三种取值。
- 新增幂等去重维度：当前用 `{platform}:{conversation_id}` 24h 去重，可扩展为支持自定义 `dedup_key` 字段（在 `metadata` 中传，后端覆盖默认计算）。

### 二次开发 patch 扩展

- `plugin-sdk/secondary-dev/` 下的 patch 文件**只改副本，不动原 collector**。
- 新增 patch 文件需在 `PATCH-GUIDE.md` 加应用步骤。
- patch 文件命名：`<功能>.patch.<ext>`（如 `kwa-push-handler.js` / `settings.patch.html` / `styles.patch.js`）。

## 注意事项（坑）

### 端口隔离约定

- 后端固定 **8788**、前端固定 **5174**，与本地可能的参考素材项目（8787 / 5173）相互隔离。
- **改端口需同步改 4 处**：`backend/app/config.py`（`backend_port` + `cors_origins`）+ `backend/.env.example` + `frontend/vite.config.ts`（`server.port` + `proxy.target`）+ `frontend/electron/launcher.ts`（`DEFAULT_BACKEND_PORT`），否则 dev / 生产 / 代理 / IPC 任一环失配都会让前端连不上后端。

### SQLite + FTS5

- 数据库 `backend/data/app.db` 是 SQLite，FTS5 扩展用于全文检索（`messages_fts` / `observations_fts` 等）。
- 部分 SQLite 编译版本不含 FTS5（罕见），`init_db` 会捕获异常并跳过，仅记录日志，不阻断启动。
- 开发期改 ORM 模型后，需 `rm backend/data/app.db` 重启（`create_all` 不会改已存在的表）；`migrate_node_columns` 是幂等的 ADD COLUMN 迁移，旧库启动不报错但只能加列不能改/删列。
- 生产环境应改用 Alembic 迁移管理 schema 演进（当前未配置）。

### LLM 凭据管理

- 开发期：`backend/.env` 的 `LLM_API_KEY`（明文，仅 dev 用）。
- 生产 / 用户配置：前端 SettingsPanel 保存到后端 `settings` 表（`llm.api_key` 加密为 Fernet 密文存储），由 `llm_factory.get_llm_client()` 解密读取。
- `APP_ENCRYPTION_KEY` 留空时由 `services/crypto.py` 自动生成并落盘到 `data/.encryption_key`，**该文件丢失则历史加密字段无法解密**，需重新配置 LLM 凭据。

### 流式 LLM 任务的取消

- 前端触发 `xx-stream` 端点后立即拿到 `request_id`，可在 store 中调 `api.cancelLlmRequest(request_id)` 取消。
- 后端 `llm_request_registry` 持有 `asyncio.Task` 引用，取消时 `task.cancel()` 并抛 `CancelledError`，`graph_agent` 的流式方法捕获后通过 WebSocket 推 `graph_agent_cancelled` 事件。
- 前端收到 `graph_agent_cancelled` 后保留已生成部分文本并弹 Toast 提示"已取消"。

### WebSocket 连接失败时降级

- `App.tsx` 启动时连 `/ws?session_id=...`，连接失败时静默降级（不弹错误）。
- 流式 LLM 动作（detail-stream / ask-stream / report-stream）在 `sessionId` 为 null 时**自动回退到非流式接口**（`/api/graphs/{id}/nodes/{nid}/detail` 等同步接口，store 内已判断），用户仍能拿到结果但没有打字机效果。

### 推送链路的鉴权风险

- `POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，仅适用于本机 loopback（`127.0.0.1:8788`）。
- 若将后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必自行在反向代理层加 token / Origin 白名单 / IP 限制。详见 [plugin-sdk/README.md](./plugin-sdk/README.md) 的"风险提示"。

### Electron 主进程与渲染进程的隔离

- `contextIsolation: true` + `nodeIntegration: false`：渲染进程不能直接 `require`，必须经 `preload.ts` 的 `contextBridge.exposeInMainWorld` 暴露。
- 当前 `electronAPI` 只暴露 `backend.getUrl()` / `backend.getWsUrl()` 两个同步方法；如需新增 IPC（如文件保存对话框），需在 `main.ts` 的 `registerIpcHandlers` 加 handler，并在 `preload.ts` 暴露对应方法。
- 同步 IPC 用 `ipcMain.on` + `event.returnValue = ...`（preload 用 `ipcRenderer.sendSync`）；异步 IPC 用 `ipcMain.handle` + `ipcRenderer.invoke`。

### 32 位十六进制 ID 不能含连字符

- 本项目所有主键 ID 用 `uuid.uuid4().hex`（32 位十六进制无连字符），与 `frontend/src/lib/ws.ts` 的 `generateSessionId` 保持一致。
- 不要混用 `str(uuid.uuid4())`（带连字符的 36 位格式），会导致前端 `Node.id` 字段类型校验失败。

### 推送 SDK 的 camelCase ↔ snake_case 转换

- `plugin-sdk/kwa-push.js` 对外暴露 camelCase（`conversationMarkdown`），发送到后端时自动转为 snake_case（`conversation_markdown`）。
- 后端 `PluginConversationRequest` schema 用 snake_case，与 SDK 转换后字段对齐。
- 在 `metadata` 内的字段不做转换，原样存入 `observations.metadata_json`，前端按需读取。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改后端 API / 图谱服务 | [backend/DEVELOPMENT.md](./backend/DEVELOPMENT.md) |
| 要改 ORM 模型 / Pydantic schema | [backend/app/models/DEVELOPMENT.md](./backend/app/models/DEVELOPMENT.md) |
| 要改路由 / 新增 API 端点 | [backend/app/routers/DEVELOPMENT.md](./backend/app/routers/DEVELOPMENT.md) |
| 要改服务层 / graph_agent / LLM 调用 | [backend/app/services/DEVELOPMENT.md](./backend/app/services/DEVELOPMENT.md) |
| 要改前端组件 / 图谱可视化 | [frontend/DEVELOPMENT.md](./frontend/DEVELOPMENT.md) |
| 要改 Electron 主进程 / 打包 | [frontend/electron/DEVELOPMENT.md](./frontend/electron/DEVELOPMENT.md) |
| 要改前端 React 组件 / 状态 | [frontend/src/DEVELOPMENT.md](./frontend/src/DEVELOPMENT.md) |
| 要做插件 → 软件推送对接 | [plugin-sdk/DEVELOPMENT.md](./plugin-sdk/DEVELOPMENT.md) |
| 要看高层项目约束 | 工作区根 [DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要看项目骨架说明 | [README.md](./README.md) |

# 对话回声 · 桌面端（echolog desktop）

双模式（Study / Work）知识图谱桌面软件：接收浏览器插件采集的 AI 对话，由 Agent 自动抽取知识点并沉淀为可问答、可测验、可辅助工作的知识图谱。

- **前端**：Electron + React + TypeScript + Vite（开发端口 `5174`）
- **后端**：Python 3.12 + FastAPI + SQLAlchemy（异步）+ aiosqlite + FTS5（监听端口 `8788`）

> 本软件是 [ai-chat-collector-pro](../README.md) 工作区的「软件侧」，与插件侧 [web-ai-chat-collector](../web-ai-chat-collector) 通过 `POST /api/plugin/conversations` 接口形成「采集 → 沉淀 → 抽取 → 图谱化」的数据闭环。后端基础服务由前期项目骨架适配而来，端口与数据目录已隔离（后端 `8788` / 前端 `5174` / 数据 `backend/data/`）。

## 功能特性

### Study 模式（学习）

- **图谱可视化** —— 无向图渲染，节点为小卡片（常显标题 + 一句话概括 + 类型标签）；支持拖拽 / 缩放 / 平移；孤立节点独立显示；延伸生成的灰色节点标记清晰。
- **双视图** —— 图谱视图与卡片视图并列切换，数据同步无丢失。
- **悬停详情卡** —— 悬停 300–500ms 显示五区域详情卡（标题 / 概括 / 重要点 / 延伸推荐 / 我的补充）；已覆盖 11 个学科模板（语文 / 数学 / 英语 / 历史 / 地理 / 政治 / 生物 / 化学 / 物理 / 编程 / 大模型），未命中走通用兜底，可手动切换类型并记忆。
- **节点延伸** —— 双击生成全部延伸（新节点标灰建边），单击推荐方向仅生成该方向一个节点；已存在节点不重复生成（高亮已有）；全部延伸支持撤销。
- **节点编辑删除** —— 可编辑标题 / 概括 / 类型 / 详情字段；删除节点并清理相关边；用户留白可保存为疑问 / 联想 / 考点 / 易错点 / 笔记，可选生成延伸节点。
- **对话抽取** —— Agent 从插件推送的对话抽取候选知识点（带类型初判、归一去重），待确认节点列表，用户确认后入图。
- **测验** —— 生成选择题（单选 / 多选）与费曼解释题；选择题即时判分给解析，费曼题 Agent 语义判分给理解度评分与反馈；结果记录并关联节点。

### Work 模式（工作）

- **工作图谱** —— 工作对象按子类型建模（线索 / 关键人 / 承诺 / 期望 / 事件 / 决策 / 风险 / 资料 / 偏好 / 复盘）；Agent 抽取归一去重建关系；节点详情卡含置信度与来源依据。
- **风口推荐** —— 侧栏按时间线展示风口推荐卡片，含可解释理由；「加入图谱」一键转为 Work 图谱节点，可继续延伸。
- **工作报告** —— 生成 Markdown 报告（进展 / 计划 / 风险 / 承诺跟进）；可导出 `.docx`；HTML 预览可打印为 PDF。
- **对话提问** —— Work 模式对话式提问入口，Agent 基于工作图谱上下文回答，标注来源与置信度。

### 通用

- **双模式切换** —— 右上角 Study / Work 开关带过渡动画，切换后仅显示对应类型图谱，study 与 work 图谱互不互通。
- **图谱管理** —— 可新建图谱并绑定类型，支持切换 / 重命名 / 删除，数据隔离。
- **新手引导** —— 首次启动自动创建 study + work 引导种子图谱；OnboardingWizard 引导配置 LLM。
- **Agent 集成** —— `main_agent` / `writer_agent` / `graph_agent` 承载节点抽取 / 延伸 / 出题判分 / 风口 / 报告 / 提问；WebSocket 推送 Agent 流式输出与图谱变更。
- **本地 API 鉴权** —— 所有 `/api/` 请求需携带 `x-local-api-token`（或插件配对凭证），见下文「鉴权」。

## 目录结构

```
knowledge-work-assistant/
├── backend/                          # Python FastAPI 后端
│   ├── app/
│   │   ├── __init__.py               # __version__
│   │   ├── main.py                   # FastAPI 应用入口（端口 8788，14 个业务路由）
│   │   ├── config.py                 # pydantic-settings 配置
│   │   ├── db.py                     # SQLAlchemy 异步引擎 + FTS5 虚拟表
│   │   ├── models/                   # ORM 模型 + Pydantic schema + 节点类型
│   │   ├── routers/                  # 业务路由
│   │   │   ├── health.py             # GET /api/health
│   │   │   ├── auth.py               # /api/auth/ws-token（WS 短期 token + token 校验依赖）
│   │   │   ├── graphs.py             # 图谱管理（新建 / 切换 / 重命名 / 删除）
│   │   │   ├── nodes.py              # 节点详情与留白
│   │   │   ├── extensions.py         # 节点延伸与撤销
│   │   │   ├── extraction.py         # Study 对话抽取（待确认 → 入图）
│   │   │   ├── quiz.py               # Study 测验（生成 / 判分）
│   │   │   ├── work.py               # Work 抽取入图 / 风口 / 报告 / 提问
│   │   │   ├── recommendations.py    # 智能推荐（按模式打分排序）
│   │   │   ├── stream.py             # 流式触发（详情卡 / 问答 / 报告）
│   │   │   ├── chat.py               # 多轮对话（main_agent + 高风险拦截 + WS 推送）
│   │   │   ├── llm_admin.py          # LLM 请求队列与配置管理
│   │   │   ├── data_management.py    # 导出备份 / 批量清空
│   │   │   ├── plugin.py             # 浏览器插件对接（见下文）
│   │   │   └── ws.py                 # WebSocket /ws
│   │   └── services/                 # 业务服务层
│   │       ├── graph_store.py        # 图谱存储（节点 / 边 / Observation）
│   │       ├── graph_agent.py        # 节点抽取 / 延伸 / 出题判分
│   │       ├── main_agent.py         # 多轮对话主循环 + Function Calling + 工具白名单
│   │       ├── writer_agent.py       # 报告生成
│   │       ├── context_manager.py    # 上下文管理
│   │       ├── compaction.py         # 上下文压缩
│   │       ├── tool_registry.py      # 工具注册与高风险拦截
│   │       ├── llm_client.py         # OpenAI 兼容 LLM 客户端（流式 + 重试）
│   │       ├── llm_factory.py        # 从 settings 表构造 LLMClient
│   │       ├── model_config.py       # model_config.json 注册表
│   │       ├── tag_store.py          # 标签库 + 标签 RAG 三路检索
│   │       ├── knowledge_store.py    # 知识库检索（委托 tag_store）
│   │       ├── file_storage.py       # 原文件本地存储
│   │       ├── crypto.py             # Fernet 敏感字段加密
│   │       ├── settings_store.py     # Settings 表读写（含加密字段）
│   │       ├── ws_notify.py          # WS 连接注册表 + 事件推送
│   │       ├── session_queue.py      # 会话级消息等待队列
│   │       ├── onboarding_seed.py    # 首次启动引导种子图谱
│   │       └── task_registry.py      # 后台任务生命周期
│   ├── tests/                        # pytest 测试（含 e2e）
│   ├── .env.example
│   ├── .python-version               # 3.12
│   └── pyproject.toml                # 依赖声明（uv 管理）
└── frontend/                         # Electron + React 前端
    ├── electron/                     # 主进程 / preload / launcher
    ├── src/
    │   ├── App.tsx                   # 根组件
    │   ├── components/               # ChatPanel / OnboardingWizard / SettingsPanel /
    │   │                             # GraphList / ImportConversationsModal / ToolConfirmDialog /
    │   │                             # graph/（图谱可视化与节点编辑）...
    │   ├── store/useAppStore.ts      # Zustand 全局状态
    │   ├── lib/                      # api / ws / types / markdown / motion / nodeTemplates / importers
    │   ├── hooks/
    │   └── styles/
    ├── vite.config.ts                # 端口 5174，代理 /api、/ws 到 8788
    └── package.json
```

## 环境要求

- **Node.js**：≥ 18（推荐 20+），用于前端与 Electron
- **pnpm**：≥ 9（前端包管理器）
- **Python**：3.12（后端运行时，由 `.python-version` 锁定）
- **uv**：≥ 0.4（Python 包管理器，[安装指南](https://docs.astral.sh/uv/)）
- 操作系统：Windows / macOS / Linux（在 Windows 上验证）

## 快速开始

### 1. 启动后端

```bash
cd knowledge-work-assistant/backend

# 复制环境变量模板（按需修改 LLM_API_KEY / LOCAL_API_TOKEN 等）
cp .env.example .env

# 安装 Python 依赖（uv 会自动创建 .venv 并锁定依赖）
uv sync

# 启动后端（监听 8788 端口，热重载）
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8788
```

启动后访问 <http://127.0.0.1:8788/api/health>（需带 `x-local-api-token` 头），应返回：

```json
{"status":"ok","service":"knowledge-work-assistant-backend","version":"1.0.0"}
```

### 2. 启动前端

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

打开应用后：首次启动会自动创建 study + work 引导种子图谱，并通过 OnboardingWizard 引导配置 LLM；随后即可在图谱视图新建 / 切换图谱、查看节点详情卡、延伸节点、做测验或生成工作报告。

### 3. 联调：插件 → 软件 推送链路

1. 软件侧后端先启动（监听 8788）。
2. 加载插件，在 popup 设置页「本地应用对接」分区勾选「启用对接」，点「连通性测试」确认后端可达。
3. 在任一受支持的 AI 平台发起一次对话 → 插件采集保存 → 推送到 `http://127.0.0.1:8788/api/plugin/conversations` → 软件侧前端收到 WebSocket 事件 `plugin.conversation_received` 并弹 Toast。
4. 在 Study 模式图谱视图打开「待抽取」侧栏，确认 Observation 进入候选列表 → 确认入图。

## 通信链路

### HTTP（`/api/*`）

- 开发环境（Vite dev server 5174）：前端用相对路径 `/api/...`，由 `vite.config.ts` 的 `server.proxy` 转发到 `http://127.0.0.1:8788`
- 生产环境（Electron `file://` 加载打包产物）：前端通过 `window.electronAPI.backend.getUrl()` 获取后端基地址，由 `electron/launcher.ts` 启动后端子进程

### WebSocket（`/ws`）

- 开发环境：`ws://localhost:5174/ws`，由 Vite 代理转发到 `ws://127.0.0.1:8788/ws`
- 生产环境：`ws://127.0.0.1:8788/ws`，通过 `window.electronAPI.backend.getWsUrl()` 获取
- `/ws` 承载 Agent 流式输出、图谱变更推送、`plugin.conversation_received` 事件等业务消息

## 鉴权

后端在 `/api/` 前缀上启用 `enforce_request_limits_and_cache_policy` 中间件，所有 `/api/` 请求必须满足以下任一条件，否则返回 `401 invalid local API token`：

1. 携带 `x-local-api-token` 头，值等于 `LOCAL_API_TOKEN`（前后端共享，统一来源）；
2. 携带 `x-plugin-credential` 头（插件配对后获得的凭证，见下文）；
3. 请求路径为 `/api/plugin/pair`（插件配对端点本身豁免）。

中间件同时限制请求体大小（默认 16 MB，超出返回 `413`）并对所有响应加 `Cache-Control: no-store`。

### `LOCAL_API_TOKEN` 的两处前端来源

- **纯浏览器 dev（`pnpm dev`）**：Vite 启动时经 `loadEnv` 读取并 `define` 注入渲染进程；
- **Electron（`dev:electron` / 生产）**：`launcher` 解析 `.env` 后经 preload 桥下发。

修改 `LOCAL_API_TOKEN` 后需同步重启前后端。生产环境建议改为高强度随机值，且不要把 `.env` 随安装包发布。

## 配置说明

### 后端环境变量（`backend/.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | 运行环境标记 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API base URL |
| `LLM_API_KEY` | （空） | LLM API Key（明文，仅 dev；生产改用 settings 表加密存储） |
| `LLM_MODEL` | `gpt-4o-mini` | 默认对话模型 |
| `LLM_CONTEXT_WINDOW` | `128000` | 上下文窗口（仅 ContextManager 决策用） |
| `DATA_DIR` | `./data` | 数据目录（SQLite、上传文件、加密 key） |
| `DATABASE_URL` | `sqlite+aiosqlite:///./data/app.db` | SQLite 连接字符串 |
| `APP_ENCRYPTION_KEY` | （空，自动生成） | Fernet 加密 key；留空时自动生成并落盘到 `data/.encryption_key` |
| `CORS_ORIGINS` | `["http://localhost:5174","file://"]` | CORS 允许来源（JSON 数组） |
| `BACKEND_PORT` | `8788` | 后端监听端口（仅 `python -m app.main` 直接启动时使用） |
| `LOCAL_API_TOKEN` | `kwa-development-token` | 本地 API 鉴权 token（见「鉴权」） |

### 前端配置

- `vite.config.ts`：`server.port = 5174`，`server.proxy` 转发 `/api`、`/ws` 到 `127.0.0.1:8788`
- `electron/launcher.ts`：`DEFAULT_BACKEND_PORT = 8788`，生产环境 spawn 后端子进程
- `src/lib/api.ts` / `src/lib/ws.ts`：兜底地址 `http://127.0.0.1:8788` / `ws://127.0.0.1:8788`

## 浏览器插件对接接口

为浏览器扩展（如 `web-ai-chat-collector`）提供对话推送接口，把采集到的 AI 对话沉淀为后端 `Observation` 原始记录，待用户在「待抽取」侧栏确认后由 `graph_agent` 抽取知识点入图。

> **鉴权**：插件需先通过 `POST /api/plugin/pair` 配对获得 `X-Plugin-Credential` 凭证，后续请求携带该头；或直接携带 `x-local-api-token`。`/api/plugin/pair` 本身豁免鉴权。

### 端点一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/plugin/pair` | 配对：提交配对码，返回插件凭证 |
| `POST` | `/api/plugin/conversations` | 接收插件推送的一段对话，持久化为 `Observation` |
| `GET` | `/api/plugin/contract` | 返回接口契约的结构化 JSON 文档 |
| `GET` | `/api/plugin/conversations/recent` | 返回最近 N 条 `source='plugin'` 的记录 |
| `GET` | `/api/plugin/health` | 联调自检（版本 / 平台 / 队列规模） |

### `POST /api/plugin/conversations` 契约

**请求体**（JSON）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 来源平台标识，必须命中白名单：`chatgpt` / `claude` / `gemini` / `deepseek` / `qwen` / `doubao` / `kimi` / `fudan` / `yuanbao` / `custom` |
| `timestamp` | string | 是 | 对话发生时间，ISO8601 格式；解析失败时 `occurred_at` 为空，不阻断接收 |
| `conversation_markdown` | string | 是 | 对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料 |
| `metadata` | object | 否 | 可选附加元数据；`title` / `url` / `model` 若提供必须为 string，否则 422 |

**响应**（JSON，200）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `received` | boolean | 是否已接收，固定为 `true` |
| `observation_id` | string | 持久化后的观察记录 ID（32 位十六进制） |
| `deduplicated` | boolean | 命中幂等去重时为 `true`（不写新记录、不广播） |

**错误码**：

| 状态码 | 含义 |
| --- | --- |
| 401 | 未携带有效 `x-local-api-token` 或 `x-plugin-credential` |
| 400 | 业务校验失败（如非法 `platform`） |
| 413 | 请求体超过 16 MB |
| 422 | 请求体不符合契约（字段缺失 / 类型错误 / 空字符串） |

**请求示例**：

```json
{
  "platform": "deepseek",
  "timestamp": "2025-01-01T12:00:00+08:00",
  "conversation_markdown": "## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是一种用图结构组织知识的方式……",
  "metadata": {
    "title": "什么是知识图谱",
    "url": "https://chat.deepseek.com/c/abc123",
    "model": "deepseek-chat",
    "conversation_id": "abc123"
  }
}
```

**响应示例**：

```json
{
  "received": true,
  "observation_id": "9f1c2a3b4d5e6f7a8b9c0d1e2f3a4b5c"
}
```

### 对接注意事项

1. **幂等去重**：若 `metadata.conversation_id` 存在，组合 `{platform}:{conversation_id}` 作为 `dedup_key`，查最近 24h 是否已落库；命中则返回 `deduplicated: true`，不写新记录、不广播。
2. **不自动抽取**：接收对话仅持久化为 `Observation`，**不触发节点抽取**。抽取由用户在 Study 模式「待抽取」侧栏确认后，经 `/api/observations`、`/api/graphs/{id}/nodes/batch` 由 `graph_agent` 完成。
3. **WebSocket 广播**：成功落库后向所有前端连接推送 `plugin.conversation_received` 事件，供前端 Toast / 刷新列表。
4. **数据流向**：`POST /api/plugin/conversations` → `observations` 表（`source='plugin'`）→ 用户确认抽取 → `nodes` / `edges` → 图谱可视化。
5. **格式参考**：`conversation_markdown` 建议参考 `web-ai-chat-collector` 的导出格式（`## 用户` / `## 助手` 分段），便于 Agent 解析角色与内容。
6. **部署风险**：插件对接面向本机回环（`127.0.0.1:8788`）。若将后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请把 `LOCAL_API_TOKEN` 改为高强度随机值，并在反向代理层加 Origin 白名单 / IP 限制。

## 测试

```bash
cd knowledge-work-assistant/backend
uv run pytest
```

前端：

```bash
cd knowledge-work-assistant/frontend
pnpm test          # vitest run
```

## 打包

```bash
cd knowledge-work-assistant/frontend
pnpm dist          # tsc + vite build + electron-builder --win（NSIS 安装包）
```

## 许可证

MIT —— 见工作区根 [LICENSE](../LICENSE)。

## 更多文档

- 工作区总览：[../README.md](../README.md)
- 工作区开发指南：[../DEVELOPMENT.md](../DEVELOPMENT.md)
- 后端开发细节：[backend/DEVELOPMENT.md](./backend/DEVELOPMENT.md)
- 前端开发细节：[frontend/DEVELOPMENT.md](./frontend/DEVELOPMENT.md)
- 整体设计：[../设计方案.md](../设计方案.md)

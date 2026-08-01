# 知识工作助手（Knowledge Work Assistant）

双模式（Study / Work）知识图谱软件的工程骨架。

- **前端**：Electron + React + TypeScript + Vite（开发端口 `5174`）
- **后端**：Python 3.12 + FastAPI + SQLAlchemy（异步）+ aiosqlite（监听端口 `8788`）

骨架与关键服务模块从「步影」项目适配拷贝而来，端口与数据目录已隔离：

| 项目 | 后端端口 | 前端端口 | 数据目录 |
| --- | --- | --- | --- |
| 步影 | `8787` | `5173` | `步影/backend/data/` |
| 知识工作助手 | `8788` | `5174` | `knowledge-work-assistant/backend/data/` |

## 目录结构

```
knowledge-work-assistant/
├── backend/                          # Python FastAPI 后端
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                   # FastAPI 应用入口（端口 8788）
│   │   ├── config.py                 # pydantic-settings 配置
│   │   ├── db.py                     # SQLAlchemy 异步引擎 + FTS5 虚拟表
│   │   ├── models/
│   │   │   ├── db_models.py          # ORM 模型（Session/Message/FileMetadata/Tag/...）
│   │   │   └── schemas.py             # Pydantic API schema
│   │   ├── routers/
│   │   │   ├── health.py             # GET /api/health
│   │   │   └── ws.py                 # WebSocket /ws（联调测试通道）
│   │   └── services/                 # 业务服务层（从步影适配拷贝）
│   │       ├── crypto.py             # Fernet 敏感字段加密
│   │       ├── llm_client.py         # OpenAI 兼容 LLM 客户端（流式/重试）
│   │       ├── llm_errors.py         # LLM 异常体系
│   │       ├── llm_factory.py        # 从 settings 表构造 LLMClient
│   │       ├── model_config.py       # model_config.json 注册表
│   │       ├── settings_store.py     # Settings 表读写（含加密字段）
│   │       ├── ws_notify.py          # WS 连接注册表 + 事件推送
│   │       ├── session_queue.py      # 会话级消息等待队列
│   │       ├── tag_store.py          # 标签库 + 标签 RAG 三路检索
│   │       ├── knowledge_store.py    # 知识库检索（委托 tag_store）
│   │       ├── file_storage.py       # 原文件本地存储
│   │       └── sub_agent.py          # 任务型子 Agent + 生命周期管理
│   ├── .env.example
│   ├── .gitignore
│   ├── .python-version               # 3.12
│   └── pyproject.toml                # 依赖声明（uv 管理）
└── frontend/                         # Electron + React 前端
    ├── electron/
    │   ├── main.ts                  # 主进程入口
    │   ├── preload.ts               # contextBridge 桥（backend URL）
    │   ├── launcher.ts              # 后端进程启动器（生产环境）
    │   ├── tsconfig.json
    │   └── package.json             # type: commonjs
    ├── src/
    │   ├── main.tsx                 # React 入口
    │   ├── App.tsx                  # 联调根组件（health 检查 + WS 测试）
    │   ├── lib/
    │   │   ├── api.ts               # HTTP 客户端（/api 前缀）
    │   │   ├── ws.ts                # WebSocket 客户端（/ws）
    │   │   ├── types.ts             # 与 schemas.py 对齐的类型
    │   │   └── electron.d.ts        # window.electronAPI 全局类型
    │   └── styles/animations.css
    ├── index.html
    ├── package.json
    ├── vite.config.ts               # 端口 5174，代理 /api、/ws 到 8788
    ├── tsconfig.json
    ├── .eslintrc.cjs
    ├── pnpm-workspace.yaml
    └── .gitignore
```

## 环境要求

- **Node.js**：≥ 18（推荐 20+），用于前端与 Electron
- **pnpm**：≥ 9（前端包管理器）
- **Python**：3.12（后端运行时）
- **uv**：≥ 0.4（Python 包管理器，[安装指南](https://docs.astral.sh/uv/)）
- 操作系统：Windows / macOS / Linux（骨架在 Windows 上验证）

## 快速开始

### 1. 启动后端

```bash
cd knowledge-work-assistant/backend

# 复制环境变量模板（按需修改 LLM_API_KEY 等）
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

打开应用后应看到「知识工作助手 · 骨架联调」界面：

- **后端健康检查**卡片：绿色圆点表示 `/api/health` 200，红色表示后端未就绪
- **WebSocket 收发测试**卡片：点击「连接」后端推送 `welcome`，点「发送 ping」收到 `pong`
- **运行环境**卡片：显示 Electron / 浏览器、file:// / http(s):// 等信息

## 通信链路

### HTTP（`/api/*`）

- 开发环境（Vite dev server 5174）：前端用相对路径 `/api/health`，由
  `vite.config.ts` 的 `server.proxy` 转发到 `http://127.0.0.1:8788`
- 生产环境（Electron `file://` 加载打包产物）：前端通过 `window.electronAPI.backend.getUrl()`
  获取后端基地址（`http://127.0.0.1:8788`），由 `electron/launcher.ts` 启动后端子进程

### WebSocket（`/ws`）

- 开发环境：`ws://localhost:5174/ws`，由 Vite 代理转发到 `ws://127.0.0.1:8788/ws`
- 生产环境：`ws://127.0.0.1:8788/ws`，通过 `window.electronAPI.backend.getWsUrl()` 获取

当前 `/ws` 仅为联调测试通道，后续业务 WebSocket（流式对话等）会在
`backend/app/routers/` 下扩展，前端在 `frontend/src/lib/ws.ts` 同步扩展。

## 配置说明

### 后端环境变量（`backend/.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | 运行环境标记 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API base URL |
| `LLM_API_KEY` | （空） | LLM API Key（明文，仅 dev；生产改用 settings 表加密存储） |
| `LLM_MODEL` | `gpt-4o-mini` | 默认对话模型 |
| `LLM_CONTEXT_WINDOW` | `128000` | 上下文窗口（仅 ContextManager 决策用，不下发 Ollama） |
| `DATA_DIR` | `./data` | 数据目录（SQLite、上传文件、加密 key） |
| `DATABASE_URL` | `sqlite+aiosqlite:///./data/app.db` | SQLite 连接字符串 |
| `APP_ENCRYPTION_KEY` | （空，自动生成） | Fernet 加密 key；留空时自动生成并落盘到 `data/.encryption_key` |
| `CORS_ORIGINS` | `["http://localhost:5174","file://"]` | CORS 允许来源（JSON 数组） |
| `BACKEND_PORT` | `8788` | 后端监听端口（仅 `python -m app.main` 直接启动时使用） |

### 前端配置

- `vite.config.ts`：`server.port = 5174`，`server.proxy` 转发 `/api`、`/ws` 到 `127.0.0.1:8788`
- `electron/launcher.ts`：`DEFAULT_BACKEND_PORT = 8788`，生产环境 spawn `python -m uvicorn`
- `src/lib/api.ts` / `src/lib/ws.ts`：兜底地址 `http://127.0.0.1:8788` / `ws://127.0.0.1:8788`

## 服务模块就位状态

以下 services 模块已从步影适配拷贝并可在本项目独立运行：

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| `crypto` | 已就位 | Fernet 加密（敏感字段存储） |
| `llm_errors` | 已就位 | LLM 异常体系 |
| `llm_client` | 已就位 | OpenAI 兼容客户端（流式 + 重试） |
| `model_config` | 已就位 | `model_config.json` 注册表 |
| `settings_store` | 已就位 | Settings 表读写（含加密字段） |
| `ws_notify` | 已就位 | WS 连接注册表 + 事件推送 |
| `session_queue` | 已就位 | 会话级消息等待队列 |
| `tag_store` | 已就位 | 标签库 + 标签 RAG 三路检索 |
| `knowledge_store` | 已就位 | 知识库检索（委托 tag_store） |
| `file_storage` | 已就位 | 原文件本地存储 |
| `llm_factory` | 已就位 | 从 settings 表构造 LLMClient |
| `sub_agent` | 已就位 | 任务型子 Agent + 生命周期管理 |
| `main_agent` | 已就位 | 多轮对话主循环 + Function Calling + Plan/Build 工具白名单 + 高风险工具拦截 + Study/Work 双模式；依赖已全部移植 |

`main_agent` 已接入 `routers/chat.py`，由 `ChatService` 在多轮对话流式输出 / 工具调用阶段调用；不再需要"不能被直接 import"的保护。

## 后续路线

参见 `.trae/specs/build-knowledge-work-assistant/tasks.md`：

- **Task 2**：图谱数据模型与存储层（Graph / Node / Edge / Observation / Quiz）
- **Task 3**：Study / Work 模式切换开关
- **Task 4**：图谱管理（新建与隔离）
- **Task 5**：图谱可视化（无向图 + 节点小卡片）
- **Task 6–9**：双视图、悬停详情卡、节点延伸、节点编辑删除
- **Task 10–12**：浏览器插件对接接口、Study 对话抽取、测验生成
- **Task 13–16**：Work 图谱、风口推荐、工作报告、用户提问
- **Task 17**：Agent 集成（`main_agent` 已就位，依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 等已全部移植，接入 `routers/chat.py`）
- **Task 18**：联调验证与优化

## 插件对接接口（Task 10）

为浏览器扩展（如 `web-ai-chat-collector`）提供对话推送接口，把采集到的 AI 对话
沉淀为后端 `Observation` 原始记录，待 Agent 抽取知识点（Task 11）。

当前阶段为**预留空实现**：只做接收与持久化，**不触发节点抽取**。抽取逻辑在
Task 11 由 Agent 实现，届时会调用 `graph_store.mark_observation_processed` 标记
已处理。

### 接口契约

#### `POST /api/plugin/conversations`

接收插件推送的一段对话。

**请求体**（JSON）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 来源平台标识，如 `chatgpt` / `claude` / `gemini` / `deepseek` / `qwen` / `doubao` / `kimi` |
| `timestamp` | string | 是 | 对话发生时间，ISO8601 格式，如 `2025-01-01T12:00:00+08:00`；解析失败时落库 `occurred_at` 为空，不阻断接收 |
| `conversation_markdown` | string | 是 | 对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料 |
| `metadata` | object | 否 | 可选附加元数据，如对话标题、URL、模型名、用户标签等，原样以 JSON 存入 `observations.metadata_json` |

**响应**（JSON，200）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `received` | boolean | 是否已接收，固定为 `true` |
| `observation_id` | string | 持久化后的观察记录 ID（32 位十六进制） |

**错误码**：

| 状态码 | 含义 |
| --- | --- |
| 422 | 请求体不符合契约（字段缺失 / 类型错误 / 空字符串） |
| 400 | 业务校验失败（如非法来源标记） |

**请求示例**：

```json
{
  "platform": "chatgpt",
  "timestamp": "2025-01-01T12:00:00+08:00",
  "conversation_markdown": "## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是一种用图结构组织知识的方式……",
  "metadata": {
    "title": "什么是知识图谱",
    "url": "https://chat.openai.com/c/abc123",
    "model": "gpt-4o-mini"
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

#### `GET /api/plugin/contract`

返回上述契约的结构化 JSON 文档（含字段说明、错误码、示例），供插件方程序化
读取并据此生成请求代码或做联调自检。

### 对接注意事项

1. **当前不去重**：同一对话重复推送会生成多条 `Observation` 记录。后续如需去重，
   可在 `metadata` 中传 `conversation_id`，由后端查重。
2. **CORS**：后端已允许 `http://localhost:5174` 与 `file://` 来源；插件直连后端
   （`http://127.0.0.1:8788`）时需自行处理跨域（浏览器扩展的 host_permissions
   可豁免 CORS）。
3. **数据流向**：`POST /api/plugin/conversations` → `observations` 表（`source='plugin'`）
   → Task 11 Agent 抽取节点 → `nodes` / `edges` → 图谱可视化。
4. **格式参考**：`conversation_markdown` 建议参考 `web-ai-chat-collector` 的导出
   格式（`## 用户` / `## 助手` 分段），便于 Agent 解析角色与内容。

# 复赛工作区 开发指南

> 本工作区是「AI 助手创新赛」复赛参赛作品的根目录，包含两个**互相独立但概念互补**的项目，共同构成"采集 ↔ 使用"的 AI 对话知识闭环。

## 工作区全景

```
复赛/
├── web-ai-chat-collector/     # 浏览器扩展（MV3）：采集多平台 AI 对话 → RAG 知识库（已入仓库）
├── knowledge-work-assistant/  # 成品软件：双模式知识工作助手（已入仓库）
├── 步影/                       # 桌面常驻 AI 助手：Electron + FastAPI 多模态 Agent（本地参考素材，不进仓库）
└── .trae/                      # TRAE 规格文档（spec.md / tasks.md / checklist.md），勿动
```

> **注意**：`步影/` 是参考素材目录，仅本地保留，**不要加入 git 仓库**（已写入 `.gitignore`）。后续任何新增素材目录如需本地保留，也应在 `.gitignore` 中排除并在此文档注明。

两个项目之间**没有代码依赖**，但在产品理念上互为表里：

- **web-ai-chat-collector** 解决"对话怎么留得下来、找得回来、用得起来"——把散落在 5 个 AI 平台（DeepSeek / 通义千问 / 复旦 AI Agent / 豆包 / Kimi）的对话沉淀成可检索知识库，并提供 RAG 问答浮球。
- **步影** 解决"AI 怎么常驻在桌面上、随时响应"——以灵动岛形态常驻桌面顶部，支持文字 / 语音 / 截图 / 文件拖拽多模态输入，自研 Agent 框架处理文件、文本、语音。

两个项目都可以独立启动、独立调试、独立打包。

## 各项目快速定位

| 维度 | web-ai-chat-collector | 步影 |
|------|----------------------|------|
| 类型 | 浏览器扩展（Chrome MV3） | 桌面应用（Electron + FastAPI） |
| 主语言 | JavaScript（ES2020+） | TypeScript + Python 3.12 |
| 包管理 | npm（package-lock.json） | pnpm（前端）+ uv（后端） |
| 入口 | `manifest.json` → `background.js` | 前端 `frontend/` + 后端 `backend/` |
| 启动命令 | Chrome `Load unpacked` | `pnpm dev:electron` + `uv run uvicorn` |
| 默认端口 | 浏览器进程内（无端口） | Vite 5173 / FastAPI 8787 |
| 测试 | `npm test`（Vitest） | 暂无统一测试 |
| 打包 | GitHub Actions release.yml | PyInstaller + electron-builder |
| 子项目指南 | [web-ai-chat-collector/DEVELOPMENT.md](./web-ai-chat-collector/DEVELOPMENT.md) | [步影/DEVELOPMENT.md](./步影/DEVELOPMENT.md) |

## 工作区级开发约定

### 1. 不要混用包管理器
- web-ai-chat-collector 用 `npm`（lock 文件是 `package-lock.json`）
- 步影前端用 `pnpm`（lock 文件是 `pnpm-lock.yaml`，启用 `pnpm-workspace.yaml`）
- 步影后端用 `uv`（lock 文件是 `uv.lock`，Python 版本由 `.python-version` 锁定）
- **不要在某个项目里用其他包管理器装依赖**，会污染 lock 文件。

### 2. 文件命名规范
- 代码文件、配置文件、脚本文件：**英文**（用户偏好：避免中文文件名导致的编码错误，曾在 generate.bat 踩坑）
- 文档内容：**中文**（用户偏好：详细解释、不要模板套话）
- 已有的中文文件名（如 `步影-示范.html`、`创意提案-报名帖正文.md`）保持原样，新增文件尽量用英文命名

### 3. 子项目内的 DEVELOPMENT.md 嵌套体系
每个含代码的子目录下都有一份 `DEVELOPMENT.md`，它们构成一个分层的开发指南网络：

```
复赛/DEVELOPMENT.md                          ← 你在这里
├── web-ai-chat-collector/DEVELOPMENT.md
│   ├── bg/DEVELOPMENT.md
│   ├── content/DEVELOPMENT.md
│   │   ├── dom/DEVELOPMENT.md
│   │   ├── network/DEVELOPMENT.md
│   │   └── ui/DEVELOPMENT.md
│   ├── lib/DEVELOPMENT.md
│   ├── popup/DEVELOPMENT.md
│   └── tests/DEVELOPMENT.md
└── 步影/DEVELOPMENT.md
    ├── backend/DEVELOPMENT.md
    │   ├── app/DEVELOPMENT.md
    │   ├── app/models/DEVELOPMENT.md
    │   ├── app/routers/DEVELOPMENT.md
    │   └── app/services/DEVELOPMENT.md
        ├── agents/DEVELOPMENT.md
        ├── multimodal/DEVELOPMENT.md
        ├── prompts/DEVELOPMENT.md
        ├── skills/DEVELOPMENT.md
        └── tools/DEVELOPMENT.md
    ├── frontend/DEVELOPMENT.md
    │   ├── electron/DEVELOPMENT.md
    │   └── src/DEVELOPMENT.md
        ├── components/DEVELOPMENT.md
        │   ├── ChatWindow/DEVELOPMENT.md
        │   ├── Island/DEVELOPMENT.md
        │   └── Settings/DEVELOPMENT.md
        └── lib/DEVELOPMENT.md
    └── installer/DEVELOPMENT.md
```

**进入任何一个子目录开发前，先读该目录的 DEVELOPMENT.md**——它会告诉你该模块的关键文件、约定、常见任务和坑点。

### 4. 与 README.md 的关系
许多子目录同时存在 `README.md` 和 `DEVELOPMENT.md`：
- `README.md`：描述"这是什么"（结构、配置、用法），多为静态文档
- `DEVELOPMENT.md`：描述"怎么在这里改代码"（开发流程、扩展点、注意事项），面向开发者

两者**互补不冲突**：改用户文档看 README，改代码看 DEVELOPMENT。

### 5. .trae/ 目录的处理
工作区根的 `.trae/` 和 步影/.trae 一样属于规格文档区，包含 `spec.md / tasks.md / checklist.md` 等。**不要手动修改这些文件**，它们是 TRAE 工具链的规格产物。

## 快速启动任意一个项目

### 启动 web-ai-chat-collector
```bash
cd web-ai-chat-collector
npm install                       # 首次
npm test                         # 跑测试（Vitest）
# Chrome → chrome://extensions/ → 开启开发者模式 → 加载已解压的扩展程序 → 选这个目录
```
详见 [web-ai-chat-collector/DEVELOPMENT.md](./web-ai-chat-collector/DEVELOPMENT.md)。

### 启动 步影
```bash
# 后端
cd 步影/backend
uv sync
cp .env.example .env             # 按需填写 LLM / ASR 凭据
uv run uvicorn app.main:app --reload --port 8787

# 另开终端：前端
cd 步影/frontend
pnpm install
pnpm dev:electron                # 同时拉起 Vite + Electron
```
详见 [步影/DEVELOPMENT.md](./步影/DEVELOPMENT.md)。

### 仅启动 步影 demo（不需要后端）
```bash
cd 步影
python serve.py                 # 默认代理到 http://127.0.0.1:11434（Ollama）
# 浏览器打开 http://localhost:8765/步影-示范.html
# API 地址栏填 http://localhost:8765（同源，无 CORS）
```
适合快速演示 LLM 对话能力，不涉及后端 Agent / 多模态 / 知识库。

## 跨项目协作场景

虽然两个项目代码独立，但在以下场景可以联动：

| 场景 | 联动方式 |
|------|---------|
| 用步影查 web-ai-chat-collector 沉淀的对话 | 启用 collector 的远程向量库（ChromaDB / Milvus / Qdrant 等），步影后端通过 MCP 调用 collector 的 SKILL 脚本检索 |
| 在步影对话中引用 collector 的导出 | collector 导出 Markdown / JSON，步影 `file_storage.py` 可作为文件附件解析 |
| 共享 LLM 凭据 | 两个项目都支持 OpenAI 兼容协议，同一套 API Key 可在 collector 的 popup/settings 和 步影 backend/.env 中复用 |

## 常见跨项目任务

### 任务 1: 在两个项目中同步新增一个 LLM Provider
**场景**：例如要接入一个新厂商的 OpenAI 兼容接口
**步骤**：
1. **collector 侧**：编辑 [web-ai-chat-collector/models.json](./web-ai-chat-collector/models.json)（preset 模型清单）和 [web-ai-chat-collector/lib/llm.js](./web-ai-chat-collector/lib/llm.js)（流式与 thinking 参数）；详见 [lib/DEVELOPMENT.md](./web-ai-chat-collector/lib/DEVELOPMENT.md) 的"扩展 LLM Provider"章节
2. **步影侧**：编辑 [步影/backend/app/services/llm_factory.py](./步影/backend/app/services/llm_factory.py) 和 [步影/backend/.env.example](./步影/backend/.env.example)；详见 [backend/app/services/DEVELOPMENT.md](./步影/backend/app/services/DEVELOPMENT.md) 的"扩展点"章节
3. **前端同步**：步影前端的设置面板 [步影/frontend/src/components/Settings/LLMSettings.tsx](./步影/frontend/src/components/Settings/LLMSettings.tsx) 如需暴露新选项则更新；详见 [Settings/DEVELOPMENT.md](./步影/frontend/src/components/Settings/DEVELOPMENT.md)
**验证**：两边各自跑一次流式对话，确认 thinking 参数生效、SSE 流式正常

### 任务 2: 把步影作为 collector 的"操作面板"
**场景**：用步影的语音 + Agent 能力去检索/整理 collector 沉淀的对话
**步骤**：
1. 在 collector 中启用远程向量库（参考 [web-ai-chat-collector/docs/supabase-setup.md](./web-ai-chat-collector/docs/supabase-setup.md) 等）
2. 部署 collector 的 SKILL（参考 [web-ai-chat-collector/docs/skill-setup.md](./web-ai-chat-collector/docs/skill-setup.md)）
3. 在步影后端通过 MCP 协议接入该 SKILL，参考 [步影/backend/app/services/mcp_manager.py](./步影/backend/app/services/mcp_manager.py) 和 [步影/backend/app/services/DEVELOPMENT.md](./步影/backend/app/services/DEVELOPMENT.md) 的 MCP 扩展点
**验证**：在步影灵动岛说"查一下我上周和 DeepSeek 聊过的 RAG 相关内容"，Agent 应能调用 SKILL 返回结果

### 任务 3: 在同一台机器上并行开发两个项目
**场景**：同时调试 collector 和 步影
**步骤**：
1. 启动 步影后端：`cd 步影/backend && uv run uvicorn app.main:app --reload --port 8787`
2. 启动 步影前端：`cd 步影/frontend && pnpm dev:electron`（占用 5173）
3. Chrome 加载 web-ai-chat-collector 扩展
4. 注意端口隔离：步影后端 8787、Vite 5173、collector demo（如启用 serve.py）8765 互不冲突
**验证**：在步影问问题，同时在 Chrome 上让 collector 采集某个 AI 平台对话，两边 CPU / 内存不互掐

## 工作区级注意事项（坑）

### 1. 路径含中文
工作区根目录名 `复赛`、子项目目录名 `步影` 都是中文。**Windows 命令行工具（git bash、PowerShell、cmd）大多数情况能正常处理，但以下场景要警惕**：
- 批处理脚本 `.bat` 文件如果用 GBK 编码可能解析失败（参考 project_memory 的教训：generate.bat 中文导致编码错误）
- PyInstaller / electron-builder 打包脚本里如果硬编码路径，用英文相对路径更安全
- Python 脚本 `serve.py` 用 `os.path.dirname(os.path.abspath(__file__))` 切换工作目录是安全的

### 2. Node.js / Python 版本要求
- web-ai-chat-collector：Node.js ≥ 18（package.json 的 engines 字段未强制，但 MV3 Service Worker 需要 Node 18+ 的 npm 才能装依赖）
- 步影前端：Node.js ≥ 18（README.md 明确要求）
- 步影后端：Python 3.12（[.python-version](./步影/backend/.python-version) 锁定，uv 会自动按此版本创建虚拟环境）

### 3. 不要在工作区根目录建 git 仓库
两个子项目各自有自己的 `.gitignore`（[web-ai-chat-collector/.gitignore](./web-ai-chat-collector/.gitignore)、[步影/.gitignore](./步影/.gitignore)、[步影/backend/.gitignore](./步影/backend/.gitignore)、[步影/frontend/.gitignore](./步影/frontend/.gitignore)），它们是独立仓库。**工作区根目录不是 git 仓库**，不要在这里执行 `git init` 或 `git add`。

### 4. 不要触碰 .trae/ 目录
工作区根的 `.trae/` 和 步影/.trae（如果存在）是 TRAE IDE 的规格文档区，包含 `spec.md`、`tasks.md`、`checklist.md` 等，由工具链管理。手动修改会被下次 TRAE 会话覆盖。

### 5. 两个项目的依赖完全独立
- 不要在 `复赛/` 根目录放 `package.json` 或 `pyproject.toml`（这里不是 monorepo）
- 不要试图用工作区根的 `node_modules` 或 `.venv` 让两个项目共享依赖
- 两个项目的第三方库版本可能冲突（例如步影后端用 SQLAlchemy 2.x，collector 没用 SQLAlchemy），强行共享会出问题

### 6. demo 与真实产品的边界
步影根目录的 `步影-示范.html`、`demo.html`、`serve.py` 是**演示用最小化页面**，只展示 LLM 流式对话能力，**不包含**：
- 灵动岛 UI
- 多模态输入（语音 / 截图 / 文件）
- Agent 工具调用
- 知识库
- 双模式（Plan / Build）

要体验完整产品，必须走 `frontend/` + `backend/` 的正式启动流程。详见 [步影/DEVELOPMENT.md](./步影/DEVELOPMENT.md) 的"demo 模式 vs 完整模式"章节。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 第一次接触工作区，想快速跑起来 | 上方"快速启动"小节 |
| 要改浏览器扩展 | [web-ai-chat-collector/DEVELOPMENT.md](./web-ai-chat-collector/DEVELOPMENT.md) |
| 要改桌面 AI 助手 | [步影/DEVELOPMENT.md](./步影/DEVELOPMENT.md) |
| 要打包发布 | [installer/DEVELOPMENT.md](./步影/installer/DEVELOPMENT.md) 和 [web-ai-chat-collector/.github/workflows/release.yml](./web-ai-chat-collector/.github/workflows/release.yml) |
| 要看比赛原始创意 | [步影/创意提案-报名帖正文.md](./步影/创意提案-报名帖正文.md) |
| 要看规格文档 | [.trae/specs/](./.trae/specs/) 下的 spec.md / tasks.md / checklist.md |

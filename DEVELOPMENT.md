# 复赛工作区 开发指南

> 本工作区是「AI 助手创新赛」复赛参赛作品的根目录，**整个工作区是一个项目**，由两个紧耦合的子工程构成「插件 + 软件」一体化形态：
> - **web-ai-chat-collector**（插件侧）：MV3 浏览器扩展，采集多平台 AI 对话 → RAG 知识库 + 推送给软件侧
> - **knowledge-work-assistant**（软件侧）：Electron + FastAPI 桌面软件，双模式（Study / Work）知识图谱软件，接收并沉淀插件推送的对话
>
> 两者通过 `POST /api/plugin/conversations` 接口与 `plugin-sdk/kwa-push.js` 形成"采集 → 沉淀 → 抽取 → 图谱化"的数据闭环，开发时需联合调试，发布时分别打包。

## 工作区全景

```
复赛/
├── web-ai-chat-collector/        # 插件侧（Chrome MV3 扩展）：AI 对话采集 + RAG 问答浮球
│   ├── bg/                        #   Service Worker 业务层
│   ├── content/                   #   Content Script 入口与适配器
│   │   ├── dom/                   #     DOM 提取模式适配器（5 平台）
│   │   ├── network/               #     网络拦截模式适配器
│   │   └── ui/                    #     浮球 / 查看器 UI 层
│   ├── lib/                       #   共享服务层（db / embedding / vector-store / llm）
│   ├── popup/                     #   弹窗主页 + 设置页
│   ├── tests/                     #   Vitest + jsdom 测试套件
│   ├── docs/                      #   各向量库部署指南 + SKILL 脚本
│   ├── manifest.json              #   MV3 清单
│   ├── background.js              #   SW 唯一入口
│   └── models.json                #   LLM / Embedding 厂商清单（运行时 fetch）
│
├── knowledge-work-assistant/      # 软件侧（Electron + FastAPI 桌面软件）：双模式知识图谱
│   ├── backend/                   #   Python 3.12 + FastAPI 后端（端口 8788）
│   │   └── app/
│   │       ├── models/            #     SQLAlchemy ORM + Pydantic schema
│   │       ├── routers/           #     FastAPI 路由（health/graphs/nodes/quiz/work/plugin/stream/...）
│   │       └── services/          #     业务服务层（graph_store / graph_agent / llm_client / ...）
│   ├── frontend/                  #   Electron + React + TS + Vite 前端（端口 5174）
│   │   ├── electron/              #     主进程 / preload / launcher
│   │   └── src/
│   │       ├── components/        #     React 组件（含 graph/ 子目录：图谱可视化与节点编辑）
│   │       ├── lib/               #     api / ws / types
│   │       └── store/             #     Zustand 全局状态
│   └── plugin-sdk/                #   推送 SDK + UI 样式包 + 二次开发 patch（桥梁层）
│       ├── kwa-push.js            #     UMD 推送 SDK
│       ├── kwa-push.d.ts          #     类型定义
│       ├── ui/                    #     统一样式包 + 视觉规范
│       ├── example/               #     最小可运行 Chrome MV3 示例扩展
│       └── secondary-dev/         #     对原 collector 的二次开发 patch
│
├── .trae/                         # TRAE 规格文档（spec.md / tasks.md / checklist.md），勿手动改
├── 用户要求.md                    # 本工作区的高层约束（不应推送到主仓库）
├── 设计方案.md                    # 整体设计方案说明
└── .gitignore                     # 忽略 node_modules / data / 参考素材目录 等
```

> **重要**：本工作区**只承认这两个子工程**为入库项目。其他本地参考素材目录（如有）**不应推送到仓库**，且**所有开发指导文件（DEVELOPMENT.md）均不得包含对参考素材目录的路径或文件引用**（参考素材目录内部的 DEVELOPMENT.md 除外，但该目录不入仓库）。详见 [用户要求.md](./用户要求.md)。

## 项目定位与一体化关系

| 维度 | web-ai-chat-collector（插件） | knowledge-work-assistant（软件） |
|------|------------------------------|--------------------------------|
| 类型 | Chrome MV3 浏览器扩展 | Electron + FastAPI 桌面软件 |
| 主语言 | JavaScript（ES2020+，非 ES module） | TypeScript + Python 3.12 |
| 包管理 | npm（`package-lock.json`） | pnpm（前端）+ uv（后端） |
| 入口 | `manifest.json` → `background.js` | 前端 `frontend/` + 后端 `backend/` |
| 启动命令 | Chrome `Load unpacked` | `pnpm dev:electron` + `uv run uvicorn` |
| 默认端口 | 浏览器进程内（无端口） | Vite 5174 / FastAPI 8788 |
| 测试 | `npm test`（Vitest + jsdom） | 暂无统一测试 |
| 打包 | GitHub Actions `release.yml` | `pnpm dist`（electron-builder + NSIS） |
| 数据存储 | IndexedDB（本地）+ 可选远程向量库 | SQLite（`backend/data/app.db`）+ FTS5 |
| **联动接口** | **不主动推送（默认）**；二次开发后通过 `kwa-push.js` 推送 | **接收 `POST /api/plugin/conversations`**，落库为 `Observation` |

### 数据闭环

```
用户在 5 个 AI 平台（DeepSeek / 千问 / 复旦 / 豆包 / Kimi）对话
        ↓
web-ai-chat-collector 采集（DOM 提取 / 网络拦截二选一）
        ↓
本地 IndexedDB + 向量库（RAG 浮球就地问答）
        ↓ （二次开发后启用 kwa-push-handler.js）
plugin-sdk/kwa-push.js → POST /api/plugin/conversations
        ↓
knowledge-work-assistant 后端：observations 表（source='plugin'）
        ↓
graph_agent 抽取候选节点（Task 11 / 13）
        ↓
graphs / nodes / edges 表 + 前端图谱可视化
        ↓
Study 模式：测验 / 费曼解释    Work 模式：风口推荐 / 工作报告 / 用户提问
```

## 工作区级开发约定

### 1. 不要混用包管理器
- `web-ai-chat-collector` 用 **npm**（lock 文件 `package-lock.json`）
- `knowledge-work-assistant/frontend` 用 **pnpm**（lock 文件 `pnpm-lock.yaml`，启用 `pnpm-workspace.yaml`）
- `knowledge-work-assistant/backend` 用 **uv**（lock 文件 `uv.lock`，Python 版本由 `.python-version` 锁定为 3.12）
- **不要在某个子工程里用其他包管理器装依赖**，会污染 lock 文件。

### 2. 文件命名规范
- 代码文件、配置文件、脚本文件：**英文**（用户偏好：避免中文文件名导致的编码错误，曾在 `generate.bat` 踩坑）
- 文档内容：**中文**（用户偏好：详细解释、不要模板套话）
- 已有的中文文件名（如 `用户要求.md`、`设计方案.md`）保持原样，新增文件尽量用英文命名。

### 3. 子项目内的 DEVELOPMENT.md 嵌套体系
每个含代码的子目录下都有一份 `DEVELOPMENT.md`，它们构成一个分层的开发指南网络：

```
复赛/DEVELOPMENT.md                                       ← 你在这里
├── web-ai-chat-collector/DEVELOPMENT.md
│   ├── bg/DEVELOPMENT.md
│   ├── content/DEVELOPMENT.md
│   │   ├── dom/DEVELOPMENT.md
│   │   ├── network/DEVELOPMENT.md
│   │   └── ui/DEVELOPMENT.md
│   ├── lib/DEVELOPMENT.md
│   ├── popup/DEVELOPMENT.md
│   └── tests/DEVELOPMENT.md
└── knowledge-work-assistant/DEVELOPMENT.md
    ├── backend/DEVELOPMENT.md
    │   ├── app/DEVELOPMENT.md
    │   │   ├── models/DEVELOPMENT.md
    │   │   ├── routers/DEVELOPMENT.md
    │   │   └── services/DEVELOPMENT.md
    │   │       └── tools/DEVELOPMENT.md
    │   └── tests/DEVELOPMENT.md
    ├── frontend/DEVELOPMENT.md
    │   ├── electron/DEVELOPMENT.md
    │   └── src/DEVELOPMENT.md
    │       ├── components/DEVELOPMENT.md
    │       │   └── graph/DEVELOPMENT.md
    │       ├── lib/DEVELOPMENT.md
    │       │   └── __tests__/DEVELOPMENT.md
    │       ├── store/DEVELOPMENT.md
    │       │   └── __tests__/DEVELOPMENT.md
    │       └── styles/DEVELOPMENT.md
    └── plugin-sdk/DEVELOPMENT.md
        ├── example/DEVELOPMENT.md
        ├── secondary-dev/DEVELOPMENT.md
        └── ui/DEVELOPMENT.md
```

> 本地参考素材目录（如前期项目骨架）**不入仓库**，其内部的 DEVELOPMENT.md 仅作参考用途，不出现在本目录树中。

**进入任何一个子目录开发前，先读该目录的 DEVELOPMENT.md**——它会告诉你该模块的关键文件、约定、常见任务和坑点。

### 4. 与 README.md 的关系
许多子目录同时存在 `README.md` 和 `DEVELOPMENT.md`：
- `README.md`：描述"这是什么"（结构、配置、用法），多为静态文档
- `DEVELOPMENT.md`：描述"怎么在这里改代码"（开发流程、扩展点、注意事项），面向开发者

两者**互补不冲突**：改用户文档看 README，改代码看 DEVELOPMENT。

### 5. .trae/ 目录的处理
工作区根的 `.trae/` 属于规格文档区，包含 `spec.md / tasks.md / checklist.md` 等。**不要手动修改这些文件**，它们是 TRAE 工具链的规格产物。

### 6. 参考素材目录相关约束
- 本地可能存在的参考素材目录（如前期项目骨架）仅作为参考用途，**禁止 `git add` 进仓库**（已在根 `.gitignore` 排除）
- 本工作区所有 `DEVELOPMENT.md` 文件中**不得出现参考素材目录的路径或对其文件的引用**（参考素材目录内部的 DEVELOVELOPMENT.md 除外，但该目录不入仓库）
- 若历史代码注释中有"从某某项目适配拷贝"等措辞，可在重构时顺手改为"由前期项目骨架适配而来"，但不必为消除字面提及而大改代码逻辑

## 快速启动

### 启动插件侧：web-ai-chat-collector
```bash
cd web-ai-chat-collector
npm install                        # 首次
npm test                           # 跑测试（Vitest + jsdom）
# Chrome → chrome://extensions/ → 开启开发者模式 → 加载已解压的扩展程序 → 选这个目录
```
详见 [web-ai-chat-collector/DEVELOPMENT.md](./web-ai-chat-collector/DEVELOPMENT.md)。

### 启动软件侧：knowledge-work-assistant
```bash
# 后端
cd knowledge-work-assistant/backend
uv sync                            # 首次（uv 自动建 .venv）
cp .env.example .env               # 按需填写 LLM_API_KEY 等
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8788

# 另开终端：前端
cd knowledge-work-assistant/frontend
pnpm install                       # 首次
pnpm dev:electron                  # 同时拉起 Vite (5174) + Electron
```
详见 [knowledge-work-assistant/DEVELOPMENT.md](./knowledge-work-assistant/DEVELOPMENT.md)。

### 联调：插件 → 软件 推送链路
1. 软件侧后端先启动（监听 8788）
2. 将 `plugin-sdk/secondary-dev/` 下的 patch 应用到 collector 副本（参考 [plugin-sdk/secondary-dev/PATCH-GUIDE.md](./knowledge-work-assistant/plugin-sdk/secondary-dev/PATCH-GUIDE.md)）
3. 加载 patched 后的 collector 扩展
4. 在任意受支持的 AI 平台发起一次对话 → collector 采集 → 自动推送 → 软件侧前端会收到 WebSocket 事件 `plugin.conversation_received` 并弹 Toast
5. 在软件侧 study 模式图谱视图打开"待抽取"侧栏，确认 Observation 进入了候选列表

详见 [plugin-sdk/DEVELOPMENT.md](./knowledge-work-assistant/plugin-sdk/DEVELOPMENT.md)。

## 跨子工程协作场景

| 场景 | 联动方式 |
|------|---------|
| 让 collector 把采集的对话沉淀到 KWA 图谱 | 应用 `plugin-sdk/secondary-dev/` patch 到 collector 副本，启用 `kwa-push-handler.js`，对话采集后自动 POST 到 `http://127.0.0.1:8788/api/plugin/conversations` |
| 在 KWA 中复用 collector 的 RAG 检索能力 | collector 启用远程向量库（Chroma / Milvus / Qdrant 等），KWA 后端通过 `docs/skills/query_knowledge.py` 脚本检索（参考 [web-ai-chat-collector/docs/skill-setup.md](./web-ai-chat-collector/docs/skill-setup.md)） |
| 共享 LLM 凭据 | 两侧均支持 OpenAI 兼容协议，同一套 API Key 可在 collector 的 `popup/settings.html` 与 KWA 后端 `backend/.env` 或前端 SettingsPanel 复用 |
| 同步新增 LLM 厂商 | collector 侧改 `models.json` + `lib/llm.js`；KWA 侧改 `backend/app/services/model_config.py` + `backend/.env.example`，两端各自跑流式对话验证 |

## 常见跨子工程任务

### 任务 1：在两侧同步新增一个 LLM Provider
**场景**：例如要接入一个新厂商的 OpenAI 兼容接口。
**步骤**：
1. **collector 侧**：编辑 [web-ai-chat-collector/models.json](./web-ai-chat-collector/models.json)（preset 模型清单，必填 `id/name/backend/baseUrl/apiKeyLabel/apiKeyUrl/supportsThinking/thinkingParam`，可选 `thinkingEnabledType/reasoningSplit/fallbackThinking`）；详见 [web-ai-chat-collector/lib/DEVELOPMENT.md](./web-ai-chat-collector/lib/DEVELOPMENT.md) 的"扩展 LLM Provider"章节。`lib/llm.js` 与 `popup/settings.js` 通过 `chrome.runtime.getURL('models.json')` 动态读取，**无需改代码**。
2. **KWA 侧**：编辑 [knowledge-work-assistant/backend/app/services/model_config.py](./knowledge-work-assistant/backend/app/services/model_config.py)（`model_config.json` 注册表 + 兜底硬编码）和 [knowledge-work-assistant/backend/.env.example](./knowledge-work-assistant/backend/.env.example)；详见 [backend/app/services/DEVELOPMENT.md](./knowledge-work-assistant/backend/app/services/DEVELOPMENT.md) 的扩展点章节。
3. **前端同步**：KWA 前端的 SettingsPanel（[frontend/src/components/SettingsPanel.tsx](./knowledge-work-assistant/frontend/src/components/SettingsPanel.tsx)）若需暴露新选项则更新；详见 [frontend/src/components/DEVELOPMENT.md](./knowledge-work-assistant/frontend/src/components/DEVELOPMENT.md)。

**验证**：两侧各自跑一次流式对话，确认 thinking 参数生效、SSE 流式正常。

### 任务 2：扩展 collector 的推送能力到 KWA
**场景**：希望 collector 在采集对话后自动推送到 KWA 后端。
**步骤**：
1. 备份 collector：`Copy-Item -Recurse web-ai-chat-collector web-ai-chat-collector-patched`
2. 按 [plugin-sdk/secondary-dev/PATCH-GUIDE.md](./knowledge-work-assistant/plugin-sdk/secondary-dev/PATCH-GUIDE.md) 应用 patch（4 个文件：`kwa-push.js` / `kwa-plugin.css` / `styles.patch.js` / `kwa-push-handler.js` + settings 页 patch）
3. 启动 KWA 后端（端口 8788），用 `curl http://127.0.0.1:8788/api/plugin/health` 自检
4. 在 patched collector 的设置页填入推送 URL（默认 `http://127.0.0.1:8788/api/plugin/conversations`），勾选启用
5. 访问任一受支持 AI 平台发起对话，观察 collector SW 日志与 KWA 后端日志

**验证**：KWA 前端图谱视图（study 模式）打开"待抽取"侧栏，能看到刚才推送的对话作为 Observation 出现。

### 任务 3：在同一台机器上并行开发两侧
**场景**：同时调试 collector 与 KWA。
**步骤**：
1. 启动 KWA 后端：`cd knowledge-work-assistant/backend && uv run uvicorn app.main:app --reload --port 8788`
2. 启动 KWA 前端：`cd knowledge-work-assistant/frontend && pnpm dev:electron`（占用 5174）
3. Chrome 加载 web-ai-chat-collector 扩展
4. 注意端口隔离：KWA 后端 8788、Vite 5174，互不冲突；collector 在浏览器进程内运行，无端口

**验证**：在 KWA 中触发节点延伸 / 测验 / 报告，同时在 Chrome 上让 collector 采集某个 AI 平台对话，两侧 CPU / 内存不互掐。

## 工作区级注意事项（坑）

### 1. 路径含中文
工作区根目录名 `复赛` 是中文。**Windows 命令行工具（git bash、PowerShell、cmd）大多数情况能正常处理，但以下场景要警惕**：
- 批处理脚本 `.bat` 文件如果用 GBK 编码可能解析失败（参考 project_memory 的教训：`generate.bat` 中文导致编码错误）
- electron-builder / PyInstaller 打包脚本里如果硬编码路径，用英文相对路径更安全
- Python 脚本用 `os.path.dirname(os.path.abspath(__file__))` 切换工作目录是安全的

### 2. Node.js / Python 版本要求
- web-ai-chat-collector：Node.js ≥ 18（MV3 Service Worker 需要 Node 18+ 的 npm 才能装依赖）
- knowledge-work-assistant/frontend：Node.js ≥ 18（推荐 20+），Electron 31.x
- knowledge-work-assistant/backend：Python 3.12（[.python-version](./knowledge-work-assistant/backend/.python-version) 锁定，uv 会自动按此版本创建虚拟环境）

### 3. 工作区根目录不是 monorepo
两个子工程各自有自己的 `.gitignore`（[web-ai-chat-collector/.gitignore](./web-ai-chat-collector/.gitignore)、[knowledge-work-assistant/backend/.gitignore](./knowledge-work-assistant/backend/.gitignore)、[knowledge-work-assistant/frontend/.gitignore](./knowledge-work-assistant/frontend/.gitignore)），它们是独立仓库。
- 不要在 `复赛/` 根目录放 `package.json` 或 `pyproject.toml`（这里不是 monorepo）
- 不要试图用工作区根的 `node_modules` 或 `.venv` 让两个子工程共享依赖
- 两个子工程的第三方库版本可能冲突（KWA 后端用 SQLAlchemy 2.x，collector 没用 SQLAlchemy），强行共享会出问题

### 4. 不要触碰 .trae/ 目录
工作区根的 `.trae/` 是 TRAE IDE 的规格文档区，包含 `spec.md`、`tasks.md`、`checklist.md` 等，由工具链管理。手动修改会被下次 TRAE 会话覆盖。

### 5. 推送链路的鉴权风险
`POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，仅适用于本机 loopback（`127.0.0.1:8788`）。若将 KWA 后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必自行在反向代理层加 token / Origin 白名单 / IP 限制。详见 [plugin-sdk/README.md](./knowledge-work-assistant/plugin-sdk/README.md) 的"风险提示"章节。

### 6. 端口隔离约定
KWA 后端固定 8788、前端固定 5174，与可能的本地其他项目（如其他参考素材项目用 8787 / 5173）相互隔离。**改端口需同步改 4 处**：`backend/app/config.py`、`backend/.env.example`、`frontend/vite.config.ts`、`frontend/electron/launcher.ts`，否则 dev / 生产 / 代理 / IPC 任一环失配都会让前端连不上后端。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 第一次接触工作区，想快速跑起来 | 上方"快速启动"小节 |
| 要改浏览器扩展（采集侧） | [web-ai-chat-collector/DEVELOPMENT.md](./web-ai-chat-collector/DEVELOPMENT.md) |
| 要改桌面软件（图谱侧） | [knowledge-work-assistant/DEVELOPMENT.md](./knowledge-work-assistant/DEVELOPMENT.md) |
| 要改后端 API / 图谱服务 | [knowledge-work-assistant/backend/DEVELOPMENT.md](./knowledge-work-assistant/backend/DEVELOPMENT.md) |
| 要改前端图谱可视化 | [knowledge-work-assistant/frontend/DEVELOPMENT.md](./knowledge-work-assistant/frontend/DEVELOPMENT.md) |
| 要做插件 → 软件推送对接 | [knowledge-work-assistant/plugin-sdk/DEVELOPMENT.md](./knowledge-work-assistant/plugin-sdk/DEVELOPMENT.md) |
| 要打包发布 | [knowledge-work-assistant/frontend/package.json](./knowledge-work-assistant/frontend/package.json) 的 `dist` script（electron-builder + NSIS）和 [web-ai-chat-collector/.github/workflows/release.yml](./web-ai-chat-collector/.github/workflows/release.yml) |
| 要看规格文档 | [.trae/specs/](./.trae/specs/) 下的 spec.md / tasks.md / checklist.md |
| 要看高层约束 | [用户要求.md](./用户要求.md) 与 [设计方案.md](./设计方案.md) |

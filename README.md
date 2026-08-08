# AI 对话采集与知识工作助手 · ai-chat-collector-pro

> 「AI 助手创新赛」参赛作品 —— 一个「浏览器插件 + 桌面软件」一体化的 AI 对话知识化方案：
> 把你在各家 AI 平台上的零散对话，**自动采集 → 沉淀 → 抽取知识点 → 沉淀成可问答、可测验、可辅助工作的知识图谱**。

整个工作区是一个项目，由两个紧耦合的子工程构成「插件 + 软件」一体化形态：

| 子工程 | 形态 | 作用 |
|--------|------|------|
| [web-ai-chat-collector](./web-ai-chat-collector) | Chrome MV3 浏览器扩展 | 采集多平台 AI 对话，构建本地 RAG 知识库，并提供悬浮问答球；可把对话推送给软件侧 |
| [knowledge-work-assistant](./knowledge-work-assistant) | Electron + FastAPI 桌面软件 | 双模式（Study / Work）知识图谱软件，接收并沉淀插件推送的对话，自动抽取节点、出题、生成工作报告 |

两者通过插件的 `bg/local-app.js` 与软件后端的 `POST /api/plugin/conversations` 接口形成
**「采集 → 沉淀 → 抽取 → 图谱化」** 的数据闭环。

> 📌 文档约定：本仓库根目录的 [DEVELOPMENT.md](./DEVELOPMENT.md) 是面向开发者的工作区指南（怎么跑起来、怎么改代码、跨子工程协作）；本 README 面向「这是什么、能做什么、怎么用」。

---

## ✨ 它能做什么

### 数据闭环：从一次对话到一张知识图谱

```
你在 6 个 AI 平台（DeepSeek / 千问 / 豆包 / Kimi / 元宝 / 文心）对话
        ↓
web-ai-chat-collector 采集（纯 DOM 提取，不拦截网络）
        ↓
本地 IndexedDB + 可选远程向量库（RAG 浮球就地问答）
        ↓ （在设置页启用「本地应用对接」后由 bg/local-app.js 触发）
POST /api/plugin/conversations  →  软件侧 observations 表
        ↓
graph_agent 自动抽取候选知识点（带类型初判、归一去重）
        ↓
graphs / nodes / edges 表  →  前端图谱可视化（待确认侧栏 → 入图）
        ↓
Study 模式：测验 / 费曼解释      Work 模式：风口推荐 / 工作报告 / 对话提问
```

### 插件侧 · web-ai-chat-collector

- **多平台对话采集** —— 6 家平台开箱即用：DeepSeek、千问、豆包、Kimi、腾讯元宝、百度文心。完整提取用户提问、AI 回答、**深度思考过程**和**联网搜索引用**。
- **纯 DOM 采集** —— 只解析你已渲染浏览的页面内容，不拦截网络流量、不 monkey-patch `fetch`/`XHR`、不模拟登录点击。完整保留 Markdown 格式（标题 / 列表 / GFM 表格 / 代码块 / KaTeX 数学公式）。
- **语义搜索 + RAG 问答** —— 对话切片嵌入为向量，悬浮问答球三模式流式输出：整理信息、生成测验、AI 问答。回答基于你已保存的对话历史。
- **多厂商 LLM** —— 6 家预设（DashScope / DeepSeek / 智谱 / Kimi / 豆包 / MiniMax）走 OpenAI 兼容协议，支持深度思考模式切换；亦可自定义任意 OpenAI 兼容端点。
- **多后端向量库** —— 默认本地 IndexedDB 零配置；可切换 ChromaDB / Milvus / pgvector / Supabase / Qdrant 远程库，支持跨设备与外部智能体消费。
- **SKILL 集成** —— 配套 SKILL 让外部智能体（TRAE、OpenClaw、Cursor）语义检索采集到的知识库。
- **导出** —— Markdown / JSON，单条或全部。

### 软件侧 · knowledge-work-assistant

- **双模式知识图谱** —— Study（学习）与 Work（工作）两套独立图谱，互不互通；右上角切换开关带过渡动画，切换后仅显示对应类型图谱。
- **图谱可视化** —— 无向图渲染，节点为小卡片（常显标题 + 一句话概括 + 类型标签）；支持拖拽 / 缩放 / 平移；孤立节点独立显示；延伸生成的灰色节点标记清晰。
- **双视图** —— 图谱视图与卡片视图并列切换，数据同步无丢失。
- **悬停详情卡** —— 悬停 300–500ms 显示五区域详情卡（标题 / 概括 / 重要点 / 延伸推荐 / 我的补充）；已覆盖 11 个学科模板（语文 / 数学 / 英语 / 历史 / 地理 / 政治 / 生物 / 化学 / 物理 / 编程 / 大模型），未命中走通用兜底，可手动切换类型并记忆。
- **节点延伸** —— 双击生成全部延伸（新节点标灰建边），单击推荐方向仅生成该方向一个节点；已存在节点不重复生成（高亮已有）；全部延伸支持撤销。
- **节点编辑删除** —— 可编辑标题 / 概括 / 类型 / 详情字段；删除节点并清理相关边；用户留白可保存为疑问 / 联想 / 考点 / 易错点 / 笔记，可选生成延伸节点。
- **Study 测验** —— 生成选择题（单选 / 多选）与费曼解释题；选择题即时判分给解析，费曼题 Agent 语义判分给理解度评分与反馈；结果记录并关联节点。
- **Work 图谱** —— 工作对象按子类型建模（线索 / 关键人 / 承诺 / 期望 / 事件 / 决策 / 风险 / 资料 / 偏好 / 复盘）；Agent 抽取归一去重建关系；节点详情卡含置信度与来源依据。
- **Work 风口推荐** —— 侧栏按时间线展示风口推荐卡片，含可解释理由；「加入图谱」一键转为 Work 图谱节点，可继续延伸。
- **Work 工作报告** —— 生成 Markdown 报告（进展 / 计划 / 风险 / 承诺跟进）；可导出 `.docx`；HTML 预览可打印为 PDF。
- **Work 对话提问** —— Work 模式对话式提问入口，Agent 基于工作图谱上下文回答，标注来源与置信度。
- **Agent 集成** —— `main_agent` / `sub_agent` 承载节点抽取 / 延伸 / 出题判分 / 风口 / 报告 / 提问；WebSocket 推送 Agent 流式输出与图谱变更。

> 截图与演示视频位置预留：`thumbnails/`（界面截图）、`videos/`（操作演示）。提交前请补充实拍素材。

---

## 🏗️ 架构总览

```
┌───────────────────────────── 浏览器（插件侧）─────────────────────────────┐
│                                                                          │
│  Content Scripts                  Service Worker (background.js)         │
│  ├─ 6 个平台 DOM 适配器            ├─ db.js          (对话存储 IndexedDB) │
│  ├─ floating-ball / viewer        ├─ embedding.js   (5 家嵌入厂商)        │
│  ├─ ai-ball (RAG 问答 UI)         ├─ vector-store.js(6 种向量后端)        │
│  └─ html-to-markdown (turndown)   └─ llm.js         (6 家 LLM 厂商)       │
│                                                                          │
│  Popup / 设置页（采集开关 / Embedding / 向量库 / LLM / 本地应用对接）       │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ bg/local-app.js（启用「本地应用对接」后触发）
                           ▼  POST /api/plugin/conversations
┌───────────────────────── 桌面（软件侧）──────────────────────────────────┐
│                                                                          │
│  后端 FastAPI（端口 8788）                  前端 Electron + React（5174）   │
│  ├─ routers/plugin.py     接收对话          ├─ 图谱可视化（react-force-graph）│
│  ├─ services/graph_store  节点 / 边存储     ├─ 悬停详情卡 / 节点编辑         │
│  ├─ services/graph_agent  抽取 / 延伸 / 出题 ├─ Study 测验 / Work 报告       │
│  ├─ services/main_agent   多轮对话 + 工具    ├─ OnboardingWizard 引导         │
│  ├─ routers/quiz/work/... 业务路由          └─ SettingsPanel / 导入对话框     │
│  └─ SQLite + FTS5（backend/data/app.db）                                  │
│                                                                          │
│  WebSocket /ws 推送：Agent 流式输出 + 图谱变更 + plugin.conversation_received │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 🧰 技术栈

| | 插件侧 web-ai-chat-collector | 软件侧 knowledge-work-assistant |
|---|---|---|
| 类型 | Chrome MV3 扩展 | Electron + FastAPI 桌面软件 |
| 主语言 | JavaScript（ES2020+） | TypeScript + Python 3.12 |
| 前端 | 原生 + turndown / marked / KaTeX | React 18 + Vite 5 + Zustand + react-force-graph |
| 后端 / 服务 | Service Worker（无端口） | FastAPI + SQLAlchemy 2.x（异步）+ aiosqlite + FTS5 |
| 包管理 | npm | pnpm（前端）+ uv（后端） |
| 数据存储 | IndexedDB（本地）+ 可选远程向量库 | SQLite（`backend/data/app.db`）+ FTS5 |
| 测试 | Vitest + jsdom（DOM 提取回归 + 纯函数单测） | pytest + pytest-asyncio（含 e2e） |
| 打包 | GitHub Actions `release.yml` | `pnpm dist`（electron-builder + NSIS） |

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 18（推荐 20+）
- **pnpm** ≥ 9（软件侧前端）
- **Python** 3.12（软件侧后端，由 `.python-version` 锁定）
- **uv** ≥ 0.4（Python 包管理器，[安装指南](https://docs.astral.sh/uv/)）
- Chrome / Edge 浏览器（加载扩展）

### 1. 启动插件侧

```bash
cd web-ai-chat-collector
npm install                 # 首次
npm test                    # 可选：跑测试（Vitest + jsdom）
```

然后：Chrome → `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `web-ai-chat-collector` 目录。

### 2. 启动软件侧

```bash
# 后端
cd knowledge-work-assistant/backend
cp .env.example .env        # 按需填写 LLM_API_KEY 等
uv sync                     # 首次（uv 自动建 .venv）
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8788

# 另开终端：前端
cd knowledge-work-assistant/frontend
pnpm install                # 首次
pnpm dev:electron           # 同时拉起 Vite (5174) + Electron
```

启动后访问 <http://127.0.0.1:8788/api/health>，应返回 `{"status":"ok",...}`。

### 3. 联调：插件 → 软件 推送链路

1. 软件侧后端先启动（监听 8788）。
2. 加载插件，在 popup 设置页「本地应用对接」分区勾选「启用对接」，点「连通性测试」确认后端可达。
3. 在任一受支持的 AI 平台发起一次对话 → 插件采集保存 → `bg/local-app.js` 自动 POST 到 `http://127.0.0.1:8788/api/plugin/conversations` → 软件侧前端收到 WebSocket 事件 `plugin.conversation_received` 并弹 Toast。
4. 在软件侧 Study 模式图谱视图打开「待抽取」侧栏，确认 Observation 进入候选列表 → 确认入图。

> 更详细的开发流程、跨子工程协作场景与注意事项见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## 📁 项目结构

```
ai-chat-collector-pro/
├── web-ai-chat-collector/          # 插件侧（Chrome MV3 扩展）
│   ├── bg/                          #   Service Worker 业务层（含 local-app.js 推送）
│   ├── content/                     #   Content Script 入口与适配器
│   │   ├── dom/                     #     6 平台 DOM 提取适配器
│   │   └── ui/                      #     浮球 / 查看器 / 问答 UI
│   ├── lib/                         #   共享服务（db / embedding / vector-store / llm）
│   ├── popup/                       #   弹窗主页 + 设置页
│   ├── tests/                       #   Vitest + jsdom 测试套件
│   ├── docs/                        #   各向量库部署指南 + SKILL 脚本
│   ├── manifest.json                #   MV3 清单
│   └── background.js                #   SW 唯一入口
│
├── knowledge-work-assistant/        # 软件侧（Electron + FastAPI 桌面软件）
│   ├── backend/                     #   Python 3.12 + FastAPI 后端（端口 8788）
│   │   ├── app/
│   │   │   ├── models/              #     SQLAlchemy ORM + Pydantic schema
│   │   │   ├── routers/             #     路由（auth/chat/graphs/nodes/quiz/work/plugin/...）
│   │   │   └── services/            #     业务服务（graph_store / graph_agent / main_agent / ...）
│   │   └── tests/                   #     pytest 测试（含 e2e）
│   └── frontend/                    #   Electron + React + TS + Vite（端口 5174）
│       ├── electron/                #     主进程 / preload / launcher
│       └── src/                     #     components（含 graph/）/ lib / store
│
├── DEVELOPMENT.md                   # 工作区开发指南（面向开发者）
├── 设计方案.md                       # 整体设计方案说明
└── README.md                        # 本文件
```

每个含代码的子目录下还有一份 `DEVELOPMENT.md`，构成分层开发指南网络；进入子目录改代码前先读它。

---

## 🔐 合规与隐私

- **仅采集用户本人数据** —— 插件只采集当前已登录用户在各支持平台上的对话，不访问、爬取或存储任何他人数据。
- **本地优先存储** —— 默认情况下，采集的对话仅存储在浏览器本地 IndexedDB / 软件侧本地 SQLite，不会上传到任何第三方服务器。
- **可选远程同步** —— 高级功能允许用户将自身对话数据推送至**自建**的远程向量库，以支持跨设备访问和 SKILL 语义检索。此操作需用户显式发起，并使用用户自有凭证与服务。
- **纯 DOM 采集** —— 不拦截网络流量、不发起辅助请求、不模拟任何用户行为。
- **loopback 鉴权提示** —— `POST /api/plugin/conversations` 面向本机回环（`127.0.0.1:8788`）。若将软件后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必在反向代理层加 token / Origin 白名单 / IP 限制。

---

## 🧪 测试

```bash
# 插件侧
cd web-ai-chat-collector && npm test

# 软件侧后端
cd knowledge-work-assistant/backend && uv run pytest
```

---

## 📜 许可证

MIT License — 详见 [LICENSE](./LICENSE)。

---

## 📚 更多文档

| 你想了解 | 去看 |
|----------|------|
| 插件侧是什么、怎么用 | [web-ai-chat-collector/README.md](./web-ai-chat-collector/README.md)（[中文](./web-ai-chat-collector/README-zh.md)） |
| 软件侧是什么、怎么用 | [knowledge-work-assistant/README.md](./knowledge-work-assistant/README.md) |
| 怎么改代码、跨子工程协作 | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| 整体设计思路 | [设计方案.md](./设计方案.md) |
| 各向量库部署 / SKILL 集成 | [web-ai-chat-collector/docs/](./web-ai-chat-collector/docs/) |
| 插件 → 软件对接接口契约 | [knowledge-work-assistant/README.md](./knowledge-work-assistant/README.md) 的「插件对接接口」章节 |

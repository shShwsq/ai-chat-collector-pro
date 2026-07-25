# ai-chat-collector

浏览器扩展，采集 AI 平台的对话记录，并将其转化为可搜索、可问答的知识库。基于 RAG（检索增强生成）：对话被切片嵌入为向量，通过语义搜索召回，再交给 LLM 回答问题、整理笔记或生成测验。

## 功能特性

- **多平台对话采集** — 完整提取用户提问、AI 回答、深度思考过程和联网搜索引用。默认推荐 DOM 模式（兼容性更好、不受 API 协议限制），网络拦截模式作为可选增强。
- **语义搜索** — 对话被切片并嵌入（DashScope / 智谱 / 百度千帆 / 火山豆包 / Jina 多厂商可选），支持按语义检索而非仅靠关键词。
- **AI 问答（RAG）** — 在支持的页面提供悬浮问答球，三种模式均支持流式输出：整理信息、生成测验、AI 问答。回答基于你已保存的对话历史。
- **多后端向量库** — 默认本地 IndexedDB（零配置）；可切换到远程向量库，支持跨设备 / 智能体消费。
- **多厂商 LLM** — 6 家预设厂商（DashScope / DeepSeek / 智谱 / Kimi / 豆包 / MiniMax）均走 OpenAI 兼容协议，支持深度思考模式切换；亦可自定义任意 OpenAI 兼容端点。
- **SKILL 集成** — 配套 SKILL 让外部智能体（TRAE、OpenClaw、Cursor）语义检索采集到的知识库。
- **导出** — Markdown / JSON，支持单条或全部导出。

## 支持平台

| 平台 | DOM 模式 | 网络拦截模式 |
|------|:--------:|:-----------:|
| DeepSeek (chat.deepseek.com) | ✅ | ✅ |
| 千问 (www.qianwen.com) | ✅ | ✅ |
| 复旦智汇岛 (aiagent.fudan.edu.cn) | ✅ | ✅ |
| 豆包 (www.doubao.com) | ✅ | ✅ |
| Kimi (www.kimi.com) | ✅ | — （WebSocket + protobuf，仅 DOM） |

## 模式说明

### DOM 模式（推荐）

通过解析渲染后的页面 DOM 提取对话内容。兼容性最好、对平台 API 变更不敏感，并通过 `turndown.js` + `turndown-plugin-gfm` 完整保留 Markdown 格式（标题、列表、表格、代码块、数学公式 KaTeX 等）。

- 五个平台开箱即用，覆盖最广
- 从渲染后的 HTML 还原 Markdown 格式 —— 标题、列表、**GFM 表格**、删除线、任务列表、围栏代码块、KaTeX 数学公式（行内 `$...$` / 块级 `$$...$$`）
- 各平台深度思考过程和联网搜索引用均支持提取（Kimi/DeepSeek/千问/豆包/复旦）
- 不依赖平台 API 协议（REST / WebSocket / protobuf 均可）
- 持续优化中 —— 思考块、搜索引用的提取精度仍在进一步提升

### 网络拦截模式

通过拦截浏览器网络请求，从 API 响应中直接解析对话数据。可获取原始流式数据，包括思考过程和搜索引用。可在设置页按平台手动启用。

**权衡：**

- 与各平台 API 契约强耦合，平台更新接口时易失效
- Kimi 无法使用（WebSocket + protobuf 传输）
- 仅在需要 DOM 尚未覆盖的原始流式数据时启用

## 合规与隐私

- **仅采集用户本人数据** — 扩展只采集当前已登录用户在各支持平台上的对话，不访问、爬取或存储任何他人数据。
- **本地优先存储** — 默认情况下，采集的对话仅存储在浏览器本地 IndexedDB，不会上传到任何第三方服务器。
- **可选远程同步** — 高级功能允许用户将自身对话数据推送至自建的远程向量库（ChromaDB / Milvus / pgvector / Supabase / Qdrant），以支持跨设备访问和 SKILL 语义检索（供 TRAE、OpenClaw、Cursor 等外部智能体使用）。此操作需用户显式发起，并使用用户自有凭证与服务。
- **模式推荐** — 默认推荐 DOM 模式，仅解析用户已浏览渲染的页面内容。网络拦截模式作为可选备选方案，用于获取原始流式数据；其辅助请求机制（复用用户自身的会话凭证，请求用户有权访问的对话历史）是提升采集完整性的手段，而非爬取数据的机制。
- **无用户行为模拟** — 扩展不会模拟登录、点击、滚动或任何与平台 UI 的用户交互。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      浏览器扩展 (MV3)                            │
│                                                                  │
│  Content Scripts           Service Worker (background.js)        │
│  ├─ network-interceptor    ├─ db.js        (对话存储)            │
│  ├─ 平台适配器             ├─ embedding.js (5 家嵌入厂商)         │
│  ├─ floating-ball          ├─ vector-store.js (6 种后端)         │
│  └─ ai-ball (问答 UI)      └─ llm.js       (6 家 LLM 厂商)       │
│                                                                  │
│  Popup / 设置页                                                  │
└──────────────┬───────────────────────────────┬───────────────────┘
               │                               │
               ▼                               ▼
        ┌─────────────┐               ┌─────────────────┐
        │  Embedding  │               │   向量库        │
        │  DashScope/ │               │  local | remote │
        │  智谱/百度/ │               └────────┬────────┘
        │  豆包/Jina  │                        │
        └─────────────┘                        │
                                  ┌────────────┴────────────┐
                                  ▼                         ▼
                          ┌─────────────┐         ┌─────────────────┐
                          │  LLM (RAG)  │         │  SKILL          │
                          │  6 家预设   │         │  (外部智能体)    │
                          │  + 自定义   │         │                 │
                          └─────────────┘         └─────────────────┘
```

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录

## 配置

从扩展弹窗打开设置页，主要配置项：

- **对话提取** — 按平台启用 / 禁用对话采集。
- **Embedding 服务** — 选择厂商（DashScope / 智谱 / 百度千帆 / 火山豆包 / Jina）、模型、API Key、内容过滤（是否包含思考 / 搜索块）、切片大小与重叠。
- **向量库** — 选择后端；保存前请先用「测试连通性」验证。
- **检索设置** — 模式（`combined` / `topk` / `threshold`）、Top-K、相似度阈值。
- **LLM 服务** — 选择后端并配置凭证。

### 向量库后端

| 后端 | 类型 | 部署指南 |
|------|------|----------|
| 本地 IndexedDB | 内置（零配置） | — |
| ChromaDB | 远程 | [docs/chroma-setup.md](docs/chroma-setup.md) |
| Milvus | 远程 | [docs/milvus-setup.md](docs/milvus-setup.md) |
| PostgreSQL + pgvector | 远程 | [docs/pgvector-setup.md](docs/pgvector-setup.md) |
| Supabase | 远程 | [docs/supabase-setup.md](docs/supabase-setup.md) |
| Qdrant | 远程 | [docs/qdrant-setup.md](docs/qdrant-setup.md) |

> 向量维度由模型配置决定（`model.dimension` > `provider.fallbackDimension` > 1024），当前预设模型均为 1024 维以匹配向量库 schema；支持 `dimensionsParam` 的模型（智谱 Embedding-3 / 豆包 / Jina v5）可在请求中强制指定维度。配置远程后端前请先用「测试连通性」按钮验证。

### LLM 后端

所有预设厂商均走 OpenAI 兼容协议（`backend: openai`），支持深度思考模式切换。

| 厂商 | 模型 | 思考参数 |
|------|------|----------|
| 阿里云百炼 DashScope | Qwen3.7-Max / Plus、Qwen3.6-Flash / Pro、DeepSeek-V4-Flash / Pro、QwQ-Plus（仅思考） | `enable_thinking` |
| DeepSeek 官方 | DeepSeek-V4-Flash / Pro | `thinking` |
| 智谱 AI (BigModel) | GLM-5.2、GLM-5.1 | `thinking` |
| 月之暗面 Kimi | kimi-k2.6、kimi-k2.5 | `thinking`（思考时 temperature=1.0，非思考时 0.6）|
| 火山引擎豆包 | Doubao-Seed-2.1-Pro / Turbo、Doubao-Seed-2.0-Mini | `thinking` |
| MiniMax | MiniMax-M3（混合）、MiniMax-M2.7（仅思考） | `thinking`（`adaptive` + `reasoning_split`）|

> 支持自定义 OpenAI 兼容端点（如 Ollama 本地推理）：在设置页填写 baseUrl 与模型 ID 即可。

### SKILL 集成

配套 SKILL（`docs/skills/`）让外部智能体（TRAE、OpenClaw、Cursor）通过 Python 脚本语义检索采集到的知识库。部署与使用见 [docs/skill-setup.md](docs/skill-setup.md)。

## 使用

1. 访问支持的 AI 平台并正常对话 — 采集会自动进行。
2. 点击浮动球可查看、搜索和导出已保存的对话。
3. 点击 AI 问答悬浮球，可基于历史对话提问、整理笔记或生成测验。

## 导出格式

- Markdown
- JSON

## 项目结构

```
ai-plugin/
├── manifest.json              # MV3 清单（host_permissions、content scripts）
├── background.js              # Service Worker 入口（加载 lib + bg 模块）
├── models.json                # LLM / Embedding 厂商目录（预设与模型清单）
├── bg/                        # Service Worker 业务模块
│   ├── router.js              # 消息路由 + ensureInit 守卫
│   ├── init.js                # 启动初始化
│   ├── settings-handlers.js   # 设置读写 + 连通性测试
│   ├── conversations.js       # 对话 CRUD
│   ├── ai-handlers.js         # RAG 编排（问答 / 整理 / 测验）
│   ├── vector-handlers.js     # 向量索引构建 / 重建 / 统计
│   ├── export.js              # Markdown / JSON 导出
│   └── data-handlers.js       # 存储信息 / 清空 / 重置
├── content/                   # Content Scripts
│   ├── adapter-registry.js    # EXTRACTION_MODE + getPlatformMode + 适配器注册表
│   ├── exporter-base.js       # ChatExporterBase（网络 / DOM 分派）
│   ├── network-interceptor.js # 共享网络钩子（MAIN world）
│   ├── ai-ball.js             # AI 问答悬浮球 + 面板
│   ├── kimi.js                # Kimi 入口（仅 DOM，无网络适配器）
│   ├── deepseek.js / qianwen.js / fudan.js / doubao.js  # 各平台入口
│   ├── network/               # 各平台网络适配器（REST 解析）
│   │   ├── common.js
│   │   ├── deepseek.js / qianwen.js / fudan.js / doubao.js
│   ├── dom/                   # 各平台 DOM 适配器
│   │   ├── html-to-markdown.js  # 统一的 HTML→Markdown 包装（turndown.js + GFM）
│   │   ├── katex-html-to-latex.js # KaTeX HTML→LaTeX 反向解析（Kimi 降级路径）
│   │   ├── kimi.js / deepseek.js / qianwen.js / fudan.js / doubao.js
│   └── ui/                    # 悬浮球 / 查看器 / 样式
│       ├── floating-ball.js / viewer.js / styles.js
├── lib/                       # 共享服务（SW 与 content 共用）
│   ├── db.js                  # IndexedDB 对话存储
│   ├── embedding.js           # 嵌入抽象层（DashScope / 多模态）
│   ├── vector-store.js        # 向量库抽象层（6 种后端）
│   ├── llm.js                 # LLM 抽象层（3 种后端，流式）
│   ├── marked.min.js          # Markdown → HTML 渲染器
│   ├── katex.min.js + .css    # 数学公式渲染
│   ├── turndown.min.js        # HTML → Markdown 转换器（DOM 模式使用）
│   └── turndown-plugin-gfm.js # GFM 插件：表格 / 删除线 / 任务列表
├── popup/                     # 弹窗 + 设置页
│   ├── popup.html / popup.js / popup.css
│   └── settings.html / settings.js / settings.css
├── docs/                      # 部署指南 + SKILL 集成
│   ├── chroma-setup.md / milvus-setup.md / pgvector-setup.md
│   ├── supabase-setup.md / qdrant-setup.md / skill-setup.md
│   └── skills/                # 外部智能体 SKILL
└── .github/workflows/         # 构建与发布流水线
```

## 第三方库

| 库 | 版本 | 用途 | 使用方 |
|------|------|------|--------|
| [turndown](https://github.com/mixmark-io/turndown) | 7.2.4 | HTML → Markdown 转换器 | DOM 模式提取（`content/dom/html-to-markdown.js`） |
| [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | 1.0.2 | turndown 的 GitHub Flavored Markdown 插件 —— 表格、删除线、任务列表、高亮代码块 | DOM 模式提取 |
| [marked](https://github.com/markedjs/marked) | — | Markdown → HTML 渲染器 | 查看器 & AI 问答面板（`content/ui/viewer.js`） |
| [KaTeX](https://github.com/KaTeX/KaTeX) | — | 数学公式渲染 | 查看器 & AI 问答面板 |

> KaTeX 反向解析：大多数平台保留了 `<annotation encoding="application/x-tex">` 源码层，turndown 可直接提取 LaTeX。Kimi 移除了该层，由 `content/dom/katex-html-to-latex.js` 递归解析 `.katex-html` DOM 重建 LaTeX 源码（积分、分式、上下标、导数等）。

## License

MIT — 见 [LICENSE](LICENSE)。

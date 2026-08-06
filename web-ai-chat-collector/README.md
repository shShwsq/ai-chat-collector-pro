# ai-chat-collector

[中文](README-zh.md) | **English**

A browser extension that captures AI platform conversations and turns them into a searchable, queryable knowledge base. Built on RAG (Retrieval-Augmented Generation): conversations are embedded into vectors, recalled via semantic search, and fed to an LLM to answer questions, organize notes, or generate quizzes.

## Features

- **Multi-platform conversation capture** — extracts user questions, AI answers, deep-thinking traces, and search citations. DOM mode is the recommended default (network interception available as an opt-in alternative).
- **Semantic search** — conversations are chunked and embedded (multi-provider: DashScope / Zhipu / Baidu Qianfan / Volcengine Doubao / Jina) so you can search by meaning, not just keywords.
- **AI Q&A (RAG)** — a floating Q&A ball on supported pages offers three modes, all streaming: organize information, generate quiz, and ask question. Answers are grounded in your saved conversations.
- **Multi-backend vector store** — local IndexedDB out of the box; optionally switch to a remote vector database for cross-device / agent consumption.
- **Multi-provider LLM** — 6 preset providers (DashScope / DeepSeek / Zhipu / Kimi / Doubao / MiniMax) all via OpenAI-compatible protocol with deep-thinking mode toggle; custom OpenAI-compatible endpoints also supported.
- **Skill integration** — a ready-made SKILL lets external agents (TRAE, OpenClaw, Cursor) semantically search the collected knowledge base.
- **Export** — Markdown / JSON, single conversation or all at once.

## Supported Platforms

| Platform | DOM Mode |
|----------|:--------:|
| DeepSeek (chat.deepseek.com) | ✅ |
| Qianwen (www.qianwen.com) | ✅ |
| Doubao (www.doubao.com) | ✅ |
| Kimi (www.kimi.com) | ✅ |
| Tencent Yuanbao (yuanbao.tencent.com) | ✅ |
| Baidu Wenxin (chat.baidu.com / wenxin.baidu.com) | ✅ |

## Capture Approach

### DOM Mode

Parses the rendered page DOM to extract conversations. Universal compatibility, resilient to API changes, and preserves full Markdown formatting (via `turndown.js` + `turndown-plugin-gfm`) including headings, lists, tables, code blocks, and math (KaTeX).

- All six supported platforms work out of the box
- Markdown formatting is preserved from rendered HTML — headings, lists, **GFM tables**, strikethrough, task lists, fenced code, and KaTeX math (inline `$...$` / block `$$...$$`)
- Deep-thinking traces and search citations are extracted per platform (Kimi/DeepSeek/Qianwen/Doubao/Yuanbao/Wenxin)
- Independent of platform API protocol (REST / WebSocket / protobuf)
- Actively under optimization — further improvements to thinking-block and search-citation extraction are in progress

## Compliance & Privacy

- **User-owned data only** — the extension captures only the conversations of the currently logged-in user on each supported AI platform. It does not access, scrape, or store any data belonging to other users.
- **Local-first storage** — by default, captured conversations are stored only in the browser's local IndexedDB. No data is uploaded to any third-party server in the default configuration.
- **Optional remote sync** — advanced features allow users to push their own conversation data to a self-hosted remote vector database (ChromaDB / Milvus / pgvector / Supabase / Qdrant) for cross-device access and SKILL-based retrieval by external agents (TRAE, OpenClaw, Cursor). This is an explicit user action using the user's own credentials and services.
- **DOM-only capture** — the extension parses only page content the user has already rendered; it does not intercept network traffic, monkey-patch `fetch`/`XMLHttpRequest`, or make auxiliary requests. (Network interception mode was removed in favor of this safer, purely-DOM approach.)
- **No behavioral simulation** — the extension does not simulate logins, clicks, scrolls, or any user interaction with the platform UI.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser Extension (MV3)                     │
│                                                                  │
│  Content Scripts           Service Worker (background.js)        │
│  ├─ platform adapters      ├─ db.js        (conversation store) │
│  ├─ floating-ball/viewer   ├─ embedding.js (5 embed providers) │
│  ├─ ai-ball (Q&A UI)       ├─ vector-store.js (6 backends)      │
│                            └─ llm.js       (6 LLM providers)   │
│                                                                  │
│  Popup / Settings Page                                           │
└──────────────┬───────────────────────────────┬───────────────────┘
               │                               │
               ▼                               ▼
        ┌─────────────┐               ┌─────────────────┐
        │  Embedding  │               │  Vector Store   │
        │  DashScope/ │               │  local | remote │
        │  Zhipu/Baidu/               └────────┬────────┘
        │  Doubao/Jina│                        │
        └─────────────┘                        │
                                  ┌────────────┴────────────┐
                                  ▼                         ▼
                          ┌─────────────┐         ┌─────────────────┐
                          │  LLM (RAG)  │         │  SKILL          │
                          │  6 presets  │         │  (external      │
                          │  + custom   │         │   agents)       │
                          └─────────────┘         └─────────────────┘
```

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the project root directory

## Configuration

Open the settings page from the extension popup. Key sections:

- **对话提取 (Capture)** — enable/disable capture per platform.
- **Embedding 服务** — choose provider (DashScope / Zhipu / Baidu Qianfan / Volcengine Doubao / Jina), model, API key, content filtering (include thinking / search blocks), chunk size & overlap.
- **向量库 (Vector Store)** — choose backend; test connectivity before saving.
- **检索设置 (Retrieval)** — mode (`combined` / `topk` / `threshold`), Top-K, score threshold.
- **LLM 服务** — choose backend and configure credentials.

### Vector Store Backends

| Backend | Type | Setup Guide |
|---------|------|-------------|
| Local IndexedDB | Built-in (zero config) | — |
| ChromaDB | Remote | [docs/chroma-setup.md](docs/chroma-setup.md) |
| Milvus | Remote | [docs/milvus-setup.md](docs/milvus-setup.md) |
| PostgreSQL + pgvector | Remote | [docs/pgvector-setup.md](docs/pgvector-setup.md) |
| Supabase | Remote | [docs/supabase-setup.md](docs/supabase-setup.md) |
| Qdrant | Remote | [docs/qdrant-setup.md](docs/qdrant-setup.md) |

> Vector dimension is determined by model config (`model.dimension` > `provider.fallbackDimension` > 1024); all preset models are 1024-dim to match the vector store schema. Models supporting `dimensionsParam` (Zhipu Embedding-3 / Doubao / Jina v5) can force a specific dimension in the request. Use the "测试连通性" button before saving a remote configuration.

### LLM Backends

All preset providers use the OpenAI-compatible protocol (`backend: openai`) and support deep-thinking mode toggling.

| Provider | Models | Thinking Param |
|----------|--------|----------------|
| Alibaba Cloud DashScope | Qwen3.7-Max / Plus, Qwen3.6-Flash / Pro, DeepSeek-V4-Flash / Pro, QwQ-Plus (thinking-only) | `enable_thinking` |
| DeepSeek Official | DeepSeek-V4-Flash / Pro | `thinking` |
| Zhipu AI (BigModel) | GLM-5.2, GLM-5.1 | `thinking` |
| Moonshot Kimi | kimi-k2.6, kimi-k2.5 | `thinking` (temperature=1.0 thinking / 0.6 non-thinking) |
| Volcengine Doubao | Doubao-Seed-2.1-Pro / Turbo, Doubao-Seed-2.0-Mini | `thinking` |
| MiniMax | MiniMax-M3 (hybrid), MiniMax-M2.7 (thinking-only) | `thinking` (`adaptive` + `reasoning_split`) |

> Custom OpenAI-compatible endpoints (e.g., Ollama for local inference) are supported: enter the baseUrl and model ID in the settings page.

### Skill Integration

A ready-made SKILL (`docs/skills/`) lets external agents (TRAE, OpenClaw, Cursor) semantically search the collected knowledge base via a Python script. See [docs/skill-setup.md](docs/skill-setup.md) for setup and deployment.

## Usage

1. Visit a supported AI platform and have a conversation — capture happens automatically.
2. Click the floating ball to view, search, and export saved conversations.
3. Click the AI Q&A ball to ask questions grounded in your history, organize notes, or generate quizzes.

## Export Formats

- Markdown
- JSON

## Project Structure

```
ai-plugin/
├── manifest.json              # MV3 manifest (host permissions, content scripts)
├── background.js              # Service Worker entry (loads lib + bg modules)
├── models.json                # LLM / Embedding provider catalog (presets & model lists)
├── bg/                        # Service Worker business modules
│   ├── router.js              # Message routing + ensureInit guard
│   ├── init.js                # Startup initialization
│   ├── settings-handlers.js   # Settings R/W + connectivity tests
│   ├── conversations.js       # Conversation CRUD
│   ├── ai-handlers.js         # RAG orchestration (Q&A / organize / quiz)
│   ├── vector-handlers.js     # Vector index build / rebuild / stats
│   ├── export.js              # Markdown / JSON export
│   └── data-handlers.js       # Storage info / clear / reset
├── content/                   # Content scripts
│   ├── adapter-registry.js    # EXTRACTION_MODE + adapter registry + platform enable defaults
│   ├── exporter-base.js       # ChatExporterBase (DOM extraction dispatch)
│   ├── ai-ball.js             # AI Q&A floating ball + panel
│   ├── deepseek.js / qianwen.js / doubao.js / kimi.js / yuanbao.js / wenxin.js  # Per-platform entries (DOM-only)
│   ├── dom/                   # Per-platform DOM adapters
│   │   ├── html-to-markdown.js  # Unified HTML→Markdown wrapper (turndown.js + GFM)
│   │   ├── katex-html-to-latex.js # KaTeX HTML→LaTeX reverse parser (Kimi fallback)
│   │   ├── kimi.js / deepseek.js / qianwen.js / doubao.js / yuanbao.js / wenxin.js
│   └── ui/                    # floating-ball, viewer, styles
│       ├── floating-ball.js / viewer.js / styles.js
├── lib/                       # Shared services (loaded by both SW and content)
│   ├── db.js                  # IndexedDB conversation store
│   ├── embedding.js           # Embedding abstraction (DashScope / multimodal)
│   ├── vector-store.js        # Vector store abstraction (6 backends)
│   ├── llm.js                 # LLM abstraction (3 backends, streaming)
│   ├── marked.min.js          # Markdown → HTML renderer
│   ├── katex.min.js + .css    # Math rendering
│   ├── turndown.min.js        # HTML → Markdown converter (DOM mode)
│   └── turndown-plugin-gfm.js # GFM plugin: tables / strikethrough / task lists
├── popup/                     # Popup + settings page
│   ├── popup.html / popup.js / popup.css
│   └── settings.html / settings.js / settings.css
├── docs/                      # Setup guides + SKILL integration
│   ├── chroma-setup.md / milvus-setup.md / pgvector-setup.md
│   ├── supabase-setup.md / qdrant-setup.md / skill-setup.md
│   └── skills/                # SKILL for external agents
└── .github/workflows/         # Build & release pipeline
```

## Third-Party Libraries

| Library | Version | Purpose | Used By |
|---------|---------|---------|---------|
| [turndown](https://github.com/mixmark-io/turndown) | 7.2.4 | HTML → Markdown converter | DOM mode extraction (`content/dom/html-to-markdown.js`) |
| [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | 1.0.2 | GitHub Flavored Markdown plugin for turndown — tables, strikethrough, task lists, highlighted code blocks | DOM mode extraction |
| [marked](https://github.com/markedjs/marked) | — | Markdown → HTML renderer | Viewer & AI Q&A panel (`content/ui/viewer.js`) |
| [KaTeX](https://github.com/KaTeX/KaTeX) | — | Math formula rendering | Viewer & AI Q&A panel |

> KaTeX reverse parsing: most platforms preserve the `<annotation encoding="application/x-tex">` source layer, so turndown extracts LaTeX directly. Kimi removes this layer, so `content/dom/katex-html-to-latex.js` recursively parses the `.katex-html` DOM to reconstruct the LaTeX source (integrals, fractions, superscripts/subscripts, derivatives, etc.).

## License

MIT — see [LICENSE](LICENSE).

# web-ai-chat-collector 项目开发指南

> 一句话定位：这是一个 MV3 浏览器扩展，把用户在 5 个 AI 平台（DeepSeek/千问/复旦 AI Agent/豆包/Kimi）上的对话采集下来、向量化、再做 RAG 问答；本文件是项目根目录的全局导航，五个子目录（`bg/`、`lib/`、`content/`、`popup/`、`tests/`）各有自己的 `DEVELOPMENT.md`。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本扩展是「复赛工作区」的**插件侧**，与**软件侧** [knowledge-work-assistant](../knowledge-work-assistant/DEVELOPMENT.md) 构成一个完整项目，共同形成"采集 → 沉淀 → 抽取 → 图谱化"的数据闭环：

- **默认行为**：本扩展独立运行，采集的对话存入 IndexedDB + 可选远程向量库，**不主动推送**到任何外部后端。
- **启用本地应用对接后**：默认行为下采集的对话仅存入本地 IndexedDB；在 popup 设置页"本地应用对接"分区启用对接后，由 `bg/local-app.js` 在保存对话时即时推送（`pushOnSave`）+ 可选 `chrome.alarms` 定时推送（间隔 1/5/10/30 分钟可选，静默失败），POST 到 `http://127.0.0.1:8788/api/plugin/conversations`，落库为 `Observation` 待 Agent 抽取知识点。
- **共享约定**：
  - 平台标识一致：本扩展采集时的 `platform` 字段（`deepseek/qianwen/fudan/doubao/kimi`）与 KWA 后端 `routers/plugin.py` 的白名单（`chatgpt/claude/gemini/deepseek/qwen/doubao/kimi/fudan/custom`）取交集；推送时建议带 `metadata.conversation_id`，KWA 后端会基于 `{platform}:{conversation_id}` 做 24h 幂等去重。
  - 对话格式：本扩展导出与推送均使用 `## 用户` / `## 助手` 分段的 Markdown，KWA 后端 `graph_agent` 据此解析角色与内容。
  - LLM 厂商清单：本扩展用 `models.json`（运行时 fetch），KWA 后端用 `backend/app/services/model_config.py`（启动时加载 `model_config.json`），**两份清单独立维护**，同步新增厂商时需两侧各改一处。

跨子工程任务（同步新增 LLM Provider、启用推送能力、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

根目录只承担"装配与声明"职责，本身不含业务逻辑：

- **`manifest.json`**：声明 MV3 元数据，包括 host_permissions（5 个 AI 平台 + 6 个 LLM/embedding 厂商域名 + 1 个 Jina）、permissions（storage / downloads / activeTab / scripting）、optional_host_permissions（远程向量库域名用 `http://*/*` 与 `https://*/*` 兜底）、content_scripts（按平台分别注入，每平台两条 entries：一条 MAIN world 的 `network-interceptor.js` 在 document_start 注入；一条默认 world 的 lib + content + 平台入口脚本）。Kimi 没有 MAIN world 注入，因为它走 WebSocket+protobuf 无法拦截。
- **`background.js`**：Service Worker 唯一入口，仅做两件事——(1) 顶层同步 `importScripts` 加载 `lib/*.js` + `bg/*.js`，(2) 调用 `initAll()` 并把 Promise 赋给 `_initPromise`，由 `bg/router.js` 的 `ensureInit()` await。注意 `importScripts` 必须在顶层 try 块中同步执行，不能放进 async 函数。
- **`models.json`**：LLM 与 Embedding 厂商/模型清单（被 `lib/embedding.js`、`lib/llm.js`、`popup/settings.js` 三处通过 `chrome.runtime.getURL('models.json')` fetch 后读取）。新增厂商或模型只需要改这一个文件，不需要改代码。
- **`package.json`**：仅声明测试套件依赖（vitest + jsdom + @vitest/coverage-v8），不声明运行时依赖——扩展运行时无构建步骤、无 npm 包打入产物。
- **`vitest.config.js`**：测试配置，jsdom 环境、`tests/**/*.test.js` glob、testTimeout 10s（DOM 转换涉及 turndown 初始化）。
- **`README.md` / `README-zh.md` / `LICENSE` / `THIRD_PARTY_LICENSES.md`**：文档与法务声明。
- **`.gitignore`**：忽略 `node_modules`、`coverage` 等。
- **`.github/workflows/release.yml`**：CI 打包发布。

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| `manifest.json` | MV3 清单 | host_permissions 含 15 个域名；content_scripts 5 套（每平台两条 entry，Kimi 仅一条）；action.default_popup 指向 `popup/popup.html`；web_accessible_resources 仅暴露 `lib/katex.min.css` |
| `background.js` | SW 入口 | 顶层 `importScripts` 加载顺序：`lib/db.js → lib/embedding.js → lib/vector-store.js → lib/llm.js → bg/init.js → bg/conversations.js → bg/export.js → bg/ai-handlers.js → bg/settings-handlers.js → bg/vector-handlers.js → bg/data-handlers.js → bg/router.js`；最后 `_initPromise = initAll()` |
| `models.json` | 厂商清单 | `llmProviders`（6 家：dashscope/deepseek/zhipu/moonshot/doubao/minimax，全 `backend:"openai"`）+ `embeddingProviders`（5 家：dashscope/zhipu/baidu/volcengine/jina）。每家含 id/name/baseUrl/apiKeyLabel/apiKeyUrl/models，模型含 dimension/multimodal/dimensionsParam 等元信息 |
| `package.json` | 测试依赖 | scripts: `test`/`test:watch`/`test:dom`/`test:unit`/`test:coverage`；无 runtime deps |
| `vitest.config.js` | 测试配置 | `environment: 'jsdom'`、`globals: true`、`include: ['tests/**/*.test.js']`；coverage include 仅 `lib/**` 与 `content/dom/**`，排除 `lib/*.min.js` 和 `lib/turndown-plugin-gfm.js` |

## 开发工作流

### 加载与调试

1. **加载扩展**：Chrome → `chrome://extensions/` → 打开右上"开发者模式" → "加载已解压的扩展程序" → 选 `web-ai-chat-collector/` 根目录。
2. **改 SW 代码后**（`background.js` 或 `bg/*.js` 或 `lib/*.js`）：在 `chrome://extensions/` 该扩展卡片点"Service Worker"链接重新打开 DevTools；SW 在 30 秒空闲后会休眠，调试断点会因休眠丢失，需在 DevTools → Application → Service Workers → 勾选"Keep service worker alive"。
3. **改 content script 后**（`content/**`）：必须刷新目标平台网页（chat.deepseek.com 等）才会重新注入。
4. **改 popup 后**：popup 关闭即销毁，调试时在 popup 上右键 → "检查"打开 DevTools，关闭 popup 后 DevTools 仍可保留用于查看日志。
5. **改 settings 页后**：settings 是普通 tab 页（`chrome.tabs.create` 打开），刷新即可。
6. **改 models.json 后**：SW 重新启动（在 `chrome://extensions/` 点扩展卡片的"重新加载"按钮）才能让 `lib/embedding.js` 与 `lib/llm.js` 重新 fetch；settings 页也要刷新。
7. **跑测试**：`npm test`（一次性）或 `npm run test:watch`（watch 模式）；只跑 DOM 适配器测试用 `npm run test:dom`，只跑 lib 单测用 `npm run test:unit`；覆盖率 `npm run test:coverage`。

### 调试技巧

- **SW 日志**：所有 `bg/*.js` 与 `lib/*.js` 的 `console.log/error` 都在 SW DevTools 中查看，前缀通常是 `[BG]`、`[Embedding]`、`[LLM]`、`[VectorStore]`、`[DB/Embedding]`。
- **content script 日志**：在目标平台网页 DevTools 的 Console 查看，注意 top frame（默认）才是 content script 上下文；MAIN world 的 `network-interceptor.js` 日志也在 top frame。
- **IndexedDB 内容**：SW DevTools → Application → IndexedDB → `AIChatCollector`（3 个 store：conversations/searchIndex/qaHistory）和 `AIChatEmbeddings`（1 个 store：embeddings）。
- **chrome.storage.local**：SW DevTools → Application → Storage → Local Storage → chrome-extension://<id>/，查看 `embeddingSettings`、`vectorStoreSettings`、`retrievalSettings`、`llmSettings`、`platformSettings`、`platformModes` 等 key。
- **网络请求**：LLM/Embedding/远程向量库的 fetch 在 SW 发起，要在 SW DevTools → Network 看；content script 的网络拦截在网页 DevTools → Network。

## 代码约定

### 模块加载方式

- **`background.js` 用 `importScripts`**（MV3 Service Worker 支持），不是 ES module。所有 `lib/*.js` 与 `bg/*.js` 顶层声明（`const X = {...}` / `function foo(){}`）都直接挂到 SW 全局，互相按声明顺序引用。
- **content scripts 用 manifest 静态注入**（`content_scripts[].js` 数组按顺序加载），也是非 ES module；文件之间通过 `window.X` 或全局变量通信。
- **popup 用 `<script src=>` 标签加载**（见 `popup/popup.html` 底部），同样非 ES module。
- **只有 `tests/helpers/load-source.js` 用 ES module**（`import fs from 'node:fs'`），并通过 `runInWindow()` 把源文件字符串 indirect eval 到 jsdom window 上来测试。

### 命名规范

- **文件名**：业务模块全小写连字符（`ai-handlers.js`、`vector-handlers.js`、`network-interceptor.js`、`html-to-markdown.js`）；第三方库保留原名（`marked.min.js`、`katex.min.js`、`turndown.min.js`、`turndown-plugin-gfm.js`）。
- **顶层函数**：`async function dbSaveConversation(data)` 风格，camelCase，`bg/*.js` 中以 `handle*` / `db*` 前缀分组（handler 命名 `handleXxx`、db 委托命名 `dbXxx`）。
- **顶层常量/单例对象**：PascalCase（`EmbeddingService`、`VectorStore`、`LLMService`、`AIAssistant`、`ChatExporterBase`）或全大写常量（`DB_NAME`、`DB_VERSION`、`STORE_CONVERSATIONS`、`RETRIEVAL_DEFAULTS`、`EMBEDDING_STORE`）。
- **私有方法**：下划线前缀（`_embedOpenAI`、`_addChromaBatch`、`_buildThinkingExtras`、`_parseEmbId`、`_stripAugmentBlocks`、`_createStreamChunkSender`）。

### 消息协议格式

所有 content/popup → SW 的消息统一用 `{ type: 'XXX_YYY', ...payload }` 格式，SW 用 `switch(message.type)` 分发。返回值统一是 `{ success: true, ...data }` 或 `{ success: false, error: '...' }`，少量只读查询（如 `GET_CONVERSATIONS`）直接返回原始数据不带 `success` 包装。流式 AI 调用（`ORGANIZE_INFO` / `GENERATE_QUIZ` / `AI_ASK_QUESTION`）的协议比较特殊：

1. 调用方传 `stream: true` 和 `sender.tab`，SW 立即返回 `{ success: true, requestId }`（如 `organize_1737000000000`）。
2. SW 异步执行 `AIAssistant.organizeInfo(query, onChunk, options)`，每收到一个 chunk 通过 `chrome.tabs.sendMessage(tab.id, { type: 'AI_STREAM_CHUNK', requestId, delta, fullContent, phase })` 推回 content script（`phase` 为 `'reasoning'` 或 `'content'`）。
3. 完成后推 `{ type: 'AI_STREAM_DONE', requestId, fullContent }`，失败推 `{ type: 'AI_STREAM_ERROR', requestId, error }`。

### 错误处理风格

- handler 层（`bg/*.js`）统一 try/catch 包裹，失败返回 `{ success: false, error: e.message }`，并 `console.error('[BG] xxx 失败:', e)`。
- lib 层（`lib/*.js`）的对外服务方法（`EmbeddingService.embed`、`VectorStore._addRemote*` 等）多数返回 `null` 或抛 Error，由 handler 决定是否包装。
- IndexedDB 操作用 `Promise + onsuccess/onerror + tx.oncomplete` 三件套，error 时 `reject(tx.error)`。
- 远程向量库 fetch 失败时返回 `{ success: false, error: 'HTTP ${status}' }` 或抛 Error（Milvus/Qdrant 的 batch insert 抛 Error 由上层 catch）。
- 用户友好提示：`testConnection` 把 `Failed to fetch` 翻译成"无法连接（Failed to fetch）。请检查地址是否可达、CORS 是否放行本扩展，以及服务是否在线"。

## 常见任务

### 任务 1：新增一个 AI 平台支持（DOM 模式）

**场景**：用户希望采集某个新平台（如文心一言）的对话。

**步骤**：
1. 在 `manifest.json` 的 `host_permissions` 加上该平台域名。
2. 在 `manifest.json` 的 `content_scripts` 加 2 条 entries：一条 MAIN world 注入 `content/network-interceptor.js`（可选），一条默认 world 注入 lib + content 共享脚本 + 新平台入口脚本 `content/<platform>.js`。
3. 在 `content/dom/<platform>.js` 实现 4 个方法：`getConversationId()`、`getTitle()`、`isStreaming()`、`extractMessages()`，并注册到 `window.DOM_ADAPTERS`。
4. 在 `content/<platform>.js` 入口调用 `ChatExporterBase` 启动采集。
5. 在 `bg/settings-handlers.js` 的 `DEFAULT_PLATFORM_MODES` 加上 `'<platform>': 'dom'`。
6. 在 `popup/settings.html` 的"对话提取"区加 checkbox + radio（DOM/网络拦截）。
7. 在 `popup/popup.js` 的 `platformNames` map 加显示名。
8. 在 `tests/dom/adapters.test.js` 加该平台的 fixture 测试（参考已有 5 平台结构）。
9. 在 `tests/helpers/load-source.js` 的 `loadDomAdapter` 不需要改（参数化）。

**验证**：访问新平台 → 检查 SW 日志出现 `[BG] 数据库初始化完成` 与保存对话日志 → 在 popup 列表能看到对话 → 跑 `npm run test:dom` 通过。

### 任务 2：新增一个 LLM 厂商预设

**场景**：接入一个新的 OpenAI 兼容厂商。

**步骤**：
1. 在 `models.json` 的 `llmProviders` 数组加一项，必填字段：`id`、`name`、`backend: "openai"`、`baseUrl`、`apiKeyLabel`、`apiKeyUrl`、`supportsThinking`、`thinkingParam`；可选：`thinkingEnabledType`（默认 `enabled`，MiniMax 用 `adaptive`）、`reasoningSplit`（MiniMax 才 true）、`thinkingTemperature`/`nonThinkingTemperature`（Kimi 用）、`fallbackThinking`（豆包用 `hybrid`）。
2. 在该厂商 `models` 数组加模型项，必填 `id`、`name`、`thinking`（`hybrid`/`only`/`none`）、`thinkingDefault`。
3. **不需要改 `lib/llm.js`**——它通过 `chrome.runtime.getURL('models.json')` 动态读取清单。
4. **不需要改 `popup/settings.js`**——它从同一个清单动态渲染下拉选项。

**验证**：重新加载扩展 → 打开 settings 页 → LLM 区"OpenAI 兼容预设"下拉出现新厂商 → 选中后 baseUrl/模型列表自动填充 → 填 API Key → 点"测试 LLM"返回 `success: true`。

### 任务 3：新增一个 Embedding 厂商

**场景**：接入新的向量生成服务。

**步骤**：
1. 在 `models.json` 的 `embeddingProviders` 数组加一项：`id`、`name`、`backend`（`dashscope` 或 `openai`）、`baseUrl`、`apiKeyLabel`、`apiKeyUrl`、`models`。每个模型需指定 `dimension`（必须 1024，否则与向量库 schema 不匹配）、`multimodal`（bool）、`dimensionsParam`（bool，是否在请求体传 `dimensions: 1024`）。
2. 若厂商用原生 API（非 `/embeddings` 端点），需要在 `lib/embedding.js` 的 `embed()` 方法加分支，并实现 `_embedXxx(text)`。
3. 若厂商有 `multimodalEndpoint: true`（如豆包 vision 走 `/embeddings/multimodal`），`lib/embedding.js` 已自动路由，只需在 modelMeta 标记。

**验证**：settings 页 Embedding 区下拉出现新厂商 → 选中后模型下拉填充 → 填 key → 点"测试 Embedding"返回 `success: true, dimension: 1024`。

### 任务 4：新增一个远程向量库后端

**场景**：接入 Weaviate 等新向量库。

**步骤**：
1. 在 `lib/vector-store.js` 的 `_addRemoteBatch` / `_searchRemote` / `_deleteRemote` / `_clearRemote` / `_statsRemote` 5 个 switch 中加 `case 'weaviate':` 分支，分别实现 `_addWeaviateBatch`、`_searchWeaviate`、`_deleteWeaviate`、`_clearWeaviate`、`_statsWeaviate`。
2. 注意 URL 拼接前必须先 `this._trimTrailingSlash(url)`。
3. 注意 ID 处理：项目其它后端用 `${convId}::msg::${hash}::chunk::${idx}` 字符串 ID；若新后端只接受 UUID/数字（如 Qdrant），需写一个确定性字符串→UUID 转换（参考 `_strToQdrantUUID`）。
4. 在 `popup/settings.html` 的 `vectorStoreType` select 加 `<option value="weaviate">Weaviate</option>`。
5. 在 `popup/settings.js` 的 `VECTOR_HELP_MAP` 加 `{ weaviate: { title: 'Weaviate 部署说明', file: 'docs/weaviate-setup.md' } }`。
6. 编写 `docs/weaviate-setup.md` 部署指南。
7. 在 `tests/unit/vector-store.test.js` 加纯函数测试（URL 处理、ID 转换等）。

**验证**：settings 页选 Weaviate → 填 URL/Key/Collection → 点"测试连通性"返回 `success: true, latency, count` → 保存 → "重建向量索引"成功。

### 任务 5：升级依赖库版本

**场景**：turndown 或 marked 有安全更新或新特性。

**步骤**：
1. 直接替换 `lib/turndown.min.js` 等文件内容（项目无 npm 构建，库直接以 min.js 形式 vendored）。
2. 跑 `npm run test:dom`，重点关注 `html-to-markdown.test.js` 是否仍通过——它是"DOM 改了立刻发现"的核心防线。
3. 若 turndown 升级破坏了 GFM 表格/任务列表，检查 `lib/turndown-plugin-gfm.js` 兼容性。
4. KaTeX 升级需重点跑 `tests/dom/katex-html-to-latex.test.js`——它依赖 KaTeX v0.16 输出的 `.katex-html` DOM 结构。

**验证**：`npm test` 全绿 → 在真实平台网页刷新 → 弹出 popup 查看对话 → Markdown 渲染正常（表格、代码块、公式）。

### 任务 6：调整 RAG 召回策略

**场景**：召回结果太多噪声或太少命中。

**步骤**：
1. 修改 `lib/vector-store.js` 的 `retrievalSearch()` 或 `RETRIEVAL_DEFAULTS`（`mode`/`topK`/`scoreThreshold`/`maxContextChars`）。
2. 也可在 settings 页"检索设置"区临时调整 mode（topk/threshold/combined）。
3. 修改 `lib/llm.js` 的 `AIAssistant._buildContexts()` 调整父子检索逻辑（命中消息+前后各 1 条邻居）。

**验证**：在 AI 平台网页点 AI 问答球 → 提问 → 观察返回引用的对话标题与相似度 → 在 SW DevTools 看 `[LLM]` 日志的请求/响应 → 调整阈值后再问。

## 扩展点

### 平台适配器扩展

- `content/adapter-registry.js` 提供 `EXTRACTION_MODE`、`getPlatformMode`、`adapter-registry`，新平台只需在 `content/dom/<platform>.js` 注册到 `window.DOM_ADAPTERS` 并在 `content/<platform>.js` 入口调用 `ChatExporterBase`。
- DOM 模式与网络拦截模式可独立切换（`platformModes` 设置项），新平台默认走 DOM（兼容性更好）。

### LLM provider 扩展

- 全部 LLM 厂商走 OpenAI 兼容协议（`backend: "openai"`），新厂商只需在 `models.json` 加配置。
- 思考模式差异通过 `thinkingParam`（`enable_thinking` 布尔 vs `thinking` 对象）、`thinkingEnabledType`（`enabled` vs `adaptive`）、`reasoningSplit`（是否拆 `reasoning_content` 字段）3 个字段表达，`lib/llm.js` 的 `_buildThinkingExtras` 自动处理。
- Ollama 本地后端独立分支（`_chatOllamaStream`），不走 models.json。

### Embedding provider 扩展

- OpenAI 兼容厂商统一走 `/embeddings` 端点，新厂商只需在 `models.json` 配置。
- 维度强制：`dimensionsParam: true` 的模型在请求体带 `dimensions: 1024`，保证与向量库 schema 匹配。
- 多模态：豆包 vision 走 `/embeddings/multimodal`（`multimodalEndpoint: true`）；DashScope 多模态走独立原生端点（`backend: "dashscope"` + `multimodal: true`）。

### Vector store 扩展

- `VectorStore` 单例 5 个 switch 分发，新后端在 5 处加 `case` 即可。
- ID 格式全局统一：`${convId}::msg::${msgHash}::chunk::${chunkIdx}`，metadata 含 `convId`/`msgHash`/`chunkIdx`/`chunkTotal`/`title`/`platform`/`role`/`content`，使远程向量库成为自包含、可被外部 SKILL 消费的数据库。

### SKILL 集成扩展

- `docs/skills/` 提供 Python 脚本 `query_knowledge.py`，外部 agent（TRAE/OpenClaw/Cursor）通过它语义搜索远程向量库。
- 新 agent 接入只需写自己的 SKILL.md，复用同一 Python 脚本。
- **与 KWA 联动**：knowledge-work-assistant 后端可通过该 SKILL 脚本检索本扩展沉淀的远程向量库（参考 [knowledge-work-assistant/DEVELOPMENT.md](../knowledge-work-assistant/DEVELOPMENT.md) 的"跨子工程协作"）。本扩展本身的 RAG 浮球（`content/ui/floating-ball.js`）不走该 SKILL，直接调本地 `lib/vector-store.js`。

### 推送能力扩展（与 KWA 联动）

- 默认扩展不主动推送采集结果到任何后端；要启用推送到 KWA，在 popup 设置页"本地应用对接"分区打开启用开关，由 `bg/local-app.js` 负责对接。
- 推送能力：保存对话时即时推送（`pushOnSave`）+ 可选 `chrome.alarms` 定时推送（间隔 1/5/10/30 分钟可选）；本地 `chrome.storage.local` 维护 `localAppPushedConvIds` 增量去重，避免无谓请求；后端 24h 幂等去重（`{platform}:{conversation_id}`）是兜底；后端不可达时静默失败，不阻断插件其他功能。
- 设置入口：popup 设置页"本地应用对接"分区，含启用总开关、自动推送开关、定时推送间隔选择、baseUrl 输入框（默认 `http://127.0.0.1:8788`）、连通性测试按钮（调 `GET /api/plugin/health`）。
- **鉴权风险**：KWA 后端当前不鉴权，仅适用于 loopback；部署到公网 / 局域网需自行加反代鉴权。

## 注意事项（坑）

### MV3 Service Worker 生命周期

- SW 30 秒空闲会被 Chrome 杀掉，所有内存状态（`_initPromise`、`EmbeddingService._modelsCatalog`、`VectorStore._config`）丢失，下次消息触发会重新 `initAll()`。
- 调试时勾选"Keep service worker alive"避免断点丢失。
- 不能在 SW 用 `XMLHttpRequest`，必须用 `fetch`；不能用 `window`/`document`，但可以用 `indexedDB`、`chrome.storage`、`navigator.storage.estimate`。

### importScripts 顺序敏感

- `background.js` 的 `importScripts` 顺序固定不能乱：`lib/db.js` → `lib/embedding.js` → `lib/vector-store.js` → `lib/llm.js` → `bg/init.js` → ... → `bg/router.js`。`lib/llm.js` 依赖 `EmbeddingService`/`VectorStore`/`getConversation`，`bg/router.js` 依赖所有 handler。
- 新增 `bg/*.js` 文件必须在 `bg/router.js` 之前 import。

### 维度一致性陷阱

- 所有预设 embedding 模型强制 1024 维（与向量库 schema 匹配）。
- 切换 embedding 模型导致维度变化时：本地 IndexedDB 不校验维度，新旧维度向量混存会导致 `localVectorSearch` 的 cosine similarity 返回 NaN（点积维度不匹配）；远程向量库（Milvus/pgvector）schema 固定维度，插入会直接 4xx。
- 用户需手动"清空向量库" + "重建向量索引"，插件不自动清理（见 `lib/embedding.js` 顶部注释）。

### 向量库后端切换副作用

- `bg/settings-handlers.js` 的 `handleSaveSettings('vectorStore')` 会判断 backend 变化（type/url/collection 改变，apiKey 单独变不算），可选清空旧后端 + 重建新后端索引（`clearOld`/`rebuildNew` 标志由 settings.js 询问用户后传入）。
- 切换时 `VectorStore.setBackend()` 会立即更新单例，但旧数据仍在旧后端，需要用户确认清理。

### 消息响应必须 return true

- `bg/router.js` 的 `chrome.runtime.onMessage.addListener` 必须 `return true` 表示异步响应，否则 `sendResponse` 在事件循环下一轮调用会失败（Chrome 限制）。
- 所有 case 都通过 `ensureInit().then(() => { ... sendResponse(...) })` 异步处理。

### 流式 AI 响应的特殊协议

- `ORGANIZE_INFO`/`GENERATE_QUIZ`/`AI_ASK_QUESTION` 立即返回 `requestId`，chunk 通过 `chrome.tabs.sendMessage` 推回 content script（不是通过 `sendResponse`）。
- `onChunk` 签名 `(delta, fullContent, phase)`，phase 区分 `reasoning`（思考内容）与 `content`（正式回答），UI 需要分别渲染。
- `handleTestLLM` 复用 `chatStream` 但 `onChunk=null`，只取最终 content。

### 内联事件处理器被 MV3 CSP 禁止

- `popup/popup.js` 与 `popup/settings.js` 全部用 `addEventListener`，不能用 HTML 内联 `onclick`。
- 修改 HTML 时不要图省事加 `onclick="..."`，会直接被 CSP 拦截不执行。

### PostgREST 204 空响应

- `lib/vector-store.js` 的 pgvector/Supabase POST 成功返回 204 No Content（空 body），直接 `resp.json()` 会抛 "Unexpected end of JSON input"，必须走 `parsePostgrestResponse(resp)` 统一处理。

### Qdrant ID 限制

- Qdrant point ID 只接受 unsigned int 或 UUID，不接受任意字符串。项目其它后端用 `convId::msg::hash::chunk::idx` 字符串 ID，Qdrant 入口做确定性字符串→UUID 转换（`_strToQdrantUUID`，FNV-1a 哈希），原 ID 存到 `payload._origId`。

### Milvus content 字段长度

- Milvus content 字段有 max_length 限制，长消息直接存 `msg.content` 会被拒。项目存的是切片后的 `c.text`（按 chunkSize 切片），不存原文。

### ChromaDB v2 API 路径规则

- ChromaDB 1.0+ 用 v2 API：集合级操作（create/delete collection）用 collection 名字；数据级操作（add/query/delete/count）路径必须用 collection 的 UUID（不是名字）。每次数据操作前先 `_chromaGetMeta` 查 UUID。
- distance function（l2/cosine/ip）决定 score 转换公式，`_chromaDistanceToScore` 统一处理。

### 测试加载机制

- 源码是 IIFE + 全局变量风格（不是 ES module），测试通过 `tests/helpers/load-source.js` 的 `runInWindow()` 用 indirect eval 在 jsdom 全局执行，并把 `const`/`let` 转 `var` 让顶层声明挂到 window。
- 改 `lib/*.js` 顶层声明为 `const X = {}` 后，测试中通过 `window.X` 访问；若新增顶层函数，需要在对应 `loadXxx()` 函数中显式返回。

### settings 保存触发权限申请

- 保存远程向量库配置时，`popup/settings.js` 的 `saveSettings` 末尾会通过 `chrome.permissions.request` 申请该域名权限（弹窗会导致 popup 失焦关闭），所以权限申请放在保存最后——配置已持久化，用户重开 popup 即可继续。

### Kimi 平台无网络拦截模式

- Kimi 用 WebSocket + protobuf 传输，无法用 `network-interceptor.js` 拦截，`manifest.json` 中 Kimi 的 content_scripts 只有 1 条 entry（无 MAIN world 注入），`settings.html` 中 Kimi 的"网络拦截"radio 是 `disabled`，`DEFAULT_PLATFORM_MODES.kimi` 固定为 `'dom'`。

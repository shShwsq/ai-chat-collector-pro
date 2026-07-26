# bg/ Service Worker 业务模块开发指南

> 一句话定位：本目录是 MV3 Service Worker 的业务逻辑层，所有消息路由、CRUD 委托、AI 编排、向量索引管理、设置 R/W、导出与数据清理都在这里；它通过 `background.js` 的 `importScripts` 顺序加载，依赖 `lib/*.js` 提供的 `EmbeddingService` / `VectorStore` / `LLMService` / `AIAssistant` / `db.js` 函数。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录是 collector 采集侧的"业务大脑"，与软件侧 [knowledge-work-assistant](../../knowledge-work-assistant/DEVELOPMENT.md) 的对接关系如下：

- **`conversations.js` 的 `dbSaveConversation`**：默认行为只写本地 IndexedDB；二次开发后，[plugin-sdk/secondary-dev/kwa-push-handler.js](../../knowledge-work-assistant/plugin-sdk/secondary-dev/kwa-push-handler.js) 会在采集事件后额外调用 `KwaPush.pushConversation()` 推送到 KWA 后端 `POST /api/plugin/conversations`，落库为 `Observation`。
- **`settings-handlers.js` 的 `platformModes`**：本扩展支持的 5 个平台 ID（`deepseek`/`qianwen`/`fudan`/`doubao`/`kimi`）与 KWA 后端 [routers/plugin.py](../../knowledge-work-assistant/backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 白名单（`chatgpt/claude/gemini/deepseek/qwen/doubao/kimi/fudan/custom`）取交集；推送时 `platform` 字段必须命中白名单。
- **`ai-handlers.js` 的 RAG 编排**：本扩展的 `organizeInfo`/`generateQuiz`/`askQuestion` 是 collector 本地的 RAG 能力（用本地向量库），与 KWA 后端的 `graph_agent`（[services/graph_agent.py](../../knowledge-work-assistant/backend/app/services/graph_agent.py)）是**两套独立的 LLM 编排**——前者服务于浏览器浮球就地问答，后者服务于图谱节点抽取与延伸。
- **`vector-handlers.js` 的远程向量库**：远程向量库（Chroma/Milvus/pgvector/Supabase/Qdrant）可被 KWA 后端通过 [docs/skills/query_knowledge.py](../docs/skills/scripts/query_knowledge.py) SKILL 脚本检索（跨子工程协作），共享同一份向量数据。
- **推送链路鉴权**：KWA 后端当前不鉴权，仅适用于 loopback（`127.0.0.1:8788`）；推送 URL 在 patched 后的设置页"知识工作助手推送"分区配置。

跨子工程任务（启用推送、同步 LLM Provider、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

`bg/` 共 8 个文件，按职责分为四层：

1. **初始化层**（`init.js`）：启动时打开 IndexedDB、初始化三大 AI 服务；提供 `ensureInit()` 让 router 在处理消息前 await。
2. **路由层**（`router.js`）：注册 `chrome.runtime.onMessage` 监听器，按 `message.type` 分发到各 handler，统一处理 `ensureInit` 包装与异步 `return true`。
3. **handler 层**（`conversations.js` / `export.js` / `ai-handlers.js` / `settings-handlers.js` / `vector-handlers.js` / `data-handlers.js`）：每个文件聚焦一个业务域，函数命名 `handleXxx` 或 `dbXxx`，参数从 `message` 解构，返回值统一为 `{ success, ... }` 或原始数据。
4. **委托层**：多数 handler 只是把请求转发给 `lib/*.js`（如 `dbSaveConversation` → `saveConversation`），加一层 try/catch 与日志；少量 handler（如 `handleRebuildIndex` / `handleSaveSettings('vectorStore')`）含跨模块编排逻辑。

## 关键文件

| 文件 | 职责 | 重要函数 |
|------|------|---------|
| `init.js` | SW 启动初始化 + ensureInit 守卫 | `initAll()`（依次 await `initDB` / `EmbeddingService.init` / `VectorStore.init` / `LLMService.init`，每个 try/catch 独立）；`ensureInit()`（await `_initPromise` 后置 null，确保只等待一次） |
| `router.js` | 消息路由总入口 | `chrome.runtime.onMessage.addListener`（switch 26 个 case + default 返回"未知消息类型"；外层 `ensureInit().then(() => {...})`；末尾 `return true` 表示异步响应） |
| `conversations.js` | 对话 CRUD 委托 | `dbSaveConversation(data)`（转发 `saveConversation`，失败包装 error）；`dbGetConversations(filters)`；`dbDeleteConversation(id)`；`dbGetStatus()`；`dbGetStorageInfo()`；`dbSearchConversations(query, filters)` |
| `ai-handlers.js` | RAG 三种模式流式编排 | `_createStreamChunkSender(tab, requestId)`（返回 onChunk 回调，通过 `chrome.tabs.sendMessage` 推 `AI_STREAM_CHUNK`）；`handleOrganizeInfo(query, stream, tab, options)`；`handleGenerateQuiz(query, stream, tab, options)`；`handleAIAskQuestion(query, stream, tab, options)`（三者结构相同：流式立即返回 requestId，异步执行后推 `AI_STREAM_DONE`/`AI_STREAM_ERROR`） |
| `settings-handlers.js` | 设置 R/W + 连通性测试 + 平台模式 | `handleGetSettings(category)`（switch 6 类：embedding/vectorStore/retrieval/llm/platforms/platformModes）；`handleSaveSettings(category, settings)`（vectorStore 分支含后端变化判定、可选清空旧后端 + 重建新后端）；`handleTestEmbedding(text)`；`handleTestLLM(prompt)`；`getPlatformSettings` / `savePlatformSettings` / `getPlatformModes` / `savePlatformModes`（直接读写 `chrome.storage.local`，DEFAULT_PLATFORM_MODES 默认全 dom） |
| `vector-handlers.js` | 向量索引生命周期 | `handleRebuildIndex()`（遍历全部对话，按消息切片 embedding 后批量写入 VectorStore，ID 格式 `${convId}::msg::${msgHash}::chunk::${chunkIdx}`）；`handleTriggerEmbedding(convId, messages)`（保存对话时由 db.js 触发，增量嵌入新消息）；`handleClearEmbeddings()`（兼容旧名，转调 `handleClearVectorStore`）；`handleClearVectorStore()`；`handleGetVectorStoreStats()`；`handleTestVectorConnection(config)` |
| `export.js` | 对话导出 | `handleExportConversation(id, format)`（单条，markdown/json）；`handleExportAll(format)`（全部，json 一次序列化，markdown 用 `\n\n---\n\n` 连接）；`formatConversation(conv, format)`（json 只导出 role+content，markdown 含标题/平台/时间/链接元信息）；`jsonContentToMarkdown(content)`（把 `<think>` 块转 `> 💭 **思考过程**` 引用块，`<search_result>` 转 `🔍 **联网搜索结果**`）；`downloadFile(content, filename, mimeType)`（用 `data:` URL + `chrome.downloads.download`，保存到 `ai-chat-collector/` 子目录）；`sanitizeFilename(name)`（去掉非法字符并截断到 50 字符） |
| `data-handlers.js` | 危险操作 | `handleClearAllConversations()`（遍历 deleteConversation 后 `VectorStore.clearCollection()`）；`handleResetAllSettings()`（`chrome.storage.local.clear()` 后用默认值重新初始化三大服务，LLM 默认 dashscope + qwen3.6-flash） |

## 开发工作流

### 改 bg 代码的典型流程

1. 改 `bg/*.js` 后，到 `chrome://extensions/` 点扩展卡片的"重新加载"按钮。
2. 点扩展卡片的"Service Worker"链接打开 SW DevTools。
3. SW 默认 30 秒空闲休眠，DevTools → Application → Service Workers → 勾选 "Keep service worker alive" 防止断点丢失。
4. 触发消息（如打开 popup、刷新 AI 平台网页、点 AI 问答球），在 SW DevTools → Console 看日志（前缀 `[BG]`、`[BG/Embedding]`）。
5. 在 SW DevTools → Sources 找到对应文件下断点（注意 Source 是 `chrome-extension://<id>/bg/xxx.js`，不是文件系统路径）。

### 调试技巧

- **消息路由错误**：未识别的 `message.type` 会落到 router.js 的 default 分支返回 `{ error: '未知消息类型' }`，在发送方 console 看到这个错误说明 type 字符串拼错或大小写不对。
- **初始化失败**：`initAll` 中每个服务的 init 都独立 try/catch，部分失败不影响其他服务；查看 SW 启动日志 `[BG] 数据库初始化完成` 与 `[BG] AI 服务初始化完成` 是否都出现。
- **流式 AI 无响应**：先看 SW 日志是否有 `[LLM] 请求:` 与 SSE chunk 日志；若 chunk 数为 0 但请求成功，说明响应体不是标准 SSE 或被代理拦截；若 `[LLM] 流式响应结束但无内容`，检查模型 ID 是否正确、思考参数是否被厂商拒绝。
- **向量库写入失败**：`[BG] 重建索引失败` 后跟 error，常见原因：维度不匹配（远程 schema 固定 1024 维）、Milvus content 字段超长、Qdrant ID 格式错误（不会发生，已用 `_strToQdrantUUID` 转换）。
- **导出失败**：`chrome.downloads.download` 失败一般是 filename 含非法字符（已用 `sanitizeFilename` 处理）或用户取消了下载权限。

## 代码约定

### 加载方式

- 通过 `background.js` 顶层 `importScripts` 加载，不是 ES module。
- 加载顺序固定：`init.js` → `conversations.js` → `export.js` → `ai-handlers.js` → `settings-handlers.js` → `vector-handlers.js` → `data-handlers.js` → `router.js`。新增 `bg/*.js` 必须在 `router.js` 之前 import。
- 各文件顶层声明（`async function` / `function`）直接挂到 SW 全局，互相按声明顺序引用——`router.js` 引用所有 handler，`vector-handlers.js` 引用 `EmbeddingService`/`VectorStore`/`getConversations`/`getConversation`（来自 lib）。

### 命名规范

- handler 命名 `handleXxx(args)`，db 委托命名 `dbXxx(args)`，导出 handler 也用 `handleXxx`（如 `handleExportConversation`）。
- 私有辅助函数下划线前缀（`_createStreamChunkSender`）。
- 常量全大写下划线（`DEFAULT_PLATFORM_MODES`）。

### 消息协议

- 入参：`{ type: 'XXX_YYY', ...payload }`，payload 字段直接从 message 解构（如 `message.id`、`message.filters`、`message.query`、`message.options`）。
- 出参：`{ success: true, ...data }` 或 `{ success: false, error: e.message }`；只读查询（`GET_CONVERSATIONS` / `GET_STATUS` / `GET_STORAGE_INFO` / `SEARCH_CONVERSATIONS` / `GET_QA_HISTORY` / `GET_VECTOR_STORE_STATS`）直接返回原始数据。
- 流式 AI 协议：`ORGANIZE_INFO`/`GENERATE_QUIZ`/`AI_ASK_QUESTION` 立即返回 `{ success: true, requestId }`，chunk 通过 `chrome.tabs.sendMessage(tab.id, { type: 'AI_STREAM_CHUNK', requestId, delta, fullContent, phase })` 推回，phase 为 `'reasoning'` 或 `'content'`（默认）。完成推 `AI_STREAM_DONE`，失败推 `AI_STREAM_ERROR`。
- `OPEN_SETTINGS` 同步处理：`chrome.tabs.create({ url: chrome.runtime.getURL('popup/settings.html') })` 后立即 `sendResponse({ success: true })`。

### 错误处理

- 每个 handler 都 try/catch，失败返回 `{ success: false, error: e.message }`，`console.error('[BG] xxx 失败:', e)`。
- 流式 handler 的异步部分（`.then`/`.catch`）单独 try/catch 推 `AI_STREAM_ERROR`，因为外层 sendResponse 已经返回。
- `dbSaveConversation` 在 catch 中返回 `{ success: false, error: error.message }`，而其他 db 委托（`dbGetConversations` 等）不 catch，让错误冒泡到 router 的 `ensureInit().then` 链——router 没有 catch，错误会被 Chrome 吞掉，sendResponse 不会被调用，调用方会等到默认超时（约 1 分钟）后收到 `undefined`。**改 db 委托时建议加 try/catch 包装**。

## 常见任务

### 任务 1：新增一个消息类型

**场景**：需要一个新的 SW 能力，比如 `GET_CONVERSATION_BY_URL`。

**步骤**：
1. 在合适的 handler 文件加 `async function handleGetConversationByUrl(url) { try { ... return { success: true, conversation }; } catch (e) { return { success: false, error: e.message }; } }`。
2. 在 `bg/router.js` 的 switch 加 `case 'GET_CONVERSATION_BY_URL': handleGetConversationByUrl(message.url).then(sendResponse); break;`。
3. 在调用方（content/popup）发 `chrome.runtime.sendMessage({ type: 'GET_CONVERSATION_BY_URL', url }, callback)`。
4. 若新 handler 文件是新建的，在 `background.js` 的 `importScripts` 列表中、`bg/router.js` 之前加 `importScripts('bg/new-handler.js');`。

**验证**：在 SW DevTools 下断点 → 调用方触发消息 → 断点命中 → sendResponse 返回 → 调用方 callback 收到结果。

### 任务 2：扩展 RAG 三种模式

**场景**：在 `AIAssistant.organizeInfo` 之外新增一种 RAG 模式（如"对比分析"）。

**步骤**：
1. 在 `lib/llm.js` 的 `AIAssistant` 对象加 `async compareAnalysis(query, onChunk, options) { ... return await LLMService.chatStream(messages, onChunk, options); }`，参考 `organizeInfo` 结构（embed → retrievalSearch → _buildContexts → 构造 prompt → chatStream）。
2. 在 `bg/ai-handlers.js` 加 `async function handleCompareAnalysis(query, stream, tab, options = {})`，复制 `handleOrganizeInfo` 结构，把 `requestId` 前缀改为 `compare_${Date.now()}`。
3. 在 `bg/router.js` 加 `case 'COMPARE_ANALYSIS': handleCompareAnalysis(message.query, message.stream, sender.tab, message.options).then(sendResponse); break;`。
4. 在 content script（`content/ai-ball.js`）监听 `AI_STREAM_CHUNK`/`AI_STREAM_DONE`/`AI_STREAM_ERROR`，按 requestId 匹配。
5. 在 UI 加触发按钮。

**验证**：在 AI 平台网页点 AI 球的新按钮 → SW 日志出现 `[LLM] 请求:` → 推 chunk → 球面板流式渲染。

### 任务 3：调整向量索引重建策略

**场景**：重建索引太慢，想加并发或跳过某些消息。

**步骤**：
1. 修改 `bg/vector-handlers.js` 的 `handleRebuildIndex()`，核心循环结构：
   ```js
   for (const conv of list) {
     const batchItems = [];
     for (const msg of conv.messages) {
       const embedContent = EmbeddingService.filterContentForEmbedding(msg.content);
       if (!embedContent) continue;
       const chunks = await EmbeddingService.embedMessageChunks(embedContent);
       // 拼装 batchItems，ID 格式 `${conv.id}::msg::${msg.hash || count}::chunk::${c.chunkIdx}`
     }
     if (batchItems.length > 0) await VectorStore.addVectors(batchItems);
   }
   ```
2. 想加并发：用 `Promise.all` 分批处理多个对话，但注意 `EmbeddingService.embed` 内部是串行的（for 循环 await），并发只在对话级别有效，且远程向量库可能限流。
3. 想跳过：在 `if (!embedContent) continue;` 后加额外过滤（如跳过特定 role、跳过短消息）。

**验证**：settings 页点"重建向量索引"按钮 → SW 日志 `[BG] 重建索引...` → 完成后返回 `{ success: true, count }` → settings 页 toast 显示重建条数。

### 任务 4：修改导出格式

**场景**：导出时想额外包含思考过程的标记或调整 Markdown 格式。

**步骤**：
1. 修改 `bg/export.js` 的 `formatConversation(conv, format)` 函数：
   - markdown 模式：调整 `md += ...` 模板，如加 `> 平台: ${conv.platform}` 已有，可加 `> 消息数: ${conv.messages.length}`。
   - json 模式：当前只导出 `role` + `content`，可加 `hash`、`createdAt` 等字段。
2. 修改 `jsonContentToMarkdown(content)`：当前把 `<think>` 转 `> 💭 **思考过程**` 引用块，`<search_result>` 转 `🔍 **联网搜索结果**`。可改为代码块、折叠块等。
3. 修改 `downloadFile(content, filename, mimeType)`：当前用 `data:` URL，对大文件可能超 URL 长度限制（Chrome 约 2MB），可改用 `URL.createObjectURL(new Blob([...]))` + `chrome.downloads.download`。

**验证**：popup 列表点"导出 Markdown" → 下载的 .md 文件内容符合预期 → "导出 JSON" 同理。

### 任务 5：增加设置类别

**场景**：新增一个设置类别（如"通知设置"）。

**步骤**：
1. 在 `lib/*.js` 加 `async function getNotificationSettings() { return new Promise((resolve) => chrome.storage.local.get('notificationSettings', (r) => resolve(r.notificationSettings || { enabled: true }))); }` 和对应的 `saveNotificationSettings`。
2. 在 `bg/settings-handlers.js` 的 `handleGetSettings` switch 加 `case 'notification': return await getNotificationSettings();`。
3. 在 `handleSaveSettings` switch 加 `case 'notification': await saveNotificationSettings(settings); break;`。
4. 在 `popup/settings.html` 加表单区，`popup/settings.js` 的 `loadSettings`/`saveSettings` 加读写逻辑。
5. 在 `popup/settings.js` 的 `serializeForm` 加新字段（用于未保存提示）。

**验证**：settings 页修改新类别 → 保存 → 刷新 settings 页 → 值保留 → SW DevTools → Application → Local Storage 查看 `notificationSettings` key。

### 任务 6：处理 SW 休眠后的状态恢复

**场景**：发现 SW 休眠后某些缓存状态丢失导致首次消息响应慢。

**步骤**：
1. 检查 `init.js` 的 `initAll` 是否覆盖了所有需要恢复的状态。当前恢复：IndexedDB 连接、`EmbeddingService` 配置（含 `_modelsCatalog`）、`VectorStore` 后端、`LLMService` 后端。
2. 若新增了带状态的 lib 模块，在 `initAll` 加 `await NewService.init()`。
3. `router.js` 的 `ensureInit` 保证每条消息都等待初始化完成，但 `_initPromise` 在第一次 await 后置 null——SW 重启后 `background.js` 重新执行 `_initPromise = initAll()`，新消息会再次 await。

**验证**：在 SW DevTools 手动 `chrome.runtime.terminate()`（或等待 30 秒）→ 触发消息 → SW 重启 → 日志出现 `[BG] 数据库初始化完成` → 消息正常响应。

## 扩展点

### 新增 handler 文件

- 创建 `bg/<domain>-handlers.js`，导出 `async function handleXxx(...)` 函数。
- 在 `background.js` 的 `importScripts` 列表中、`bg/router.js` 之前加 `importScripts('bg/<domain>-handlers.js');`。
- 在 `bg/router.js` 加对应 case。
- 不需要在 `init.js` 注册——handler 是无状态的。

### 扩展设置类别

- `handleGetSettings` / `handleSaveSettings` 的 switch 已支持 6 类（embedding/vectorStore/retrieval/llm/platforms/platformModes），新增类别在两处 switch 各加一个 case。
- 设置持久化逻辑放在 `lib/*.js`（如 `lib/embedding.js` 的 `getEmbeddingSettings` / `saveEmbeddingSettings`），保持 handler 层只做转发。

### 扩展向量索引触发时机

- 当前 `handleTriggerEmbedding(convId, messages)` 由 `lib/db.js` 的 `saveConversation` 在 `tx.oncomplete` 中自动调用（仅当 `EmbeddingService.isConfigured()` 为 true）。
- 可在其他时机触发：如对话删除时调用 `VectorStore.deleteByConvId(id)`（已在 `deleteConversation` 中实现）；对话更新时调用 `handleTriggerEmbedding` 重新嵌入。

### 扩展流式协议

- 当前 `AI_STREAM_CHUNK` / `AI_STREAM_DONE` / `AI_STREAM_ERROR` 三种消息类型 + `requestId` 关联。
- 可扩展 `AI_STREAM_CANCEL` 让前端主动取消（需要 LLMService 支持 AbortController，当前未实现）。

## 注意事项（坑）

### router.js 的 return true 必须有

- `chrome.runtime.onMessage.addListener` 的回调 `return true` 表示异步响应，否则 `sendResponse` 在事件循环下一轮调用会失败。
- 即使某些 case 是同步的（如 `OPEN_SETTINGS`），也走 `ensureInit().then()` 包装，整个 listener 始终 `return true`。

### ensureInit 只 await 一次

- `init.js` 的 `ensureInit` 在 await `_initPromise` 后立即置 null，意味着同一个 SW 生命周期内只等待一次初始化。
- SW 重启后 `background.js` 重新执行 `_initPromise = initAll()`，新消息会再次 await——这是设计，不是 bug。

### handleSaveSettings('vectorStore') 的副作用

- `vectorStore` 分支含后端变化判定：`backendChanged = oldBackend !== newBackend || (remote→remote 且 type/url/collection 任一变化)`。apiKey 单独变化不算（不触发清理/重建）。
- `clearOld` 标志触发 `VectorStore.clearCollection()`（此时单例仍指向旧后端，能清掉旧数据）。
- `rebuildNew` 标志触发 `handleRebuildIndex()`（此时 `VectorStore.setBackend` 已切换，重建写入新后端）。
- `clearOld` 和 `rebuildNew` 是临时标志，由 `popup/settings.js` 询问用户后传入，`handleSaveSettings` 内部剥离不持久化。

### handleTriggerEmbedding 的隐式触发

- `lib/db.js` 的 `saveConversation` 在 `tx.oncomplete` 中调用 `triggerEmbedding(convId, messages, convMeta)`（不是 `handleTriggerEmbedding`，是 db.js 内部的同名函数）。
- 该函数检查 `typeof EmbeddingService === 'undefined'` 跳过（lib 环境下未定义），SW 环境下才会真正嵌入。
- 增量保存时只嵌入 `newMessages`（`action === 'appended'`），全量保存时嵌入所有 `messages`。
- 这是设计上的"自动嵌入"，不需要 content script 显式发 `TRIGGER_EMBEDDING` 消息——`TRIGGER_EMBEDDING` 是给手动重试用的。

### 流式响应的 tab.id 可能失效

- `handleOrganizeInfo` 等流式 handler 捕获 `sender.tab`，但用户在流式过程中关闭 tab 会导致 `chrome.tabs.sendMessage` 失败。
- 已用 try/catch 包裹推送 chunk 的逻辑，失败只 `console.warn` 不影响 SW。
- `AI_STREAM_DONE` 推送也 try/catch，避免 reject 影响 SW 稳定性。

### handleExportAll 的 markdown 连接符

- 全部导出 markdown 时用 `\n\n---\n\n` 连接多个对话，这是 GFM 水平分隔线。
- json 模式直接 `JSON.stringify(list, null, 2)`，不连接。
- 大量对话导出时 `data:` URL 可能超长度限制，已知的边界情况，未优化。

### handleClearAllConversations 的串行删除

- 当前实现是 `for (const conv of list) await deleteConversation(conv.id)`，串行。
- 每个 `deleteConversation` 还会触发 `VectorStore.deleteByConvId(id)`（异步，不 await）。
- 大量对话时可能慢，但不改并发——避免 IndexedDB 事务冲突。
- 最后 `VectorStore.clearCollection()` 兜底清空向量库。

### handleResetAllSettings 的默认值

- 重置后 LLM 默认 `dashscope + qwen3.6-flash`（不是 `qwen3.7-max`），因为 flash 更便宜适合默认。
- Embedding 默认 `dashscope + text-embedding-v4`，apiKey 为空（需用户填）。
- VectorStore 默认 `local`（零配置）。
- 重置不删 IndexedDB 数据（只 `chrome.storage.local.clear()`），对话记录保留。

### DEFAULT_PLATFORM_MODES 的 Kimi 固定 dom

- `bg/settings-handlers.js` 顶部 `DEFAULT_PLATFORM_MODES = { deepseek: 'dom', qianwen: 'dom', fudan: 'dom', doubao: 'dom', kimi: 'dom' }`。
- Kimi 永远是 dom，因为 WebSocket+protobuf 无法用 `network-interceptor.js` 拦截。
- `popup/settings.html` 中 Kimi 的"网络拦截"radio 是 `disabled`，用户无法切换。
- 新增平台时若也用 WebSocket 等非 HTTP 协议，记得在 `DEFAULT_PLATFORM_MODES` 固定为 'dom' 并在 settings.html 禁用 network radio。

### handleSaveSettings('embedding') 的字段兼容

- `EmbeddingService.setConfig` 接受 `apiKey` 和 `dashscopeKey` 两个字段（兼容旧数据），`dashscopeKey` 仅在 `apiKey` 为空时使用。
- 保存时同时写入两个字段：`apiKey: settings.apiKey, dashscopeKey: settings.apiKey`，确保旧代码读取 `dashscopeKey` 仍能工作。
- 改这段逻辑时不要删除 `dashscopeKey` 兼容，会让老用户的配置失效。

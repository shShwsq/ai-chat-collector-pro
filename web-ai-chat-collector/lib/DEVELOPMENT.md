# lib/ 共享服务层开发指南

> 一句话定位：本目录是项目的"业务无关基础设施层"，提供四大单例服务（`EmbeddingService`/`VectorStore`/`LLMService`/`AIAssistant`）、IndexedDB 持久化（`db.js`）、设置项读写、向量相似度计算，以及 vendored 的第三方库（turndown/marked/katex）；同时被 Service Worker（通过 `importScripts`）和 content scripts（通过 manifest 静态注入）加载。

## 模块职责

`lib/` 共 9 个文件，分两类：

### 业务服务类（4 个，项目自研）

1. **`db.js`**：IndexedDB 数据访问层。管理两个数据库——`AIChatCollector`（3 个 store：conversations / searchIndex / qaHistory）和（间接）`AIChatEmbeddings`（实际在 `embedding.js` 中定义）。提供对话 CRUD、增量追加/覆盖/标题更新三种模式、中文 bigram 分词倒排索引、Q&A 历史 CRUD、存储信息统计、后台 embedding 触发。
2. **`embedding.js`**：Embedding 服务单例 `EmbeddingService` + 本地向量存储（`AIChatEmbeddings` IndexedDB）+ 暴力 cosine 相似度搜索。支持 5 个厂商：DashScope（原生 API，纯文本/多模态两个端点）、智谱/百度/Jina（OpenAI 兼容 `/embeddings`）、火山豆包（OpenAI 兼容多模态端点 `/embeddings/multimodal`）。提供文本切片（`chunkText`）、内容过滤（`filterContentForEmbedding` 剥离 `<think>`/`<search_result>`）、维度校验、`dimensionsParam` 强制 1024 维。
3. **`vector-store.js`**：向量库抽象单例 `VectorStore` + 召回设置持久化 + PostgREST 响应解析。支持 6 个后端：local（IndexedDB + `localVectorSearch`）、ChromaDB、Milvus、pgvector（PostgREST）、Supabase（PostgREST + `/rest/v1` 前缀）、Qdrant。每个后端实现 5 个操作：批量添加、相似度搜索、按 convId 删除、清空 collection、统计条数。提供 `retrievalSearch` 统一入口（按 mode=topk/threshold/combined 调用 `similaritySearch`）。
4. **`llm.js`**：LLM 服务单例 `LLMService` + AI 助手 `AIAssistant`。LLMService 支持 OpenAI 兼容（6 个预设厂商）+ Ollama 本地，统一流式接口 `chatStream(messages, onChunk, options)`，思考参数注入（`_buildThinkingExtras` 处理 6 厂商 × 3 思考模式 × 2 开关的矩阵），SSE 解析（区分 `reasoning_content` 与 `content` 两个字段）。AIAssistant 提供三种 RAG 模式：`organizeInfo` / `generateQuiz` / `askQuestion`，统一流程：embed query → retrievalSearch → _buildContexts（父子检索：命中消息+前后各 1 条邻居）→ 构造 prompt → chatStream。

### 第三方库类（5 个，vendored）

- **`turndown.min.js`**（7.2.4）：HTML→Markdown 转换器，DOM 模式提取用。
- **`turndown-plugin-gfm.js`**（1.0.2）：GFM 插件，加表格/删除线/任务列表支持。
- **`marked.min.js`**：Markdown→HTML 渲染器，popup 查看器与 content viewer 用。
- **`katex.min.js`** + **`katex.min.css`**：数学公式渲染。`katex.min.css` 是唯一在 `manifest.json` 的 `web_accessible_resources` 中暴露的资源（5 个平台域名可访问）。

## 关键文件

| 文件 | 职责 | 重要函数/类 |
|------|------|-------------|
| `db.js` | IndexedDB 对话/索引/QA 持久化 | `openDB()`（DB_NAME='AIChatCollector', DB_VERSION=2, 3 个 store）；`saveConversation(data)`（支持 mode=updateTitle/overwrite/默认增量追加，含思考补充替换逻辑）；`_stripAugmentBlocks(content)`（剥离 think/search_result/【搜索】/【来源】）；`getConversations(filters)` / `getConversation(id)` / `deleteConversation(id)`；`tokenize(text)`（中文 bigram + 单字符分词）；`searchConversations(query, filters)`（倒排索引检索 + 评分排序）；`highlightSearchResult(messages, query)`；`getStorageInfo()`（统计两个 DB 各 store 条目数 + `navigator.storage.estimate`）；`saveQAHistory` / `getQAHistory` / `deleteQAHistory` / `clearQAHistory`；`triggerEmbedding(convId, messages, convMeta)`（保存对话后异步触发，检查 `typeof EmbeddingService === 'undefined'` 跳过） |
| `embedding.js` | Embedding 服务 + 本地向量库 | `EmbeddingService` 单例（字段：`_provider`/`_backend`/`_baseUrl`/`_apiKey`/`_model`/`_multimodal`/`_dimensionsParam`/`_multimodalEndpoint`/`_expectedDimension`/`_includeThinking`/`_includeSearch`/`_chunkSize`/`_chunkOverlap`/`_modelsCatalog`）；方法：`init()`（读 settings + `_loadModelsCatalog` + `_applyProviderMeta`）、`setConfig(options)`、`chunkText(text)`、`filterContentForEmbedding(text)`、`embed(text)`（按 backend 分发）、`embedBatch(texts)`、`embedMessageChunks(text)`、`_embedDashscopeText` / `_embedDashscopeMultimodal` / `_embedOpenAI` / `_embedOpenAIMultimodal`；`openEmbeddingDB()`（DB_NAME='AIChatEmbeddings', DB_VERSION=1）；`saveEmbedding` / `getEmbeddingsByConvId` / `getAllEmbeddings` / `deleteEmbeddingsByConvId` / `clearAllEmbeddings`；`cosineSimilarity(a, b)`；`localVectorSearch(queryVector, topK)`；`getEmbeddingSettings` / `saveEmbeddingSettings` |
| `vector-store.js` | 向量库抽象 + 召回设置 | `VectorStore` 单例（字段：`_backend`/`_config`）；方法：`init()`、`setBackend(backend, config)`、`addVector(id, vector, metadata)`、`addVectors(items)`（批量，BATCH_SIZE=100 分批）、`similaritySearch(queryVector, topK, filters, options)`（含客户端阈值过滤）、`retrievalSearch(queryVector)`（按 retrievalSettings 的 mode 调用）、`deleteByConvId(convId)`、`clearCollection()`、`getStats()`、`testConnection(config)`；私有：`_trimTrailingSlash(url)`、`_normalizeSupabaseUrl(url)`、`_strToQdrantUUID(str)`（FNV-1a 哈希）、`_chromaGetMeta` / `_chromaGetSpace` / `_chromaDistanceToScore`；5 个后端的 `_addXxxBatch` / `_searchXxx` / `_deleteXxx` / `_clearXxx` / `_statsXxx`；`parsePostgrestResponse(resp)`；`getVectorStoreSettings` / `saveVectorStoreSettings`；`RETRIEVAL_DEFAULTS`（mode=combined, topK=20, scoreThreshold=0.3, maxContextChars=8000）；`getRetrievalSettings` / `saveRetrievalSettings` |
| `llm.js` | LLM 服务 + RAG 助手 | `LLMService` 单例（字段：`_backend`/`_config`/`_modelsCatalog`）；方法：`init()`（含 dashscope→openai 后端迁移逻辑）、`setBackend(backend, config)`、`chatStream(messages, onChunk, options)`、`_chatOpenAIStream`（含 temperature 厂商差异处理）、`_chatOllamaStream`、`_parseSSE(resp, onChunk, ctx)`（区分 reasoning_content 与 content）、`_buildThinkingExtras(options)`（核心：6 厂商 × 3 思考模式 × 2 开关矩阵）、`_buildOpenAIChatUrl(baseUrl)`、`_findProvider(id)` / `_findProviderByBaseUrl(baseUrl)`；`AIAssistant` 单例：`organizeInfo(query, onChunk, options)` / `generateQuiz(query, onChunk, options)` / `askQuestion(query, onChunk, options)`（三者结构相同）、`_parseEmbId(id)`（从 `${convId}::msg::${hash}::chunk::${idx}` 解析）、`_buildContexts(searchResults)`（父子检索：按 msgHash 定位命中消息，前后各 1 条邻居，命中取完整内容标 ★，邻居取前 500 字标 ·）；`getLLMSettings` / `saveLLMSettings` |
| `turndown.min.js` | HTML→Markdown | 第三方库，DOM 模式提取用（被 `content/dom/html-to-markdown.js` 包装） |
| `turndown-plugin-gfm.js` | GFM 表格/删除线/任务列表 | 第三方插件，配合 turndown 使用 |
| `marked.min.js` | Markdown→HTML | 第三方库，popup 查看器与 content viewer 用 |
| `katex.min.js` + `katex.min.css` | 数学公式渲染 | 第三方库，katex.min.css 通过 web_accessible_resources 暴露给 5 个平台域名 |

## 开发工作流

### 改 lib 代码的典型流程

1. 改 `lib/*.js` 后，到 `chrome://extensions/` 点扩展卡片的"重新加载"按钮（SW 重新启动，重新 `importScripts`）。
2. 在 SW DevTools → Sources 找到 `chrome-extension://<id>/lib/xxx.js` 下断点。
3. 触发对应功能（如保存对话触发 embedding、AI 问答触发 LLM 调用、settings 保存触发 setConfig）。
4. 在 SW DevTools → Console 看日志（前缀 `[Embedding]` / `[LLM]` / `[VectorStore]` / `[DB/Embedding]`）。
5. 改完同步跑 `npm run test:unit` 确保纯函数测试通过。

### 调试技巧

- **IndexedDB 内容查看**：SW DevTools → Application → IndexedDB → `AIChatCollector`（3 store）和 `AIChatEmbeddings`（1 store）。可直接编辑/删除记录。
- **chrome.storage 内容**：SW DevTools → Application → Storage → Local Storage → chrome-extension://<id>/，查看 `embeddingSettings`、`vectorStoreSettings`、`retrievalSettings`、`llmSettings`。
- **LLM 请求调试**：`_chatOpenAIStream` 在请求前 `console.debug('[LLM] 请求:', url, '模型:', model, 'temperature:', body.temperature)`；`_parseSSE` 前 3 个 chunk 输出 `console.debug('[LLM:xxx] SSE chunk[0]:', data.substring(0, 300))`，便于排查响应格式。
- **Embedding 请求调试**：`_embedOpenAI` 失败时 `console.error('[Embedding/OpenAI] 返回错误:', data.error)`；维度不匹配时 `console.error('[Embedding/OpenAI] 维度不匹配: 期望 ${expected}, 实际 ${actual}')`。
- **向量库请求调试**：`_addMilvusBatch` 成功时 `console.log('[VectorStore] Milvus batch insert 成功: ${items.length} 条, insertCnt=${data?.data?.insertCnt}')`。
- **本地向量搜索**：`localVectorSearch` 是暴力遍历 `getAllEmbeddings()` + cosine，O(n) 复杂度，向量多时慢。可在 SW DevTools Console 直接调用 `getAllEmbeddings().then(r => console.log(r.length))` 查看数量。

### 测试调试

- `lib/*.js` 的纯函数测试在 `tests/unit/`，通过 `tests/helpers/load-source.js` 的 `runInWindow()` 加载到 jsdom。
- 改 lib 顶层声明后，可能需要在 `loadXxx()` 函数中显式返回新导出（如 `loadDb()` 返回 `{ _stripAugmentBlocks, tokenize, highlightSearchResult }`）。
- 测试用 `beforeEach` 重置单例状态（如 `EmbeddingService._chunkSize = 500`），避免跨用例污染。

## 代码约定

### 加载方式

- **非 ES module**：所有 `lib/*.js` 用顶层 `const X = {...}` / `function foo(){}` 声明，通过 `importScripts`（SW）或 manifest 静态注入（content）或 `<script src=>`（popup）加载。
- **顶层声明挂全局**：`const EmbeddingService = {...}` 在 SW 中挂到 `self.EmbeddingService`，在 content/popup 中挂到 `window.EmbeddingService`，互相按声明顺序引用。
- **第三方库也是全局**：`turndown.min.js` 暴露 `TurndownService`，`turndown-plugin-gfm.js` 暴露 `turndownPluginGfm`，`marked.min.js` 暴露 `marked`，`katex.min.js` 暴露 `katex`。

### 命名规范

- **单例对象**：PascalCase（`EmbeddingService` / `VectorStore` / `LLMService` / `AIAssistant`）。
- **顶层函数**：camelCase（`saveConversation` / `getConversations` / `openDB` / `openEmbeddingDB` / `cosineSimilarity` / `localVectorSearch` / `parsePostgrestResponse`）。
- **常量**：全大写下划线（`DB_NAME` / `DB_VERSION` / `STORE_CONVERSATIONS` / `STORE_INDEX` / `STORE_QA_HISTORY` / `EMBEDDING_STORE` / `RETRIEVAL_DEFAULTS`）。
- **私有方法/字段**：下划线前缀（`_backend` / `_config` / `_apiKey` / `_embedOpenAI` / `_addChromaBatch` / `_buildThinkingExtras` / `_parseEmbId` / `_stripAugmentBlocks` / `_trimTrailingSlash` / `_strToQdrantUUID`）。
- **后端特定方法**：`_<backend><Operation>` 格式（`_addChromaBatch` / `_searchMilvus` / `_deletePgvector` / `_clearQdrant` / `_statsSupabase`）。

### 设置持久化协议

- 每个服务有自己的 `getXxxSettings` / `saveXxxSettings`，统一存 `chrome.storage.local`，key 分别为 `embeddingSettings` / `vectorStoreSettings` / `retrievalSettings` / `llmSettings` / `platformSettings` / `platformModes`。
- 默认值：embedding 用 dashscope/text-embedding-v4，vectorStore 用 local，retrieval 用 combined/topK=20/scoreThreshold=0.3/maxContextChars=8000，llm 用 openai/dashscope/qwen3.6-flash。
- 读取时 `chrome.storage.local.get(key, (result) => resolve(result[key] || defaults))`。

### 错误处理

- **IndexedDB**：`Promise + onsuccess/onerror + tx.oncomplete` 三件套，error 时 `reject(tx.error)` 或 `reject(request.error)`。
- **fetch**：失败时 `console.error` + 返回 `null`（Embedding）或抛 Error（Milvus/Qdrant batch insert）。
- **维度校验**：`_embedOpenAI` / `_embedOpenAIMultimodal` 收到向量后校验 `vec.length !== this._expectedDimension`，不匹配返回 null。
- **HTTP 错误**：`_chatOpenAIStream` 检查 `!resp.ok` 时解析错误 JSON 拼 `LLM 请求失败 (HTTP ${status}): ${message}` 抛 Error；不检查会让 `_parseSSE` 把 JSON 当 SSE 解析全部失败。
- **PostgREST 204**：`parsePostgrestResponse(resp)` 统一处理 204 空 body 与 201 JSON 响应。

## 常见任务

### 任务 1：调整文本切片策略

**场景**：默认 chunkSize=500 / chunkOverlap=50 不够好，想改默认值或改切片算法。

**步骤**：
1. 修改 `lib/embedding.js` 的 `EmbeddingService.chunkText(text)` 方法，当前算法：
   ```js
   const step = size - overlap;
   let i = 0;
   while (i < text.length) {
     chunks.push(text.slice(i, i + size));
     if (i + size >= text.length) break;
     i += step;
   }
   ```
2. 想改默认值：在 `getEmbeddingSettings()` 的默认返回值改 `chunkSize: 500, chunkOverlap: 50`；同时改 `popup/settings.html` 的默认值与 `popup/settings.js` 的 `loadSettings` 默认值。
3. 想按句子边界切片：用正则 `text.match(/[^。！？.!?]+[。！？.!?]+/g)` 先分段，再按 chunkSize 合并。
4. 改完跑 `tests/unit/embedding.test.js` 的 `chunkText` 测试，可能需要更新断言。

**验证**：settings 页改 chunkSize=300 → 保存 → 重建向量索引 → SW 日志 `[Embedding] 初始化完成，... 切片: size=300 overlap=50`。

### 任务 2：新增 Embedding 厂商分支

**场景**：接入一个用原生 API（非 OpenAI 兼容）的厂商。

**步骤**：
1. 在 `models.json` 的 `embeddingProviders` 加配置，`backend` 字段用一个新值（如 `xxx`）。
2. 在 `lib/embedding.js` 的 `EmbeddingService.embed(text)` 方法加分支：
   ```js
   if (this._backend === 'xxx') return await this._embedXxx(text);
   ```
3. 实现 `_embedXxx(text)`：fetch + 解析 + 返回向量数组。
4. 在 `_applyProviderMeta()` 中处理新 backend（设置 `_baseUrl` / `_multimodal` / `_dimensionsParam` 等）。
5. 维度校验：收到向量后 `if (vec.length !== this._expectedDimension) { console.error(...); return null; }`。

**验证**：settings 页选新厂商 → 填 key → "测试 Embedding" 返回 `success: true, dimension: 1024` → 重建索引成功。

### 任务 3：新增向量库后端

**场景**：接入 Weaviate。

**步骤**：
1. 在 `lib/vector-store.js` 的 5 个 switch（`_addRemoteBatch` / `_searchRemote` / `_deleteRemote` / `_clearRemote` / `_statsRemote`）加 `case 'weaviate':` 分支。
2. 实现 5 个方法：`_addWeaviateBatch(url, apiKey, collection, items)` / `_searchWeaviate(url, apiKey, collection, queryVector, topK)` / `_deleteWeaviate(url, apiKey, collection, convId)` / `_clearWeaviate(url, apiKey, collection)` / `_statsWeaviate(url, apiKey, collection)`。
3. URL 拼接前必须 `this._trimTrailingSlash(url)`。
4. ID 处理：Weaviate 支持 UUID，可复用 `_strToQdrantUUID` 或直接用项目字符串 ID（若 Weaviate 支持）。
5. score 字段：Weaviate 返回的 score 可能是 distance 或 similarity，统一转成"越大越相似"。
6. 在 `popup/settings.html` 加 `<option value="weaviate">`，`popup/settings.js` 的 `VECTOR_HELP_MAP` 加映射。
7. 在 `tests/unit/vector-store.test.js` 加纯函数测试。

**验证**：settings 页选 Weaviate → 填配置 → "测试连通性" → 保存 → "重建向量索引" → AI 问答能召回。

### 任务 4：调整 LLM 思考参数注入

**场景**：新厂商的思考参数格式特殊。

**步骤**：
1. 修改 `lib/llm.js` 的 `_buildThinkingExtras(options)`，当前逻辑：
   ```js
   if (thinkingMode === 'only') { extras = paramName === 'thinking' ? { thinking: { type: enabledType } } : { [paramName]: true }; }
   else if (thinkingMode === 'hybrid') { extras = paramName === 'thinking' ? { thinking: { type: enabled ? enabledType : 'disabled' } } : { [paramName]: enabled }; }
   if (extras && provider.reasoningSplit) extras.reasoning_split = true;
   ```
2. 若新厂商用不同格式（如 `{ reasoning: { effort: 'high' } }`），在 `_buildThinkingExtras` 加分支判断 `provider.id === 'newprovider'`。
3. 在 `models.json` 加该厂商配置时，标记 `thinkingParam` / `thinkingEnabledType` / `reasoningSplit` 等字段。
4. 跑 `tests/unit/llm.test.js` 的 `_buildThinkingExtras` 测试，覆盖新厂商。

**验证**：settings 页选新厂商 → 启用思考 → "测试 LLM" → SW 日志 `[LLM] 请求:` 的 body 含正确思考参数 → 响应含 `reasoning_content` 字段。

### 任务 5：修改 RAG 上下文构建

**场景**：父子检索的邻居数（当前前后各 1 条）想改为 2 条。

**步骤**：
1. 修改 `lib/llm.js` 的 `AIAssistant._buildContexts(searchResults)`，当前：
   ```js
   for (const idx of hitIndices) {
     contextIndices.add(idx);
     if (idx - 1 >= 0) contextIndices.add(idx - 1);
     if (idx + 1 < messages.length) contextIndices.add(idx + 1);
   }
   ```
2. 改为 `idx - 2` / `idx + 2`，或加参数 `neighborCount` 让用户可配置。
3. 邻居消息当前取前 500 字（`filtered.substring(0, 500)`），可调整为 `maxContextChars / hitCount` 动态分配。
4. 注意 `maxCharsPerConv` 限制（默认 8000，可由 retrievalSettings 调整），超出会截断并加 `...（内容过长，已截断）`。

**验证**：AI 球提问 → 返回引用的上下文更宽 → SW 日志 `[LLM] 请求:` 的 userPrompt 更长。

### 任务 6：调整 IndexedDB schema

**场景**：conversations store 需要加新字段（如 tags）。

**步骤**：
1. 在 `lib/db.js` 的 `openDB()` 的 `onupgradeneeded` 回调加 schema 变更：
   ```js
   if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) { ... }
   else {
     // 已存在的 store，加新 index
     const convStore = event.target.transaction.objectStore(STORE_CONVERSATIONS);
     if (!convStore.indexNames.contains('tags')) {
       convStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
     }
   }
   ```
2. 把 `DB_VERSION` 从 2 升到 3。
3. 注意：`onupgradeneeded` 只在版本号变化时触发，老用户的 DB 会被升级。
4. 在 `saveConversation` 中支持新字段：`conv.tags = data.tags || []`。
5. 在查询时用 index：`store.index('tags').getAll('xxx')`。
6. 跑 `tests/unit/db.test.js`（虽然纯函数测试不覆盖 IndexedDB，但确保 token 化等不破坏）。

**验证**：重新加载扩展 → SW 日志 `[BG] 数据库初始化完成` → IndexedDB DevTools 看到 conversations store 多了 tags index。

## 扩展点

### Embedding provider 扩展

- `EmbeddingService.embed(text)` 按 `this._backend` 分发，新 backend 加分支即可。
- `_applyProviderMeta()` 从 `models.json` 读取 provider 元信息（backend/baseUrl/multimodal/dimensionsParam/multimodalEndpoint/expectedDimension），自动适配。
- 自定义 provider（不在 models.json 中）回退到 `backend='openai'` + 用户填的 baseUrl，modelMeta 匹配不上时用 provider 级 fallback（`fallbackDimension` / `fallbackMultimodal` / `fallbackDimensionsParam` / `fallbackMultimodalEndpoint`）。

### Vector store 扩展

- `VectorStore` 5 个 switch 分发，新后端在 5 处加 `case`。
- ID 格式全局统一：`${convId}::msg::${msgHash}::chunk::${chunkIdx}`，metadata 含 8 个字段（convId/msgHash/chunkIdx/chunkTotal/title/platform/role/content）。
- 新后端的 score 必须转成"越大越相似"（cosine similarity 风格），客户端 `similaritySearch` 才能正确阈值过滤。

### LLM provider 扩展

- `LLMService.chatStream(messages, onChunk, options)` 按 `this._backend` 分发，当前支持 `openai` 与 `ollama`。
- 新增 backend（如 `anthropic` 原生 API）：在 `chatStream` 加分支，实现 `_chatAnthropicStream`，注意 Anthropic 的 SSE 格式与 OpenAI 不同。
- `_buildThinkingExtras` 已处理 6 厂商差异，新厂商若思考参数格式特殊，在此函数加分支。

### RAG 模式扩展

- `AIAssistant` 当前有 `organizeInfo` / `generateQuiz` / `askQuestion` 三种模式，结构相同。
- 新增模式（如 `summarize`）：复制 `organizeInfo` 结构，改 systemPrompt 与 userPrompt 构造逻辑。
- `_buildContexts` 是公共方法，所有模式共享父子检索逻辑。

### 设置项扩展

- 每个服务有自己的 `getXxxSettings` / `saveXxxSettings`，新增设置项时在对应函数的默认值中加字段。
- `RETRIEVAL_DEFAULTS` 是常量，包含 mode/topK/scoreThreshold/maxContextChars 4 个字段。
- 设置项变更需要兼容老数据：读取时 `Object.assign({}, DEFAULTS, result[key] || {})` 保证新字段有默认值。

## 注意事项（坑）

### 维度一致性

- 所有预设 embedding 模型强制 1024 维（与向量库 schema 匹配）。
- 切换 embedding 模型导致维度变化时：
  - 本地 IndexedDB 不校验维度，新旧维度向量混存。
  - `localVectorSearch` 的 `cosineSimilarity(a, b)` 在 `a.length !== b.length` 时返回 0（不是 NaN），但点积计算时维度不匹配的项会得到 0 分，等同于不命中。
  - 远程向量库（Milvus/pgvector）schema 固定维度，插入会直接 4xx。
- 用户需手动"清空向量库" + "重建向量索引"，插件不自动清理（见 `lib/embedding.js` 顶部 `_expectedDimension` 字段的长注释）。

### _expectedDimension 来源优先级

- `models.json model.dimension` > `provider.fallbackDimension` > `1024`（默认）。
- `dimensionsParam: true` 时，请求体带 `dimensions: _expectedDimension` 强制模型输出指定维度（适用于 Jina v5 / 智谱 Embedding-3 等可调维度模型）。
- 自定义 provider（不在 models.json）回退到 1024。

### IndexedDB 事务自动关闭

- IDB 事务在所有请求都完成后会自动关闭（`tx.oncomplete`），新请求必须在事务活跃期间发起。
- `db.js` 的 `saveConversation` 在 `getReq.onsuccess` 回调内发起新请求（`convStore.put`），事务仍活跃，OK。
- `clearConvFromIndex` 用 cursor 遍历 + `indexStore.put/delete`，事务活跃，OK。
- 不要在 `tx.oncomplete` 后再发请求，会抛 "Transaction has finished"。

### saveConversation 的增量追加逻辑

- 默认 mode（无 mode 字段）：增量追加，按 `msg.hash` 去重，已有 hash 不重复添加。
- mode='overwrite'：覆盖整个对话的 messages，重建搜索索引。
- mode='updateTitle'：只更新标题，不动 messages（用于会话信息 API 单独更新标题）。
- **思考补充替换**：若新消息含 `<think>`/`<search_result>` 补充且正式回答与已有消息相同，替换原消息而非追加（场景：豆包/千问思考块展开后、搜索来源懒加载后二次采集）。判定条件：同 role + `_stripAugmentBlocks(m.content) === _stripAugmentBlocks(newMsg.content)` + `newMsg.content.length > m.content.length`。
- 改这段逻辑时注意 `_stripAugmentBlocks` 的 4 种剥离格式：`<think>` / `<search_result>` / `【搜索】` / `【来源】`（后两个是千问 DOM 模式标记）。

### triggerEmbedding 的隐式调用

- `db.js` 的 `saveConversation` 在 `tx.oncomplete` 中调用 `triggerEmbedding(convId, newMessages, convMeta)`（不是 `bg/vector-handlers.js` 的 `handleTriggerEmbedding`）。
- 该函数检查 `typeof EmbeddingService === 'undefined'` 跳过（lib 环境下未定义），SW 环境下才会真正嵌入。
- 增量保存时只嵌入 `newMessages`（`action === 'appended'` 时是 newMessages，否则是 messages 全量）。
- 异步执行（`(async () => {...})()`），不阻塞 saveConversation 返回。
- 失败只 `console.error`，不影响对话保存。

### deleteConversation 的向量清理

- `db.js` 的 `deleteConversation` 在 `tx.oncomplete` 中异步调用 `VectorStore.deleteByConvId(id)`。
- 检查 `typeof VectorStore === 'undefined'` 跳过（lib 环境下未定义）。
- 向量清理失败不影响对话删除的成功返回（避免数据不一致）。
- 这是 fire-and-forget 模式，不 await。

### chunkOverlap 必须小于 chunkSize

- `EmbeddingService.setConfig` 中 `this._chunkOverlap = Math.max(0, Math.min(options.chunkOverlap, this._chunkSize - 1))`。
- `chunkText` 中 `const step = size - overlap`，若 overlap >= size 会导致 step <= 0，死循环。
- `popup/settings.js` 也有前端校验：`if (overlap >= size) showToast('切片重叠必须小于切片大小')`。

### localVectorSearch 不校验维度

- `cosineSimilarity(a, b)` 在 `a.length !== b.length` 时返回 0。
- 这意味着切换 embedding 模型后，旧维度向量在搜索时全部得 0 分，等同于不命中——但不会报错。
- 用户感知是"AI 问答召回不到旧对话"，需要手动重建索引。

### _buildThinkingExtras 的复杂性

- 6 厂商（dashscope/deepseek/zhipu/moonshot/doubao/minimax）× 3 思考模式（hybrid/only/none）× 2 开关（enabled/disabled）= 36 种组合。
- 关键差异：
  - `thinkingParam`: `enable_thinking`（dashscope 布尔）vs `thinking`（其他对象）。
  - `thinkingEnabledType`: `enabled`（默认）vs `adaptive`（MiniMax）。
  - `reasoningSplit`: true（MiniMax 需要拆 `reasoning_content` 字段）。
  - `fallbackThinking`: `hybrid`（豆包 Endpoint ID 匹配不上 modelMeta 时用）。
- hybrid 模式关闭时必须显式传 false/disabled，不传会用模型默认值（可能为 true）。
- only 模式强制开启，无法关闭（`openaiEnableThinking.disabled = true` 在 settings.js）。
- 改这段逻辑必须跑 `tests/unit/llm.test.js` 的 `_buildThinkingExtras` 测试，覆盖所有 36 种组合。

### Kimi 的 temperature 强制

- Kimi k2.6/k2.5：思考模式固定 1.0，非思考模式固定 0.6，其他值报错。
- `_chatOpenAIStream` 中：若 `provider.thinkingTemperature !== undefined || provider.nonThinkingTemperature !== undefined`，根据 `isThinking` 选择温度，覆盖用户传入的 `options.temperature`。
- 用户显式传 `options.temperature` 优先级最高（用于 AI Ball 临时切换）。

### MiniMax 的 reasoning_split

- MiniMax 不传 `reasoning_split: true` 时，思考内容混在 content 的 `<think>` 标签内，无法通过 phase='reasoning' 区分。
- `_buildThinkingExtras` 在 extras 存在且 `provider.reasoningSplit` 为 true 时追加 `extras.reasoning_split = true`。

### _parseSSE 的 chunk 调试

- 前 3 个 data 输出 `console.debug` 帮助排查响应格式问题。
- `[DONE]` 跳过（OpenAI 流结束标记）。
- `:` 开头的行跳过（SSE 注释/keep-alive）。
- `event:` 等其他 SSE 字段忽略，只处理 `data:`。
- 解析失败 `console.warn` 但不抛错，继续处理下一条。
- 流结束若 `!fullContent && !fullReasoning`，输出警告帮助排查"响应为空"问题。

### VectorStore.testConnection 的友好错误

- `Failed to fetch` 通常是网络/CORS/URL 问题，翻译成"无法连接（Failed to fetch）。请检查地址是否可达、CORS 是否放行本扩展，以及服务是否在线"。
- 其他错误直接用原始 message。
- 返回 `{ success, latency, count, error }`，latency 是测试耗时（毫秒）。

### _strToQdrantUUID 的确定性

- FNV-1a 哈希（两个独立种子 h1/h2）+ 拼接成 32 字符 hex + 格式化成 UUID。
- 同一 embId 每次映射到同一 UUID，保证幂等。
- 原始字符串 ID 存到 `payload._origId`，便于排查。

### ChromaDB 的 distance function

- ChromaDB 默认 l2（平方欧氏距离），也可能是 cosine 或 ip（内积）。
- `_chromaGetSpace(detail)` 从 collection 详情中依次尝试 `metadata['hnsw:space']` / `configuration.fields['hnsw:space']` / `configuration.hnsw.space`，均缺失时回退 'l2'。
- `_chromaDistanceToScore(space, d)`：
  - cosine: `1 - d`（还原成 cosine similarity ∈ [-1, 1]）。
  - ip: `-d`（还原成内积）。
  - l2: `1 / (1 + d)`（归一化到 (0, 1]，避免高维 L2 距离 >1 时被线性压成 0）。

### Milvus v2 REST API 的成功码

- Milvus v2 REST API 成功码是 200（与 HTTP 状态码一致），不是 0。
- 失败时 HTTP 仍是 200，但 `code !== 200` 或 `message` 非空。
- `_addMilvus` / `_addMilvusBatch` 检查 `!resp.ok || (data?.code !== 200 && data?.code !== 0)`，失败抛 Error。

### pgvector 必须创建 match 函数

- `_searchPgvector` 调用 `/rpc/match_${collection}`，用户需在 PG 中创建该函数。
- 函数签名参考 PostgREST 文档，接收 `query_embedding` 和 `match_count` 参数，返回 `id` / `conv_id` / `similarity` 字段。
- 部署指南见 `docs/pgvector-setup.md`。

### Supabase URL 归一化

- 用户可能填入带 `/rest/v1/` 后缀的完整地址（官方文档/控制台常这样写）。
- `_normalizeSupabaseUrl(url)` 先 `_trimTrailingSlash` 再去 `/rest/v1` 后缀，避免出现 `/rest/v1/rest/v1/` 之类的 404。

### marked 的 KaTeX 兼容

- `popup/popup.js` 的 `renderViewerContent` 在调用 `marked.parse` 前先提取 `$$...$$` / `$...$` 公式为占位符，避免 marked 破坏公式。
- 占位符 `%%BLOCK_${idx}%%` 在 marked 渲染后还原为 KaTeX HTML。
- 改这段逻辑时注意占位符不能与用户内容冲突（`%%` 在 Markdown 中不常见，安全）。

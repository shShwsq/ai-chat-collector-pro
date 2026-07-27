# content/network/ 开发指南

> 网络拦截模式适配器集合：当平台使用 HTTP/SSE 协议且用户选择了网络模式时，由这些适配器从 `network-interceptor.js` 拦截到的 fetch/XHR 响应中解析对话数据。Kimi 不在此目录（WebSocket + protobuf 不可拦截）。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录的网络适配器是"采集链路的协议层"，与软件侧 [knowledge-work-assistant](../../../knowledge-work-assistant/DEVELOPMENT.md) 的对接关系如下：

- **平台 ID 对齐**：本目录 4 个适配器（`deepseek.js`/`doubao.js`/`qianwen.js`/`fudan.js`，**无 Kimi**）注册到 `window.NETWORK_ADAPTERS[platformName]` 的 `name` 字段，与 KWA 后端 [routers/plugin.py](../../../knowledge-work-assistant/backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 白名单取交集。
- **对话格式契约**：`common.js` 的 `buildAssistantContent(thinking, search, answer)` 是三段式拼接的"权威实现"，被 DOM 适配器与网络适配器共同遵循；KWA 后端 [services/graph_agent.py](../../../knowledge-work-assistant/backend/app/services/graph_agent.py) 据此解析思考/搜索/回答三段式。改 `buildAssistantContent` 必须同步 KWA 后端解析逻辑。
- **历史消息解析**：`fetchConversation(convId)` 通过 `fetchViaInterceptor` 让 MAIN world 拦截器主动请求历史对话 API，保证用户切换到历史对话时也能完整采集并推送到 KWA 后端。
- **保存后推送**：网络模式采集成功后由 `exporter-base.js` 调 SW `SAVE_CONVERSATION`，启用对接时由 `bg/local-app.js` 自动推送（详见 `bg/local-app.js` 的 `LocalApp_pushByConvId`）。
- **Kimi 不在此目录**：Kimi 走 WebSocket + protobuf，网络拦截无法解析，故本目录无 `kimi.js`；但 KWA 后端 `SUPPORTED_PLATFORMS` 仍包含 `kimi`（由 DOM 适配器采集后推送）。

跨子工程任务（新增平台、调整对话格式等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

- **公共工具函数**（`common.js`）：提供 `buildAssistantContent`（思考/搜索/回答三段式拼接）、`parseRequestBody`（从 POST body 提取 sessionId 和用户消息）、`buildConversationResult`（构建标准对话结果对象）、`fetchViaInterceptor`（通过 postMessage 让 MAIN world 拦截器发起主动请求）。
- **平台网络适配器**：每个平台一个文件（DeepSeek/豆包/千问/复旦，**无 Kimi**），注册到 `window.NETWORK_ADAPTERS[platformName]`，提供 `matchApi(url)` / `parse(url, data, requestBody)` / `fetchConversation(convId)` 等方法。
- **SSE 流式响应解析**：DeepSeek 用自定义 patch 协议（`{p, o, v}` 路径操作），豆包用 `event:` 类型化 SSE（`CHUNK_DELTA` / `STREAM_CHUNK` / `STREAM_MSG_NOTIFY` 等），千问和复旦用标准 `data:` SSE。
- **历史消息解析**：从平台的历史对话 API 响应中提取完整对话（含思考、搜索、回答），用于切换到历史对话时的完整采集。
- **标题缓存与更新**：豆包/千问/复旦有独立的会话信息 API，适配器缓存标题到模块级对象（如 `_conversationTitles` / `_qianwenSessionTitles` / `_fudanSessionTitles`），历史消息解析时取用。
- **主动重采**：用户删除对话后，`exporter-base.js` 调用 `adapter.fetchConversation(convId)`，适配器通过 `fetchViaInterceptor(url)` 让 MAIN world 拦截器发起 GET 请求，响应再走正常解析流程。

## 关键文件

| 文件 | 职责 | 重要函数/类 |
|------|------|-------------|
| `common.js` | 公共工具函数 | `buildAssistantContent(thinking, search, answer)`、`parseRequestBody(requestBody, sessionFields, queryFields)`、`buildConversationResult(id, title, messages)`、`fetchViaInterceptor(url)` |
| `deepseek.js` | DeepSeek 网络适配器（自定义 patch SSE + 历史消息） | `NETWORK_ADAPTERS.deepseek`：`matchApi`、`parse`、`fetchFullHistory(sessionId)`、`fetchConversation(convId)`、`parseMessages(url, data)`；模块级 `parseStream(url, data, requestBody)`、`applyAtPath(state, pathParts, operation, value)`、`resolveIndex(arr, key)`、`_fetchedSessions` Set |
| `doubao.js` | 豆包网络适配器（类型化 SSE + content_block 协议） | `NETWORK_ADAPTERS.doubao`：`matchApi`、`parse`、`fetchConversation(convId)`；模块级 `parseConversationInfo(data)`、`parseHistoryMessages(data, requestBody)`、`extractTextFromContentBlocks(blocks)`、`parseAssistantContentBlocks(blocks)`、`parseDoubaoStream(url, data, requestBody)`、`_conversationTitles` 对象、`_fetchedConversations` Set |
| `qianwen.js` | 千问网络适配器（标准 SSE + multi_load 协议） | `NETWORK_ADAPTERS.qianwen`：`matchApi`、`parse`、`fetchConversation(convId)`；模块级 `parseSessionInfo(url, data)`、`parseMessages(url, data)`、`parseStream(url, data, requestBody)`、`extractSources(sources)`、`formatSources(sourceItems)`、`_qianwenSessionTitles` 对象 |
| `fudan.js` | 复旦 AI Agent 网络适配器（标准 SSE + 历史消息） | `NETWORK_ADAPTERS.fudan`：`matchApi`、`parse`、`fetchConversation(convId)`；模块级 `parseHistory(data)`、`parseStream(url, data, requestBody)`、`_fudanSessionTitles` 对象 |

## 开发工作流

### 改代码的典型流程

1. 修改 `content/network/` 下相关文件。
2. 打开 `chrome://extensions` → 重新加载扩展。
3. 回到目标平台页面，**Ctrl+Shift+R 强制刷新**——网络拦截器必须在 `document_start` 注入，错过初始请求就拦不到。
4. 打开 DevTools Console，过滤日志前缀：`[DeepSeek/Debug]`、`[DeepSeek/Stream]`、`[Doubao/Stream]`、`[Qianwen/Stream]`、`[Fudan/Stream]`、`[Exporter/Debug]`、`[NetworkInterceptor]`。

### 调试技巧

- **检查网络适配器是否注册**：Console 执行 `Object.keys(window.NETWORK_ADAPTERS)`，应返回当前平台的数组（如 `['deepseek']`）。Kimi 页面应返回 `[]`。
- **检查拦截器是否安装**：Console（`top` 上下文）执行 `window.__AI_CHAT_INTERCEPTOR_INSTALLED__`，应为 `true`。
- **观察拦截到的请求**：发送对话时 Console 应出现 `[Exporter/Debug] 收到拦截数据: source=fetch, url=..., bodyLength=..., hasRequestBody=...`。若无此日志，说明拦截器未捕获请求（检查 `matchApi` 是否匹配 URL）。
- **跟踪解析流程**：`[Exporter/Debug] parseResponse: URL匹配成功` → `[DeepSeek/Stream] 提取到对话: sessionId=..., userQuery=..., hasThinking=..., hasSearch=..., hasAnswer=...` → `[Exporter] 保存成功`。
- **查看主动请求**：删除对话后切换回该对话，Console 应出现 `[DeepSeek/Debug] fetchFullHistory: sessionId=..., url=...` 和 `fetchFullHistory postMessage 已发送`。
- **诊断报告**：调用 `exporter.diagnose()`（需临时挂到 window）查看 `interceptor.requestCount` / `parseSuccessCount` / `parseFailCount` / `conversationsCount`。

## 代码约定

### 适配器注册模式

网络适配器文件顶部直接赋值到全局 `NETWORK_ADAPTERS`（由 `adapter-registry.js` 初始化为 `{}`）：

```javascript
// network/deepseek.js
NETWORK_ADAPTERS.deepseek = {
  name: 'deepseek',
  matchApi: (url) => { /* 返回 boolean，判断 URL 是否为本平台 API */ },
  parse: (url, data, requestBody) => { /* 解析响应，返回对话对象或 null */ },
  fetchConversation: async (convId) => { /* 主动请求历史，返回 null */ },
  // 平台特有方法...
};
```

**模块级函数和变量**：`parseStream` / `parseHistory` 等解析函数定义在模块顶层（非适配器对象内），通过闭包共享 `_fetchedSessions` / `_conversationTitles` 等状态。适配器方法内调用这些函数时直接用函数名（如 `parseStream(url, data, requestBody)`），不用 `this`。

### 适配器接口约定

`exporter-base.js` 的 `parseResponse()` 调用适配器的方法顺序：

1. `adapter.matchApi(url)` → 返回 false 则忽略该响应。
2. `adapter.parse(url, data, requestBody)` → 返回值规则：
   - `null`：忽略（如标题缓存 API、缓存命中但已请求过）。
   - `{ id, title, messages, url }`：标准对话对象，触发保存。
   - `{ titleUpdate: true, id, title, url }`：仅更新标题（豆包会话信息 API 用），不覆盖消息。
3. `adapter.fetchConversation(convId)`（可选）：删除对话后主动重采，内部调 `fetchViaInterceptor(url)` 发起 GET，响应由拦截器异步处理，函数本身返回 `null`。

### DOM 模式 vs 网络模式的选择逻辑

- 网络模式要求平台用 HTTP/SSE 协议（可被 `fetch` / `XMLHttpRequest` 拦截），WebSocket 平台（Kimi）**不可用**。
- `content/kimi.js` 不调用 `getPlatformMode`，直接硬编码 DOM 模式；`manifest.json` 中 Kimi 不加载 `network-interceptor.js` 和 `network/` 下任何文件。
- 其他四个平台（DeepSeek/豆包/千问/复旦）由用户在设置中选择模式，默认 DOM（兼容性更好）。
- 网络模式优势：能拿到搜索来源的完整摘要（DOM 模式豆包/千问不渲染摘要）、不被虚拟滚动限制（豆包 DOM 模式长对话丢失）。
- 网络模式劣势：依赖拦截器在 `document_start` 注入，错过初始请求就拦不到；SSE 协议复杂，平台改版易出错。

### 平台命名约定

文件名与 platformName 严格一致：`deepseek.js` → `NETWORK_ADAPTERS.deepseek`。**无 `kimi.js`**——Kimi 不支持网络模式，若新建该文件不会被 manifest 加载。

### 助手消息内容拼接格式

所有适配器的 `parse` 必须通过 `buildAssistantContent(thinking, search, answer)` 拼接助手消息内容（定义在 `common.js`）：

```
<think>
思考内容...
</think>

<search_result>
搜索来源...
</search_result>

正式回答...
```

- 三部分均**可选**，`buildAssistantContent` 自动跳过空部分。
- 搜索来源格式各平台略有差异：
  - DeepSeek/复旦：`【标题】\nURL\n摘要`
  - 豆包：`【标题】 (站点名)\nURL\n摘要`
  - 千问：`[站点名: 标题](URL)\n> 摘要前200字`（Markdown 链接格式）
- **不要在适配器中直接拼接字符串**，必须调 `buildAssistantContent`，保证与 DOM 模式输出格式一致（`viewer.js` 和 `ai-ball.js` 依赖此格式渲染可折叠块）。

### SSE 流式响应解析约定

各平台 SSE 协议差异：

| 平台 | SSE 格式 | 关键事件/字段 |
|------|----------|---------------|
| DeepSeek | 自定义 patch 协议 | `{p, o, v}` 路径操作（SET/APPEND/BATCH），`event: title` 提取标题 |
| 豆包 | 类型化 SSE | `event: SSE_ACK` / `FULL_MSG_NOTIFY` / `STREAM_MSG_NOTIFY` / `STREAM_CHUNK` / `CHUNK_DELTA` / `SSE_HEARTBEAT` / `SSE_REPLY_END` |
| 千问 | 标准 `data:` SSE | 每个 chunk 是 `{data: {messages: [...]}, communication: {sessionid}}` |
| 复旦 | 标准 `data:` SSE | 每个 chunk 是 `{e: 0|1, d: {answer, ext: {site_search, runtime_node_output}}}`，`e=1` 为结束块 |

**解析流程**：按行分割 → 跳过空行和非 `data:` 行 → JSON.parse → 按平台协议提取字段 → 累积 thinking/search/answer → 调 `buildAssistantContent` 拼接 → 调 `buildConversationResult` 构建。

### 历史消息解析约定

历史消息 API 返回的对话通常是**完整对话**（多条消息），`parse` 返回的对话对象 `messages` 数组按时间升序排列。`exporter-base.js` 对历史消息采用「覆盖模式」（`mode: 'overwrite'`），流式响应采用「追加模式」（`mode: 'append'`）。

## 常见任务

### 任务 1: 适配平台 API 改版

**场景**：平台升级 API，原有的 URL 路径或响应结构变化，网络模式无法解析。

**步骤**：
1. 打开平台页面，DevTools Network 面板发送一条对话，找到新的 API 请求（通常是 `/chat/completion` 或 `/api/v2/chat` 等）。
2. Console 检查拦截日志：`[Exporter/Debug] 收到拦截数据: url=...` 中的 URL 是否被 `matchApi` 匹配。
3. 若 URL 不匹配，编辑 `network/{platform}.js` 的 `matchApi`，添加新 URL 模式：
   ```javascript
   matchApi: (url) => {
     return url.includes('/chat/history_messages') ||
            url.includes('/chat/completion') ||
            url.includes('/new-api-path');  // 新增
   }
   ```
4. 若 URL 匹配但 `parse` 返回 null，检查响应结构：在 `parse` 函数开头加 `console.log('[Platform/Debug] parse input:', url, typeof data, data?.substring?.(0, 200))`。
5. 根据新响应结构调整 `parseStream` / `parseMessages` 中的字段提取路径。

**验证**：发送对话，Console 应出现 `[Platform/Stream] 提取到对话: sessionId=..., hasThinking=..., hasAnswer=...` 和 `[Exporter] 保存成功`。

### 任务 2: 调试 DeepSeek patch 协议解析

**场景**：DeepSeek 流式响应解析后 `answer` 为空，但 SSE 数据中确实有内容。

**步骤**：
1. 在 `parseStream` 函数末尾加 `console.log('[DeepSeek/Stream] final state:', JSON.stringify(state).substring(0, 500))`，查看 `state.response.fragments` 是否有 `RESPONSE` 类型片段。
2. 若 fragments 为空，说明 patch 操作没有正确应用到 `state.response.fragments`：
   - 检查 `applyAtPath` 的路径导航是否正确（如 `response/fragments/0/content`）。
   - 检查 `lastAppendPath` 是否追踪到了正确的 content APPEND 路径（无路径简写 `{"v":"text"}` 依赖此变量）。
3. 若 fragments 有内容但 `frag.content` 为空，检查 patch 的 `o` 操作是否为 `APPEND`（`SET` 会覆盖而非追加）。
4. DeepSeek 的 patch 协议特殊点：`{"v":"text"}` 无路径简写会追加到 `lastAppendPath` 指向的 content 路径——若 `lastAppendPath` 为 null（如第一个 patch 就是简写），文本会丢失。

**验证**：`state.response.fragments` 应包含 `{type: 'RESPONSE', content: '...'}`，且 `answer` 非空。

### 任务 3: 调试豆包 content_block 归类

**场景**：豆包助手消息的思考内容被误归类为正式回答，或反之。

**步骤**：
1. 检查 `thinkingBlockIds` Set 是否正确收集了思考块 ID：在 `STREAM_MSG_NOTIFY` 和 `STREAM_CHUNK` 事件中，`block_type === 10040` 的 `block_id` 应加入此 Set。
2. 检查文本块（`block_type === 10000`）的 `parent_id` 归类：
   - `parent_id` 指向 thinking_block → 思考正文
   - 无 `parent_id` → 正式回答
3. 豆包特殊点：回答开头通过 `STREAM_CHUNK` 发送（累积式），后续增量通过 `CHUNK_DELTA` 发送。`finalAnswer` 合并时需检查重叠：
   ```javascript
   if (answerText.startsWith(answerStreamChunks)) {
     finalAnswer = answerText;  // CHUNK_DELTA 包含全部
   } else {
     finalAnswer = answerStreamChunks + answerText;  // 拼接
   }
   ```

**验证**：`finalThinking` 和 `finalAnswer` 应分别非空（若对话含思考），且不重叠。

### 任务 4: 实现新平台网络适配器

**场景**：接入新 AI 平台（HTTP/SSE 协议），需实现网络模式。

**步骤**：
1. 在 `content/network/` 下新建 `{platform}.js`，复制 `qianwen.js` 模板（标准 SSE，结构最清晰）。
2. 实现三个核心方法：
   - `matchApi(url)`：用 `url.includes('/api/path')` 匹配平台 API。
   - `parse(url, data, requestBody)`：按 URL 分流到 `parseStream` / `parseMessages`。
   - `fetchConversation(convId)`：调用 `fetchViaInterceptor(url)` 发起主动请求。
3. 实现 `parseStream(url, data, requestBody)`：
   - 按 `\n` 分割 SSE 文本，提取 `data:` 行的 JSON。
   - 按平台协议提取 thinking / search / answer / sessionId / userQuery。
   - 调 `buildAssistantContent` 和 `buildConversationResult` 返回。
4. 实现 `parseMessages(url, data)`（若有历史消息 API）：
   - 遍历消息列表，按角色提取内容。
   - 消息列表通常是倒序的（最新在前），需 `reverse()`。
5. 注册到 `NETWORK_ADAPTERS.{platform}`。
6. 在 `manifest.json` 的对应平台 content_scripts 中加载此文件（在 `network/common.js` 之后）。

**验证**：刷新页面，发送对话，Console 应出现 `[Platform/Stream] 提取到对话: ...` 和 `[Exporter] 保存成功`。

### 任务 5: 修复标题缓存失效问题

**场景**：导出的对话标题为空，但平台页面侧边栏显示有标题。

**步骤**：
1. 检查标题缓存机制：
   - 豆包：`_conversationTitles` 由 `parseConversationInfo`（`/im/conversation/info` API）填充。
   - 千问：`_qianwenSessionTitles` 由 `parseSessionInfo`（`/v1/session/get` 或 `/v2/session/page/list` API）填充。
   - 复旦：`_fudanSessionTitles` 由 `parseHistory` 中的 `session_info` / `update_session_title` API 填充。
2. 若标题 API 未被拦截（`matchApi` 未匹配），添加新 URL 模式。
3. 若标题 API 已拦截但 `_xxxTitles` 未填充，检查 `parse` 函数中字段路径是否正确（如 `data.d.title` vs `data.data.title`）。
4. 豆包特殊点：`/im/conversation/info` 返回 `{titleUpdate: true, id, title}`，`exporter-base.js` 收到后只更新标题不覆盖消息——这解决了 `chain/single` 早于 `conversation/info` 到达导致标题为空的问题。

**验证**：切换到历史对话，Console 应出现 `[Platform/Title] 缓存标题: ... -> ...`，导出对话标题非空。

### 任务 6: 处理流式响应的消息去重

**场景**：流式响应被拦截多次（如分块传输），导致重复保存相同消息。

**步骤**：
1. `exporter-base.js` 的 `parseResponse()` 已实现 hash 去重：
   - 流式响应采用「追加模式」，与内存中已有数据合并，只发送 `capturedHashes` 中没有的新消息。
   - `messageHash(role, content)` 是简单 hash 函数，相同 role+content 返回相同 hash。
2. 若仍出现重复，检查 `adapter.parse` 是否返回了重复消息：
   - 流式响应每次解析全量消息（如 DeepSeek 的 `state.response.fragments` 累积所有片段），`parseStream` 应返回当前全量，由 `exporter-base.js` 负责去重。
   - **不要在适配器内自己做去重**——`exporter-base.js` 的 `capturedHashes` 是唯一去重点。
3. 历史消息响应采用「覆盖模式」（`mode: 'overwrite'`），直接替换内存和存储，不走 hash 去重。

**验证**：发送一条对话，Console 应出现 `[Exporter] 合并流式消息到对话 ...: +N 条`，N 为新增消息数（通常 1-2 条）。

## 扩展点

### 新增一个 AI 平台网络适配器

详见「任务 4」。关键约束：

- **必须实现 `matchApi` 和 `parse`**：`matchApi` 返回 false 的响应直接丢弃；`parse` 返回 null 也丢弃，返回对话对象则保存。
- **可选实现 `fetchConversation`**：未实现时删除对话后无法主动重采，需用户手动刷新页面触发自然加载。
- **必须用 `buildAssistantContent` 拼接助手内容**：不要手动拼字符串，否则 `viewer.js` 渲染会异常。
- **必须用 `buildConversationResult` 构建返回对象**：保证 `id` / `title` / `messages` / `url` 字段齐全。
- **SSE 解析必须容错**：`JSON.parse` 失败时 `continue` 跳过该行，不要让整个解析崩溃。
- **WebSocket 平台不要在此目录新建文件**：网络拦截器无法解析 WebSocket 帧，强制走 DOM 模式（参考 Kimi）。

### 扩展 html-to-markdown 的解析规则

网络模式不直接用 `html-to-markdown.js`——响应中的思考/回答通常是纯文本或 Markdown，无需 HTML 转换。但若平台 API 返回 HTML 富文本（罕见），可在适配器内调用 `window.HtmlToMarkdown.convert(tempEl)`（需先将 HTML 字符串塞进临时 DOM 元素）。一般情况下**不需要扩展 html-to-markdown**，直接保存纯文本/Markdown 即可。

## 注意事项（坑）

- **平台 DOM 结构变更的脆弱性**：网络模式相对 DOM 模式更稳定（API 协议比 CSS 类名改版频率低），但仍受平台后端 API 改版影响。**字段路径变化**（如 `data.d.biz_data.chat_messages` → `data.d.chat_messages`）是最常见的失效原因。日志中加了 `[Platform/Debug] parse input:` 等诊断日志便于排查。
- **Kimi 特殊性**：
  - **不在本目录**——Kimi 走 WebSocket + protobuf，网络拦截完全不可用。
  - `manifest.json` 中 Kimi 的 content_scripts 不加载 `network-interceptor.js`、`network/common.js`、`network/kimi.js`（该文件不存在）。
  - 若误在 Kimi 页面加载网络适配器，`NETWORK_ADAPTERS.kimi` 为 undefined，`exporter-base.js` 的 `getNetworkAdapter()` 返回 null，网络模式下降级为 DOM 模式（但 Kimi 入口硬编码 DOM，不会触发此路径）。
- **turndown 插件加载顺序**：网络模式**不依赖 turndown**（响应是纯文本/Markdown），但 `manifest.json` 仍加载 turndown 库（DOM 模式需要）。网络适配器文件不要在顶层调用 `TurndownService`，避免 Kimi 页面（不加载 turndown）报错。
- **KaTeX 反向解析的 fallback 逻辑**：网络模式**不需要**反向解析——API 响应中的数学公式是原始 LaTeX 文本（如 `$E=mc^2$`），直接保存即可。`html-to-markdown.js` 和 `katex-html-to-latex.js` 仅用于 DOM 模式。但 `viewer.js` 渲染时若检测到 `$...$` / `$$...$$` 会调 KaTeX 渲染，因此网络模式保存的内容必须用 `$` 包裹公式（不要用 `\(` `\)` 等 LaTeX 定界符）。
- **`network-interceptor.js` 必须在 MAIN world**：`manifest.json` 中网络适配器对应的 content_script 条目必须 `world: MAIN`，`run_at: document_start`，且单独一条。若与默认 world 脚本混在一起，拦截器无法重写页面的 `fetch` / `XMLHttpRequest`（默认 world 是隔离的 content script 世界，重写不影响页面）。
- **DeepSeek patch 协议的 `lastAppendPath` 陷阱**：DeepSeek 的无路径简写 `{"v":"text"}` 依赖 `lastAppendPath` 追踪最近一次 content APPEND 路径。若第一个 patch 就是简写（罕见），`lastAppendPath` 为 null，文本会丢失。**修复方案**：若 `lastAppendPath` 为 null，默认追加到 `response/fragments/-1/content`（最后一个片段的 content）。
- **豆包 `STREAM_CHUNK` 与 `CHUNK_DELTA` 的重叠**：豆包回答开头通过 `STREAM_CHUNK` 累积发送（如 `### 基本信息\n文`），后续增量通过 `CHUNK_DELTA` 发送。`finalAnswer` 合并时必须检查 `answerText.startsWith(answerStreamChunks)`——若 `CHUNK_DELTA` 包含了 `STREAM_CHUNK` 的全部内容（如重新发送完整文本），直接用 `CHUNK_DELTA`；否则拼接。**不要简单相加**，会导致开头内容重复。
- **千问 `multi_load/iframe` 的累积式内容**：千问的 `multi_load/iframe` 类型消息每个 chunk 包含完整内容（累积式），不是增量。`parseStream` 中取最后一个 chunk 的 content 即可，不要拼接所有 chunk（会重复）。`plan_cot/post`（思考内容）同理，优先取 `status: 'complete'` 的，否则取最后一个。
- **复旦 `<think>` 标签解析**：复旦的流式响应中思考内容用 `<think>...</think>` 标签包裹在 `answer` 字段内，`parseStream` 需用正则 `/<think\s*>([\s\S]*?)<\/think>/` 提取思考，剩余部分作为回答。这与 DeepSeek/豆包/千问的「思考是独立字段」不同——复旦把思考嵌在回答里。
- **`_fetchedSessions` / `_fetchedConversations` 去重 Set**：DeepSeek 和豆包用模块级 Set 避免重复主动请求同一对话。**Set 在页面刷新后清空**（模块重新加载），因此刷新页面后会重新请求一次历史，这是正常行为。若发现历史对话被反复请求，检查 Set 是否正确添加（`_fetchedSessions.add(sessionId)` 在 `fetchFullHistory` 调用前）。
- **`titleUpdate` 机制的时序依赖**：豆包的 `conversation/info` API 可能晚于 `chain/single`（历史消息）到达，导致历史消息保存时标题为空。`parseConversationInfo` 返回 `{titleUpdate: true, ...}`，`exporter-base.js` 收到后只更新标题不覆盖消息——**不要移除此机制**，否则豆包对话标题会大量丢失。

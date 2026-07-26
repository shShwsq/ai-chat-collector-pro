# content/ 根目录 开发指南

> 浏览器扩展 content script 主入口层：负责适配器注册表、导出器基类、主世界网络拦截器、AI 问答悬浮球，以及五个 AI 平台（Kimi / DeepSeek / 豆包 / 千问 / 复旦）的入口脚本。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录是 collector 在宿主页面注入的"采集触角"，与软件侧 [knowledge-work-assistant](../../knowledge-work-assistant/DEVELOPMENT.md) 的对接关系如下：

- **平台 ID 对齐**：本目录 5 个平台入口文件（`kimi.js`/`deepseek.js`/`doubao.js`/`qianwen.js`/`fudan.js`）的 `platformName` 与 KWA 后端 [routers/plugin.py](../../knowledge-work-assistant/backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 白名单取交集；推送时 `metadata.platform` 必须命中白名单（`chatgpt`/`claude`/`gemini`/`deepseek`/`qwen`/`doubao`/`kimi`/`fudan`/`custom`）。
- **对话格式契约**：`exporter-base.js` 的 `saveConversation()` 写入本地 IndexedDB 时使用 `## 用户`/`## 助手` 分段的 Markdown；二次开发推送后，KWA 后端 `graph_agent` 据此解析角色与内容（详见 [services/graph_agent.py](../../knowledge-work-assistant/backend/app/services/graph_agent.py)）。改格式需两侧同步。
- **采集事件触发推送**：`ChatExporterBase.saveConversation()` 成功后会派发采集事件；应用 [plugin-sdk/secondary-dev/kwa-push-handler.js](../../knowledge-work-assistant/plugin-sdk/secondary-dev/kwa-push-handler.js) patch 后，该事件会被监听并触发 `KwaPush.pushConversation()` 推送。
- **UI 风格统一**：应用 [plugin-sdk/ui/kwa-plugin.css](../../knowledge-work-assistant/plugin-sdk/ui/kwa-plugin.css) patch 后，本目录的 `ai-ball.js` 与 `content/ui/` 悬浮球颜色会随 KWA 模式（study 墨绿 / work 琥珀）联动（CSS 变量 `--kwa-accent`）。
- **独立运行能力**：默认行为下（未应用 patch），本目录所有逻辑独立运行，不依赖 KWA 后端；KWA 后端不在线时采集功能不受影响。

跨子工程任务（启用推送、新增平台、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

- **常量与注册表**：定义 `EXTRACTION_MODE`（NETWORK / DOM 两种提取模式）和两个全局适配器表 `window.NETWORK_ADAPTERS` / `window.DOM_ADAPTERS`，供 `network/` 与 `dom/` 子目录中的适配器文件挂载。
- **平台启用与模式查询**：通过 `chrome.storage.local` 读取 `platformSettings` 判断平台是否启用；通过 `chrome.runtime.sendMessage({ type: 'GET_SETTINGS', category: 'platformModes' })` 向 background 查询每个平台的提取模式（默认 DOM，扩展重载后上下文失效时也降级 DOM）。
- **导出器基类 `ChatExporterBase`**：所有平台共用的导出器骨架——初始化网络拦截器、URL 监听、DOM MutationObserver、悬浮球 UI、消息去重（hash）、保存对话到 background、模式切换、诊断报告。
- **主世界网络拦截器**：在页面 `MAIN` world 重写 `fetch` 与 `XMLHttpRequest`，将响应体通过 `window.postMessage` 转发回 content script，并保存最近一次请求的认证 headers 供主动重发使用。
- **AI 问答悬浮球 `AIBall`**：紫色渐变球 + 面板 UI，包含「整理信息 / 生成测验 / 自由问答」三个 Tab，与 background 的 LLM 流式接口对接；面板使用 Shadow DOM 隔离样式，注入 KaTeX CSS 渲染数学公式；内置做题模式（解析 `<!--QUIZ_DATA ...-->` JSON 块）。
- **平台入口**：每个平台一个文件（`kimi.js` / `deepseek.js` / `doubao.js` / `qianwen.js` / `fudan.js`），统一流程为「检查启用 → 查询模式 → `new ChatExporterBase(platformName, mode)` → `new AIBall()`」。

## 关键文件

| 文件 | 职责 | 重要函数/类 |
|------|------|-------------|
| `adapter-registry.js` | 定义提取模式常量、全局适配器注册表、平台启用/模式查询 | `EXTRACTION_MODE`、`isPlatformEnabled(platformName)`、`getPlatformMode(platformName)`、`DEFAULT_ENABLED_PLATFORMS`（仅 `fudan`） |
| `exporter-base.js` | 导出器基类，串联适配器、拦截器、URL 监听、保存逻辑 | `class ChatExporterBase`、`getNetworkAdapter()`、`getDomAdapter()`、`setupInterceptor()`、`parseResponse()`、`exportFromNetwork()`、`exportFromDom()`、`captureCurrentConversation()`、`saveConversation()`、`switchMode()`、`diagnose()`、`getConvIdFromUrl()` |
| `network-interceptor.js` | MAIN world 拦截 fetch/XHR，转发响应给 content script | 顶层 IIFE，重写 `window.fetch` 与 `window.XMLHttpRequest`；监听 `__AI_CHAT_FETCH_REQUEST__` 主动发起请求；保存 `lastAuthHeaders` |
| `ai-ball.js` | AI 问答悬浮球 + 面板，三 Tab + 做题模式 + 流式渲染 | `class AIBall`、`createBall()`、`createPanel()`、`handleSend()`、`_renderMarkdown()`、`_parseQuizData()`、`_startQuizMode()`、`_onStreamComplete()`、`_saveToHistory()` |
| `kimi.js` | Kimi 平台入口 | IIFE：`isPlatformEnabled('kimi')` → 固定 `EXTRACTION_MODE.DOM` → `new ChatExporterBase('kimi', DOM)` |
| `deepseek.js` | DeepSeek 平台入口 | IIFE：`isPlatformEnabled('deepseek')` → `getPlatformMode('deepseek')` → `new ChatExporterBase('deepseek', savedMode)` |
| `doubao.js` | 豆包平台入口 | IIFE：同 DeepSeek 流程，platformName=`'doubao'` |
| `qianwen.js` | 千问平台入口 | IIFE：同 DeepSeek 流程，platformName=`'qianwen'` |
| `fudan.js` | 复旦 AI Agent 平台入口 | IIFE：同 DeepSeek 流程，platformName=`'fudan'`；默认启用平台 |

## 开发工作流

### 改代码的典型流程

1. 修改 `content/` 下相关文件（适配器逻辑在 `dom/` 或 `network/`，UI 在 `ui/`）。
2. 打开 `chrome://extensions`，找到 ai-chat-collector，点击「重新加载」按钮（图标刷新）。
3. 回到目标 AI 平台页面（如 `https://chat.deepseek.com/`），**强制刷新（Ctrl+Shift+R）**——content script 只在页面加载时注入一次，扩展重载后旧页面仍持有失效的 `chrome.runtime` 上下文，必须刷新页面让新脚本生效。
4. 打开 DevTools Console 验证日志：所有模块都打了 `[Exporter]`、`[Exporter/Debug]`、`[Kimi/DOM]`、`[DeepSeek/Stream]` 等前缀日志，便于过滤。

### 调试技巧

- **content script 调试**：在目标平台页面 DevTools Console 顶部下拉选择 `ai-chat-collector` 上下文（不是 `top`），即可访问 `window.DOM_ADAPTERS`、`window.NETWORK_ADAPTERS`、`ChatExporterBase` 实例（若挂载到 window）等。
- **MAIN world 拦截器调试**：DevTools Console 默认上下文即 `top`（页面主世界），可直接查看 `window.__AI_CHAT_INTERCEPTOR_INSTALLED__`、`lastAuthHeaders`（闭包内不可见，但可观察 postMessage）。
- **扩展上下文失效判断**：在 Console 执行 `chrome.runtime.id`，若为 `undefined` 说明扩展已重载，需要刷新页面。
- **网络模式诊断**：调用 `exporter.diagnose()` 可输出当前模式、适配器加载状态、拦截器请求计数、对话捕获数等诊断信息（但 `exporter` 实例未挂到 window，需在代码中临时加 `window.__exporter = exporter` 调试）。

## 代码约定

### 适配器注册模式

适配器注册**不是函数式 API**，而是直接给全局对象赋值：

```javascript
// adapter-registry.js 中初始化
window.NETWORK_ADAPTERS = {};
window.DOM_ADAPTERS = {};

// dom/deepseek.js 中注册
if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};
DOM_ADAPTERS.deepseek = { name: 'deepseek', getConversationId, getTitle, isStreaming, extractMessages, _extractXxx... };

// network/deepseek.js 中注册
NETWORK_ADAPTERS.deepseek = { name: 'deepseek', matchApi, parse, fetchConversation, ... };
```

`exporter-base.js` 通过 `window.NETWORK_ADAPTERS[this.platformName]` 和 `window.DOM_ADAPTERS[this.platformName]` 按平台名取适配器。**没有 `registerAdapter` 函数**，新增平台只需在适配器文件中赋值即可，但必须在 `manifest.json` 的 `content_scripts` 中按依赖顺序声明脚本。

### DOM 模式 vs 网络模式的选择逻辑

- 用户在 popup 设置页为每个平台选择模式，存到 `chrome.storage.local` 的 `platformModes`。
- 平台入口调用 `getPlatformMode(platformName)`，内部通过 `chrome.runtime.sendMessage({ type: 'GET_SETTINGS', category: 'platformModes' })` 向 background 查询。
- **降级规则**（重要）：
  - `chrome.runtime.id` 为 undefined（扩展重载后旧 content script）→ 降级 DOM 模式
  - `chrome.runtime.lastError`（消息失败）→ 降级 DOM 模式
  - background 返回 error 或空 → 降级 DOM 模式
  - 默认值本身就是 DOM 模式（兼容性更好，不依赖拦截器启动）
- **Kimi 是特例**：不查 `getPlatformMode`，入口文件直接硬编码 `EXTRACTION_MODE.DOM`，因为 Kimi 走 WebSocket + protobuf，网络拦截无法解析。`manifest.json` 中 Kimi 的 content_scripts 不加载 `network-interceptor.js`、`network/common.js`、`network/kimi.js`（该文件不存在）。

### 平台命名约定

五个平台 ID（platformName）在所有文件中保持小写英文一致：

| platformName | 平台中文名 | 入口域名 | 是否支持网络模式 |
|--------------|------------|----------|------------------|
| `kimi` | Kimi | kimi.com / www.kimi.com / kimi.moonshot.cn | ❌ 仅 DOM |
| `deepseek` | DeepSeek | chat.deepseek.com | ✅ |
| `doubao` | 豆包 | www.doubao.com | ✅ |
| `qianwen` | 千问 | www.qianwen.com | ✅ |
| `fudan` | 复旦 AI Agent | aiagent.fudan.edu.cn | ✅（默认启用） |

`DEFAULT_ENABLED_PLATFORMS = new Set(['fudan'])`——只有复旦平台默认开启对话提取，其他平台需要用户在设置中显式启用。

### 脚本加载顺序（manifest.json 约束）

每个平台的 content_scripts 按以下顺序加载（以 DeepSeek 为例）：

1. `content/network-interceptor.js` —— **单独的 content_script 条目，`world: MAIN`，`run_at: document_start`**，必须最早执行以拦截初始 API 请求。
2. 第三方库：`lib/marked.min.js`、`lib/katex.min.js`、`lib/turndown.min.js`、`lib/turndown-plugin-gfm.js`
3. `content/adapter-registry.js`（定义 EXTRACTION_MODE、DOM_ADAPTERS、NETWORK_ADAPTERS）
4. `content/ui/styles.js`、`content/ui/viewer.js`、`content/ui/floating-ball.js`（UI 组件，ChatExporterBase 在 initUi 中 `new FloatingBall(this)`）
5. `content/ai-ball.js`（AIBall 类，入口文件中 `new AIBall()`）
6. `content/exporter-base.js`（ChatExporterBase 类）
7. `content/network/common.js`（Kimi 不加载）+ `content/network/{platform}.js`
8. `content/dom/katex-html-to-latex.js` + `content/dom/html-to-markdown.js` + `content/dom/{platform}.js`
9. `content/{platform}.js`（平台入口，最后执行）

**改动 `manifest.json` 加载顺序需极其谨慎**：例如把 `exporter-base.js` 放在 `adapter-registry.js` 之前会直接报 `EXTRACTION_MODE is not defined`。

## 常见任务

### 任务 1: 新增一个 AI 平台入口

**场景**：接入新的 AI 平台（如智谱清言）。

**步骤**：
1. 在 `content/` 下新建 `{platform}.js` 入口文件，复制 `deepseek.js` 模板，改 platformName。
2. 在 `content/dom/` 下新建 `{platform}.js` DOM 适配器，注册到 `DOM_ADAPTERS.{platform}`。
3. 在 `content/network/` 下新建 `{platform}.js` 网络适配器（若平台用 HTTP/SSE，非 WebSocket），注册到 `NETWORK_ADAPTERS.{platform}`。
4. 在 `manifest.json` 中：
   - `host_permissions` 添加平台域名
   - 新增两个 content_scripts 条目：一个 MAIN world 加载 `network-interceptor.js`，一个默认 world 按上述顺序加载所有脚本
   - `web_accessible_resources.matches` 添加平台域名（KaTeX CSS 跨域）
5. 在 `bg/settings-handlers.js` 中添加默认模式配置（默认 DOM）。
6. 在 `popup/` 设置页 UI 中添加平台开关。

**验证**：刷新扩展 → 打开平台页面 → Console 应出现 `[Exporter] 已加载，平台: {platform}, 模式: dom` 日志。

### 任务 2: 修改平台默认启用状态

**场景**：将某个平台从默认禁用改为默认启用。

**步骤**：
1. 编辑 `content/adapter-registry.js` 的 `DEFAULT_ENABLED_PLATFORMS`：
   ```javascript
   const DEFAULT_ENABLED_PLATFORMS = new Set(['fudan', 'deepseek']); // 添加 deepseek
   ```
2. 注意：`isPlatformEnabled` 的逻辑是「已显式保存过的平台按存储值；未保存过的走默认」——已使用过的用户设置不会变，仅对新用户生效。

**验证**：清除扩展存储（`chrome.storage.local.clear()`）后刷新页面，新平台应自动启用。

### 任务 3: 调试网络拦截器未捕获请求

**场景**：网络模式下 `exporter.conversations.size === 0`，导出按钮报「未捕获到对话数据」。

**步骤**：
1. 在目标页面 Console（`top` 上下文）执行 `window.__AI_CHAT_INTERCEPTOR_INSTALLED__`，应为 `true`；若 `undefined` 说明 MAIN world 拦截器未注入（检查 manifest 是否声明 `world: MAIN` 的 content_script）。
2. 观察 Console 是否有 `[Exporter/Debug] 收到拦截数据: source=..., url=..., bodyLength=...` 日志；若没有，说明 fetch/XHR 没被匹配——可能是平台用了 WebSocket（如 Kimi）或其他传输方式。
3. 若有拦截日志但无解析成功日志，检查 `[Exporter/Debug] parseResponse: URL匹配成功` 是否出现；若 URL 匹配失败，需在 `network/{platform}.js` 的 `matchApi` 中添加新 API 路径。
4. 调用 `exporter.diagnose()` 查看 `interceptor.requestCount`、`parseSuccessCount`、`parseFailCount`。

**验证**：发送一条对话，Console 应依次出现「收到拦截数据 → URL匹配成功 → adapter.parse 返回 → 保存成功」。

### 任务 4: 切换平台提取模式

**场景**：用户从 DOM 模式切换到网络模式（或反向）。

**步骤**：
1. 用户在 popup 设置页选择模式，触发 `chrome.storage.local.set({ platformModes: { deepseek: 'network' } })`。
2. **当前页面不会立即切换模式**——`ChatExporterBase` 在构造时确定 `this.mode`，需刷新页面让入口脚本重新读取设置。
3. 若需运行时切换，调用 `exporter.switchMode(newMode)`（已实现但入口未暴露调用入口），会启动拦截器但不会停止已启动的 DOM Observer。

**验证**：刷新页面后 Console 显示 `模式: network`，发送对话应出现 `[Exporter/Debug] 检测到 SSE 流式响应`。

### 任务 5: 修改 URL 对话 ID 提取规则

**场景**：平台改版导致 URL 格式变化，对话 ID 提取失败。

**步骤**：
1. 编辑 `content/exporter-base.js` 的 `getConvIdFromUrl()`，添加新正则分支。当前已支持：
   - DeepSeek: `/chat/s/{id}` 或 `/chat/{id}`
   - 千问: `/chat/{id}`
   - 复旦: `?sess_id=xxx`
2. **同步修改**对应 `dom/{platform}.js` 的 `getConversationId()`，保持一致——网络模式用 `getConvIdFromUrl()`，DOM 模式用适配器的 `getConversationId()`，两者返回值必须相同（都是平台 conversation ID）。

**验证**：切换不同对话，Console 应出现 `[Exporter] URL 变化: ...` 和 `切换对话: oldId -> newId`，且新 ID 与 URL 一致。

### 任务 6: 处理「扩展上下文失效」错误

**场景**：扩展重载后，旧页面 content script 仍持有失效的 `chrome.runtime`，sendMessage 报 `Extension context invalidated`。

**步骤**：
1. `exporter-base.js` 的 `sendMessage()` 已统一捕获该错误并 reject `new Error('CONTEXT_INVALIDATED')`。
2. `saveConversation()` 和 `captureCurrentConversation()` 的 catch 块检查 `err.message !== 'CONTEXT_INVALIDATED'` 才打 `console.error`，避免刷屏。
3. **用户侧解决**：刷新页面即可。代码侧无需特殊处理——降级为 DOM 模式继续运行，只是无法保存到 background。

**验证**：重载扩展后不刷新页面，Console 应仅有 warn 级别日志（`chrome.runtime 上下文已失效`），不应有红色 error。

## 扩展点

### 新增一个 AI 平台适配器

详见「任务 1」。核心步骤：

- **DOM 模式**：实现 `DOM_ADAPTERS.{platform}` 对象，必须包含 `name`、`getConversationId()`、`getTitle()`、`extractMessages()` 三个公共方法；可选 `isStreaming()` 用于流式输出检测（避免流式过程中采集到半截消息）。
- **网络模式**：实现 `NETWORK_ADAPTERS.{platform}` 对象，必须包含 `name`、`matchApi(url)`、`parse(url, data, requestBody)` 三个方法；可选 `fetchConversation(convId)` 用于删除后主动重采。`parse` 返回 `null` 表示忽略该响应（如标题缓存 API），返回 `{ id, title, messages, url }` 表示成功解析对话，返回 `{ titleUpdate: true, id, title }` 表示仅更新标题。

### 扩展 html-to-markdown 的解析规则

见 `dom/DEVELOPMENT.md` 中的「扩展 html-to-markdown 解析规则」章节。简言之：在 `content/dom/html-to-markdown.js` 中通过 `turndownService.addRule(name, { filter, replacement })` 添加新规则，或在 `NOISE_SELECTORS` 数组中追加要移除的噪声选择器。

## 注意事项（坑）

- **平台 DOM 结构变更的脆弱性**：所有 `dom/*.js` 适配器依赖具体的 CSS 类名（如 `.ds-message`、`.chat-content-item`、`.md-box-root`），平台前端改版会直接导致提取失败。日志中加了 `[Platform/DOM] 找到 0 个 ...` 等诊断日志便于排查。**修改类名时务必基于实际抓包确认**，不要凭记忆。
- **Kimi 特殊性**：
  - WebSocket + protobuf 传输，**网络拦截完全不可用**，固定 DOM 模式。
  - `manifest.json` 中 Kimi 不加载 `network-interceptor.js`、`network/common.js`，因此 `dom/kimi.js` 自己内联了 `_buildKimiAssistantContent()` 函数（与 `network/common.js` 的 `buildAssistantContent` 一致但不依赖它）。
  - Kimi 主动移除 KaTeX 的 `<annotation>` 可访问性层，必须走 `KatexHtmlToLatex.convert()` 反向解析（见 `dom/katex-html-to-latex.js`）。
- **turndown 插件加载顺序**：`lib/turndown.min.js` 必须在 `lib/turndown-plugin-gfm.js` 之前加载（插件挂载到 `TurndownService` 全局）；`content/dom/html-to-markdown.js` 必须在两个库之后加载，否则 `TurndownService` 未定义会降级为 `textContent`。`manifest.json` 中已固定顺序，**不要调整**。
- **KaTeX 反向解析的 fallback 逻辑**：`HtmlToMarkdown._extractKatexLatex()` 优先从 `<annotation encoding="application/x-tex">` 提取原始 LaTeX（DeepSeek/千问/豆包/复旦均支持），失败时降级到 `KatexHtmlToLatex.convert()`（Kimi 需要），最终降级为 `textContent`。**不要移除任何一层 fallback**——Kimi 改版恢复 annotation 后第一层即可命中，移除反向解析可省代码，但移除第一层会让所有平台都走反向解析，性能下降且易出错。
- **`run_at: document_start` 的必要性**：所有 content script 必须在 `document_start` 注入，否则会错过页面初始的 API 请求（如历史对话加载）。`network-interceptor.js` 尤其关键——晚于页面 fetch 调用注入就拦不到数据。
- **`_deletedConvIds` 重新采集机制**：用户在悬浮球面板删除对话后，`floating-ball.js` 将 `platformConvId` 加入 `collector._deletedConvIds`，下次 URL 切换到该对话时 `exporter-base.js` 的 `onConversationChange()` 会主动调用 `requestConversationData()` 重新采集。**Kimi（DOM 模式）不走此路径**——`requestConversationData` 依赖 `adapter.fetchConversation`，Kimi 无网络适配器，删除后只能等 DOM Observer 自然采集。
- **流式响应合并的 hash 去重**：`parseResponse()` 中流式响应采用「追加模式」，每次解析全量消息后用 `messageHash(role, content)` 去重——hash 函数是简单的 `(hash << 5) - hash + charCode`，**有极小概率碰撞**，但对于正常对话内容足够。若发现消息丢失，可临时在 `capturedHashes` 中检查 hash 是否误命中。

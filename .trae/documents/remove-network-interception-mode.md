# 移除 web-ai-chat-collector 网络拦截模式（保留 DOM 模式）

## Context（背景）

`web-ai-chat-collector` 扩展当前有两套对话提取模式：
- **网络拦截模式**：在页面主世界（MAIN world）monkey-patch `window.fetch` / `XMLHttpRequest`，捕获 API 响应体来提取对话。涉及 4 个平台（deepseek / qianwen / fudan / doubao）。
- **DOM 模式**：直接从页面 DOM 提取对话内容。

用户希望**取消网络拦截模式、只保留 DOM 模式**以提升安全性（monkey-patching fetch/XHR 风险较高）。

探索发现一处关键依赖：`content/dom/fudan.js`（复旦 DOM 适配器）在 DOM 模式下复用了网络拦截器——它监听 `__AI_CHAT_INTERCEPTED__` postMessage 并调用 `window.NETWORK_ADAPTERS.fudan.parse()`，从 `/site/ai/compose_chat` 的 SSE 流式响应中提取 `session_id`（复旦新流式对话 URL 无 `sess_id`，只能从响应体获取）。

经与用户确认，**直接移除整个复旦平台**（避免处理 session_id 降级问题），且**默认不启用任何平台**（`DEFAULT_ENABLED_PLATFORMS` 改为空 Set，符合用户安全优先偏好）。

**预期结果**：扩展不再注入任何 MAIN-world 拦截脚本、不再 monkey-patch fetch/XHR；6 个平台（deepseek / qianwen / doubao / kimi / yuanbao / wenxin）均走纯 DOM 提取；复旦平台完全移除；安装后不在任何网站自动采集，需用户在设置页手动启用。

**范围**：仅 `web-ai-chat-collector` 插件。`knowledge-work-assistant` 后端 `SUPPORTED_PLATFORMS` 白名单仍含 `fudan`，保留无害（插件不再推送 fudan 数据），不在本次范围内。

## 关键事实

- `manifest.json` **没有** `webRequest` / `declarativeNetRequest` 权限——拦截纯靠 MAIN-world 脚本，所以无需删权限，只需删 content_scripts 条目。
- `kimi` / `yuanbao` / `wenxin` 三个入口已经是纯 DOM（`EXTRACTION_MODE.DOM` 硬编码），可作为改造其余入口的参照样板。
- DOM 模式导出路径（`exportFromDom` / `captureCurrentConversation`）**不依赖**任何网络代码；只有 `dom/fudan.js` 例外（随复旦一起删除）。
- 测试 `tests/dom/adapters.test.js` 不直接依赖网络适配器（`window.NETWORK_ADAPTERS?.fudan` 在测试环境为 undefined 会安全跳过），删掉 fudan 测试块即可。

## 实施步骤

### 1. 删除文件

- `content/network-interceptor.js`（MAIN-world fetch/XHR 拦截器）
- `content/network/`（整个目录：`common.js`、`deepseek.js`、`qianwen.js`、`fudan.js`、`doubao.js`、`DEVELOPMENT.md`）
- `content/dom/fudan.js`（复旦 DOM 适配器，含网络依赖）
- `content/fudan.js`（复旦平台入口）

### 2. `manifest.json`

- 删除 deepseek / qianwen / fudan / doubao 各自的 **MAIN-world** content_scripts 条目（只加载 `network-interceptor.js` 的那 4 条，fudan 的整条删除）。
- 删除 fudan 的 **ISOLATED-world** content_scripts 条目（整条）。
- 从 deepseek / qianwen / doubao 的 ISOLATED-world 脚本列表中移除 `content/network/common.js` 与 `content/network/<site>.js`。
- 从 `host_permissions` 移除 `https://aiagent.fudan.edu.cn/*`。
- 从 `web_accessible_resources[0].matches` 移除 `https://aiagent.fudan.edu.cn/*`。
- `permissions` / `optional_host_permissions` 无需改动（本就无 webRequest/DNR）。

### 3. `content/adapter-registry.js`

- `EXTRACTION_MODE` 删除 `NETWORK` 字段，仅保留 `DOM: 'dom'`（最小改动，保留常量以避免大改入口）。
- 删除 `window.NETWORK_ADAPTERS = {}`（保留 `window.DOM_ADAPTERS = {}`）。
- 删除 `getPlatformMode()` 整个函数（不再需要模式查询）。
- `DEFAULT_ENABLED_PLATFORMS` 改为 `new Set([])`（空集，默认不启用任何平台）。

### 4. `content/exporter-base.js`（删除网络分支，保留 DOM 路径）

- 构造函数：删除 `this.conversations`（Map）、`this.interceptor`、`this.currentConvId` 等网络模式专用状态；`mode` 参数保留（默认 DOM）但不再有分支意义。
- 删除方法：`getNetworkAdapter()`、`setupInterceptor()`、`parseResponse()`、`exportFromNetwork()`、`getConvIdFromUrl()`、`requestConversationData()`、`switchMode()`。
- `init()`：删除 `if (mode === NETWORK)` 分支，直接走 `initUi()`。
- `exportAll()`：简化为 `return this.exportFromDom()`。
- `onConversationChange()`：删除 NETWORK 分支（`getConvIdFromUrl`、已删除对话主动请求），保留 DOM 路径（`getDomAdapter()?.getConversationId()` + `debounceCapture`）。
- `startObserver()`：删除 `if (mode === NETWORK) return` 早返回。
- `captureCurrentConversation()`：删除 `if (mode === NETWORK) return` 早返回。
- `diagnose()`：删除 NETWORK 分支，仅保留 DOM 诊断。
- 参照 `content/kimi.js` / `yuanbao.js` 的纯 DOM 用法验证一致性。

### 5. 入口文件 `content/{deepseek,qianwen,doubao}.js`

- 删除 `const savedMode = await getPlatformMode(...)`，改为 `new ChatExporterBase('<platform>', EXTRACTION_MODE.DOM)`（与 kimi/yuanbao/wenxin 一致）。
- 更新顶部注释：删除"网络拦截器必须在最早时机启动"说明。

### 6. `bg/settings-handlers.js`

- 从 `handleGetSettings` / `handleSaveSettings` 的 switch 中删除 `case 'platformModes'`。
- 删除 `DEFAULT_PLATFORM_MODES`、`getPlatformModes()`、`savePlatformModes()`。
- `platformSettings`（平台启用/禁用）保留不动。
- （旧用户存储里的 `platformModes` key 残留无害，可不管；若想清理可在 `bg/init.js` 加一次性迁移，非必需。）

### 7. `popup/settings.html`

- 删除复旦整行（`platform-row` + 其 `mode-options`）。
- 删除 deepseek / qianwen / doubao / kimi / yuanbao / wenxin 各行的 `mode-options` 整块（模式不再可配，只剩 DOM）。
- 保留各平台的 checkbox 行。
- 保留底部 `<small>` 说明，按需微调措辞（去掉"DOM/网络拦截"相关字样）。

### 8. `popup/settings.js`

- 删除 platformModes 加载块（约 639–651 行：`GET_SETTINGS category:'platformModes'` + `setMode(...)`）。
- 删除 platformModes 保存块（约 812–829 行：`SAVE_SETTINGS category:'platformModes'` + `getMode(...)`）。
- 删除所有 `platformFudan` 引用（加载约 632 行、保存约 804 行，及变量声明）。
- 删除 `setMode` / `getMode` 辅助函数（如仅用于模式）。

### 9. `tests/dom/adapters.test.js`

- 删除 `fudan` 变量声明与 `fudan = loadDomAdapter('fudan')`。
- 删除整个 fudan `describe` 块（约 433–565 行）。
- 更新文件顶部注释 "7 个平台" → "6 个平台"。
- 确认 `tests/helpers/load-source.js` 无 fudan 硬编码依赖（已核实：无 fudan fixture 文件）。

### 10. `bg/local-app.js`（可选清理，低风险）

- 从 `PLATFORM_MAP` 删除 `fudan: 'fudan'`（保留无害，但为一致性建议删除）。

### 11. 文档更新（一致性）

- `README.md` / `README-zh.md`：更新架构图（移除 `network-interceptor` 行、移除 fudan）。
- `content/DEVELOPMENT.md`、`content/dom/DEVELOPMENT.md`、`bg/DEVELOPMENT.md`、`popup/DEVELOPMENT.md`：移除网络模式 / fudan / platformModes 相关描述。
- `content/dom/html-to-markdown.js:395`、`content/ui/viewer.js:6`：仅注释提及"复旦"，可留可改（非阻塞）。

## 验证

1. **单测**：在 `web-ai-chat-collector` 下运行 `npm test`（vitest）。预期：`adapters.test.js`（去掉 fudan 后 6 平台）、`html-to-markdown`、`katex-html-to-latex`、`markdown-safety`、`viewer-isolation`、`bg/local-app`、`unit/*` 全绿。
2. **加载扩展**：Chrome `chrome://extensions` 加载解包目录，确认无 manifest 报错、无 content script 注册错误。
3. **DOM 模式功能**：打开 `chat.deepseek.com`，启用该平台后发一条对话，确认悬浮球正常采集（Network 面板看不到扩展注入的拦截脚本，控制台无 `[NetworkInterceptor]` 日志）。
4. **复旦不注入**：打开 `aiagent.fudan.edu.cn`，确认扩展不注入任何 content script（`chrome.storage` 中无 fudan 采集活动，无悬浮球）。
5. **设置页**：打开 popup 设置页，确认无 fudan 行、无"网络拦截"radio、保存/加载正常且不再读写 `platformModes`。
6. **回归**：在 deepseek / qianwen / doubao 上各发一条对话，确认 DOM 提取与历史对话加载正常。

## 不在范围内

- `knowledge-work-assistant` 后端 `SUPPORTED_PLATFORMS` 白名单的 `fudan` 项（保留无害）。
- 旧用户 `chrome.storage.local` 中残留的 `platformModes` / `platformSettings.fudan` 值（不影响功能）。

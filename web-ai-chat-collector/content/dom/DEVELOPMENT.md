# content/dom/ 开发指南

> DOM 提取模式适配器集合：当平台网络协议不可拦截（Kimi WebSocket）或用户在设置中选择了 DOM 模式时，由这些适配器从渲染后的页面 DOM 中提取对话消息，并通过 `HtmlToMarkdown` 将 HTML 转为 Markdown 文本。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录的 DOM 适配器是"采集链路的最后一公里"，与软件侧 [knowledge-work-assistant](../../../knowledge-work-assistant/DEVELOPMENT.md) 的对接关系如下：

- **平台 ID 对齐**：本目录 5 个适配器（`kimi.js`/`deepseek.js`/`doubao.js`/`qianwen.js`/`fudan.js`）注册到 `window.DOM_ADAPTERS[platformName]` 的 `name` 字段，与 KWA 后端 [routers/plugin.py](../../../knowledge-work-assistant/backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 白名单取交集。
- **对话格式契约**：适配器 `extractMessages()` 返回的 `messages` 数组中，助手消息按 `<think>...</think>\n\n<search_result>...</search_result>\n\n回答` 三段式拼接；这与 `network/common.js` 的 `buildAssistantContent` 一致，也是 KWA 后端 `graph_agent` 解析思考/搜索/回答三段式的来源格式。改格式需同步 [content/network/common.js](../network/common.js) 与 KWA 后端 [services/graph_agent.py](../../../knowledge-work-assistant/backend/app/services/graph_agent.py)。
- **流式输出检测**：`isStreaming()` 返回 true 时 `exporter-base.js` 跳过采集，避免推送半截消息到 KWA 后端造成 `Observation` 内容不完整。
- **采集事件 → 推送**：DOM 模式采集成功后由 `exporter-base.js` 派发事件，应用 [plugin-sdk/secondary-dev/kwa-push-handler.js](../../../knowledge-work-assistant/plugin-sdk/secondary-dev/kwa-push-handler.js) patch 后自动推送到 KWA 后端。
- **Kimi 特例**：Kimi 仅支持 DOM 模式（WebSocket + protobuf 不可拦截），但 KWA 后端 `SUPPORTED_PLATFORMS` 仍包含 `kimi`，DOM 采集后可正常推送。

跨子工程任务（新增平台、调整对话格式等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

- **HTML → Markdown 转换层**：基于 turndown.js v7.2.4 + turndown-plugin-gfm v1.0.2，封装为 `window.HtmlToMarkdown.convert(el)`，统一处理五个平台的渲染容器（`.markdown` / `.md-box-root` / `.qk-markdown` / `.ds-markdown` / `.md-editor-preview`）。
- **KaTeX HTML → LaTeX 反向解析**：当平台（如 Kimi）移除 `<annotation>` 可访问性层时，通过 `window.KatexHtmlToLatex.convert(katexHtmlEl)` 递归解析 `.katex-html` DOM 重建 LaTeX 源码。
- **平台 DOM 适配器**：每个平台一个文件，注册到 `window.DOM_ADAPTERS[platformName]`，提供 `getConversationId()` / `getTitle()` / `isStreaming()` / `extractMessages()` 等方法，由 `exporter-base.js` 在 DOM 模式下调用。
- **思考与搜索内容分离**：DeepSeek/千问/豆包/复旦的助手消息通常包含「思考过程」「搜索来源」「正式回答」三部分，DOM 适配器需分别提取并按 `<think>...</think>\n\n<search_result>...</search_result>\n\n回答` 格式拼接（与 `network/common.js` 的 `buildAssistantContent` 保持一致）。
- **流式输出检测**：每个适配器提供 `isStreaming()` 方法，让 `exporter-base.js` 在流式过程中跳过采集，避免抓到半截消息。

## 关键文件

| 文件 | 职责 | 重要函数/类 |
|------|------|-------------|
| `html-to-markdown.js` | 统一 HTML→Markdown 转换封装，含五平台自定义规则 | `window.HtmlToMarkdown.convert(el)`、`HtmlToMarkdown._extractKatexLatex(node)`、`NOISE_SELECTORS`（噪声选择器数组）、自定义规则 `paragraphDiv` / `qkMdParagraphDiv` / `doubaoParagraphDiv` / `deepseekCodeBlock` / `qianwenCodeBlock` / `doubaoCodeBlock` / `katexInline` / `katexDisplay` |
| `katex-html-to-latex.js` | KaTeX 渲染 HTML → LaTeX 反向解析器 | `window.KatexHtmlToLatex.convert(katexHtmlEl)`、`_processNode(node)`、`_processSupSub(supsubEl)`、`_processFrac(fracEl)`、`_processSqrt(sqrtEl)`、`_processMtable(tableEl)`、`OP_MAP`（操作符符号→LaTeX 命令映射表，100+ 项）、`SUP_THRESHOLD = -1.8`（上下标判断阈值） |
| `kimi.js` | Kimi DOM 适配器（WebSocket 平台，仅 DOM 模式） | `DOM_ADAPTERS.kimi`：`getConversationId`、`getTitle`、`isStreaming`、`extractMessages`、`_extractUserContent`、`_extractAssistantContent`、`_extractMarkdownText`；模块级函数 `_buildKimiAssistantContent(thinking, answer)`（内联，不依赖 network/common.js） |
| `deepseek.js` | DeepSeek DOM 适配器 | `DOM_ADAPTERS.deepseek`：`getConversationId`、`getTitle`、`isStreaming`、`extractMessages`、`_getRole`、`_extractText`、`_extractThinking`、`_extractSearchResults`、`_extractMarkdownText`、`_isInterrupted` |
| `doubao.js` | 豆包 DOM 适配器（虚拟滚动，长对话受限） | `DOM_ADAPTERS.doubao`：`getConversationId`、`getTitle`、`isStreaming`、`extractMessages`、`_getRole`、`_extractContent`、`_extractUserContent`、`_extractAssistantContent`、`_extractMarkdownText` |
| `qianwen.js` | 千问 DOM 适配器 | `DOM_ADAPTERS.qianwen`：`getConversationId`、`getTitle`、`isStreaming`、`extractMessages`、`_extractUserMessage`、`_extractAssistantMessage`、`_extractThinking`、`_extractSearchTerms`、`_extractMarkdownText` |
| `fudan.js` | 复旦 AI Agent DOM 适配器（与网络拦截器协作获取 session_id） | `DOM_ADAPTERS.fudan`：`getConversationId`、`getTitle`、`isStreaming`、`extractMessages`、`_extractUserContent`、`_extractAssistantMessage`、`_extractThinking`、`_extractSearchResults`、`_extractMarkdownText`；模块级状态 `_fudanCachedSessionId` / `_fudanComposeChatSeen` / `_fudanWaitStart` / `_FUDAN_SESSION_ID_TIMEOUT` |

## 开发工作流

### 改代码的典型流程

1. 修改 `content/dom/` 下相关文件（适配器或转换器）。
2. 打开 `chrome://extensions` → 找到 ai-chat-collector → 点击「重新加载」。
3. 回到目标平台页面（如 `https://www.kimi.com/chat/{uuid}`），**Ctrl+Shift+R 强制刷新**。
4. 打开 DevTools Console，按平台过滤日志前缀：`[Kimi/DOM]`、`[DeepSeek/DOM]`、`[Doubao/DOM]`、`[Qianwen/DOM]`、`[Fudan/DOM]`、`[HtmlToMarkdown]`、`[KatexHtmlToLatex]`。

### 调试技巧

- **检查 DOM 适配器是否注册**：Console 执行 `Object.keys(window.DOM_ADAPTERS)`，应返回当前平台的数组（如 `['deepseek']`）。
- **手动调用提取**：Console 执行 `window.DOM_ADAPTERS.deepseek.extractMessages()` 应返回消息数组；若返回 `[]`，按日志中 `找到 0 个 ...` 的提示检查容器选择器。
- **查看 turndown 输出**：执行 `window.HtmlToMarkdown.convert(document.querySelector('.ds-markdown'))` 可直接看转换结果，便于调试自定义规则。
- **KaTeX 反向解析调试**：执行 `window.KatexHtmlToLatex.convert(document.querySelector('.katex-html'))` 看是否输出正确 LaTeX；若失败会降级为 `textContent` 并打 warn 日志。
- **检查噪声移除**：`HtmlToMarkdown.convert` 内部先克隆节点再按 `NOISE_SELECTORS` 移除噪声，可手动遍历 `NOISE_SELECTORS` 数组看哪些选择器命中了多余元素。

## 代码约定

### 适配器注册模式

每个 DOM 适配器文件顶部都有相同的防御性初始化：

```javascript
if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};
```

然后直接赋值：

```javascript
DOM_ADAPTERS.deepseek = {
  name: 'deepseek',
  getConversationId: () => { /* 从 URL 提取 */ },
  getTitle: () => { /* 从 document.title 或侧边栏提取 */ },
  isStreaming: () => { /* 检测流式输出信号 */ },
  extractMessages: () => { /* 主提取逻辑，返回消息数组 */ },
  _extractXxx: () => { /* 私有辅助方法，下划线前缀 */ }
};
```

**内部自引用**：适配器方法内调用同对象其他方法时用 `DOM_ADAPTERS.deepseek._extractXxx(el)` 而非 `this._extractXxx(el)`——因为方法可能被解构赋值丢失 `this`，显式引用对象更安全。

### DOM 模式 vs 网络模式的选择逻辑

- 用户在 popup 设置页选择模式，`getPlatformMode()` 返回 `'dom'` 或 `'network'`。
- DOM 模式下 `exporter-base.js` 启动 `MutationObserver` 监听 DOM 变化，触发 `captureCurrentConversation()` → `exportFromDom()` → `adapter.extractMessages()`。
- 网络模式下 `exporter-base.js` 不启动 `MutationObserver`（`startObserver()` 中 `if (this.mode === EXTRACTION_MODE.NETWORK) return;`），由拦截器直接保存。
- **Kimi 强制 DOM**：`content/kimi.js` 直接 `new ChatExporterBase('kimi', EXTRACTION_MODE.DOM)`，不查 `getPlatformMode`。
- **复旦 DOM 模式复用网络拦截器**：`dom/fudan.js` 监听 `__AI_CHAT_INTERCEPTED__` postMessage，从 SSE 响应中提取 `session_id` 缓存到 `_fudanCachedSessionId`，解决流式新对话 URL 无 `sess_id` 的问题。

### 平台命名约定

文件名与 platformName 严格一致：`kimi.js` → `DOM_ADAPTERS.kimi`、`deepseek.js` → `DOM_ADAPTERS.deepseek`，以此类推。新增平台必须遵守此约定，否则 `exporter-base.js` 的 `getDomAdapter()` 找不到适配器。

### 助手消息内容拼接格式

所有适配器的 `_extractAssistantContent` / `_extractAssistantMessage` 必须返回如下格式（与 `network/common.js` 的 `buildAssistantContent` 一致）：

```
<think>
思考内容...
</think>

<search_result>
搜索来源...
</search_result>

正式回答...
```

- 三部分均**可选**，缺失部分省略对应标签和空行。
- `viewer.js` 和 `ai-ball.js` 的 `_renderMarkdown` 通过正则提取这些标签渲染为可折叠块。
- **Kimi 例外**：`_buildKimiAssistantContent(thinking, answer)` 不支持 `<search_result>`（Kimi DOM 中搜索来源不渲染）。

### 流式输出检测约定

每个适配器的 `isStreaming()` 返回 boolean，检测平台特有的「发送按钮变为停止按钮」信号：

| 平台 | 检测信号 |
|------|----------|
| Kimi | `.core-spiral-loading` 加载动画，或 `.send-button-container.stop` 类 |
| DeepSeek | `.ds-button--primary.ds-button--filled.ds-button--circle` 按钮 SVG path 以 `M2 ` 开头（停止图标 vs 发送箭头） |
| 豆包 | `[class*="break-btn"]` 中断按钮存在 |
| 千问 | `[aria-label="停止回答"]` 按钮 |
| 复旦 | `.n-spin` / `.n-base-loading` 加载组件，或流式新对话等待 `session_id` 缓存（最多 10 秒） |

## 常见任务

### 任务 1: 适配平台 DOM 结构改版

**场景**：平台前端改版，原有 CSS 类名失效，`extractMessages()` 返回空数组。

**步骤**：
1. 打开平台页面，DevTools Elements 面板找到消息容器（通常用户消息和助手消息有不同的 class）。
2. Console 执行 `document.querySelectorAll('.原类名')` 确认旧选择器失效；用 `document.querySelectorAll('[class*="关键词"]')` 搜索新类名。
3. 编辑 `dom/{platform}.js` 的 `extractMessages()` 中容器选择器（如 `container = document.querySelector('.list_items')`）。
4. 同步修改 `_extractUserContent` / `_extractAssistantContent` 中的子元素选择器。
5. 若是消息行选择器变化，修改 `msgElements = container.querySelectorAll('.chat-content-item')` 等。
6. **同步更新 `content/dom/html-to-markdown.js`**：若平台改了段落容器（如 `.paragraph` → `.new-paragraph`），需在自定义规则中添加新选择器。

**验证**：刷新页面后发送一条对话，Console 应出现 `[Platform/DOM] 共提取 N 条消息`，N ≥ 2（用户+助手）。

### 任务 2: 新增 HTML → Markdown 自定义规则

**场景**：平台用了非标准 HTML 结构（如 `<div class="xxx-paragraph">` 代替 `<p>`），turndown 默认转换丢失段落分隔。

**步骤**：
1. 编辑 `content/dom/html-to-markdown.js`，在 `turndownService.addRule(...)` 调用区域添加新规则：
   ```javascript
   turndownService.addRule('myPlatformParagraphDiv', {
     filter: function (node) {
       return node.nodeName === 'DIV' &&
              node.getAttribute('class') &&
              /\bxxx-paragraph\b/.test(node.getAttribute('class'));
     },
     replacement: function (content) {
       return '\n\n' + content + '\n\n';
     }
   });
   ```
2. 规则名必须唯一（如 `myPlatformParagraphDiv`），否则会覆盖已有规则。
3. `filter` 返回 true 时该节点由本规则处理，`replacement` 返回 Markdown 文本。

**验证**：Console 执行 `window.HtmlToMarkdown.convert(testEl)`，输出中段落间应有 `\n\n` 分隔。

### 任务 3: 添加噪声元素到移除列表

**场景**：导出的 Markdown 混入了「复制」「编辑」按钮文字、引用图标、推荐问题等噪声。

**步骤**：
1. 在 `html-to-markdown.js` 的 `NOISE_SELECTORS` 数组中追加选择器：
   ```javascript
   var NOISE_SELECTORS = [
     'svg',
     // ... 已有选择器
     '.new-noise-class',  // 新增
     '[data-new-noise]'   // 新增
   ];
   ```
2. 选择器尽量用**不含哈希后缀**的稳定 class（如 `.iconfont`），避免用 `.iconfont-abc123`（哈希会变）。
3. 优先用属性选择器（如 `[data-copy-ignore="true"]`），更抗改版。

**验证**：刷新页面，导出对话查看 Markdown，噪声文字应消失。

### 任务 4: 修复 KaTeX 反向解析错误

**场景**：Kimi 平台导出的公式 LaTeX 不正确（如上下标颠倒、分数顺序错）。

**步骤**：
1. Console 找到错误公式节点：`document.querySelectorAll('.katex-html')`，逐个执行 `window.KatexHtmlToLatex.convert(el)` 对比预期。
2. 编辑 `content/dom/katex-html-to-latex.js`：
   - 上下标判断错误 → 调整 `SUP_THRESHOLD = -1.8`（更负则更严格判为上标）。
   - 操作符未识别 → 在 `OP_MAP` 中添加新映射，如 `'∉': '\\notin'`。
   - 嵌套结构解析错 → 检查 `_processNode` 的分派逻辑，新增 class 模式分支。
3. **优先用 `:scope >` 限定直接子节点**：`_findDirectTopSpans` 已封装此逻辑，避免 `querySelectorAll` 递归进入嵌套结构（如 `\frac{\frac{1}{2}}{3}` 的内层 mfrac）。

**验证**：单元测试在 `tests/dom/katex-html-to-latex.test.js`，运行 `npx vitest run tests/dom/katex-html-to-latex.test.js`。

### 任务 5: 处理流式输出半截消息

**场景**：DOM 模式下，AI 还在流式输出，`MutationObserver` 触发采集抓到了不完整的回答。

**步骤**：
1. 检查适配器的 `isStreaming()` 是否实现且返回正确。`exporter-base.js` 的 `captureCurrentConversation()` 会调用它，返回 true 时跳过本次采集并 1.5s 后重试。
2. 若平台没有明显的「停止按钮」信号，可监听「打字光标」元素（如有 `.cursor-blink` 类）：
   ```javascript
   isStreaming: () => {
     return !!document.querySelector('.cursor-blink, .typing-indicator');
   }
   ```
3. **不要在流式过程中频繁采集**——`debounceCapture(500)` 已加防抖，但若 `isStreaming` 失效会导致每 500ms 抓一次半截消息，hash 去重会保留第一版（可能不完整）。

**验证**：流式过程中 Console 不应出现 `[Exporter/DOM] ... 流式输出进行中，跳过本次采集`；流式结束后 1.5s 内应出现采集日志。

### 任务 6: 新增平台 DOM 适配器

**场景**：接入新 AI 平台，需实现 DOM 模式提取。

**步骤**：
1. 在 `content/dom/` 下新建 `{platform}.js`，复制 `deepseek.js` 模板（结构最完整，含思考/搜索/中断处理）。
2. 修改顶部注释中的 DOM 结构说明（基于实际抓包确认）。
3. 实现五个核心方法：
   - `getConversationId()`：从 `window.location` 提取对话 ID。
   - `getTitle()`：从 `document.title` 或侧边栏激活项提取标题。
   - `isStreaming()`：检测流式信号。
   - `extractMessages()`：遍历消息容器，按角色调用 `_extractUserContent` / `_extractAssistantContent`。
   - `_extractMarkdownText(el)`：调用 `window.HtmlToMarkdown.convert(el)`，降级为 `textContent`。
4. 注册到 `DOM_ADAPTERS.{platform}`。
5. 在 `manifest.json` 的对应平台 content_scripts 中加载此文件（在 `html-to-markdown.js` 之后）。
6. 若平台用非标准段落/代码块容器，在 `html-to-markdown.js` 中添加自定义规则。

**验证**：刷新页面，发送对话，Console 应出现 `[Platform/DOM] 共提取 N 条消息`，导出的 Markdown 结构正确。

## 扩展点

### 新增一个 AI 平台 DOM 适配器

详见「任务 6」。关键约束：

- **必须实现 `extractMessages()`**：返回 `[{ role: 'user'|'assistant', content: string, timestamp: ISOString }]` 数组，空数组表示无消息（页面未加载完或不在对话页面）。
- **可选实现 `isStreaming()`**：未实现时 `exporter-base.js` 跳过流式检测，可能导致半截消息采集（不致命，hash 去重会保留完整版）。
- **`_extractAssistantContent` 拼接格式必须与 `buildAssistantContent` 一致**：`<think>...</think>\n\n<search_result>...</search_result>\n\n回答`，否则 `viewer.js` 渲染会异常。
- **Kimi 不加载 `network/common.js`**：若新平台也走「仅 DOM」路线（如 WebSocket），不要在适配器中调用 `buildAssistantContent`，需内联拼接函数（参考 `dom/kimi.js` 的 `_buildKimiAssistantContent`）。

### 扩展 html-to-markdown 的解析规则

`html-to-markdown.js` 提供两种扩展点：

1. **自定义 turndown 规则**：`turndownService.addRule(name, { filter, replacement })`，用于处理特殊 HTML 结构（如平台特有的段落、代码块容器）。
2. **噪声选择器**：`NOISE_SELECTORS` 数组，转换前从克隆节点中移除的元素选择器（如按钮、图标、引用标记）。

**新规则的命名约定**：`{平台}{元素类型}` 驼峰命名，如 `deepseekCodeBlock`、`doubaoParagraphDiv`、`qianwenCodeBlock`。规则名必须全局唯一。

**KaTeX 处理无需扩展**：`katexInline` / `katexDisplay` 规则已覆盖所有平台的 KaTeX 结构，新平台只要用标准 KaTeX 渲染（`<span class="katex">` / `<span class="katex-display">`）即可自动转换。

## 注意事项（坑）

- **平台 DOM 结构变更的脆弱性**：所有适配器依赖具体 CSS 类名（如 `.ds-message`、`.chat-content-item`、`.md-box-root`、`.qk-markdown`、`.md-editor-preview`），平台前端改版会直接导致提取失败。**修改类名时务必基于实际抓包确认**——打开 DevTools Elements 面板复制真实 class，不要凭记忆或猜测。哈希后缀的 class（如 `.container-enLQFx`、`.code-block-element-R6c8c0`）尽量用正则匹配前缀（`/\bcode-block-element-\w+\b/`），避免哈希变化失效。
- **Kimi 特殊性（WebSocket + protobuf）**：
  - 网络拦截完全不可用，**固定 DOM 模式**，`content/kimi.js` 不调用 `getPlatformMode`。
  - `manifest.json` 中 Kimi 不加载 `network-interceptor.js`、`network/common.js`，因此 `dom/kimi.js` 内联了 `_buildKimiAssistantContent(thinking, answer)` 函数，不依赖 `buildAssistantContent`。
  - Kimi 主动移除 KaTeX 的 `<annotation>` 可访问性层，**必须**走 `KatexHtmlToLatex.convert()` 反向解析。若其他平台也跟进移除 annotation，反向解析器会自动接管（`HtmlToMarkdown._extractKatexLatex` 有 fallback 链）。
  - Kimi 助手消息中 `.segment-content-box` 可能嵌套 `.toolcall-container`（思考内容），`_extractAssistantContent` 用 `!m.closest('.toolcall-container')` 过滤，避免思考内容被误识别为回答。
- **turndown 插件加载顺序**：
  - `lib/turndown.min.js` 必须在 `lib/turndown-plugin-gfm.js` 之前加载（插件挂载到 `TurndownService` 全局对象）。
  - `content/dom/html-to-markdown.js` 必须在两个库之后加载，否则 `typeof TurndownService === 'undefined'` 会降级为 `textContent` 转换（丢失所有格式）。
  - `manifest.json` 中已固定顺序：`turndown.min.js` → `turndown-plugin-gfm.js` → `katex-html-to-latex.js` → `html-to-markdown.js` → 平台适配器。**不要调整此顺序**。
  - GFM 插件提供表格/删除线/任务列表/高亮代码块支持，turndown v7.2.4 默认不转换 `<table>`，若 GFM 未加载会 warn 但不致命。
- **KaTeX 反向解析的 fallback 逻辑**：
  - `HtmlToMarkdown._extractKatexLatex(node)` 三层 fallback：
    1. 优先从 `<annotation encoding="application/x-tex">` 提取原始 LaTeX（DeepSeek/千问/豆包/复旦均支持，最可靠）。
    2. 失败时降级到 `KatexHtmlToLatex.convert(katexHtmlEl)`（Kimi 需要，递归解析 `.katex-html` DOM）。
    3. 最终降级为 `node.textContent.trim()`（结构丢失，但保证不中断导出流程）。
  - **不要移除任何一层 fallback**：第一层是性能优化（直接取源码比反向解析快 100 倍），第二层是 Kimi 兼容，第三层是兜底。
  - 反向解析器限制：矩阵 `.mtable` 仅取文本拼接（不重建 `\begin{matrix}`），复杂嵌套（`\underbrace` / `\overbrace`）降级为 textContent。若需扩展，在 `_processNode` 中添加新的 class 分支。
- **豆包虚拟滚动限制**：豆包用 `v_list` 虚拟滚动，DOM 中只保留当前可见的消息行，长对话中滚出视图的消息会从 DOM 移除。**DOM 模式可能无法提取完整对话**——建议豆包用户优先用网络模式。`dom/doubao.js` 顶部注释明确说明了此限制。
- **复旦 DOM 模式与网络拦截器协作**：`dom/fudan.js` 顶部有 `window.addEventListener('message', ...)` 监听 `__AI_CHAT_INTERCEPTED__`，从 SSE 响应提取 `session_id` 缓存到 `_fudanCachedSessionId`。这是为了解决流式新对话 URL 无 `sess_id` 的问题——`getConversationId()` 优先用 URL 的 `sess_id`，其次用缓存的 `session_id`，最终降级为 `'default'`。**若 manifest 中复旦未加载 `network-interceptor.js`，此机制失效**，流式新对话会全部归到 `'default'` 对话 ID 下。
- **千问搜索词识别启发式**：`_extractSearchTerms` 用「长度 < 15 字 + 无标点」启发式区分搜索词和网页标题，可能误判。若发现搜索词缺失或混入网页标题，调整阈值或增加过滤规则。
- **`_extractMarkdownText` 的降级逻辑**：所有适配器的 `_extractMarkdownText` 在 `window.HtmlToMarkdown` 未定义时降级为 `textContent` / `innerText`，会丢失格式（标题、列表、粗体、代码块）。**若导出全是纯文本，先检查 Console 是否有 `[HtmlToMarkdown] TurndownService 未加载` warn**。

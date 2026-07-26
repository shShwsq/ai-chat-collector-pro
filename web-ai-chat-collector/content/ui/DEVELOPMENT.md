# content/ui/ 开发指南

> 采集器悬浮球 UI 层：负责在宿主 AI 平台页面右下角注入可拖拽的悬浮球、对话列表面板、对话详情查看器，以及所有相关的样式注入与 Markdown/KaTeX 渲染。本目录是「采集侧」UI——与 `content/ai-ball.js`（紫色 AI 问答球，独立 Shadow DOM）是两套并存的 UI 组件，不要混淆。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录是 collector 在宿主页面渲染的"采集侧 UI"，与软件侧 [knowledge-work-assistant](../../../knowledge-work-assistant/DEVELOPMENT.md) 的关系如下：

- **两套独立 UI**：本目录的悬浮球（`#ai-chat-ball`）+ 列表面板 + 查看器是 collector 本地 UI，与 KWA 前端 [frontend/src/components/](../../../knowledge-work-assistant/frontend/src/components/DEVELOPMENT.md) 的图谱 UI（GraphView / NodeDetailCard 等）是**两套完全独立的 UI**，互不依赖、互不通信。
- **UI 风格统一 patch**：应用 [plugin-sdk/secondary-dev/styles.patch.js](../../../knowledge-work-assistant/plugin-sdk/secondary-dev/styles.patch.js) patch 后，本目录 `styles.js` 中硬编码的主色（如 `#4f46e5` 紫色）会被替换为 CSS 变量 `var(--kwa-accent)`，并 `<link>` 引入 [plugin-sdk/ui/kwa-plugin.css](../../../knowledge-work-assistant/plugin-sdk/ui/kwa-plugin.css)；之后悬浮球颜色会随 KWA 模式（study 墨绿 / work 琥珀）联动。
- **patch 不破坏原 UI**：`styles.patch.js` 是**覆盖式 patch**（替换整个 `styles.js` 文件），不修改 `floating-ball.js`/`viewer.js` 的逻辑；patch 后 `FloatingBall`/`ConversationViewer` 的实例化流程、拖拽逻辑、删除回调等不变。
- **本地查看器与 KWA 报告**：本目录的 `ConversationViewer` 用于查看 collector 采集的原始对话；KWA 后端的"工作报告"（[services/report_service.py](../../../knowledge-work-assistant/backend/app/services/report_service.py)）是另一回事——后者基于图谱节点生成周期性报告，不读 collector 数据。
- **删除对话的级联**：`FloatingBall` 删除对话时调 `chrome.runtime.sendMessage({ type: 'DELETE_CONVERSATION' })`，由 [bg/conversations.js](../../bg/conversations.js) 的 `dbDeleteConversation` 删本地 IndexedDB + 触发 `VectorStore.deleteByConvId`；**不会**通知 KWA 后端删除已推送的 `Observation`（KWA 后端的 `Observation` 需在软件侧手动删除）。

跨子工程任务（应用 UI patch、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

- **悬浮球入口**：`FloatingBall` 类创建蓝色圆形悬浮球（`#ai-chat-ball`），点击展开对话列表面板，拖拽可移动位置；球上角标显示已采集对话总数。
- **对话列表面板**：展示从 background 拉取的对话列表，支持平台过滤、关键词搜索、单条查看/导出（Markdown/JSON）/删除，以及全量导出。
- **对话详情查看器**：`ConversationViewer` 类创建弹窗（`#ai-chat-viewer`），用 marked.js + KaTeX 渲染对话消息，支持思考过程/搜索来源折叠块、行内/行间数学公式、引用编号圆圈上标。
- **样式注入**：`AIChatStyles` 对象负责一次性注入主样式（`#ai-chat-collector-styles`）、KaTeX CSS（`lib/katex.min.css`）、数学公式额外样式到 `document.head`。
- **通用拖拽工具**：`makeDraggable(element, handle)` 函数让任意 DOM 元素可通过指定手柄拖动，被悬浮球、面板、查看器复用。
- **与采集器协作**：`FloatingBall` 构造时接收 `collector`（`ChatExporterBase` 实例）引用，删除对话时记录 `platformConversationId` 到 `collector._deletedConvIds`，并在删除的是当前对话时触发重新采集（网络模式走 `requestConversationData`，DOM 模式走 `captureCurrentConversation`）。

## 关键文件

| 文件 | 职责 | 重要函数/类 |
|------|------|-------------|
| `floating-ball.js` | 悬浮球 + 对话列表面板 UI，与 background 通信管理对话 | `class FloatingBall`：`constructor(collector)`、`createBall()`、`createPanel()`、`onMouseDown(e)`、`onMouseMove(e)`、`onMouseUp(e)`、`togglePanel(forceState)`、`positionPanel()`、`updateBadge(count)`、`loadConversations()`、`updatePlatformFilter(platforms)`、`exportAll()`、`handleSearch()`、`sendMessage(msg)`、`escapeHtml(text)` |
| `viewer.js` | 对话详情查看器弹窗，Markdown/KaTeX 渲染 | 顶层 `marked.use({ renderer: { link(...) } })`（引用编号圆圈渲染）、`class ConversationViewer`：`createViewer()`、`open(convId, sendMessage)`、`close()`、`renderContent(content)`、`renderMath(tex, displayMode)`、`escapeHtml(text)` |
| `styles.js` | UI 样式注入 + 通用拖拽工具 | `function makeDraggable(element, handle)`、`const AIChatStyles`：`inject()`、`mainCSS`（模板字符串，含 `#ai-chat-ball` / `#ai-chat-panel` / `#ai-chat-viewer` 全部样式）、`mathCSS`（`.math-block` / `.math-inline` 样式） |

## 开发工作流

### 改代码的典型流程

1. 修改 `content/ui/` 下相关文件（样式、面板逻辑或查看器渲染）。
2. 打开 `chrome://extensions` → 找到 ai-chat-collector → 点击「重新加载」。
3. 回到目标平台页面（如 `https://chat.deepseek.com/`），**Ctrl+Shift+R 强制刷新**——content script 只在页面加载时注入一次，扩展重载后旧页面持有的 `chrome.runtime` 上下文已失效，必须刷新。
4. 打开 DevTools Console，按日志前缀过滤：`[FloatingBall/Debug]`（删除对话后的重新采集日志）。UI 本身日志较少，主要看 background 返回的数据是否正确。

### 调试技巧

- **检查 UI 是否注入**：Console 执行 `document.getElementById('ai-chat-ball')`、`document.getElementById('ai-chat-panel')`、`document.getElementById('ai-chat-viewer')`，三者均应返回 DOM 元素（球默认显示，面板和查看器默认 `display:none`）。
- **检查样式是否注入**：执行 `document.getElementById('ai-chat-collector-styles')`，应返回 `<style>` 元素；`document.querySelector('link[href*="katex.min.css"]')` 应返回 KaTeX CSS link。
- **手动打开面板**：执行 `document.getElementById('ai-chat-panel').classList.add('open')` 可强制显示面板，便于调试列表渲染。
- **检查 collector 引用**：`FloatingBall` 实例未挂载到 window，但删除对话时会在 Console 打印 `[FloatingBall/Debug]` 日志，可从中观察 `collector._deletedConvIds` 状态。
- **扩展上下文失效判断**：Console 执行 `chrome.runtime.id`，若为 `undefined` 说明扩展已重载，需刷新页面；此时面板内会显示「扩展已更新或重载，请刷新当前页面后重试」。

## 代码约定

### UI 组件实例化顺序

`FloatingBall` 由 `ChatExporterBase.initUi()` 创建（见 `exporter-base.js`），传入 `this` 作为 `collector`：

```javascript
// exporter-base.js
initUi() {
  this.watchUrlChanges();
  this.startObserver();
  this.floatingBall = new FloatingBall(this);  // 传入 collector 引用
}
```

`FloatingBall` 构造函数内部按顺序：
1. `AIChatStyles.inject()` — 注入样式（幂等，重复调用不重复注入）。
2. `this.createBall()` — 创建悬浮球并绑定 mousedown/mousemove/mouseup 拖拽事件。
3. `this.createPanel()` — 创建面板，内部调用 `makeDraggable(this.panel, this.panel.querySelector('.panel-header'))`。
4. `new ConversationViewer()` — 创建查看器（查看器在 `createViewer` 中也调用 `makeDraggable`）。

**加载顺序约束**（`manifest.json` 中固定）：`styles.js` → `viewer.js` → `floating-ball.js` → `ai-ball.js` → `exporter-base.js`。`styles.js` 必须最先加载，因为 `floating-ball.js` 构造时立即调用 `AIChatStyles.inject()`；`viewer.js` 必须在 `floating-ball.js` 之前，因为 `FloatingBall` 构造时 `new ConversationViewer()` 需要该类已定义。

### 拖拽实现的两种模式

本目录有两套拖拽逻辑，**不要混用**：

1. **悬浮球自带拖拽**（`floating-ball.js` 的 `onMouseDown/Move/Up`）：
   - 手动实现，因为有「点击 vs 拖拽」区分需求——`hasMoved` 标记在移动超过 3px 时置 true，`onMouseUp` 中仅当 `!hasMoved` 才 `togglePanel()`。
   - 拖拽时实时设置 `ball.style.left/top`，并将 `right/bottom` 置为 `'auto'`（球默认用 `right:24px; bottom:24px` 定位）。
   - 边界限制：`Math.max(0, Math.min(x, maxX))` 确保球不会拖出视口。

2. **面板/查看器拖拽**（`styles.js` 的 `makeDraggable`）：
   - 通用工具函数，通过 header 手柄拖动。
   - 自动忽略按钮/输入框等交互元素上的拖拽（`e.target.closest('button, input, select, textarea, a')` 检查）。
   - 不做「点击 vs 拖拽」区分——面板/查看器的 header 上没有点击行为，纯拖动即可。

### 与 background 的消息通信

`FloatingBall.sendMessage(msg)` 封装了 `chrome.runtime.sendMessage`，处理两类错误：

```javascript
sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        reject(new Error('CONTEXT_INVALIDATED'));  // 扩展已重载
        return;
      }
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.includes('Extension context invalidated') ||
              errMsg.includes('message port closed')) {
            reject(new Error('CONTEXT_INVALIDATED'));
          } else {
            console.warn('[ai-chat-collector] 消息发送失败:', errMsg);
            resolve(null);  // 其他错误降级为 null，不中断流程
          }
          return;
        }
        resolve(response);
      });
    } catch (e) {
      reject(new Error('CONTEXT_INVALIDATED'));
    }
  });
}
```

**支持的消息类型**：

| 消息 type | 用途 | 调用位置 |
|-----------|------|----------|
| `GET_CONVERSATIONS` | 拉取对话列表（支持 `filters.platform` 过滤） | `loadConversations()` |
| `SEARCH_CONVERSATIONS` | 关键词搜索对话（支持 `query` + `filters.platform`） | `loadConversations()`（当 `searchQuery` 非空时） |
| `GET_STATUS` | 获取采集状态（`totalConversations`、`platforms`） | `loadConversations()` |
| `EXPORT_CONVERSATION` | 导出单条对话（`id` + `format: 'markdown'\|'json'`） | 列表项「导出 MD/JSON」按钮 |
| `EXPORT_ALL` | 全量导出（`format`） | `exportAll()` |
| `DELETE_CONVERSATION` | 删除单条对话（`id`） | 列表项「删除」按钮 |
| `OPEN_SETTINGS` | 打开设置页 | 面板 header 齿轮按钮 |

**`CONTEXT_INVALIDATED` 处理**：`loadConversations()` 的 catch 中显示「扩展已更新或重载，请刷新当前页面后重试」；`exportAll()` 中弹 alert 提示刷新。其他 `sendMessage` 调用点（如导出/删除按钮）未单独 catch，错误会被吞掉但不会中断脚本。

### 对话列表项的结构

每个 `conv-item` 包含三层：

```
.conv-item
├── .conv-top          标题 + 平台标签
│   ├── .conv-title    对话标题（title 属性放完整标题，文本截断省略号）
│   └── .conv-tag      平台名（deepseek/kimi/qianwen/yiyan → 中文名）
├── .conv-info         消息数 + 日期
└── .conv-btns         展开/折叠的操作按钮区
    ├── .btn-view      查看（调用 viewer.open）
    ├── .btn-export    导出 MD / 导出 JSON
    └── .btn-del       删除（confirm 确认后执行）
```

- 点击 `.conv-item` 非 按钮 区域切换 `expanded` 类，显示/隐藏 `.conv-btns`。
- 按钮点击需 `e.stopPropagation()` 防止触发展开/折叠。
- `data-id` 存对话 ID，`data-fmt` 存导出格式，`data-platform-conv-id` 存平台对话 ID（删除后用于重新采集判断）。

### Markdown 渲染的占位符替换模式

`ConversationViewer.renderContent(content)` 采用「先提取特殊块 → marked 渲染 → 还原占位符」的三阶段模式，避免 marked 破坏数学公式和特殊标签：

1. **提取阶段**（按顺序）：
   - `<think>...</think>` → `%%BLOCK_N%%`（think 类型）
   - `<search_result>...</search_result>` → `%%BLOCK_N%%`（search 类型）
   - `$$...$$` 行间公式 → `%%BLOCK_N%%`（math_display 类型）
   - `$...$` 行内公式（不匹配 `$$`）→ `%%BLOCK_N%%`（math_inline 类型，无前后换行）
2. **marked 渲染阶段**：`marked.parse(processed, { breaks: true, gfm: true })`，marked 不会触碰 `%%BLOCK_N%%` 占位符。
3. **还原阶段**：正则 `%%BLOCK_(\d+)%%` 匹配占位符，按类型还原：
   - `math_display` → `renderMath(tex, true)`（KaTeX 渲染，失败降级为 `<div class="math-block">$$tex$$</div>`）
   - `math_inline` → `renderMath(tex, false)`（失败降级为 `<span class="math-inline">$tex$</span>`）
   - `think` → 可折叠块（默认折叠），内部内容再用 marked 渲染
   - `search` → 可折叠块（默认折叠），内部内容再用 marked 渲染

**占位符格式固定为 `%%BLOCK_{index}%%`**，不要修改——`blocks` 数组索引与占位符一一对应。

### 引用编号渲染约定

`viewer.js` 顶层注册了 marked 自定义 renderer：

```javascript
marked.use({
  renderer: {
    link({ href, title, text }) {
      const safeHref = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#';
      const titleAttr = title ? ` title="${title}"` : '';
      if (/^\d+$/.test(text.trim())) {
        return `<a href="${safeHref}"${titleAttr} class="cite-ref" target="_blank" rel="noreferrer">${text}</a>`;
      }
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noreferrer">${text}</a>`;
    }
  }
});
```

- 链接文本仅为数字时（如 `[1](url)`），渲染为 `<a class="cite-ref">`，CSS 中定义为圆圈上标样式（18×18px 圆形边框，`vertical-align: super`）。
- **仅影响 viewer 内的渲染**，存储格式仍为 `[N](url)`（DOM 适配器通过 turndown 转换得到）。
- 安全过滤：仅允许 `http:` / `https:` / `mailto:` / `/` / `#` 协议，其他协议（如 `javascript:`）替换为 `#`。

## 常见任务

### 任务 1: 修改悬浮球或面板样式

**场景**：调整悬浮球大小、颜色、位置，或面板宽度、字体等。

**步骤**：
1. 编辑 `content/ui/styles.js` 的 `AIChatStyles.mainCSS` 模板字符串。
2. 悬浮球样式在 `#ai-chat-ball { ... }` 块（默认 44×44px，`#2563eb` 蓝色，`right:24px; bottom:24px`）。
3. 面板样式在 `#ai-chat-panel { ... }` 块（默认 380px 宽，520px 最大高度）。
4. 查看器样式在 `#ai-chat-viewer { ... }` 块（默认 680px 宽，90vw/80vh 最大尺寸）。
5. **修改面板宽度后需同步更新 `positionPanel()`**：`floating-ball.js` 中 `const panelW = 380; const panelH = 520;` 是硬编码值，需与 CSS 一致，否则面板定位计算会偏。

**验证**：刷新页面，悬浮球/面板应呈现新样式；拖拽球后面板应正确定位在球附近（不超出视口）。

### 任务 2: 新增面板工具栏按钮

**场景**：在面板工具栏（`.panel-toolbar`）新增一个操作按钮，如「按日期排序」。

**步骤**：
1. 在 `floating-ball.js` 的 `createPanel()` 方法中，找到 `.panel-toolbar` 的 HTML 模板，追加按钮：
   ```html
   <button id="acc-sort-by-date">按日期排序</button>
   ```
2. 在 `createPanel()` 末尾的事件绑定区域添加：
   ```javascript
   this.panel.querySelector('#acc-sort-by-date').addEventListener('click', () => {
     // 排序逻辑，可存到 this.sortOrder，在 loadConversations 中使用
     this.loadConversations();
   });
   ```
3. 如需按钮样式，在 `styles.js` 的 `#ai-chat-panel .panel-toolbar button` 区域添加新类样式（默认按钮已有 hover 效果，主操作按钮加 `.btn-primary` 类）。

**验证**：刷新页面，面板工具栏应出现新按钮，点击后触发预期行为。

### 任务 3: 修改对话详情查看器的渲染逻辑

**场景**：需要支持新的特殊块类型（如 `<tool_call>...</tool_call>`），或修改现有渲染。

**步骤**：
1. 编辑 `content/ui/viewer.js` 的 `renderContent(content)` 方法。
2. 在提取阶段添加新的正则（放在 `<think>` 和 `<search_result>` 提取之后）：
   ```javascript
   processed = processed.replace(/<tool_call>\n?([\s\S]*?)\n?<\/tool_call>/g, (_, text) => {
     const idx = blocks.length;
     blocks.push({ type: 'tool_call', content: text.trim() });
     return `\n%%BLOCK_${idx}%%\n`;
   });
   ```
3. 在还原阶段的 `html.replace(/%%BLOCK_(\d+)%%/g, ...)` 中添加新类型分支：
   ```javascript
   if (block.type === 'tool_call') {
     return `<div class="tool-block"><div class="collapsible-header collapsed"><span class="arrow">▼</span>工具调用</div><div class="collapsible-body collapsed">${inner}</div></div>`;
   }
   ```
4. 在 `styles.js` 中添加 `.tool-block` 相关样式（参考 `.think-block` / `.search-block`）。

**验证**：构造含 `<tool_call>` 的测试消息，查看器应渲染为可折叠块。

### 任务 4: 修复 KaTeX 渲染失败问题

**场景**：查看器中数学公式显示为原始 LaTeX 文本而非渲染后的公式。

**步骤**：
1. 检查 KaTeX 库是否加载：Console 执行 `typeof katex`，应返回 `'function'`。若为 `'undefined'`，检查 `manifest.json` 中 `lib/katex.min.js` 是否在该平台的 content_scripts 列表中。
2. 检查 KaTeX CSS 是否注入：`document.querySelector('link[href*="katex.min.css"]')` 应返回 link 元素。`AIChatStyles.inject()` 中通过 `chrome.runtime.getURL('lib/katex.min.css')` 加载，需 `lib/katex.min.css` 在 `web_accessible_resources` 中（已在 `manifest.json` 中配置）。
3. 检查 `renderMath` 的 try-catch：KaTeX 渲染失败时静默降级为原始 LaTeX（`<div class="math-block">$$tex$$</div>`），不会报错。若需查看失败原因，临时在 catch 中加 `console.error('[Viewer] KaTeX 渲染失败:', e, tex)`。
4. **行内公式识别限制**：`$...$` 正则为 `/\$([^\$\n]+?)\$/g`，不匹配跨行或含 `$` 的公式。若公式内含 `$` 字符（如货币符号），会被错误识别——这是已知限制，存储时应确保 LaTeX 公式内不含裸 `$`。

**验证**：发送含 `$$E=mc^2$$` 和 `$x^2$` 的对话，查看器应分别渲染为居中公式和行内公式。

### 任务 5: 处理删除对话后的重新采集

**场景**：用户在面板中删除当前正在查看的对话，需立即重新采集而非等下次 URL 变化。

**步骤**：
1. 此逻辑已在 `floating-ball.js` 的 `.btn-del` 点击处理中实现，通常无需修改。
2. **关键流程**：
   - 删除后 `collector._deletedConvIds.add(platformConvId)` 记录已删除 ID。
   - 检查当前对话 ID（`collector.getConvIdFromUrl()` 或 `collector.getDomAdapter()?.getConversationId()`）是否等于被删除的 `platformConvId`。
   - 若匹配，从 `_deletedConvIds` 中移除该 ID，清空 `capturedHashes`（避免去重命中旧 hash），按模式分流：
     - 网络模式：`collector.requestConversationData(platformConvId)` 主动请求 API。
     - DOM 模式：`collector.captureCurrentConversation()` 走 DOM 提取。
3. **调试**：Console 会打印 `[FloatingBall/Debug] 已记录删除对话ID`、`[FloatingBall/Debug] 删除后检查`、`[FloatingBall/Debug] 当前正在查看被删除的对话，立即触发重新采集` 三条日志，按此追踪流程。

**验证**：在 DeepSeek 对话页面删除当前对话，Console 应出现重新采集日志，刷新面板后该对话应重新出现。

### 任务 6: 新增对话列表项的操作按钮

**场景**：在 `.conv-btns` 中新增一个按钮，如「复制对话内容」。

**步骤**：
1. 在 `floating-ball.js` 的 `loadConversations()` 方法中，找到 `item.innerHTML` 模板的 `.conv-btns` 块，追加按钮：
   ```html
   <button class="btn-copy" data-id="${conv.id}">复制</button>
   ```
2. 在 `item.querySelectorAll('.btn-del').forEach(...)` 之后添加事件绑定：
   ```javascript
   item.querySelectorAll('.btn-copy').forEach(btn => {
     btn.addEventListener('click', async (e) => {
       e.stopPropagation();
       const resp = await this.sendMessage({ type: 'GET_CONVERSATIONS' });
       const conv = resp?.find(c => c.id === btn.dataset.id);
       if (conv) {
         const text = conv.messages.map(m => `【${m.role}】\n${m.content}`).join('\n\n');
         navigator.clipboard.writeText(text);
       }
     });
   });
   ```
3. 在 `styles.js` 中添加 `.btn-copy` 样式（参考 `.btn-view`）。

**验证**：刷新面板，列表项展开后应出现「复制」按钮，点击后剪贴板应含对话文本。

## 扩展点

### 新增一个 UI 组件

若需新增独立 UI 组件（如「设置浮窗」「统计图表」）：

1. 在 `content/ui/` 下新建 `{component}.js`，定义类或对象。
2. **样式注入复用 `AIChatStyles`**：在 `styles.js` 的 `mainCSS` 中追加新组件样式，或新建 `style` 元素单独注入（但需注意 id 去重）。
3. **拖拽复用 `makeDraggable`**：从 `styles.js` 调用 `makeDraggable(element, handle)`，无需重复实现。
4. 在 `manifest.json` 的所有平台 content_scripts 中加载新文件（在 `floating-ball.js` 之后、`exporter-base.js` 之前）。
5. 在 `exporter-base.js` 的 `initUi()` 中实例化新组件（若需与采集器协作，传入 `this`）。

**关键约束**：
- **不要使用 Shadow DOM**——本目录的 UI 组件（`#ai-chat-ball` / `#ai-chat-panel` / `#ai-chat-viewer`）直接 append 到 `document.body`，样式注入到 `document.head`。Shadow DOM 隔离会导致 KaTeX CSS、marked 渲染的样式无法穿透。`ai-ball.js`（紫色 AI 问答球）用 Shadow DOM 是因为它有完全独立的样式系统，不要在本目录效仿。
- **z-index 层级**：悬浮球 `2147483647`（最高），面板 `2147483646`，查看器 `2147483647`。新组件避免超过此值。

### 扩展 marked 渲染规则

`viewer.js` 顶层 `marked.use({ renderer: { ... } })` 可扩展更多自定义 renderer：

```javascript
marked.use({
  renderer: {
    code({ text, lang }) {
      // 自定义代码块渲染，如添加复制按钮
      return `<pre><code class="language-${lang}">${this.escapeHtml(text)}</code></pre>`;
    },
    table(...) { /* 自定义表格渲染 */ }
  }
});
```

**注意**：marked v12+ 的 renderer 接收对象参数（如 `link({ href, title, text })`），而非位置参数。若 marked 版本升级，需同步调整 renderer 签名。

### 扩展对话列表的显示信息

`loadConversations()` 中每个 `conv-item` 的 `innerHTML` 是模板字符串，可自由扩展显示字段（如对话时长、消息平均长度等）。`conv` 对象包含 `id` / `title` / `platform` / `messages` / `updatedAt` / `platformConversationId` 等字段，从 background 返回。

## 注意事项（坑）

- **`makeDraggable` 与悬浮球自带拖拽的区别**：`floating-ball.js` 的悬浮球没用 `makeDraggable`，而是手写 `onMouseDown/Move/Up`，因为需要区分「点击」和「拖拽」（`hasMoved` 标记，移动 >3px 才算拖拽，否则 `onMouseUp` 触发 `togglePanel()`）。若误用 `makeDraggable` 改造悬浮球，会导致点击无法打开面板。面板和查看器用 `makeDraggable` 是因为它们的 header 上没有点击行为。
- **面板定位的硬编码尺寸**：`positionPanel()` 中 `const panelW = 380; const panelH = 520;` 是硬编码值，必须与 `styles.js` 中 `#ai-chat-panel` 的 `width: 380px; max-height: 520px;` 保持一致。若修改了面板尺寸而忘记同步这两处，面板定位会偏移（如面板比球更靠右、超出视口等）。定位逻辑：默认在球的左上方，若左侧空间不足则放右上方，若上方空间不足则放下方，最终 clamp 到视口内（8px 边距）。
- **扩展上下文失效后的降级处理不完整**：`sendMessage` 会 reject `CONTEXT_INVALIDATED`，但只有 `loadConversations()` 和 `exportAll()` 显式 catch 并提示用户刷新。其他调用点（如「导出 MD/JSON」「查看」「删除」按钮的点击处理）未单独 catch，`CONTEXT_INVALIDATED` 错误会被外层 async 函数吞掉，按钮无反应且无提示。**若用户反馈按钮点击无反应，首先检查 `chrome.runtime.id` 是否为 undefined**。
- **KaTeX CSS 加载依赖 `web_accessible_resources`**：`AIChatStyles.inject()` 通过 `chrome.runtime.getURL('lib/katex.min.css')` 加载 KaTeX 样式，该文件必须在 `manifest.json` 的 `web_accessible_resources.resources` 中列出（已配置）。若新增平台时忘记在 `web_accessible_resources.matches` 中添加该平台域名，KaTeX CSS 会加载失败（CSP 拦截），公式无样式但 HTML 结构仍在。
- **marked 自定义 renderer 的协议过滤**：`viewer.js` 的 `link` renderer 用 `/^(https?:|mailto:|\/|#)/i` 过滤协议，`javascript:` 等危险协议会被替换为 `#`。**不要移除此过滤**——对话内容来自平台页面，可能含用户输入的恶意链接。所有链接均加 `target="_blank" rel="noreferrer"`，防止反向链接泄露和 tab nabbing。
- **`renderContent` 的占位符替换顺序敏感**：必须先提取 `<think>` / `<search_result>`，再提取 `$$...$$` 行间公式，最后提取 `$...$` 行内公式。若顺序颠倒，`<think>` 块内的 `$...$` 会被先提取为占位符，导致 think 内容被截断。**行内公式正则 `/\$([^\$\n]+?)\$/g` 排除了换行符**，避免跨行匹配；行间公式 `/\$\$([\s\S]+?)\$\$/g` 用 `[\s\S]` 允许跨行。
- **事件委托而非内联 onclick**：`viewer.js` 的 `createViewer()` 中用事件委托处理 `.collapsible-header` 的点击折叠（`#acc-viewer-body` 上监听 click，`e.target.closest('.collapsible-header')`）。**不能用内联 `onclick`**——宿主 AI 平台的 CSP（Content Security Policy）可能收紧，内联事件处理器会被拦截。同样，`conv-item` 的按钮事件也是在 `loadConversations()` 中用 `addEventListener` 绑定。
- **`platformNames` 映射不完整**：`floating-ball.js` 中有两处 `platformNames` 对象（`loadConversations` 和 `updatePlatformFilter`），只映射了 `deepseek/chatgpt/claude/kimi/qianwen/yiyan`。若新增平台（如 `doubao`、`fudan`），标签会显示原始 platformName（如 `doubao` 而非「豆包」）。**新增平台时需同步更新两处 `platformNames`**（两处的映射不完全一致，`loadConversations` 中有 `chatgpt/claude/yiyan` 但 `updatePlatformFilter` 中没有，这是因为 `updatePlatformFilter` 的数据来自 background 的实际采集平台列表）。
- **`escapeHtml` 的实现**：`FloatingBall` 和 `ConversationViewer` 各自实现了 `escapeHtml(text)`，逻辑相同（`div.textContent = text; return div.innerHTML`）。这是有意的代码重复，避免跨文件依赖。**不要试图抽公共函数**——两个文件在不同 content_script 实例中执行，共享作用域不可靠。
- **查看器拖拽与折叠块的冲突**：`makeDraggable` 在 `viewer-header` 上绑定 mousedown，会 `e.preventDefault()`。但 `viewer-body` 内的 `.collapsible-header` 点击折叠不受影响，因为拖拽手柄是 header 而非 body。若误将 `viewer-body` 设为拖拽手柄，点击折叠块时会触发拖拽（`makeDraggable` 虽然忽略了 `a` 标签，但 `.collapsible-header` 是 `div`，不在忽略列表中）。
- **`loadConversations` 的搜索清空逻辑**：`#acc-search-input` 的 `input` 事件监听中，当输入框清空且 `this.searchQuery` 非空时，重置 `searchQuery` 并重新加载。**若用户清空输入框但未触发 `input` 事件**（如通过 JS 设置 value），搜索状态不会重置。这是已知限制，通常不影响正常使用。

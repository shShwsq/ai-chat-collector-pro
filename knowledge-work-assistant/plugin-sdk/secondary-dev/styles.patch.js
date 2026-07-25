// ============================================================================
// styles.patch.js — 知识工作助手（KWA）二次开发 patch
// 替换原文件位置：web-ai-chat-collector/content/ui/styles.js
//
// 修改点列表（相对原 styles.js）：
//   1. AIChatStyles.inject() 末尾追加：动态创建 <link> 引入 kwa-plugin.css
//      （部署时把 kwa-plugin.css 放到原插件 content/ui/ 目录下）
//   2. mainCSS 中所有 #2563eb → var(--kwa-accent, #1a7f6e)
//   3. mainCSS 中所有 #1d4ed8 → var(--kwa-accent-hover, #15665a)
//   4. mainCSS 中所有 #667eea → var(--kwa-accent, #1a7f6e)
//   5. #ai-chat-ball 的 background 改为 var(--kwa-accent, #1a7f6e)
//   6. 在 #ai-chat-ball / #ai-chat-panel .panel-header / #ai-chat-panel .panel-search
//      button / #ai-chat-viewer .viewer-header 等元素样式上加注释说明
//      "主色已变量化，跟随主应用 study/work 模式"
//
// 部署方式：
//   用本文件整体覆盖 patched 插件 content/ui/styles.js。
//   并确保 kwa-plugin.css 已复制到 patched 插件 content/ui/ 目录。
//   详见 PATCH-GUIDE.md Step 2 / Step 3。
//
// 模式切换：
//   主色已变量化为 CSS 变量，由 kwa-plugin.css 中 [data-kwa-mode="study"|"work"]
//   决定。在 <html> 元素上加 data-kwa-mode="study" 或 "work" 切换；
//   不设置时默认回退 study（墨绿 #1a7f6e）。
// ============================================================================

// 通用拖拽工具：让元素可通过指定 handle 拖动
// element: 要拖动的 DOM 元素
// handle: 拖动手柄（如 header），默认为 element 本身
function makeDraggable(element, handle) {
  const dragHandle = handle || element;
  let isDragging = false;
  let offsetX = 0, offsetY = 0;

  dragHandle.addEventListener('mousedown', (e) => {
    // 忽略按钮、输入框等交互元素上的拖拽
    if (e.target.closest('button, input, select, textarea, a')) return;

    isDragging = true;
    const rect = element.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    dragHandle.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    const maxX = window.innerWidth - element.offsetWidth;
    const maxY = window.innerHeight - element.offsetHeight;
    element.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
    element.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    dragHandle.style.cursor = '';
  });
}

const AIChatStyles = {
  inject() {
    if (document.getElementById('ai-chat-collector-styles')) return;

    const style = document.createElement('style');
    style.id = 'ai-chat-collector-styles';
    style.textContent = this.mainCSS;
    document.head.appendChild(style);

    // 动态加载 KaTeX CSS
    const katexCss = document.createElement('link');
    katexCss.rel = 'stylesheet';
    katexCss.href = chrome.runtime.getURL('lib/katex.min.css');
    document.head.appendChild(katexCss);

    // 数学公式额外样式
    const mathStyle = document.createElement('style');
    mathStyle.textContent = this.mathCSS;
    document.head.appendChild(mathStyle);

    // ---- KWA patch：动态引入 kwa-plugin.css（统一样式包，主色变量化） ----
    // 部署时需把 kwa-plugin.css 放到原插件 content/ui/ 目录下。
    // 该 CSS 提供 --kwa-accent / --kwa-accent-hover 等变量，并由
    // [data-kwa-mode="study"|"work"] 决定取值。
    if (!document.getElementById('kwa-plugin-css-link')) {
      const kwaCss = document.createElement('link');
      kwaCss.id = 'kwa-plugin-css-link';
      kwaCss.rel = 'stylesheet';
      // chrome.runtime.getURL 在 content script 中返回扩展内绝对路径
      try {
        kwaCss.href = chrome.runtime.getURL('content/ui/kwa-plugin.css');
      } catch (e) {
        // 退回相对路径（与原 styles.js 同目录）
        kwaCss.href = 'kwa-plugin.css';
      }
      document.head.appendChild(kwaCss);
    }
  },

  mainCSS: `
      /* 主色已变量化，跟随主应用 study/work 模式（由 kwa-plugin.css 提供） */
      #ai-chat-ball {
        position: fixed;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        /* KWA patch: 原 rgba(102, 126, 234, 0.4) → 主色阴影 */
        box-shadow: 0 2px 12px rgba(26, 127, 110, 0.4);
        cursor: grab;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        transition: box-shadow 0.2s, transform 0.2s;
        right: 24px;
        bottom: 24px;
      }
      #ai-chat-ball:hover {
        /* KWA patch: 主色阴影加深 */
        box-shadow: 0 4px 20px rgba(26, 127, 110, 0.6);
        transform: scale(1.08);
      }
      #ai-chat-ball:active {
        cursor: grabbing;
      }
      #ai-chat-ball svg {
        width: 22px;
        height: 22px;
        fill: #fff;
        pointer-events: none;
      }
      #ai-chat-ball .badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 18px;
        height: 18px;
        border-radius: 9px;
        background: #10b981;
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        pointer-events: none;
      }
      #ai-chat-panel {
        position: fixed;
        width: 380px;
        max-height: 520px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18);
        z-index: 2147483646;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #1a1a1a;
      }
      #ai-chat-panel.open {
        display: flex;
      }
      /* 主色已变量化，跟随主应用 study/work 模式 */
      #ai-chat-panel .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        cursor: grab;
      }
      #ai-chat-panel .panel-header h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        flex: 1;
      }
      #ai-chat-panel .panel-header .settings-btn {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 2px 6px;
        margin-right: 4px;
        opacity: 0.8;
        display: flex;
        align-items: center;
      }
      #ai-chat-panel .panel-header .settings-btn:hover {
        opacity: 1;
      }
      #ai-chat-panel .panel-header .close-btn {
        background: none;
        border: none;
        color: #fff;
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        opacity: 0.8;
      }
      #ai-chat-panel .panel-header .close-btn:hover {
        opacity: 1;
      }
      #ai-chat-panel .panel-toolbar {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
      }
      #ai-chat-panel .panel-search {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
      }
      #ai-chat-panel .panel-search input {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        font-size: 12px;
        outline: none;
        color: #1a1a1a;
        background: #fff;
      }
      #ai-chat-panel .panel-search input:focus {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        border-color: var(--kwa-accent, #1a7f6e);
        /* KWA patch: 原 rgba(37, 99, 235, 0.15) → 主色透明 */
        box-shadow: 0 0 0 2px rgba(26, 127, 110, 0.15);
      }
      #ai-chat-panel .panel-search input::placeholder {
        color: #9ca3af;
      }
      /* 主色已变量化，跟随主应用 study/work 模式 */
      #ai-chat-panel .panel-search button {
        padding: 6px 12px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        white-space: nowrap;
      }
      #ai-chat-panel .panel-search button:hover {
        /* KWA patch: 原 #1d4ed8 → var(--kwa-accent-hover) */
        background: var(--kwa-accent-hover, #15665a);
      }
      #ai-chat-panel .panel-toolbar select {
        flex: 1;
        padding: 5px 8px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        font-size: 12px;
        background: #fff;
        color: #1a1a1a;
        cursor: pointer;
        outline: none;
      }
      #ai-chat-panel .panel-toolbar button {
        padding: 5px 10px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        background: #fff;
        color: #374151;
        white-space: nowrap;
        transition: background 0.15s;
      }
      #ai-chat-panel .panel-toolbar button:hover {
        background: #f3f4f6;
      }
      #ai-chat-panel .panel-toolbar .btn-primary {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        /* KWA patch: 原 #667eea → var(--kwa-accent) */
        border-color: var(--kwa-accent, #1a7f6e);
      }
      #ai-chat-panel .panel-toolbar .btn-primary:hover {
        /* KWA patch: 原 #1d4ed8 → var(--kwa-accent-hover) */
        background: var(--kwa-accent-hover, #15665a);
      }
      #ai-chat-panel .conv-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        max-height: 400px;
      }
      #ai-chat-panel .conv-list .empty {
        text-align: center;
        padding: 32px 16px;
        color: #aaa;
        font-size: 13px;
      }
      #ai-chat-panel .conv-item {
        background: #fff;
        border: 1px solid #eee;
        border-radius: 8px;
        padding: 10px 12px;
        cursor: pointer;
        margin-bottom: 6px;
        transition: border-color 0.15s;
      }
      #ai-chat-panel .conv-item:hover {
        border-color: #b4c6f7;
      }
      #ai-chat-panel .conv-item .conv-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      #ai-chat-panel .conv-item .conv-title {
        font-weight: 500;
        font-size: 13px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-right: 8px;
      }
      #ai-chat-panel .conv-item .conv-tag {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: #eff6ff;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        color: var(--kwa-accent, #1a7f6e);
        white-space: nowrap;
      }
      #ai-chat-panel .conv-item .conv-info {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #aaa;
      }
      #ai-chat-panel .conv-item .conv-btns {
        display: none;
        gap: 4px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #f5f5f5;
      }
      #ai-chat-panel .conv-item.expanded .conv-btns {
        display: flex;
      }
      #ai-chat-panel .conv-item .conv-btns button {
        padding: 4px 10px;
        border: 1px solid #e0e0e0;
        border-radius: 5px;
        font-size: 11px;
        cursor: pointer;
        background: #fff;
        color: #374151;
        transition: background 0.15s;
      }
      #ai-chat-panel .conv-item .conv-btns button:hover {
        background: #f3f4f6;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-export {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        /* KWA patch: 原 #667eea → var(--kwa-accent) */
        border-color: var(--kwa-accent, #1a7f6e);
      }
      #ai-chat-panel .conv-item .conv-btns .btn-export:hover {
        /* KWA patch: 原 #1d4ed8 → var(--kwa-accent-hover) */
        background: var(--kwa-accent-hover, #15665a);
      }
      #ai-chat-panel .conv-item .conv-btns .btn-del {
        color: #dc2626;
        border-color: #fca5a5;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-del:hover {
        background: #fef2f2;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-view {
        background: #f0f9ff;
        color: #0369a1;
        border-color: #bae6fd;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-view:hover {
        background: #e0f2fe;
      }
      /* 完整对话查看弹窗 - 浮动面板 */
      #ai-chat-viewer {
        position: fixed;
        z-index: 2147483647;
        display: none;
      }
      #ai-chat-viewer.open {
        display: block;
      }
      #ai-chat-viewer .viewer-box {
        position: fixed;
        width: 680px;
        max-width: 90vw;
        max-height: 80vh;
        background: #fff;
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      }
      /* 主色已变量化，跟随主应用 study/work 模式 */
      #ai-chat-viewer .viewer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        cursor: grab;
      }
      #ai-chat-viewer .viewer-header h3 {
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #ai-chat-viewer .viewer-header .close-btn {
        background: none;
        border: none;
        color: #fff;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        opacity: 0.8;
        margin-left: 12px;
      }
      #ai-chat-viewer .viewer-header .close-btn:hover {
        opacity: 1;
      }
      #ai-chat-viewer .viewer-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px;
        font-size: 13px;
        line-height: 1.6;
      }
      #ai-chat-viewer .viewer-body .msg-block {
        margin-bottom: 16px;
        padding: 10px 14px;
        border-radius: 8px;
      }
      #ai-chat-viewer .viewer-body .msg-block.user {
        background: #eff6ff;
        border-left: 3px solid #3b82f6;
      }
      #ai-chat-viewer .viewer-body .msg-block.assistant {
        background: #f0fdf4;
        border-left: 3px solid #22c55e;
      }
      #ai-chat-viewer .viewer-body .msg-role {
        font-weight: 600;
        font-size: 11px;
        margin-bottom: 4px;
        text-transform: uppercase;
      }
      #ai-chat-viewer .viewer-body .msg-block.user .msg-role {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        color: var(--kwa-accent, #1a7f6e);
      }
      #ai-chat-viewer .viewer-body .msg-block.assistant .msg-role {
        color: #16a34a;
      }
      #ai-chat-viewer .viewer-body .msg-content {
        color: #1a1a1a;
        word-break: break-word;
      }
      #ai-chat-viewer .viewer-body .msg-content p { margin: 0 0 8px; }
      #ai-chat-viewer .viewer-body .msg-content p:last-child { margin-bottom: 0; }
      #ai-chat-viewer .viewer-body .msg-content pre {
        background: #1e293b;
        color: #e2e8f0;
        padding: 12px 16px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.5;
      }
      #ai-chat-viewer .viewer-body .msg-content code {
        background: #f1f5f9;
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 12px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      }
      #ai-chat-viewer .viewer-body .msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
      }
      #ai-chat-viewer .viewer-body .msg-content table {
        border-collapse: collapse;
        margin: 8px 0;
        font-size: 12px;
        width: 100%;
      }
      #ai-chat-viewer .viewer-body .msg-content th,
      #ai-chat-viewer .viewer-body .msg-content td {
        border: 1px solid #e2e8f0;
        padding: 6px 10px;
        text-align: left;
      }
      #ai-chat-viewer .viewer-body .msg-content th {
        background: #f8fafc;
        font-weight: 600;
      }
      #ai-chat-viewer .viewer-body .msg-content h1,
      #ai-chat-viewer .viewer-body .msg-content h2,
      #ai-chat-viewer .viewer-body .msg-content h3,
      #ai-chat-viewer .viewer-body .msg-content h4,
      #ai-chat-viewer .viewer-body .msg-content h5,
      #ai-chat-viewer .viewer-body .msg-content h6 {
        font-weight: 600;
        color: #1a1a1a;
        margin: 12px 0 6px;
        line-height: 1.3;
      }
      #ai-chat-viewer .viewer-body .msg-content h1 { font-size: 18px; }
      #ai-chat-viewer .viewer-body .msg-content h2 { font-size: 16px; }
      #ai-chat-viewer .viewer-body .msg-content h3 { font-size: 15px; }
      #ai-chat-viewer .viewer-body .msg-content h4 { font-size: 14px; }
      #ai-chat-viewer .viewer-body .msg-content h5 { font-size: 13px; }
      #ai-chat-viewer .viewer-body .msg-content h6 { font-size: 12px; color: #6b7280; }
      #ai-chat-viewer .viewer-body .msg-content strong,
      #ai-chat-viewer .viewer-body .msg-content b {
        font-weight: 600;
        color: #111827;
      }
      #ai-chat-viewer .viewer-body .msg-content ul,
      #ai-chat-viewer .viewer-body .msg-content ol {
        padding-left: 24px;
        margin: 4px 0;
        list-style: revert;
      }
      #ai-chat-viewer .viewer-body .msg-content ul { list-style-type: disc; }
      #ai-chat-viewer .viewer-body .msg-content ol { list-style-type: decimal; }
      #ai-chat-viewer .viewer-body .msg-content li {
        margin: 2px 0;
        display: list-item;
      }
      #ai-chat-viewer .viewer-body .msg-content li::marker {
        color: #6b7280;
      }
      #ai-chat-viewer .viewer-body .msg-content blockquote {
        border-left: 3px solid #d1d5db;
        padding-left: 12px;
        color: #6b7280;
        margin: 8px 0;
      }
      #ai-chat-viewer .viewer-body .msg-content a {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        color: var(--kwa-accent, #1a7f6e);
        text-decoration: none;
      }
      #ai-chat-viewer .viewer-body .msg-content a:hover {
        text-decoration: underline;
      }
      #ai-chat-viewer .viewer-body .msg-content a.cite-ref {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin: 0 1px;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        border: 1px solid var(--kwa-accent, #1a7f6e);
        border-radius: 50%;
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        color: var(--kwa-accent, #1a7f6e);
        font-size: 11px;
        line-height: 1;
        vertical-align: super;
        text-decoration: none;
        box-sizing: border-box;
      }
      #ai-chat-viewer .viewer-body .msg-content a.cite-ref:hover {
        /* KWA patch: 原 #2563eb → var(--kwa-accent) */
        background: var(--kwa-accent, #1a7f6e);
        color: #fff;
        text-decoration: none;
      }
      #ai-chat-viewer .viewer-body .msg-content img {
        max-width: 100%;
        border-radius: 6px;
      }
      #ai-chat-viewer .viewer-body .msg-content hr {
        border: none;
        border-top: 1px solid #e5e7eb;
        margin: 12px 0;
      }
      #ai-chat-viewer .viewer-body .msg-content .think-block,
      #ai-chat-viewer .viewer-body .msg-content .search-block {
        margin: 6px 0;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        padding: 4px 0;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header:hover {
        opacity: 0.8;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header .arrow {
        transition: transform 0.2s;
        font-size: 10px;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header.collapsed .arrow {
        transform: rotate(-90deg);
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-body {
        overflow: hidden;
        transition: max-height 0.3s ease;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-body.collapsed {
        max-height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        background: none !important;
        overflow: hidden;
      }
      #ai-chat-viewer .viewer-body .msg-content .think-block .collapsible-header {
        color: #6b7280;
      }
      #ai-chat-viewer .viewer-body .msg-content .think-block .collapsible-body {
        color: #6b7280;
        font-style: italic;
        border-left: 2px solid #d1d5db;
        padding-left: 10px;
      }
      #ai-chat-viewer .viewer-body .msg-content .search-block .collapsible-header {
        color: #0369a1;
      }
      #ai-chat-viewer .viewer-body .msg-content .search-block .collapsible-body {
        color: #0369a1;
        background: #f0f9ff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
      }
    `,

  mathCSS: `
      #ai-chat-viewer .msg-content .math-block {
        text-align: center;
        margin: 8px 0;
        overflow-x: auto;
      }
      #ai-chat-viewer .msg-content .math-inline {
        display: inline;
      }
    `
};

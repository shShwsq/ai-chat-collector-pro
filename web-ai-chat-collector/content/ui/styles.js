// ui/styles.js - UI 样式注入
// 所有规则都通过 #ai-chat-* ID 前缀建立命名空间，避免与宿主页面样式冲突

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

    // KaTeX CSS 与 viewer 公式样式改由各 shadow DOM 内部加载（viewer.js / ai-ball.js），
    // head 全局样式无法穿透 shadow 边界，在 head 中注入已无意义
  },

  // mainCSS: 注入到宿主页 head，控制浮球与面板样式
  // 全部规则带 #ai-chat-* 前缀，避免与宿主页面样式冲突
  mainCSS: `
      /* ===== 浮球 ===== */
      #ai-chat-ball {
        position: fixed;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #1a7f6e;
        box-shadow: 0 2px 8px rgba(26, 127, 110, 0.28), 0 1px 3px rgba(0, 0, 0, 0.08);
        cursor: grab;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        transition: box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    background 220ms cubic-bezier(0.22, 1, 0.36, 1);
        right: 24px;
        bottom: 24px;
      }
      #ai-chat-ball:hover {
        background: #176b5d;
        box-shadow: 0 4px 16px rgba(26, 127, 110, 0.38), 0 2px 6px rgba(0, 0, 0, 0.1);
        transform: scale(1.06);
      }
      #ai-chat-ball:active {
        cursor: grabbing;
        transform: scale(0.96);
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
        background: #d94545;
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        pointer-events: none;
        border: 2px solid #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      /* ===== 面板 ===== */
      #ai-chat-panel {
        position: fixed;
        width: 380px;
        max-height: 520px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14), 0 4px 12px rgba(0, 0, 0, 0.08);
        z-index: 2147483646;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
        font-size: 13px;
        color: #1d1d1f;
        border: 1px solid #f0f0f2;
        opacity: 0;
        transform: translateY(8px) scale(0.98);
        transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel.open {
        display: flex;
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      #ai-chat-panel .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        background: #fff;
        color: #1d1d1f;
        cursor: grab;
        border-bottom: 1px solid #f0f0f2;
        gap: 6px;
      }
      #ai-chat-panel .panel-header h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        letter-spacing: -0.01em;
      }
      #ai-chat-panel .panel-header .settings-btn {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #8e8e93;
        cursor: pointer;
        padding: 0;
        border-radius: 6px;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-header .settings-btn:hover {
        background: #f5f5f7;
        color: #1a7f6e;
      }
      #ai-chat-panel .panel-header .close-btn {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #8e8e93;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        border-radius: 6px;
        margin-left: 4px;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-header .close-btn:hover {
        background: #f5f5f7;
        color: #1d1d1f;
      }
      #ai-chat-panel .panel-search {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f2;
        background: #fafafa;
      }
      #ai-chat-panel .panel-search input {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid #e5e5e7;
        border-radius: 6px;
        font-size: 12px;
        outline: none;
        color: #1d1d1f;
        background: #fff;
        transition: border-color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-search input:hover {
        border-color: #d8d8dc;
      }
      #ai-chat-panel .panel-search input:focus {
        border-color: #1a7f6e;
        box-shadow: 0 0 0 3px rgba(26, 127, 110, 0.16);
      }
      #ai-chat-panel .panel-search input::placeholder {
        color: #8e8e93;
      }
      #ai-chat-panel .panel-search button {
        padding: 6px 12px;
        border: 1px solid #1a7f6e;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        background: #1a7f6e;
        color: #fff;
        white-space: nowrap;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    border-color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-search button:hover {
        background: #176b5d;
        border-color: #176b5d;
      }
      #ai-chat-panel .panel-search button:active {
        transform: scale(0.97);
      }
      #ai-chat-panel .panel-toolbar {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        border-bottom: 1px solid #f0f0f2;
        background: #fff;
        align-items: center;
      }
      #ai-chat-panel .panel-toolbar select {
        flex: 1;
        min-width: 0;
        padding: 5px 24px 5px 8px;
        border: 1px solid #e5e5e7;
        border-radius: 6px;
        font-size: 12px;
        background: #fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='%238e8e93' d='M2 4l4 4 4-4z'/></svg>") no-repeat right 6px center / 12px 12px;
        -webkit-appearance: none;
        appearance: none;
        color: #1d1d1f;
        cursor: pointer;
        outline: none;
        transition: border-color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-toolbar select:hover {
        border-color: #d8d8dc;
      }
      #ai-chat-panel .panel-toolbar select:focus {
        border-color: #1a7f6e;
        box-shadow: 0 0 0 3px rgba(26, 127, 110, 0.16);
      }
      #ai-chat-panel .panel-toolbar button {
        padding: 5px 12px;
        border: 1px solid #e5e5e7;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        background: #fff;
        color: #6e6e73;
        white-space: nowrap;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    border-color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .panel-toolbar button:hover {
        background: #f5f5f7;
        color: #1d1d1f;
        border-color: #d8d8dc;
      }
      #ai-chat-panel .panel-toolbar button:active {
        transform: scale(0.97);
      }
      #ai-chat-panel .panel-toolbar .btn-primary {
        background: #1a7f6e;
        color: #fff;
        border-color: #1a7f6e;
      }
      #ai-chat-panel .panel-toolbar .btn-primary:hover {
        background: #176b5d;
        border-color: #176b5d;
      }
      #ai-chat-panel .conv-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px 12px;
        max-height: 400px;
      }
      #ai-chat-panel .conv-list::-webkit-scrollbar {
        width: 8px;
      }
      #ai-chat-panel .conv-list::-webkit-scrollbar-track {
        background: transparent;
      }
      #ai-chat-panel .conv-list::-webkit-scrollbar-thumb {
        background: #e5e5e7;
        border-radius: 4px;
        border: 2px solid #fff;
      }
      #ai-chat-panel .conv-list::-webkit-scrollbar-thumb:hover {
        background: #d8d8dc;
      }
      #ai-chat-panel .conv-list .empty {
        text-align: center;
        padding: 48px 20px;
        color: #8e8e93;
        font-size: 13px;
        line-height: 1.7;
      }
      #ai-chat-panel .conv-list .empty small {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: #aaa;
      }
      #ai-chat-panel .conv-list .empty.empty-error {
        color: #d94545;
      }
      #ai-chat-panel .conv-list .empty.empty-error small {
        color: #8e8e93;
      }
      #ai-chat-panel .conv-item {
        background: #fff;
        border: 1px solid #f0f0f2;
        border-radius: 8px;
        padding: 10px 12px;
        cursor: pointer;
        margin-bottom: 6px;
        transition: border-color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .conv-item:hover {
        border-color: #dceae3;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.05);
      }
      #ai-chat-panel .conv-item:active {
        transform: scale(0.997);
      }
      #ai-chat-panel .conv-item.expanded {
        border-color: #dceae3;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.05);
      }
      #ai-chat-panel .conv-item .conv-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 6px;
      }
      #ai-chat-panel .conv-item .conv-title {
        font-weight: 600;
        font-size: 13px;
        color: #1d1d1f;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-right: 8px;
        letter-spacing: -0.005em;
      }
      #ai-chat-panel .conv-item .conv-tag {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 999px;
        background: #eef5f2;
        color: #1a7f6e;
        white-space: nowrap;
        letter-spacing: 0.02em;
      }
      /* 语义相似度徽章（紫色，与绿色平台徽章区分） */
      #ai-chat-panel .conv-item .conv-similarity {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 999px;
        background: #f3eeff;
        color: #6b46c1;
        white-space: nowrap;
        letter-spacing: 0.02em;
      }
      #ai-chat-panel .conv-item .conv-info {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #8e8e93;
      }
      /* 命中片段：搜索结果中提取的句子，配合 <mark> 高亮 term */
      #ai-chat-panel .conv-item .conv-snippet {
        margin-top: 6px;
        padding: 6px 10px;
        font-size: 11.5px;
        line-height: 1.5;
        color: #6e6e73;
        background: #fafafa;
        border-left: 2px solid #c4b5fd;
        border-radius: 6px;
        word-break: break-word;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        line-clamp: 3;
        box-orient: vertical;
        overflow: hidden;
      }
      #ai-chat-panel .conv-item .conv-snippet mark {
        background: #fef3c7;
        color: #1d1d1f;
        padding: 0 2px;
        border-radius: 2px;
        font-weight: 600;
      }
      #ai-chat-panel .conv-item .conv-btns {
        display: none;
        gap: 6px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed #f0f0f2;
        flex-wrap: wrap;
        animation: acc-fade-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .conv-item.expanded .conv-btns {
        display: flex;
      }
      @keyframes acc-fade-in {
        from { opacity: 0; transform: translateY(-2px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #ai-chat-panel .conv-item .conv-btns button {
        padding: 4px 10px;
        border: 1px solid #e5e5e7;
        border-radius: 5px;
        font-size: 11px;
        cursor: pointer;
        background: #fff;
        color: #6e6e73;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    border-color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-panel .conv-item .conv-btns button:hover {
        background: #f5f5f7;
        color: #1d1d1f;
        border-color: #d8d8dc;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-export {
        background: #1a7f6e;
        color: #fff;
        border-color: #1a7f6e;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-export:hover {
        background: #176b5d;
        border-color: #176b5d;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-del {
        color: #d94545;
        border-color: #f4c4c4;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-del:hover {
        background: #fef2f2;
        color: #c73e3e;
        border-color: #d94545;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-view {
        background: #eef5f2;
        color: #1a7f6e;
        border-color: #dceae3;
      }
      #ai-chat-panel .conv-item .conv-btns .btn-view:hover {
        background: #dceae3;
        color: #176b5d;
        border-color: #1a7f6e;
      }
    `,

  // viewerCSS: 注入到 viewer 的 shadow DOM 内，与宿主页样式双向隔离
  // :host 控制 host 元素（#ai-chat-viewer-host）的定位与显隐
  // viewer-box 显式设置 font-family/color，阻断宿主页继承
  viewerCSS: `
      :host {
        position: fixed;
        z-index: 2147483647;
        display: none;
      }
      :host(.open) {
        display: block;
      }
      #ai-chat-viewer .viewer-box {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
        color: #1d1d1f;
        position: fixed;
        width: 680px;
        max-width: 90vw;
        max-height: 80vh;
        background: #fff;
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.14), 0 4px 12px rgba(0, 0, 0, 0.08);
        border: 1px solid #f0f0f2;
      }
      #ai-chat-viewer .viewer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 18px;
        background: #fff;
        color: #1d1d1f;
        cursor: grab;
        border-bottom: 1px solid #f0f0f2;
      }
      #ai-chat-viewer .viewer-header h3 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: -0.01em;
        color: #1d1d1f;
      }
      #ai-chat-viewer .viewer-header .close-btn {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #8e8e93;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        border-radius: 6px;
        margin-left: 12px;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-viewer .viewer-header .close-btn:hover {
        background: #f5f5f7;
        color: #1d1d1f;
      }
      #ai-chat-viewer .viewer-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 18px;
        font-size: 13px;
        line-height: 1.65;
        color: #1d1d1f;
      }
      #ai-chat-viewer .viewer-body::-webkit-scrollbar {
        width: 8px;
      }
      #ai-chat-viewer .viewer-body::-webkit-scrollbar-track {
        background: transparent;
      }
      #ai-chat-viewer .viewer-body::-webkit-scrollbar-thumb {
        background: #e5e5e7;
        border-radius: 4px;
        border: 2px solid #fff;
      }
      #ai-chat-viewer .viewer-body::-webkit-scrollbar-thumb:hover {
        background: #d8d8dc;
      }

      /* ===== 消息气泡 ===== */
      #ai-chat-viewer .viewer-body .msg-block {
        margin-bottom: 14px;
        padding: 10px 14px;
        border-radius: 8px;
        border-left: 2px solid transparent;
      }
      #ai-chat-viewer .viewer-body .msg-block.user {
        background: #fafafa;
        border-left-color: #8e8e93;
      }
      #ai-chat-viewer .viewer-body .msg-block.assistant {
        background: #eef5f2;
        border-left-color: #1a7f6e;
      }
      #ai-chat-viewer .viewer-body .msg-role {
        font-weight: 600;
        font-size: 10px;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      #ai-chat-viewer .viewer-body .msg-block.user .msg-role {
        color: #6e6e73;
      }
      #ai-chat-viewer .viewer-body .msg-block.assistant .msg-role {
        color: #1a7f6e;
      }
      #ai-chat-viewer .viewer-body .msg-content {
        color: #1d1d1f;
        word-break: break-word;
      }

      /* ===== Markdown 渲染 ===== */
      #ai-chat-viewer .viewer-body .msg-content p { margin: 0 0 8px; }
      #ai-chat-viewer .viewer-body .msg-content p:last-child { margin-bottom: 0; }
      #ai-chat-viewer .viewer-body .msg-content h1,
      #ai-chat-viewer .viewer-body .msg-content h2,
      #ai-chat-viewer .viewer-body .msg-content h3,
      #ai-chat-viewer .viewer-body .msg-content h4,
      #ai-chat-viewer .viewer-body .msg-content h5,
      #ai-chat-viewer .viewer-body .msg-content h6 {
        font-weight: 600;
        color: #1d1d1f;
        margin: 14px 0 6px;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      #ai-chat-viewer .viewer-body .msg-content h1 { font-size: 18px; }
      #ai-chat-viewer .viewer-body .msg-content h2 { font-size: 16px; }
      #ai-chat-viewer .viewer-body .msg-content h3 { font-size: 15px; }
      #ai-chat-viewer .viewer-body .msg-content h4 { font-size: 14px; }
      #ai-chat-viewer .viewer-body .msg-content h5 { font-size: 13px; }
      #ai-chat-viewer .viewer-body .msg-content h6 { font-size: 12px; color: #6e6e73; }
      #ai-chat-viewer .viewer-body .msg-content strong,
      #ai-chat-viewer .viewer-body .msg-content b {
        font-weight: 600;
        color: #1d1d1f;
      }
      #ai-chat-viewer .viewer-body .msg-content pre {
        background: #1d1f22;
        color: #e6e6e8;
        padding: 12px 14px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.55;
        border: 1px solid rgba(255, 255, 255, 0.04);
      }
      #ai-chat-viewer .viewer-body .msg-content pre::-webkit-scrollbar {
        height: 6px;
      }
      #ai-chat-viewer .viewer-body .msg-content pre::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      #ai-chat-viewer .viewer-body .msg-content code {
        background: #f5f5f7;
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 12px;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
        color: #1d1d1f;
        border: 1px solid #f0f0f2;
      }
      #ai-chat-viewer .viewer-body .msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
        border: none;
        font-size: inherit;
      }
      #ai-chat-viewer .viewer-body .msg-content table {
        border-collapse: collapse;
        margin: 8px 0;
        font-size: 12px;
        width: 100%;
        border: 1px solid #e5e5e7;
        border-radius: 6px;
        overflow: hidden;
      }
      #ai-chat-viewer .viewer-body .msg-content th,
      #ai-chat-viewer .viewer-body .msg-content td {
        border: 1px solid #f0f0f2;
        padding: 6px 10px;
        text-align: left;
        vertical-align: top;
      }
      #ai-chat-viewer .viewer-body .msg-content th {
        background: #fafafa;
        font-weight: 600;
        color: #1d1d1f;
      }
      #ai-chat-viewer .viewer-body .msg-content tr:nth-child(even) td {
        background: #fafafa;
      }
      #ai-chat-viewer .viewer-body .msg-content ul,
      #ai-chat-viewer .viewer-body .msg-content ol {
        padding-left: 22px;
        margin: 6px 0;
        list-style-position: outside;
      }
      #ai-chat-viewer .viewer-body .msg-content ul { list-style-type: disc; }
      #ai-chat-viewer .viewer-body .msg-content ol { list-style-type: decimal; }
      #ai-chat-viewer .viewer-body .msg-content li {
        margin: 2px 0;
        display: list-item;
      }
      #ai-chat-viewer .viewer-body .msg-content li::marker {
        color: #8e8e93;
      }
      #ai-chat-viewer .viewer-body .msg-content blockquote {
        border-left: 2px solid #dceae3;
        padding: 2px 0 2px 12px;
        color: #6e6e73;
        margin: 8px 0;
        background: transparent;
      }
      #ai-chat-viewer .viewer-body .msg-content a {
        color: #1a7f6e;
        text-decoration: none;
        border-bottom: 1px solid #dceae3;
        transition: border-color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-viewer .viewer-body .msg-content a:hover {
        color: #176b5d;
        border-bottom-color: #1a7f6e;
      }
      #ai-chat-viewer .viewer-body .msg-content a.cite-ref {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        margin: 0 1px;
        border: 1px solid #1a7f6e;
        border-radius: 50%;
        color: #1a7f6e;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        vertical-align: super;
        text-decoration: none;
        box-sizing: border-box;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    color 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-viewer .viewer-body .msg-content a.cite-ref:hover {
        background: #1a7f6e;
        color: #fff;
        border-bottom: 1px solid #1a7f6e;
      }
      #ai-chat-viewer .viewer-body .msg-content img {
        max-width: 100%;
        border-radius: 6px;
      }
      #ai-chat-viewer .viewer-body .msg-content hr {
        border: none;
        border-top: 1px solid #f0f0f2;
        margin: 12px 0;
      }

      /* ===== 思考过程 / 搜索来源 折叠块 ===== */
      #ai-chat-viewer .viewer-body .msg-content .think-block,
      #ai-chat-viewer .viewer-body .msg-content .search-block {
        margin: 6px 0;
        border-radius: 6px;
        overflow: hidden;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header {
        display: flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        user-select: none;
        font-size: 11px;
        font-weight: 500;
        padding: 5px 8px;
        border-radius: 6px;
        transition: background 220ms cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header:hover {
        opacity: 0.85;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header .arrow {
        transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
        font-size: 9px;
        display: inline-block;
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-header.collapsed .arrow {
        transform: rotate(-90deg);
      }
      #ai-chat-viewer .viewer-body .msg-content .collapsible-body {
        overflow: hidden;
        transition: max-height 280ms cubic-bezier(0.22, 1, 0.36, 1);
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
        color: #8e8e93;
        background: #fafafa;
      }
      #ai-chat-viewer .viewer-body .msg-content .think-block .collapsible-body {
        color: #6e6e73;
        font-style: italic;
        background: #fafafa;
        border-left: 2px solid #e5e5e7;
        padding: 6px 10px;
        margin-top: 2px;
        font-size: 12px;
        line-height: 1.55;
      }
      #ai-chat-viewer .viewer-body .msg-content .search-block .collapsible-header {
        color: #1a7f6e;
        background: #eef5f2;
      }
      #ai-chat-viewer .viewer-body .msg-content .search-block .collapsible-body {
        color: #1d1d1f;
        background: #eef5f2;
        padding: 6px 10px;
        margin-top: 2px;
        border-left: 2px solid #1a7f6e;
        border-radius: 0 6px 6px 0;
        font-size: 12px;
        line-height: 1.55;
      }
    `,

  mathCSS: `
      #ai-chat-viewer .msg-content .math-block {
        text-align: center;
        margin: 10px 0;
        padding: 6px 0;
        overflow-x: auto;
      }
      #ai-chat-viewer .msg-content .math-block::-webkit-scrollbar {
        height: 6px;
      }
      #ai-chat-viewer .msg-content .math-block::-webkit-scrollbar-thumb {
        background: #e5e5e7;
        border-radius: 3px;
      }
      #ai-chat-viewer .msg-content .math-inline {
        display: inline;
      }
      #ai-chat-viewer .msg-content .katex {
        font-size: 1.05em;
        color: #1d1d1f;
      }
      #ai-chat-viewer .msg-content .katex-display {
        margin: 0;
      }
    `
};

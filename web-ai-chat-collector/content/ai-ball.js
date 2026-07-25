// content/ai-ball.js - AI 问答悬浮球 + 面板 UI

class AIBall {
  constructor() {
    this.ball = null;
    this.panel = null;
    this.isDragging = false;
    this.isPanelOpen = false;
    this.dragOffset = { x: 0, y: 0 };
    this.dragStartPos = { x: 0, y: 0 };
    this.hasMoved = false;
    this.currentTab = 'organize'; // organize | quiz | chat
    this.isGenerating = false;
    this._streamingContent = ''; // 流式累积内容（正式回答）
    this._streamingReasoning = ''; // 流式累积思考过程（reasoning_content）
    this._streamRequestId = null; // 当前流式请求 ID
    this._lastReasoning = ''; // 上一次完成后的思考内容（用于历史保存）
    this._thinkingToggleInited = false; // 思考开关是否已根据设置初始化

    // 等 DOM 就绪后再创建所有元素
    const init = () => {
      this.createBall();
      this.createPanel();
    };
    if (document.body) {
      init();
    } else {
      document.addEventListener('DOMContentLoaded', init);
    }
  }

  // Ball 样式（隔离在 shadow DOM 内，:host 控制定位与层级）
  _ballCSS() {
    return `
      :host {
        position: fixed;
        z-index: 2147483645;
        right: 24px;
        bottom: 80px;
        cursor: grab;
      }
      #ai-qa-ball {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: linear-gradient(135deg, #7c3aed, #a855f7);
        box-shadow: 0 2px 12px rgba(124, 58, 237, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        transition: box-shadow 0.2s, transform 0.2s;
      }
      #ai-qa-ball:hover {
        box-shadow: 0 4px 20px rgba(124, 58, 237, 0.6);
        transform: scale(1.08);
      }
      #ai-qa-ball:active {
        cursor: grabbing;
      }
      #ai-qa-ball svg {
        width: 22px;
        height: 22px;
        fill: #fff;
        pointer-events: none;
      }
      #ai-qa-ball .loading-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #fff;
        animation: ai-ball-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ai-ball-pulse {
        0%, 100% { opacity: 0.4; transform: scale(0.8); }
        50% { opacity: 1; transform: scale(1.2); }
      }
    `;
  }

  // Panel 样式（隔离在 shadow DOM 内，:host 控制定位与显隐）
  _panelCSS() {
    return `
      :host {
        position: fixed;
        z-index: 2147483644;
        display: none;
      }
      :host(.open) {
        display: block;
      }
      #ai-qa-panel {
        width: 400px;
        max-height: 560px;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #1a1a1a;
      }

      /* 面板头部 */
      #ai-qa-panel .qa-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: linear-gradient(135deg, #7c3aed, #a855f7);
        color: #fff;
        cursor: grab;
      }
      #ai-qa-panel .qa-header h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
      }
      #ai-qa-panel .qa-header .close-btn {
        background: none;
        border: none;
        color: #fff;
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        opacity: 0.8;
      }
      #ai-qa-panel .qa-header .close-btn:hover {
        opacity: 1;
      }
      #ai-qa-panel .qa-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #ai-qa-panel .qa-header .history-btn {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 4px 6px;
        opacity: 0.8;
        border-radius: 4px;
        display: flex;
        align-items: center;
        transition: opacity 0.15s, background 0.15s;
      }
      #ai-qa-panel .qa-header .history-btn:hover {
        opacity: 1;
        background: rgba(255,255,255,0.15);
      }
      #ai-qa-panel .qa-header .history-back-btn {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 4px;
        opacity: 0.9;
        transition: background 0.15s, opacity 0.15s;
      }
      #ai-qa-panel .qa-header .history-back-btn:hover {
        opacity: 1;
        background: rgba(255,255,255,0.15);
      }

      /* 主内容区 */
      #ai-qa-panel .qa-main {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      /* Tab 切换 */
      #ai-qa-panel .qa-tabs {
        display: flex;
        border-bottom: 1px solid #e5e7eb;
        background: #fafafa;
      }
      #ai-qa-panel .qa-tabs button {
        flex: 1;
        padding: 8px;
        border: none;
        background: none;
        font-size: 12px;
        cursor: pointer;
        color: #6b7280;
        border-bottom: 2px solid transparent;
        transition: all 0.15s;
      }
      #ai-qa-panel .qa-tabs button:hover {
        color: #7c3aed;
        background: #f5f3ff;
      }
      #ai-qa-panel .qa-tabs button.active {
        color: #7c3aed;
        border-bottom-color: #7c3aed;
        font-weight: 600;
      }

      /* 输入区域 */
      #ai-qa-panel .qa-input-area {
        padding: 12px;
        border-bottom: 1px solid #f0f0f0;
      }
      #ai-qa-panel .qa-input-area textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 12px;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        font-size: 13px;
        outline: none;
        color: #1a1a1a;
        background: #fff;
        resize: vertical;
        min-height: 60px;
        max-height: 120px;
        font-family: inherit;
      }
      #ai-qa-panel .qa-input-area textarea:focus {
        border-color: #7c3aed;
        box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.15);
      }
      #ai-qa-panel .qa-input-area textarea::placeholder {
        color: #9ca3af;
      }
      #ai-qa-panel .qa-input-area .qa-actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
        justify-content: flex-end;
      }
      #ai-qa-panel .qa-input-area .qa-actions button {
        padding: 6px 16px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.15s;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-send {
        background: #7c3aed;
        color: #fff;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-send:hover {
        background: #6d28d9;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-send:disabled {
        background: #c4b5fd;
        cursor: not-allowed;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-export {
        background: #f3f4f6;
        color: #374151;
        border: 1px solid #e0e0e0;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-export:hover {
        background: #e5e7eb;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-quiz-start {
        background: #7c3aed;
        color: #fff;
        border: 1px solid #6d28d9;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-quiz-start:hover {
        background: #6d28d9;
      }
      /* 深度思考 toggle（左侧） */
      #ai-qa-panel .qa-input-area .qa-actions .btn-thinking-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: #f3f4f6;
        color: #6b7280;
        border: 1px solid #e0e0e0;
        margin-right: auto;
        font-size: 12px;
        padding: 6px 10px;
        user-select: none;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-thinking-toggle:hover {
        background: #e5e7eb;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-thinking-toggle.active {
        background: #fef3c7;
        color: #92400e;
        border-color: #fcd34d;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-thinking-toggle .toggle-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #d1d5db;
        transition: background 0.15s;
      }
      #ai-qa-panel .qa-input-area .qa-actions .btn-thinking-toggle.active .toggle-dot {
        background: #f59e0b;
      }

      /* 思考过程可折叠块 */
      #ai-qa-panel .qa-thinking-block {
        margin: 0 0 10px 0;
        border: 1px solid #fde68a;
        border-radius: 6px;
        background: #fffbeb;
        overflow: hidden;
      }
      #ai-qa-panel .qa-thinking-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 12px;
        color: #92400e;
        user-select: none;
      }
      #ai-qa-panel .qa-thinking-header:hover {
        background: #fef3c7;
      }
      #ai-qa-panel .qa-thinking-header .arrow {
        transition: transform 0.15s;
        display: inline-block;
      }
      #ai-qa-panel .qa-thinking-block.collapsed .qa-thinking-header .arrow {
        transform: rotate(-90deg);
      }
      #ai-qa-panel .qa-thinking-header .label {
        font-weight: 600;
      }
      #ai-qa-panel .qa-thinking-header .status {
        color: #b45309;
        margin-left: auto;
      }
      #ai-qa-panel .qa-thinking-body {
        padding: 8px 12px;
        font-size: 12px;
        color: #78350f;
        line-height: 1.6;
        border-top: 1px solid #fde68a;
        white-space: pre-wrap;
        word-wrap: break-word;
        max-height: 300px;
        overflow-y: auto;
      }
      #ai-qa-panel .qa-thinking-block.collapsed .qa-thinking-body {
        display: none;
      }

      /* 结果区域 */
      #ai-qa-panel .qa-result {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        min-height: 0;
        line-height: 1.6;
      }
      #ai-qa-panel .qa-result .empty {
        text-align: center;
        padding: 40px 16px;
        color: #9ca3af;
        font-size: 13px;
      }
      #ai-qa-panel .qa-result .qa-msg {
        margin-bottom: 12px;
        padding: 10px 14px;
        border-radius: 8px;
      }
      #ai-qa-panel .qa-result .qa-msg.user {
        background: #f5f3ff;
        border-left: 3px solid #7c3aed;
      }
      #ai-qa-panel .qa-result .qa-msg.assistant {
        background: #f0fdf4;
        border-left: 3px solid #22c55e;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-role {
        font-weight: 600;
        font-size: 11px;
        margin-bottom: 4px;
        text-transform: uppercase;
      }
      #ai-qa-panel .qa-result .qa-msg.user .qa-msg-role {
        color: #7c3aed;
      }
      #ai-qa-panel .qa-result .qa-msg.assistant .qa-msg-role {
        color: #16a34a;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content {
        font-size: 13px;
        color: #1a1a1a;
        word-break: break-word;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content p { margin: 0 0 8px; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content p:last-child { margin-bottom: 0; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content pre {
        background: #1e293b;
        color: #e2e8f0;
        padding: 10px 12px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 6px 0;
        font-size: 11px;
        line-height: 1.5;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content code {
        background: #f1f5f9;
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 12px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content strong {
        color: #7c3aed;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content table {
        border-collapse: collapse;
        margin: 6px 0;
        font-size: 12px;
        width: 100%;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content th,
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content td {
        border: 1px solid #e2e8f0;
        padding: 4px 8px;
        text-align: left;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content th {
        background: #f8fafc;
        font-weight: 600;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content ul,
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content ol {
        padding-left: 18px;
        margin: 4px 0;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content li { margin: 2px 0; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content blockquote {
        border-left: 3px solid #d1d5db;
        padding-left: 10px;
        color: #6b7280;
        margin: 6px 0;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content a {
        color: #7c3aed;
        text-decoration: none;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content a:hover {
        text-decoration: underline;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content hr {
        border: none;
        border-top: 1px solid #e5e7eb;
        margin: 10px 0;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content img {
        max-width: 100%;
        border-radius: 6px;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h2,
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h3,
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h4 {
        margin: 10px 0 6px;
        color: #1a1a1a;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h2 { font-size: 15px; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h3 { font-size: 14px; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content h4 { font-size: 13px; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .math-block {
        text-align: center;
        margin: 8px 0;
        overflow-x: auto;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .math-inline {
        display: inline;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .think-block,
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .search-block {
        margin: 6px 0;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-header {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        padding: 3px 0;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-header:hover { opacity: 0.8; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-header .arrow {
        transition: transform 0.2s;
        font-size: 10px;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-header.collapsed .arrow {
        transform: rotate(-90deg);
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-body {
        overflow: hidden;
        transition: max-height 0.3s ease;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .collapsible-body.collapsed {
        max-height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        background: none !important;
        overflow: hidden;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .think-block .collapsible-header { color: #6b7280; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .think-block .collapsible-body {
        color: #6b7280;
        font-style: italic;
        border-left: 2px solid #d1d5db;
        padding-left: 8px;
      }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .search-block .collapsible-header { color: #0369a1; }
      #ai-qa-panel .qa-result .qa-msg .qa-msg-content .search-block .collapsible-body {
        color: #0369a1;
        background: #f0f9ff;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
      }

      /* 底部状态栏 */
      #ai-qa-panel .qa-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        background: #fafafa;
        border-top: 1px solid #f0f0f0;
        font-size: 11px;
        color: #9ca3af;
      }
      #ai-qa-panel .qa-footer a {
        color: #7c3aed;
        text-decoration: none;
      }
      #ai-qa-panel .qa-footer a:hover {
        text-decoration: underline;
      }

      /* 生成中动画 */
      .typing-indicator {
        display: inline-flex;
        gap: 4px;
        padding: 4px 0;
      }
      .typing-indicator span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #7c3aed;
        animation: typing-bounce 1.4s ease-in-out infinite;
      }
      .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
      .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes typing-bounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-6px); }
      }

      /* 开始做题按钮 */
      #ai-qa-panel .quiz-start-btn {
        display: block;
        margin: 12px auto 0;
        padding: 8px 24px;
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        background: linear-gradient(135deg, #7c3aed, #a855f7);
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: opacity 0.15s, transform 0.15s;
      }
      #ai-qa-panel .quiz-start-btn:hover {
        opacity: 0.9;
        transform: translateY(-1px);
      }
      #ai-qa-panel .quiz-start-btn-sm {
        margin-left: auto;
        padding: 4px 12px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: linear-gradient(135deg, #7c3aed, #a855f7);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
        transition: opacity 0.15s;
      }
      #ai-qa-panel .quiz-start-btn-sm:hover {
        opacity: 0.85;
      }

      /* 做题模式 */
      #ai-qa-panel .quiz-mode {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }
      #ai-qa-panel .quiz-mode-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #f5f3ff;
        border-bottom: 1px solid #e9d5ff;
        flex-shrink: 0;
      }
      #ai-qa-panel .quiz-progress {
        font-size: 12px;
        font-weight: 600;
        color: #7c3aed;
      }
      #ai-qa-panel .quiz-exit-btn {
        background: none;
        border: 1px solid #d1d5db;
        border-radius: 4px;
        padding: 3px 10px;
        font-size: 11px;
        color: #6b7280;
        cursor: pointer;
        transition: background 0.15s;
      }
      #ai-qa-panel .quiz-exit-btn:hover {
        background: #f3f4f6;
      }
      #ai-qa-panel .quiz-card {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
      }
      #ai-qa-panel .quiz-q-type {
        display: inline-block;
        font-size: 11px;
        font-weight: 600;
        color: #7c3aed;
        background: #f5f3ff;
        padding: 2px 8px;
        border-radius: 4px;
        margin-bottom: 8px;
      }
      #ai-qa-panel .quiz-q-text {
        font-size: 14px;
        line-height: 1.6;
        color: #1a1a1a;
        margin-bottom: 14px;
      }
      #ai-qa-panel .quiz-q-text p { margin: 0 0 6px; }
      #ai-qa-panel .quiz-options {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #ai-qa-panel .quiz-options-tf {
        flex-direction: row;
        gap: 12px;
      }
      #ai-qa-panel .quiz-options-tf .quiz-option-tf {
        flex: 1;
        justify-content: center;
        text-align: center;
      }
      #ai-qa-panel .quiz-option {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border: 2px solid #e5e7eb;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        color: #374151;
        transition: border-color 0.15s, background 0.15s;
        user-select: none;
      }
      #ai-qa-panel .quiz-option:hover {
        border-color: #c4b5fd;
      }
      #ai-qa-panel .quiz-option.selected {
        border-color: #7c3aed;
        background: #f5f3ff;
      }
      #ai-qa-panel .quiz-option.correct {
        border-color: #10b981;
        background: #ecfdf5;
        color: #065f46;
      }
      #ai-qa-panel .quiz-option.wrong {
        border-color: #ef4444;
        background: #fef2f2;
        color: #991b1b;
      }
      #ai-qa-panel .quiz-option-key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #f3f4f6;
        font-size: 12px;
        font-weight: 600;
        color: #6b7280;
        flex-shrink: 0;
      }
      #ai-qa-panel .quiz-option.selected .quiz-option-key {
        background: #7c3aed;
        color: #fff;
      }
      #ai-qa-panel .quiz-option.correct .quiz-option-key {
        background: #10b981;
        color: #fff;
      }
      #ai-qa-panel .quiz-option.wrong .quiz-option-key {
        background: #ef4444;
        color: #fff;
      }
      #ai-qa-panel .quiz-input {
        width: 100%;
        padding: 10px 12px !important;
        font-size: 13px !important;
        border: 2px solid #e5e7eb !important;
        border-radius: 8px !important;
        outline: none;
        box-sizing: border-box;
        font-family: inherit;
        background: #fff !important;
        color: #1f2937 !important;
        transition: border-color 0.15s;
      }
      #ai-qa-panel .quiz-input:focus {
        border-color: #7c3aed !important;
      }
      #ai-qa-panel .quiz-input.correct {
        border-color: #10b981 !important;
        background: #ecfdf5 !important;
      }
      #ai-qa-panel .quiz-input.wrong {
        border-color: #ef4444 !important;
        background: #fef2f2 !important;
      }
      #ai-qa-panel .quiz-feedback {
        margin-top: 14px;
        padding: 12px;
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.6;
      }
      #ai-qa-panel .quiz-feedback.feedback-correct {
        background: #ecfdf5;
        border: 1px solid #a7f3d0;
      }
      #ai-qa-panel .quiz-feedback.feedback-wrong {
        background: #fef2f2;
        border: 1px solid #fca5a5;
      }
      #ai-qa-panel .quiz-feedback-status {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 6px;
      }
      #ai-qa-panel .quiz-feedback.feedback-correct .quiz-feedback-status {
        color: #065f46;
      }
      #ai-qa-panel .quiz-feedback.feedback-wrong .quiz-feedback-status {
        color: #991b1b;
      }
      #ai-qa-panel .quiz-feedback-answer {
        color: #374151;
        margin-bottom: 6px;
      }
      #ai-qa-panel .quiz-feedback-label {
        font-weight: 600;
        color: #6b7280;
      }
      #ai-qa-panel .quiz-feedback-explanation {
        color: #4b5563;
      }
      #ai-qa-panel .quiz-feedback-explanation p { margin: 0 0 4px; }
      #ai-qa-panel .quiz-nav {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid #f0f0f0;
        background: #fafafa;
        flex-shrink: 0;
      }
      #ai-qa-panel .quiz-nav-btn {
        flex: 1;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 500;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      #ai-qa-panel .quiz-nav-btn:hover {
        opacity: 0.85;
      }
      #ai-qa-panel .quiz-prev-btn {
        background: #f3f4f6;
        color: #374151;
      }
      #ai-qa-panel .quiz-submit-btn {
        background: #7c3aed;
        color: #fff;
      }
      #ai-qa-panel .quiz-next-btn {
        background: #7c3aed;
        color: #fff;
      }
      #ai-qa-panel .quiz-finish-btn {
        background: linear-gradient(135deg, #7c3aed, #a855f7);
        color: #fff;
      }
      #ai-qa-panel .quiz-redo-btn {
        background: #f3f4f6;
        color: #374151;
      }
      #ai-qa-panel .quiz-exit-summary-btn {
        background: #7c3aed;
        color: #fff;
      }
      #ai-qa-panel .quiz-summary {
        text-align: center;
        padding: 30px 16px;
      }
      #ai-qa-panel .quiz-summary-score {
        font-size: 32px;
        font-weight: 700;
        color: #7c3aed;
        margin-bottom: 8px;
      }
      #ai-qa-panel .quiz-summary-rate {
        font-size: 14px;
        font-weight: 600;
        color: #6b7280;
        margin-bottom: 12px;
      }
      #ai-qa-panel .quiz-summary-detail {
        font-size: 12px;
        color: #9ca3af;
      }

      /* 历史对话面板 */
      #ai-qa-panel .qa-history {
        display: none;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }
      #ai-qa-panel .qa-history-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
        font-size: 13px;
        font-weight: 600;
        color: #374151;
        flex-wrap: wrap;
      }
      #ai-qa-panel .qa-history-header .qa-history-title-label {
        white-space: nowrap;
      }
      #ai-qa-panel .qa-history-header .qa-history-search {
        flex: 1;
        min-width: 80px;
        padding: 4px 8px;
        font-size: 12px;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        background: #fff;
        outline: none;
        font-weight: 400;
        transition: border-color 0.15s;
      }
      #ai-qa-panel .qa-history-header .qa-history-search:focus {
        border-color: #7c3aed;
      }
      #ai-qa-panel .qa-history-header .qa-history-filter {
        padding: 4px 6px;
        font-size: 12px;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        background: #fff;
        color: #374151;
        cursor: pointer;
        outline: none;
        font-weight: 400;
        transition: border-color 0.15s;
      }
      #ai-qa-panel .qa-history-header .qa-history-filter:hover {
        border-color: #c4b5fd;
      }
      #ai-qa-panel .qa-history-header .qa-history-clear-btn {
        padding: 4px 8px;
        font-size: 12px;
        border: 1px solid #fca5a5;
        border-radius: 4px;
        background: #fff;
        color: #dc2626;
        cursor: pointer;
        white-space: nowrap;
        font-weight: 500;
        transition: background 0.15s;
      }
      #ai-qa-panel .qa-history-header .qa-history-clear-btn:hover {
        background: #fef2f2;
      }
      #ai-qa-panel .qa-history-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      }
      #ai-qa-panel .qa-history-list .empty {
        text-align: center;
        padding: 40px 16px;
        color: #9ca3af;
        font-size: 13px;
      }
      #ai-qa-panel .qa-history-item {
        background: #fff;
        border: 1px solid #eee;
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 6px;
        transition: border-color 0.15s;
      }
      #ai-qa-panel .qa-history-item:hover {
        border-color: #c4b5fd;
      }
      #ai-qa-panel .qa-history-item-top {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
      }
      #ai-qa-panel .qa-history-tag {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: #f5f3ff;
        color: #7c3aed;
        white-space: nowrap;
        font-weight: 600;
      }
      #ai-qa-panel .qa-history-title {
        font-size: 13px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        color: #1a1a1a;
      }
      #ai-qa-panel .qa-history-item-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      #ai-qa-panel .qa-history-date {
        font-size: 11px;
        color: #9ca3af;
      }
      #ai-qa-panel .qa-history-item-btns {
        display: flex;
        gap: 4px;
      }
      #ai-qa-panel .qa-history-item-btns button {
        padding: 3px 8px;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        background: #fff;
        color: #374151;
        transition: background 0.15s;
      }
      #ai-qa-panel .qa-history-item-btns button:hover {
        background: #f3f4f6;
      }
      #ai-qa-panel .qa-history-item-btns .qa-history-del-btn {
        color: #dc2626;
        border-color: #fca5a5;
      }
      #ai-qa-panel .qa-history-item-btns .qa-history-del-btn:hover {
        background: #fef2f2;
      }
      #ai-qa-panel .qa-history-detail {
        display: none;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }
      #ai-qa-panel .qa-history-detail-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
      }
      #ai-qa-panel .qa-history-detail-header .history-back-btn {
        background: none;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        color: #7c3aed;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background 0.15s;
      }
      #ai-qa-panel .qa-history-detail-header .history-back-btn:hover {
        background: #f5f3ff;
      }
      #ai-qa-panel .qa-history-detail-title {
        font-size: 13px;
        font-weight: 600;
        color: #1a1a1a;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      #ai-qa-panel .qa-history-detail-body {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }
      #ai-qa-panel .qa-history-msg {
        margin-bottom: 12px;
        padding: 10px 12px;
        border-radius: 8px;
      }
      #ai-qa-panel .qa-history-msg.user {
        background: #f5f3ff;
        border-left: 3px solid #7c3aed;
      }
      #ai-qa-panel .qa-history-msg.assistant {
        background: #f0fdf4;
        border-left: 3px solid #22c55e;
      }
      #ai-qa-panel .qa-history-msg-role {
        font-weight: 600;
        font-size: 11px;
        margin-bottom: 4px;
        text-transform: uppercase;
      }
      #ai-qa-panel .qa-history-msg.user .qa-history-msg-role {
        color: #7c3aed;
      }
      #ai-qa-panel .qa-history-msg.assistant .qa-history-msg-role {
        color: #16a34a;
      }
      #ai-qa-panel .qa-history-msg-content {
        font-size: 13px;
        color: #1a1a1a;
        line-height: 1.6;
        word-break: break-word;
      }
      #ai-qa-panel .qa-history-msg-content p { margin: 0 0 6px; }
      #ai-qa-panel .qa-history-msg-content p:last-child { margin-bottom: 0; }
      #ai-qa-panel .qa-history-msg-content pre {
        background: #1e293b;
        color: #e2e8f0;
        padding: 10px 12px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 6px 0;
        font-size: 11px;
      }
      #ai-qa-panel .qa-history-msg-content code {
        background: #f1f5f9;
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 12px;
      }
      #ai-qa-panel .qa-history-msg-content pre code {
        background: none;
        padding: 0;
        color: inherit;
      }
      #ai-qa-panel .qa-history-msg-content strong {
        color: #7c3aed;
      }
    `;
  }

  createBall() {
    // 宿主元素：接收鼠标事件、承载定位样式（:host）
    this.ball = document.createElement('div');
    this.ball.id = 'ai-qa-ball-host';
    const shadow = this.ball.attachShadow({ mode: 'open' });

    // 样式隔离在 shadow DOM 内
    const style = document.createElement('style');
    style.textContent = this._ballCSS();
    shadow.appendChild(style);

    // 实际可见的球体元素
    this.ballInner = document.createElement('div');
    this.ballInner.id = 'ai-qa-ball';
    this.ballInner.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 2.99.97 4.29L1 23l6.71-1.97C9.01 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2c0-3 3-2.5 3-4.5 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 2.5-3 2.5-3 4.5z"/>
      </svg>
    `;
    shadow.appendChild(this.ballInner);

    document.body.appendChild(this.ball);

    this.ball.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
  }

  createPanel() {
    // 宿主元素：承载定位与显隐样式（:host / :host(.open)）
    this.panel = document.createElement('div');
    this.panel.id = 'ai-qa-panel-host';
    this.panelShadow = this.panel.attachShadow({ mode: 'open' });

    // KaTeX CSS 需注入 shadow DOM——外部 head 的样式无法穿透 shadow 边界
    const katexLink = document.createElement('link');
    katexLink.rel = 'stylesheet';
    katexLink.href = chrome.runtime.getURL('lib/katex.min.css');
    this.panelShadow.appendChild(katexLink);

    // 面板样式隔离在 shadow DOM 内
    const style = document.createElement('style');
    style.textContent = this._panelCSS();
    this.panelShadow.appendChild(style);

    // 实际面板内容
    this.panelInner = document.createElement('div');
    this.panelInner.id = 'ai-qa-panel';
    this.panelInner.innerHTML = `
      <div class="qa-header">
        <h2>AI 问答助手</h2>
        <div class="qa-header-actions">
          <button class="history-back-btn" id="ai-qa-history-back" title="返回主面板" style="display:none">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" fill="#fff"/></svg>
            返回
          </button>
          <button class="history-btn" id="ai-qa-reset-btn" title="重置对话" style="display:none">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
              <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" fill="#fff"/>
            </svg>
          </button>
          <button class="history-btn" id="ai-qa-history-btn" title="查看历史对话">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
              <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" fill="#fff"/>
            </svg>
          </button>
          <button class="history-btn" id="ai-qa-settings-btn" title="打开设置">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.04.64.09.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.21.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="#fff"/>
            </svg>
          </button>
          <button class="close-btn">&times;</button>
        </div>
      </div>
      <div class="qa-main" id="ai-qa-main">
        <div class="qa-tabs">
          <button data-tab="organize" class="active">整理信息</button>
          <button data-tab="quiz">生成测验</button>
          <button data-tab="chat">自由问答</button>
        </div>
        <div class="qa-input-area">
          <textarea id="ai-qa-input" placeholder="输入你的问题或主题..." rows="3"></textarea>
          <div class="qa-actions">
            <button class="btn-thinking-toggle" id="ai-qa-thinking-toggle" title="启用深度思考（先思考再回答，质量更高、耗时更长）" aria-pressed="false">
              <span class="toggle-dot"></span>
              <span>深度思考</span>
            </button>
            <button class="btn-export" id="ai-qa-export" style="display:none">导出结果</button>
            <button class="btn-quiz-start" id="ai-qa-quiz-start" style="display:none">开始做题</button>
            <button class="btn-send" id="ai-qa-send">发送</button>
          </div>
        </div>
        <div class="qa-result" id="ai-qa-result">
          <div class="empty">输入问题后点击发送<br><small style="color:#ccc">AI 将基于你的对话记录回答</small></div>
        </div>
      </div>
      <div class="qa-history" id="ai-qa-history" style="display:none">
        <div class="qa-history-header">
          <span class="qa-history-title-label">历史对话</span>
          <input type="text" class="qa-history-search" id="ai-qa-history-search" placeholder="搜索..." />
          <select class="qa-history-filter" id="ai-qa-history-filter">
            <option value="all">全部</option>
            <option value="organize">整理</option>
            <option value="quiz">测验</option>
            <option value="chat">问答</option>
          </select>
          <button class="qa-history-clear-btn" id="ai-qa-history-clear" title="清空全部历史对话">全部删除</button>
        </div>
        <div class="qa-history-list" id="ai-qa-history-list">
          <div class="empty">暂无历史对话</div>
        </div>
        <div class="qa-history-detail" id="ai-qa-history-detail" style="display:none">
          <div class="qa-history-detail-header" id="ai-qa-history-detail-header"></div>
          <div class="qa-history-detail-body" id="ai-qa-history-detail-body"></div>
        </div>
      </div>
      <div class="qa-footer">
        <span id="ai-qa-status">就绪</span>
        <a href="#" id="ai-qa-settings-link">设置</a>
      </div>
    `;
    this.panelShadow.appendChild(this.panelInner);

    document.body.appendChild(this.panel);

    // 事件委托：点击 .collapsible-header 切换折叠（思考过程 / 搜索来源）
    // 不能用内联 onclick：宿主页 CSP 收紧后会失效；且内容频繁重建时委托更稳
    // 绑定到 panelInner 而非 host——host 上的事件 e.target 会被重定向，closest 失效
    this.panelInner.addEventListener('click', (e) => {
      const header = e.target.closest('.collapsible-header');
      if (!header) return;
      header.classList.toggle('collapsed');
      const bodyEl = header.nextElementSibling;
      if (bodyEl && bodyEl.classList.contains('collapsible-body')) {
        bodyEl.classList.toggle('collapsed');
      }
    });

    // 面板拖拽（通过 header 拖动）
    makeDraggable(this.panel, this.panelShadow.querySelector('.qa-header'));

    // 关闭按钮
    this.panelShadow.querySelector('.close-btn').addEventListener('click', () => this.togglePanel(false));

    // 历史对话按钮
    this.panelShadow.querySelector('#ai-qa-history-btn').addEventListener('click', () => this.showHistory());

    // 重置对话按钮
    this.panelShadow.querySelector('#ai-qa-reset-btn').addEventListener('click', () => this._resetConversation());

    // 历史对话返回按钮
    this.panelShadow.querySelector('#ai-qa-history-back').addEventListener('click', () => this.hideHistory());

    // 设置按钮：在新标签页打开扩展设置
    this.panelShadow.querySelector('#ai-qa-settings-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    });

    // 历史对话搜索框（带防抖）
    let searchTimer = null;
    this.panelShadow.querySelector('#ai-qa-history-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this._loadHistoryList(), 250);
    });

    // 历史对话类别筛选
    this.panelShadow.querySelector('#ai-qa-history-filter').addEventListener('change', () => {
      this._loadHistoryList();
    });

    // 历史对话全部删除
    this.panelShadow.querySelector('#ai-qa-history-clear').addEventListener('click', async () => {
      if (!confirm('确定清空全部历史对话？此操作不可撤销。')) return;
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CLEAR_QA_HISTORY' }, resolve);
      });
      // 清空搜索与筛选状态
      this.panelShadow.querySelector('#ai-qa-history-search').value = '';
      this.panelShadow.querySelector('#ai-qa-history-filter').value = 'all';
      this._loadHistoryList();
    });

    // Tab 切换
    this.panelShadow.querySelectorAll('.qa-tabs button').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // 发送
    this.panelShadow.querySelector('#ai-qa-send').addEventListener('click', () => this.handleSend());

    // 导出
    this.panelShadow.querySelector('#ai-qa-export').addEventListener('click', () => this.handleExport());

    // 开始做题
    this.panelShadow.querySelector('#ai-qa-quiz-start').addEventListener('click', () => this._startQuizMode());

    // 深度思考开关
    const thinkingToggle = this.panelShadow.querySelector('#ai-qa-thinking-toggle');
    thinkingToggle.addEventListener('click', () => {
      const active = thinkingToggle.classList.toggle('active');
      thinkingToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    // 初始化思考开关状态（从 LLM 设置读取 enableThinking）
    this._initThinkingToggle();

    // 设置链接
    this.panelShadow.querySelector('#ai-qa-settings-link').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    });

    // 回车发送
    this.panelShadow.querySelector('#ai-qa-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // 监听来自 background 的流式消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'AI_STREAM_CHUNK' && message.requestId === this._streamRequestId) {
        // phase: 'reasoning'（思考过程） | 'content'（正式回答） | undefined（兼容旧调用）
        if (message.phase === 'reasoning') {
          // 累积思考内容（message.fullContent 为当前思考全文）
          this._streamingReasoning = message.fullContent || '';
          // 仅更新思考块，不影响正式回答占位
          this._renderThinkingBlock(this._streamingReasoning, true);
        } else {
          // 正式回答
          this._streamingContent = message.fullContent;
          this._renderAssistantContent(this._streamingContent, this._streamingReasoning);
        }
        // 自动滚动到底部
        const resultEl = this.panelShadow.querySelector('#ai-qa-result');
        resultEl.scrollTop = resultEl.scrollHeight;
      } else if (message.type === 'AI_STREAM_DONE' && message.requestId === this._streamRequestId) {
        this._streamingContent = message.fullContent;
        this._renderAssistantContent(this._streamingContent, this._streamingReasoning);
        this._onStreamComplete();
      } else if (message.type === 'AI_STREAM_ERROR' && message.requestId === this._streamRequestId) {
        const asstMsg = this.panelShadow.querySelector('#ai-qa-assistant-msg .qa-msg-content');
        if (asstMsg) {
          asstMsg.innerHTML = `<span style="color:#dc2626">${message.error || '生成失败'}</span>`;
        }
        this._onStreamComplete();
      }
    });
  }

  onMouseDown(e) {
    this.isDragging = true;
    this.hasMoved = false;
    const rect = this.ball.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;
    this.dragStartPos.x = e.clientX;
    this.dragStartPos.y = e.clientY;
    this.ball.style.cursor = 'grabbing';
    e.preventDefault();
  }

  onMouseMove(e) {
    if (!this.isDragging) return;
    const dx = e.clientX - this.dragStartPos.x;
    const dy = e.clientY - this.dragStartPos.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasMoved = true;

    const x = e.clientX - this.dragOffset.x;
    const y = e.clientY - this.dragOffset.y;
    const maxX = window.innerWidth - this.ball.offsetWidth;
    const maxY = window.innerHeight - this.ball.offsetHeight;
    this.ball.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
    this.ball.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    this.ball.style.right = 'auto';
    this.ball.style.bottom = 'auto';
  }

  onMouseUp(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.ball.style.cursor = 'grab';
    if (!this.hasMoved) this.togglePanel();
  }

  togglePanel(forceState) {
    this.isPanelOpen = forceState !== undefined ? forceState : !this.isPanelOpen;
    if (this.isPanelOpen) {
      this.positionPanel();
      this.panel.classList.add('open');
    } else {
      this.panel.classList.remove('open');
    }
  }

  positionPanel() {
    const ballRect = this.ball.getBoundingClientRect();
    const panelW = 400;
    const panelH = 560;
    let left = ballRect.left - panelW + ballRect.width;
    let top = ballRect.top - panelH;
    if (left < 8) left = ballRect.right + 8;
    if (top < 8) top = ballRect.bottom + 8;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    if (top + panelH > window.innerHeight - 8) top = window.innerHeight - panelH - 8;
    this.panel.style.left = left + 'px';
    this.panel.style.top = top + 'px';
  }

  switchTab(tab) {
    this.currentTab = tab;
    this.panelShadow.querySelectorAll('.qa-tabs button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    const input = this.panelShadow.querySelector('#ai-qa-input');
    const placeholders = {
      organize: '输入你想整理的主题或问题...',
      quiz: '输入测验主题，AI 将生成相关测验题...',
      chat: '输入你的问题，AI 将基于对话记录回答...'
    };
    input.placeholder = placeholders[tab] || '';
  }

  // 重置当前对话
  _resetConversation() {
    if (this.isGenerating) return;
    // 如果在做题模式中，先退出以恢复隐藏的元素（标签栏、输入区域等）
    if (this._quizState) this._exitQuizMode();
    // 重置结果区域为初始空状态
    const resultEl = this.panelShadow.querySelector('#ai-qa-result');
    resultEl.innerHTML = `<div class="empty">输入问题后点击发送<br><small style="color:#ccc">AI 将基于你的对话记录回答</small></div>`;
    // 隐藏导出和做题按钮
    this.panelShadow.querySelector('#ai-qa-export').style.display = 'none';
    this.panelShadow.querySelector('#ai-qa-quiz-start').style.display = 'none';
    // 清空状态
    this._lastResult = null;
    this._lastQuery = null;
    this._quizData = null;
    this._streamingReasoning = '';
    this._lastReasoning = '';
    // 隐藏重置按钮
    this.panelShadow.querySelector('#ai-qa-reset-btn').style.display = 'none';
    // 重置状态栏
    const statusEl = this.panelShadow.querySelector('#ai-qa-status');
    if (statusEl) statusEl.textContent = '';
  }

  async handleSend() {
    const input = this.panelShadow.querySelector('#ai-qa-input');
    const query = input.value.trim();
    if (!query || this.isGenerating) return;

    this.isGenerating = true;
    this._streamingContent = '';
    this._streamingReasoning = '';
    this._streamRequestId = null;
    this._lastQuery = query; // 保存当前问题，用于历史记录
    input.value = ''; // 清空输入框
    const sendBtn = this.panelShadow.querySelector('#ai-qa-send');
    const exportBtn = this.panelShadow.querySelector('#ai-qa-export');
    const quizStartBtn = this.panelShadow.querySelector('#ai-qa-quiz-start');
    const resultEl = this.panelShadow.querySelector('#ai-qa-result');
    const statusEl = this.panelShadow.querySelector('#ai-qa-status');

    sendBtn.disabled = true;
    sendBtn.textContent = '生成中...';
    exportBtn.style.display = 'none';
    if (quizStartBtn) quizStartBtn.style.display = 'none';
    statusEl.textContent = '正在检索和生成...';

    // 显示用户消息 + 加载动画
    resultEl.innerHTML = `
      <div class="qa-msg user">
        <div class="qa-msg-role">你</div>
        <div class="qa-msg-content">${this._escapeHtml(query)}</div>
      </div>
      <div class="qa-msg assistant" id="ai-qa-assistant-msg">
        <div class="qa-msg-role">AI</div>
        <div class="qa-msg-content">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;

    let fullContent = '';

    try {
      const actionMap = {
        organize: 'ORGANIZE_INFO',
        quiz: 'GENERATE_QUIZ',
        chat: 'AI_ASK_QUESTION'
      };

      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: actionMap[this.currentTab],
          query,
          stream: true,
          options: {
            enableThinking: this._isThinkingEnabled()
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      });

      if (resp && resp.success) {
        // 流式模式：记录 requestId，后续通过 onMessage 接收 chunk
        this._streamRequestId = resp.requestId || null;
        if (!this._streamRequestId && resp.content) {
          // 非流式回退：直接渲染
          this._renderAssistantContent(resp.content);
          this._lastResult = resp.content;
          exportBtn.style.display = 'inline-block';
          statusEl.textContent = '生成完成';
          this.isGenerating = false;
          sendBtn.disabled = false;
          sendBtn.textContent = '发送';
        }
        // 流式模式下，chunk 和完成由 onMessage 监听器处理
      } else {
        const asstMsg = resultEl.querySelector('#ai-qa-assistant-msg .qa-msg-content');
        asstMsg.innerHTML = `<span style="color:#dc2626">${resp?.error || '生成失败，请检查设置'}</span>`;
        statusEl.textContent = '生成失败';
        this.isGenerating = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
      }
    } catch (e) {
      const asstMsg = resultEl.querySelector('#ai-qa-assistant-msg .qa-msg-content');
      asstMsg.innerHTML = `<span style="color:#dc2626">错误: ${e.message}</span>`;
      statusEl.textContent = '出错';
      this.isGenerating = false;
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
    }
  }

  _onStreamComplete() {
    const exportBtn = this.panelShadow.querySelector('#ai-qa-export');
    const quizStartBtn = this.panelShadow.querySelector('#ai-qa-quiz-start');
    const resetBtn = this.panelShadow.querySelector('#ai-qa-reset-btn');
    const statusEl = this.panelShadow.querySelector('#ai-qa-status');
    const sendBtn = this.panelShadow.querySelector('#ai-qa-send');

    this._lastResult = this._streamingContent;
    this._lastReasoning = this._streamingReasoning;
    exportBtn.style.display = 'inline-block';
    if (resetBtn) resetBtn.style.display = 'flex';
    statusEl.textContent = '生成完成';
    this.isGenerating = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';

    // 测验模式：解析结构化数据并显示"开始做题"按钮
    if (this.currentTab === 'quiz') {
      const quizData = this._parseQuizData(this._lastResult);
      if (quizData && quizData.questions && quizData.questions.length > 0) {
        this._quizData = quizData;
        // 重新渲染（去除 QUIZ_DATA 注释块，保留思考块）
        this._renderAssistantContent(this._lastResult, this._lastReasoning);
        if (quizStartBtn) quizStartBtn.style.display = 'inline-block';
      } else {
        if (quizStartBtn) quizStartBtn.style.display = 'none';
      }
    } else {
      if (quizStartBtn) quizStartBtn.style.display = 'none';
    }

    // 自动保存到 IndexedDB
    this._saveToHistory();
  }

  // 保存当前 Q&A 到 IndexedDB（qaHistory 表）
  async _saveToHistory() {
    const query = this._lastQuery;
    if (!query || !this._lastResult) return;

    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'SAVE_QA_HISTORY',
          data: {
            tab: this.currentTab,
            query,
            answer: this._lastResult,
            reasoning: this._lastReasoning || ''
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[AIBall] 保存历史失败:', chrome.runtime.lastError.message);
          }
          resolve(response);
        });
      });
    } catch (e) {
      console.warn('[AIBall] 保存历史失败:', e);
    }
  }

  // 显示历史对话面板
  async showHistory() {
    const mainEl = this.panelShadow.querySelector('#ai-qa-main');
    const historyEl = this.panelShadow.querySelector('#ai-qa-history');
    const footerEl = this.panelShadow.querySelector('.qa-footer');
    const backBtn = this.panelShadow.querySelector('#ai-qa-history-back');
    const historyHeaderEl = this.panelShadow.querySelector('.qa-history-header');

    mainEl.style.display = 'none';
    footerEl.style.display = 'none';
    historyEl.style.display = 'flex';
    historyEl.style.flexDirection = 'column';
    historyEl.style.flex = '1';
    historyEl.style.overflow = 'hidden';

    // 确保标题行可见（从详情视图直接返回主面板后再进入时恢复）
    if (historyHeaderEl) historyHeaderEl.style.display = 'flex';

    // 显示头部返回按钮
    if (backBtn) backBtn.style.display = 'flex';

    // 重置到列表视图
    this.panelShadow.querySelector('#ai-qa-history-list').style.display = 'block';
    this.panelShadow.querySelector('#ai-qa-history-detail').style.display = 'none';

    await this._loadHistoryList();
  }

  // 隐藏历史对话面板
  hideHistory() {
    const mainEl = this.panelShadow.querySelector('#ai-qa-main');
    const historyEl = this.panelShadow.querySelector('#ai-qa-history');
    const footerEl = this.panelShadow.querySelector('.qa-footer');
    const backBtn = this.panelShadow.querySelector('#ai-qa-history-back');

    mainEl.style.display = '';
    footerEl.style.display = '';
    historyEl.style.display = 'none';

    // 隐藏头部返回按钮
    if (backBtn) backBtn.style.display = 'none';
  }

  // 加载历史对话列表
  async _loadHistoryList() {
    const listEl = this.panelShadow.querySelector('#ai-qa-history-list');

    // 读取当前搜索关键字与筛选类别
    const searchInput = this.panelShadow.querySelector('#ai-qa-history-search');
    const filterSelect = this.panelShadow.querySelector('#ai-qa-history-filter');
    const keyword = (searchInput?.value || '').trim().toLowerCase();
    const tabFilter = filterSelect?.value || 'all';

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'GET_QA_HISTORY',
          filters: {}
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        });
      });

      let list = response || [];

      // 按类别筛选
      if (tabFilter && tabFilter !== 'all') {
        list = list.filter(r => r.tab === tabFilter);
      }

      // 按关键字搜索（匹配 query 与 answer）
      if (keyword) {
        list = list.filter(r => {
          const q = (r.query || '').toLowerCase();
          const a = (r.answer || '').toLowerCase();
          return q.includes(keyword) || a.includes(keyword);
        });
      }

      if (list.length === 0) {
        const hasRecords = (response || []).length > 0;
        listEl.innerHTML = hasRecords
          ? '<div class="empty">没有匹配的历史对话</div>'
          : '<div class="empty">暂无历史对话<br><small style="color:#ccc">问答结果将自动保存</small></div>';
        return;
      }

      const tabLabels = { organize: '整理', quiz: '测验', chat: '问答' };

      listEl.innerHTML = '';
      for (const record of list) {
        const item = document.createElement('div');
        item.className = 'qa-history-item';

        const tag = tabLabels[record.tab] || '问答';
        const displayTitle = record.query.substring(0, 60);

        const date = new Date(record.createdAt).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        item.innerHTML = `
          <div class="qa-history-item-top">
            <span class="qa-history-tag">${tag}</span>
            <span class="qa-history-title">${this._escapeHtml(displayTitle)}</span>
          </div>
          <div class="qa-history-item-bottom">
            <span class="qa-history-date">${date}</span>
            <div class="qa-history-item-btns">
              <button class="qa-history-view-btn" data-id="${record.id}">查看</button>
              <button class="qa-history-del-btn" data-id="${record.id}">删除</button>
            </div>
          </div>
        `;

        item.querySelector('.qa-history-view-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          this._showHistoryDetail(record);
        });

        item.querySelector('.qa-history-del-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('确定删除这条历史记录？')) {
            await new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: 'DELETE_QA_HISTORY', id: record.id }, resolve);
            });
            this._loadHistoryList();
          }
        });

        listEl.appendChild(item);
      }
    } catch (e) {
      listEl.innerHTML = '<div class="empty" style="color:#dc2626">加载失败</div>';
    }
  }

  // 显示历史对话详情
  _showHistoryDetail(record) {
    const listEl = this.panelShadow.querySelector('#ai-qa-history-list');
    const detailEl = this.panelShadow.querySelector('#ai-qa-history-detail');
    const headerEl = this.panelShadow.querySelector('#ai-qa-history-detail-header');
    const bodyEl = this.panelShadow.querySelector('#ai-qa-history-detail-body');
    const historyHeaderEl = this.panelShadow.querySelector('.qa-history-header');

    listEl.style.display = 'none';
    // 隐藏"历史对话"标题行（搜索/筛选/全部删除工具栏）
    if (historyHeaderEl) historyHeaderEl.style.display = 'none';
    detailEl.style.display = 'flex';
    detailEl.style.flexDirection = 'column';
    detailEl.style.flex = '1';
    detailEl.style.overflow = 'hidden';

    const tabLabels = { organize: '整理信息', quiz: '生成测验', chat: '自由问答' };
    const tabLabel = tabLabels[record.tab] || '问答';

    // 测验记录：尝试解析 QUIZ_DATA，成功则显示"开始做题"按钮
    let quizBtnHTML = '';
    if (record.tab === 'quiz') {
      const quizData = this._parseQuizData(record.answer || '');
      if (quizData && quizData.questions && quizData.questions.length > 0) {
        this._quizData = quizData;
        quizBtnHTML = `<button class="quiz-start-btn-sm" id="ai-qa-detail-quiz-start">开始做题</button>`;
      }
    }

    headerEl.innerHTML = `
      <button class="history-back-btn" id="ai-qa-detail-back">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" fill="#7c3aed"/></svg>
        返回列表
      </button>
      <span class="qa-history-detail-title">[${tabLabel}] ${this._escapeHtml(record.query.substring(0, 40))}</span>
      ${quizBtnHTML}
    `;

    headerEl.querySelector('#ai-qa-detail-back').addEventListener('click', () => {
      detailEl.style.display = 'none';
      listEl.style.display = 'block';
      // 恢复显示"历史对话"标题行
      if (historyHeaderEl) historyHeaderEl.style.display = 'flex';
    });

    // 做题按钮：在详情 body 中启动做题模式
    const quizStartBtn = headerEl.querySelector('#ai-qa-detail-quiz-start');
    if (quizStartBtn) {
      quizStartBtn.addEventListener('click', () => {
        this._startQuizMode(bodyEl);
      });
    }

    bodyEl.innerHTML = '';

    // 用户提问
    const userBlock = document.createElement('div');
    userBlock.className = 'qa-history-msg user';
    userBlock.innerHTML = `
      <div class="qa-history-msg-role">你</div>
      <div class="qa-history-msg-content">${this._escapeHtml(record.query)}</div>
    `;
    bodyEl.appendChild(userBlock);

    // AI 回答
    const asstBlock = document.createElement('div');
    asstBlock.className = 'qa-history-msg assistant';
    const reasoningText = (record.reasoning || '').trim();
    const reasoningHTML = reasoningText
      ? `<div class="qa-thinking-block collapsed">
           <div class="qa-thinking-header">
             <span class="arrow">▼</span>
             <span class="label">思考过程</span>
             <span class="status">已完成</span>
           </div>
           <div class="qa-thinking-body">${this._escapeHtml(reasoningText)}</div>
         </div>`
      : '';
    asstBlock.innerHTML = `
      <div class="qa-history-msg-role">AI</div>
      <div class="qa-history-msg-content">${reasoningHTML}${this._renderResultHTML(record.answer || '')}</div>
    `;
    bodyEl.appendChild(asstBlock);
    // 绑定思考块折叠
    const thinkingBlock = asstBlock.querySelector('.qa-thinking-block');
    const thinkingHeader = asstBlock.querySelector('.qa-thinking-header');
    if (thinkingBlock && thinkingHeader) {
      thinkingHeader.addEventListener('click', () => thinkingBlock.classList.toggle('collapsed'));
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 用 marked + katex 渲染 Markdown 内容
  _renderMarkdown(content) {
    if (!content) return '';

    // 先提取特殊块，用占位符替换
    const blocks = [];
    let processed = content;

    // 移除测验数据块（包括流式过程中未闭合的部分）
    processed = processed.replace(/<!--\s*QUIZ_DATA[\s\S]*?-->/g, '');
    processed = processed.replace(/<!--\s*QUIZ_DATA[\s\S]*$/g, '');

    // 提取 <think>...</think>
    processed = processed.replace(/<think>\n?([\s\S]*?)\n?<\/think>/g, (_, text) => {
      const idx = blocks.length;
      blocks.push({ type: 'think', content: text.trim() });
      return `\n%%BLOCK_${idx}%%\n`;
    });

    // 提取 <search_result>...</search_result>
    processed = processed.replace(/<search_result>\n?([\s\S]*?)\n?<\/search_result>/g, (_, text) => {
      const idx = blocks.length;
      blocks.push({ type: 'search', content: text.trim() });
      return `\n%%BLOCK_${idx}%%\n`;
    });

    // 提取行间公式 $$...$$
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      const idx = blocks.length;
      blocks.push({ type: 'math_display', content: math.trim() });
      return `\n%%BLOCK_${idx}%%\n`;
    });

    // 提取行内公式 $...$（不匹配 $$）
    processed = processed.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
      const idx = blocks.length;
      blocks.push({ type: 'math_inline', content: math.trim() });
      return `%%BLOCK_${idx}%%`;
    });

    // 用 marked 渲染 Markdown
    let html = '';
    if (typeof marked !== 'undefined') {
      html = marked.parse(processed, { breaks: true, gfm: true });
    } else {
      html = this._escapeHtml(processed).replace(/\n/g, '<br>');
    }

    // 还原占位符
    html = html.replace(/%%BLOCK_(\d+)%%/g, (_, idx) => {
      const block = blocks[parseInt(idx)];
      if (!block) return '';

      if (block.type === 'math_display') {
        return this._renderMath(block.content, true);
      }
      if (block.type === 'math_inline') {
        return this._renderMath(block.content, false);
      }

      // think / search 块内内容也用 marked 渲染
      let inner = '';
      if (typeof marked !== 'undefined') {
        inner = marked.parse(block.content, { breaks: true, gfm: true });
      } else {
        inner = this._escapeHtml(block.content).replace(/\n/g, '<br>');
      }
      if (block.type === 'think') {
        return `<div class="think-block"><div class="collapsible-header collapsed"><span class="arrow">▼</span>思考过程</div><div class="collapsible-body collapsed">${inner}</div></div>`;
      } else if (block.type === 'search') {
        return `<div class="search-block"><div class="collapsible-header collapsed"><span class="arrow">▼</span>搜索来源</div><div class="collapsible-body collapsed">${inner}</div></div>`;
      }
      return inner;
    });

    return html;
  }

  _renderMath(tex, displayMode) {
    if (typeof katex !== 'undefined') {
      try {
        return katex.renderToString(tex, { displayMode, throwOnError: false });
      } catch (e) {
        // KaTeX 渲染失败，降级显示
      }
    }
    const escaped = this._escapeHtml(tex);
    if (displayMode) {
      return `<div class="math-block">$$${escaped}$$</div>`;
    }
    return `<span class="math-inline">$${escaped}$</span>`;
  }

  _renderResultHTML(content) {
    return this._renderMarkdown(content);
  }

  // ===== 做题模式 =====

  // 从内容中解析 QUIZ_DATA JSON
  _parseQuizData(content) {
    const match = content.match(/<!--\s*QUIZ_DATA\s*([\s\S]*?)-->/);
    if (!match) return null;
    const raw = match[1].trim();

    // 尝试直接解析
    try {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.questions) && data.questions.length > 0) {
        return data;
      }
    } catch (e) {
      // 直接解析失败是预期行为（AI 输出可能不规范），后续有修复逻辑兜底
      console.debug('[AIBall] 测验数据直接解析失败，尝试修复:', e.message);
    }

    // 修复尝试：逐个提取 question 对象
    try {
      const repaired = this._repairQuizJSON(raw);
      if (repaired) return repaired;
    } catch (e) {
      console.warn('[AIBall] 测验数据修复失败:', e);
    }

    return null;
  }

  // 修复 AI 输出的可能不合法的 JSON
  _repairQuizJSON(raw) {
    const questions = [];
    // 逐个匹配 question 对象（容错：字段顺序不固定、值内可能有特殊字符）
    const objRegex = /\{[^{}]*?"type"\s*:\s*"(choice|truefalse|fill)"[^{}]*?\}/g;
    let m;
    while ((m = objRegex.exec(raw)) !== null) {
      let objStr = m[0];
      // 尝试解析单个 question 对象
      try {
        const q = JSON.parse(objStr);
        if (q.type && q.question && q.answer) {
          questions.push(q);
          continue;
        }
      } catch (e) {
        // 单个对象解析失败，尝试修复值内未转义的双引号
        objStr = this._fixUnescapedQuotes(objStr);
        try {
          const q = JSON.parse(objStr);
          if (q.type && q.question && q.answer) {
            questions.push(q);
          }
        } catch (e2) {
          // 跳过无法修复的对象
        }
      }
    }
    return questions.length > 0 ? { questions } : null;
  }

  // 修复 JSON 字符串值内未转义的 ASCII 双引号
  // 策略：将 key 后面的值中，非 JSON 结构的 " 替换为中文引号
  _fixUnescapedQuotes(str) {
    // 匹配 "key":"value" 中 value 内部的未转义双引号
    // value 内的 " 如果不是字符串结束符，说明是未转义的
    return str.replace(/"(question|explanation|answer)"\s*:\s*"((?:[^"\\]|\\.)*?)(?=\s*[,}])/g,
      (match, key, val) => {
        // val 中如果还残留 "，说明是未转义的，替换为中文引号
        const fixed = val.replace(/"/g, '\u201C').replace(/\u201C([^\u201D]*)$/, '\u201C$1\u201D');
        return `"${key}":"${fixed}"`;
      });
  }

  // 开始做题模式（container 可选，默认为 #ai-qa-result）
  _startQuizMode(container) {
    if (!this._quizData || !this._quizData.questions) return;

    const questions = this._quizData.questions;
    this._quizState = {
      currentIndex: 0,
      answers: new Array(questions.length).fill(null),
      submitted: new Array(questions.length).fill(false)
    };

    const targetEl = container || this.panelShadow.querySelector('#ai-qa-result');
    this._quizContainer = targetEl;
    this._quizSavedHTML = targetEl.innerHTML;

    // 保存容器原始样式，切换为 flex 布局让做题模式占满高度
    this._quizSavedStyle = {
      display: targetEl.style.display,
      overflow: targetEl.style.overflow,
      overflowY: targetEl.style.overflowY,
      padding: targetEl.style.padding,
      flexDirection: targetEl.style.flexDirection
    };
    targetEl.style.display = 'flex';
    targetEl.style.flexDirection = 'column';
    targetEl.style.overflow = 'hidden';
    targetEl.style.overflowY = 'hidden';
    targetEl.style.padding = '0';

    // 主面板做题模式：隐藏标签栏、输入区域、底部状态栏
    const isMainResult = targetEl.id === 'ai-qa-result';
    this._quizHiddenEls = [];
    if (isMainResult) {
      for (const sel of ['.qa-tabs', '.qa-input-area', '.qa-footer']) {
        const el = this.panelShadow.querySelector(sel);
        if (el) {
          this._quizHiddenEls.push(el);
          el.style.display = 'none';
        }
      }
      targetEl.style.flex = '1';
    }

    targetEl.innerHTML = `
      <div class="quiz-mode" id="ai-qa-quiz-mode">
        <div class="quiz-mode-bar">
          <span class="quiz-progress" id="ai-qa-quiz-progress"></span>
          <button class="quiz-exit-btn" id="ai-qa-quiz-exit">退出做题</button>
        </div>
        <div class="quiz-card" id="ai-qa-quiz-card"></div>
        <div class="quiz-nav" id="ai-qa-quiz-nav"></div>
      </div>
    `;

    this.panelShadow.querySelector('#ai-qa-quiz-exit').addEventListener('click', () => this._exitQuizMode());
    this._renderQuizQuestion();
  }

  // 渲染当前题目
  _renderQuizQuestion() {
    const questions = this._quizData.questions;
    const idx = this._quizState.currentIndex;
    const q = questions[idx];
    const submitted = this._quizState.submitted[idx];
    const userAnswer = this._quizState.answers[idx];

    const typeLabels = { choice: '选择题', truefalse: '判断题', fill: '填空题' };
    const progressEl = this.panelShadow.querySelector('#ai-qa-quiz-progress');
    const cardEl = this.panelShadow.querySelector('#ai-qa-quiz-card');
    const navEl = this.panelShadow.querySelector('#ai-qa-quiz-nav');

    progressEl.textContent = `第 ${idx + 1} / ${questions.length} 题`;

    let optionsHTML = '';
    if (q.type === 'choice') {
      optionsHTML = '<div class="quiz-options">';
      const options = q.options || {};
      for (const key of Object.keys(options)) {
        const isSelected = userAnswer === key;
        const isCorrect = submitted && key === q.answer;
        const isWrong = submitted && isSelected && key !== q.answer;
        let cls = 'quiz-option';
        if (isSelected) cls += ' selected';
        if (isCorrect) cls += ' correct';
        if (isWrong) cls += ' wrong';
        optionsHTML += `
          <div class="${cls}" data-option="${key}">
            <span class="quiz-option-key">${key}</span>
            <span class="quiz-option-text">${this._escapeHtml(options[key])}</span>
          </div>`;
      }
      optionsHTML += '</div>';
    } else if (q.type === 'truefalse') {
      optionsHTML = '<div class="quiz-options quiz-options-tf">';
      for (const val of ['正确', '错误']) {
        const isSelected = userAnswer === val;
        const isCorrect = submitted && val === q.answer;
        const isWrong = submitted && isSelected && val !== q.answer;
        let cls = 'quiz-option quiz-option-tf';
        if (isSelected) cls += ' selected';
        if (isCorrect) cls += ' correct';
        if (isWrong) cls += ' wrong';
        optionsHTML += `<div class="${cls}" data-option="${val}">${val}</div>`;
      }
      optionsHTML += '</div>';
    } else if (q.type === 'fill') {
      const value = userAnswer || '';
      const disabled = submitted ? 'disabled' : '';
      const inputCls = submitted
        ? (userAnswer === q.answer ? 'quiz-input correct' : 'quiz-input wrong')
        : 'quiz-input';
      optionsHTML = `<input type="text" class="${inputCls}" id="ai-qa-quiz-fill" placeholder="输入你的答案..." value="${this._escapeHtml(value)}" ${disabled} />`;
    }

    // 反馈区域
    let feedbackHTML = '';
    if (submitted) {
      const isCorrect = this._checkQuizAnswer(q, userAnswer);
      feedbackHTML = `
        <div class="quiz-feedback ${isCorrect ? 'feedback-correct' : 'feedback-wrong'}">
          <div class="quiz-feedback-status">${isCorrect ? '✓ 回答正确' : '✗ 回答错误'}</div>
          <div class="quiz-feedback-answer">正确答案：<strong>${this._escapeHtml(String(q.answer))}</strong></div>
          <div class="quiz-feedback-explanation"><span class="quiz-feedback-label">解析：</span>${this._renderMarkdown(q.explanation || '')}</div>
        </div>`;
    }

    cardEl.innerHTML = `
      <div class="quiz-q-type">${typeLabels[q.type] || '题目'}</div>
      <div class="quiz-q-text">${this._renderMarkdown(q.question || '')}</div>
      ${optionsHTML}
      ${feedbackHTML}
    `;

    // 绑定选项点击
    if (!submitted) {
      cardEl.querySelectorAll('[data-option]').forEach(el => {
        el.addEventListener('click', () => {
          this._quizState.answers[idx] = el.dataset.option;
          this._renderQuizQuestion();
        });
      });
      // 填空题输入
      const fillInput = cardEl.querySelector('#ai-qa-quiz-fill');
      if (fillInput) {
        fillInput.addEventListener('input', () => {
          this._quizState.answers[idx] = fillInput.value;
        });
      }
    }

    // 导航按钮
    let navHTML = '';
    if (idx > 0) {
      navHTML += `<button class="quiz-nav-btn quiz-prev-btn" id="ai-qa-quiz-prev">上一题</button>`;
    }
    if (!submitted) {
      navHTML += `<button class="quiz-nav-btn quiz-submit-btn" id="ai-qa-quiz-submit">提交答案</button>`;
    } else if (idx < questions.length - 1) {
      navHTML += `<button class="quiz-nav-btn quiz-next-btn" id="ai-qa-quiz-next">下一题</button>`;
    } else {
      navHTML += `<button class="quiz-nav-btn quiz-finish-btn" id="ai-qa-quiz-finish">查看结果</button>`;
    }
    navEl.innerHTML = navHTML;

    // 绑定导航事件
    const prevBtn = navEl.querySelector('#ai-qa-quiz-prev');
    if (prevBtn) prevBtn.addEventListener('click', () => {
      this._quizState.currentIndex--;
      this._renderQuizQuestion();
    });
    const submitBtn = navEl.querySelector('#ai-qa-quiz-submit');
    if (submitBtn) submitBtn.addEventListener('click', () => this._submitQuizAnswer());
    const nextBtn = navEl.querySelector('#ai-qa-quiz-next');
    if (nextBtn) nextBtn.addEventListener('click', () => {
      this._quizState.currentIndex++;
      this._renderQuizQuestion();
    });
    const finishBtn = navEl.querySelector('#ai-qa-quiz-finish');
    if (finishBtn) finishBtn.addEventListener('click', () => this._showQuizSummary());
  }

  // 提交当前题目答案
  _submitQuizAnswer() {
    const idx = this._quizState.currentIndex;
    const q = this._quizData.questions[idx];
    const userAnswer = this._quizState.answers[idx];

    if (userAnswer === null || userAnswer === undefined || userAnswer === '') {
      const statusEl = this.panelShadow.querySelector('#ai-qa-status');
      if (statusEl) {
        const orig = statusEl.textContent;
        statusEl.textContent = '请先选择/输入答案';
        setTimeout(() => { statusEl.textContent = orig; }, 2000);
      }
      return;
    }

    this._quizState.submitted[idx] = true;
    this._renderQuizQuestion();
  }

  // 检查答案是否正确
  _checkQuizAnswer(q, userAnswer) {
    if (userAnswer === null || userAnswer === undefined) return false;
    const correct = String(q.answer).trim();
    const user = String(userAnswer).trim();

    if (q.type === 'truefalse') {
      // 判断题：规范化"正确"和"错误"的各种写法
      const yesSet = ['正确', '对', '是', 'true', 't', 'y', 'yes'];
      const noSet = ['错误', '错', '否', 'false', 'f', 'n', 'no'];
      const correctLower = correct.toLowerCase();
      const userLower = user.toLowerCase();
      const correctIsYes = yesSet.includes(correctLower);
      const correctIsNo = noSet.includes(correctLower);
      const userIsYes = yesSet.includes(userLower);
      const userIsNo = noSet.includes(userLower);
      return (correctIsYes && userIsYes) || (correctIsNo && userIsNo);
    }

    if (q.type === 'fill') {
      // 填空题：忽略大小写、首尾空格、全角/半角差异
      const normalize = (s) => s.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[-—~～]/g, '~')
        .replace(/[，,]/g, ',')
        .replace(/[（(]/g, '(')
        .replace(/[）)]/g, ')');
      return normalize(correct) === normalize(user);
    }

    // 选择题：大写字母匹配
    return correct.toUpperCase() === user.toUpperCase();
  }

  // 显示做题结果汇总
  _showQuizSummary() {
    const questions = this._quizData.questions;
    let correct = 0;
    let answered = 0;
    for (let i = 0; i < questions.length; i++) {
      if (this._quizState.submitted[i]) {
        answered++;
        if (this._checkQuizAnswer(questions[i], this._quizState.answers[i])) correct++;
      }
    }

    const cardEl = this.panelShadow.querySelector('#ai-qa-quiz-card');
    const navEl = this.panelShadow.querySelector('#ai-qa-quiz-nav');
    const progressEl = this.panelShadow.querySelector('#ai-qa-quiz-progress');

    const rate = questions.length > 0 ? Math.round((correct / questions.length) * 100) : 0;
    let rateLabel = '继续努力';
    if (rate >= 80) rateLabel = '优秀';
    else if (rate >= 60) rateLabel = '及格';

    progressEl.textContent = `做题完成`;
    cardEl.innerHTML = `
      <div class="quiz-summary">
        <div class="quiz-summary-score">${correct} / ${questions.length}</div>
        <div class="quiz-summary-rate">正确率 ${rate}% · ${rateLabel}</div>
        <div class="quiz-summary-detail">已作答 ${answered} 题，正确 ${correct} 题${answered < questions.length ? `，未作答 ${questions.length - answered} 题` : ''}</div>
      </div>
    `;
    navEl.innerHTML = `<button class="quiz-nav-btn quiz-redo-btn" id="ai-qa-quiz-redo">重新做题</button><button class="quiz-nav-btn quiz-exit-summary-btn" id="ai-qa-quiz-exit2">返回</button>`;

    this.panelShadow.querySelector('#ai-qa-quiz-redo').addEventListener('click', () => this._restartQuiz());
    this.panelShadow.querySelector('#ai-qa-quiz-exit2').addEventListener('click', () => this._exitQuizMode());
  }

  // 重新做题（不覆盖已保存的原始 HTML）
  _restartQuiz() {
    if (!this._quizData || !this._quizData.questions) return;
    const questions = this._quizData.questions;
    this._quizState = {
      currentIndex: 0,
      answers: new Array(questions.length).fill(null),
      submitted: new Array(questions.length).fill(false)
    };
    // 重建做题模式 DOM（不调用 _startQuizMode，避免覆盖 _quizSavedHTML）
    this._quizContainer.innerHTML = `
      <div class="quiz-mode" id="ai-qa-quiz-mode">
        <div class="quiz-mode-bar">
          <span class="quiz-progress" id="ai-qa-quiz-progress"></span>
          <button class="quiz-exit-btn" id="ai-qa-quiz-exit">退出做题</button>
        </div>
        <div class="quiz-card" id="ai-qa-quiz-card"></div>
        <div class="quiz-nav" id="ai-qa-quiz-nav"></div>
      </div>
    `;
    this.panelShadow.querySelector('#ai-qa-quiz-exit').addEventListener('click', () => this._exitQuizMode());
    this._renderQuizQuestion();
  }

  // 退出做题模式
  _exitQuizMode() {
    if (this._quizContainer && this._quizSavedHTML) {
      this._quizContainer.innerHTML = this._quizSavedHTML;
      this._quizSavedHTML = null;
    }
    // 恢复容器原始样式
    if (this._quizContainer && this._quizSavedStyle) {
      const s = this._quizSavedStyle;
      this._quizContainer.style.display = s.display;
      this._quizContainer.style.flexDirection = s.flexDirection;
      this._quizContainer.style.overflow = s.overflow;
      this._quizContainer.style.overflowY = s.overflowY;
      this._quizContainer.style.padding = s.padding;
      this._quizContainer.style.flex = '';
      this._quizSavedStyle = null;
    }
    // 恢复隐藏的元素
    if (this._quizHiddenEls) {
      this._quizHiddenEls.forEach(el => { el.style.display = ''; });
      this._quizHiddenEls = null;
    }
    this._quizState = null;
    this._quizContainer = null;
  }

  _renderAssistantContent(content, reasoning) {
    const asstMsg = this.panelShadow.querySelector('#ai-qa-assistant-msg .qa-msg-content');
    if (!asstMsg) return;
    // 若有思考过程，渲染可折叠思考块（默认收起）+ 正式回答
    const reasoningText = (reasoning || this._streamingReasoning || '').trim();
    let html = '';
    if (reasoningText) {
      const isStreaming = this.isGenerating;
      html += `
        <div class="qa-thinking-block collapsed" id="ai-qa-thinking-block">
          <div class="qa-thinking-header" id="ai-qa-thinking-header">
            <span class="arrow">▼</span>
            <span class="label">思考过程</span>
            <span class="status">${isStreaming ? '思考中...' : '已完成'}</span>
          </div>
          <div class="qa-thinking-body">${this._escapeHtml(reasoningText)}</div>
        </div>
      `;
    }
    html += this._renderMarkdown(content);
    asstMsg.innerHTML = html;
    // 绑定折叠点击
    const block = this.panelShadow.querySelector('#ai-qa-thinking-block');
    const header = this.panelShadow.querySelector('#ai-qa-thinking-header');
    if (block && header) {
      header.addEventListener('click', () => block.classList.toggle('collapsed'));
    }
  }

  // 仅更新思考块（流式思考阶段，不影响正式回答占位）
  _renderThinkingBlock(reasoning, streaming) {
    const asstMsg = this.panelShadow.querySelector('#ai-qa-assistant-msg .qa-msg-content');
    if (!asstMsg) return;
    let block = this.panelShadow.querySelector('#ai-qa-thinking-block');
    if (!block) {
      // 首次收到思考 chunk：初始化结构，保留 typing-indicator 占位
      asstMsg.innerHTML = `
        <div class="qa-thinking-block collapsed" id="ai-qa-thinking-block">
          <div class="qa-thinking-header" id="ai-qa-thinking-header">
            <span class="arrow">▼</span>
            <span class="label">思考过程</span>
            <span class="status">${streaming ? '思考中...' : '已完成'}</span>
          </div>
          <div class="qa-thinking-body">${this._escapeHtml(reasoning || '')}</div>
        </div>
        <div class="typing-indicator"><span></span><span></span><span></span></div>
      `;
      const header = this.panelShadow.querySelector('#ai-qa-thinking-header');
      const blockEl = this.panelShadow.querySelector('#ai-qa-thinking-block');
      if (header && blockEl) {
        header.addEventListener('click', () => blockEl.classList.toggle('collapsed'));
      }
    } else {
      // 更新思考内容（保持折叠状态不变）
      const body = block.querySelector('.qa-thinking-body');
      if (body) body.textContent = reasoning || '';
      const status = block.querySelector('.status');
      if (status) status.textContent = streaming ? '思考中...' : '已完成';
    }
  }

  // 读取深度思考开关当前状态
  _isThinkingEnabled() {
    const toggle = this.panelShadow.querySelector('#ai-qa-thinking-toggle');
    if (!toggle) return undefined;
    return toggle.classList.contains('active');
  }

  // 从 LLM 设置读取 enableThinking 初始化 toggle 状态（仅初始化一次）
  _initThinkingToggle() {
    if (this._thinkingToggleInited) return;
    this._thinkingToggleInited = true;
    const toggle = this.panelShadow.querySelector('#ai-qa-thinking-toggle');
    if (!toggle) return;
    try {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS', category: 'llm' }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        const config = resp.config || {};
        // enableThinking 默认 true（仅显式 false 时关闭）
        const enabled = config.enableThinking !== false;
        if (enabled) {
          toggle.classList.add('active');
          toggle.setAttribute('aria-pressed', 'true');
        } else {
          toggle.classList.remove('active');
          toggle.setAttribute('aria-pressed', 'false');
        }
      });
    } catch (e) {
      // 读取失败时保持默认（不开启）
    }
  }

  handleExport() {
    if (!this._lastResult) return;
    const tabNames = { organize: '整理结果', quiz: '测验', chat: '问答' };
    const filename = `${tabNames[this.currentTab] || '结果'}_${new Date().toLocaleDateString('zh-CN')}.txt`;
    const blob = new Blob([this._lastResult], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  setLoading(isLoading) {
    if (isLoading) {
      this.ballInner.innerHTML = '<div class="loading-dot"></div>';
    } else {
      this.ballInner.innerHTML = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
      `;
    }
  }
}

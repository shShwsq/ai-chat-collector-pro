// ui/viewer.js - 对话查看器（弹窗 + Markdown/KaTeX 渲染）

// 注册 marked 自定义 renderer：引用编号链接（文本仅为数字）渲染为圆圈上标
// 仅影响 viewer 内的渲染，存储格式仍为 [N](url)
// 各平台 DOM 提取的引用编号经 turndown 转为 [N](url)，marked 默认渲染为普通蓝色链接，
// 辨识度低；加圆圈包裹与原平台（DeepSeek .ds-markdown-cite / 复旦 a.citation-link.circle）视觉一致
if (typeof marked !== 'undefined') {
  marked.use({
    renderer: {
      link({ href, title, text }) {
        // 基本安全：仅允许 http/https/mailto/相对路径协议
        const safeHref = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#';
        const titleAttr = title ? ` title="${title}"` : '';
        // 引用编号：链接文本仅为数字，渲染为圆圈上标
        if (/^\d+$/.test(text.trim())) {
          return `<a href="${safeHref}"${titleAttr} class="cite-ref" target="_blank" rel="noreferrer">${text}</a>`;
        }
        return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noreferrer">${text}</a>`;
      }
    }
  });
}

class ConversationViewer {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.viewer = null;
    this.createViewer();
  }

  createViewer() {
    // Shadow DOM 隔离：viewer 样式与宿主页互不影响
    this.host = document.createElement('div');
    this.host.id = 'ai-chat-viewer-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });

    // viewer 样式（:host 定位/显隐 + viewer 内部规则 + 公式样式）注入 shadow 内
    const style = document.createElement('style');
    style.textContent = (AIChatStyles.viewerCSS || '') + '\n' + (AIChatStyles.mathCSS || '');
    this.shadow.appendChild(style);

    // KaTeX CSS 需在 shadow 内加载——head 全局样式无法穿透 shadow 边界
    const katexCss = document.createElement('link');
    katexCss.rel = 'stylesheet';
    katexCss.href = chrome.runtime.getURL('lib/katex.min.css');
    this.shadow.appendChild(katexCss);

    // viewer 结构
    this.viewer = document.createElement('div');
    this.viewer.id = 'ai-chat-viewer';
    this.viewer.innerHTML = `
      <div class="viewer-box">
        <div class="viewer-header">
          <h3 id="acc-viewer-title">对话详情</h3>
          <button class="close-btn">&times;</button>
        </div>
        <div class="viewer-body" id="acc-viewer-body"></div>
      </div>
    `;
    this.shadow.appendChild(this.viewer);
    document.body.appendChild(this.host);

    this.viewer.querySelector('.close-btn').addEventListener('click', () => this.close());

    // 事件委托：点击 .collapsible-header 切换折叠（思考过程 / 搜索来源）
    // 不能用内联 onclick：宿主页 CSP 收紧后会失效
    this.viewer.querySelector('#acc-viewer-body').addEventListener('click', (e) => {
      const header = e.target.closest('.collapsible-header');
      if (!header) return;
      header.classList.toggle('collapsed');
      const bodyEl = header.nextElementSibling;
      if (bodyEl && bodyEl.classList.contains('collapsible-body')) {
        bodyEl.classList.toggle('collapsed');
      }
    });

    // 弹窗拖拽（通过 header 拖动）
    // makeDraggable 在 document 上监听 mousemove/mouseup，shadow 内的 mousedown 事件
    // 会冒泡到 document，拖拽不受 shadow 边界影响
    const viewerBox = this.viewer.querySelector('.viewer-box');
    makeDraggable(viewerBox, this.viewer.querySelector('.viewer-header'));
  }

  async open(convId, sendMessage) {
    const response = await sendMessage({ type: 'GET_CONVERSATIONS' });
    if (!response) return;
    const conv = response.find(c => c.id === convId);
    if (!conv) return;

    this.viewer.querySelector('#acc-viewer-title').textContent = conv.title || '未命名对话';
    const body = this.viewer.querySelector('#acc-viewer-body');
    body.innerHTML = conv.messages.map(m => {
      const contentHtml = this.renderContent(m.content);
      return `<div class="msg-block ${m.role}">
        <div class="msg-role">${m.role === 'user' ? '用户' : '助手'}</div>
        <div class="msg-content">${contentHtml}</div>
      </div>`;
    }).join('');
    this.host.classList.add('open');

    // 居中定位
    const viewerBox = this.viewer.querySelector('.viewer-box');
    const boxW = viewerBox.offsetWidth;
    const boxH = viewerBox.offsetHeight;
    viewerBox.style.left = Math.max(8, (window.innerWidth - boxW) / 2) + 'px';
    viewerBox.style.top = Math.max(8, (window.innerHeight - boxH) / 2) + 'px';
  }

  close() {
    this.host.classList.remove('open');
  }

  renderContent(content) {
    if (!content) return '';

    // 先提取 <think> 和 <search_result> 块，用占位符替换
    const blocks = [];
    let processed = content;

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

    // 提取数学公式，用占位符替换（在 marked 之前处理，避免 marked 破坏公式）
    // 行间公式 $$...$$
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      const idx = blocks.length;
      blocks.push({ type: 'math_display', content: math.trim() });
      return `\n%%BLOCK_${idx}%%\n`;
    });
    // 行内公式 $...$（不匹配 $$）
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
      html = this.escapeHtml(processed).replace(/\n/g, '<br>');
    }

    // 还原占位符
    html = html.replace(/%%BLOCK_(\d+)%%/g, (_, idx) => {
      const block = blocks[parseInt(idx)];
      if (!block) return '';

      if (block.type === 'math_display') {
        return this.renderMath(block.content, true);
      }
      if (block.type === 'math_inline') {
        return this.renderMath(block.content, false);
      }

      // think / search 块内内容也用 marked 渲染
      let inner = '';
      if (typeof marked !== 'undefined') {
        inner = marked.parse(block.content, { breaks: true, gfm: true });
      } else {
        inner = this.escapeHtml(block.content).replace(/\n/g, '<br>');
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

  renderMath(tex, displayMode) {
    if (typeof katex !== 'undefined') {
      try {
        return katex.renderToString(tex, { displayMode, throwOnError: false });
      } catch (e) {
        // KaTeX 渲染失败，显示原始公式
      }
    }
    // 降级：显示原始 LaTeX
    const escaped = this.escapeHtml(tex);
    if (displayMode) {
      return `<div class="math-block">$$${escaped}$$</div>`;
    }
    return `<span class="math-inline">$${escaped}$</span>`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

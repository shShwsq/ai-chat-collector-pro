// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const conversationList = document.getElementById('conversationList');
  const platformFilter = document.getElementById('platformFilter');
  const exportAllBtn = document.getElementById('exportAllBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const statusEl = document.getElementById('status');
  const viewerOverlay = document.getElementById('viewerOverlay');
  const viewerTitle = document.getElementById('viewerTitle');
  const viewerBody = document.getElementById('viewerBody');
  const viewerClose = document.getElementById('viewerClose');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const pushLocalBtn = document.getElementById('pushLocalBtn');
  const pushBanner = document.getElementById('pushBanner');

  // 当前搜索关键词
  let currentSearchQuery = '';

  // 加载状态
  loadStatus();
  // 加载对话列表
  loadConversations();
  // 加载本地软件对接状态（用于在按钮上提示是否启用）
  loadLocalAppStatus();

  // 事件绑定
  platformFilter.addEventListener('change', loadConversations);
  exportAllBtn.addEventListener('click', handleExportAll);
  refreshBtn.addEventListener('click', () => {
    loadConversations();
    loadStatus();
  });

  settingsBtn.addEventListener('click', () => {
    window.location.href = 'settings.html';
  });

  // 发送到本地软件
  pushLocalBtn.addEventListener('click', handlePushToLocal);

  // 搜索
  searchBtn.addEventListener('click', handleSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
  // 清空搜索时恢复列表
  searchInput.addEventListener('input', () => {
    if (!searchInput.value.trim() && currentSearchQuery) {
      currentSearchQuery = '';
      loadConversations();
    }
  });

  // 查看器关闭
  viewerClose.addEventListener('click', closeViewer);
  viewerOverlay.addEventListener('click', (e) => {
    if (e.target === viewerOverlay) closeViewer();
  });

  // 事件委托：点击 .collapsible-header 切换折叠（思考过程 / 搜索来源）
  // 注意：不能用内联 onclick，Manifest V3 的 CSP 禁止内联事件处理器
  viewerBody.addEventListener('click', (e) => {
    const header = e.target.closest('.collapsible-header');
    if (!header) return;
    header.classList.toggle('collapsed');
    const body = header.nextElementSibling;
    if (body && body.classList.contains('collapsible-body')) {
      body.classList.toggle('collapsed');
    }
  });

  async function loadStatus() {
    const response = await sendMessage({ type: 'GET_STATUS' });
    if (response) {
      statusEl.textContent = `${response.totalConversations} 条对话 · ${response.totalMessages} 条消息`;
      updatePlatformFilter(response.platforms);
    }
  }

  function updatePlatformFilter(platforms) {
    const current = platformFilter.value;
    const options = ['<option value="">全部平台</option>'];
    const platformNames = {
      deepseek: 'DeepSeek',
      chatgpt: 'ChatGPT',
      claude: 'Claude',
      kimi: 'Kimi',
      qianwen: '千问',
      yiyan: '文心一言'
    };

    for (const p of platforms) {
      const label = platformNames[p] || p;
      options.push(`<option value="${p}">${label}</option>`);
    }
    platformFilter.innerHTML = options.join('');
    platformFilter.value = current;
  }

  async function loadConversations() {
    const platform = platformFilter.value;
    
    let response;
    if (currentSearchQuery) {
      response = await sendMessage({
        type: 'SEARCH_CONVERSATIONS',
        query: currentSearchQuery,
        filters: platform ? { platform } : {}
      });
    } else {
      response = await sendMessage({
        type: 'GET_CONVERSATIONS',
        filters: platform ? { platform } : {}
      });
    }

    if (!response || response.length === 0) {
      conversationList.innerHTML = '<div class="empty-state">暂无对话记录<br><small>打开 AI 平台开始对话，数据将自动采集</small></div>';
      return;
    }

    conversationList.innerHTML = '';
    for (const conv of response) {
      conversationList.appendChild(createConvItem(conv));
    }
  }

  function createConvItem(conv) {
    const div = document.createElement('div');
    div.className = 'conv-item';
    div.dataset.id = conv.id;

    const platformNames = {
      deepseek: 'DeepSeek',
      chatgpt: 'ChatGPT',
      claude: 'Claude',
      kimi: 'Kimi',
      qianwen: '千问',
      yiyan: '文心一言'
    };

    const date = new Date(conv.updatedAt).toLocaleDateString('zh-CN');
    const platformLabel = platformNames[conv.platform] || conv.platform;

    // 语义命中时显示相似度徽章（0-1 → 百分比）
    const simBadge = conv._similarity > 0
      ? `<span class="conv-similarity" title="语义相似度 ${Math.round(conv._similarity * 100)}%">语义 ${Math.round(conv._similarity * 100)}%</span>`
      : '';

    // 关键字命中时提取并高亮包含 term 的句子（标题优先，否则取首条命中消息）
    const snippet = findMatchSnippet(currentSearchQuery, conv);
    const snippetHTML = snippet
      ? `<div class="conv-snippet">${escapeHtmlWithHighlight(snippet.text, snippet.terms)}</div>`
      : '';

    div.innerHTML = `
      <div class="conv-header">
        <div class="conv-title" title="${escapeHtml(conv.title || '')}">${escapeHtml(conv.title || '')}</div>
        <span class="conv-platform">${escapeHtml(platformLabel || '')}</span>
        ${simBadge}
      </div>
      <div class="conv-meta">
        <span class="conv-messages-count">${conv.messages.length} 条消息</span>
        <span>${date}</span>
      </div>
      ${snippetHTML}
      <div class="conv-messages-preview">
        ${conv.messages.slice(0, 6).map(m => `
          <div class="msg-preview ${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="msg-role">${m.role === 'user' ? '用户' : '助手'}</div>
            <div class="msg-text">${escapeHtml(m.content)}</div>
          </div>
        `).join('')}
        ${conv.messages.length > 6 ? `<div class="conv-more">还有 ${conv.messages.length - 6} 条消息...</div>` : ''}
      </div>
      <div class="conv-actions">
        <button class="btn btn-view">查看</button>
        <button class="btn btn-primary export-btn">导出 Markdown</button>
        <button class="btn export-json-btn">导出 JSON</button>
        <button class="btn btn-danger delete-btn">删除</button>
      </div>
    `;

    // 点击展开/收起
    div.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      div.classList.toggle('expanded');
    });

    // 查看完整对话
    div.querySelector('.btn-view').addEventListener('click', async (e) => {
      e.stopPropagation();
      openViewer(conv);
    });

    // 导出 Markdown
    div.querySelector('.export-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendMessage({ type: 'EXPORT_CONVERSATION', id: conv.id, format: 'markdown' });
    });

    // 导出 JSON
    div.querySelector('.export-json-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await sendMessage({ type: 'EXPORT_CONVERSATION', id: conv.id, format: 'json' });
    });

    // 删除
    div.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`确定删除「${conv.title}」？`)) {
        await sendMessage({ type: 'DELETE_CONVERSATION', id: conv.id });
        loadConversations();
        loadStatus();
      }
    });

    return div;
  }

  async function handleExportAll() {
    const format = confirm('点击"确定"导出为 Markdown，点击"取消"导出为 JSON') ? 'markdown' : 'json';
    await sendMessage({ type: 'EXPORT_ALL', format });
  }

  async function handleSearch() {
    const query = searchInput.value.trim();
    currentSearchQuery = query;
    await loadConversations();
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response);
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 从 query 和对话内容中提取命中片段（用于关键字高亮）
  // 优先级：标题 > 第一条命中的消息
  // 返回 { text, terms } 或 null
  function findMatchSnippet(query, conv) {
    const terms = (query || '').trim().split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return null;
    const lowerTerms = terms.map(t => t.toLowerCase());

    // 1. 标题优先
    if (conv.title) {
      const found = extractSentenceWithTerms(conv.title, lowerTerms);
      if (found) return found;
    }

    // 2. 扫描消息，找第一条命中
    for (const msg of (conv.messages || [])) {
      const found = extractSentenceWithTerms(msg.content || '', lowerTerms);
      if (found) return found;
    }

    return null;
  }

  // 在文本中找第一个包含任一 term 的句子
  // 拆句按中英文句末标点和换行；过长句子围绕首个命中位置截取 80 字符
  // 返回 { text, terms } 或 null
  function extractSentenceWithTerms(text, lowerTerms) {
    if (!text) return null;
    // lookbehind 在现代 Chrome 中支持（popup 运行环境）
    const sentences = text.split(/(?<=[。!?；.!?;\n])/);
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();
      const hitTerms = lowerTerms.filter(t => lower.includes(t));
      if (hitTerms.length > 0) {
        let s = sentence.trim();
        if (!s) continue;
        if (s.length > 80) {
          const idx = lower.indexOf(hitTerms[0].toLowerCase());
          const start = Math.max(0, idx - 30);
          const end = Math.min(s.length, start + 80);
          s = (start > 0 ? '...' : '') + s.substring(start, end) + (end < s.length ? '...' : '');
        }
        return { text: s, terms: hitTerms };
      }
    }
    return null;
  }

  // 转义 HTML 后用 <mark> 包裹命中 term
  function escapeHtmlWithHighlight(text, terms) {
    const escaped = escapeHtml(text);
    let result = escaped;
    for (const term of terms) {
      const escapedTerm = escapeHtml(term);
      if (!escapedTerm) continue;
      // 转义 regex 特殊字符
      const safe = escapedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(safe, 'gi'), '<mark>$&</mark>');
    }
    return result;
  }

  // ===== 完整对话查看器 =====
  function openViewer(conv) {
    viewerTitle.textContent = conv.title || '未命名对话';
    viewerBody.innerHTML = conv.messages.map(m => {
      const contentHtml = renderViewerContent(m.content);
      return `<div class="v-msg ${m.role}">
        <div class="v-role">${m.role === 'user' ? '用户' : '助手'}</div>
        <div class="v-content">${contentHtml}</div>
      </div>`;
    }).join('');
    viewerOverlay.classList.add('open');
  }

  function closeViewer() {
    viewerOverlay.classList.remove('open');
  }

  function renderViewerContent(content) {
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

    // 提取数学公式（在 marked 之前处理，避免 marked 破坏公式）
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
      html = HtmlSanitizer.sanitize(marked.parse(processed, { breaks: true, gfm: true }));
    } else {
      html = escapeHtml(processed).replace(/\n/g, '<br>');
    }

    // 还原占位符
    html = html.replace(/%%BLOCK_(\d+)%%/g, (_, idx) => {
      const block = blocks[parseInt(idx)];
      if (!block) return '';

      if (block.type === 'math_display') {
        return renderMath(block.content, true);
      }
      if (block.type === 'math_inline') {
        return renderMath(block.content, false);
      }

      // think / search 块内内容也用 marked 渲染
      let inner = '';
      if (typeof marked !== 'undefined') {
        inner = HtmlSanitizer.sanitize(marked.parse(block.content, { breaks: true, gfm: true }));
      } else {
        inner = escapeHtml(block.content).replace(/\n/g, '<br>');
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

  function renderMath(tex, displayMode) {
    if (typeof katex !== 'undefined') {
      try {
        return katex.renderToString(tex, { displayMode, throwOnError: false });
      } catch (e) {
        // KaTeX 渲染失败，显示原始公式
      }
    }
    // 降级：显示原始 LaTeX
    const escaped = escapeHtml(tex);
    if (displayMode) {
      return `<div class="math-block">$$${escaped}$$</div>`;
    }
    return `<span class="math-inline">$${escaped}$</span>`;
  }

  // ===== 本地软件对接 =====

  // 加载本地软件对接状态，未启用时按钮提示用户先去设置中开启
  let _localAppBaseUrl = 'http://localhost:8788';

  async function loadLocalAppStatus() {
    const resp = await sendMessage({ type: 'LOCAL_APP_STATUS' });
    if (!resp) return;
    if (resp.baseUrl) _localAppBaseUrl = resp.baseUrl;
    if (!resp.enabled) {
      pushLocalBtn.title = '尚未启用本地软件对接，点击会先尝试推送，建议在「设置 → 本地软件对接」中启用';
    } else {
      const parts = [];
      if (resp.autoPush) parts.push(`定时 ${resp.intervalMinutes}min`);
      if (resp.pushOnSave) parts.push('保存即推');
      pushLocalBtn.title = `已启用：${parts.join(' / ') || '手动推送'}；已推送 ${resp.pushedCount} 条`;
    }
  }

  // 点击「发送到本地软件」按钮：推送所有未推送的对话
  async function handlePushToLocal() {
    const originalText = pushLocalBtn.textContent;
    pushLocalBtn.disabled = true;
    pushLocalBtn.textContent = '发送中...';
    showPushBanner('info', '正在发送对话到本地软件...');

    try {
      const resp = await sendMessage({ type: 'LOCAL_APP_PUSH_ALL' });
      if (!resp) {
        showPushBanner('error', '推送失败：未收到响应');
        return;
      }
      if (resp.reason === 'disabled') {
        showPushBanner('error', '尚未启用本地软件对接。请到「设置 → 本地软件对接」中开启。');
        return;
      }
      if (resp.failed > 0 && resp.pushed === 0) {
        // 全部失败：通常是后端不可达
        const firstErr = resp.failures && resp.failures[0];
        const hint = firstErr ? firstErr.error : '未知错误';
        showPushBanner('error',
          `推送失败：${hint}。请确认本地软件（${_localAppBaseUrl}）已启动。`);
        return;
      }
      // 部分成功或全部成功
      const msg = `推送完成：共 ${resp.total} 条，成功 ${resp.pushed}，跳过 ${resp.skipped}，失败 ${resp.failed}`;
      showPushBanner(resp.failed > 0 ? 'info' : 'success', msg);
      // 刷新按钮 tooltip
      loadLocalAppStatus();
    } catch (e) {
      showPushBanner('error', `推送异常：${e.message}`);
    } finally {
      pushLocalBtn.disabled = false;
      pushLocalBtn.textContent = originalText;
    }
  }

  // 临时提示条
  let _bannerTimer = null;
  function showPushBanner(level, message) {
    pushBanner.textContent = message;
    pushBanner.className = `popup-banner show ${level}`;
    if (_bannerTimer) clearTimeout(_bannerTimer);
    // info 显示时间短一些（用户可能在频繁操作），success/error 长一点
    const ms = level === 'info' ? 3000 : 6000;
    _bannerTimer = setTimeout(() => {
      pushBanner.className = 'popup-banner';
    }, ms);
  }
});

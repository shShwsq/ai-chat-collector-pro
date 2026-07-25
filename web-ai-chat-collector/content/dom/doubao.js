// dom/doubao.js - 豆包 DOM提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//
// 限制说明：
// 1. 豆包使用虚拟滚动列表（v_list），DOM 中只保留当前可见的消息行。
//    长对话中滚出视图的消息会从 DOM 中移除，因此 DOM 模式可能无法提取完整对话。
// 2. 搜索来源（标题/URL/摘要）在 DOM 中不渲染，DOM 模式无法提取具体来源信息。
//    如需搜索来源，请使用网络模式。
// 3. 思考块默认折叠，仅展开时才能提取完整思考内容；折叠时只能拿到标题文本。
// 4. 标题依赖侧边栏已加载（#conversation_<id> 元素）。切换对话后若侧边栏未更新，标题可能短暂取错。
//
// DOM 结构（基于实际抓包确认）:
//   .list_items
//     .v_list_row[data-observe-row="block_..."]              真实消息行（首尾指示器无此属性）
//       用户消息:
//         flex.flex-row.justify-end                          右对齐布局
//           .md-box-root                                     用户消息 markdown 容器
//             .container-fBOrXO > .container-enLQFx           段落（html-to-markdown.js 按段落处理）
//       助手消息:
//         .grid.grid-cols-[...]                              grid 布局
//           [data-plugin-identifier*="block_type:10040"]      思考块
//             [class*="thinking-box-root"]                    思考容器
//               [data-thinking-box="title"]                   标题（"已完成思考，参考 N 篇资料"）
//               [data-thinking-box-collapsed-step-content]    折叠时的内容
//           [data-plugin-identifier*="block_type:10000"]      正式回答
//             .md-box-root                                    回答 markdown 容器
//           [data-plugin-identifier*="block_type:10025"]      搜索结果块（噪声，移除）
//           [data-plugin-identifier*="block_type:10050"]      相关视频/卡片块（噪声，移除）

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

DOM_ADAPTERS.doubao = {
  name: 'doubao',

  // 获取对话ID（从URL中提取）
  getConversationId: () => {
    const match = window.location.pathname.match(/\/chat\/(\d+)/);
    return match ? match[1] : 'default';
  },

  // 获取标题
  // 侧边栏每个对话项的 <a> 标签 id 形如 "conversation_<convId>"，与 URL 中的对话 ID 一致。
  // 当前激活对话还会带 aria-current="page"。优先用 ID 精确匹配，避免取到其他对话的标题。
  getTitle: () => {
    const convId = DOM_ADAPTERS.doubao.getConversationId();
    if (convId && convId !== 'default') {
      const item = document.getElementById(`conversation_${convId}`);
      if (item) {
        const titleEl = item.querySelector('[class*="overallTitle"]');
        if (titleEl) return titleEl.textContent.trim();
      }
    }
    // fallback 1: 激活状态匹配
    const activeItem = document.querySelector('a[aria-current="page"] [class*="overallTitle"], [class*="active-link"] [class*="overallTitle"]');
    if (activeItem) return activeItem.textContent.trim();
    // fallback 2: <title> 标签（格式通常为 "对话标题 - 豆包"）
    const titleEl = document.querySelector('title');
    if (titleEl) {
      const raw = titleEl.textContent.trim();
      return raw.replace(/\s*[-—]\s*豆包\s*$/, '');
    }
    return '';
  },

  // 检测流式输出是否进行中
  // 信号：流式时存在中断按钮（class 含 "break-btn"），完成态不存在
  // 注意：data-complete="true" 是视频卡片图片加载标记，不是消息完成标记，不可用
  isStreaming: () => {
    return !!document.querySelector('[class*="break-btn"]');
  },

  // 从DOM提取消息
  extractMessages: () => {
    const messages = [];

    // 消息列表容器（无 hash 后缀，稳定）
    const container = document.querySelector('.list_items');
    if (!container) {
      console.log('[Doubao/DOM] 未找到 .list_items 容器');
      return messages;
    }

    // 真实消息行：带 data-observe-row 属性的元素（首尾的指示器行无此属性）
    const rows = container.querySelectorAll('[data-observe-row]');
    console.log(`[Doubao/DOM] 找到 ${rows.length} 个消息行`);

    for (const row of rows) {
      const role = DOM_ADAPTERS.doubao._getRole(row);
      const content = DOM_ADAPTERS.doubao._extractContent(row, role);
      if (content) {
        messages.push({
          role: role,
          content: content,
          timestamp: new Date().toISOString()
        });
      }
    }

    console.log(`[Doubao/DOM] 共提取 ${messages.length} 条消息`);
    return messages;
  },

  // 获取角色
  // 判断依据（按可靠性排序）：
  // 1. 含 thinking-box-root → 助手（启用了深度思考）
  // 2. 含 iconContainer 类（豆包头像容器，仅助手消息渲染）→ 助手
  // 3. 含 receive-message-action-bar → 助手
  // 4. 否则 → 用户
  _getRole: (el) => {
    if (el.querySelector('[class*="thinking-box-root"], [data-thinking-box]')) {
      return 'assistant';
    }
    if (el.querySelector('[class*="iconContainer"]')) {
      return 'assistant';
    }
    if (el.querySelector('[data-foundation-type="receive-message-action-bar"]')) {
      return 'assistant';
    }
    return 'user';
  },

  // 提取消息内容
  _extractContent: (el, role) => {
    if (role === 'assistant') {
      return DOM_ADAPTERS.doubao._extractAssistantContent(el);
    }
    return DOM_ADAPTERS.doubao._extractUserContent(el);
  },

  // 提取用户消息内容
  _extractUserContent: (el) => {
    const mdBox = el.querySelector('.md-box-root');
    if (mdBox) {
      return DOM_ADAPTERS.doubao._extractMarkdownText(mdBox);
    }
    // 降级：textContent
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-foundation-type="send-message-action-bar"], svg, button').forEach(n => n.remove());
    return clone.textContent.trim();
  },

  // 提取助手消息内容（思考 + 回答）
  _extractAssistantContent: (el) => {
    let thinking = '';
    let answer = '';

    // 1. 提取思考内容
    const thinkingRoot = el.querySelector('[class*="thinking-box-root"]');
    if (thinkingRoot) {
      // 思考内容：优先取展开后的内容，折叠时只有标题
      const contentEl = thinkingRoot.querySelector('[data-thinking-box="content"]');
      if (contentEl) {
        const clone = contentEl.cloneNode(true);
        // 移除标题（"已完成思考，参考 N 篇资料"）
        clone.querySelectorAll('[data-thinking-box="title"]').forEach(n => n.remove());
        thinking = (clone.innerText || clone.textContent || '').trim();
      } else {
        // 折叠状态：取整个 thinkingRoot 文本并清理标题
        let thinkText = thinkingRoot.textContent.trim();
        thinkText = thinkText.replace(/^已完成思考[，,]\s*参考\s*\d+\s*篇资料\s*/, '');
        thinkText = thinkText.replace(/\s*已完成\s*$/, '');
        thinking = thinkText.trim();
      }
    }

    // 2. 提取回答正文：找到不在 thinking-box-root 内的 md-box-root
    const allMdBoxes = el.querySelectorAll('.md-box-root');
    for (const md of allMdBoxes) {
      if (md.closest('[class*="thinking-box-root"]')) continue;
      answer = DOM_ADAPTERS.doubao._extractMarkdownText(md);
      if (answer) break;
    }

    // 3. 拼接为标准格式（与网络适配器一致）
    let fullContent = '';
    if (thinking) fullContent += `<think>\n${thinking}\n</think>\n\n`;
    fullContent += answer;
    return fullContent.trim();
  },

  // 从 .md-box-root 元素提取 Markdown 文本
  // 使用 turndown.js 将渲染后的 HTML 转为 Markdown，保留标题/列表/粗体等格式
  // 降级：若 turndown 未加载，回退到 textContent
  _extractMarkdownText: (mdBoxEl) => {
    if (!mdBoxEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(mdBoxEl);
      console.log('[Doubao/DOM] _extractMarkdownText (turndown): 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级：textContent
    console.warn('[Doubao/DOM] HtmlToMarkdown 未加载，降级为 textContent');
    const clone = mdBoxEl.cloneNode(true);
    clone.querySelectorAll('style, svg, button, [data-foundation-type]').forEach(n => n.remove());
    return clone.textContent.trim();
  }
};

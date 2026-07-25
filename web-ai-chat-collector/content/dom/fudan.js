// dom/fudan.js - 复旦 AI Agent DOM提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//       network/fudan.js（NETWORK_ADAPTERS.fudan.parse，用于从流式响应提取 session_id）
//
// DOM 结构（基于实际抓包确认）:
//   #share_part.message_list
//     .message_item
//       .cardBox
//         .my_issue[position="q"]                       用户消息
//           .headImgRight.img                           用户头像（噪声，移除）
//           .question_copy_icon                         复制按钮（噪声，移除）
//           .text.myQuestion.q > .content > form.n-form
//             p.q_class > .md-editor.question.md-editor-previewOnly
//               .md-editor-preview-wrapper > .md-editor-preview    用户消息 markdown
//         .my_issue.has_a[position="a"]                 助手消息
//           .headImgLeft.img                            助手头像（噪声，移除）
//           .text.a > .content > form.n-form
//             .networking_card                          联网搜索来源卡片
//               .summarize                              摘要头（"quoteN using this information..."）
//               .link_box (display:none)                搜索链接列表（默认隐藏）
//                 .link_item                            "N、标题"（仅标题，无 URL）
//             .think_box                                深度思考容器
//               .think_title.show                       "deep thinking" 标题（噪声）
//               .border_box.show                        思考内容（纯文本，含 [citation:N] 引用标记）
//             .md-editor.answer.md-editor-previewOnly
//               .md-editor-preview-wrapper > .md-editor-preview    助手回答 markdown
//                 h1/h2/h3、p、strong、ul/ol/li、hr、blockquote、table
//                 a.citation-link[href]                 引用编号（文本=N，href=URL，对应 link_item 序号）
//
// 搜索来源 URL 补全：link_box 内 link_item 仅有标题，URL 从回答中的 a.citation-link 按编号映射获取

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

// 缓存从网络拦截器获取的 session id
// 流式新对话的 URL 不含 sess_id，但 /site/ai/compose_chat 的 SSE 响应中包含 session_id
// MAIN world 拦截器（network-interceptor.js）始终运行，DOM 模式复用它来获取 session_id
let _fudanCachedSessionId = '';
let _fudanComposeChatSeen = false;       // 是否观察到 compose_chat 请求（流式对话标志）
let _fudanWaitStart = 0;                 // 等待 session_id 的起始时间戳
const _FUDAN_SESSION_ID_TIMEOUT = 10000; // 等待 session_id 最长 10 秒，超时降级为 default

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== '__AI_CHAT_INTERCEPTED__') return;

  const { url, body, requestBody } = event.data;
  if (!url) return;

  // 标记观察到了 compose_chat 请求（流式新对话）
  if (url.includes('/site/ai/compose_chat')) {
    _fudanComposeChatSeen = true;
  }

  // 复用网络适配器的 matchApi + parse 提取 session_id
  const adapter = window.NETWORK_ADAPTERS?.fudan;
  if (!adapter || !adapter.matchApi(url)) return;

  try {
    const conversation = adapter.parse(url, body, requestBody);
    if (conversation && conversation.id && conversation.id !== 'unknown') {
      _fudanCachedSessionId = conversation.id;
      _fudanWaitStart = 0; // 拿到了，重置等待计时
      console.log('[Fudan/DOM] 从网络拦截获取 session_id: %s', _fudanCachedSessionId);
    }
  } catch (e) {
    // parse 失败不影响 DOM 提取
  }
});

DOM_ADAPTERS.fudan = {
  name: 'fudan',

  // 获取对话ID
  // 1. 历史对话：URL 中带 sess_id（点击历史对话时后端路由写入）
  // 2. 流式新对话：URL 无 sess_id，使用网络拦截器从 SSE 响应提取的 session_id
  // 3. 降级：default
  getConversationId: () => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessId = urlParams.get('sess_id');
    if (sessId) return sessId;
    if (_fudanCachedSessionId) return _fudanCachedSessionId;
    return 'default';
  },

  // 获取标题
  getTitle: () => {
    const activeSession = document.querySelector('.session.active_session');
    console.log('[Fudan/DOM] getTitle: .session.active_session=', activeSession ? `text="${activeSession.textContent.trim().substring(0,50)}"` : 'null');
    if (activeSession) {
      const text = activeSession.textContent.trim();
      if (text) return text;
    }
    const el = document.querySelector('title');
    console.log('[Fudan/DOM] getTitle: fallback title=', el ? `"${el.textContent.trim().substring(0,50)}"` : 'null');
    if (el) return el.textContent.trim();
    return '';
  },

  // 检测流式输出是否进行中
  // 信号1：Naive UI 的 .n-spin / .n-base-loading 加载组件，或 [aria-label="loading"]
  // 信号2：流式新对话（URL 无 sess_id 且已观察到 compose_chat 请求）时，阻塞采集直到 session_id 就绪
  isStreaming: () => {
    if (document.querySelector('.n-spin, .n-base-loading')) return true;
    if (document.querySelector('[aria-label="loading"]')) return true;

    // 流式新对话：URL 无 sess_id 且观察到 compose_chat 请求时，阻塞采集直到 session_id 就绪
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.get('sess_id') && !_fudanCachedSessionId && _fudanComposeChatSeen) {
      if (!_fudanWaitStart) _fudanWaitStart = Date.now();
      if (Date.now() - _fudanWaitStart < _FUDAN_SESSION_ID_TIMEOUT) {
        console.log('[Fudan/DOM] 流式新对话，等待 session_id 缓存... (%dms)',
          Date.now() - _fudanWaitStart);
        return true;
      }
      console.warn('[Fudan/DOM] 等待 session_id 超时(%dms)，降级为 default', _FUDAN_SESSION_ID_TIMEOUT);
    }

    return false;
  },

  // 从DOM提取消息
  extractMessages: () => {
    const messages = [];

    // 欢迎对话（URL 无 sess_id 且未发生流式对话）跳过不保存
    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.get('sess_id') && !_fudanComposeChatSeen && !_fudanCachedSessionId) {
      console.log('[Fudan/DOM] 欢迎对话，跳过采集');
      return messages;
    }

    const messageList = document.querySelector('.message_list');
    if (!messageList) {
      console.log('[Fudan/DOM] 未找到 .message_list 容器');
      return messages;
    }

    const items = messageList.querySelectorAll('.message_item');
    console.log(`[Fudan/DOM] 找到 ${items.length} 个消息项`);
    if (items.length === 0) {
      return messages;
    }

    for (const item of items) {
      const userText = item.querySelector('.text.myQuestion, .text.q');
      const assistantText = item.querySelector('.text.a');

      // 同一 .message_item 内可能同时含用户消息和助手消息，分别提取
      if (userText) {
        const content = DOM_ADAPTERS.fudan._extractUserContent(userText);
        if (content) {
          messages.push({ role: 'user', content, timestamp: new Date().toISOString() });
        }
      }
      if (assistantText) {
        const msg = DOM_ADAPTERS.fudan._extractAssistantMessage(assistantText);
        if (msg) messages.push(msg);
      }
    }

    console.log(`[Fudan/DOM] 共提取 ${messages.length} 条消息`);
    return messages;
  },

  // 提取用户消息内容
  _extractUserContent: (el) => {
    // 用户消息的 markdown 容器：.md-editor.question .md-editor-preview
    const preview = el.querySelector('.md-editor.question .md-editor-preview') ||
                    el.querySelector('.md-editor-preview');
    if (preview) {
      return DOM_ADAPTERS.fudan._extractMarkdownText(preview);
    }
    // 降级：从 .content 取文本
    const contentEl = el.querySelector('.content');
    if (contentEl) {
      const clone = contentEl.cloneNode(true);
      clone.querySelectorAll('.question_copy_icon, .iconfont, svg, button').forEach(n => n.remove());
      return (clone.innerText || clone.textContent || '').trim();
    }
    return (el.innerText || el.textContent || '').trim();
  },

  // 提取助手消息（包含思考、搜索来源、回答）
  // 拼接格式参照 network/common.js buildAssistantContent：
  //   <think>...</think>\n\n<search_result>...</search_result>\n\n回答
  _extractAssistantMessage: (textEl) => {
    let answer = '';
    let answerPreview = null;

    // 提取正式回答：.md-editor.answer .md-editor-preview
    answerPreview = textEl.querySelector('.md-editor.answer .md-editor-preview');
    if (answerPreview) {
      answer = DOM_ADAPTERS.fudan._extractMarkdownText(answerPreview);
    } else {
      // 备选：任意 .md-editor-preview（排除 question 类型和 think_box 内的）
      const previews = textEl.querySelectorAll('.md-editor-preview');
      for (const p of previews) {
        if (p.closest('.md-editor.question')) continue;
        if (p.closest('.think_box')) continue;
        const text = DOM_ADAPTERS.fudan._extractMarkdownText(p);
        if (text.trim()) {
          answer = answer ? answer + '\n\n' + text : text;
        }
      }
    }

    // 提取思考内容
    const thinking = DOM_ADAPTERS.fudan._extractThinking(textEl);

    // 提取搜索来源（需传入 answerPreview 用于 citation-link URL 映射）
    const search = DOM_ADAPTERS.fudan._extractSearchResults(textEl, answerPreview);

    // 最终兜底：从 .content 提取（移除 networking_card/think_box 等噪声）
    if (!answer && !thinking && !search) {
      const contentEl = textEl.querySelector('.content');
      if (contentEl) {
        const clone = contentEl.cloneNode(true);
        clone.querySelectorAll('.networking_card, .think_box, .headImgLeft, .headImgRight, .question_copy_icon, .iconfont, svg, button').forEach(n => n.remove());
        answer = (clone.innerText || clone.textContent || '').trim();
      }
    }

    if (!answer.trim() && !thinking && !search) return null;

    // 拼接：参照 network/common.js buildAssistantContent 格式
    let fullContent = '';
    if (thinking) fullContent += `<think>\n${thinking}\n</think>\n\n`;
    if (search) fullContent += `<search_result>\n${search}\n</search_result>\n\n`;
    if (answer) fullContent += answer;

    console.log('[Fudan/DOM] 助手消息: thinking=%d字, search=%d字, answer=%d字',
      thinking.length, search.length, answer.length);
    return {
      role: 'assistant',
      content: fullContent.trim(),
      timestamp: new Date().toISOString()
    };
  },

  // 提取深度思考内容
  // 思考内容在 .think_box .border_box 中（纯文本，无 markdown 渲染）
  // .think_title "deep thinking" 为标题噪声，需排除
  _extractThinking: (textEl) => {
    const borderBox = textEl.querySelector('.think_box .border_box');
    if (!borderBox) return '';
    // 移除标题噪声后取文本
    const clone = borderBox.cloneNode(true);
    clone.querySelectorAll('.think_title, .iconfont, svg').forEach(n => n.remove());
    const text = (clone.innerText || clone.textContent || '').trim();
    console.log('[Fudan/DOM] _extractThinking: %d字', text.length);
    return text;
  },

  // 提取搜索来源
  // .networking_card .link_box (display:none) 含 .link_item "N、标题"（仅标题，无 URL）
  // 回答里的 a.citation-link 文本为编号、href 为 URL，按编号映射补全 URL
  // 格式参照 network/fudan.js siteSearch 分支：【标题】\nURL（DOM 不渲染 snippet）
  _extractSearchResults: (textEl, answerEl) => {
    const linkBox = textEl.querySelector('.networking_card .link_box');
    if (!linkBox) return '';
    const linkItems = linkBox.querySelectorAll('.link_item');
    if (linkItems.length === 0) return '';

    // 建立 编号→URL 映射（从回答里的 a.citation-link 收集）
    const urlMap = new Map();
    if (answerEl) {
      const citations = answerEl.querySelectorAll('a.citation-link[href]');
      for (const cite of citations) {
        const num = (cite.textContent || '').trim();
        const url = cite.getAttribute('href') || '';
        if (num && url && !urlMap.has(num)) {
          urlMap.set(num, url);
        }
      }
    }

    const parts = [];
    linkItems.forEach((item, idx) => {
      const raw = (item.textContent || '').trim();
      if (!raw) return;
      // 提取编号和标题（格式 "N、标题" 或 "N. 标题"）
      const m = raw.match(/^(\d+)\s*[、.]\s*(.+)$/);
      const num = m ? m[1] : String(idx + 1);
      const title = m ? m[2].trim() : raw;
      const url = urlMap.get(num) || '';
      parts.push(url ? `【${title}】\n${url}` : `【${title}】`);
    });
    const result = parts.join('\n\n');
    console.log('[Fudan/DOM] _extractSearchResults: %d 条来源, %d 条有URL', parts.length, urlMap.size);
    return result;
  },

  // 从 .md-editor-preview 元素提取 Markdown 文本
  // 使用 turndown.js 将渲染后的 HTML 转为 Markdown，保留标题/列表/粗体/表格等格式
  // 降级：若 turndown 未加载，回退到 innerText
  _extractMarkdownText: (previewEl) => {
    if (!previewEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(previewEl);
      console.log('[Fudan/DOM] _extractMarkdownText (turndown): 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级：innerText
    console.warn('[Fudan/DOM] HtmlToMarkdown 未加载，降级为 innerText');
    const clone = previewEl.cloneNode(true);
    clone.querySelectorAll('style, svg, .iconfont, button').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }
};

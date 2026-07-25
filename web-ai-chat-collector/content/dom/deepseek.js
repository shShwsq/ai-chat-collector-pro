// dom/deepseek.js - DeepSeek DOM提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//
// DOM 结构（基于实际抓包确认）:
//   .ds-virtual-list-visible-items
//     [data-virtual-list-item-key] > .ds-message           消息容器
//       用户消息:
//         .fbb737a4                                            纯文本内容
//       助手消息（完整）:
//         ._74c0879                                            思考区域（可折叠）
//           ._5ab5d64                                          标题行（"已深度思考（用时 N 秒）"）
//           .ds-think-content > .ds-markdown                  思考内容片段（可能多个）
//           ._60aa7fb                                          搜索结果信息行（"搜索到 N 个网页" + 站点图标，无链接列表）
//           .e4c3fd02 > .f2021e64                              浏览页面列表（"浏览 N 个页面" + a._04ab7b1 链接）
//                                                              每条仅含标题+URL，无摘要（摘要仅网络 API 可见）
//         .ds-markdown.ds-assistant-message-main-content      正式回答
//           p.ds-markdown-paragraph                            段落
//           h3 / ul / li / strong / a                          标题/列表/粗体/引用链接
//           ._2ed5dee                                          引用图标噪声（html-to-markdown.js 中移除）
//           a > .ds-markdown-cite                              引用编号（转为 [N](url)）
//           .katex / .katex-display                            KaTeX 公式（html-to-markdown.js 转为 $...$ / $$...$$）
//       助手消息（被中断）:
//         ._74c0879._5ab5d64 标题行显示"已停止"
//         .ds-think-content > .ds-markdown                    仍有思考内容
//         无 .ds-assistant-message-main-content                无正式回答

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

DOM_ADAPTERS.deepseek = {
  name: 'deepseek',

  // 获取对话ID
  // DeepSeek URL 格式: /a/chat/s/{uuid} 或 /a/chat/{uuid}
  // 需跳过 s/ 前缀，与 exporter-base.js 的 getConvIdFromUrl 保持一致
  getConversationId: () => {
    const match = window.location.pathname.match(/\/chat\/(?:s\/)?([a-f0-9\-]+)/i);
    return match ? match[1] : 'default';
  },

  // 获取标题
  getTitle: () => {
    const el = document.querySelector('title, h1, [class*="chat-title"], [class*="conversation-title"]');
    if (el) {
      // document.title 格式为 "对话标题 - DeepSeek"，需去除后缀
      const text = el.textContent.trim();
      if (el.tagName === 'TITLE') {
        return text.replace(/\s*[-–—]\s*DeepSeek\s*$/i, '').trim() || text;
      }
      return text;
    }
    return '';
  },

  // 检测流式输出是否进行中
  // 信号：输入框右下角的 primary circle 按钮在流式时变为「停止」按钮
  //   流式中：SVG path 以 "M2 " 开头（圆角矩形=停止图标），按钮激活（无 ds-button--disabled）
  //   完成态：SVG path 以 "M8" 开头（箭头=发送图标），按钮 disabled
  isStreaming: () => {
    const btn = document.querySelector('.ds-button--primary.ds-button--filled.ds-button--circle');
    if (!btn) return false;
    const path = btn.querySelector('svg path');
    if (!path) return false;
    const d = path.getAttribute('d') || '';
    // 停止图标 path 以 "M2 " 开头（圆角矩形），发送图标以 "M8" 开头（箭头）
    return d.startsWith('M2 ');
  },

  // 从DOM提取消息
  extractMessages: () => {
    const messages = [];

    const container = document.querySelector('.ds-virtual-list-visible-items');
    if (!container) {
      console.log('[DeepSeek/DOM] 未找到消息列表容器');
      return messages;
    }

    const msgElements = container.querySelectorAll('.ds-message');
    console.log(`[DeepSeek/DOM] 找到 ${msgElements.length} 个消息元素`);

    for (const el of msgElements) {
      const role = DOM_ADAPTERS.deepseek._getRole(el);
      const content = DOM_ADAPTERS.deepseek._extractText(el);

      if (content && content.trim()) {
        messages.push({
          role: role,
          content: content.trim(),
          timestamp: new Date().toISOString()
        });
      }
    }

    console.log(`[DeepSeek/DOM] 共提取 ${messages.length} 条消息`);
    return messages;
  },

  // 提取文本（用户消息直接取文本，助手消息分离思考、搜索来源与回答）
  // 处理三种情况：
  //   1. 完整助手消息：有思考 + 有搜索来源 + 有正式回答
  //   2. 被中断的助手消息：有思考/搜索但无正式回答（用户在思考阶段或回答中途停止）
  //   3. 用户消息：纯文本
  // 拼接格式参照 network/common.js buildAssistantContent：
  //   <think>...</think>\n\n<search_result>...</search_result>\n\n回答
  _extractText: (el) => {
    const mainContent = el.querySelector('.ds-assistant-message-main-content');
    const thinking = DOM_ADAPTERS.deepseek._extractThinking(el);
    const search = DOM_ADAPTERS.deepseek._extractSearchResults(el);

    if (mainContent || thinking || search) {
      // 助手消息（可能被中断）
      const answer = mainContent ? DOM_ADAPTERS.deepseek._extractMarkdownText(mainContent) : '';
      const isInterrupted = DOM_ADAPTERS.deepseek._isInterrupted(el);

      let fullText = '';
      if (thinking) {
        fullText = `<think>\n${thinking}\n</think>\n\n`;
      }
      if (search) {
        fullText += `<search_result>\n${search}\n</search_result>\n\n`;
      }
      if (answer) {
        fullText += answer;
      } else if (isInterrupted) {
        // 用户在思考阶段或回答中途停止，无正式回答
        fullText += '[已停止]';
      }
      console.log('[DeepSeek/DOM] 助手消息: thinking=%d字, search=%d字, answer=%d字, interrupted=%s',
        thinking.length, search.length, answer.length, isInterrupted);
      return fullText.trim();
    }

    // 用户消息：直接取文本（DeepSeek 用户消息为纯文本，无 markdown 渲染容器）
    const userEl = el.querySelector('.fbb737a4');
    if (userEl) {
      return userEl.textContent.trim();
    }
    return el.textContent.trim();
  },

  // 检测助手消息是否被中断（用户在思考或回答过程中点击停止）
  // 信号：思考区域标题行（._5ab5d64）显示「已停止」而非「已深度思考」
  _isInterrupted: (el) => {
    const titleEl = el.querySelector('._5ab5d64');
    if (!titleEl) return false;
    return titleEl.textContent.includes('已停止');
  },

  // 提取思考过程
  // 思考内容分散在多个 .ds-think-content > .ds-markdown 中，需遍历合并
  _extractThinking: (el) => {
    const thinkMarkdowns = el.querySelectorAll('.ds-think-content .ds-markdown');
    if (thinkMarkdowns.length === 0) return '';

    const parts = [];
    for (const md of thinkMarkdowns) {
      const text = DOM_ADAPTERS.deepseek._extractMarkdownText(md);
      if (text.trim()) {
        parts.push(text.trim());
      }
    }
    return parts.join('\n\n');
  },

  // 提取搜索来源（浏览的网页列表）
  // DeepSeek DOM 中搜索结果以两种形式呈现：
  //   1. ._60aa7fb 信息行：仅显示"搜索到 N 个网页"+ 站点图标（无实际链接列表）
  //   2. .f2021e64 浏览列表：显示"浏览 N 个页面"+ 实际访问的页面链接（标题+URL）
  // 实际可提取的搜索来源为 .f2021e64 内的 a._04ab7b1 链接（无摘要，仅有标题和URL）
  // 格式参照 network/deepseek.js TOOL_SEARCH 分支：【标题】\nURL
  // （DOM 模式无 snippet，网络模式的 site_name 可从 URL 域名推导但此处省略保持简洁）
  // 支持多次搜索：一个消息内可能有多个 .f2021e64 浏览段
  _extractSearchResults: (el) => {
    const browseSections = el.querySelectorAll('.f2021e64');
    if (browseSections.length === 0) return '';

    const allParts = [];
    for (const section of browseSections) {
      const links = section.querySelectorAll('a._04ab7b1');
      for (const link of links) {
        const title = (link.textContent || '').trim();
        const url = link.getAttribute('href') || '';
        if (title && url) {
          allParts.push(`【${title}】\n${url}`);
        }
      }
    }
    const result = allParts.join('\n\n');
    console.log('[DeepSeek/DOM] _extractSearchResults: %d 条来源', allParts.length);
    return result;
  },

  // 从 .ds-markdown 元素提取 Markdown 文本
  // 使用 turndown.js 将渲染后的 HTML 转为 Markdown，保留标题/列表/粗体等格式
  // 降级：若 turndown 未加载，回退到 textContent
  _extractMarkdownText: (markdownEl) => {
    if (!markdownEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(markdownEl);
      console.log('[DeepSeek/DOM] _extractMarkdownText (turndown): 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级：textContent
    console.warn('[DeepSeek/DOM] HtmlToMarkdown 未加载，降级为 textContent');
    const clone = markdownEl.cloneNode(true);
    clone.querySelectorAll('style, svg, .iconify').forEach(n => n.remove());
    return clone.textContent.trim();
  },

  // 获取角色
  // 助手消息特征：有正式回答(.ds-assistant-message-main-content)、思考区域(._74c0879)、或 .ds-markdown
  // 用户消息特征：仅有 .fbb737a4 纯文本容器
  _getRole: (el) => {
    if (el.querySelector('.ds-assistant-message-main-content, ._74c0879, .ds-markdown')) return 'assistant';
    return 'user';
  }
};

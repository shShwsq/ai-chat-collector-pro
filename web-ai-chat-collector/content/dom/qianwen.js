// dom/qianwen.js - 千问 DOM提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//
// DOM 结构（基于实际抓包确认）:
//   #message-list-scroller
//     .chat-round                                          对话轮次
//       .chat-question-card-wrap                           用户消息
//       .chat-answers-card-wrap                            助手消息
//         .message-card-j_n6rq                             消息卡片
//           [data-card_name="bar_workflow"]                思考+搜索容器（可折叠）
//             .text-caption                                标题行（"已完成思考，参考了N篇材料"）
//             .thinking-content-tIwPU3                     单个思考步骤
//               .markdown-pc-special-class > .qk-markdown  思考内容 markdown
//             .truncate                                    搜索查询词（每步可含多个）
//             .reference-wrap-iEjeb3                       搜索结果引用链接
//           .answer-common-card                            正式回答卡片
//             .markdown-pc-special-class > .qk-markdown    正式回答 markdown
//               .qk-md-paragraph                            段落
//               .qk-md-katext > .katex                      KaTeX 公式（保留标准 <annotation>）
//
// 注意：千问不使用 data-card_name="deep_think"（旧适配器注释有误），实际为 bar_workflow。

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

DOM_ADAPTERS.qianwen = {
  name: 'qianwen',

  // 获取对话ID
  getConversationId: () => {
    const match = window.location.pathname.match(/\/chat\/(.+)/);
    if (match) return match[1];
    return 'default';
  },

  // 获取标题
  getTitle: () => {
    const activeItems = document.querySelectorAll('[class*="!bg-option"]');
    for (const item of activeItems) {
      const titleEl = item.querySelector('.text-ellipsis.whitespace-nowrap.overflow-hidden');
      if (titleEl && titleEl.textContent.trim()) {
        return titleEl.textContent.trim();
      }
    }
    const el = document.querySelector('title');
    if (el) {
      return el.textContent.replace(' - 千问', '').replace(' - 阿里AI助手', '').trim();
    }
    return '';
  },

  // 检测流式输出是否进行中
  // 信号：发送按钮 aria-label 在流式时变为"停止回答"（完成态为"发送消息"）
  isStreaming: () => {
    const stopBtn = document.querySelector('[aria-label="停止回答"]');
    if (stopBtn) return true;
    return false;
  },

  // 从DOM提取消息
  extractMessages: () => {
    const messages = [];

    const messageList = document.querySelector('#message-list-scroller');
    if (!messageList) {
      console.log('[Qianwen/DOM] 未找到消息列表容器');
      return messages;
    }

    // 查找所有对话轮次
    const chatRounds = messageList.querySelectorAll('.chat-round');
    console.log(`[Qianwen/DOM] 找到 ${chatRounds.length} 个对话轮次`);

    if (chatRounds.length === 0) {
      // 备选：直接查找消息卡片
      const questionCards = messageList.querySelectorAll('.chat-question-card-wrap');
      const answerCards = messageList.querySelectorAll('.chat-answers-card-wrap');
      console.log(`[Qianwen/DOM] 备选模式: ${questionCards.length} 个问题, ${answerCards.length} 个回答`);

      questionCards.forEach(card => {
        const text = DOM_ADAPTERS.qianwen._extractUserMessage(card);
        if (text) {
          messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
        }
      });

      answerCards.forEach(card => {
        const msg = DOM_ADAPTERS.qianwen._extractAssistantMessage(card);
        if (msg) messages.push(msg);
      });

      return messages;
    }

    // 按轮次提取
    for (const round of chatRounds) {
      const questionCard = round.querySelector('.chat-question-card-wrap');
      if (questionCard) {
        const text = DOM_ADAPTERS.qianwen._extractUserMessage(questionCard);
        if (text) {
          messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
        }
      }

      const answerCard = round.querySelector('.chat-answers-card-wrap');
      if (answerCard) {
        const msg = DOM_ADAPTERS.qianwen._extractAssistantMessage(answerCard);
        if (msg) messages.push(msg);
      }
    }

    console.log(`[Qianwen/DOM] 共提取 ${messages.length} 条消息`);
    return messages;
  },

  // 提取用户消息
  // 千问用户消息可能无 markdown 渲染容器，文本直接在容器中
  _extractUserMessage: (el) => {
    // 尝试找 markdown 容器
    const markdown = el.querySelector('.qk-markdown, .markdown-pc-special-class');
    if (markdown) {
      return DOM_ADAPTERS.qianwen._extractMarkdownText(markdown);
    }
    // 降级：从容器取文本，移除底部操作区
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.qs-bottom, [class*="bottom"], [class*="action"], [class*="toolbar"], button, svg').forEach(n => n.remove());
    const text = clone.innerText || clone.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
  },

  // 提取助手消息（包含思考、搜索、回答）
  // 结构：bar_workflow 容器内含多个思考步骤（thinking-content），每步可能有搜索查询词和搜索结果
  _extractAssistantMessage: (el) => {
    let thinking = '';
    let answer = '';

    // 1. 提取深度思考内容（bar_workflow 容器）
    //    旧版千问用 data-card_name="deep_think"，新版改为 bar_workflow
    const workflowCard = el.querySelector('[data-card_name="bar_workflow"], [data-card_name="deep_think"]');
    if (workflowCard) {
      thinking = DOM_ADAPTERS.qianwen._extractThinking(workflowCard);
    }

    // 2. 提取正式回答（answer-common-card 内的 qk-markdown，排除 bar_workflow 内的）
    const answerCard = el.querySelector('.answer-common-card');
    if (answerCard) {
      const answerMarkdown = answerCard.querySelector('.qk-markdown');
      if (answerMarkdown) {
        answer = DOM_ADAPTERS.qianwen._extractMarkdownText(answerMarkdown);
      }
    }

    // 备选：遍历所有 qk-markdown，排除 bar_workflow 内的、视频卡片内的、推荐问题内的
    if (!answer) {
      const allMarkdowns = el.querySelectorAll('.qk-markdown');
      const answerParts = [];
      for (const markdown of allMarkdowns) {
        if (workflowCard && workflowCard.contains(markdown)) continue;
        if (markdown.closest('[data-tpl*="card_video"], .recommend-query-wrap, .reference-wrap-iEjeb3')) continue;
        const text = DOM_ADAPTERS.qianwen._extractMarkdownText(markdown);
        if (text.trim()) answerParts.push(text.trim());
      }
      answer = answerParts.join('\n\n');
    }

    // 最终兜底
    if (!answer && !thinking) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[class*="bottom"], [class*="action"], [class*="toolbar"], button, svg').forEach(n => n.remove());
      answer = (clone.innerText || clone.textContent || '').trim();
    }

    // 构建完整内容
    let fullContent = '';
    if (thinking) {
      fullContent += `<think>\n${thinking}\n</think>\n\n`;
    }
    if (answer) {
      fullContent += answer;
    }

    if (!fullContent.trim()) return null;

    console.log('[Qianwen/DOM] 助手消息: thinking=%d字, answer=%d字', thinking.length, answer.length);
    return {
      role: 'assistant',
      content: fullContent.trim(),
      timestamp: new Date().toISOString()
    };
  },

  // 从 bar_workflow 容器提取思考内容
  // 结构：每个思考步骤是一组兄弟元素
  //   .flex.flex-col.gap-0.5                          步骤容器（标题 + thinking-content）
  //     .text-sm.font-semibold                         步骤标题（如"调用搜索查询天气"）
  //     .thinking-content-tIwPU3 > .qk-markdown        思考内容 markdown
  //   .flex.flex-col.gap-1.5                           搜索词容器（步骤容器的下一个兄弟）
  //     .truncate                                      搜索查询词（可能多个）
  // 输出格式：每步思考内容用空行分隔，搜索词以【搜索】标记
  _extractThinking: (workflowEl) => {
    const parts = [];

    // 提取所有思考步骤
    const thinkSteps = workflowEl.querySelectorAll('.thinking-content-tIwPU3, [class*="thinking-content"]');
    for (const step of thinkSteps) {
      // 思考步骤的标题行（在 thinking-content 的父元素内的 .text-sm.font-semibold）
      const stepContainer = step.parentElement;
      let stepTitle = '';
      if (stepContainer) {
        const titleEl = stepContainer.querySelector('.text-sm.font-semibold');
        if (titleEl) {
          stepTitle = titleEl.textContent.trim();
        }
      }

      // 提取该步骤关联的搜索查询词
      // 搜索词在 stepContainer 的下一个兄弟元素（.flex.flex-col.gap-1.5）中
      let searchTerms = [];
      if (stepContainer && stepContainer.nextElementSibling) {
        searchTerms = DOM_ADAPTERS.qianwen._extractSearchTerms(stepContainer.nextElementSibling);
      }

      // 提取思考内容 markdown
      const markdown = step.querySelector('.qk-markdown');
      let stepContent = '';
      if (markdown) {
        stepContent = DOM_ADAPTERS.qianwen._extractMarkdownText(markdown);
      }

      // 组装该步骤内容
      let stepText = '';
      if (stepTitle) {
        stepText += `### ${stepTitle}\n\n`;
      }
      if (searchTerms.length > 0) {
        stepText += `【搜索】${searchTerms.join('、')}\n\n`;
      }
      if (stepContent) {
        stepText += stepContent;
      }
      if (stepText.trim()) {
        parts.push(stepText.trim());
      }
    }

    // 如果没有找到思考步骤，降级：直接取所有 qk-markdown
    if (parts.length === 0) {
      const allMarkdowns = workflowEl.querySelectorAll('.qk-markdown');
      for (const markdown of allMarkdowns) {
        const text = DOM_ADAPTERS.qianwen._extractMarkdownText(markdown);
        if (text.trim()) parts.push(text.trim());
      }
    }

    return parts.join('\n\n');
  },

  // 提取搜索查询词（.truncate span 文本）
  // 千问的搜索词 chip 在 .invisible.absolute 容器内（预览态），与网页标题混在一起
  // 区分特征：搜索查询词短（< 15 字）且不含标点（_ - , 【】等），网页标题长且含标点
  _extractSearchTerms: (container) => {
    const terms = [];
    const seen = new Set();
    if (!container) return terms;
    // 优先从 .invisible.absolute 容器提取（搜索词 chip 和网页标题都在此处）
    const chipContainers = container.querySelectorAll('.invisible.absolute, [class*="invisible"][class*="absolute"]');
    const searchContainers = chipContainers.length > 0 ? chipContainers : [container];
    for (const searchContainer of searchContainers) {
      const truncateEls = searchContainer.querySelectorAll('.truncate');
      for (const el of truncateEls) {
        const text = el.textContent.trim();
        // 过滤：空文本、URL、含标点的网页标题、过长的文本
        // 搜索查询词特征：< 15 字、无标点（_ - , . ， 。 【】 等）
        if (!text || text.startsWith('http')) continue;
        if (text.length >= 15) continue;
        if (/[_\-,.，。！？【】、；：]/.test(text)) continue;
        if (!seen.has(text)) {
          seen.add(text);
          terms.push(text);
        }
      }
    }
    return terms;
  },

  // 从 .qk-markdown 元素提取 Markdown 文本
  // 使用 turndown.js 将渲染后的 HTML 转为 Markdown，保留标题/列表/粗体等格式
  // 降级：若 turndown 未加载，回退到 innerText
  _extractMarkdownText: (markdownEl) => {
    if (!markdownEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(markdownEl);
      console.log('[Qianwen/DOM] _extractMarkdownText (turndown): 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级：innerText
    console.warn('[Qianwen/DOM] HtmlToMarkdown 未加载，降级为 innerText');
    const clone = markdownEl.cloneNode(true);
    clone.querySelectorAll('style, svg, .iconify, button').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }
};

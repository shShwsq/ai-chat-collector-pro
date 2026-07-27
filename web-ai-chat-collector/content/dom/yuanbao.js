// dom/yuanbao.js - 腾讯元宝 DOM 提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//
// DOM 结构（基于实际抓包确认）:
//   #chat-content.agent-dialogue__content--common__content
//     .agent-chat__list.agent-chat__list__hunyuan
//       .agent-chat__list__content-wrapper
//         .agent-chat__list__content                 消息列表
//           .agent-chat__list__item--human           用户消息
//             data-conv-speaker="human"
//             data-conv-status="finished|running"
//             data-conv-outputting="true|false"
//             .agent-chat__bubble--human
//               .hyc-component-text > .hyc-content-text   纯文本
//           .agent-chat__list__item--ai              助手消息
//             .agent-chat__bubble--ai
//               .agent-chat__conv--ai__speech_show
//                 形态A（深度搜索）: .hyc-component-deepsearch-cot
//                   .hyc-component-deepsearch-cot__think
//                     .hyc-component-deepsearch-cot__think__content
//                       .__item-text                  思考步骤（多个）
//                         .hyc-common-markdown-style-cot > .ybc-p
//                       .__item-search                搜索结果块
//                         .__doc-container > .__doc__title__text
//                       .__item-text.__item--last     最后一步思考
//                   .hyc-content-md-done（正式回答，在 deepsearch-cot 内但不在 __think 内）
//                     .hyc-common-markdown-style > .ybc-p / .ybc-ul-component / blockquote
//                 形态B（Agent模式）: .hyc-component-deep-search-agent
//                   .hyc-content-md-done（正式回答，与简单回答结构相同）
//                   .hyc-card-box-process-list.--hidden（Agent 操作过程卡片，折叠态，不提取）
//                 形态C（简单回答）: .hyc-content-md-done（无思考块、无 Agent 容器）
//
// 流式状态特征:
//   - data-conv-outputting="true" 或 data-conv-status="running" 表示正在生成
//   - .hyc-content-md（无 -done 后缀）表示该段还在生成
//   - <span data-gradient="true" style="opacity:0.x"> 渐变文字（流式输出标志）

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

// 助手消息内容拼接（与 network/common.js 中的 buildAssistantContent 一致）
// 元宝不加载 network/common.js，所以这里内联一份
function _buildYuanbaoAssistantContent(thinking, search, answer) {
  let fullContent = '';
  if (thinking) fullContent += `<think>\n${thinking.trim()}\n</think>\n\n`;
  if (search) fullContent += `<search_result>\n${search.trim()}\n</search_result>\n\n`;
  if (answer) fullContent += answer;
  return fullContent.trim();
}

DOM_ADAPTERS.yuanbao = {
  name: 'yuanbao',

  // 从 URL 提取对话 ID
  // URL 格式: https://yuanbao.tencent.com/chat/{agentId}/{convId}
  //   例如 https://yuanbao.tencent.com/chat/naQivTmsDa/0P71bwF3Gl6
  //   提取第二段（convId），忽略第一段（agentId）
  getConversationId: () => {
    const path = window.location.pathname;
    const match = path.match(/\/chat\/[^/]+\/([^/?#]+)/);
    const id = match ? match[1] : 'default';
    console.log('[Yuanbao/DOM] getConversationId: path=%s → %s', path, id);
    return id;
  },

  // 获取对话标题
  // 优先级 1：侧边栏当前激活对话项 .yb-recent-conv-list__item.active .yb-recent-conv-list__item-name
  //          （新对话刚发起时 document.title 可能未更新，但侧边栏 active 项已含标题）
  // 优先级 2：document.title（对话页直接是对话标题）
  // 排除首页默认标题"元宝 - 轻松工作 多点生活"
  getTitle: () => {
    // 1. 侧边栏 active 项
    const activeName = document.querySelector('.yb-recent-conv-list__item.active .yb-recent-conv-list__item-name');
    if (activeName) {
      const text = activeName.textContent.trim();
      if (text && !text.includes('元宝')) return text;
    }

    // 2. document.title
    const raw = document.title || '';
    if (raw.includes('元宝') && (raw.includes('轻松工作') || raw.includes('AI助手'))) {
      return '未命名对话';
    }
    return raw.trim() || '未命名对话';
  },

  // 检测流式输出是否进行中
  // 信号：最后一条消息的 data-conv-outputting="true" 或 data-conv-status="running"
  // 兜底：存在 .hyc-content-md（无 -done 后缀，表示该段还在生成）
  isStreaming: () => {
    const items = document.querySelectorAll('.agent-chat__list__item');
    if (items.length === 0) return false;
    const lastItem = items[items.length - 1];
    const outputting = lastItem.getAttribute('data-conv-outputting');
    const status = lastItem.getAttribute('data-conv-status');
    if (outputting === 'true' || status === 'running') return true;
    // 兜底：检查是否有未完成的 markdown 段（.hyc-content-md 但无 -done）
    const unfinishedMd = lastItem.querySelector('.hyc-content-md:not(.hyc-content-md-done)');
    if (unfinishedMd) return true;
    return false;
  },

  // 从 DOM 提取消息
  extractMessages: () => {
    const messages = [];

    const container = document.querySelector('.agent-chat__list__content');
    if (!container) {
      console.log('[Yuanbao/DOM] 未找到 .agent-chat__list__content');
      return messages;
    }

    const msgElements = container.querySelectorAll(':scope > .agent-chat__list__item');
    console.log('[Yuanbao/DOM] 找到 %d 个 .agent-chat__list__item', msgElements.length);

    for (const el of msgElements) {
      const speaker = el.getAttribute('data-conv-speaker');
      const isUser = speaker === 'human' || el.classList.contains('agent-chat__list__item--human');
      const isAssistant = speaker === 'ai' || el.classList.contains('agent-chat__list__item--ai');
      if (!isUser && !isAssistant) {
        console.log('[Yuanbao/DOM] 跳过非消息项: speaker=%s, class=%s', speaker, el.className);
        continue;
      }

      const role = isUser ? 'user' : 'assistant';
      const content = isUser
        ? DOM_ADAPTERS.yuanbao._extractUserContent(el)
        : DOM_ADAPTERS.yuanbao._extractAssistantContent(el);

      console.log('[Yuanbao/DOM] %s 消息: 内容长度=%d, 预览=%s',
        role, (content || '').length, (content || '').substring(0, 100));

      if (content && content.trim()) {
        messages.push({
          role: role,
          content: content.trim(),
          timestamp: new Date().toISOString()
        });
      } else {
        console.log('[Yuanbao/DOM] ⚠️ 内容为空');
      }
    }

    console.log('[Yuanbao/DOM] 共提取 %d 条消息', messages.length);
    return messages;
  },

  // 提取用户消息内容
  // 结构: .agent-chat__bubble--human .hyc-component-text > .hyc-content-text
  _extractUserContent: (el) => {
    const textEl = el.querySelector('.hyc-content-text');
    if (textEl) {
      const text = textEl.textContent.trim();
      console.log('[Yuanbao/DOM] _extractUserContent: 从 .hyc-content-text 提取, 长度=%d', text.length);
      return text;
    }
    // 兜底: 从 bubble content 取文本，移除工具栏
    const bubble = el.querySelector('.agent-chat__bubble__content');
    if (bubble) {
      const clone = bubble.cloneNode(true);
      clone.querySelectorAll('[class*="toolbar"], [class*="action"], button, svg').forEach(n => n.remove());
      const text = (clone.innerText || clone.textContent || '').trim();
      console.log('[Yuanbao/DOM] _extractUserContent fallback: 长度=%d', text.length);
      return text;
    }
    return '';
  },

  // 提取助手消息内容（按形态分发）
  // 形态A: 深度搜索模式（有 .hyc-component-deepsearch-cot）→ 思考 + 搜索 + 回答
  // 形态B: Agent 模式（有 .hyc-component-deep-search-agent，无 deepsearch-cot）→ 直接提取 .hyc-content-md-done
  // 形态C: 简单回答（无上述容器）→ 直接提取 .hyc-content-md-done
  // 注：形态B与C的提取逻辑相同，差异仅在容器包裹层；Agent 操作过程卡片（.hyc-card-box-process-list）不提取
  _extractAssistantContent: (el) => {
    const deepSearchCot = el.querySelector('.hyc-component-deepsearch-cot');

    if (deepSearchCot) {
      console.log('[Yuanbao/DOM] 形态A: 深度搜索模式');
      return DOM_ADAPTERS.yuanbao._extractDeepSearchMode(el, deepSearchCot);
    }

    const deepSearchAgent = el.querySelector('.hyc-component-deep-search-agent');
    if (deepSearchAgent) {
      console.log('[Yuanbao/DOM] 形态B: Agent 模式');
    } else {
      console.log('[Yuanbao/DOM] 形态C: 简单回答模式');
    }
    return DOM_ADAPTERS.yuanbao._extractSimpleAnswer(el);
  },

  // 形态A: 深度搜索模式提取
  // 思考块内的 __item-text 为思考步骤，__item-search 为搜索结果
  // 正式回答为思考块之后的 .hyc-content-md-done
  _extractDeepSearchMode: (el, cotEl) => {
    let thinking = '';
    let search = '';
    let answer = '';

    // 1. 提取思考内容
    const thinkContent = cotEl.querySelector('.hyc-component-deepsearch-cot__think__content');
    if (thinkContent) {
      const result = DOM_ADAPTERS.yuanbao._extractThinkingAndSearch(thinkContent);
      thinking = result.thinking;
      search = result.search;
    }

    // 2. 提取正式回答
    // 正式回答 .hyc-content-md-done 位于 .hyc-component-deepsearch-cot 内部（但在 __think 外部），
    // 思考步骤的 .hyc-content-md-done 位于 __think 内部。
    // 选取所有 .hyc-content-md-done，排除位于 __think 内的（即思考步骤），保留正式回答。
    const speechShow = el.querySelector('.agent-chat__conv--ai__speech_show');
    if (speechShow) {
      const allMdDones = speechShow.querySelectorAll('.hyc-content-md-done');
      const answerParts = [];
      for (const md of allMdDones) {
        // 跳过位于思考步骤内的（思考步骤的 markdown 也有 -done 后缀，但在 __think 内）
        if (md.closest('.hyc-component-deepsearch-cot__think')) continue;
        const text = DOM_ADAPTERS.yuanbao._extractMarkdownText(md);
        if (text.trim()) answerParts.push(text.trim());
      }
      answer = answerParts.join('\n\n');
    }

    // 兜底: 若无正式回答，取整个 speech_show 内非思考块的文本
    if (!answer && speechShow) {
      const clone = speechShow.cloneNode(true);
      clone.querySelectorAll('.hyc-component-deepsearch-cot, .hyc-component-deep-search-agent, [class*="toolbar"], [class*="action"], button, svg').forEach(n => n.remove());
      answer = (clone.innerText || clone.textContent || '').trim();
    }

    console.log('[Yuanbao/DOM] 深度搜索: thinking=%d字, search=%d字, answer=%d字',
      thinking.length, search.length, answer.length);

    return _buildYuanbaoAssistantContent(thinking, search, answer);
  },

  // 从思考内容容器提取思考步骤和搜索结果
  // 遍历 __item-text 和 __item-search，分别提取
  _extractThinkingAndSearch: (thinkContentEl) => {
    const thinkingParts = [];
    const searchParts = [];
    let searchIdx = 1;

    const items = thinkContentEl.querySelectorAll(':scope > .hyc-component-deepsearch-cot__think__content__item');
    console.log('[Yuanbao/DOM] 思考块共 %d 个 item', items.length);

    for (const item of items) {
      const isText = item.classList.contains('hyc-component-deepsearch-cot__think__content__item-text');
      const isSearch = item.classList.contains('hyc-component-deepsearch-cot__think__content__item-search');

      if (isText) {
        const markdown = item.querySelector('.hyc-common-markdown, .hyc-common-markdown-style-cot');
        if (markdown) {
          const text = DOM_ADAPTERS.yuanbao._extractMarkdownText(markdown);
          if (text.trim()) thinkingParts.push(text.trim());
        }
      } else if (isSearch) {
        // 提取搜索结果文档标题
        const docTitles = item.querySelectorAll('.hyc-component-deepsearch-cot__think__content__item__doc__title__text');
        for (const titleEl of docTitles) {
          const title = titleEl.textContent.trim();
          if (title) {
            searchParts.push(`${searchIdx}. ${title}`);
            searchIdx++;
          }
        }
      }
    }

    return {
      thinking: thinkingParts.join('\n\n'),
      search: searchParts.join('\n')
    };
  },

  // 形态B/C: 简单回答模式提取（Agent 模式与简单回答共用）
  // 直接取 .hyc-content-md-done 转 markdown
  _extractSimpleAnswer: (el) => {
    const mdDone = el.querySelector('.hyc-content-md-done');
    if (mdDone) {
      return DOM_ADAPTERS.yuanbao._extractMarkdownText(mdDone);
    }
    // 兜底: 取 bubble content 文本
    const bubble = el.querySelector('.agent-chat__bubble__content');
    if (bubble) {
      const clone = bubble.cloneNode(true);
      clone.querySelectorAll('[class*="toolbar"], [class*="action"], button, svg').forEach(n => n.remove());
      return (clone.innerText || clone.textContent || '').trim();
    }
    return '';
  },

  // 从 markdown 容器提取 Markdown 文本
  // 使用 HtmlToMarkdown.convert 统一转换
  _extractMarkdownText: (markdownEl) => {
    if (!markdownEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(markdownEl);
      console.log('[Yuanbao/DOM] _extractMarkdownText: 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级: textContent
    console.warn('[Yuanbao/DOM] HtmlToMarkdown 未加载，降级为 textContent');
    const clone = markdownEl.cloneNode(true);
    clone.querySelectorAll('style, svg, .iconify, button').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }
};

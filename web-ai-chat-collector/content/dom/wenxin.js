// dom/wenxin.js - 百度文心（chat.baidu.com / wenxin.baidu.com）DOM 提取适配器
// 依赖：adapter-registry.js（DOM_ADAPTERS）、html-to-markdown.js（window.HtmlToMarkdown）
//
// DOM 结构（基于实际抓包确认，2026-07-28）:
//   #conversation-flow-content.conversation-flow-content     对话流根容器
//     .chat-qa-container[data-qa-pair-id][data-chat-status]  单个 QA 对
//       data-chat-status="COMPLETE|GENERATING"               完成态 / 生成中
//       data-session-id="对话ID"
//       ._question-wrapper_u2k25_47
//         .conversation-flow-question-container
//           .cs-question-bubble[data-query="问题文本"]       用户问题（data-query 含原文）
//             .cs-question-pure-text > ._question-line-break_y4jra_5  显示文本（兜底）
//       .conversation-flow-answer-container
//         .answer-box > .chat-search-answer-generate > .cs-answer-container > .answer-container
//           .ai-entry
//             .ai-entry-block.ai-thinking-steps              思考步骤（可选，深度思考模式才有）
//               ._thinking-steps_1eyeq_1
//                 ._collapse-container_er9xf_1
//                   header.root-header                       标题"深度思考完成"
//                   main
//                     ._collapse-container_er9xf_1._step_1eyeq_24   单个思考步骤
//                       main > ._markdown-content_53we2_1
//                         .cosd-markdown > .cosd-markdown-content > .marklang
//                           p.marklang-paragraph             思考文本
//                       （部分步骤仅有 ._title_1eyeq_45 标题如"信息整理完成"，无 markdown，跳过）
//             .ai-entry-block.ai-markdown                    正式回答
//               .cosd-markdown > .cosd-markdown-content > .marklang
//                 p.marklang-paragraph / table / ul / span.katex-display 等
//             .ai-entry-block.ai-image-scroll                图片轮播（不提取）
//
// 流式状态特征:
//   - .chat-qa-container[data-chat-status] != "COMPLETE" 表示正在生成
//   - 兜底：存在 ._markdown-content_53we2_1 但无 _typing-finished_53we2_41（生成中的 markdown 段）
//
// KaTeX 公式：保留标准 <annotation encoding="application/x-tex">，html-to-markdown.js 直接提取源码
//
// 标题提取:
//   优先级 1：侧边栏 .chat-side-list-item.selected .history-item-text
//            （selected 项的 data-show-ext 含 ori_lid 对应当前对话 convId）
//   优先级 2：document.title（排除默认标题"百度文心助手 - 办公学习一站解决"）
//   兜底："未命名对话"

if (typeof DOM_ADAPTERS === 'undefined') window.DOM_ADAPTERS = {};

// 助手消息内容拼接（与 network/common.js 中的 buildAssistantContent 一致）
// 文心不加载 network/common.js，所以这里内联一份
function _buildWenxinAssistantContent(thinking, answer) {
  let fullContent = '';
  if (thinking) fullContent += `<think>\n${thinking.trim()}\n</think>\n\n`;
  if (answer) fullContent += answer;
  return fullContent.trim();
}

DOM_ADAPTERS.wenxin = {
  name: 'wenxin',

  // 从 URL 提取对话 ID
  // URL 格式: https://wenxin.baidu.com/search/{convId}?enter_type=...
  //           https://chat.baidu.com/search/{convId}?enter_type=...
  getConversationId: () => {
    const path = window.location.pathname;
    const match = path.match(/\/search\/([^/?#]+)/);
    const id = match ? match[1] : 'default';
    console.log('[Wenxin/DOM] getConversationId: path=%s → %s', path, id);
    return id;
  },

  // 获取对话标题
  // 优先级 1：侧边栏 .chat-side-list-item.selected .history-item-text
  //          （新对话发起时侧边栏 selected 项已含标题，document.title 始终是默认值）
  // 优先级 2：document.title（排除首页默认标题"百度文心助手 - 办公学习一站解决"）
  // 兜底："未命名对话"
  getTitle: () => {
    // 1. 侧边栏 selected 项
    const selectedText = document.querySelector('.chat-side-list-item.selected .history-item-text');
    if (selectedText) {
      const text = (selectedText.textContent || '').trim();
      if (text) return text;
    }

    // 2. document.title（排除默认标题）
    const raw = (document.title || '').trim();
    if (raw && !raw.includes('百度文心助手')) {
      return raw;
    }

    // 3. 兜底
    return '未命名对话';
  },

  // 检测流式输出是否进行中
  // 注意：.chat-qa-container[data-chat-status] 在流式态也是 "COMPLETE"，不可靠；
  //       _typing-finished_ 在流式态也存在，不可靠。
  // 可靠信号（基于 wenxin_stream.txt 与 wenxin.txt 对比确认）：
  //   1. .cs-answer-container[data-status="GENERATING"]  回答容器生成中
  //   2. .cosd-markdown-loading                          markdown 内的加载占位
  //   3. [class*="_answer-generating_"]                  回答菜单的生成中类
  isStreaming: () => {
    // 1. 回答容器状态（最可靠，GENERATING 表示正在生成）
    const answerContainers = document.querySelectorAll('.cs-answer-container');
    if (answerContainers.length > 0) {
      const lastAnswer = answerContainers[answerContainers.length - 1];
      const status = lastAnswer.getAttribute('data-status');
      if (status === 'GENERATING') return true;
    }

    // 2. markdown 加载占位（流式中 markdown 末尾的加载指示器）
    if (document.querySelector('.cosd-markdown-loading')) return true;

    // 3. 回答菜单生成中类
    if (document.querySelector('[class*="_answer-generating_"]')) return true;

    return false;
  },

  // 从 DOM 提取消息
  // 每个问题-回答对包含两段内容：
  //   - .conversation-flow-question-container 用户问题
  //   - .conversation-flow-answer-container 助手回答（含思考步骤 + 正式回答）
  extractMessages: () => {
    const messages = [];

    const container = document.querySelector('#conversation-flow-content, .conversation-flow-content');
    if (!container) {
      console.log('[Wenxin/DOM] 未找到 #conversation-flow-content');
      return messages;
    }

    const qaPairs = container.querySelectorAll(':scope > .chat-qa-container');
    console.log('[Wenxin/DOM] 找到 %d 个 .chat-qa-container', qaPairs.length);

    for (const qa of qaPairs) {
      // 提取用户问题
      const userContent = DOM_ADAPTERS.wenxin._extractUserContent(qa);
      if (userContent) {
        messages.push({
          role: 'user',
          content: userContent,
          timestamp: new Date().toISOString()
        });
      }

      // 提取助手回答
      const assistantContent = DOM_ADAPTERS.wenxin._extractAssistantContent(qa);
      if (assistantContent) {
        messages.push({
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString()
        });
      }
    }

    console.log('[Wenxin/DOM] 共提取 %d 条消息', messages.length);
    return messages;
  },

  // 提取用户问题内容
  // 优先级 1：.cs-question-bubble[data-query] 属性（最可靠，含原始问题文本）
  // 优先级 2：.cs-question-pure-text 文本（显示文本，可能含换行处理）
  _extractUserContent: (qaEl) => {
    // 1. data-query 属性
    const bubble = qaEl.querySelector('.cs-question-bubble[data-query]');
    if (bubble) {
      const query = (bubble.getAttribute('data-query') || '').trim();
      if (query) {
        console.log('[Wenxin/DOM] _extractUserContent: 从 data-query 提取, 长度=%d', query.length);
        return query;
      }
    }

    // 2. 显示文本兜底
    const pureText = qaEl.querySelector('.cs-question-pure-text');
    if (pureText) {
      const text = (pureText.textContent || '').trim();
      if (text) {
        console.log('[Wenxin/DOM] _extractUserContent: 从 .cs-question-pure-text 提取, 长度=%d', text.length);
        return text;
      }
    }

    console.log('[Wenxin/DOM] _extractUserContent: 未找到问题内容');
    return '';
  },

  // 提取助手回答内容
  // 结构：.conversation-flow-answer-container 内 .ai-entry 含多个 .ai-entry-block
  //   - .ai-entry-block.ai-thinking-steps  思考步骤（可选）→ <think> 块
  //   - .ai-entry-block.ai-markdown        正式回答 → 正文
  //   - .ai-entry-block.ai-image-scroll    图片轮播 → 跳过
  //   - 其他 ai-entry-block（如 ai-search）→ 跳过
  _extractAssistantContent: (qaEl) => {
    const answerContainer = qaEl.querySelector('.conversation-flow-answer-container');
    if (!answerContainer) {
      console.log('[Wenxin/DOM] _extractAssistantContent: 未找到 .conversation-flow-answer-container');
      return '';
    }

    let thinking = '';
    let answer = '';

    // 1. 提取思考内容
    const thinkingBlock = answerContainer.querySelector('.ai-entry-block.ai-thinking-steps');
    if (thinkingBlock) {
      thinking = DOM_ADAPTERS.wenxin._extractThinking(thinkingBlock);
      console.log('[Wenxin/DOM] 思考内容长度=%d', thinking.length);
    }

    // 2. 提取正式回答
    // 注意：文心会把长回答拆成多个 .ai-entry-block.ai-markdown，中间夹 .ai-entry-block.ai-image-scroll
    //       必须用 querySelectorAll 收集所有 markdown 块并拼接，否则只拿到第一段
    const markdownBlocks = answerContainer.querySelectorAll('.ai-entry-block.ai-markdown');
    if (markdownBlocks.length > 0) {
      const parts = [];
      for (const block of markdownBlocks) {
        const text = DOM_ADAPTERS.wenxin._extractMarkdownText(block);
        if (text.trim()) parts.push(text.trim());
      }
      answer = parts.join('\n\n');
      console.log('[Wenxin/DOM] 正式回答: %d 个 markdown 块, 总长度=%d', markdownBlocks.length, answer.length);
    } else {
      console.log('[Wenxin/DOM] 未找到 .ai-entry-block.ai-markdown');
    }

    // 兜底：若无正式回答但有思考，则仅返回思考；若都没有，返回空
    if (!thinking && !answer) {
      console.log('[Wenxin/DOM] ⚠️ 思考与回答均为空');
      return '';
    }

    return _buildWenxinAssistantContent(thinking, answer);
  },

  // 从思考步骤块提取思考内容
  // .ai-thinking-steps 内有多个 ._step_1eyeq_24，每个含 ._markdown-content_ .cosd-markdown
  // 部分步骤仅有标题（如"信息整理完成"），无 markdown 内容，自动跳过
  // 提取所有 .cosd-markdown-content（避免 .cosd-markdown-mask 动画遮罩干扰）
  _extractThinking: (thinkingBlockEl) => {
    const parts = [];
    // 优先取 .cosd-markdown-content（不含 mask），兜底取 .cosd-markdown
    let mdContents = thinkingBlockEl.querySelectorAll('.cosd-markdown-content');
    if (mdContents.length === 0) {
      mdContents = thinkingBlockEl.querySelectorAll('.cosd-markdown');
    }
    console.log('[Wenxin/DOM] 思考块共 %d 个 markdown 段', mdContents.length);

    for (const md of mdContents) {
      const text = DOM_ADAPTERS.wenxin._extractMarkdownText(md);
      if (text.trim()) parts.push(text.trim());
    }

    return parts.join('\n\n');
  },

  // 从 markdown 容器提取 Markdown 文本
  // 使用 HtmlToMarkdown.convert 统一转换
  _extractMarkdownText: (markdownEl) => {
    if (!markdownEl) return '';

    if (typeof window.HtmlToMarkdown !== 'undefined' && window.HtmlToMarkdown.convert) {
      const md = window.HtmlToMarkdown.convert(markdownEl);
      console.log('[Wenxin/DOM] _extractMarkdownText: 长度=%d, 预览=%s', md.length, md.substring(0, 120));
      return md;
    }

    // 降级: textContent
    console.warn('[Wenxin/DOM] HtmlToMarkdown 未加载，降级为 textContent');
    const clone = markdownEl.cloneNode(true);
    clone.querySelectorAll('style, svg, .iconify, button, .cosd-markdown-mask').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }
};

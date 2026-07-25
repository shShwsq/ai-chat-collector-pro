// network/fudan.js - 复旦 AI Agent 网络拦截适配器
// 依赖：network/common.js

// 缓存对话标题：sessionId -> title
const _fudanSessionTitles = {};

NETWORK_ADAPTERS.fudan = {
  name: 'fudan',

  // 匹配API
  matchApi: (url) => {
    return url.includes('/site/voom/chat_history_info') ||
           url.includes('/site/ai/compose_chat') ||
           url.includes('/site/voom/session_info') ||
           url.includes('/site/voom/update_session_title');
  },

  // 解析API响应
  parse: (url, data, requestBody) => {
    // 对话标题 API（历史对话进入时触发）
    if (url.includes('/site/voom/session_info')) {
      if (data && data.e === 0 && data.d) {
        const sid = data.d.sess_id;
        const title = data.d.title || '';
        if (sid && title) {
          _fudanSessionTitles[sid] = title;
          console.log('[Fudan/Title] 缓存标题: %s -> %s', sid, title);
        }
      }
      return null;
    }

    // 对话标题更新 API（流式对话完成后触发）
    if (url.includes('/site/voom/update_session_title')) {
      if (data && data.e === 0 && data.d) {
        const sid = data.d.session_id;
        const title = data.d.title || '';
        if (sid && title) {
          _fudanSessionTitles[sid] = title;
          console.log('[Fudan/Title] 更新标题: %s -> %s', sid, title);
        }
      }
      return null;
    }

    // 流式对话 API
    if (url.includes('/site/ai/compose_chat') && typeof data === 'string') {
      return parseStream(url, data, requestBody);
    }

    // 历史消息 API
    if (url.includes('/site/voom/chat_history_info')) {
      if (!data || data.e !== 0 || !data.d) return null;
      return parseHistory(data);
    }

    return null;
  },

  // 主动请求指定对话数据
  async fetchConversation(convId) {
    const url = `/site/voom/chat_history_info?session_id=${convId}`;
    console.log('[Fudan/Debug] fetchConversation: convId=%s, url=%s', convId, url);
    fetchViaInterceptor(url);
    return null;
  }
};

// ===== 历史消息解析 =====

function parseHistory(data) {
  const messages = [];

  for (const item of data.d) {
    if (!item.content) continue;

    let contentObj;
    try {
      contentObj = JSON.parse(item.content);
    } catch (e) {
      continue;
    }

    const role = contentObj.card_role === 'q' ? 'user' : 'assistant';
    const text = contentObj.plugins?.[0]?.field_props?.data || '';

    if (!text) continue;

    if (role === 'user') {
      messages.push({
        role: 'user',
        content: text,
        timestamp: new Date((item.ct || 0) * 1000).toISOString()
      });
    } else {
      // 助手消息：提取思考内容和回答
      let thinking = '';
      let answer = text;

      // 处理 <think...</think 标签
      const thinkMatch = text.match(/<think\s*>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        thinking = thinkMatch[1].trim();
        answer = text.slice(thinkMatch.index + thinkMatch[0].length).trim();
      }

      // 提取搜索来源
      let search = '';
      if (contentObj.card_data?.siteSearch) {
        const sources = contentObj.card_data.siteSearch;
        if (Array.isArray(sources) && sources.length > 0) {
          search = sources.map(s => {
            const title = s.title || '';
            const url = s.url || '';
            const content = s.content || '';
            return `【${title}】\n${url}\n${content}`;
          }).join('\n\n');
        }
      }

      const fullContent = buildAssistantContent(thinking, search, answer);

      if (fullContent) {
        messages.push({
          role: 'assistant',
          content: fullContent,
          timestamp: new Date((item.ct || 0) * 1000).toISOString()
        });
      }
    }
  }

  if (messages.length === 0) return null;

  // 从第一条消息或 URL 提取 session_id
  const sessionId = data.d[0]?.session_id || 'unknown';
  const title = _fudanSessionTitles[sessionId] || '';

  return buildConversationResult(sessionId, title, messages);
}

// ===== 流式响应解析 =====

function parseStream(url, data, requestBody) {
  if (typeof data !== 'string') return null;

  // 解析 SSE 数据块
  const chunks = [];
  const lines = data.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.substring(5).trim();
    if (!jsonStr) continue;
    try {
      chunks.push(JSON.parse(jsonStr));
    } catch (e) { /* 跳过非 JSON 的 SSE 行 */ }
  }

  if (chunks.length === 0) return null;

  // 拼接所有 answer 片段，同时收集搜索来源
  let fullAnswer = '';
  let sessionId = '';
  let userQuery = '';
  let siteSearch = [];

  for (const chunk of chunks) {
    if (chunk.d?.answer) {
      fullAnswer += chunk.d.answer;
    }

    // 收集搜索来源（通常在第一个 chunk 的 ext.site_search 中）
    if (chunk.d?.ext?.site_search && Array.isArray(chunk.d.ext.site_search) && chunk.d.ext.site_search.length > 0) {
      siteSearch = chunk.d.ext.site_search;
    }

    // 从结束块（e=1）的 ext.runtime_node_output 提取 session_id 和用户消息
    if (chunk.e === 1 && chunk.d?.ext?.runtime_node_output) {
      for (const node of chunk.d.ext.runtime_node_output) {
        if (node.node_key === 'start' && node.output) {
          if (node.output.session_id) sessionId = node.output.session_id;
          if (node.output.content) userQuery = node.output.content;
        }
      }
    }
  }

  if (!fullAnswer) return null;

  // 从 URL referer 提取 session_id（备用）
  if (!sessionId) {
    const match = window.location.pathname.match(/sess_id=([^&]+)/);
    if (match) sessionId = match[1];
  }
  // 从 URL search params 提取
  if (!sessionId) {
    const urlParams = new URLSearchParams(window.location.search);
    sessionId = urlParams.get('sess_id') || '';
  }

  // 分离思考内容和回答
  let thinking = '';
  let answer = fullAnswer;

  const thinkMatch = fullAnswer.match(/<think\s*>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    answer = fullAnswer.slice(thinkMatch.index + thinkMatch[0].length).trim();
  }

  // 清理回答中的 [citation:N] 标记
  answer = answer.replace(/\[citation:\d+\]/g, '').trim();

  // 格式化搜索来源
  let search = '';
  if (siteSearch.length > 0) {
    search = siteSearch.map(s => {
      const title = s.title || '';
      const url = s.url || '';
      const content = s.content || '';
      return `【${title}】\n${url}\n${content}`;
    }).join('\n\n');
  }

  // 构建消息
  const messages = [];

  if (userQuery) {
    messages.push({ role: 'user', content: userQuery, timestamp: new Date().toISOString() });
  }

  const fullContent = buildAssistantContent(thinking, search, answer);

  if (fullContent) {
    messages.push({ role: 'assistant', content: fullContent, timestamp: new Date().toISOString() });
  }

  if (messages.length === 0) return null;

  console.log('[Fudan/Stream] 提取到对话: sessionId=%s, userQuery=%s, hasThinking=%s, hasAnswer=%s',
    sessionId, userQuery?.substring(0, 30), !!thinking, !!answer);

  return buildConversationResult(sessionId, _fudanSessionTitles[sessionId] || '', messages);
}

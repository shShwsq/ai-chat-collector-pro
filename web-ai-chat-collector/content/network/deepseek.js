// network/deepseek.js - DeepSeek 网络拦截适配器
// 依赖：network/common.js

// 记录已主动请求过的 session，避免重复请求
const _fetchedSessions = new Set();

NETWORK_ADAPTERS.deepseek = {
  name: 'deepseek',
  
  // 匹配API
  matchApi: (url) => {
    return url.includes('/chat/history_messages') ||
           url.includes('/chat/completion');
  },
  
  // 解析API响应
  parse: (url, data, requestBody) => {
    // 流式对话 API
    if (url.includes('/chat/completion') && typeof data === 'string') {
      return parseStream(url, data, requestBody);
    }
    
    // 历史消息 API
    if (url.includes('/chat/history_messages')) {
      if (!data || data.code !== 0 || !data.data?.biz_data) return null;
      
      const chatMessages = data.data.biz_data.chat_messages;
      
      // 缓存命中：chat_messages 为空但 chat_session 存在
      if ((!chatMessages || chatMessages.length === 0) && data.data.biz_data.chat_session) {
        const sessionId = data.data.biz_data.chat_session.id;
        if (!_fetchedSessions.has(sessionId)) {
          _fetchedSessions.add(sessionId);
          NETWORK_ADAPTERS.deepseek.fetchFullHistory(sessionId);
        }
        return null;
      }
      
      if (!chatMessages || chatMessages.length === 0) return null;
      
      return NETWORK_ADAPTERS.deepseek.parseMessages(url, data);
    }
    
    return null;
  },
  
  // 主动请求完整历史（缓存未命中时调用）
  fetchFullHistory(sessionId) {
    const url = `/api/v0/chat/history_messages?chat_session_id=${sessionId}`;
    console.log('[DeepSeek/Debug] fetchFullHistory: sessionId=%s, url=%s', sessionId, url);
    fetchViaInterceptor(url);
    console.log('[DeepSeek/Debug] fetchFullHistory postMessage 已发送');
  },
  
  // 主动请求指定对话数据（删除后重新采集）
  async fetchConversation(convId) {
    console.log('[DeepSeek/Debug] fetchConversation: convId=%s', convId);
    this.fetchFullHistory(convId);
    return null;
  },
  
  // 从历史消息响应中解析消息列表
  parseMessages(url, data) {
    const chatMessages = data.data.biz_data.chat_messages;
    
    const sessionIdMatch = url.match(/chat_session_id=([^&]+)/);
    const conversationId = sessionIdMatch ? sessionIdMatch[1] : 'unknown';
    const title = data.data.biz_data.chat_session?.title || '';
    
    const messages = [];
    
    for (const msg of chatMessages) {
      if (!msg.fragments || msg.fragments.length === 0) continue;
      
      if (msg.role === 'USER') {
        const requestFragment = msg.fragments.find(f => f.type === 'REQUEST');
        if (requestFragment && requestFragment.content) {
          messages.push({
            role: 'user',
            content: requestFragment.content,
            timestamp: new Date((msg.inserted_at || 0) * 1000).toISOString()
          });
        }
      } else if (msg.role === 'ASSISTANT') {
        let thinking = null;
        let search = null;
        let answer = null;
        
        for (const fragment of msg.fragments) {
          if (fragment.type === 'THINK' && fragment.content) {
            thinking = (thinking || '') + fragment.content + '\n';
          }
          else if (fragment.type === 'TOOL_SEARCH' && fragment.results) {
            const searchParts = fragment.results.map(r => {
              const title = r.title || '';
              const url = r.url || '';
              const snippet = r.snippet || '';
              const siteName = r.site_name || '';
              return `【${title}】${siteName ? ` (${siteName})` : ''}\n${url}\n${snippet}`;
            });
            search = (search || '') + searchParts.join('\n\n') + '\n\n';
          }
          else if (fragment.type === 'RESPONSE' && fragment.content) {
            answer = fragment.content;
          }
        }
        
        const fullContent = buildAssistantContent(thinking, search, answer);
        
        if (fullContent) {
          messages.push({
            role: 'assistant',
            content: fullContent,
            timestamp: new Date((msg.inserted_at || 0) * 1000).toISOString()
          });
        }
      }
    }
    
    if (messages.length === 0) return null;
    
    return buildConversationResult(conversationId, title, messages);
  }
};

// ===== 流式响应解析 =====

// 解析 SSE 流式响应（/api/v0/chat/completion）
// DeepSeek 使用自定义 patch 协议：
//   {"v":{...}}              — 根级设置
//   {"p":"path","v":"value"} — 设置路径值（默认操作 SET）
//   {"p":"path","o":"APPEND","v":"text"} — 追加
//   {"p":"path","o":"BATCH","v":[...]}   — 批量子操作
//   {"v":"text"}             — 无路径简写，追加到上次的内容路径
function parseStream(url, data, requestBody) {
  let title = '';
  const state = { response: { fragments: [] } };
  let lastAppendPath = null; // 追踪最近一次 content APPEND 的路径（用于无路径简写）
  
  const lines = data.split('\n');
  let currentEventType = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('event:')) {
      currentEventType = trimmed.substring(6).trim();
      continue;
    }
    
    if (!trimmed.startsWith('data:')) {
      if (trimmed === '') currentEventType = '';
      continue;
    }
    
    const jsonStr = trimmed.substring(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    
    // 提取标题事件
    if (currentEventType === 'title') {
      try { title = JSON.parse(jsonStr).content || ''; } catch (e) { /* title 解析失败留空 */ }
      continue;
    }
    
    // 跳过非数据事件（ready, update_session, close 等）
    if (currentEventType) continue;
    
    let patch;
    try { patch = JSON.parse(jsonStr); } catch (e) { continue; }
    
    // 应用 patch
    if (patch.p === undefined) {
      // 无路径
      if (patch.v !== undefined && typeof patch.v === 'object' && !Array.isArray(patch.v)) {
        // 根级合并
        for (const key of Object.keys(patch.v)) {
          state[key] = patch.v[key];
        }
      } else if (typeof patch.v === 'string' && lastAppendPath) {
        // 简写：追加到上次的 content 路径
        applyAtPath(state, lastAppendPath, 'APPEND', patch.v);
      }
    } else {
      const pathParts = patch.p.split('/');
      const operation = patch.o || 'SET';
      
      // 追踪 content APPEND 路径
      if (operation === 'APPEND' && pathParts[pathParts.length - 1] === 'content') {
        lastAppendPath = pathParts;
      }
      
      if (operation === 'BATCH') {
        for (const subPatch of (patch.v || [])) {
          const subPathParts = subPatch.p ? [...pathParts, ...subPatch.p.split('/')] : pathParts;
          const subOp = subPatch.o || 'SET';
          if (subOp === 'APPEND' && subPathParts[subPathParts.length - 1] === 'content') {
            lastAppendPath = subPathParts;
          }
          applyAtPath(state, subPathParts, subOp, subPatch.v);
        }
      } else {
        applyAtPath(state, pathParts, operation, patch.v);
      }
    }
  }
  
  // 从最终状态提取数据
  const fragments = state.response?.fragments || [];
  let thinking = '';
  let search = '';
  let answer = '';
  
  for (const frag of fragments) {
    if (frag.type === 'THINK' && frag.content) {
      thinking += frag.content;
    }
    else if (frag.type === 'TOOL_SEARCH') {
      const queries = frag.queries || [];
      const results = frag.results || [];
      if (results.length > 0) {
        const searchParts = results.map(r => {
          const t = r.title || '';
          const u = r.url || '';
          const s = r.snippet || '';
          const site = r.site_name || '';
          return `【${t}】${site ? ` (${site})` : ''}\n${u}\n${s}`;
        });
        search += searchParts.join('\n\n') + '\n\n';
      } else if (queries.length > 0) {
        search += queries.map(q => `搜索: ${q}`).join('\n') + '\n\n';
      }
    }
    else if (frag.type === 'RESPONSE' && frag.content) {
      answer = frag.content;
    }
  }
  
  // 清理回答中的 [reference:N] 标记
  answer = answer.replace(/\[reference:\d+\]/g, '').trim();
  
  // 提取 session_id 和用户消息
  let { sessionId, userQuery } = parseRequestBody(requestBody, ['session_id'], ['prompt', 'query', 'content']);
  if (!sessionId) {
    const match = window.location.pathname.match(/\/chat\/s\/([a-f0-9-]+)/i);
    if (match) sessionId = match[1];
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
  
  if (messages.length === 0) {
    console.log('[DeepSeek/Stream] 未提取到有效消息');
    return null;
  }
  
  console.log('[DeepSeek/Stream] 提取到对话: sessionId=%s, userQuery=%s, hasThinking=%s, hasSearch=%s, hasAnswer=%s',
    sessionId, userQuery?.substring(0, 30), !!thinking, !!search, !!answer);
  
  return buildConversationResult(sessionId, title || '', messages);
}

// ===== Patch 引擎 =====

// 解析数组索引（支持负数索引如 -1 表示最后一个元素）
function resolveIndex(arr, key) {
  const idx = parseInt(key);
  if (isNaN(idx)) return key;
  if (idx < 0) return arr.length + idx;
  return idx;
}

// 沿路径导航到目标并应用操作
function applyAtPath(state, pathParts, operation, value) {
  let current = state;
  
  // 导航到父级
  for (let i = 0; i < pathParts.length - 1; i++) {
    let key = pathParts[i];
    if (Array.isArray(current)) {
      key = resolveIndex(current, key);
    }
    if (current[key] === undefined) {
      current[key] = {};
    }
    current = current[key];
  }
  
  // 对最后一个 key 应用操作
  let lastKey = pathParts[pathParts.length - 1];
  if (Array.isArray(current)) {
    lastKey = resolveIndex(current, lastKey);
  }
  
  if (operation === 'SET') {
    current[lastKey] = value;
  } else if (operation === 'APPEND') {
    if (Array.isArray(current[lastKey])) {
      if (Array.isArray(value)) {
        current[lastKey].push(...value);
      } else {
        current[lastKey].push(value);
      }
    } else if (typeof current[lastKey] === 'string') {
      current[lastKey] += value;
    } else {
      current[lastKey] = value;
    }
  }
}

// network/qianwen.js - 千问 网络拦截适配器
// 依赖：network/common.js

// 缓存对话标题：sessionId -> title
const _qianwenSessionTitles = {};

NETWORK_ADAPTERS.qianwen = {
  name: 'qianwen',
  
  // 匹配API
  matchApi: (url) => {
    return url.includes('/session/msg/list') ||
           url.includes('/v1/session/get') ||
           url.includes('/v2/session/page/list') ||
           url.includes('/api/v2/chat');
  },
  
  // 解析API响应
  parse: (url, data, requestBody) => {
    // 处理流式对话 API
    if (url.includes('/api/v2/chat')) {
      return parseStream(url, data, requestBody);
    }
    
    // 处理会话列表 API（提取标题）
    if (url.includes('/v2/session/page/list') || url.includes('/v1/session/get')) {
      return parseSessionInfo(url, data);
    }
    
    // 处理消息列表 API
    if (url.includes('/session/msg/list')) {
      return parseMessages(url, data);
    }
    
    return null;
  },
  
  // 主动请求指定对话数据（删除后重新采集）
  async fetchConversation(convId) {
    const url = `https://chat2-api.qianwen.com/api/v1/session/msg/list?session_id=${convId}&biz_id=ai_qwen`;
    console.log('[Qianwen/Debug] fetchConversation: convId=%s, url=%s', convId, url);
    fetchViaInterceptor(url);
    console.log('[Qianwen/Debug] postMessage 已发送');
    return null;
  }
};

// 解析会话信息（提取标题）
function parseSessionInfo(url, data) {
  if (!data || data.code !== 0 || !data.data) return null;
  
  // /v1/session/get 返回单个会话
  if (url.includes('/v1/session/get')) {
    const sid = data.data.session_id || data.data.id;
    if (sid) {
      _qianwenSessionTitles[sid] = data.data.title || '';
    }
    return null;
  }
  
  // /v2/session/page/list 返回会话列表
  if (url.includes('/v2/session/page/list')) {
    if (data.data.list) {
      for (const session of data.data.list) {
        if (session.session_id) {
          _qianwenSessionTitles[session.session_id] = session.title || '';
        }
      }
    }
    return null;
  }
  
  return null;
}

// 从 sources 数组提取搜索来源
function extractSources(sources) {
  const sourceItems = [];
  if (!sources) return sourceItems;
  for (const s of sources) {
    if (s.type === 'source' && s.content?.list) {
      for (const item of s.content.list) {
        const title = item.title || '';
        const url = item.url || '';
        const name = item.name || '';
        const summary = item.summary || '';
        if (title || url) {
          sourceItems.push({ title, url, name, summary });
        }
      }
    }
  }
  return sourceItems;
}

// 格式化搜索来源为 Markdown
function formatSources(sourceItems) {
  return sourceItems.map(s => {
    const label = s.name ? `${s.name}: ${s.title}` : s.title;
    return `[${label}](${s.url})\n> ${s.summary.substring(0, 200)}`;
  }).join('\n\n');
}

// 解析消息列表
function parseMessages(url, data) {
  if (!data || data.code !== 0 || !data.data?.list) return null;
  
  // 从URL提取session_id
  const sessionIdMatch = url.match(/session_id=([^&]+)/);
  const conversationId = sessionIdMatch ? sessionIdMatch[1] : 'unknown';
  
  const messages = [];
  
  // API 返回的消息列表是倒序的（最新在前），需要反转
  const msgList = [...data.data.list].reverse();
  
  // 遍历消息列表
  for (const msgItem of msgList) {
    // 提取用户消息
    if (msgItem.request_messages && msgItem.request_messages.length > 0) {
      for (const reqMsg of msgItem.request_messages) {
        if (reqMsg.mime_type === 'text/plain' && reqMsg.content) {
          messages.push({
            role: 'user',
            content: reqMsg.content,
            timestamp: new Date().toISOString()
          });
          break;
        }
      }
    }
    
    // 提取助手消息
    if (msgItem.response_messages && msgItem.response_messages.length > 0) {
      let thinking = null;
      let thinkingAfterSearch = null;
      let search = null;
      let answer = null;
      
      for (const respMsg of msgItem.response_messages) {
        // 深度思考（搜索前）- 内容是累积的，优先取 status=complete 的
        if (respMsg.mime_type === 'plan_cot/post' && respMsg.content) {
          if (respMsg.status === 'complete' || !thinking) {
            thinking = respMsg.content;
          }
        }
        // 联网搜索（bar/iframe）
        else if (respMsg.mime_type === 'bar/iframe' && respMsg.meta_data?.sources) {
          const sourceItems = extractSources(respMsg.meta_data.sources);
          if (sourceItems.length > 0) {
            search = formatSources(sourceItems);
          }
        }
        // 正式回答（multi_load/iframe 包含搜索后思考 + 搜索来源 + 回答）
        else if (respMsg.mime_type === 'multi_load/iframe') {
          // 从 meta_data.multi_load 提取搜索后思考和搜索来源
          if (respMsg.meta_data?.multi_load) {
            for (const block of respMsg.meta_data.multi_load) {
              if (block.type === 'deep_think' && block.content?.think_content) {
                thinkingAfterSearch = block.content.think_content;
              }
              else if ((block.type === 'source_group_web' || block.type === 'source') && block.content?.list) {
                const sourceItems = [];
                for (const sGroup of block.content.list) {
                  if (sGroup.type === 'source' && sGroup.content?.list) {
                    for (const item of sGroup.content.list) {
                      const title = item.title || '';
                      const url = item.url || '';
                      const name = item.name || '';
                      const summary = item.summary || '';
                      if (title || url) {
                        sourceItems.push({ title, url, name, summary });
                      }
                    }
                  }
                }
                if (sourceItems.length > 0 && !search) {
                  search = formatSources(sourceItems);
                }
              }
            }
          }
          // 从 content 提取回答文本
          if (respMsg.content) {
            answer = respMsg.content.replace(/^\[\(deep_think\)\]\s*/, '').trim();
          }
        }
      }
      
      // 合并思考内容
      let allThinking = '';
      if (thinking) {
        allThinking += thinking;
      }
      if (thinkingAfterSearch) {
        if (allThinking) allThinking += '\n\n---\n\n';
        allThinking += thinkingAfterSearch;
      }
      
      // 构建完整内容
      const fullContent = buildAssistantContent(allThinking, search, answer);
      
      if (fullContent) {
        messages.push({
          role: 'assistant',
          content: fullContent,
          timestamp: new Date().toISOString()
        });
      }
    }
  }
  
  if (messages.length === 0) return null;
  
  // 从缓存中获取标题
  const title = _qianwenSessionTitles[conversationId] || '';
  
  return buildConversationResult(conversationId, title, messages);
}

// 解析 SSE 流式响应（/api/v2/chat）
function parseStream(url, data, requestBody) {
  // data 可能是字符串（SSE 格式）或已解析的对象
  let sseText = data;
  if (typeof data !== 'string') {
    console.log('[Qianwen/Stream] data 不是字符串，跳过');
    return null;
  }
  
  // 解析 SSE 数据块
  const chunks = [];
  const lines = sseText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const jsonStr = trimmed.substring(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        chunks.push(JSON.parse(jsonStr));
      } catch (e) {
        // 解析失败跳过
      }
    }
  }
  
  if (chunks.length === 0) {
    console.log('[Qianwen/Stream] 无有效 SSE 数据块');
    return null;
  }
  
  console.log('[Qianwen/Stream] 解析到 %d 个 SSE 数据块', chunks.length);
  
  // 提取 session_id
  let { sessionId } = parseRequestBody(requestBody, ['session_id']);
  // 从 SSE 数据块提取
  if (!sessionId) {
    for (const chunk of chunks) {
      if (chunk.communication?.sessionid) {
        sessionId = chunk.communication.sessionid;
        break;
      }
    }
  }
  // 从 URL 的 referer 或路径提取
  if (!sessionId) {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9]+)/i);
    if (match) sessionId = match[1];
  }
  
  if (!sessionId) {
    console.log('[Qianwen/Stream] 无法提取 session_id');
    return null;
  }
  
  // 提取用户消息
  let { userQuery } = parseRequestBody(requestBody, [], ['query', 'content']);
  // 从 SSE signal/post 提取
  if (!userQuery) {
    for (const chunk of chunks) {
      const msgs = chunk.data?.messages || [];
      for (const msg of msgs) {
        if (msg.mime_type === 'signal/post' && msg.meta_data?.ori_query) {
          userQuery = msg.meta_data.ori_query;
          break;
        }
      }
      if (userQuery) break;
    }
  }
  
  // 提取思考内容（plan_cot/post 是累积的，每个chunk包含完整内容，只取 status=complete 的）
  let thinking = '';
  for (const chunk of chunks) {
    const msgs = chunk.data?.messages || [];
    for (const msg of msgs) {
      if (msg.mime_type === 'plan_cot/post' && msg.status === 'complete' && msg.content) {
        thinking = msg.content;
      }
    }
  }
  // 如果没有 complete 状态的，取最后一个（可能是流未结束）
  if (!thinking) {
    for (const chunk of chunks) {
      const msgs = chunk.data?.messages || [];
      for (const msg of msgs) {
        if (msg.mime_type === 'plan_cot/post' && msg.content) {
          thinking = msg.content;
        }
      }
    }
  }
  
  // 提取搜索来源
  let search = '';
  for (const chunk of chunks) {
    const msgs = chunk.data?.messages || [];
    for (const msg of msgs) {
      // bar/iframe 格式
      if (msg.mime_type === 'bar/iframe' && msg.meta_data?.sources) {
        const sourceItems = extractSources(msg.meta_data.sources);
        if (sourceItems.length > 0) {
          search = formatSources(sourceItems);
        }
      }
      // bar/progress 格式（搜索进度中的查询词）
      if (msg.mime_type === 'bar/progress' && msg.meta_data?.content?.list) {
        const progressList = msg.meta_data.content.list;
        if (Array.isArray(progressList) && progressList.length > 0 && !search) {
          const queries = progressList.map(item => item.query || '').filter(Boolean);
          if (queries.length > 0) {
            search = queries.map(q => `搜索: ${q}`).join('\n\n');
          }
        }
      }
    }
  }
  
  // 提取回答内容
  let answer = '';
  let thinkingAfterSearch = '';  // 搜索后思考（来自 multi_load/iframe 的 deep_think）
  for (const chunk of chunks) {
    const msgs = chunk.data?.messages || [];
    for (const msg of msgs) {
      // text/post 或 text/plain 格式（最终回答）
      if ((msg.mime_type === 'text/post' || msg.mime_type === 'text/plain') && msg.content) {
        answer = msg.content;
      }
      // multi_load/iframe 格式（也是累积的，每个chunk包含完整内容）
      if (msg.mime_type === 'multi_load/iframe' && msg.content) {
        answer = msg.content.replace(/^\[\(deep_think\)\]\s*/, '').trim();
        // 也提取搜索后思考和搜索来源
        if (msg.meta_data?.multi_load) {
          for (const block of msg.meta_data.multi_load) {
            // 搜索后思考也是累积的，取最后一个即可
            if (block.type === 'deep_think' && block.content?.think_content) {
              thinkingAfterSearch = block.content.think_content;
            }
            if ((block.type === 'source_group_web' || block.type === 'source') && block.content?.list && !search) {
              const sourceItems = [];
              for (const sGroup of block.content.list) {
                if (sGroup.type === 'source' && sGroup.content?.list) {
                  for (const item of sGroup.content.list) {
                    if (item.title || item.url) {
                      sourceItems.push({ title: item.title || '', url: item.url || '', name: item.name || '', summary: item.summary || '' });
                    }
                  }
                }
              }
              if (sourceItems.length > 0) search = formatSources(sourceItems);
            }
          }
        }
      }
    }
  }
  
  // 合并思考内容
  if (thinkingAfterSearch) {
    if (thinking) {
      thinking += '\n\n---\n\n' + thinkingAfterSearch;
    } else {
      thinking = thinkingAfterSearch;
    }
  }
  
  // 构建消息
  const messages = [];
  
  if (userQuery) {
    messages.push({
      role: 'user',
      content: userQuery,
      timestamp: new Date().toISOString()
    });
  }
  
  // 构建助手完整内容
  const fullContent = buildAssistantContent(thinking, search, answer);
  
  if (fullContent) {
    messages.push({
      role: 'assistant',
      content: fullContent,
      timestamp: new Date().toISOString()
    });
  }
  
  if (messages.length === 0) {
    console.log('[Qianwen/Stream] 未提取到有效消息');
    return null;
  }
  
  console.log('[Qianwen/Stream] 提取到对话: sessionId=%s, userQuery=%s, hasThinking=%s, hasSearch=%s, hasAnswer=%s',
    sessionId, userQuery?.substring(0, 30), !!thinking, !!search, !!answer);
  
  const title = _qianwenSessionTitles[sessionId] || '';
  
  return buildConversationResult(sessionId, title, messages);
}

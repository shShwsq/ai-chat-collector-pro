// network/doubao.js - 豆包网络拦截适配器
// 依赖：network/common.js

// 记录已主动请求过的对话，避免重复请求
const _fetchedConversations = new Set();

NETWORK_ADAPTERS.doubao = {
  name: 'doubao',

  // 匹配API：流式对话、历史消息、会话信息
  matchApi: (url) => {
    return url.includes('/chat/completion') ||
           url.includes('/im/chain/single') ||
           url.includes('/im/conversation/info');
  },

  // 解析API响应
  parse: (url, data, requestBody) => {
    // 流式对话 API
    if (url.includes('/chat/completion') && typeof data === 'string') {
      return parseDoubaoStream(url, data, requestBody);
    }

    // 历史消息 API（cmd: 3100）
    if (url.includes('/im/chain/single') && typeof data === 'object') {
      return parseHistoryMessages(data, requestBody);
    }

    // 会话信息 API（cmd: 1110）- 暂存标题，由历史消息适配器使用
    if (url.includes('/im/conversation/info') && typeof data === 'object') {
      return parseConversationInfo(data);
    }

    return null;
  },

  // 主动请求对话历史
  async fetchConversation(convId) {
    if (_fetchedConversations.has(convId)) return null;
    _fetchedConversations.add(convId);
    // 通过拦截器发起历史消息请求
    const url = `/im/chain/single?aid=497858&device_platform=web`;
    const body = JSON.stringify({
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: convId,
          anchor_index: Number.MAX_SAFE_INTEGER,
          conversation_type: 3,
          direction: 1,
          limit: 20,
          filter: { index_list: [] }
        }
      },
      sequence_id: crypto.randomUUID(),
      channel: 2,
      version: '1'
    });
    // 豆包的历史消息 API 是 POST，需要通过拦截器发送
    fetchViaInterceptor(url);
    return null;
  }
};

// 缓存会话标题（会话信息 API 返回，历史消息 API 使用）
const _conversationTitles = {};

// ===== 会话信息解析 =====

function parseConversationInfo(data) {
  try {
    const convInfo = data.downlink_body?.get_conv_info_downlink_body?.conversation_info;
    if (!convInfo) return null;

    const convId = convInfo.conversation_id;
    const title = convInfo.name || '';

    if (convId && title) {
      _conversationTitles[convId] = title;
      // 返回标题更新对象，触发 exporter-base.js 只更新标题（不覆盖消息）
      // 解决 chain/single 早于 conversation/info 到达导致标题为空的问题
      return {
        titleUpdate: true,
        id: convId,
        title: title,
        url: window.location.href
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ===== 历史消息解析 =====

function parseHistoryMessages(data, requestBody) {
  try {
    if (data.status_code !== 0) return null;

    const pullBody = data.downlink_body?.pull_singe_chain_downlink_body;
    if (!pullBody || !pullBody.messages) return null;

    // 从请求体中提取 conversation_id
    let conversationId = '';
    if (requestBody) {
      try {
        const reqBody = JSON.parse(requestBody);
        conversationId = reqBody.uplink_body?.pull_singe_chain_uplink_body?.conversation_id || '';
      } catch (e) { /* conversationId 解析失败留空 */ }
    }

    // 按 index_in_conv 升序排列（响应是倒序的）
    const rawMessages = pullBody.messages.sort((a, b) =>
      parseInt(a.index_in_conv) - parseInt(b.index_in_conv)
    );

    const messages = [];

    for (const msg of rawMessages) {
      const isUser = msg.user_type === 1;
      const isAssistant = msg.user_type === 2;

      if (isUser) {
        // 用户消息：从 content_block 提取
        const text = extractTextFromContentBlocks(msg.content_block);
        if (text) {
          messages.push({
            role: 'user',
            content: text,
            timestamp: new Date(parseInt(msg.create_time) * 1000).toISOString()
          });
        }
      } else if (isAssistant) {
        // 助手消息：从 content_block 提取思考/搜索/回答
        const parsed = parseAssistantContentBlocks(msg.content_block);
        if (parsed) {
          messages.push({
            role: 'assistant',
            content: parsed,
            timestamp: new Date(parseInt(msg.create_time) * 1000).toISOString()
          });
        }
      }
    }

    if (messages.length === 0) return null;

    const title = _conversationTitles[conversationId] || '';
    return buildConversationResult(conversationId, title, messages);
  } catch (e) {
    console.error('[Doubao/History] 解析历史消息失败:', e);
    return null;
  }
}

// ===== content_block 解析 =====

// 从 content_block 数组中提取用户文本
function extractTextFromContentBlocks(blocks) {
  if (!blocks || !Array.isArray(blocks)) return '';
  let text = '';
  for (const block of blocks) {
    if (block.block_type === 10000 && block.content?.text_block?.text) {
      text += block.content.text_block.text;
    }
  }
  return text.trim();
}

// 从 content_block 数组中解析助手消息（思考/搜索/回答）
function parseAssistantContentBlocks(blocks) {
  if (!blocks || !Array.isArray(blocks)) return null;

  let thinking = '';
  let search = '';
  let answer = '';

  // 构建 block_id -> block_type 映射，用于判断 parent_id 指向的块类型
  const blockTypeMap = {};
  for (const block of blocks) {
    if (block.block_id) {
      blockTypeMap[block.block_id] = block.block_type;
    }
  }

  for (const block of blocks) {
    // 文本块 (block_type: 10000)
    if (block.block_type === 10000 && block.content?.text_block) {
      const text = block.content.text_block.text || '';
      if (!text) continue;

      // 判断是否属于思考块（parent_id 指向 thinking_block）
      if (block.parent_id && blockTypeMap[block.parent_id] === 10040) {
        thinking += text;
      } else if (!block.parent_id) {
        // 无 parent_id = 正式回答
        answer += text;
      }
    }

    // 思考块标题 (block_type: 10040)
    if (block.block_type === 10040 && block.content?.thinking_block) {
      // thinking_block 的 finish_title 可以作为思考标题，但正文在子 10000 块中
      // 这里不需要额外处理，子块会通过 parent_id 归类
    }

    // 搜索结果块 (block_type: 10025)
    if (block.block_type === 10025 && block.content?.search_query_result_block) {
      const searchBlock = block.content.search_query_result_block;
      if (searchBlock.results && searchBlock.results.length > 0) {
        const searchParts = searchBlock.results.map(r => {
          // 豆包新结构：result 嵌套在 text_card 字段中
          const card = r.text_card || r;
          const title = card.title || '';
          const siteName = card.sitename || '';
          const url = card.url || '';
          const snippet = card.summary || '';
          return `【${title}】${siteName ? ` (${siteName})` : ''}\n${url}\n${snippet}`;
        });
        search += searchParts.join('\n\n');
      }
    }
  }

  return buildAssistantContent(thinking || null, search || null, answer || null);
}

// ===== 流式响应解析 =====

// 解析豆包 SSE 流式响应
// 豆包使用自定义 SSE 协议，关键事件类型：
//   CHUNK_DELTA      - 增量文本 {"text":"xxx"}
//   STREAM_CHUNK     - 内容块更新（text_block/thinking_block/search_query_result_block）
//   STREAM_MSG_NOTIFY - 初始消息通知
//   SSE_HEARTBEAT    - 心跳，忽略
//   SSE_ACK          - 确认，忽略
//   SSE_REPLY_END    - 回复结束
function parseDoubaoStream(url, data, requestBody) {
  const lines = data.split('\n');
  let currentEvent = '';
  let conversationId = '';
  let messageId = '';

  // 收集各类内容
  let thinkingDeltas = '';     // CHUNK_DELTA 中属于思考阶段的文本
  let thinkingTexts = '';      // STREAM_CHUNK 中思考阶段的文本
  let answerStreamChunks = ''; // STREAM_CHUNK 中正式回答的文本（回答开头，CHUNK_DELTA 可能缺失）
  let answerText = '';         // CHUNK_DELTA 中最终回答文本
  let searchResults = [];      // 搜索结果
  let userQuery = '';          // 用户发送的消息

  // 状态追踪
  let inThinkingPhase = false;
  let thinkingFinished = false;

  // 追踪 thinking_block 的 block_id，用于判断子块归属
  let thinkingBlockIds = new Set();

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.substring(6).trim();
      continue;
    }

    if (!trimmed.startsWith('data:')) {
      if (trimmed === '') currentEvent = '';
      continue;
    }

    const jsonStr = trimmed.substring(5).trim();
    if (!jsonStr) continue;

    let jsonData;
    try { jsonData = JSON.parse(jsonStr); } catch (e) { continue; }

    switch (currentEvent) {
      case 'SSE_ACK': {
        if (jsonData.ack_client_meta?.conversation_id) {
          conversationId = jsonData.ack_client_meta.conversation_id;
        }
        break;
      }

      case 'FULL_MSG_NOTIFY': {
        const msg = jsonData.message;
        if (msg?.conversation_id) {
          conversationId = msg.conversation_id;
        }
        // 从用户消息的 content_block 提取用户输入
        // 格式: content_block: [{block_type: 10000, content: {text_block: {text: "hello"}}}]
        if (msg?.content_block && Array.isArray(msg.content_block)) {
          for (const block of msg.content_block) {
            if (block.block_type === 10000 && block.content?.text_block?.text) {
              userQuery = block.content.text_block.text;
              break;
            }
          }
        }
        break;
      }

      case 'STREAM_MSG_NOTIFY': {
        const meta = jsonData.meta;
        if (meta?.conversation_id) {
          conversationId = meta.conversation_id;
        }
        if (meta?.message_id) {
          messageId = meta.message_id;
        }
        // 检查是否有 thinking_block（深度思考模式）
        const contentBlocks = jsonData.content?.content_block || [];
        for (const block of contentBlocks) {
          if (block.block_type === 10040) {
            inThinkingPhase = true;
            if (block.block_id) {
              thinkingBlockIds.add(block.block_id);
            }
          }
        }
        break;
      }

      case 'STREAM_CHUNK': {
        const patchOps = jsonData.patch_op || [];
        for (const op of patchOps) {
          if (op.patch_object === 1 && op.patch_value?.content_block) {
            for (const block of op.patch_value.content_block) {
              // 思考块
              if (block.block_type === 10040 && block.content?.thinking_block) {
                if (block.block_id) {
                  thinkingBlockIds.add(block.block_id);
                }
                if (block.is_finish) {
                  inThinkingPhase = false;
                  thinkingFinished = true;
                }
              }
              // 文本块
              if (block.block_type === 10000 && block.content?.text_block) {
                const textBlock = block.content.text_block;
                const text = textBlock.text || '';
                if (!text) continue;

                // parent_id 指向 thinking_block → 思考正文
                if (block.parent_id && thinkingBlockIds.has(block.parent_id)) {
                  thinkingTexts += text;
                } else if (!block.parent_id) {
                  // 无 parent_id → 正式回答的开头部分
                  // 豆包的前几段文字通过 STREAM_CHUNK 发送，后续增量通过 CHUNK_DELTA 发送
                  // STREAM_CHUNK 中的 text 是累积式追加，需要收集
                  answerStreamChunks += text;
                }
              }
              // 搜索结果块
              if (block.block_type === 10025 && block.content?.search_query_result_block) {
                const searchBlock = block.content.search_query_result_block;
                if (searchBlock.results && block.is_finish) {
                  searchResults = searchBlock.results;
                }
              }
            }
          }
        }
        break;
      }

      case 'CHUNK_DELTA': {
        const text = jsonData.text || '';
        if (text) {
          if (inThinkingPhase) {
            thinkingDeltas += text;
          } else {
            answerText += text;
          }
        }
        break;
      }

      case 'SSE_HEARTBEAT':
      case 'SSE_REPLY_END':
        break;
    }
  }

  // 思考内容：优先使用 CHUNK_DELTA（更完整），其次使用 STREAM_CHUNK 中的文本
  const finalThinking = thinkingDeltas || thinkingTexts;

  // 正式回答：合并 STREAM_CHUNK 和 CHUNK_DELTA
  // STREAM_CHUNK 包含回答开头（如 "### 基本信息\n文"），CHUNK_DELTA 包含后续增量
  // 需要检查 answerText 是否已经是 answerStreamChunks 的延续（避免重复）
  let finalAnswer = '';
  if (answerStreamChunks && answerText) {
    // 检查 CHUNK_DELTA 的文本是否以 STREAM_CHUNK 的文本开头（重叠）
    if (answerText.startsWith(answerStreamChunks)) {
      // CHUNK_DELTA 包含了 STREAM_CHUNK 的全部内容，直接用 CHUNK_DELTA
      finalAnswer = answerText;
    } else {
      // 两者不重叠，拼接（STREAM_CHUNK 在前，CHUNK_DELTA 在后）
      finalAnswer = answerStreamChunks + answerText;
    }
  } else {
    finalAnswer = answerStreamChunks || answerText;
  }

  // 构建搜索结果文本
  let searchText = '';
  if (searchResults.length > 0) {
    const searchParts = searchResults.map(r => {
      // 豆包新结构：result 嵌套在 text_card 字段中
      const card = r.text_card || r;
      const title = card.title || '';
      const siteName = card.sitename || '';
      const rUrl = card.url || '';
      const snippet = card.summary || '';
      return `【${title}】${siteName ? ` (${siteName})` : ''}\n${rUrl}\n${snippet}`;
    });
    searchText = searchParts.join('\n\n');
  }

  // 从请求体中补充用户消息和 conversation_id（备选，FULL_MSG_NOTIFY 优先）
  if (!userQuery && requestBody) {
    try {
      const reqBody = JSON.parse(requestBody);
      // 豆包请求体中用户消息在 content_block 格式
      if (reqBody.content_block && Array.isArray(reqBody.content_block)) {
        for (const block of reqBody.content_block) {
          if (block.content?.text_block?.text) {
            userQuery = block.content.text_block.text;
            break;
          }
        }
      }
      // 从请求体提取 conversation_id
      if (!conversationId && reqBody.conversation_id) {
        conversationId = reqBody.conversation_id;
      }
    } catch (e) { /* 请求体解析失败 */ }
  }

  // 如果没有从请求体获取到 conversation_id，尝试从 URL 路径提取
  if (!conversationId) {
    const match = window.location.pathname.match(/\/chat\/(\d+)/);
    if (match) conversationId = match[1];
  }

  // 构建消息
  const messages = [];
  if (userQuery) {
    messages.push({ role: 'user', content: userQuery, timestamp: new Date().toISOString() });
  }

  const fullContent = buildAssistantContent(
    finalThinking || null,
    searchText || null,
    finalAnswer || null
  );

  if (fullContent) {
    messages.push({ role: 'assistant', content: fullContent, timestamp: new Date().toISOString() });
  }

  if (messages.length === 0) {
    console.log('[Doubao/Stream] 未提取到有效消息');
    return null;
  }

  console.log('[Doubao/Stream] 提取到对话: convId=%s, userQuery=%s, hasThinking=%s, hasSearch=%s, hasAnswer=%s',
    conversationId, userQuery?.substring(0, 30), !!finalThinking, !!searchText, !!answerText);

  return buildConversationResult(conversationId || messageId || 'unknown', '', messages);
}

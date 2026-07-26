// network/common.js - 网络适配器公共函数
// 依赖：adapter-registry.js（NETWORK_ADAPTERS）

// ============================================================
// 消息内容构建
// ============================================================

// 将思考、搜索、回答拼接为标准格式的助手消息内容
function buildAssistantContent(thinking, search, answer) {
  let fullContent = '';
  if (thinking) fullContent += `<think>\n${thinking.trim()}\n</think>\n\n`;
  if (search) fullContent += `<search_result>\n${search.trim()}\n</search_result>\n\n`;
  if (answer) fullContent += answer;
  return fullContent.trim();
}

// ============================================================
// 请求体解析
// ============================================================

// 从请求体中提取 sessionId 和用户消息
// sessionFields: 用于提取 sessionId 的字段名列表，如 ['session_id']
// queryFields: 用于提取用户消息的字段名列表，如 ['prompt', 'query', 'content']
function parseRequestBody(requestBody, sessionFields = ['session_id'], queryFields = ['prompt', 'query', 'content']) {
  const result = { sessionId: '', userQuery: '' };
  if (!requestBody) return result;
  try {
    const reqBody = JSON.parse(requestBody);
    for (const field of sessionFields) {
      if (reqBody[field]) { result.sessionId = reqBody[field]; break; }
    }
    for (const field of queryFields) {
      if (reqBody[field]) { result.userQuery = reqBody[field]; break; }
    }
  } catch (e) { /* 非合法 JSON，返回空 result */ }
  return result;
}

// ============================================================
// 对话结果构建
// ============================================================

// 构建标准对话结果对象
function buildConversationResult(id, title, messages) {
  return {
    id: id,
    title: title,
    messages: messages,
    url: window.location.href
  };
}

// ============================================================
// 主动请求（通过拦截器）
// ============================================================

// 通过 network-interceptor 发起主动请求
function fetchViaInterceptor(url) {
  window.postMessage({
    type: '__AI_CHAT_FETCH_REQUEST__',
    url: url
  }, '*');
}

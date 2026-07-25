// bg/ai-handlers.js - AI 问答（整理信息 / 生成测验 / 问答），支持流式输出
// 依赖：lib/llm.js (AIAssistant)

function _createStreamChunkSender(tab, requestId) {
  // 向 content script 推送流式 chunk
  // onChunk 签名: (delta, fullContent, phase) - phase: 'reasoning' | 'content' | undefined
  return (delta, fullContent, phase) => {
    try {
      chrome.tabs.sendMessage(tab.id, {
        type: 'AI_STREAM_CHUNK',
        requestId,
        delta,
        fullContent,
        phase: phase || 'content'
      });
    } catch (e) {
      console.error('[BG] 推送流式 chunk 失败:', e);
    }
  };
}

async function handleOrganizeInfo(query, stream, tab, options = {}) {
  try {
    if (stream && tab) {
      const requestId = `organize_${Date.now()}`;
      // 先返回 requestId，让前端开始监听
      // 异步执行流式调用
      const onChunk = _createStreamChunkSender(tab, requestId);
      AIAssistant.organizeInfo(query, onChunk, options).then((content) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_DONE',
            requestId,
            fullContent: content
          });
        } catch (e) { console.warn('[BG] 推送 STREAM_DONE 失败:', e); }
      }).catch((e) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_ERROR',
            requestId,
            error: e.message
          });
        } catch (e2) { console.warn('[BG] 推送 STREAM_ERROR 失败:', e2); }
      });
      return { success: true, requestId };
    }
    const content = await AIAssistant.organizeInfo(query, null, options);
    return { success: true, content };
  } catch (e) {
    console.error('[BG] 整理信息失败:', e);
    return { success: false, error: e.message };
  }
}

async function handleGenerateQuiz(query, stream, tab, options = {}) {
  try {
    if (stream && tab) {
      const requestId = `quiz_${Date.now()}`;
      const onChunk = _createStreamChunkSender(tab, requestId);
      AIAssistant.generateQuiz(query, onChunk, options).then((content) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_DONE',
            requestId,
            fullContent: content
          });
        } catch (e) { console.warn('[BG] 推送 STREAM_DONE 失败:', e); }
      }).catch((e) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_ERROR',
            requestId,
            error: e.message
          });
        } catch (e2) { console.warn('[BG] 推送 STREAM_ERROR 失败:', e2); }
      });
      return { success: true, requestId };
    }
    const content = await AIAssistant.generateQuiz(query, null, options);
    return { success: true, content };
  } catch (e) {
    console.error('[BG] 生成测验失败:', e);
    return { success: false, error: e.message };
  }
}

async function handleAIAskQuestion(query, stream, tab, options = {}) {
  try {
    if (stream && tab) {
      const requestId = `chat_${Date.now()}`;
      const onChunk = _createStreamChunkSender(tab, requestId);
      AIAssistant.askQuestion(query, onChunk, options).then((content) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_DONE',
            requestId,
            fullContent: content
          });
        } catch (e) { console.warn('[BG] 推送 STREAM_DONE 失败:', e); }
      }).catch((e) => {
        try {
          chrome.tabs.sendMessage(tab.id, {
            type: 'AI_STREAM_ERROR',
            requestId,
            error: e.message
          });
        } catch (e2) { console.warn('[BG] 推送 STREAM_ERROR 失败:', e2); }
      });
      return { success: true, requestId };
    }
    const content = await AIAssistant.askQuestion(query, null, options);
    return { success: true, content };
  } catch (e) {
    console.error('[BG] AI 问答失败:', e);
    return { success: false, error: e.message };
  }
}

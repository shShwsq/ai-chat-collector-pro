// bg/ai-handlers.js - AI 问答（整理信息 / 生成测验 / 问答），支持流式输出
// 依赖：lib/llm.js (AIAssistant)

// 向 content script 推送流式 chunk 的 sender 工厂
// onChunk 签名: (delta, fullContent, phase) - phase: 'reasoning' | 'content' | undefined
function _createStreamChunkSender(tab, requestId) {
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

// 统一推送流式完成/错误消息，吞掉 tab 失联等异常
function _sendStreamMessage(tabId, type, payload) {
  try {
    chrome.tabs.sendMessage(tabId, { type, ...payload });
  } catch (e) {
    console.warn(`[BG] 推送 ${type} 失败:`, e);
  }
}

// 统一的流式/非流式 AI 调用封装
// - method: 已绑定的 AIAssistant 方法 (query, onChunk, options) => Promise<string>
// - prefix: requestId 前缀，用于区分调用类型
// - label:  错误日志中的中文标签
async function _handleAiCall(method, prefix, label, query, stream, tab, options = {}) {
  try {
    if (stream && tab) {
      const requestId = `${prefix}_${Date.now()}`;
      const onChunk = _createStreamChunkSender(tab, requestId);
      method(query, onChunk, options).then((content) => {
        _sendStreamMessage(tab.id, 'AI_STREAM_DONE', { requestId, fullContent: content });
      }).catch((e) => {
        _sendStreamMessage(tab.id, 'AI_STREAM_ERROR', { requestId, error: e.message });
      });
      return { success: true, requestId };
    }
    const content = await method(query, null, options);
    return { success: true, content };
  } catch (e) {
    console.error(`[BG] ${label}失败:`, e);
    return { success: false, error: e.message };
  }
}

async function handleOrganizeInfo(query, stream, tab, options = {}) {
  return _handleAiCall(AIAssistant.organizeInfo.bind(AIAssistant), 'organize', '整理信息', query, stream, tab, options);
}

async function handleGenerateQuiz(query, stream, tab, options = {}) {
  return _handleAiCall(AIAssistant.generateQuiz.bind(AIAssistant), 'quiz', '生成测验', query, stream, tab, options);
}

async function handleAIAskQuestion(query, stream, tab, options = {}) {
  return _handleAiCall(AIAssistant.askQuestion.bind(AIAssistant), 'chat', 'AI 问答', query, stream, tab, options);
}

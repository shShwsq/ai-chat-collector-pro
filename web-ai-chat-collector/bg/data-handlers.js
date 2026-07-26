// bg/data-handlers.js - 数据管理（清空对话 / 重置设置）
// 依赖：lib/db.js (getConversations, deleteConversation),
//       lib/vector-store.js (VectorStore),
//       lib/embedding.js (EmbeddingService), lib/llm.js (LLMService)

async function handleClearAllConversations() {
  try {
    const list = await getConversations();
    let count = 0;
    for (const conv of list) {
      await deleteConversation(conv.id);
      count++;
    }
    // 同时清空向量库（本地或远程，根据当前后端）
    await VectorStore.clearCollection();
    console.log(`[BG] 已清空所有对话（${count} 条）和向量库（后端: ${VectorStore.getBackend()}）`);
    return { success: true, count };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleResetAllSettings() {
  try {
    await chrome.storage.local.clear();
    // 重新初始化服务
    await EmbeddingService.setConfig({ provider: 'dashscope', apiKey: '', model: 'text-embedding-v4', baseUrl: '', includeThinking: false, includeSearch: false });
    await VectorStore.setBackend('local', {});
    await LLMService.setBackend('openai', { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen3.6-flash' });
    console.log('[BG] 已重置所有设置');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

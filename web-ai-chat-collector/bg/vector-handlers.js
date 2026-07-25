// bg/vector-handlers.js - 向量索引管理（重建 / 触发嵌入 / 清空 / 统计 / 连通性测试）
// 依赖：lib/db.js (getConversation, getConversations),
//       lib/embedding.js (EmbeddingService), lib/vector-store.js (VectorStore)

async function handleRebuildIndex() {
  try {
    const list = await getConversations();
    let count = 0;

    for (const conv of list) {
      const batchItems = [];
      for (const msg of conv.messages) {
        if (!msg.content || !msg.content.trim()) continue;
        // 根据设置剥离 <think>/<search_result> 块后再 embedding
        const embedContent = EmbeddingService.filterContentForEmbedding(msg.content);
        if (!embedContent) continue;
        // 按当前切片设置切成多段，逐段 embedding
        const chunks = await EmbeddingService.embedMessageChunks(embedContent);
        const msgKey = msg.hash || count;
        for (const c of chunks) {
          batchItems.push({
            id: `${conv.id}::msg::${msgKey}::chunk::${c.chunkIdx}`,
            vector: c.vector,
            metadata: {
              convId: conv.id,
              msgHash: String(msgKey),
              chunkIdx: c.chunkIdx,
              chunkTotal: c.total,
              title: conv.title || '',
              platform: conv.platform || '',
              role: msg.role || '',
              content: c.text || ''
            }
          });
          count++;
        }
      }
      // 逐对话批量写入（单次 HTTP/事务写入该对话所有 chunks）
      if (batchItems.length > 0) {
        await VectorStore.addVectors(batchItems);
      }
    }

    return { success: true, count };
  } catch (e) {
    console.error('[BG] 重建索引失败:', e);
    return { success: false, error: e.message };
  }
}

// 后台 Embedding：保存对话时由 content script 触发
async function handleTriggerEmbedding(convId, messages) {
  try {
    if (!EmbeddingService.isConfigured()) {
      console.log('[BG/Embedding] DashScope API Key 未配置，跳过 embedding');
      return { success: false, error: '未配置 API Key' };
    }

    // 取对话元信息（title/platform）一并写入向量库，使远程向量库成为自包含、可被智能体消费的 SKILL 数据
    const conv = await getConversation(convId);
    const title = conv?.title || '';
    const platform = conv?.platform || '';

    const batchItems = [];
    for (const msg of messages) {
      if (!msg.content || !msg.content.trim()) continue;
      // 根据设置剥离 <think>/<search_result> 块后再 embedding
      const embedContent = EmbeddingService.filterContentForEmbedding(msg.content);
      if (!embedContent) continue;
      // 按当前切片设置切成多段，逐段 embedding
      const chunks = await EmbeddingService.embedMessageChunks(embedContent);
      const msgKey = msg.hash || Date.now();
      for (const c of chunks) {
        batchItems.push({
          id: `${convId}::msg::${msgKey}::chunk::${c.chunkIdx}`,
          vector: c.vector,
          metadata: {
            convId,
            msgHash: String(msgKey),
            chunkIdx: c.chunkIdx,
            chunkTotal: c.total,
            title,
            platform,
            role: msg.role || '',
            content: c.text || ''
          }
        });
      }
    }
    // 整个对话一次批量写入
    if (batchItems.length > 0) {
      await VectorStore.addVectors(batchItems);
    }
    console.log(`[BG/Embedding] 对话 ${convId} 的 ${messages.length} 条消息 embedding 完成`);
    return { success: true };
  } catch (e) {
    console.error('[BG/Embedding] 后台 embedding 失败:', e);
    return { success: false, error: e.message };
  }
}

// ===== 数据管理 =====

// 清空向量索引（兼容旧消息，根据当前后端分别处理）
async function handleClearEmbeddings() {
  return await handleClearVectorStore();
}

// 清空向量库（本地=IndexedDB；远程=远程 collection）
async function handleClearVectorStore() {
  try {
    const result = await VectorStore.clearCollection();
    console.log(`[BG] 已清空向量库（后端: ${VectorStore.getBackend()}），结果:`, result);
    return result;
  } catch (e) {
    console.error('[BG] 清空向量库失败:', e);
    return { success: false, error: e.message };
  }
}

// 获取向量库统计
async function handleGetVectorStoreStats() {
  try {
    return await VectorStore.getStats();
  } catch (e) {
    console.error('[BG] 获取向量库统计失败:', e);
    return { error: e.message };
  }
}

// 测试远程向量库连通性（用表单当前值，不依赖已保存设置）
async function handleTestVectorConnection(config) {
  try {
    return await VectorStore.testConnection(config);
  } catch (e) {
    console.error('[BG] 测试向量库连通性失败:', e);
    return { success: false, error: e.message };
  }
}

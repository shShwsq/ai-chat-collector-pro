// bg/init.js - Service Worker 初始化
// 依赖：lib/db.js (initDB), lib/embedding.js (EmbeddingService),
//       lib/vector-store.js (VectorStore), lib/llm.js (LLMService)

let _initPromise = null;

async function initAll() {
  try {
    await initDB();
    console.log('[BG] 数据库初始化完成');
  } catch (e) {
    console.error('[BG] 数据库初始化失败:', e);
  }
  try {
    await EmbeddingService.init();
    await VectorStore.init();
    await LLMService.init();
    console.log('[BG] AI 服务初始化完成');
  } catch (e) {
    console.error('[BG] AI 服务初始化失败:', e);
  }
  // 本地软件对接模块（失败不阻断主流程）
  try {
    await LocalApp_init();
    console.log('[BG] 本地软件对接初始化完成');
  } catch (e) {
    console.error('[BG] 本地软件对接初始化失败:', e);
  }
}

// 确保初始化完成后再处理消息
async function ensureInit() {
  if (_initPromise) {
    await _initPromise;
    _initPromise = null;
  }
}

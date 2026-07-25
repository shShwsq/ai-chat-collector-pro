// background.js - Service Worker 入口
// 仅负责：加载依赖（lib + bg 模块）并启动初始化
// 消息路由见 bg/router.js，各 handler 见 bg/*.js

// 加载依赖（Service Worker 中 importScripts 必须在顶层同步调用）
try {
  // 基础服务层
  importScripts('lib/db.js');
  importScripts('lib/embedding.js');
  importScripts('lib/vector-store.js');
  importScripts('lib/llm.js');
  // SW 业务模块（顺序：init → handlers → router）
  importScripts('bg/init.js');
  importScripts('bg/conversations.js');
  importScripts('bg/export.js');
  importScripts('bg/ai-handlers.js');
  importScripts('bg/settings-handlers.js');
  importScripts('bg/vector-handlers.js');
  importScripts('bg/data-handlers.js');
  importScripts('bg/local-app.js');
  importScripts('bg/router.js');
} catch (e) {
  console.error('[BG] 加载依赖失败:', e);
}

// 启动初始化（router.js 的 ensureInit 会 await 此 Promise）
_initPromise = initAll();

// kimi.js - Kimi 平台主入口
// 依赖：adapter-registry.js, exporter-base.js, ai-ball.js
//
// Kimi 对话流走 WebSocket + protobuf，网络拦截不可用，固定使用 DOM 模式。

(async function() {
  const enabled = await isPlatformEnabled('kimi');
  if (!enabled) {
    console.log('[Exporter] kimi 平台对话提取已禁用，跳过初始化');
    new AIBall();
    return;
  }

  console.log('[Exporter/Kimi] 初始化，模式: dom（Kimi 仅支持 DOM 模式）');
  const exporter = new ChatExporterBase('kimi', EXTRACTION_MODE.DOM);
  new AIBall();
})().catch(err => console.error('[Exporter] kimi 初始化失败:', err.message));

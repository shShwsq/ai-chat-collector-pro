// qianwen.js - 千问 平台入口
// 依赖：adapter-registry.js, exporter-base.js, ai-ball.js

(async function() {
  // 检查该平台是否启用对话提取
  const enabled = await isPlatformEnabled('qianwen');
  if (!enabled) {
    console.log('[Exporter] qianwen 平台对话提取已禁用，跳过初始化');
    new AIBall();
    return;
  }

  const exporter = new ChatExporterBase('qianwen', EXTRACTION_MODE.DOM);

  // AI 问答悬浮球
  new AIBall();
})().catch(err => console.error('[Exporter] qianwen 初始化失败:', err.message));

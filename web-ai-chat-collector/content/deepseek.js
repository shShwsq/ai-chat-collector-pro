// deepseek.js - DeepSeek 平台入口
// 依赖：adapter-registry.js, exporter-base.js, ai-ball.js

(async function() {
  // 检查该平台是否启用对话提取
  const enabled = await isPlatformEnabled('deepseek');
  if (!enabled) {
    console.log('[Exporter] deepseek 平台对话提取已禁用，跳过初始化');
    // AI 问答悬浮球仍保留，便于查询历史对话
    new AIBall();
    return;
  }

  const exporter = new ChatExporterBase('deepseek', EXTRACTION_MODE.DOM);

  // AI 问答悬浮球
  new AIBall();
})().catch(err => console.error('[Exporter] deepseek 初始化失败:', err.message));

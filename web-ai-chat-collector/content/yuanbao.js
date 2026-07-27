// yuanbao.js - 腾讯元宝平台主入口
// 依赖：adapter-registry.js, exporter-base.js, ai-ball.js
//
// 元宝对话流走 WebSocket + 自定义协议，网络拦截不可用，固定使用 DOM 模式。
// DOM 适配器支持三种形态：深度搜索、Agent 模式、简单回答。

(async function() {
  const enabled = await isPlatformEnabled('yuanbao');
  if (!enabled) {
    console.log('[Exporter] yuanbao 平台对话提取已禁用，跳过初始化');
    new AIBall();
    return;
  }

  console.log('[Exporter/Yuanbao] 初始化，模式: dom（元宝仅支持 DOM 模式）');
  const exporter = new ChatExporterBase('yuanbao', EXTRACTION_MODE.DOM);
  new AIBall();
})().catch(err => console.error('[Exporter] yuanbao 初始化失败:', err.message));

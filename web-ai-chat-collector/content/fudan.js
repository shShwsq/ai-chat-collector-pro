// fudan.js - 复旦 AI Agent 平台入口

// 网络拦截器必须在最早时机启动，不能等DOMContentLoaded
// 否则会错过页面初始的API请求
(async function() {
  // 检查该平台是否启用对话提取
  const enabled = await isPlatformEnabled('fudan');
  if (!enabled) {
    console.log('[Exporter] fudan 平台对话提取已禁用，跳过初始化');
    new AIBall();
    return;
  }

  const savedMode = await getPlatformMode('fudan');
  const exporter = new ChatExporterBase('fudan', savedMode);

  // AI 问答悬浮球
  new AIBall();
})().catch(err => console.error('[Exporter] fudan 初始化失败:', err.message));

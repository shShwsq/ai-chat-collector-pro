// wenxin.js - 百度文心平台主入口
// 依赖：adapter-registry.js, exporter-base.js, ai-ball.js
//
// 文心对话流走 WebSocket + 自定义协议，网络拦截不可用，固定使用 DOM 模式。
// 域名：chat.baidu.com / wenxin.baidu.com（同一应用，两个域名均可访问）

(async function() {
  const enabled = await isPlatformEnabled('wenxin');
  if (!enabled) {
    console.log('[Exporter] wenxin 平台对话提取已禁用，跳过初始化');
    new AIBall();
    return;
  }

  console.log('[Exporter/Wenxin] 初始化，模式: dom（文心仅支持 DOM 模式）');
  const exporter = new ChatExporterBase('wenxin', EXTRACTION_MODE.DOM);
  new AIBall();
})().catch(err => console.error('[Exporter] wenxin 初始化失败:', err.message));

/**
 * @file background.js
 * @description KWA Push Demo 的 MV3 service worker。
 *
 * 职责：
 *   1. 通过 importScripts 引入 plugin-sdk/kwa-push.js（UMD 模块，
 *      暴露浏览器全局变量 KwaPush）。
 *   2. 监听 popup 发来的 'push_test_conversation' 消息，调用
 *      KwaPush.pushConversation(payload) 推送到本机后端
 *      POST http://127.0.0.1:8788/api/plugin/conversations。
 *   3. 把成功响应或错误（含 status / attempt / field 等结构化字段）
 *      通过 sendResponse 回传给 popup。
 *
 * 路径说明：
 *   本文件位于 plugin-sdk/example/chrome-extension/background.js，
 *   kwa-push.js 位于 plugin-sdk/kwa-push.js，需上溯两级：
 *     background.js → example/chrome-extension/ → ../ = example/ → ../ = plugin-sdk/
 *   因此 importScripts('../../kwa-push.js')。
 *
 * MV3 注意：
 *   - importScripts 必须在 service worker 顶层同步调用（本文件即是）。
 *   - onMessage 监听器若要异步 sendResponse，必须 return true。
 */

importScripts('../../kwa-push.js');

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === 'push_test_conversation') {
    KwaPush.pushConversation(message.payload)
      .then(function (resp) {
        sendResponse({ ok: true, data: resp });
      })
      .catch(function (err) {
        sendResponse({
          ok: false,
          error: {
            message: err && err.message ? err.message : String(err),
            name: err && err.name ? err.name : 'Error',
            field: err && err.field != null ? err.field : null,
            status: err && err.status != null ? err.status : 0,
            attempt: err && err.attempt != null ? err.attempt : 0,
          },
        });
      });
    return true; // 保持消息通道开启，等待异步 sendResponse
  }
  return false; // 非本监听器关心的消息
});

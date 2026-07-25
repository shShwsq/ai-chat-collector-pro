/**
 * @file kwa-push-handler.js
 * @description 知识工作助手（KWA）二次开发 patch —— 注入到原 web-ai-chat-collector
 *              background.js（Service Worker）的对话推送 handler 模块。
 *
 * 用途：
 *   监听原插件采集对话完成事件（chrome.runtime.onMessage，type='conversation_collected'），
 *   调用 KwaPush.pushConversation 把对话推送到本机知识工作助手后端
 *   `POST /api/plugin/conversations`，由后端持久化为 Observation 待 Agent 抽取。
 *
 * 部署方式：
 *   1. 把本文件与 kwa-push.js 一起复制到 patched 插件根目录。
 *   2. 在 patched 插件 background.js 顶部追加：
 *        importScripts('kwa-push.js', 'kwa-push-handler.js');
 *      （必须在原 importScripts 链之后，确保 KwaPush 全局已就绪）
 *   3. 重载扩展。详见 PATCH-GUIDE.md。
 *
 * 与原插件的集成点：
 *   - 依赖：原插件采集流程在落库后通过 chrome.runtime.sendMessage 发出
 *     { type: 'conversation_collected', payload: { platform, timestamp,
 *       conversationMarkdown, metadata: { conversation_id?, title?, url?, model? } } }
 *     事件。若原插件未发该事件，需在原插件 bg/conversations.js 等处补发
 *     （PATCH-GUIDE.md「进阶改造」一节给出示例）。
 *   - 配置：通过 chrome.storage.local 持久化以下键
 *       - kwaPushEnabled  : boolean，默认 true，是否启用推送
 *       - kwaPushUrl      : string，默认 'http://127.0.0.1:8788/api/plugin/conversations'
 *   - 反馈：每次推送结束后通过 chrome.runtime.sendMessage 发出
 *     { type: 'kwa_push_result', ok: boolean, deduplicated: boolean,
 *       observation_id?: string, error?: string, conversation_id?: string }
 *     便于 popup 显示状态。
 *
 * 节流与重试策略：
 *   - 事件层去抖：相同 metadata.conversation_id 在 500ms 内重复触发只推送一次。
 *   - 网络层重试：交给 SDK 内置的指数退避（默认 500ms / 1000ms / 2000ms 共 3 次），
 *     本层不再叠加重试。
 *
 * 鉴权风险提示：
 *   本 patch 与后端约定「暂不鉴权」，仅适用于本机环境（loopback）。
 *   若后端部署到公网，请自行在反代层加 token / Origin 校验。
 */

(function () {
  'use strict';

  // 仅在 Service Worker / background 上下文运行
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
    console.warn('[KWA-Push] 非 background 上下文，handler 不注册');
    return;
  }

  // 确保 KwaPush 全局可用（由 kwa-push.js 提供）
  if (typeof self.KwaPush === 'undefined') {
    console.error(
      '[KWA-Push] KwaPush 全局未就绪，请确认 background.js 中 importScripts 顺序：' +
        "importScripts('kwa-push.js', 'kwa-push-handler.js');"
    );
    return;
  }

  var KwaPush = self.KwaPush;

  /** 默认推送端点（本机知识工作助手后端）。 */
  var DEFAULT_PUSH_URL = 'http://127.0.0.1:8788/api/plugin/conversations';
  /** 相同 conversation_id 的去抖窗口（毫秒）。 */
  var DEDUP_WINDOW_MS = 500;

  /** 最近推送过的 conversation_id → 时间戳，用于 500ms 去抖。 */
  var recentPushed = Object.create(null);

  /**
   * 读取 chrome.storage.local 中的配置。
   * @returns {Promise<{enabled: boolean, url: string}>}
   */
  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(
          ['kwaPushEnabled', 'kwaPushUrl'],
          function (items) {
            var enabled = true;
            if (
              items &&
              typeof items.kwaPushEnabled === 'boolean'
            ) {
              enabled = items.kwaPushEnabled;
            }
            var url =
              items && typeof items.kwaPushUrl === 'string' && items.kwaPushUrl
                ? items.kwaPushUrl
                : DEFAULT_PUSH_URL;
            resolve({ enabled: enabled, url: url });
          }
        );
      } catch (e) {
        // 极端情况下（如 storage 不可用）退回默认值
        resolve({ enabled: true, url: DEFAULT_PUSH_URL });
      }
    });
  }

  /**
   * 反向通知 popup 推送结果。
   * 用 sendMessage 广播，popup 监听方按 type='kwa_push_result' 过滤即可。
   *
   * @param {Object} result
   * @param {boolean} result.ok
   * @param {boolean} [result.deduplicated]
   * @param {string} [result.observation_id]
   * @param {string} [result.error]
   * @param {string} [result.conversation_id]
   */
  function notifyResult(result) {
    try {
      chrome.runtime.sendMessage(
        Object.assign({ type: 'kwa_push_result' }, result),
        // SW 中无 popup 时会触发"Receiving end does not exist"错误，吞掉即可
        function () {
          if (chrome.runtime.lastError) {
            // 静默忽略：popup 未打开属正常情况
          }
        }
      );
    } catch (e) {
      // 静默忽略
    }
  }

  /**
   * 事件层去抖：500ms 内相同 conversation_id 只允许一次推送。
   *
   * @param {string|null|undefined} conversationId
   * @returns {boolean} true 表示放行（首次或已过窗口）；false 表示本次应跳过。
   */
  function shouldThrottle(conversationId) {
    if (!conversationId) return true; // 无 id 不去重，直接放行
    var now = Date.now();
    var last = recentPushed[conversationId];
    if (last != null && now - last < DEDUP_WINDOW_MS) {
      return false; // 命中去抖，跳过本次
    }
    recentPushed[conversationId] = now;
    return true;
  }

  /**
   * 处理 conversation_collected 事件：组装 payload 调用 SDK 推送。
   *
   * @param {Object} payload 原插件发出的事件 payload
   * @param {string} payload.platform
   * @param {string} payload.timestamp
   * @param {string} payload.conversationMarkdown
   * @param {Object} [payload.metadata]
   * @param {string} [payload.metadata.conversation_id]
   * @param {string} [payload.metadata.title]
   * @param {string} [payload.metadata.url]
   * @param {string} [payload.metadata.model]
   * @returns {Promise<void>}
   */
  async function handleConversationCollected(payload) {
    if (!payload || typeof payload !== 'object') {
      console.warn('[KWA-Push] conversation_collected payload 非对象，已忽略');
      return;
    }

    var cfg = await loadConfig();
    if (!cfg.enabled) {
      // 开关关闭：静默跳过，不打扰用户
      return;
    }

    var conversationId =
      payload.metadata && payload.metadata.conversation_id
        ? String(payload.metadata.conversation_id)
        : null;

    // 500ms 去抖
    if (!shouldThrottle(conversationId)) {
      console.debug(
        '[KWA-Push] 500ms 内重复 conversation_id，跳过本次推送:',
        conversationId
      );
      return;
    }

    // 组装 SDK 调用参数（camelCase，SDK 内部会转 snake_case）
    var pushOptions = {
      platform: payload.platform,
      timestamp: payload.timestamp,
      conversationMarkdown: payload.conversationMarkdown,
      metadata: payload.metadata || {},
    };

    try {
      var result = await KwaPush.pushConversation(pushOptions, {
        webhookUrl: cfg.url,
      });
      console.info(
        '[KWA-Push] 推送成功 ok=' +
          result.received +
          ' deduplicated=' +
          result.deduplicated +
          ' observation_id=' +
          result.observation_id
      );
      notifyResult({
        ok: true,
        deduplicated: !!result.deduplicated,
        observation_id: result.observation_id || '',
        conversation_id: conversationId || '',
      });
    } catch (err) {
      var errMsg =
        err && err.message ? err.message : String(err);
      console.error('[KWA-Push] 推送失败:', errMsg, err);
      notifyResult({
        ok: false,
        deduplicated: false,
        error: errMsg,
        conversation_id: conversationId || '',
      });
    }
  }

  // ==========================================================================
  // 注册 chrome.runtime.onMessage 监听
  // ==========================================================================
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== 'object') return;
    if (message.type !== 'conversation_collected') return;

    // 异步处理，立即返回 true 以保持 sendResponse 通道开放（虽然这里不依赖回调返回值）
    handleConversationCollected(message.payload)
      .catch(function (e) {
        console.error('[KWA-Push] handleConversationCollected 异常:', e);
      })
      .finally(function () {
        // 主动回复 ack，避免原插件方等待
        try {
          sendResponse({ ack: true });
        } catch (_) {}
      });

    return true; // 表示将异步调用 sendResponse
  });

  console.info(
    '[KWA-Push] kwa-push-handler 已加载，监听 conversation_collected 事件'
  );
})();

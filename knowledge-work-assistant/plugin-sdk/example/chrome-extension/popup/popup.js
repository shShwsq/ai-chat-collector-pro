/**
 * @file popup.js
 * @description KWA Push Demo 弹窗逻辑。
 *
 * 行为：
 *   1. 显示默认 Webhook URL 与一段固定的测试对话 Markdown 预览。
 *   2. 点击「推送测试对话」按钮时，构造测试对话 payload（camelCase 字段，
 *      与 kwa-push.js 的 pushConversation options 对齐），通过
 *      chrome.runtime.sendMessage 发送给 background.js。
 *   3. background.js 调用 KwaPush.pushConversation 推送到后端，并把结果
 *      回传给本脚本渲染到结果区（成功 / 失败 / 去重信息）。
 *
 * 注意：
 *   - 测试对话的 conversation_id 使用 'kwa-demo-' + Date.now()，
 *     每次点击都不同，后端不会去重；如需观察去重，可手动固定该值。
 *   - popup 与 background 之间通过 chrome.runtime.sendMessage 通信，
 *     background 需在 onMessage 监听器中 return true 才能异步 sendResponse。
 */

(function () {
  'use strict';

  var WEBHOOK_URL = 'http://127.0.0.1:8788/api/plugin/conversations';

  // 固定的测试对话 Markdown（含 user / assistant 两轮）
  var TEST_MARKDOWN = [
    '# KWA 示例对话',
    '',
    '## user',
    '',
    '请用一句话介绍知识工作助手（KWA）的推送 SDK。',
    '',
    '## assistant',
    '',
    'KWA 推送 SDK（kwa-push.js）是一个 UMD 模块，导出 pushConversation 函数，',
    '将采集到的 AI 对话以 Markdown 形式推送到本机后端 POST /api/plugin/conversations，',
    '由后端持久化为 Observation 原始记录，待后续 Agent 抽取知识点。',
    '',
  ].join('\n');

  var pushBtn = document.getElementById('push-btn');
  var resultEl = document.getElementById('result');
  var webhookUrlEl = document.getElementById('webhook-url');
  var previewEl = document.getElementById('preview');

  // 初始化静态展示
  webhookUrlEl.textContent = WEBHOOK_URL;
  previewEl.textContent = TEST_MARKDOWN;

  function setResult(state, text) {
    resultEl.className = 'result result-' + state;
    resultEl.textContent = text;
  }

  function buildPayload() {
    return {
      platform: 'custom',
      timestamp: new Date().toISOString(),
      conversationMarkdown: TEST_MARKDOWN,
      metadata: {
        conversation_id: 'kwa-demo-' + Date.now(),
        title: 'KWA 示例对话',
      },
    };
  }

  function renderSuccess(data) {
    var lines = [
      '[成功] 推送完成',
      'received: ' + (data && data.received === true),
      'deduplicated: ' + (data && data.deduplicated === true),
      'observation_id: ' + (data && data.observation_id ? data.observation_id : '(空)'),
    ];
    setResult('success', lines.join('\n'));
  }

  function renderError(err) {
    var lines = ['[失败] 推送未完成'];
    lines.push('name: ' + (err && err.name ? err.name : 'unknown'));
    lines.push('message: ' + (err && err.message ? err.message : '(no message)'));
    if (err && err.field != null && err.field !== '') {
      lines.push('field: ' + err.field);
    }
    if (err && err.status != null && err.status !== 0) {
      lines.push('status: ' + err.status);
    }
    if (err && err.attempt != null) {
      lines.push('attempt: ' + err.attempt);
    }
    setResult('error', lines.join('\n'));
  }

  pushBtn.addEventListener('click', function () {
    pushBtn.disabled = true;
    setResult('pending', '推送中...');

    var message = {
      type: 'push_test_conversation',
      payload: buildPayload(),
    };

    chrome.runtime.sendMessage(message, function (resp) {
      pushBtn.disabled = false;

      if (chrome.runtime.lastError) {
        renderError({
          name: 'RuntimeError',
          message: chrome.runtime.lastError.message || 'chrome.runtime 通道错误',
        });
        return;
      }

      if (!resp) {
        renderError({
          name: 'NoResponse',
          message: '未收到 background.js 的回应',
        });
        return;
      }

      if (resp.ok) {
        renderSuccess(resp.data);
      } else {
        renderError(resp.error);
      }
    });
  });
})();

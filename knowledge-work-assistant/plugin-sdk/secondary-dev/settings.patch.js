/**
 * @file settings.patch.js
 * @description 知识工作助手（KWA）二次开发 patch —— 注入到原 popup/settings.js 的 IIFE 模块。
 *
 * 用途：
 *   在原插件设置页（popup/settings.html）动态注入「知识工作助手推送」分区，
 *   提供：开关 / 推送目标 URL 输入框 / 测试推送按钮 / 状态显示。
 *   配置持久化到 chrome.storage.local；测试推送调用 KwaPush.pushConversation
 *   发送一条空对话验证连通性。
 *
 * 引入方式：
 *   1. 把本文件复制到 patched 插件 popup/ 目录。
 *   2. 把 settings.patch.html 也复制到 popup/ 目录（本脚本会 fetch 该文件内容注入 DOM）。
 *   3. 在 patched 插件 popup/settings.html 的 </body> 之前追加：
 *        <script src="../kwa-push.js"></script>
 *        <script src="settings.patch.js"></script>
 *      （KwaPush 必须先于本脚本加载，否则测试推送会回退到 chrome.runtime 转发）
 *   4. 详见 PATCH-GUIDE.md。
 *
 * 与原 settings.js 的关系：
 *   原插件 popup 不是 Service Worker，不能用 importScripts。
 *   本文件以 IIFE 自执行方式运行，挂在 DOMContentLoaded 上，
 *   不污染原 settings.js 的全局变量。
 */

(function () {
  'use strict';

  /** 默认推送端点。 */
  var DEFAULT_PUSH_URL = 'http://127.0.0.1:8788/api/plugin/conversations';
  /** 配置存储键。 */
  var STORAGE_KEY_ENABLED = 'kwaPushEnabled';
  var STORAGE_KEY_URL = 'kwaPushUrl';
  /** patch HTML 片段文件名（与本文件同目录）。 */
  var PATCH_HTML_NAME = 'settings.patch.html';

  // ==========================================================================
  // 工具：读取 / 保存配置
  // ==========================================================================

  /**
   * 从 chrome.storage.local 读取配置。
   * @returns {Promise<{enabled: boolean, url: string}>}
   */
  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(
          [STORAGE_KEY_ENABLED, STORAGE_KEY_URL],
          function (items) {
            var enabled = true;
            if (
              items &&
              typeof items[STORAGE_KEY_ENABLED] === 'boolean'
            ) {
              enabled = items[STORAGE_KEY_ENABLED];
            }
            var url =
              items &&
              typeof items[STORAGE_KEY_URL] === 'string' &&
              items[STORAGE_KEY_URL]
                ? items[STORAGE_KEY_URL]
                : DEFAULT_PUSH_URL;
            resolve({ enabled: enabled, url: url });
          }
        );
      } catch (e) {
        resolve({ enabled: true, url: DEFAULT_PUSH_URL });
      }
    });
  }

  /**
   * 保存配置到 chrome.storage.local。
   * @param {Object} patch
   * @param {boolean} patch.enabled
   * @param {string} patch.url
   * @returns {Promise<void>}
   */
  function saveConfig(patch) {
    return new Promise(function (resolve) {
      var obj = {};
      if (patch.enabled != null) obj[STORAGE_KEY_ENABLED] = patch.enabled;
      if (patch.url != null) obj[STORAGE_KEY_URL] = patch.url;
      try {
        chrome.storage.local.set(obj, function () {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // ==========================================================================
  // 工具：在原 settings.html 中定位「数据管理」section 作为插入锚点
  // ==========================================================================

  /**
   * 找到「数据管理」section 元素。
   * 策略：
   *   1. 优先按 .danger-zone + 内文含「数据管理」匹配；
   *   2. 退而求其次：所有 .setting-section 中 h2 文本含「数据管理」的；
   *   3. 都找不到时返回 null（调用方决定 fallback 行为）。
   *
   * @returns {Element|null}
   */
  function findDataManagementSection() {
    var sections = document.querySelectorAll('section.setting-section');
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      var isDanger = sec.classList.contains('danger-zone');
      var h2 = sec.querySelector('h2');
      var text = h2 ? (h2.textContent || '').trim() : '';
      if (isDanger || text.indexOf('数据管理') >= 0) {
        return sec;
      }
    }
    return null;
  }

  /**
   * 把 patch HTML 片段注入到「数据管理」section 之前。
   * 若该 section 不存在，则追加到 .container 末尾。
   *
   * @param {string} htmlStr settings.patch.html 文件内容
   * @returns {boolean} 是否注入成功
   */
  function injectPatchHtml(htmlStr) {
    if (document.getElementById('kwaPushSection')) {
      // 已注入，幂等
      return true;
    }
    var container = document.querySelector('.container') || document.body;
    var anchor = findDataManagementSection();

    // 用 DOMParser 解析，避免 innerHTML 整体回流
    var parser = new DOMParser();
    var doc = parser.parseFromString('<root>' + htmlStr + '</root>', 'text/html');
    var sectionNode = doc.querySelector('#kwaPushSection');
    if (!sectionNode) {
      console.error('[KWA-Patch] settings.patch.html 中未找到 #kwaPushSection');
      return false;
    }
    var node = document.importNode(sectionNode, true);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(node, anchor);
    } else {
      container.appendChild(node);
    }
    return true;
  }

  // ==========================================================================
  // 工具：状态显示
  // ==========================================================================

  /**
   * 设置 #kwaPushStatus 的内容与颜色。
   * @param {string} msg
   * @param {'idle'|'success'|'dedup'|'error'|'loading'} kind
   */
  function setStatus(msg, kind) {
    var el = document.getElementById('kwaPushStatus');
    if (!el) return;
    el.textContent = msg;
    var color = '';
    switch (kind) {
      case 'success':
        color = '#15803d';
        break;
      case 'dedup':
        color = '#1d4ed8';
        break;
      case 'error':
        color = '#b91c1c';
        break;
      case 'loading':
        color = '#6b7280';
        break;
      default:
        color = '#6b7280';
    }
    el.style.color = color;
  }

  // ==========================================================================
  // 测试推送
  // ==========================================================================

  /**
   * 构造一条测试对话的推送参数。
   * @returns {{platform: string, timestamp: string, conversationMarkdown: string, metadata: {conversation_id: string, title: string}}}
   */
  function buildTestPayload() {
    return {
      platform: 'custom',
      timestamp: new Date().toISOString(),
      conversationMarkdown:
        '## 用户\n测试推送\n\n## 助手\n收到，连通性正常',
      metadata: {
        conversation_id: 'kwa-test-' + Date.now(),
        title: '连通性测试',
      },
    };
  }

  /**
   * 通过 chrome.runtime.sendMessage 转发测试请求到 background。
   * 当 popup 未引入 kwa-push.js 时使用此回退通道。
   *
   * @param {string} url 推送目标 URL
   * @returns {Promise<{ok: boolean, deduplicated: boolean, observation_id?: string, error?: string}>}
   */
  function pushViaBackground(url) {
    return new Promise(function (resolve) {
      var payload = buildTestPayload();
      try {
        chrome.runtime.sendMessage(
          {
            type: 'kwa_push_test',
            payload: payload,
            webhookUrl: url,
          },
          function (resp) {
            if (chrome.runtime.lastError || !resp) {
              resolve({
                ok: false,
                deduplicated: false,
                error:
                  (chrome.runtime.lastError &&
                    chrome.runtime.lastError.message) ||
                  'background 无响应',
              });
              return;
            }
            resolve(resp);
          }
        );
      } catch (e) {
        resolve({
          ok: false,
          deduplicated: false,
          error: String(e && e.message ? e.message : e),
        });
      }
    });
  }

  /**
   * 执行一次测试推送：优先用 popup 内 KwaPush 全局，否则回退到 background 转发。
   *
   * @param {string} url 推送目标 URL
   * @returns {Promise<{ok: boolean, deduplicated: boolean, observation_id?: string, error?: string}>}
   */
  async function runTestPush(url) {
    // 优先：popup 内 KwaPush 全局可用
    if (typeof window.KwaPush !== 'undefined' && window.KwaPush.pushConversation) {
      try {
        var result = await window.KwaPush.pushConversation(buildTestPayload(), {
          webhookUrl: url,
        });
        return {
          ok: !!result.received,
          deduplicated: !!result.deduplicated,
          observation_id: result.observation_id || '',
        };
      } catch (err) {
        return {
          ok: false,
          deduplicated: false,
          error: err && err.message ? err.message : String(err),
        };
      }
    }
    // 回退：通过 background 转发
    return await pushViaBackground(url);
  }

  // ==========================================================================
  // 绑定事件
  // ==========================================================================

  /**
   * 绑定开关 / URL 输入 / 测试按钮事件，并从 storage 回填表单。
   *
   * @returns {Promise<void>}
   */
  async function bindPatchEvents() {
    var checkbox = document.getElementById('kwaPushEnabled');
    var urlInput = document.getElementById('kwaPushUrl');
    var testBtn = document.getElementById('kwaPushTestBtn');
    if (!checkbox || !urlInput || !testBtn) {
      console.error('[KWA-Patch] patch 元素未就绪，事件绑定失败');
      return;
    }

    // 回填
    var cfg = await loadConfig();
    checkbox.checked = !!cfg.enabled;
    urlInput.value = cfg.url || DEFAULT_PUSH_URL;

    // 开关变化：立即保存
    checkbox.addEventListener('change', function () {
      saveConfig({ enabled: !!checkbox.checked });
    });

    // URL 变化：失焦时保存（避免每次按键都写 storage）
    urlInput.addEventListener('blur', function () {
      var v = (urlInput.value || '').trim();
      if (!v) {
        v = DEFAULT_PUSH_URL;
        urlInput.value = v;
      }
      saveConfig({ url: v });
    });

    // 测试推送
    testBtn.addEventListener('click', async function () {
      var url = (urlInput.value || '').trim() || DEFAULT_PUSH_URL;
      // 顺手把当前 URL 保存
      await saveConfig({ url: url });
      testBtn.disabled = true;
      setStatus('正在推送…', 'loading');
      try {
        var r = await runTestPush(url);
        if (r.ok && !r.deduplicated) {
          setStatus(
            '✓ 推送成功 observation_id=' + (r.observation_id || ''),
            'success'
          );
        } else if (r.ok && r.deduplicated) {
          setStatus('✓ 已存在（去重）', 'dedup');
        } else {
          setStatus('✗ 推送失败：' + (r.error || '未知错误'), 'error');
        }
      } catch (e) {
        setStatus(
          '✗ 推送失败：' + (e && e.message ? e.message : String(e)),
          'error'
        );
      } finally {
        testBtn.disabled = false;
      }
    });
  }

  // ==========================================================================
  // 入口
  // ==========================================================================

  /**
   * 加载 patch HTML 并注入 + 绑定事件。
   * 优先 fetch(settings.patch.html)，失败时回退到内嵌 HTML 字符串（保证离线可用）。
   */
  async function bootstrap() {
    var htmlStr = '';
    try {
      // popup 内 chrome.runtime.getURL('popup/settings.patch.html')
      var url = chrome.runtime.getURL('popup/' + PATCH_HTML_NAME);
      var resp = await fetch(url);
      if (resp.ok) {
        htmlStr = await resp.text();
      }
    } catch (e) {
      // fetch 失败时静默回退到内嵌字符串
    }

    if (!htmlStr || htmlStr.indexOf('kwaPushSection') < 0) {
      // 内嵌兜底（与 settings.patch.html 同步）
      htmlStr = FALLBACK_HTML;
    }

    injectPatchHtml(htmlStr);
    await bindPatchEvents();
  }

  // ==========================================================================
  // 内嵌兜底 HTML（与 settings.patch.html 内容保持一致）
  // ==========================================================================

  var FALLBACK_HTML = [
    '<section class="setting-section" id="kwaPushSection">',
    '  <h2>知识工作助手推送</h2>',
    '  <p class="desc">把采集到的对话自动推送到本机知识工作助手后端</p>',
    '  <div class="form-group">',
    '    <div class="checkbox-row">',
    '      <input type="checkbox" id="kwaPushEnabled" checked />',
    '      <label for="kwaPushEnabled">启用自动推送</label>',
    '    </div>',
    '    <small>关闭后，对话采集完成时不再自动推送到知识工作助手后端</small>',
    '  </div>',
    '  <div class="form-group">',
    '    <label>推送目标 URL</label>',
    '    <input type="text" id="kwaPushUrl" placeholder="' + DEFAULT_PUSH_URL + '" value="' + DEFAULT_PUSH_URL + '" />',
    '    <small>知识工作助手后端的对话接收端点；默认本机 8788 端口</small>',
    '  </div>',
    '  <div class="form-group">',
    '    <button class="btn" id="kwaPushTestBtn">测试推送</button>',
    '    <small>说明：测试推送会发送一条空对话到后端验证连通性</small>',
    '  </div>',
    '  <div class="form-group">',
    '    <label>测试结果</label>',
    '    <div id="kwaPushStatus" class="info-text" style="min-height: 20px; word-break: break-word;">未测试</div>',
    '  </div>',
    '</section>',
  ].join('\n');

  // ==========================================================================
  // 注册 background 端的 kwa_push_test 转发 handler（仅在 background 中有效，
  // popup 中此段无副作用，因为 chrome.runtime.onMessage 在 popup 中通常不会触发自己发出的事件）
  // ==========================================================================
  if (
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    chrome.runtime.onMessage
  ) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'kwa_push_test') return;
      // 仅在 background 上下文（KwaPush 可见）中处理
      var KwaPush =
        typeof self !== 'undefined'
          ? self.KwaPush
          : typeof window !== 'undefined'
          ? window.KwaPush
          : undefined;
      if (!KwaPush || !KwaPush.pushConversation) {
        sendResponse({
          ok: false,
          deduplicated: false,
          error: 'KwaPush SDK 未加载',
        });
        return false;
      }
      KwaPush.pushConversation(message.payload, {
        webhookUrl: message.webhookUrl,
      })
        .then(function (r) {
          sendResponse({
            ok: !!r.received,
            deduplicated: !!r.deduplicated,
            observation_id: r.observation_id || '',
          });
        })
        .catch(function (e) {
          sendResponse({
            ok: false,
            deduplicated: false,
            error: e && e.message ? e.message : String(e),
          });
        });
      return true; // async
    });
  }

  // ==========================================================================
  // DOMContentLoaded：注入 + 绑定
  // ==========================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bootstrap().catch(function (e) {
        console.error('[KWA-Patch] bootstrap 失败:', e);
      });
    });
  } else {
    // settings.js 已在 DOMContentLoaded 中跑过，这里直接 bootstrap
    bootstrap().catch(function (e) {
      console.error('[KWA-Patch] bootstrap 失败:', e);
    });
  }
})();

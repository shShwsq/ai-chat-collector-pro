/**
 * @file kwa-push.js
 * @description 知识工作助手（KWA）浏览器插件推送 SDK。
 *
 * 用途：
 *   供浏览器插件（如二次开发后的 web-ai-chat-collector）调用，将采集到的
 *   AI 对话推送到本机后端 `POST /api/plugin/conversations`，由后端持久化为
 *   Observation 原始记录，待后续 Agent 抽取知识点。
 *
 * 鉴权风险提示（重要）：
 *   本 SDK 与后端约定「暂不鉴权」，仅适用于本机开发环境（loopback）。
 *   若将后端部署到公网或局域网，请自行在反向代理层加 token / Origin 校验，
 *   否则任何能访问该端点的客户端均可写入数据。详见 README.md「风险提示」一节。
 *
 * 模块格式：
 *   UMD（兼容 CommonJS / AMD / 浏览器全局变量 `KwaPush`）。
 *
 * 依赖：
 *   - fetch API（浏览器与 Node 18+ 原生支持）
 *   - AbortController（同上）
 *
 * 对齐契约：
 *   后端请求体字段为 snake_case（platform / timestamp / conversation_markdown /
 *   metadata），SDK 对外暴露 camelCase（conversationMarkdown），内部自动转换。
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KwaPush = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================================================
  // 默认配置常量
  // ==========================================================================

  /** 后端默认推送端点（本机环境）。 */
  var DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:8788/api/plugin/conversations';
  /** 单次请求超时（毫秒）。 */
  var DEFAULT_TIMEOUT = 10000;
  /** 失败重试次数上限（不含首次尝试）。 */
  var DEFAULT_MAX_RETRIES = 3;
  /** 指数退避基数（毫秒），实际等待 = retryDelayMs * 2^attempt。 */
  var DEFAULT_RETRY_DELAY_MS = 500;

  /**
   * 支持的来源平台白名单（与后端 `routers/plugin.py` 的 SUPPORTED_PLATFORMS 对齐）。
   * `custom` 用于插件自定义 / 未列举的平台兜底。
   */
  var SUPPORTED_PLATFORMS = [
    'chatgpt',
    'claude',
    'gemini',
    'deepseek',
    'qwen',
    'doubao',
    'kimi',
    'fudan',
    'custom',
  ];

  // ==========================================================================
  // 错误类
  // ==========================================================================

  /**
   * 推送过程中产生的运行时错误（网络错误 / 超时 / 5xx / 重试耗尽）。
   *
   * @property {number} status   HTTP 状态码；网络错误 / 超时 / 取消时为 0。
   * @property {number} attempt  失败时所处的尝试序号（0 表示首次尝试）。
   * @property {*} responseBody  后端返回的解析后响应体（若可解析为 JSON）。
   */
  function KwaPushError(message, options) {
    this.name = 'KwaPushError';
    this.message = message || 'KwaPush error';
    this.status = options && options.status != null ? options.status : 0;
    this.attempt = options && options.attempt != null ? options.attempt : 0;
    this.responseBody = options ? options.responseBody : undefined;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  KwaPushError.prototype = Object.create(Error.prototype);
  KwaPushError.prototype.constructor = KwaPushError;

  /**
   * 客户端校验失败（字段缺失 / 类型不符 / 空值）时抛出。
   *
   * @property {string|null} field  出错字段名（platform / timestamp / conversationMarkdown / metadata / options）。
   */
  function KwaPushValidationError(message, field) {
    this.name = 'KwaPushValidationError';
    this.message = message || 'KwaPush validation error';
    this.field = field != null ? field : null;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  KwaPushValidationError.prototype = Object.create(Error.prototype);
  KwaPushValidationError.prototype.constructor = KwaPushValidationError;

  // ==========================================================================
  // 全局默认配置（可通过 configure() 覆写）
  // ==========================================================================

  var globalConfig = {
    webhookUrl: DEFAULT_WEBHOOK_URL,
    timeout: DEFAULT_TIMEOUT,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  };

  /**
   * 配置全局默认值，后续 `pushConversation` 调用若未传 config 则使用此处的值。
   *
   * @param {Object} options
   * @param {string} [options.webhookUrl]   后端推送端点 URL。
   * @param {number} [options.timeout]      单次请求超时（毫秒）。
   * @param {number} [options.maxRetries]   失败重试次数上限（不含首次）。
   * @param {number} [options.retryDelayMs] 指数退避基数（毫秒）。
   * @returns {void}
   */
  function configure(options) {
    if (!options) return;
    if (options.webhookUrl != null) globalConfig.webhookUrl = options.webhookUrl;
    if (options.timeout != null) globalConfig.timeout = options.timeout;
    if (options.maxRetries != null) globalConfig.maxRetries = options.maxRetries;
    if (options.retryDelayMs != null) globalConfig.retryDelayMs = options.retryDelayMs;
  }

  /**
   * 合并配置：base（默认 globalConfig）→ explicit（调用方传入）。
   * signal 字段不继承自 base，仅当 explicit 显式提供时采用。
   *
   * @param {Object} [explicit] 调用方传入的覆写项。
   * @param {Object} [base]     基础配置（默认 globalConfig；createClient 传 clientConfig）。
   * @returns {Object} 合并后的完整配置对象。
   */
  function mergeConfig(explicit, base) {
    var b = base || globalConfig;
    var merged = {
      webhookUrl: b.webhookUrl,
      timeout: b.timeout,
      maxRetries: b.maxRetries,
      retryDelayMs: b.retryDelayMs,
      signal: null,
    };
    if (b.signal != null) merged.signal = b.signal;
    if (explicit) {
      if (explicit.webhookUrl != null) merged.webhookUrl = explicit.webhookUrl;
      if (explicit.timeout != null) merged.timeout = explicit.timeout;
      if (explicit.maxRetries != null) merged.maxRetries = explicit.maxRetries;
      if (explicit.retryDelayMs != null) merged.retryDelayMs = explicit.retryDelayMs;
      if (explicit.signal != null) merged.signal = explicit.signal;
    }
    return merged;
  }

  // ==========================================================================
  // 客户端校验
  // ==========================================================================

  /**
   * 推送前对 options 做基本校验。
   *
   * 校验规则：
   * - options 必须为对象
   * - platform 非空 string
   * - timestamp 非空 string
   * - conversationMarkdown 非空 string
   * - metadata 若提供必须为对象（非数组）
   *
   * 注意：platform 白名单校验由后端完成，SDK 仅做非空校验（'custom' 兜底）。
   *
   * @param {Object} options 推送参数。
   * @throws {KwaPushValidationError} 校验失败时抛出。
   */
  function validateOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new KwaPushValidationError(
        'pushConversation options is required and must be an object',
        'options'
      );
    }
    if (!options.platform || typeof options.platform !== 'string') {
      throw new KwaPushValidationError(
        'platform is required and must be a non-empty string',
        'platform'
      );
    }
    if (!options.timestamp || typeof options.timestamp !== 'string') {
      throw new KwaPushValidationError(
        'timestamp is required and must be a non-empty string (ISO8601)',
        'timestamp'
      );
    }
    if (
      !options.conversationMarkdown ||
      typeof options.conversationMarkdown !== 'string'
    ) {
      throw new KwaPushValidationError(
        'conversationMarkdown is required and must be a non-empty string',
        'conversationMarkdown'
      );
    }
    if (
      options.metadata != null &&
      (typeof options.metadata !== 'object' || Array.isArray(options.metadata))
    ) {
      throw new KwaPushValidationError(
        'metadata must be an object if provided',
        'metadata'
      );
    }
  }

  // ==========================================================================
  // 网络层
  // ==========================================================================

  /**
   * 可被 AbortSignal 取消的延迟函数。
   *
   * @param {number} ms             等待毫秒数。
   * @param {AbortSignal} [signal]  外部取消信号。
   * @returns {Promise<void>} resolve 表示等待完成；reject 表示被取消。
   */
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(
          new KwaPushError('aborted by signal during backoff', {
            status: 0,
            attempt: 0,
          })
        );
        return;
      }
      var onAbort = function () {
        clearTimeout(timer);
        reject(
          new KwaPushError('aborted by signal during backoff', {
            status: 0,
            attempt: 0,
          })
        );
      };
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }

  /**
   * 执行一次 HTTP POST 请求。
   *
   * - 用 AbortController 实现超时控制。
   * - 若外部 signal 触发 abort，联动取消当前请求。
   * - 网络错误 / 超时 / 外部取消 均抛 KwaPushError（status=0）。
   * - HTTP 响应（无论 2xx / 4xx / 5xx）均返回结构化结果，不抛错。
   *
   * @param {string} url        目标 URL。
   * @param {Object} body       请求体（已序列化前的对象）。
   * @param {number} timeout    超时毫秒。
   * @param {AbortSignal} [outerSignal] 调用方传入的取消信号。
   * @returns {Promise<{ok: boolean, status: number, body: *, rawText: string}>}
   */
  function doFetchOnce(url, body, timeout, outerSignal) {
    if (typeof fetch === 'undefined') {
      return Promise.reject(
        new KwaPushError(
          'fetch is not available in this environment (require Node 18+ or a modern browser)',
          { status: 0, attempt: 0 }
        )
      );
    }
    if (typeof AbortController === 'undefined') {
      return Promise.reject(
        new KwaPushError(
          'AbortController is not available in this environment',
          { status: 0, attempt: 0 }
        )
      );
    }

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeout);

    function onOuterAbort() {
      controller.abort();
    }
    if (outerSignal) {
      if (outerSignal.aborted) {
        controller.abort();
      } else {
        outerSignal.addEventListener('abort', onOuterAbort);
      }
    }

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          var parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch (_) {
              parsed = null;
            }
          }
          return {
            ok: resp.ok,
            status: resp.status,
            body: parsed,
            rawText: text,
          };
        });
      })
      .catch(function (err) {
        // 区分 abort 来源：外部 signal 取消 / 超时 / 网络错误
        if (err && err.name === 'AbortError') {
          if (outerSignal && outerSignal.aborted) {
            throw new KwaPushError('aborted by caller signal', {
              status: 0,
              attempt: 0,
            });
          }
          throw new KwaPushError(
            'request timed out after ' + timeout + 'ms',
            { status: 0, attempt: 0 }
          );
        }
        throw new KwaPushError(
          'network error: ' + (err && err.message ? err.message : String(err)),
          { status: 0, attempt: 0 }
        );
      })
      .then(
        function (result) {
          // finally 语义：清理 timer 与 listener
          clearTimeout(timer);
          if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
          return result;
        },
        function (err) {
          clearTimeout(timer);
          if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
          throw err;
        }
      );
  }

  // ==========================================================================
  // 核心推送函数
  // ==========================================================================

  /**
   * 推送一条 AI 对话到后端。
   *
   * 行为：
   * 1. 客户端基本校验（platform / timestamp / conversationMarkdown 非空）。
   * 2. 将 camelCase 字段转为后端 snake_case 契约（conversationMarkdown → conversation_markdown）。
   * 3. 通过 fetch POST 到 webhookUrl，带超时控制。
   * 4. 失败重试：仅对网络错误与 5xx 重试，4xx 不重试；指数退避 `retryDelayMs * 2^attempt`。
   * 5. 重试到达上限后抛出 KwaPushError（含 status / attempt 字段）。
   *
   * @param {Object} options
   * @param {string} options.platform            来源平台，如 'deepseek'。
   * @param {string} options.timestamp           对话发生时间，ISO8601 字符串。
   * @param {string} options.conversationMarkdown 对话原文 Markdown（非空）。
   * @param {Object} [options.metadata]          可选元数据；强烈推荐填 conversation_id 用于幂等去重。
   * @param {Object} [config]
   * @param {string} [config.webhookUrl]         默认 'http://127.0.0.1:8788/api/plugin/conversations'。
   * @param {number} [config.timeout]            默认 10000 ms。
   * @param {number} [config.maxRetries]         默认 3。
   * @param {number} [config.retryDelayMs]       默认 500（指数退避基数）。
   * @param {AbortSignal} [config.signal]        可选，支持取消。
   * @returns {Promise<{received: boolean, deduplicated: boolean, observation_id: string}>}
   *
   * @throws {KwaPushValidationError} 客户端校验失败。
   * @throws {KwaPushError} 网络错误 / 超时 / 4xx / 5xx / 重试耗尽。
   */
  async function pushConversation(options, config) {
    validateOptions(options);

    var cfg = mergeConfig(config);
    var payload = {
      platform: options.platform,
      timestamp: options.timestamp,
      conversation_markdown: options.conversationMarkdown,
      metadata: options.metadata != null ? options.metadata : null,
    };

    var lastError = null;
    var maxRetries = cfg.maxRetries;

    // 串行重试：attempt 0 为首次，attempt = maxRetries 为最后一次
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      // 调用方取消 → 立即抛出，不重试
      if (cfg.signal && cfg.signal.aborted) {
        throw new KwaPushError('aborted by caller signal', {
          status: 0,
          attempt: attempt,
        });
      }

      try {
        var result = await doFetchOnce(
          cfg.webhookUrl,
          payload,
          cfg.timeout,
          cfg.signal
        );

        if (result.ok) {
          var body = result.body || {};
          // 成功 → 立即返回，跳出重试链
          return {
            received: body.received === true,
            deduplicated: body.deduplicated === true,
            observation_id: body.observation_id || '',
          };
        }

        // 4xx：不重试，直接抛出
        if (result.status >= 400 && result.status < 500) {
          throw new KwaPushError(
            'server rejected (' + result.status + '): ' + (result.rawText || ''),
            {
              status: result.status,
              attempt: attempt,
              responseBody: result.body,
            }
          );
        }

        // 5xx 或其他：可重试
        lastError = new KwaPushError(
          'server error (' + result.status + '): ' + (result.rawText || ''),
          {
            status: result.status,
            attempt: attempt,
            responseBody: result.body,
          }
        );
      } catch (err) {
        // 4xx KwaPushError 直接向上抛，不进入重试
        if (
          err instanceof KwaPushError &&
          err.status >= 400 &&
          err.status < 500
        ) {
          throw err;
        }
        // 调用方主动取消 → 不重试
        if (cfg.signal && cfg.signal.aborted) {
          throw err instanceof KwaPushError
            ? err
            : new KwaPushError('aborted by caller signal', {
                status: 0,
                attempt: attempt,
              });
        }
        // 网络 / 超时 / 5xx：记录后等待退避再重试
        if (err instanceof KwaPushError) {
          // doFetchOnce 内部抛出的错误 attempt 固定为 0，这里覆写为当前轮次
          lastError = err;
          lastError.attempt = attempt;
        } else {
          lastError = new KwaPushError(
            'unexpected error: ' +
              (err && err.message ? err.message : String(err)),
            { status: 0, attempt: attempt }
          );
        }
      }

      // 指数退避等待（最后一次不需要等）
      if (attempt < maxRetries) {
        var backoff = cfg.retryDelayMs * Math.pow(2, attempt);
        await sleep(backoff, cfg.signal);
      }
    }

    throw lastError || new KwaPushError('push failed after retries', {
      status: 0,
      attempt: maxRetries,
    });
  }

  // ==========================================================================
  // 独立客户端（用于多后端场景）
  // ==========================================================================

  /**
   * 创建独立客户端实例，持有自己的配置副本，互不影响。
   *
   * 适用场景：同时对接多个后端（dev / staging），每个后端一个 client。
   *
   * @param {Object} [options] 初始配置（同 pushConversation 的 config 字段）。
   * @returns {Object} 客户端实例，含 pushConversation / configure / config。
   */
  function createClient(options) {
    var clientConfig = mergeConfig(options);

    var client = {
      /** 当前客户端配置快照（修改 configure 后会同步更新）。 */
      config: clientConfig,
      /**
       * 使用本客户端配置推送对话；可传入 overrideConfig 临时覆写部分字段。
       * @type {(options: Object, config?: Object) => Promise<Object>}
       */
      pushConversation: function (opts, overrideConfig) {
        var merged = overrideConfig
          ? mergeConfig(overrideConfig, clientConfig)
          : clientConfig;
        return pushConversation(opts, merged);
      },
      /**
       * 更新本客户端配置（仅更新提供的字段，其余保持不变）。
       * @param {Object} opts
       */
      configure: function (opts) {
        if (!opts) return;
        if (opts.webhookUrl != null) clientConfig.webhookUrl = opts.webhookUrl;
        if (opts.timeout != null) clientConfig.timeout = opts.timeout;
        if (opts.maxRetries != null) clientConfig.maxRetries = opts.maxRetries;
        if (opts.retryDelayMs != null) clientConfig.retryDelayMs = opts.retryDelayMs;
        if (opts.signal != null) clientConfig.signal = opts.signal;
      },
    };

    return client;
  }

  // ==========================================================================
  // 导出
  // ==========================================================================

  return {
    pushConversation: pushConversation,
    configure: configure,
    createClient: createClient,
    SUPPORTED_PLATFORMS: SUPPORTED_PLATFORMS.slice(),
    KwaPushError: KwaPushError,
    KwaPushValidationError: KwaPushValidationError,
  };
});

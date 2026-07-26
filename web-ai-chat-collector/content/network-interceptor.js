// network-interceptor.js - 在页面主世界(MAIN world)中拦截 fetch/XHR
// 通过 window.postMessage 将拦截到的数据转发给 content script

(function() {
  if (window.__AI_CHAT_INTERCEPTOR_INSTALLED__) return;
  window.__AI_CHAT_INTERCEPTOR_INSTALLED__ = true;

  // 保存最近一次 API 请求的认证 headers
  let lastAuthHeaders = {};

  // ===== 拦截 fetch =====
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    let capturedRequestBody = null;
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const options = args[1] || {};

      // 提取认证 headers（所有 API 请求）
      if (options.headers) {
        const headers = {};
        if (options.headers instanceof Headers) {
          options.headers.forEach((v, k) => { headers[k] = v; });
        } else if (typeof options.headers === 'object') {
          Object.assign(headers, options.headers);
        }
        const authKeys = Object.keys(headers).filter(k =>
          k.toLowerCase().includes('auth') ||
          k.toLowerCase().includes('token') ||
          k.toLowerCase().includes('x-') ||
          k.toLowerCase().includes('cookie')
        );
        if (authKeys.length > 0) {
          const filtered = {};
          authKeys.forEach(k => { filtered[k] = headers[k]; });
          lastAuthHeaders = filtered;
        }
      }

      // 捕获 POST 请求体（用于流式对话提取用户消息）
      if (options.method?.toUpperCase() === 'POST' && options.body) {
        try {
          if (typeof options.body === 'string') {
            capturedRequestBody = options.body;
          } else if (options.body instanceof ReadableStream) {
            // ReadableStream 不能直接读取，跳过（流式请求体不常见）
          } else if (options.body instanceof FormData) {
            // FormData 不容易序列化，跳过
          } else if (options.body instanceof Blob) {
            capturedRequestBody = await options.body.text();
          } else if (options.body instanceof ArrayBuffer) {
            capturedRequestBody = new TextDecoder().decode(options.body);
          }
        } catch (e) {
          console.warn('[Interceptor] 请求体捕获失败:', e);
        }
      }
    } catch (e) { console.warn('[Interceptor] 拦截处理失败:', e); }

    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const cloned = response.clone();
      cloned.text().then(bodyText => {
        const msg = {
          type: '__AI_CHAT_INTERCEPTED__',
          source: 'fetch',
          url: url,
          body: bodyText
        };
        // 附带请求体（如果有）
        if (capturedRequestBody) {
          msg.requestBody = capturedRequestBody;
        }
        window.postMessage(msg, '*');
      }).catch(e => console.warn('[Interceptor] 读取响应体失败:', e));
    } catch (e) { console.warn('[Interceptor] 拦截处理失败:', e); }

    return response;
  };

  // ===== 拦截 XHR =====
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    let capturedRequestBody = null;

    const originalOpen = xhr.open;
    xhr.open = function(method, url, ...rest) {
      xhr.__interceptedUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function(name, value) {
      const lower = name.toLowerCase();
      if (lower.includes('auth') || lower.includes('token') || lower.startsWith('x-')) {
        lastAuthHeaders[name] = value;
      }
      return originalSetRequestHeader.call(this, name, value);
    };

    const originalSend = xhr.send;
    xhr.send = function(...args) {
      // 捕获 XHR 请求体
      if (args[0]) {
        try {
          capturedRequestBody = typeof args[0] === 'string' ? args[0] : null;
        } catch (e) { console.warn('[Interceptor] XHR 请求体捕获失败:', e); }
      }
      xhr.addEventListener('load', function() {
        try {
          const msg = {
            type: '__AI_CHAT_INTERCEPTED__',
            source: 'xhr',
            url: xhr.__interceptedUrl || '',
            body: xhr.responseText
          };
          if (capturedRequestBody) {
            msg.requestBody = capturedRequestBody;
          }
          window.postMessage(msg, '*');
        } catch (e) { console.warn('[Interceptor] 拦截处理失败:', e); }
      });
      return originalSend.call(this, ...args);
    };

    return xhr;
  };

  // ===== 监听来自 content script 的主动请求指令 =====
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__AI_CHAT_FETCH_REQUEST__') return;

    const { url } = event.data;
    const headers = { ...lastAuthHeaders };
    originalFetch(url, { headers })
      .then(resp => {
        return resp.text();
      })
      .then(bodyText => {
        window.postMessage({
          type: '__AI_CHAT_INTERCEPTED__',
          source: 'fetch-active',
          url: url,
          body: bodyText
        }, '*');
      })
      .catch(err => {
        console.warn('[NetworkInterceptor/Debug] 主动请求失败: url=%s, error=%s', url?.substring(0, 80), err.message);
      });
  });

  console.log('[NetworkInterceptor] 主世界拦截器已安装');
})();

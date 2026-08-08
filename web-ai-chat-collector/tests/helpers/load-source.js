// tests/helpers/load-source.js
// 加载 IIFE + 全局变量风格的源文件到 jsdom 的 window 上
//
// 项目源文件不是 ES module，挂载到 window 全局（window.HtmlToMarkdown / window.LLMService 等）。
// 通过 fs.readFileSync 读字符串后用 new Function 在当前 jsdom 上下文执行，
// 让源文件能访问 window / document / chrome 等浏览器全局。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// 在当前 jsdom 上下文执行源文件字符串
// 源文件是 IIFE + 全局变量风格：
//   - content/dom/*.js 用 IIFE，内部 `window.X = {...}` 显式挂载
//   - lib/*.js 用顶层 `const X = {...}` 或 `function foo() {}` 声明
// indirect eval 在全局作用域执行：
//   - 顶层函数声明会挂到 window（OK）
//   - 顶层 var 会挂到 window（OK）
//   - 顶层 const/let 不会挂到 window（需转为 var）
// 因此把 const/let 转为 var 后再用 indirect eval，让所有顶层声明都挂到 window 全局，
// 这样后续加载的源文件能直接引用前面的全局（如 llm.js 引用 EmbeddingService）
function runInWindow(filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');
  // 把 const/let 转 var：
  //   - 我们的源码中 const 声明不会被重新赋值，转 var 在运行时行为一致
  //   - 解构声明 `const { a, b } = obj` 转 `var { a, b } = obj` 在 ES2015+ 中合法
  //   - 块级作用域内的 const/let（如 if/for 内）转 var 会改变作用域，但我们的源码中
  //     这类声明都是局部变量，没有跨作用域引用，行为仍一致
  //   - 注意：不处理字符串/正则中的 const/let 关键字（源码中无此情况）
  const modified = code
    .replace(/\bconst\s+/g, 'var ')
    .replace(/\blet\s+/g, 'var ');
  // indirect eval：在全局作用域执行，让顶层声明挂到 window
  // eslint-disable-next-line no-eval
  (0, eval)(modified);
}

// 挂载 chrome.* mock。源文件加载时不会立即调用 chrome API，
// 但 EmbeddingService.init / LLMService.init 等方法会用到，提前 mock 避免抛错。
export function mockChrome(overrides = {}) {
  window.chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (p) => `chrome-extension://test/${p}`,
      ...overrides.runtime
    },
    storage: {
      local: {
        get: (keys, cb) => cb({}),
        set: (data, cb) => cb && cb(),
        ...overrides.storage?.local
      }
    },
    ...overrides
  };
}

// 在 document.body 注入 HTML（jsdom 不支持设置 documentElement.innerHTML 直接换根，
// 但支持 document.body.innerHTML 或 DOMParser）
export function setBody(html) {
  document.body.innerHTML = html;
}

// 完全替换 document.documentElement（含 <head>），适合需要 <head> 中样式/脚本的场景
export function setDocument(html) {
  // jsdom 支持 document.documentElement.outerHTML 替换
  document.documentElement.innerHTML = html;
}

// 模拟 window.location.pathname（用于 Kimi 等 getConversationId 测试）
export function setPathname(pathname) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname },
    configurable: true,
    writable: true
  });
}

export function setTitle(title) {
  Object.defineProperty(document, 'title', {
    value: title,
    configurable: true,
    writable: true
  });
}

// ---- 各源文件加载函数 ----
// 每个 loader 先 mockChrome 再执行源文件，返回需要测试的全局对象。

export function loadDb() {
  mockChrome();
  runInWindow(path.join(ROOT, 'lib', 'db.js'));
  return {
    _stripAugmentBlocks: window._stripAugmentBlocks.bind(window),
    _reorderByDomOrder: window._reorderByDomOrder.bind(window),
    tokenize: window.tokenize.bind(window),
    highlightSearchResult: window.highlightSearchResult.bind(window),
    saveConversation: window.saveConversation.bind(window),
    getConversation: window.getConversation.bind(window)
  };
}

export function loadEmbedding() {
  mockChrome();
  runInWindow(path.join(ROOT, 'lib', 'embedding.js'));
  return {
    EmbeddingService: window.EmbeddingService,
    cosineSimilarity: window.cosineSimilarity,
    saveEmbedding: window.saveEmbedding.bind(window),
    localVectorSearch: window.localVectorSearch.bind(window)
  };
}

export function loadVectorStore() {
  mockChrome();
  // vector-store.js 依赖 embedding.js 的 openEmbeddingDB/saveEmbedding/getAllEmbeddings 等
  runInWindow(path.join(ROOT, 'lib', 'embedding.js'));
  runInWindow(path.join(ROOT, 'lib', 'vector-store.js'));
  return {
    VectorStore: window.VectorStore,
    parsePostgrestResponse: window.parsePostgrestResponse
  };
}

export function loadLlm() {
  mockChrome();
  // llm.js 用到 getConversation（db.js）/ EmbeddingService / VectorStore / getRetrievalSettings
  runInWindow(path.join(ROOT, 'lib', 'db.js'));
  runInWindow(path.join(ROOT, 'lib', 'embedding.js'));
  runInWindow(path.join(ROOT, 'lib', 'vector-store.js'));
  runInWindow(path.join(ROOT, 'lib', 'llm.js'));
  return {
    LLMService: window.LLMService,
    AIAssistant: window.AIAssistant
  };
}

export function loadHtmlSanitizer() {
  mockChrome();
  runInWindow(path.join(ROOT, 'lib', 'sanitize-html.js'));
  return window.HtmlSanitizer;
}

// 加载 KaTeX/turndown 第三方库 + html-to-markdown.js + katex-html-to-latex.js
// 需要真实第三方库才能测 KaTeX 解析与 Markdown 转换
export function loadHtmlToMarkdown() {
  mockChrome();
  runInWindow(path.join(ROOT, 'lib', 'turndown.min.js'));
  runInWindow(path.join(ROOT, 'lib', 'turndown-plugin-gfm.js'));
  runInWindow(path.join(ROOT, 'content', 'dom', 'katex-html-to-latex.js'));
  runInWindow(path.join(ROOT, 'content', 'dom', 'html-to-markdown.js'));
  return {
    HtmlToMarkdown: window.HtmlToMarkdown,
    KatexHtmlToLatex: window.KatexHtmlToLatex,
    TurndownService: window.TurndownService
  };
}

// 加载指定平台 DOM 适配器
export function loadDomAdapter(platform) {
  mockChrome();
  runInWindow(path.join(ROOT, 'lib', 'turndown.min.js'));
  runInWindow(path.join(ROOT, 'lib', 'turndown-plugin-gfm.js'));
  runInWindow(path.join(ROOT, 'content', 'dom', 'katex-html-to-latex.js'));
  runInWindow(path.join(ROOT, 'content', 'dom', 'html-to-markdown.js'));
  runInWindow(path.join(ROOT, 'content', 'dom', `${platform}.js`));
  return window.DOM_ADAPTERS[platform];
}

// 加载 bg/local-app.js（插件↔本地应用对接）
// 与 lib/ 不同：local-app.js 用 chrome.alarms 做定时推送，且 loadPushedMap/savePushedMap
// 会读写 chrome.storage.local，需要 get 能读回 set 写入的数据（持久化 storage mock）。
// fetch / getConversations / getConversation 不在此加载——由测试按需 mock window.fetch。
export function loadLocalApp() {
  // 持久化 storage mock：savePushedMap 写入后 loadPushedMap 能读回
  const storageStore = {};
  const storageMock = {
    local: {
      get: (keys, cb) => {
        const result = {};
        // chrome.storage.local.get 支持三种 keys 形式：string / string[] / object（带默认值）
        const keyList = typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : (keys && typeof keys === 'object' ? Object.keys(keys) : []);
        for (const k of keyList) {
          if (k in storageStore) result[k] = storageStore[k];
        }
        cb(result);
      },
      set: (data, cb) => {
        Object.assign(storageStore, data);
        cb && cb();
      }
    }
  };
  // alarms mock：_syncAlarm 会 clear + create，LocalApp_init 会注册 onAlarm listener
  const alarmsMock = {
    create: () => {},
    clear: () => {},
    onAlarm: { addListener: () => {} }
  };
  mockChrome({
    storage: storageMock,
    alarms: alarmsMock
  });
  runInWindow(path.join(ROOT, 'bg', 'local-app.js'));
  return {
    _buildRequestBody: window._buildRequestBody.bind(window),
    _fallbackMarkdown: window._fallbackMarkdown.bind(window),
    LocalApp_pushConversation: window.LocalApp_pushConversation.bind(window),
    LocalApp_pushAll: window.LocalApp_pushAll.bind(window),
    LocalApp_pushByConvId: window.LocalApp_pushByConvId.bind(window),
    LocalApp_pair: window.LocalApp_pair.bind(window),
    LocalApp_testConnection: window.LocalApp_testConnection.bind(window),
    LocalApp_getStatus: window.LocalApp_getStatus.bind(window),
    LocalApp_applySettings: window.LocalApp_applySettings.bind(window),
    LocalApp_resetPushedMap: window.LocalApp_resetPushedMap.bind(window),
    // 模块状态访问器：_settings / _pushedMap 是模块级 let，const/let→var 后挂 window
    getSettings: () => window._settings,
    setSettings: (s) => { window._settings = { ...window._settings, ...s }; },
    getPushedMap: () => window._pushedMap,
    setPushedMap: (m) => { window._pushedMap = m; },
    getRevisionMap: () => window._revisionMap,
    setRevisionMap: (m) => {
      window._revisionMap = m;
      window._revisionLoadPromise = Promise.resolve(m);
    },
    PLATFORM_MAP: window.PLATFORM_MAP,
    DEFAULT_LOCAL_APP_SETTINGS: window.DEFAULT_LOCAL_APP_SETTINGS
  };
}

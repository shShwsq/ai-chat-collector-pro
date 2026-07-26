// adapter-registry.js - 适配器注册表与常量

// 提取模式
const EXTRACTION_MODE = {
  NETWORK: 'network',  // 网络拦截模式
  DOM: 'dom'          // DOM提取模式
};

// 适配器注册表（由 network/*.js 和 dom/*.js 填充）
window.NETWORK_ADAPTERS = {};
window.DOM_ADAPTERS = {};

// 检查指定平台是否启用对话提取
// 默认仅启用 fudan；用户显式保存过的平台按存储值
// content script 中可直接调用 chrome.storage.local
const DEFAULT_ENABLED_PLATFORMS = new Set(['fudan']);

async function isPlatformEnabled(platformName) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local) {
        resolve(DEFAULT_ENABLED_PLATFORMS.has(platformName));
        return;
      }
      chrome.storage.local.get('platformSettings', (result) => {
        if (chrome.runtime.lastError) {
          resolve(DEFAULT_ENABLED_PLATFORMS.has(platformName));
          return;
        }
        const settings = result?.platformSettings || {};
        // 已显式保存过的平台按存储值；未保存过的走默认（仅 fudan 启用）
        if (platformName in settings) {
          resolve(settings[platformName] === true);
        } else {
          resolve(DEFAULT_ENABLED_PLATFORMS.has(platformName));
        }
      });
    } catch (e) {
      resolve(DEFAULT_ENABLED_PLATFORMS.has(platformName));
    }
  });
}

// 读取指定平台的提取模式（由 content script 在初始化时调用）
// 默认值表只在 bg/settings-handlers.js 维护一份，content script 通过消息向 bg 查询
// 注意：扩展重新加载后旧 content script 的 chrome.runtime 上下文会失效，
// 此时不应 reject（会导致 Uncaught promise），而应 resolve 默认值让适配器降级运行
// 默认降级为 DOM 模式：兼容性更好，且不依赖网络拦截器是否成功启动
function getPlatformMode(platformName) {
  return new Promise((resolve) => {
    try {
      // context 失效检查（扩展重新加载后 chrome.runtime.id 变为 undefined）
      if (!chrome.runtime?.id) {
        console.warn('[AdapterRegistry] chrome.runtime 上下文已失效，getPlatformMode 降级为 DOM 模式');
        resolve(EXTRACTION_MODE.DOM);
        return;
      }
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS', category: 'platformModes' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[AdapterRegistry] getPlatformMode 查询失败，降级为 DOM 模式:', chrome.runtime.lastError.message);
          resolve(EXTRACTION_MODE.DOM);
          return;
        }
        if (!response || response.error) {
          console.warn('[AdapterRegistry] getPlatformMode 返回错误，降级为 DOM 模式:', response?.error);
          resolve(EXTRACTION_MODE.DOM);
          return;
        }
        resolve(response[platformName] || EXTRACTION_MODE.DOM);
      });
    } catch (e) {
      console.warn('[AdapterRegistry] getPlatformMode 异常，降级为 DOM 模式:', e.message);
      resolve(EXTRACTION_MODE.DOM);
    }
  });
}

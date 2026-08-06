// adapter-registry.js - 适配器注册表与常量

// 提取模式（仅 DOM 提取，网络拦截模式已移除）
const EXTRACTION_MODE = {
  DOM: 'dom'          // DOM提取模式
};

// 适配器注册表（由 dom/*.js 填充）
window.DOM_ADAPTERS = {};

// 检查指定平台是否启用对话提取
// 默认不启用任何平台；用户显式保存过的平台按存储值
// content script 中可直接调用 chrome.storage.local
const DEFAULT_ENABLED_PLATFORMS = new Set([]);

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
        // 已显式保存过的平台按存储值；未保存过的走默认（默认不启用任何平台）
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



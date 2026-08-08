// bg/settings-handlers.js - 设置读写 + 服务连通性测试
// 依赖：lib/embedding.js (EmbeddingService), lib/llm.js (LLMService),
//       lib/vector-store.js (VectorStore), lib/db.js (get/save*Settings)

const SENSITIVE_SETTING_KEYS = new Set([
  'apiKey',
  'api_key',
  'dashscopeKey',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'secret'
]);

function redactSensitiveSettings(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveSettings);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_SETTING_KEYS.has(key) ? '' : redactSensitiveSettings(item)
  ]));
}

async function handleGetSettings(category, options = {}) {
  try {
    let settings;
    switch (category) {
      case 'embedding':
        settings = await getEmbeddingSettings();
        break;
      case 'vectorStore':
        settings = await getVectorStoreSettings();
        break;
      case 'retrieval':
        settings = await getRetrievalSettings();
        break;
      case 'llm':
        settings = await getLLMSettings();
        break;
      case 'platforms':
        settings = await getPlatformSettings();
        break;
      case 'localApp':
        settings = await getLocalAppSettings();
        break;
      default:
        return { error: '未知设置类别' };
    }
    return options.includeSecrets ? settings : redactSensitiveSettings(settings);
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSaveSettings(category, settings) {
  try {
    let extraResult = {};
    switch (category) {
      case 'embedding': {
        const oldSettings = await getEmbeddingSettings();
        const apiKey = settings.apiKey || settings.dashscopeKey || oldSettings.apiKey || oldSettings.dashscopeKey || '';
        settings = { ...settings, apiKey, dashscopeKey: apiKey };
        await saveEmbeddingSettings(settings);
        await EmbeddingService.setConfig({
          provider: settings.provider,
          apiKey,
          dashscopeKey: apiKey,
          model: settings.model,
          baseUrl: settings.baseUrl,
          includeThinking: settings.includeThinking,
          includeSearch: settings.includeSearch,
          chunkSize: settings.chunkSize,
          chunkOverlap: settings.chunkOverlap
        });
        break;
      }
      case 'retrieval':
        await saveRetrievalSettings(settings);
        break;
      case 'vectorStore': {
        // 读取当前（旧）设置，用于判断后端是否变化
        const oldSettings = await getVectorStoreSettings();
        const oldBackend = oldSettings.backend;
        const oldConfig = oldSettings.config || {};
        const newBackend = settings.backend;
        const requestedConfig = settings.config || {};
        const newConfig = {
          ...requestedConfig,
          apiKey: requestedConfig.apiKey || oldConfig.apiKey || ''
        };

        // 后端变化判定：backend 字段变化，或 remote 模式下 type/url/collection 变化
        // apiKey 单独变化不视为数据位置变化（不触发清理/重建）
        const backendChanged = oldBackend !== newBackend ||
          (oldBackend === 'remote' && newBackend === 'remote' && (
            oldConfig.type !== newConfig.type ||
            oldConfig.url !== newConfig.url ||
            oldConfig.collection !== newConfig.collection
          ));

        // 切换前清空旧后端（此时 VectorStore 单例仍指向旧后端）
        let cleared = null;
        if (settings.clearOld && backendChanged) {
          try {
            cleared = await VectorStore.clearCollection();
            console.log(`[BG] 已清空旧后端向量库 (${oldBackend}):`, cleared);
          } catch (e) {
            console.error('[BG] 清空旧后端失败:', e);
            cleared = { success: false, error: e.message };
          }
        }

        // 保存新设置并切换后端（剥离 clearOld/rebuildNew 临时标志，不持久化）
        await saveVectorStoreSettings({ backend: newBackend, config: newConfig });
        await VectorStore.setBackend(newBackend, newConfig);

        // 切换后重建新后端索引
        let rebuilt = null;
        if (settings.rebuildNew && backendChanged) {
          try {
            console.log('[BG] 开始为新后端重建索引...');
            rebuilt = await handleRebuildIndex();
          } catch (e) {
            console.error('[BG] 新后端索引重建失败:', e);
            rebuilt = { success: false, error: e.message };
          }
        }

        extraResult = { cleared, rebuilt };
        break;
      }
      case 'llm': {
        const oldSettings = await getLLMSettings();
        const oldConfig = oldSettings.config || {};
        const config = {
          ...(settings.config || {}),
          apiKey: settings.config?.apiKey || oldConfig.apiKey || ''
        };
        settings = { ...settings, config };
        await saveLLMSettings(settings);
        await LLMService.setBackend(settings.backend, config);
        break;
      }
      case 'platforms':
        await savePlatformSettings(settings);
        break;
      case 'localApp': {
        const oldSettings = await getLocalAppSettings();
        settings = {
          ...settings,
          credential: settings.credential || oldSettings.credential || ''
        };
        await LocalApp_applySettings(settings);
        break;
      }
    }
    return { success: true, ...extraResult };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 平台提取设置（按网站启用/禁用对话提取）
async function getPlatformSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('platformSettings', (result) => {
      resolve(result.platformSettings || {});
    });
  });
}

async function savePlatformSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ platformSettings: settings }, resolve);
  });
}

async function handleTestEmbedding(text) {
  try {
    const start = Date.now();
    const vector = await EmbeddingService.embed(text);
    const time = Date.now() - start;
    if (vector) {
      return { success: true, dimension: vector.length, time };
    }
    return { success: false, error: '生成向量失败' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleTestLLM(prompt) {
  try {
    // 改用流式调用，统一走 chatStream（onChunk 不向前端推送，仅等待完成）
    const content = await LLMService.chatStream(
      [{ role: 'user', content: prompt }],
      null,
      {}
    );
    return { success: true, content };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

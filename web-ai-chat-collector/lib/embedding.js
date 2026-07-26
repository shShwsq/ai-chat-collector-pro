// lib/embedding.js - Embedding 服务
// 支持多厂商（向量维度由 models.json 中 model.dimension 指定，默认 1024 与向量库匹配）：
//   1. DashScope（阿里云百炼）：原生 API，含纯文本和多模态端点
//   2. OpenAI 兼容厂商（智谱/百度/火山/Jina 等）：统一 /embeddings 端点，
//      部分模型通过 dimensions 参数指定 1024 维

const EMBEDDING_STORE = 'embeddings';

// ============================================================
// Embedding 服务管理器
// ============================================================

const EmbeddingService = {
  // 厂商与模型配置
  _provider: 'dashscope', // 厂商 id（对应 models.json embeddingProviders.id）
  _backend: 'dashscope', // 'dashscope'（原生 API） | 'openai'（兼容 /embeddings）
  _baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  _apiKey: '', // 统一 API Key（兼容旧字段 dashscopeKey）
  _model: 'text-embedding-v4',
  _multimodal: false, // 是否多模态模型（仅 dashscope 多模态走独立端点）
  _dimensionsParam: false, // 是否在请求体中传 dimensions 参数
  _multimodalEndpoint: false, // OpenAI 兼容厂商是否走 /embeddings/multimodal 端点（豆包 vision）
  // 期望输出的向量维度（与向量库 schema 匹配）
  // 来源优先级：models.json model.dimension > provider.fallbackDimension > 1024（默认）
  //
  // ⚠️ 切换 Embedding 模型导致维度变化时的处理：
  // 本地 IndexedDB 不校验向量维度，新旧维度向量会混存于同一 store；
  // localVectorSearch 暴力 cosine similarity 也不校验维度，混合维度会产生错误结果（点积维度不匹配 → NaN）。
  // 插件不会自动清理旧向量，用户需手动操作：
  //   1. 设置页「清空向量库」清除旧维度向量
  //   2. 「重建向量索引」用新模型重新嵌入全部对话
  // 远程向量库（Milvus/pgvector 等）的 collection schema 通常固定维度，
  // 插入不同维度向量会直接被后端拒绝（HTTP 4xx），需删除并重建 collection。
  //
  // _dimensionsParam 为 true 时，请求体带 dimensions 参数强制模型输出 _expectedDimension 维，
  // 适用于 Jina v3 等可调维度模型，使其与向量库固定维度匹配，避免上述问题。
  _expectedDimension: 1024,
  // 向量库内容过滤：是否包含深度思考 / 联网搜索结果
  _includeThinking: false,
  _includeSearch: false,
  // 切片参数（按字符数）：单条消息过长时切成多段分别 embedding
  _chunkSize: 500,
  _chunkOverlap: 50,
  _initialized: false,
  // models.json 厂商清单缓存
  _modelsCatalog: null,

  // 初始化：读取设置
  async init() {
    const settings = await getEmbeddingSettings();
    this._provider = settings.provider || 'dashscope';
    this._apiKey = settings.apiKey || settings.dashscopeKey || '';
    this._model = settings.model || 'text-embedding-v4';
    this._customBaseUrl = settings.baseUrl || '';
    this._includeThinking = settings.includeThinking === true;
    this._includeSearch = settings.includeSearch === true;
    this._chunkSize = Math.max(1, settings.chunkSize || 500);
    this._chunkOverlap = Math.max(0, Math.min(settings.chunkOverlap || 0, this._chunkSize - 1));
    // 异步加载 models.json 并补全 backend/baseUrl/multimodal/dimensionsParam
    await this._loadModelsCatalog();
    this._applyProviderMeta();
    this._initialized = true;
    console.log(`[Embedding] 初始化完成，厂商: ${this._provider}，后端: ${this._backend}，模型: ${this._model}，API Key: ${this._apiKey ? '已配置' : '未配置'}，内容过滤: think=${this._includeThinking} search=${this._includeSearch}，切片: size=${this._chunkSize} overlap=${this._chunkOverlap}`);
  },

  // 加载 models.json（用于查找厂商 backend / baseUrl / 模型 multimodal / dimensionsParam）
  async _loadModelsCatalog() {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    try {
      const url = chrome.runtime.getURL('models.json');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._modelsCatalog = await resp.json();
    } catch (e) {
      this._modelsCatalog = null;
      console.warn('[Embedding] 加载 models.json 失败，将使用默认配置:', e);
    }
  },

  // 根据当前 provider/model 从 models.json 补全 backend/baseUrl/multimodal/dimensionsParam
  _applyProviderMeta() {
    if (!this._modelsCatalog) {
      // 无 catalog 时回退到 dashscope 默认
      this._backend = 'dashscope';
      this._baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
      this._multimodal = false;
      this._dimensionsParam = false;
      this._expectedDimension = 1024;
      return;
    }
    const provider = (this._modelsCatalog.embeddingProviders || [])
      .find(p => p.id === this._provider);
    if (!provider) {
      // 自定义厂商：走 OpenAI 兼容后端，用用户填的 baseUrl
      this._backend = 'openai';
      this._baseUrl = this._customBaseUrl || '';
      this._multimodal = false;
      this._dimensionsParam = false;
      this._multimodalEndpoint = false;
      this._expectedDimension = 1024;
      return;
    }
    this._backend = provider.backend || 'openai';
    // 用户自定义 baseUrl 优先于预设
    this._baseUrl = this._customBaseUrl || provider.baseUrl || '';
    const modelMeta = (provider.models || []).find(m => m.id === this._model);
    // 自定义模型 ID（如豆包 Endpoint ID ep-xxx）匹配不上时，用 provider 级别 fallback
    this._multimodal = !!(modelMeta?.multimodal || provider.fallbackMultimodal);
    this._dimensionsParam = !!(modelMeta?.dimensionsParam || provider.fallbackDimensionsParam);
    this._multimodalEndpoint = !!(modelMeta?.multimodalEndpoint || provider.fallbackMultimodalEndpoint);
    this._expectedDimension = modelMeta?.dimension || provider.fallbackDimension || 1024;
  },

  // 检查是否已配置
  isConfigured() {
    return !!this._apiKey;
  },

  // 获取当前模型
  getModel() {
    return this._model;
  },

  // 更新配置
  async setConfig(options = {}) {
    let catalogDirty = false;
    if (options.provider !== undefined && options.provider !== this._provider) {
      this._provider = options.provider;
      catalogDirty = true;
    }
    // apiKey 与 dashscopeKey 均接受（兼容旧字段）
    if (options.apiKey !== undefined) this._apiKey = options.apiKey;
    if (options.dashscopeKey !== undefined && !this._apiKey) this._apiKey = options.dashscopeKey;
    if (options.model !== undefined) {
      this._model = options.model;
      catalogDirty = true;
    }
    if (options.baseUrl !== undefined) {
      this._customBaseUrl = options.baseUrl;
      catalogDirty = true;
    }
    if (options.includeThinking !== undefined) this._includeThinking = options.includeThinking;
    if (options.includeSearch !== undefined) this._includeSearch = options.includeSearch;
    if (options.chunkSize !== undefined) {
      this._chunkSize = Math.max(1, options.chunkSize);
    }
    if (options.chunkOverlap !== undefined) {
      // overlap 必须小于 size，否则会无限循环
      this._chunkOverlap = Math.max(0, Math.min(options.chunkOverlap, this._chunkSize - 1));
    }
    // provider/model 变化时重新补全元信息
    if (catalogDirty) {
      if (!this._modelsCatalog) await this._loadModelsCatalog();
      this._applyProviderMeta();
    }
    await saveEmbeddingSettings({
      provider: this._provider,
      apiKey: this._apiKey,
      dashscopeKey: this._apiKey, // 兼容旧代码读取
      model: this._model,
      includeThinking: this._includeThinking,
      includeSearch: this._includeSearch,
      chunkSize: this._chunkSize,
      chunkOverlap: this._chunkOverlap
    });
  },

  // 获取当前切片参数（供 background 生成 chunk ID 等场景使用）
  getChunkConfig() {
    return { chunkSize: this._chunkSize, chunkOverlap: this._chunkOverlap };
  },

  // 将长文本按 chunkSize/chunkOverlap 切成多段（按字符数）
  // 返回字符串数组；空文本返回 []；短于 chunkSize 的返回 [text]
  chunkText(text) {
    const size = Math.max(1, this._chunkSize);
    const overlap = Math.max(0, Math.min(this._chunkOverlap, size - 1));
    if (!text) return [];
    if (text.length <= size) return [text];
    const chunks = [];
    const step = size - overlap; // 每次前进的步长
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + size));
      if (i + size >= text.length) break; // 已覆盖到尾部
      i += step;
    }
    return chunks;
  },

  // 根据设置过滤待 embed 的对话内容：剥离 midt/<search_result> 块
  filterContentForEmbedding(text) {
    if (!text) return text;
    let result = text;
    if (!this._includeThinking) {
      result = result.replace(/<think>\n?[\s\S]*?\n?<\/think>\n*/g, '');
    }
    if (!this._includeSearch) {
      result = result.replace(/<search_result>\n?[\s\S]*?\n?<\/search_result>\n*/g, '');
    }
    return result.trim();
  },

  // 生成单条文本的 embedding
  async embed(text) {
    if (!text || !text.trim()) return null;
    // 按后端分发
    if (this._backend === 'dashscope') {
      // DashScope 原生 API：多模态走独立端点
      if (this._multimodal) return await this._embedDashscopeMultimodal(text);
      return await this._embedDashscopeText(text);
    }
    // OpenAI 兼容厂商：豆包 vision 走 /embeddings/multimodal，其余走 /embeddings
    if (this._multimodalEndpoint) return await this._embedOpenAIMultimodal(text);
    return await this._embedOpenAI(text);
  },

  // 批量生成 embedding
  async embedBatch(texts) {
    const results = [];
    for (const text of texts) {
      const vec = await this.embed(text);
      results.push(vec);
    }
    return results;
  },

  // 将一条消息按 chunkSize/chunkOverlap 切片并逐段生成 embedding
  // 返回 [{ chunkIdx, vector, total, text }]，失败的字段 vector 为 null（调用方应跳过）
  // text 为该切片的原文（已按设置剥离 think/search_result 块），供远程向量库作为可被智能体消费的内容
  // 调用方据此生成 chunk ID：`${convId}::msg::${msgHash}::chunk::${chunkIdx}`
  async embedMessageChunks(text) {
    const chunks = this.chunkText(text);
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const vec = await this.embed(chunks[i]);
      if (vec) {
        results.push({ chunkIdx: i, vector: vec, total: chunks.length, text: chunks[i] });
      }
    }
    return results;
  },

  // ---- DashScope 纯文本 Embedding（text-embedding-v4） ----
  async _embedDashscopeText(text) {
    if (!this._apiKey) {
      console.error('[Embedding] 未配置 API Key');
      return null;
    }
    try {
      const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this._model,
          input: { texts: [text] },
          parameters: { text_type: 'document' }
        })
      });
      const data = await resp.json();
      if (data.output && data.output.embeddings && data.output.embeddings[0]) {
        return data.output.embeddings[0].embedding;
      }
      console.error('[Embedding/DashScope-Text] 返回异常:', data);
      return null;
    } catch (e) {
      console.error('[Embedding/DashScope-Text] 请求失败:', e);
      return null;
    }
  },

  // ---- DashScope 多模态 Embedding（tongyi-embedding-vision-plus） ----
  async _embedDashscopeMultimodal(text) {
    if (!this._apiKey) {
      console.error('[Embedding] 未配置 API Key');
      return null;
    }
    try {
      const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this._model,
          input: {
            contents: [{ text }]
          }
        })
      });
      const data = await resp.json();
      if (data.output && data.output.embeddings && data.output.embeddings[0]) {
        return data.output.embeddings[0].embedding;
      }
      console.error('[Embedding/DashScope-Multimodal] 返回异常:', data);
      return null;
    } catch (e) {
      console.error('[Embedding/DashScope-Multimodal] 请求失败:', e);
      return null;
    }
  },

  // ---- OpenAI 兼容 Embedding（智谱/百度/火山/Jina 等） ----
  // 端点：${baseUrl}/embeddings，baseUrl 已含版本前缀（如 /v1、/v4、/v2、/v3）
  async _embedOpenAI(text) {
    if (!this._apiKey) {
      console.error('[Embedding] 未配置 API Key');
      return null;
    }
    const base = (this._baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    // baseUrl 已含版本前缀（/v1、/v4 等），直接拼 /embeddings
    const url = /\/v\d+$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
    const body = {
      model: this._model,
      input: text
    };
    // 部分模型需显式指定维度（与向量库固定维度匹配）
    if (this._dimensionsParam) body.dimensions = this._expectedDimension;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (data.error) {
        console.error('[Embedding/OpenAI] 返回错误:', data.error);
        return null;
      }
      // 豆包 multimodal 返回 data.data.embedding（对象），标准 OpenAI 返回 data.data[0].embedding（数组）
      const vec = (data.data && data.data[0] && data.data[0].embedding) || (data.data && data.data.embedding);
      if (vec) {
        // 维度校验：与向量库固定维度匹配
        if (vec.length !== this._expectedDimension) {
          console.error(`[Embedding/OpenAI] 维度不匹配: 期望 ${this._expectedDimension}, 实际 ${vec.length}（模型: ${this._model}）`);
          return null;
        }
        return vec;
      }
      console.error('[Embedding/OpenAI] 返回异常:', data);
      return null;
    } catch (e) {
      console.error('[Embedding/OpenAI] 请求失败:', e);
      return null;
    }
  },

  // ---- OpenAI 兼容多模态 Embedding（豆包 vision: /embeddings/multimodal） ----
  // 端点：${baseUrl}/embeddings/multimodal
  // 请求格式：input 为对象数组 [{type:"text", text:"..."}]
  async _embedOpenAIMultimodal(text) {
    if (!this._apiKey) {
      console.error('[Embedding] 未配置 API Key');
      return null;
    }
    const base = (this._baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const url = /\/v\d+$/.test(base) ? `${base}/embeddings/multimodal` : `${base}/v1/embeddings/multimodal`;
    const body = {
      model: this._model,
      input: [{ type: 'text', text }],
      encoding_format: 'float'
    };
    if (this._dimensionsParam) body.dimensions = this._expectedDimension;
    try {
      console.debug('[Embedding/Multimodal] 请求:', url, '模型:', this._model);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        console.error(`[Embedding/Multimodal] HTTP ${resp.status}:`, JSON.stringify(data));
        return null;
      }
      // 豆包 multimodal 返回 data.data.embedding（对象），标准 OpenAI 返回 data.data[0].embedding（数组）
      const vec = (data.data && data.data[0] && data.data[0].embedding) || (data.data && data.data.embedding);
      if (vec) {
        if (vec.length !== this._expectedDimension) {
          console.error(`[Embedding/Multimodal] 维度不匹配: 期望 ${this._expectedDimension}, 实际 ${vec.length}（模型: ${this._model}）`);
          return null;
        }
        return vec;
      }
      console.error('[Embedding/Multimodal] 返回异常:', JSON.stringify(data));
      return null;
    } catch (e) {
      console.error('[Embedding/Multimodal] 请求失败:', e);
      return null;
    }
  }
};

// ============================================================
// Embedding 存储（IndexedDB）
// ============================================================

async function openEmbeddingDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('AIChatEmbeddings', 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(EMBEDDING_STORE)) {
        const store = db.createObjectStore(EMBEDDING_STORE, { keyPath: 'id' });
        store.createIndex('convId', 'convId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 保存消息的 embedding
async function saveEmbedding(id, convId, vector) {
  const db = await openEmbeddingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDING_STORE, 'readwrite');
    const store = tx.objectStore(EMBEDDING_STORE);
    store.put({ id, convId, vector, createdAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 获取某对话所有 embedding
async function getEmbeddingsByConvId(convId) {
  const db = await openEmbeddingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDING_STORE, 'readonly');
    const store = tx.objectStore(EMBEDDING_STORE);
    const index = store.index('convId');
    const req = index.getAll(convId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 获取所有 embedding
async function getAllEmbeddings() {
  const db = await openEmbeddingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDING_STORE, 'readonly');
    const store = tx.objectStore(EMBEDDING_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 删除某对话的所有 embedding
async function deleteEmbeddingsByConvId(convId) {
  const db = await openEmbeddingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDING_STORE, 'readwrite');
    const store = tx.objectStore(EMBEDDING_STORE);
    const index = store.index('convId');
    const cursorReq = index.openCursor(convId);
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 清空所有 embedding（本地 IndexedDB 模式）
async function clearAllEmbeddings() {
  const db = await openEmbeddingDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDING_STORE, 'readwrite');
    tx.objectStore(EMBEDDING_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// 向量相似度搜索（内置模式，暴力 cosine similarity）
// ============================================================

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// 内置向量搜索：返回 topK 最相似的 embedding 记录
// 注意：不校验 queryVector 与存储向量的维度一致性，混合维度会产生 NaN 结果
//       （切换模型导致维度变化时的处理见 EmbeddingService._expectedDimension 注释）
async function localVectorSearch(queryVector, topK = 10) {
  const all = await getAllEmbeddings();
  const scored = all.map(item => ({
    ...item,
    score: cosineSimilarity(queryVector, item.vector)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ============================================================
// 设置持久化
// ============================================================

async function getEmbeddingSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('embeddingSettings', (result) => {
      resolve(result.embeddingSettings || {
        provider: 'dashscope',
        apiKey: '',
        dashscopeKey: '', // 兼容旧字段
        model: 'text-embedding-v4',
        includeThinking: false,
        includeSearch: false,
        chunkSize: 500,
        chunkOverlap: 50
      });
    });
  });
}

async function saveEmbeddingSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ embeddingSettings: settings }, resolve);
  });
}

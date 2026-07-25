// lib/vector-store.js - 向量库抽象层
// 支持两种模式：
//   1. 内置 IndexedDB（零配置，暴力 cosine similarity）
//   2. 远程向量库（通过 URL 配置，支持 ChromaDB / Milvus / PostgreSQL+pgvector / Supabase / Qdrant）

const VectorStore = {
  _backend: 'local', // 'local' | 'remote'
  _config: {},
  _initialized: false,

  async init() {
    const settings = await getVectorStoreSettings();
    this._backend = settings.backend || 'local';
    this._config = settings.config || {};
    this._initialized = true;
    console.log(`[VectorStore] 初始化完成，后端: ${this._backend}`);
  },

  getBackend() {
    return this._backend;
  },

  async setBackend(backend, config = {}) {
    this._backend = backend;
    this._config = config;
    await saveVectorStoreSettings({ backend, config });
  },

  // 通用：剥掉 URL 末尾所有斜杠，避免拼接时出现 // 双斜杠导致 404
  // 所有远程后端（ChromaDB / Milvus / pgvector / Supabase / Qdrant）在拼接路径前都应先过这一层
  _trimTrailingSlash(url) {
    return String(url).replace(/\/+$/, '');
  },

  // 添加向量（单条）
  async addVector(id, vector, metadata = {}) {
    if (this._backend === 'local') {
      return await saveEmbedding(id, metadata.convId, vector);
    }
    return await this._addRemote(id, vector, metadata);
  },

  // 批量添加向量（分批写入：本地单事务批量 put，远程单 HTTP 请求插入多条）
  // 大幅减少 IndexedDB 事务数 / HTTP 往返数，重建索引等批量场景性能提升显著
  async addVectors(items) {
    if (!items || items.length === 0) return [];
    if (this._backend === 'local') {
      return await this._addLocalBatch(items);
    }
    // 远程：分批，避免单请求 body 过大（1024 维 × 100 条 ≈ 1-2MB JSON，主流后端可接受）
    const BATCH_SIZE = 100;
    const results = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const r = await this._addRemoteBatch(batch);
      if (Array.isArray(r)) results.push(...r);
      else results.push(r);
    }
    return results;
  },

  // 本地批量写入：单事务多次 put，只 openDB 一次
  async _addLocalBatch(items) {
    const db = await openEmbeddingDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(EMBEDDING_STORE, 'readwrite');
      const store = tx.objectStore(EMBEDDING_STORE);
      const now = new Date().toISOString();
      for (const item of items) {
        store.put({ id: item.id, convId: item.metadata?.convId || '', vector: item.vector, createdAt: now });
      }
      tx.oncomplete = () => { db.close(); resolve(items.map(() => ({ success: true }))); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  },

  // 远程批量添加分派
  async _addRemoteBatch(items) {
    const { type, url, apiKey, collection } = this._config;
    try {
      switch (type) {
        case 'chroma': return await this._addChromaBatch(url, apiKey, collection, items);
        case 'milvus': return await this._addMilvusBatch(url, apiKey, collection, items);
        case 'pgvector': return await this._addPgvectorBatch(url, apiKey, collection, items);
        case 'supabase': return await this._addSupabaseBatch(url, apiKey, collection, items);
        case 'qdrant': return await this._addQdrantBatch(url, apiKey, collection, items);
        default:
          console.error('[VectorStore] 未知远程类型:', type);
          return items.map(() => ({ success: false, error: `未知远程类型: ${type}` }));
      }
    } catch (e) {
      console.error('[VectorStore] 远程批量添加失败:', e);
      return items.map(() => ({ success: false, error: e.message }));
    }
  },

  // ---- 各后端批量写入 ----

  // ChromaDB：ids/embeddings/metadatas 传数组，只查一次 collection UUID
  async _addChromaBatch(url, apiKey, collection, items) {
    const { id: uuid } = await this._chromaGetMeta(url, collection);
    const resp = await fetch(`${this._chromaCollectionsBase(url)}/${uuid}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: items.map(i => i.id),
        embeddings: items.map(i => i.vector),
        metadatas: items.map(i => i.metadata)
      })
    });
    return await resp.json();
  },

  // Milvus：data 传数组，单次 insert 请求
  async _addMilvusBatch(url, apiKey, collection, items) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/entities/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        collectionName: collection,
        data: items.map(i => ({ id: i.id, vector: i.vector, ...i.metadata }))
      })
    });
    const data = await resp.json();
    if (!resp.ok || (data?.code !== 200 && data?.code !== 0)) {
      const errMsg = `Milvus batch insert 失败: HTTP ${resp.status}, code=${data?.code}, message=${data?.message || ''}`;
      console.error('[VectorStore]', errMsg);
      throw new Error(errMsg);
    }
    console.log(`[VectorStore] Milvus batch insert 成功: ${items.length} 条, insertCnt=${data?.data?.insertCnt}`);
    return data;
  },

  // pgvector（PostgREST）：body 传数组，单次 POST
  async _addPgvectorBatch(url, apiKey, collection, items) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(items.map(i => ({ id: i.id, embedding: i.vector, conv_id: i.metadata.convId, metadata: i.metadata })))
    });
    return await parsePostgrestResponse(resp);
  },

  // Supabase（PostgREST + /rest/v1 前缀）：body 传数组，单次 POST
  async _addSupabaseBatch(url, apiKey, collection, items) {
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(items.map(i => ({ id: i.id, embedding: i.vector, conv_id: i.metadata.convId, metadata: i.metadata })))
    });
    return await parsePostgrestResponse(resp);
  },

  // Qdrant：points 传数组，单次 PUT
  async _addQdrantBatch(url, apiKey, collection, items) {
    const points = items.map(i => ({
      id: this._strToQdrantUUID(i.id),
      vector: i.vector,
      payload: { ...i.metadata, _origId: i.id }
    }));
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${collection}/points`, {
      method: 'PUT',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ points })
    });
    const data = await resp.json();
    if (!resp.ok || data?.status?.error) {
      throw new Error(`Qdrant 批量插入失败: ${data?.status?.error || `HTTP ${resp.status}`}`);
    }
    return data;
  },

  // 相似度搜索
  // options.scoreThreshold: 若提供（0-1），低于此值的候选会在客户端过滤掉
  async similaritySearch(queryVector, topK = 10, filters = {}, options = {}) {
    let results;
    if (this._backend === 'local') {
      results = await localVectorSearch(queryVector, topK);
    } else {
      results = await this._searchRemote(queryVector, topK, filters);
    }
    // 客户端阈值过滤（统一在客户端做，避免每个远程后端都要改 SQL/RPC）
    if (typeof options.scoreThreshold === 'number' && options.scoreThreshold > 0) {
      results = results.filter(r => (r.score || 0) >= options.scoreThreshold);
    }
    return results;
  },

  // 按召回设置（retrievalSettings）执行一次完整的检索
  // mode: 'topk'（仅 Top-K）| 'threshold'（仅阈值，Top-K 放大到 100 拉候选）
  //       | 'combined'（先 Top-K，再阈值过滤）
  // 这是 llm.js / organizeInfo / askQuestion 等业务调用统一入口
  async retrievalSearch(queryVector) {
    const rs = await getRetrievalSettings();
    const mode = rs.mode || 'combined';
    const threshold = typeof rs.scoreThreshold === 'number' ? rs.scoreThreshold : 0;
    let topK, opts = {};
    if (mode === 'topk') {
      topK = Math.max(1, rs.topK || 20);
      // 不过滤阈值
    } else if (mode === 'threshold') {
      // 只用阈值：把 topK 放大，让阈值来主导筛选
      topK = 100;
      opts.scoreThreshold = threshold;
    } else {
      // combined
      topK = Math.max(1, rs.topK || 20);
      opts.scoreThreshold = threshold;
    }
    return await this.similaritySearch(queryVector, topK, {}, opts);
  },

  // 删除某对话的向量
  async deleteByConvId(convId) {
    if (this._backend === 'local') {
      return await deleteEmbeddingsByConvId(convId);
    }
    return await this._deleteRemote(convId);
  },

  // 清空整个 collection（本地=清空 IndexedDB；远程=清空 collection 内所有向量）
  async clearCollection() {
    if (this._backend === 'local') {
      const before = (await getAllEmbeddings()).length;
      await clearAllEmbeddings();
      return { success: true, count: before };
    }
    return await this._clearRemote();
  },

  // 获取统计信息（条数、后端类型、配置概要）
  async getStats() {
    const backend = this._backend;
    if (backend === 'local') {
      const all = await getAllEmbeddings();
      return { backend: 'local', count: all.length, configured: true };
    }
    const stats = await this._statsRemote();
    return {
      backend: this._config.type || 'remote',
      count: stats?.count ?? null,
      configured: !!(this._config.url && this._config.collection),
      config: {
        type: this._config.type,
        url: this._config.url,
        collection: this._config.collection
      },
      error: stats?.error || null
    };
  },

  // ---- 远程向量库操作 ----

  async _addRemote(id, vector, metadata) {
    const { type, url, apiKey, collection } = this._config;
    try {
      switch (type) {
        case 'chroma':
          return await this._addChroma(url, apiKey, collection, id, vector, metadata);
        case 'milvus':
          return await this._addMilvus(url, apiKey, collection, id, vector, metadata);
        case 'pgvector':
          return await this._addPgvector(url, apiKey, collection, id, vector, metadata);
        case 'supabase':
          return await this._addSupabase(url, apiKey, collection, id, vector, metadata);
        case 'qdrant':
          return await this._addQdrant(url, apiKey, collection, id, vector, metadata);
        default:
          console.error('[VectorStore] 未知远程类型:', type);
      }
    } catch (e) {
      console.error('[VectorStore] 远程添加失败:', e);
    }
  },

  async _searchRemote(queryVector, topK, filters) {
    const { type, url, apiKey, collection } = this._config;
    try {
      switch (type) {
        case 'chroma':
          return await this._searchChroma(url, apiKey, collection, queryVector, topK);
        case 'milvus':
          return await this._searchMilvus(url, apiKey, collection, queryVector, topK);
        case 'pgvector':
          return await this._searchPgvector(url, apiKey, collection, queryVector, topK);
        case 'supabase':
          return await this._searchSupabase(url, apiKey, collection, queryVector, topK);
        case 'qdrant':
          return await this._searchQdrant(url, apiKey, collection, queryVector, topK);
        default:
          console.error('[VectorStore] 未知远程类型:', type);
          return [];
      }
    } catch (e) {
      console.error('[VectorStore] 远程搜索失败:', e);
      return [];
    }
  },

  async _deleteRemote(convId) {
    const { type, url, apiKey, collection } = this._config;
    try {
      switch (type) {
        case 'chroma':
          return await this._deleteChroma(url, apiKey, collection, convId);
        case 'milvus':
          return await this._deleteMilvus(url, apiKey, collection, convId);
        case 'pgvector':
          return await this._deletePgvector(url, apiKey, collection, convId);
        case 'supabase':
          return await this._deleteSupabase(url, apiKey, collection, convId);
        case 'qdrant':
          return await this._deleteQdrant(url, apiKey, collection, convId);
        default:
          console.error('[VectorStore] 未知远程类型:', type);
          return { success: false, error: `未知远程类型: ${type}` };
      }
    } catch (e) {
      console.error('[VectorStore] 远程删除失败:', e);
      return { success: false, error: e.message };
    }
  },

  async _clearRemote() {
    const { type, url, apiKey, collection } = this._config;
    try {
      switch (type) {
        case 'chroma':
          return await this._clearChroma(url, apiKey, collection);
        case 'milvus':
          return await this._clearMilvus(url, apiKey, collection);
        case 'pgvector':
          return await this._clearPgvector(url, apiKey, collection);
        case 'supabase':
          return await this._clearSupabase(url, apiKey, collection);
        case 'qdrant':
          return await this._clearQdrant(url, apiKey, collection);
        default:
          return { success: false, error: `未知远程类型: ${type}` };
      }
    } catch (e) {
      console.error('[VectorStore] 远程清空失败:', e);
      return { success: false, error: e.message };
    }
  },

  async _statsRemote(configOverride) {
    const cfg = configOverride || this._config;
    const { type, url, apiKey, collection } = cfg;
    try {
      switch (type) {
        case 'chroma':
          return await this._statsChroma(url, apiKey, collection);
        case 'milvus':
          return await this._statsMilvus(url, apiKey, collection);
        case 'pgvector':
          return await this._statsPgvector(url, apiKey, collection);
        case 'supabase':
          return await this._statsSupabase(url, apiKey, collection);
        case 'qdrant':
          return await this._statsQdrant(url, apiKey, collection);
        default:
          return { count: null, error: `未知远程类型: ${type}` };
      }
    } catch (e) {
      console.error('[VectorStore] 远程统计失败:', e);
      return { count: null, error: e.message };
    }
  },

  // 测试远程向量库连通性（不修改已保存状态，直接用传入的 config 测试）
  // 用于保存前自检，帮助用户定位 URL / API Key / 集合名是否正确
  async testConnection(config) {
    if (!config || !config.type) {
      return { success: false, error: '配置不完整（缺少向量库类型）' };
    }
    if (!config.url) {
      return { success: false, error: '请填写服务地址' };
    }
    if (!config.collection) {
      return { success: false, error: '请填写集合/表名' };
    }
    const start = Date.now();
    try {
      const stats = await this._statsRemote(config);
      const latency = Date.now() - start;
      if (stats.error) {
        // "Failed to fetch" 通常是网络/CORS/URL 问题，给出更友好的提示
        const friendly = stats.error === 'Failed to fetch'
          ? '无法连接（Failed to fetch）。请检查地址是否可达、CORS 是否放行本扩展，以及服务是否在线'
          : stats.error;
        return { success: false, error: friendly, latency };
      }
      return {
        success: true,
        latency,
        count: stats.count ?? null
      };
    } catch (e) {
      const latency = Date.now() - start;
      const friendly = e.message === 'Failed to fetch'
        ? '无法连接（Failed to fetch）。请检查地址是否可达、CORS 是否放行本扩展，以及服务是否在线'
        : e.message;
      return { success: false, error: friendly, latency };
    }
  },

  // ---- ChromaDB ----
  // ChromaDB 1.0+ 用 v2 API。
  // 规律：集合级操作（create/delete collection）用 collection 名字；
  //       数据级操作（add/query/delete/count）路径要用 collection 的 UUID（不是名字）。
  _chromaCollectionsBase(url) {
    return `${this._trimTrailingSlash(url)}/api/v2/tenants/default_tenant/databases/default_database/collections`;
  },
  _chromaBase(url, collection) {
    // 用名字查详情（GET 支持 collection 名字）
    return `${this._chromaCollectionsBase(url)}/${encodeURIComponent(collection)}`;
  },
  // 按名字查 collection 的 UUID 和 distance function（数据级操作需要）
  // 返回 { id, space }：id 用于数据级操作路径，space 用于 score 转换
  async _chromaGetMeta(url, collection) {
    const resp = await fetch(this._chromaBase(url, collection), { method: 'GET' });
    if (!resp.ok) throw new Error(`获取 collection 详情失败: HTTP ${resp.status}`);
    const detail = await resp.json();
    if (!detail.id) throw new Error('collection 详情中未找到 id 字段');
    return { id: detail.id, space: this._chromaGetSpace(detail) };
  },
  // 从 collection 详情中提取 hnsw:space（distance function）。
  // ChromaDB 默认为 l2（平方欧氏距离）。不同版本/部署返回结构略有差异，
  // 依次尝试 metadata、configuration 字段，均缺失时回退到 'l2'。
  _chromaGetSpace(detail) {
    // 常见结构 1：detail.metadata["hnsw:space"]（创建时通过 metadata 指定）
    const meta = detail.metadata || {};
    if (meta['hnsw:space']) return meta['hnsw:space'];
    // 常见结构 2：detail.configuration.fields["hnsw:space"]
    const cfg = detail.configuration || {};
    const fields = cfg.fields || {};
    if (fields['hnsw:space']) return fields['hnsw:space'];
    // 常见结构 3：detail.configuration.hnsw.space（嵌套对象形式）
    const hnsw = cfg.hnsw || {};
    if (hnsw.space) return hnsw.space;
    return 'l2'; // ChromaDB 默认
  },
  // 按 distance function 将 ChromaDB distance 转成 score（越大越相似）。
  // - l2（平方欧氏）：d ∈ [0, +∞)，score = 1/(1+d)，单调递减到 0
  // - cosine：d ∈ [0, 2]，score = 1-d，还原成 cosine similarity ∈ [-1, 1]
  // - ip（负内积）：d = -⟨a,b⟩，score = -d，还原成内积
  _chromaDistanceToScore(space, d) {
    if (space === 'cosine') return 1 - d;
    if (space === 'ip') return -d;
    // l2 或未知：用 1/(1+d) 归一化，避免高维 L2 距离 >1 时被线性压成 0
    return d >= 0 ? 1 / (1 + d) : 1;
  },
  async _addChroma(url, apiKey, collection, id, vector, metadata) {
    const { id: uuid } = await this._chromaGetMeta(url, collection);
    const resp = await fetch(`${this._chromaCollectionsBase(url)}/${uuid}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], embeddings: [vector], metadatas: [metadata] })
    });
    return await resp.json();
  },
  async _searchChroma(url, apiKey, collection, queryVector, topK) {
    const { id: uuid, space } = await this._chromaGetMeta(url, collection);
    const resp = await fetch(`${this._chromaCollectionsBase(url)}/${uuid}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 必须显式 include distances，ChromaDB 默认只返回 metadatas + documents
      body: JSON.stringify({ query_embeddings: [queryVector], n_results: topK, include: ['metadatas', 'distances'] })
    });
    const data = await resp.json();
    return this._formatChromaResults(data, space);
  },
  _formatChromaResults(data, space) {
    if (!data.ids || !data.ids[0]) return [];
    return data.ids[0].map((id, i) => ({
      id,
      convId: data.metadatas?.[0]?.[i]?.convId || '',
      score: this._chromaDistanceToScore(space, data.distances?.[0]?.[i] ?? 0),
      vector: data.embeddings?.[0]?.[i] || null
    }));
  },
  async _deleteChroma(url, apiKey, collection, convId) {
    const { id: uuid } = await this._chromaGetMeta(url, collection);
    const resp = await fetch(`${this._chromaCollectionsBase(url)}/${uuid}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { convId } })
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _clearChroma(url, apiKey, collection) {
    // ChromaDB 删除 collection 后重建一个同名空 collection。
    // delete collection 用名字（不用 UUID）；create 用名字。
    await fetch(this._chromaBase(url, collection), { method: 'DELETE' });
    await fetch(this._chromaCollectionsBase(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: collection })
    });
    return { success: true, count: null };
  },
  async _statsChroma(url, apiKey, collection) {
    // count 是数据级操作，路径要用 UUID
    const { id: uuid } = await this._chromaGetMeta(url, collection);
    const resp = await fetch(`${this._chromaCollectionsBase(url)}/${uuid}/count`, { method: 'GET' });
    if (!resp.ok) return { count: null, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    // ChromaDB count 返回数字
    const count = typeof data === 'number' ? data : (data?.count ?? 0);
    return { count };
  },

  // ---- Milvus ----
  async _addMilvus(url, apiKey, collection, id, vector, metadata) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/entities/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ collectionName: collection, data: [{ id, vector, ...metadata }] })
    });
    const data = await resp.json();
    // Milvus v2 REST API 成功码是 200（与 HTTP 状态码一致），不是 0
    // 失败时 HTTP 仍是 200，但 code != 200 或 message 非空
    if (!resp.ok || (data?.code !== 200 && data?.code !== 0)) {
      const errMsg = `Milvus insert 失败: HTTP ${resp.status}, code=${data?.code}, message=${data?.message || ''}, id=${id}`;
      console.error('[VectorStore]', errMsg);
      throw new Error(errMsg);
    }
    console.log('[VectorStore] Milvus insert 成功:', { id, insertCnt: data?.data?.insertCnt, deleteCnt: data?.data?.deleteCnt, upsertCnt: data?.data?.upsertCnt });
    return data;
  },
  async _searchMilvus(url, apiKey, collection, queryVector, topK) {
    // 必须指定 outputFields，否则 Milvus 只返回 id + distance，convId 等字段拿不到
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/entities/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        collectionName: collection,
        data: [queryVector],
        limit: topK,
        outputFields: ['id', 'convId', 'title', 'platform', 'role', 'content', 'msgHash', 'chunkIdx', 'chunkTotal']
      })
    });
    const data = await resp.json();
    return (data.data || []).map(item => ({
      id: String(item.id),
      convId: item.convId || '',
      title: item.title || '',
      platform: item.platform || '',
      role: item.role || '',
      content: item.content || '',
      score: item.score ?? item.distance ?? 0,
      vector: item.vector || null
    }));
  },
  async _deleteMilvus(url, apiKey, collection, convId) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/entities/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ collectionName: collection, filter: `convId == "${convId}"` })
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _clearMilvus(url, apiKey, collection) {
    // Milvus 按 id 过滤删除全部：用 always-true filter
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/entities/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ collectionName: collection, filter: 'id != ""' })
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _statsMilvus(url, apiKey, collection) {
    // Milvus v2.4 提供 get_stats 接口直接返回 rowCount
    // 不用 query 接口：query 不支持 count 模式，返回的 data 是数组，没有 count 字段
    const resp = await fetch(`${this._trimTrailingSlash(url)}/v2/vectordb/collections/get_stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ collectionName: collection })
    });
    if (!resp.ok) return { count: null, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { count: data?.data?.rowCount ?? null };
  },

  // ---- PostgreSQL+pgvector（通过 PostgREST 访问） ----
  // pgvector 不能直连 PG（Chrome 扩展无 TCP 能力），统一走 PostgREST 协议。
  // 用户需自部署 PostgREST（https://postgrest.org）作为 PG 的 HTTP 网关。
  // 注意：vanilla PostgREST 的 REST 路径为 /<表名> 和 /rpc/<函数名>，
  // 与 Supabase 的 /rest/v1/<表名> 不同（Supabase 通过反向代理加了 /rest/v1 前缀）。
  async _addPgvector(url, apiKey, collection, id, vector, metadata) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ id, embedding: vector, conv_id: metadata.convId, metadata })
    });
    // PostgREST 默认返回 204 No Content（空 body），不能强转 json
    return await parsePostgrestResponse(resp);
  },
  async _searchPgvector(url, apiKey, collection, queryVector, topK) {
    // 需要在 PG 中创建 match_<table> 函数，参考 PostgREST 文档
    const resp = await fetch(`${this._trimTrailingSlash(url)}/rpc/match_${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_embedding: queryVector, match_count: topK })
    });
    const data = await resp.json();
    return (data || []).map(item => ({
      id: item.id,
      convId: item.conv_id || '',
      score: item.similarity || 0,
      vector: null
    }));
  },
  async _deletePgvector(url, apiKey, collection, convId) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/${collection}?conv_id=eq.${encodeURIComponent(convId)}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Prefer': 'return=minimal' }
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _clearPgvector(url, apiKey, collection) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/${collection}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Prefer': 'return=minimal' }
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _statsPgvector(url, apiKey, collection) {
    // PostgREST：HEAD 请求 + Prefer: count=exact 走 SELECT count(*)，准确但稍慢
    // 不用 count=planned：它读 pg_class.reltuples 估算值，TRUNCATE/DELETE 后会陈旧
    const resp = await fetch(`${this._trimTrailingSlash(url)}/${collection}?select=id`, {
      method: 'HEAD',
      headers: { 'apikey': apiKey, 'Prefer': 'count=exact' }
    });
    if (!resp.ok) return { count: null, error: `HTTP ${resp.status}` };
    const range = resp.headers.get('content-range');
    if (range && range.includes('/')) {
      const total = range.split('/')[1];
      const n = parseInt(total, 10);
      return { count: isNaN(n) ? null : n };
    }
    return { count: null };
  },

  // ---- Supabase ----
  // 归一化 Supabase URL：用户可能填入带 /rest/v1/ 后缀的完整地址（官方文档/控制台常这样写），
  // 统一剥掉末尾斜杠和 /rest/v1，再由各方法重新拼接，避免出现 /rest/v1/rest/v1/ 之类的 404。
  _normalizeSupabaseUrl(url) {
    return this._trimTrailingSlash(url).replace(/\/rest\/v1$/i, '');
  },
  async _addSupabase(url, apiKey, collection, id, vector, metadata) {
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ id, embedding: vector, conv_id: metadata.convId, metadata })
    });
    return await parsePostgrestResponse(resp);
  },
  async _searchSupabase(url, apiKey, collection, queryVector, topK) {
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/rpc/match_${collection}`, {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_embedding: queryVector, match_count: topK })
    });
    const data = await resp.json();
    return (data || []).map(item => ({
      id: item.id,
      convId: item.conv_id || '',
      score: item.similarity || 0,
      vector: null
    }));
  },
  async _deleteSupabase(url, apiKey, collection, convId) {
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/${collection}?conv_id=eq.${encodeURIComponent(convId)}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Prefer': 'return=minimal' }
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _clearSupabase(url, apiKey, collection) {
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/${collection}`, {
      method: 'DELETE',
      headers: { 'apikey': apiKey, 'Prefer': 'return=minimal' }
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _statsSupabase(url, apiKey, collection) {
    // PostgREST：HEAD 请求 + Prefer: count=exact 走 SELECT count(*)，准确但稍慢
    const base = this._normalizeSupabaseUrl(url);
    const resp = await fetch(`${base}/rest/v1/${collection}?select=id`, {
      method: 'HEAD',
      headers: { 'apikey': apiKey, 'Prefer': 'count=exact' }
    });
    if (!resp.ok) return { count: null, error: `HTTP ${resp.status}` };
    const range = resp.headers.get('content-range');
    if (range && range.includes('/')) {
      const total = range.split('/')[1];
      const n = parseInt(total, 10);
      return { count: isNaN(n) ? null : n };
    }
    return { count: null };
  },

  // ---- Qdrant ----
  // Qdrant 的 point ID 只接受 unsigned integer 或 UUID，不接受任意字符串。
  // 项目其它后端（ChromaDB/Milvus 等）使用 `${convId}::msg::${hash}::chunk::${idx}` 字符串 ID，
  // 因此在 Qdrant 入口做确定性字符串→UUID 转换，保证同一 embId 每次映射到同一 UUID。
  _strToQdrantUUID(str) {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x811c9dc5 >>> 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x05031813) >>> 0;
    }
    const s = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).padEnd(32, '0');
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
  },
  async _addQdrant(url, apiKey, collection, id, vector, metadata) {
    const uuid = this._strToQdrantUUID(id);
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${collection}/points`, {
      method: 'PUT',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: [{ id: uuid, vector, payload: { ...metadata, _origId: id } }] })
    });
    const data = await resp.json();
    // Qdrant 失败时 status 字段为 error，但 HTTP 状态可能是 200/400/422
    if (!resp.ok || data?.status?.error) {
      throw new Error(`Qdrant 插入失败: ${data?.status?.error || `HTTP ${resp.status}`}`);
    }
    return data;
  },
  async _searchQdrant(url, apiKey, collection, queryVector, topK) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${collection}/points/search`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector: queryVector, limit: topK, with_payload: true })
    });
    const data = await resp.json();
    return (data.result || []).map(item => ({
      id: String(item.id),
      convId: item.payload?.convId || '',
      score: item.score || 0,
      vector: null
    }));
  },
  async _deleteQdrant(url, apiKey, collection, convId) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${collection}/points/delete`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { must: [{ key: 'convId', match: { value: convId } }] } })
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _clearQdrant(url, apiKey, collection) {
    // Qdrant：用空 filter 删除所有 points（filter: {} 等价于匹配全部）
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${collection}/points/delete`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: {} })
    });
    return { success: resp.ok, error: resp.ok ? null : `HTTP ${resp.status}` };
  },
  async _statsQdrant(url, apiKey, collection) {
    const resp = await fetch(`${this._trimTrailingSlash(url)}/collections/${encodeURIComponent(collection)}`, {
      method: 'GET',
      headers: { 'api-key': apiKey }
    });
    if (!resp.ok) return { count: null, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const count = data?.result?.points_count ?? data?.result?.vectors_count ?? null;
    return { count };
  }
};

// ============================================================
// PostgREST 响应解析（pgvector / Supabase 通用）
// ============================================================

// PostgREST 行为：
//   - POST 成功，Prefer 不含 return=representation：返回 204 No Content（空 body）
//   - POST 成功，Prefer: return=representation：返回 201 + 创建的资源 JSON
//   - 失败：返回 4xx/5xx + JSON 错误体（如 {"code":"...","message":"..."}）
// 直接 resp.json() 会在 204 空响应上抛 "Unexpected end of JSON input"，故统一走本函数。
async function parsePostgrestResponse(resp) {
  if (!resp.ok) {
    // 失败：尝试解析错误体（也可能为空，如 404/500 无 body）
    let error = `HTTP ${resp.status}`;
    try {
      const text = await resp.text();
      if (text) {
        try {
          const j = JSON.parse(text);
          error = j.message || j.code || text;
        } catch (e) { /* 错误体非 JSON，使用原始文本 */
          error = text;
        }
      }
    } catch (e) { /* 读取错误体失败，使用 HTTP 状态码作为错误 */ }
    return { success: false, status: resp.status, error };
  }
  // 成功：204 或 201。204 一定无 body；201 也可能无 body（取决于 Prefer）
  const text = await resp.text();
  if (!text) return { success: true, status: resp.status };
  try {
    return { success: true, status: resp.status, data: JSON.parse(text) };
  } catch (e) { /* 非 JSON 响应，返回原始文本 */
    return { success: true, status: resp.status, raw: text };
  }
}

// ============================================================
// 设置持久化
// ============================================================

async function getVectorStoreSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('vectorStoreSettings', (result) => {
      resolve(result.vectorStoreSettings || { backend: 'local', config: {} });
    });
  });
}

async function saveVectorStoreSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ vectorStoreSettings: settings }, resolve);
  });
}

// ============================================================
// 召回（Retrieval）设置持久化
// ============================================================
// mode: 'topk'（仅 Top-K）| 'threshold'（仅相似度阈值）| 'combined'（Top-K + 阈值过滤，默认）
// topK: 召回候选条数上限（远程传给后端作 limit；threshold 模式下放大到 100 保证候选足够）
// scoreThreshold: 相似度下界（0-1），低于此值的候选在客户端过滤掉；阈值模式必填

const RETRIEVAL_DEFAULTS = {
  mode: 'combined',
  topK: 20,
  scoreThreshold: 0.3,
  // 单对话上下文上限（字数）：_buildContexts 据此截断，避免超出 LLM 上下文窗口
  maxContextChars: 8000
};

async function getRetrievalSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('retrievalSettings', (result) => {
      resolve(Object.assign({}, RETRIEVAL_DEFAULTS, result.retrievalSettings || {}));
    });
  });
}

async function saveRetrievalSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ retrievalSettings: settings }, resolve);
  });
}

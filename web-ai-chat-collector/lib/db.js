// lib/db.js - IndexedDB 存储层（CRUD + 全文搜索 + 数据迁移）

const DB_NAME = 'AIChatCollector';
const DB_VERSION = 2;
const STORE_CONVERSATIONS = 'conversations';
const STORE_INDEX = 'searchIndex';
const STORE_QA_HISTORY = 'qaHistory';

// ============================================================
// 数据库初始化
// ============================================================

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 对话存储
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
        convStore.createIndex('platform', 'platform', { unique: false });
        convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // 搜索索引（倒排索引）
      if (!db.objectStoreNames.contains(STORE_INDEX)) {
        const indexStore = db.createObjectStore(STORE_INDEX, { keyPath: 'term' });
        indexStore.createIndex('term', 'term', { unique: true });
      }

      // Q&A 历史记录
      if (!db.objectStoreNames.contains(STORE_QA_HISTORY)) {
        const qaStore = db.createObjectStore(STORE_QA_HISTORY, { keyPath: 'id' });
        qaStore.createIndex('tab', 'tab', { unique: false });
        qaStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================================
// CRUD 操作
// ============================================================

// 剥离思考块和搜索来源块，返回纯回答部分（trim 后）
// 用于对比消息的"正式回答"是否相同：豆包等平台的思考/搜索内容需手动展开或懒加载，
// 首次提取只有回答、后续补充思考或搜索来源，两者回答部分相同应替换而非追加
// 支持的格式：
//   <think>...</think>                  思考块（网络模式 / DOM 模式统一）
//   <search_result>...</search_result>  搜索来源块（网络模式）
//   【搜索】...                          搜索查询词标记（千问 DOM 模式）
//   【来源】...                          搜索结果来源标记（千问 DOM 模式）
function _stripAugmentBlocks(content) {
  if (!content) return '';
  return content
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/<search_result>[\s\S]*?<\/search_result>\s*/g, '')
    .replace(/【搜索】[^\n]*\n*/g, '')
    .replace(/【来源】[^\n]*\n*/g, '')
    .trim();
}

// 按 DOM 快照顺序重排已保存的消息数组
// 场景：DOM 模式下用户向上滚动加载更早的消息，extractMessages 返回的 DOM 顺序是正确的，
// 但 exporter-base.js 只把"未见过的消息"发给 db，db 直接 push 到末尾会破坏顺序。
// domOrder 是当前 DOM 快照中所有消息 hash 的有序列表（虚拟列表场景可能不完整）。
//
// 重排策略：
//   1. 按 domOrder 顺序重建"当前可见部分" ordered
//   2. existingMsgs 中不在 domOrder 的消息（滚出视图的旧消息）按原相对顺序分两组：
//      - 位于 existingMsgs 中"第一个 domOrder 锚点"之前的 → 放 ordered 之前
//      - 位于锚点之后的 → 放 ordered 之后
//   3. 合并：[beforeOrphan, ...ordered, afterOrphan]
//
// 验证场景：
//   向上滚：existing=[A,B,C], 新增 X, DOM=[X,A,B] → push 后 [A,B,C,X] → 重排 [X,A,B,C] ✓
//   向下滚：existing=[A,B,C], 新增 Y, DOM=[B,C,Y] → push 后 [A,B,C,Y] → 重排 [A,B,C,Y] ✓
function _reorderByDomOrder(existingMsgs, domOrder) {
  if (!Array.isArray(existingMsgs) || existingMsgs.length === 0) return existingMsgs;
  if (!Array.isArray(domOrder) || domOrder.length === 0) return existingMsgs;

  const msgMap = new Map(existingMsgs.map(m => [m.hash, m]));
  const domSet = new Set(domOrder);

  // 1. 按 domOrder 重建可见部分（去重，防 domOrder 含重复 hash）
  const ordered = [];
  const placed = new Set();
  for (const h of domOrder) {
    const m = msgMap.get(h);
    if (m && !placed.has(h)) {
      ordered.push(m);
      placed.add(h);
    }
  }

  // domOrder 里的 hash 都不在 existing 中（数据不一致），保持原顺序
  if (ordered.length === 0) return existingMsgs;

  // 2. 锚点：existingMsgs 中第一个也在 domOrder 中的消息位置
  const firstPlacedIdx = existingMsgs.findIndex(m => domSet.has(m.hash));
  if (firstPlacedIdx < 0) {
    // 理论不会走到（ordered.length > 0 说明有交集），保险起见保持原顺序
    return existingMsgs;
  }

  // 3. orphan（不在 domOrder 的消息）按 existingMsgs 原顺序分前后
  const beforeOrphan = [];
  const afterOrphan = [];
  for (let i = 0; i < existingMsgs.length; i++) {
    const m = existingMsgs[i];
    if (domSet.has(m.hash)) continue;
    if (i < firstPlacedIdx) beforeOrphan.push(m);
    else afterOrphan.push(m);
  }

  return [...beforeOrphan, ...ordered, ...afterOrphan];
}

// 保存对话（支持追加和覆盖）
async function saveConversation(data) {
  const db = await openDB();
  const { platform, platformConversationId, title, url, messages, mode, domOrder } = data;
  const convId = `${platform}::${platformConversationId}`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CONVERSATIONS, STORE_INDEX], 'readwrite');
    const convStore = tx.objectStore(STORE_CONVERSATIONS);
    const indexStore = tx.objectStore(STORE_INDEX);

    const getReq = convStore.get(convId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      let result;
      let newMessages = [];

      // 只更新标题（来自会话信息 API，不携带消息）
      if (mode === 'updateTitle') {
        if (existing) {
          if (title && title !== existing.title) {
            existing.title = title;
            existing.updatedAt = new Date().toISOString();
            convStore.put(existing);
          }
          result = { success: true, action: 'titleUpdated', messageCount: existing.messages.length };
        } else {
          // 对话尚未保存（流式响应可能还在路上），跳过；后续保存会带上标题
          result = { success: true, action: 'no-op', messageCount: 0 };
        }
      } else if (existing && mode !== 'overwrite') {
        // 增量追加
        const existingHashes = new Set(existing.messages.map(m => m.hash));
        let newCount = 0;

        for (const msg of messages) {
          if (!existingHashes.has(msg.hash)) {
            // 增量补充替换：若新消息仅在已有消息基础上补充了思考或搜索来源（正式回答相同），
            // 替换原消息而非追加，避免重复。场景：豆包/千问思考块展开后、搜索来源懒加载后二次采集。
            const newAnswer = _stripAugmentBlocks(msg.content);
            if (newAnswer && newAnswer !== msg.content.trim()) {
              // 新消息含思考/搜索补充；查找同角色、回答部分相同的已有消息
              const replaceIdx = existing.messages.findIndex(m =>
                m.role === msg.role &&
                _stripAugmentBlocks(m.content) === newAnswer &&
                msg.content.length > m.content.length
              );
              if (replaceIdx >= 0) {
                const oldLen = existing.messages[replaceIdx].content?.length || 0;
                existing.messages[replaceIdx] = msg;
                newMessages.push(msg);
                newCount++;
                console.log('[DB] 思考补充替换: convId=%s, msgIdx=%d, 旧长度=%d, 新长度=%d',
                  convId, replaceIdx, oldLen, msg.content.length);
                continue;
              }
            }
            existing.messages.push(msg);
            newMessages.push(msg);
            newCount++;
          }
        }

        // DOM 模式滚动加载场景：按 domOrder 重排，修正向上滚动加载的旧消息被错误
        // 追加到对话末尾的问题。domOrder 是当前 DOM 快照中所有消息 hash 的有序列表
        // （可能不完整，虚拟列表场景），用它在 existing.messages 中重建正确顺序。
        if (Array.isArray(domOrder) && domOrder.length > 0) {
          const beforeLen = existing.messages.length;
          existing.messages = _reorderByDomOrder(existing.messages, domOrder);
          console.log('[DB] domOrder 重排: convId=%s, 消息数=%d, domOrder长度=%d',
            convId, existing.messages.length, domOrder.length);
          if (existing.messages.length !== beforeLen) {
            console.warn('[DB] domOrder 重排后消息数变化: %d → %d (convId=%s)',
              beforeLen, existing.messages.length, convId);
          }
        }

        if (newCount > 0) {
          existing.updatedAt = new Date().toISOString();
          if (title) existing.title = title;
          // 只索引新消息
          updateSearchIndex(indexStore, convId, newMessages);
        } else if (title && title !== existing.title) {
          // 没有新消息但标题更新了
          existing.title = title;
          existing.updatedAt = new Date().toISOString();
        }

        convStore.put(existing);
        result = { success: true, action: 'appended', newMessages: newCount };
      } else if (existing && mode === 'overwrite') {
        // 覆盖模式
        const updated = {
          ...existing,
          title: title || existing.title,
          url: url || existing.url,
          messages,
          updatedAt: new Date().toISOString()
        };
        // 重建该对话的搜索索引
        rebuildConvIndex(indexStore, convId, messages);
        convStore.put(updated);
        result = { success: true, action: 'overwritten', messageCount: messages.length };
      } else {
        // 新对话
        const conv = {
          id: convId,
          platform,
          platformConversationId,
          title: title || '未命名对话',
          url: url || '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages
        };
        updateSearchIndex(indexStore, convId, messages);
        convStore.put(conv);
        result = { success: true, action: 'created', messageCount: messages.length };
      }

      tx.oncomplete = () => {
        // 后台触发 embedding（不阻塞保存）
        // 传入 convMeta（platform/title）供远程向量库写入元数据字段
        triggerEmbedding(convId, result.action === 'appended' ? newMessages : messages, { platform, title });
        resolve(result);
      };
      tx.onerror = () => reject(tx.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

// 获取对话列表
async function getConversations(filters = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    const request = store.getAll();

    request.onsuccess = () => {
      let list = request.result || [];
      if (filters.platform) {
        list = list.filter(c => c.platform === filters.platform);
      }
      list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      resolve(list);
    };
    request.onerror = () => reject(request.error);
  });
}

// 获取单条对话
async function getConversation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const store = tx.objectStore(STORE_CONVERSATIONS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 删除对话
async function deleteConversation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CONVERSATIONS, STORE_INDEX], 'readwrite');
    const convStore = tx.objectStore(STORE_CONVERSATIONS);
    const indexStore = tx.objectStore(STORE_INDEX);

    // 先删除对话
    convStore.delete(id);

    // 清理搜索索引中该对话的引用
    clearConvFromIndex(indexStore, id);

    tx.oncomplete = () => {
      // 对话删除成功后，异步清理该对话对应的向量索引（避免孤儿向量）
      // VectorStore 在 background.js 中通过 importScripts 加载，lib 环境下可能未定义
      // 向量清理失败不影响对话删除的成功返回（避免数据不一致）
      (async () => {
        try {
          if (typeof VectorStore === 'undefined' || !VectorStore) return;
          await VectorStore.deleteByConvId(id);
          console.log(`[DB] 已清理对话 ${id} 的向量索引`);
        } catch (e) {
          console.error(`[DB] 清理对话 ${id} 的向量索引失败:`, e);
        }
      })();
      resolve({ success: true });
    };
    tx.onerror = () => reject(tx.error);
  });
}

// 获取状态
async function getStatus() {
  const list = await getConversations();
  return {
    totalConversations: list.length,
    totalMessages: list.reduce((sum, c) => sum + c.messages.length, 0),
    platforms: [...new Set(list.map(c => c.platform))]
  };
}

// ============================================================
// 存储位置信息（用于在设置页展示给用户）
// ============================================================

// 统计单个 objectStore 的条目数
function _countStore(db, storeName) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch (e) {
      resolve(0);
    }
  });
}

// 统计主数据库（AIChatCollector）各 store 条目数
async function _getMainDBStoreCounts() {
  const db = await openDB();
  const stores = [];
  for (const name of db.objectStoreNames) {
    const count = await _countStore(db, name);
    stores.push({ name, count });
  }
  db.close();
  return stores;
}

// 统计 embedding 数据库（AIChatEmbeddings）各 store 条目数
async function _getEmbeddingDBStoreCounts() {
  // openEmbeddingDB 定义在 embedding.js 中
  if (typeof openEmbeddingDB !== 'function') return [];
  const db = await openEmbeddingDB();
  const stores = [];
  for (const name of db.objectStoreNames) {
    const count = await _countStore(db, name);
    stores.push({ name, count });
  }
  db.close();
  return stores;
}

// 获取存储位置信息：数据库列表、各 store 条目数、估算占用、扩展 ID
async function getStorageInfo() {
  const databases = [];

  // 主数据库
  try {
    const mainStores = await _getMainDBStoreCounts();
    databases.push({ name: DB_NAME, version: DB_VERSION, stores: mainStores });
  } catch (e) {
    console.error('[DB] 统计主数据库失败:', e);
  }

  // Embedding 数据库
  try {
    const embStores = await _getEmbeddingDBStoreCounts();
    // embedding.js 里硬编码了数据库名和版本
    databases.push({ name: 'AIChatEmbeddings', version: 1, stores: embStores });
  } catch (e) {
    console.error('[DB] 统计 embedding 数据库失败:', e);
  }

  // 估算存储占用（含 IndexedDB / chrome.storage 等，整个扩展源）
  let usage = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      usage = { usage: est.usage || 0, quota: est.quota || 0 };
    }
  } catch (e) {
    // Service Worker 环境下一般可用，失败则忽略
  }

  return {
    databases,
    usage,
    extensionId: chrome.runtime.id || ''
  };
}

// ============================================================
// 全文搜索
// ============================================================

// 中文分词：字符 bigram + 单字符
function tokenize(text) {
  if (!text) return [];
  const normalized = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, ' ');
  const tokens = new Set();

  // 按空白分割
  const words = normalized.split(/\s+/).filter(w => w.length > 0);
  for (const word of words) {
    tokens.add(word);
    // 对中文做 bigram
    for (let i = 0; i < word.length - 1; i++) {
      if (/[\u4e00-\u9fff]/.test(word[i]) || /[\u4e00-\u9fff]/.test(word[i + 1])) {
        tokens.add(word.substring(i, i + 2));
      }
    }
  }

  return [...tokens];
}

// 更新搜索索引（增量，仅索引新消息）
function updateSearchIndex(indexStore, convId, messages) {
  for (const msg of messages) {
    const text = `${msg.role === 'user' ? '' : ''}${msg.content || ''}`;
    const terms = tokenize(text);
    for (const term of terms) {
      // 读取已有索引项并追加
      const getReq = indexStore.get(term);
      getReq.onsuccess = () => {
        const entry = getReq.result || { term, convIds: {} };
        if (!entry.convIds[convId]) {
          entry.convIds[convId] = 0;
        }
        entry.convIds[convId]++;
        indexStore.put(entry);
      };
    }
  }
}

// 重建某对话的搜索索引
function rebuildConvIndex(indexStore, convId, messages) {
  // 先清理旧索引
  clearConvFromIndex(indexStore, convId);
  // 再添加新索引
  updateSearchIndex(indexStore, convId, messages);
}

// 清理搜索索引中某对话的引用
function clearConvFromIndex(indexStore, convId) {
  const cursorReq = indexStore.openCursor();
  cursorReq.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      const entry = cursor.value;
      if (entry.convIds && entry.convIds[convId] !== undefined) {
        delete entry.convIds[convId];
        if (Object.keys(entry.convIds).length === 0) {
          indexStore.delete(entry.term);
        } else {
          indexStore.put(entry);
        }
      }
      cursor.continue();
    }
  };
}

// 全文搜索：返回匹配的对话列表
async function searchConversations(query, filters = {}) {
  if (!query || !query.trim()) {
    return getConversations(filters);
  }

  const db = await openDB();
  const terms = tokenize(query);

  if (terms.length === 0) {
    return getConversations(filters);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CONVERSATIONS, STORE_INDEX], 'readonly');
    const indexStore = tx.objectStore(STORE_INDEX);

    // 收集每个 term 对应的 convId 及其匹配次数
    const convScores = {};
    let pending = terms.length;

    if (pending === 0) {
      resolve([]);
      return;
    }

    for (const term of terms) {
      const req = indexStore.get(term);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && entry.convIds) {
          for (const [convId, count] of Object.entries(entry.convIds)) {
            convScores[convId] = (convScores[convId] || 0) + count;
          }
        }
        pending--;
        if (pending === 0) {
          // 按匹配分数排序，获取对话详情
          const sortedIds = Object.entries(convScores)
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id);

          // 获取对话详情
          const convStore = tx.objectStore(STORE_CONVERSATIONS);
          const results = [];
          let fetched = 0;

          if (sortedIds.length === 0) {
            resolve([]);
            return;
          }

          for (const convId of sortedIds) {
            const getReq = convStore.get(convId);
            getReq.onsuccess = () => {
              const conv = getReq.result;
              if (conv) {
                // 应用平台过滤
                if (!filters.platform || conv.platform === filters.platform) {
                  results.push({ ...conv, _score: convScores[convId] });
                }
              }
              fetched++;
              if (fetched === sortedIds.length) {
                // 按分数排序
                results.sort((a, b) => b._score - a._score);
                // 移除内部字段
                resolve(results.map(({ _score, ...rest }) => rest));
              }
            };
            getReq.onerror = () => {
              fetched++;
              if (fetched === sortedIds.length) {
                results.sort((a, b) => b._score - a._score);
                resolve(results.map(({ _score, ...rest }) => rest));
              }
            };
          }
        }
      };
      req.onerror = () => {
        pending--;
        if (pending === 0) {
          resolve([]);
        }
      };
    }
  });
}

// 高亮搜索结果：返回消息列表，匹配片段被 <mark> 标记
function highlightSearchResult(messages, query) {
  if (!query || !query.trim()) return messages;

  const terms = tokenize(query);
  if (terms.length === 0) return messages;

  // 构建正则（按长度降序，优先匹配长词）
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const pattern = sorted.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(pattern, 'gi');

  return messages.map(msg => ({
    ...msg,
    highlighted: (msg.content || '').replace(regex, '<mark>$&</mark>')
  }));
}

// 初始化：打开数据库
async function initDB() {
  await openDB();
}

// ============================================================
// 后台 Embedding 触发（保存对话时自动调用）
// ============================================================

function triggerEmbedding(convId, messages, convMeta = {}) {
  // db.js 只在 background.js 中通过 importScripts 加载，
  // 所以这里直接调用 EmbeddingService，不需要发消息
  // convMeta: { platform, title } 远程向量库需要的对话级元数据
  (async () => {
    try {
      if (typeof EmbeddingService === 'undefined' || typeof VectorStore === 'undefined') {
        console.warn('[DB/Embedding] 跳过：EmbeddingService 或 VectorStore 未定义');
        return;
      }
      if (!EmbeddingService.isConfigured()) {
        console.warn('[DB/Embedding] 跳过：DashScope API Key 未配置');
        return;
      }
      console.log(`[DB/Embedding] 触发：convId=${convId}，消息数=${messages.length}`);

      const batchItems = [];
      for (const msg of messages) {
        if (!msg.content || !msg.content.trim()) continue;
        // 根据设置剥离 <think>/<search_result> 块后再 embedding
        const embedContent = EmbeddingService.filterContentForEmbedding(msg.content);
        if (!embedContent) continue;
        // 按当前切片设置切成多段，逐段 embedding
        const chunks = await EmbeddingService.embedMessageChunks(embedContent);
        const msgKey = msg.hash || Date.now();
        for (const c of chunks) {
          batchItems.push({
            id: `${convId}::msg::${msgKey}::chunk::${c.chunkIdx}`,
            vector: c.vector,
            metadata: {
              convId,
              title: convMeta.title || '',
              platform: convMeta.platform || '',
              role: msg.role || '',
              // content 用切片后的文本（已按设置剥离 think/search_result 块）
              // 不直接用 msg.content：长消息会超过 Milvus content 字段 max_length
              content: c.text || '',
              msgHash: String(msgKey),
              chunkIdx: c.chunkIdx,
              chunkTotal: c.total
            }
          });
        }
      }
      // 整个对话一次批量写入
      if (batchItems.length > 0) {
        await VectorStore.addVectors(batchItems);
      }
      console.log(`[DB/Embedding] 对话 ${convId} 的 ${messages.length} 条消息 embedding 完成`);
    } catch (e) {
      console.error('[DB/Embedding] 后台 embedding 失败:', e);
    }
  })();
}

// ============================================================
// Q&A 历史记录 CRUD
// ============================================================

// 保存一条 Q&A 记录
async function saveQAHistory(data) {
  const db = await openDB();
  const { id, tab, query, answer, reasoning } = data;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QA_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_QA_HISTORY);

    const record = {
      id: id || `qa_${Date.now()}`,
      tab: tab || 'chat',
      query: query || '',
      answer: answer || '',
      reasoning: reasoning || '',
      createdAt: new Date().toISOString()
    };

    store.put(record);

    tx.oncomplete = () => resolve({ success: true, id: record.id });
    tx.onerror = () => reject(tx.error);
  });
}

// 获取 Q&A 历史列表（按时间倒序）
async function getQAHistory(filters = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QA_HISTORY, 'readonly');
    const store = tx.objectStore(STORE_QA_HISTORY);
    const request = store.getAll();

    request.onsuccess = () => {
      let list = request.result || [];
      if (filters.tab) {
        list = list.filter(r => r.tab === filters.tab);
      }
      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      resolve(list);
    };
    request.onerror = () => reject(request.error);
  });
}

// 获取单条 Q&A 记录
async function getQAHistoryItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QA_HISTORY, 'readonly');
    const store = tx.objectStore(STORE_QA_HISTORY);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 删除一条 Q&A 记录
async function deleteQAHistory(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QA_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_QA_HISTORY);
    store.delete(id);
    tx.oncomplete = () => resolve({ success: true });
    tx.onerror = () => reject(tx.error);
  });
}

// 清空所有 Q&A 历史
async function clearQAHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QA_HISTORY, 'readwrite');
    const store = tx.objectStore(STORE_QA_HISTORY);
    store.clear();
    tx.oncomplete = () => resolve({ success: true });
    tx.onerror = () => reject(tx.error);
  });
}

// bg/local-app.js - 本地软件（knowledge-work-assistant）对接
// 依赖: lib/db.js (getConversations), lib/embedding.js, chrome.alarms, chrome.storage
//       bg/export.js (formatConversation)
//
// 设计要点：
// 1. 后端已有 POST /api/plugin/conversations 单条推送接口，含 24h 幂等去重
//    （基于 metadata.conversation_id），重复推送安全。
// 2. Chrome MV3 service worker 会休眠，定时器用 chrome.alarms（最小 1 分钟）。
//    同时每次插件保存新对话时，若启用对接，立即异步推送一次（即时反馈，
//    不阻塞 SAVE_CONVERSATION 的响应）。
// 3. 本地后端不可达时静默失败（console.warn），不阻断插件其他功能。
// 4. 用 chrome.storage.local 维护 pushedConvIds，避免重复请求已推送且未变更的对话。
//    后端 24h 去重是兜底，本地维护是优化（避免无谓的 HTTP 请求）。

// ===== 常量 =====

// 本地软件后端默认地址（knowledge-work-assistant backend 监听 8788）
const LOCAL_APP_DEFAULT_URL = 'http://localhost:8788';

// chrome.alarms 名称
const LOCAL_APP_ALARM = 'local-app-push';

// chrome.storage.local 中存储已推送对话映射的 key
const PUSHED_KEY = 'localAppPushedConvIds';

// chrome.storage.local 中存储设置的 key
const SETTINGS_KEY = 'localAppSettings';
const REVISION_KEY = 'localAppConversationRevisions';
const LOCAL_APP_API_VERSION = '1.0';

// 默认设置
const DEFAULT_LOCAL_APP_SETTINGS = {
  enabled: false,            // 总开关：是否启用与本地软件的对接
  autoPush: false,           // 是否启用定时自动推送
  pushOnSave: true,           // 保存新对话时立即推送（不影响定时器）
  intervalMinutes: 1,        // 定时推送间隔（chrome.alarms 最小 1 分钟）
  baseUrl: LOCAL_APP_DEFAULT_URL,
  credential: ''
};

// 插件 platform → 后端 SUPPORTED_PLATFORMS 白名单映射
// 后端白名单（与插件实际采集的 6 家对齐）：
//   deepseek / qwen / doubao / kimi / yuanbao / wenxin
const PLATFORM_MAP = {
  deepseek: 'deepseek',
  qianwen: 'qwen',
  qwen: 'qwen',
  doubao: 'doubao',
  kimi: 'kimi',
  yuanbao: 'yuanbao',
  wenxin: 'wenxin'
};

// ===== 模块状态 =====

let _settings = { ...DEFAULT_LOCAL_APP_SETTINGS };
let _pushedMap = {};  // { [convId]: { pushedAt, observationId, deduplicated, updatedAt } }
let _revisionMap = {};
let _revisionLoadPromise = null;
let _initialized = false;

function _authHeaders(headers = {}) {
  return _settings.credential
    ? { ...headers, 'X-Plugin-Credential': _settings.credential }
    : headers;
}

// ===== 设置读写 =====

function getLocalAppSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      resolve({ ...DEFAULT_LOCAL_APP_SETTINGS, ...(result[SETTINGS_KEY] || {}) });
    });
  });
}

function saveLocalAppSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, resolve);
  });
}

// ===== 已推送映射读写 =====

function loadPushedMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PUSHED_KEY, (result) => {
      _pushedMap = result[PUSHED_KEY] || {};
      resolve(_pushedMap);
    });
  });
}

function savePushedMap() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PUSHED_KEY]: _pushedMap }, resolve);
  });
}

function loadRevisionMap() {
  if (_revisionLoadPromise) return _revisionLoadPromise;
  _revisionLoadPromise = new Promise((resolve) => {
    chrome.storage.local.get(REVISION_KEY, (result) => {
      _revisionMap = result[REVISION_KEY] || {};
      resolve(_revisionMap);
    });
  });
  return _revisionLoadPromise;
}

function saveRevisionMap() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [REVISION_KEY]: _revisionMap }, resolve);
  });
}

function _conversationRevision(conv) {
  return conv.updatedAt || _revisionMap[conv.id] || null;
}

async function _ensureConversationRevision(conv) {
  await loadRevisionMap();
  const existing = _conversationRevision(conv);
  if (existing) return existing;
  const revision = new Date().toISOString();
  _revisionMap[conv.id] = revision;
  await saveRevisionMap();
  return revision;
}

function _validateHealthResponse(data) {
  if (!data || data.ok !== true || typeof data.version !== 'string' ||
      !Array.isArray(data.supported_platforms) ||
      !data.supported_platforms.every(item => typeof item === 'string') ||
      !Number.isInteger(data.queue_size) || data.queue_size < 0) {
    throw new Error('后端健康检查响应不符合契约');
  }
  if (data.version !== LOCAL_APP_API_VERSION) {
    throw new Error(`API 版本不兼容：插件 ${LOCAL_APP_API_VERSION}，后端 ${data.version}`);
  }
  return data;
}

function _validatePushResponse(data) {
  if (!data || data.received !== true || typeof data.observation_id !== 'string' ||
      data.observation_id.length === 0 || typeof data.deduplicated !== 'boolean') {
    throw new Error('后端推送响应不符合契约');
  }
  return data;
}

// ===== 初始化 =====

async function LocalApp_init() {
  if (_initialized) return;
  _settings = await getLocalAppSettings();
  await Promise.all([loadPushedMap(), loadRevisionMap()]);
  await _syncAlarm();
  chrome.alarms.onAlarm.addListener(_onAlarm);
  _initialized = true;
  console.log('[LocalApp] 初始化完成:', { ..._settings, pushedCount: Object.keys(_pushedMap).length });
}

// ===== 定时器管理 =====

async function _syncAlarm() {
  // 先清除旧 alarm（无论启用与否，确保幂等）
  await chrome.alarms.clear(LOCAL_APP_ALARM);
  if (_settings.enabled && _settings.autoPush) {
    // chrome.alarms 最小 periodInMinutes 为 1 分钟（MV3 限制）
    const periodInMinutes = Math.max(1, _settings.intervalMinutes || 1);
    await chrome.alarms.create(LOCAL_APP_ALARM, { periodInMinutes });
    console.log(`[LocalApp] 定时推送已启用：每 ${periodInMinutes} 分钟`);
  } else {
    console.log('[LocalApp] 定时推送未启用');
  }
}

async function _onAlarm(alarm) {
  if (alarm.name !== LOCAL_APP_ALARM) return;
  if (!_settings.enabled || !_settings.autoPush) return;
  try {
    await LocalApp_pushAll({ silent: true });
  } catch (e) {
    console.warn('[LocalApp] 定时推送异常（静默）:', e);
  }
}

// ===== 推送逻辑 =====

function _authHeaders(headers = {}) {
  return _settings.credential
    ? { ...headers, 'X-Plugin-Credential': _settings.credential }
    : { ...headers };
}

// 把单条对话转换为后端 POST /api/plugin/conversations 的请求体
function _buildRequestBody(conv, revision = _conversationRevision(conv)) {
  if (!revision) throw new Error('对话 revision 尚未初始化');
  const platform = PLATFORM_MAP[conv.platform] || 'custom';
  const markdown = (typeof formatConversation === 'function')
    ? formatConversation(conv, 'markdown')
    : _fallbackMarkdown(conv);
  return {
    platform,
    timestamp: revision,
    conversation_markdown: markdown,
    metadata: {
      conversation_id: `${conv.id}@${revision}`,
      source_conversation_id: conv.id,
      conversation_revision: revision,
      title: conv.title || '',
      url: conv.url || ''
    }
  };
}

// 兜底 Markdown 转换（bg/export.js 加载失败时用）
function _fallbackMarkdown(conv) {
  let md = `# ${conv.title || '未命名对话'}\n\n`;
  md += `> 平台: ${conv.platform} | 更新: ${conv.updatedAt}\n\n`;
  if (conv.url) md += `> 链接: ${conv.url}\n\n`;
  for (const msg of (conv.messages || [])) {
    const label = msg.role === 'user' ? '用户' : '助手';
    md += `## ${label}\n\n${msg.content || ''}\n\n`;
  }
  return md;
}

// 推送单条对话
// 返回 { pushed: true/false, skipped: true/false, reason, data }
async function LocalApp_pushConversation(conv) {
  if (!_settings.enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const revision = await _ensureConversationRevision(conv);
  const pushed = _pushedMap[conv.id];
  if (pushed && (pushed.revision || pushed.updatedAt) === revision) {
    return { skipped: true, reason: 'already_pushed', data: pushed };
  }

  const body = _buildRequestBody(conv, revision);
  const url = `${_settings.baseUrl.replace(/\/+$/, '')}/api/plugin/conversations`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: _authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
  } catch (e) {
    // 网络错误（本地后端未启动）：抛给上层静默处理
    throw new Error(`连接失败: ${e.message}`);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = _validatePushResponse(await resp.json());

  // 记录已推送状态
  _pushedMap[conv.id] = {
    pushedAt: new Date().toISOString(),
    observationId: data.observation_id,
    deduplicated: data.deduplicated,
    revision,
    updatedAt: conv.updatedAt
  };
  await savePushedMap();

  return { pushed: true, data };
}

// 推送所有未推送（或已变更）的对话
// 选项：silent=true 时不打印详细日志（用于定时器静默推送）
// 返回 { total, pushed, skipped, failed }
async function LocalApp_pushAll(options = {}) {
  const { silent = false } = options;
  if (!_settings.enabled) {
    return { total: 0, pushed: 0, skipped: 0, failed: 0, reason: 'disabled' };
  }

  const list = await getConversations();
  let pushed = 0, skipped = 0, failed = 0;
  const failures = [];

  for (const conv of list) {
    try {
      const r = await LocalApp_pushConversation(conv);
      if (r.pushed) pushed++;
      else if (r.skipped) skipped++;
    } catch (e) {
      failed++;
      failures.push({ id: conv.id, title: conv.title, error: e.message });
      // 后端不可达时，第一条就退出循环（避免 100 个对话都超时）
      if (/连接失败|Failed to fetch|NetworkError/i.test(e.message)) {
        if (!silent) console.warn('[LocalApp] 后端不可达，停止后续推送:', e.message);
        // 剩余的算作 skipped（待后续重试）
        skipped += list.length - (pushed + skipped + failed);
        break;
      }
    }
  }

  if (!silent) {
    console.log(`[LocalApp] 推送完成: 共 ${list.length} 条，成功 ${pushed}，跳过 ${skipped}，失败 ${failed}`);
    if (failures.length > 0) {
      console.warn('[LocalApp] 失败明细:', failures);
    }
  }

  return {
    total: list.length,
    pushed,
    skipped,
    failed,
    failures
  };
}

// 单条对话保存后即时推送（不阻塞 SAVE_CONVERSATION 响应）
// 在 bg/router.js 的 SAVE_CONVERSATION 处理完成后异步调用
async function LocalApp_onConversationSaved(saveResult) {
  if (!_settings.enabled || !_settings.pushOnSave) return;
  // 仅在「新增/追加/覆盖」时推送，标题更新和 no-op 不推
  if (!saveResult || !saveResult.success) return;
  const action = saveResult.action;
  if (action !== 'created' && action !== 'appended' && action !== 'overwritten') return;

  // 推送该对话：需要先查到完整记录（saveResult 不含 conv 本体）
  // 通过遍历 getConversations 找到刚保存的 convId 不现实，由调用方传入 convId
  // 这里只做转发：调用方应使用 LocalApp_pushByConvId
}

// 按对话 ID 即时推送（用于保存后即时推送）
async function LocalApp_pushByConvId(convId) {
  if (!_settings.enabled || !_settings.pushOnSave) return { skipped: true, reason: 'disabled' };
  // 直接从 db 取单条对话（getConversation 在 lib/db.js 中定义）
  let conv;
  try {
    conv = await getConversation(convId);
  } catch (e) {
    console.warn('[LocalApp] 读取对话失败:', e);
    return { skipped: true, reason: 'read_failed', error: e.message };
  }
  if (!conv) return { skipped: true, reason: 'not_found' };

  try {
    const r = await LocalApp_pushConversation(conv);
    if (r.pushed) {
      console.log(`[LocalApp] 保存后即时推送成功: convId=${convId}`);
    }
    return r;
  } catch (e) {
    console.warn(`[LocalApp] 保存后即时推送失败（静默）: convId=${convId}`, e.message);
    return { skipped: true, reason: 'push_failed', error: e.message };
  }
}

// ===== 连通性测试 =====

// 调用 GET /api/plugin/health，返回后端版本和支持平台
async function LocalApp_pair(code) {
  const url = `${_settings.baseUrl.replace(/\/+$/, '')}/api/plugin/pair`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code || '').trim() })
  });
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
  const data = await resp.json();
  await LocalApp_applySettings({ ..._settings, credential: data.credential });
  return { success: true };
}

async function LocalApp_testConnection() {
  const url = `${_settings.baseUrl.replace(/\/+$/, '')}/api/plugin/health`;
  const start = Date.now();
  let resp;
  try {
    resp = await fetch(url, { method: 'GET', headers: _authHeaders() });
  } catch (e) {
    return { success: false, error: `连接失败：${e.message}` };
  }
  const latency = Date.now() - start;
  if (!resp.ok) {
    return { success: false, error: `HTTP ${resp.status}` };
  }
  let data;
  try {
    data = _validateHealthResponse(await resp.json());
  } catch (e) {
    return { success: false, error: e.message };
  }
  return {
    success: true,
    latency,
    version: data.version,
    supported_platforms: data.supported_platforms,
    queue_size: data.queue_size
  };
}

// ===== 状态查询 =====

// 返回已推送统计，供 popup / settings 展示
async function LocalApp_getStatus() {
  await loadPushedMap();
  const ids = Object.keys(_pushedMap);
  return {
    enabled: _settings.enabled,
    autoPush: _settings.autoPush,
    pushOnSave: _settings.pushOnSave,
    intervalMinutes: _settings.intervalMinutes,
    baseUrl: _settings.baseUrl,
    paired: !!_settings.credential,
    pushedCount: ids.length,
    pushedItems: ids.map(id => ({
      convId: id,
      ..._pushedMap[id]
    })).sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt))
  };
}

// ===== 设置变更钩子（由 settings-handlers.js 调用）=====

async function LocalApp_applySettings(newSettings) {
  _settings = { ...DEFAULT_LOCAL_APP_SETTINGS, ...newSettings };
  await saveLocalAppSettings(_settings);
  await _syncAlarm();
  return { success: true };
}

// 重置已推送映射（用户手动重置时用）
async function LocalApp_resetPushedMap() {
  _pushedMap = {};
  await savePushedMap();
  return { success: true };
}

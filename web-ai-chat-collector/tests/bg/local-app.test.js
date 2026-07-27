// tests/bg/local-app.test.js
// bg/local-app.js 测试：插件↔本地应用（knowledge-work-assistant）对接的契约守卫
//
// 这是跨子工程的契约代码：请求体结构必须与后端
// knowledge-work-assistant/backend/app/routers/plugin.py 的
// POST /api/plugin/conversations 对齐（platform 白名单、metadata.conversation_id
// 用于 24h 幂等去重）。改 _buildRequestBody / PLATFORM_MAP 时本测试立即失败，
// 提示同步后端契约。
//
// 网络相关函数（testConnection / pushConversation / pushAll）通过 mock window.fetch
// 测试，不依赖真实后端运行。getConversations / getConversation 由测试按需 mock。

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadLocalApp } from '../helpers/load-source.js';

let lib;
let fetchMock;

beforeAll(() => {
  lib = loadLocalApp();
});

beforeEach(() => {
  // 重置模块状态到默认（禁用 + 空 pushedMap）
  lib.setSettings({
    enabled: false,
    autoPush: false,
    pushOnSave: true,
    intervalMinutes: 1,
    baseUrl: 'http://localhost:8788'
  });
  lib.setPushedMap({});
  // 每个测试用全新的 fetch mock
  fetchMock = vi.fn();
  window.fetch = fetchMock;
});

// =================================================================
// _buildRequestBody：请求体契约（与后端 POST /api/plugin/conversations 对齐）
// 注意：未加载 bg/export.js，formatConversation 未定义，走 _fallbackMarkdown 路径
// =================================================================
describe('_buildRequestBody', () => {
  it('platform 映射：qianwen → qwen（后端白名单用 qwen 不是 qianwen）', () => {
    const conv = { id: 'c1', platform: 'qianwen', updatedAt: '2025-01-01T00:00:00Z', messages: [] };
    const body = lib._buildRequestBody(conv);
    expect(body.platform).toBe('qwen');
  });

  it('platform 映射：未知平台 → custom（后端兜底白名单）', () => {
    const conv = { id: 'c1', platform: 'unknown-xyz', updatedAt: '2025-01-01T00:00:00Z', messages: [] };
    const body = lib._buildRequestBody(conv);
    expect(body.platform).toBe('custom');
  });

  it('metadata.conversation_id 等于 conv.id（后端 24h 幂等去重的关键）', () => {
    const conv = {
      id: 'conv-abc-123',
      platform: 'deepseek',
      updatedAt: '2025-01-01T00:00:00Z',
      title: '测试标题',
      url: 'https://chat.deepseek.com/c/abc',
      messages: []
    };
    const body = lib._buildRequestBody(conv);
    expect(body.metadata.conversation_id).toBe('conv-abc-123');
    expect(body.metadata.title).toBe('测试标题');
    expect(body.metadata.url).toBe('https://chat.deepseek.com/c/abc');
  });

  it('timestamp 用 conv.updatedAt', () => {
    const ts = '2025-06-15T12:30:45+08:00';
    const conv = { id: 'c1', platform: 'deepseek', updatedAt: ts, messages: [] };
    const body = lib._buildRequestBody(conv);
    expect(body.timestamp).toBe(ts);
  });

  it('conversation_markdown 非空（走 _fallbackMarkdown 路径）', () => {
    const conv = {
      id: 'c1',
      platform: 'deepseek',
      updatedAt: '2025-01-01T00:00:00Z',
      title: 'T',
      messages: [{ role: 'user', content: '你好' }]
    };
    const body = lib._buildRequestBody(conv);
    expect(body.conversation_markdown).toContain('你好');
    expect(body.conversation_markdown).toContain('# T');
  });

  it('title/url 缺失时 metadata 用空串兜底', () => {
    const conv = { id: 'c1', platform: 'deepseek', updatedAt: '2025-01-01T00:00:00Z', messages: [] };
    const body = lib._buildRequestBody(conv);
    expect(body.metadata.title).toBe('');
    expect(body.metadata.url).toBe('');
  });

  it('请求体顶层字段：platform / timestamp / conversation_markdown / metadata 齐全', () => {
    const conv = { id: 'c1', platform: 'kimi', updatedAt: 'ts', messages: [] };
    const body = lib._buildRequestBody(conv);
    expect(body).toHaveProperty('platform');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('conversation_markdown');
    expect(body).toHaveProperty('metadata');
  });
});

// =================================================================
// _fallbackMarkdown：兜底 Markdown 转换（bg/export.js 未加载时用）
// =================================================================
describe('_fallbackMarkdown', () => {
  it('含标题、平台、更新时间、用户/助手消息', () => {
    const conv = {
      title: '测试对话',
      platform: 'deepseek',
      updatedAt: '2025-01-01T00:00:00Z',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你？' }
      ]
    };
    const md = lib._fallbackMarkdown(conv);
    expect(md).toContain('# 测试对话');
    expect(md).toContain('平台: deepseek');
    expect(md).toContain('更新: 2025-01-01T00:00:00Z');
    expect(md).toContain('## 用户');
    expect(md).toContain('你好');
    expect(md).toContain('## 助手');
    expect(md).toContain('有什么可以帮你');
  });

  it('无标题时用"未命名对话"', () => {
    const conv = { platform: 'kimi', updatedAt: 'ts', messages: [] };
    const md = lib._fallbackMarkdown(conv);
    expect(md).toContain('# 未命名对话');
  });

  it('有 url 时含链接行', () => {
    const conv = {
      title: 'T',
      platform: 'deepseek',
      updatedAt: 'ts',
      url: 'https://example.com/c/1',
      messages: []
    };
    const md = lib._fallbackMarkdown(conv);
    expect(md).toContain('链接: https://example.com/c/1');
  });

  it('无消息时不生成 ## 用户 / ## 助手 段', () => {
    const conv = { title: 'T', platform: 'deepseek', updatedAt: 'ts', messages: [] };
    const md = lib._fallbackMarkdown(conv);
    expect(md).not.toContain('## 用户');
    expect(md).not.toContain('## 助手');
  });
});

// =================================================================
// LocalApp_testConnection：连通性测试（GET /api/plugin/health）
// =================================================================
describe('LocalApp_testConnection', () => {
  beforeEach(() => {
    lib.setSettings({ enabled: true, baseUrl: 'http://localhost:8788' });
  });

  it('成功：返回 success/version/supported_platforms/queue_size/latency', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        version: '1.0',
        supported_platforms: ['chatgpt', 'deepseek', 'qwen'],
        queue_size: 3
      })
    });
    const r = await lib.LocalApp_testConnection();
    expect(r.success).toBe(true);
    expect(r.version).toBe('1.0');
    expect(r.supported_platforms).toEqual(['chatgpt', 'deepseek', 'qwen']);
    expect(r.queue_size).toBe(3);
    expect(typeof r.latency).toBe('number');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8788/api/plugin/health');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('网络错误（后端未启动）：返回 success:false + error 含"连接失败"', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    const r = await lib.LocalApp_testConnection();
    expect(r.success).toBe(false);
    expect(r.error).toContain('连接失败');
  });

  it('HTTP 错误：返回 success:false + error 含状态码', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({})
    });
    const r = await lib.LocalApp_testConnection();
    expect(r.success).toBe(false);
    expect(r.error).toContain('500');
  });

  it('baseUrl 含末尾斜杠时正确拼接（去斜杠）', async () => {
    lib.setSettings({ enabled: true, baseUrl: 'http://localhost:8788/' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, version: '1.0', supported_platforms: [], queue_size: 0 })
    });
    await lib.LocalApp_testConnection();
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8788/api/plugin/health');
  });
});

// =================================================================
// LocalApp_pushConversation：单条推送（POST /api/plugin/conversations）
// =================================================================
describe('LocalApp_pushConversation', () => {
  const conv = {
    id: 'conv-1',
    platform: 'deepseek',
    updatedAt: '2025-01-01T00:00:00Z',
    title: 'T',
    messages: [{ role: 'user', content: 'hi' }]
  };

  it('禁用时跳过，不发起请求', async () => {
    lib.setSettings({ enabled: false });
    const r = await lib.LocalApp_pushConversation(conv);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已推送且对话未变更时跳过（增量优化）', async () => {
    lib.setSettings({ enabled: true });
    lib.setPushedMap({
      'conv-1': {
        pushedAt: '2025-01-01T01:00:00Z',
        observationId: 'obs-1',
        updatedAt: conv.updatedAt
      }
    });
    const r = await lib.LocalApp_pushConversation(conv);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('already_pushed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已推送但对话已变更（updatedAt 不同）时重新推送', async () => {
    lib.setSettings({ enabled: true });
    lib.setPushedMap({
      'conv-1': { pushedAt: 'x', observationId: 'obs-1', updatedAt: '2025-01-01T00:00:00Z' }
    });
    const changedConv = { ...conv, updatedAt: '2025-01-02T00:00:00Z' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, deduplicated: false, observation_id: 'obs-2' })
    });
    const r = await lib.LocalApp_pushConversation(changedConv);
    expect(r.pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功推送：记录到 _pushedMap（含 observationId/deduplicated/updatedAt）', async () => {
    lib.setSettings({ enabled: true });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, deduplicated: false, observation_id: 'obs-new' })
    });
    const r = await lib.LocalApp_pushConversation(conv);
    expect(r.pushed).toBe(true);
    expect(r.data.observation_id).toBe('obs-new');
    const pushed = lib.getPushedMap()['conv-1'];
    expect(pushed).toBeDefined();
    expect(pushed.observationId).toBe('obs-new');
    expect(pushed.deduplicated).toBe(false);
    expect(pushed.updatedAt).toBe(conv.updatedAt);
  });

  it('网络错误时抛出"连接失败"（交给上层静默处理）', async () => {
    lib.setSettings({ enabled: true });
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(lib.LocalApp_pushConversation(conv)).rejects.toThrow('连接失败');
  });

  it('HTTP 错误时抛出"HTTP xxx"', async () => {
    lib.setSettings({ enabled: true });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'unsupported platform' })
    });
    await expect(lib.LocalApp_pushConversation(conv)).rejects.toThrow('HTTP 400');
  });

  it('请求 URL 为 baseUrl + /api/plugin/conversations，method=POST', async () => {
    lib.setSettings({ enabled: true, baseUrl: 'http://localhost:8788/' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, observation_id: 'obs-1' })
    });
    await lib.LocalApp_pushConversation(conv);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8788/api/plugin/conversations');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  it('请求体 JSON 含 platform/timestamp/conversation_markdown/metadata', async () => {
    lib.setSettings({ enabled: true });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, observation_id: 'obs-1' })
    });
    await lib.LocalApp_pushConversation(conv);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.platform).toBe('deepseek');
    expect(body.timestamp).toBe(conv.updatedAt);
    expect(body.conversation_markdown).toContain('hi');
    expect(body.metadata.conversation_id).toBe('conv-1');
  });
});

// =================================================================
// LocalApp_pushAll：批量推送（聚合 + 后端不可达提前退出）
// 依赖全局 getConversations（lib/db.js），测试中 mock window.getConversations
// =================================================================
describe('LocalApp_pushAll', () => {
  it('禁用时返回 reason:disabled，不读对话', async () => {
    lib.setSettings({ enabled: false });
    const r = await lib.LocalApp_pushAll();
    expect(r.total).toBe(0);
    expect(r.reason).toBe('disabled');
  });

  it('后端不可达时第一条就退出，剩余算 skipped（避免 100 个对话都超时）', async () => {
    lib.setSettings({ enabled: true });
    const convs = [
      { id: 'c1', platform: 'deepseek', updatedAt: 'ts1', title: 'A', messages: [] },
      { id: 'c2', platform: 'deepseek', updatedAt: 'ts2', title: 'B', messages: [] },
      { id: 'c3', platform: 'deepseek', updatedAt: 'ts3', title: 'C', messages: [] }
    ];
    window.getConversations = async () => convs;
    fetchMock.mockRejectedValue(new Error('Failed to fetch'));
    const r = await lib.LocalApp_pushAll();
    expect(r.total).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.pushed).toBe(0);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].id).toBe('c1');
  });

  it('全部成功时返回 pushed 计数', async () => {
    lib.setSettings({ enabled: true });
    const convs = [
      { id: 'c1', platform: 'deepseek', updatedAt: 'ts1', messages: [] },
      { id: 'c2', platform: 'kimi', updatedAt: 'ts2', messages: [] }
    ];
    window.getConversations = async () => convs;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ received: true, observation_id: 'obs-x' })
    });
    const r = await lib.LocalApp_pushAll();
    expect(r.total).toBe(2);
    expect(r.pushed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('已推送且未变更的对话跳过，不发起请求', async () => {
    lib.setSettings({ enabled: true });
    const convs = [
      { id: 'c1', platform: 'deepseek', updatedAt: 'ts1', messages: [] }
    ];
    lib.setPushedMap({
      'c1': { pushedAt: 'x', observationId: 'o1', updatedAt: 'ts1' }
    });
    window.getConversations = async () => convs;
    const r = await lib.LocalApp_pushAll();
    expect(r.skipped).toBe(1);
    expect(r.pushed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =================================================================
// LocalApp_pushByConvId：按 ID 即时推送（保存后触发）
// 依赖全局 getConversation（lib/db.js），测试中 mock window.getConversation
// =================================================================
describe('LocalApp_pushByConvId', () => {
  it('禁用时跳过', async () => {
    lib.setSettings({ enabled: false, pushOnSave: true });
    const r = await lib.LocalApp_pushByConvId('c1');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('disabled');
  });

  it('pushOnSave 关闭时跳过', async () => {
    lib.setSettings({ enabled: true, pushOnSave: false });
    const r = await lib.LocalApp_pushByConvId('c1');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('disabled');
  });

  it('对话不存在时返回 not_found', async () => {
    lib.setSettings({ enabled: true, pushOnSave: true });
    window.getConversation = async () => null;
    const r = await lib.LocalApp_pushByConvId('c1');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('not_found');
  });

  it('成功推送', async () => {
    lib.setSettings({ enabled: true, pushOnSave: true });
    const conv = { id: 'c1', platform: 'deepseek', updatedAt: 'ts', messages: [] };
    window.getConversation = async () => conv;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, observation_id: 'obs-1' })
    });
    const r = await lib.LocalApp_pushByConvId('c1');
    expect(r.pushed).toBe(true);
  });

  it('推送失败时返回 push_failed（静默，不抛错）', async () => {
    lib.setSettings({ enabled: true, pushOnSave: true });
    window.getConversation = async () => ({ id: 'c1', platform: 'deepseek', updatedAt: 'ts', messages: [] });
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    const r = await lib.LocalApp_pushByConvId('c1');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('push_failed');
  });
});

// =================================================================
// 状态管理：applySettings / resetPushedMap / getStatus
// =================================================================
describe('LocalApp_applySettings', () => {
  it('合并设置并更新模块状态（未传字段保留默认）', async () => {
    await lib.LocalApp_applySettings({ enabled: true, intervalMinutes: 5 });
    const s = lib.getSettings();
    expect(s.enabled).toBe(true);
    expect(s.intervalMinutes).toBe(5);
    // pushOnSave 未传，保留默认值 true
    expect(s.pushOnSave).toBe(true);
  });
});

describe('LocalApp_resetPushedMap', () => {
  it('清空 _pushedMap', async () => {
    lib.setPushedMap({ 'c1': { pushedAt: 'x' }, 'c2': { pushedAt: 'y' } });
    await lib.LocalApp_resetPushedMap();
    expect(Object.keys(lib.getPushedMap())).toHaveLength(0);
  });
});

describe('LocalApp_getStatus', () => {
  it('无推送记录时 pushedCount=0', async () => {
    lib.setSettings({ enabled: false });
    const status = await lib.LocalApp_getStatus();
    expect(status.pushedCount).toBe(0);
    expect(status.pushedItems).toEqual([]);
  });

  it('返回当前设置 + 已推送统计（通过成功推送一次填充 storage）', async () => {
    lib.setSettings({
      enabled: true,
      autoPush: true,
      pushOnSave: false,
      intervalMinutes: 5,
      baseUrl: 'http://x:8788'
    });
    // LocalApp_getStatus 会调 loadPushedMap 从 storage 读，
    // 需要先通过成功推送一次（savePushedMap 写 storage）来填充数据
    const conv = {
      id: 'c1',
      platform: 'deepseek',
      updatedAt: '2025-01-01T00:00:00Z',
      title: 'T',
      messages: []
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ received: true, observation_id: 'obs-1', deduplicated: false })
    });
    await lib.LocalApp_pushConversation(conv);

    const status = await lib.LocalApp_getStatus();
    expect(status.enabled).toBe(true);
    expect(status.autoPush).toBe(true);
    expect(status.pushOnSave).toBe(false);
    expect(status.intervalMinutes).toBe(5);
    expect(status.baseUrl).toBe('http://x:8788');
    expect(status.pushedCount).toBe(1);
    expect(status.pushedItems[0].convId).toBe('c1');
    expect(status.pushedItems[0].observationId).toBe('obs-1');
  });
});

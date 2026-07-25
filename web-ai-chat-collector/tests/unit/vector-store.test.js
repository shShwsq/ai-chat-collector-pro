// tests/unit/vector-store.test.js
// lib/vector-store.js 纯函数测试：
// _trimTrailingSlash / _normalizeSupabaseUrl / _strToQdrantUUID
// _chromaDistanceToScore / _chromaGetSpace / parsePostgrestResponse

import { describe, it, expect, beforeAll } from 'vitest';
import { loadVectorStore } from '../helpers/load-source.js';

let VectorStore, parsePostgrestResponse;

beforeAll(() => {
  const lib = loadVectorStore();
  VectorStore = lib.VectorStore;
  parsePostgrestResponse = lib.parsePostgrestResponse;
});

// =================================================================
// _trimTrailingSlash：剥掉 URL 末尾所有斜杠
// =================================================================
describe('_trimTrailingSlash', () => {
  it('单斜杠末尾被剥掉', () => {
    expect(VectorStore._trimTrailingSlash('http://localhost:8000/')).toBe('http://localhost:8000');
  });

  it('多斜杠末尾全部被剥掉', () => {
    expect(VectorStore._trimTrailingSlash('http://localhost:8000///')).toBe('http://localhost:8000');
  });

  it('无末尾斜杠时原样返回', () => {
    expect(VectorStore._trimTrailingSlash('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('路径中含斜杠但末尾无斜杠时只剥末尾', () => {
    expect(VectorStore._trimTrailingSlash('http://localhost:8000/api/v1')).toBe('http://localhost:8000/api/v1');
  });

  it('路径中含斜杠且末尾有斜杠时只剥末尾', () => {
    expect(VectorStore._trimTrailingSlash('http://localhost:8000/api/v1/')).toBe('http://localhost:8000/api/v1');
  });

  it('空字符串返回空字符串', () => {
    expect(VectorStore._trimTrailingSlash('')).toBe('');
  });

  it('非字符串被 String() 转换后再处理', () => {
    // 数字 123 转字符串 '123'，无斜杠，原样返回 '123'
    expect(VectorStore._trimTrailingSlash(123)).toBe('123');
  });
});

// =================================================================
// _normalizeSupabaseUrl：剥末尾斜杠 + 去 /rest/v1 后缀
// =================================================================
describe('_normalizeSupabaseUrl', () => {
  it('带 /rest/v1 后缀时被剥掉', () => {
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co');
  });

  it('不带 /rest/v1 后缀时原样返回', () => {
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co')).toBe('https://abc.supabase.co');
  });

  it('带末尾斜杠时先剥斜杠再去 /rest/v1', () => {
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co/rest/v1/')).toBe('https://abc.supabase.co');
  });

  it('大小写不敏感匹配 /rest/v1', () => {
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co/REST/V1')).toBe('https://abc.supabase.co');
  });

  it('重复 /rest/v1 后缀只剥一次（正则末尾匹配）', () => {
    // 正则 /\/rest\/v1$/i 只匹配末尾一次，剥掉一次后中间的 /rest/v1 保留
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co/rest/v1/rest/v1')).toBe('https://abc.supabase.co/rest/v1');
  });

  it('路径中含 /rest/v1 但不在末尾时不剥', () => {
    expect(VectorStore._normalizeSupabaseUrl('https://abc.supabase.co/rest/v1/table')).toBe('https://abc.supabase.co/rest/v1/table');
  });
});

// =================================================================
// _strToQdrantUUID：确定性字符串 → UUID 转换
// =================================================================
describe('_strToQdrantUUID', () => {
  it('同一字符串每次转换结果相同（确定性）', () => {
    const id = 'deepseek::msg::abc123::chunk::0';
    expect(VectorStore._strToQdrantUUID(id)).toBe(VectorStore._strToQdrantUUID(id));
  });

  it('生成的 UUID 格式合法（8-4-4-4-12 hex）', () => {
    const uuid = VectorStore._strToQdrantUUID('test-id');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('空字符串也能生成 UUID（不抛错）', () => {
    const uuid = VectorStore._strToQdrantUUID('');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('不同字符串生成不同的 UUID', () => {
    const u1 = VectorStore._strToQdrantUUID('id-1');
    const u2 = VectorStore._strToQdrantUUID('id-2');
    expect(u1).not.toBe(u2);
  });

  it('常见 chunk ID 格式都能生成合法 UUID', () => {
    // 项目实际使用的 chunk ID 格式：${convId}::msg::${msgHash}::chunk::${chunkIdx}
    const ids = [
      'deepseek::msg::hash1::chunk::0',
      'deepseek::msg::hash1::chunk::1',
      'kimi::msg::abc::chunk::0',
      'qianwen::msg::xyz::chunk::99'
    ];
    for (const id of ids) {
      expect(VectorStore._strToQdrantUUID(id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('只有 chunkIdx 不同的 ID 生成不同 UUID', () => {
    const base = 'deepseek::msg::hash1::chunk::';
    const u0 = VectorStore._strToQdrantUUID(base + '0');
    const u1 = VectorStore._strToQdrantUUID(base + '1');
    const u2 = VectorStore._strToQdrantUUID(base + '2');
    expect(u0).not.toBe(u1);
    expect(u1).not.toBe(u2);
    expect(u0).not.toBe(u2);
  });
});

// =================================================================
// _chromaDistanceToScore：按 distance function 转换 distance → score
// =================================================================
describe('_chromaDistanceToScore', () => {
  it('space=l2：d=0 → score=1', () => {
    expect(VectorStore._chromaDistanceToScore('l2', 0)).toBe(1);
  });

  it('space=l2：d>0 时 score=1/(1+d)，单调递减', () => {
    expect(VectorStore._chromaDistanceToScore('l2', 1)).toBeCloseTo(0.5, 5);
    expect(VectorStore._chromaDistanceToScore('l2', 2)).toBeCloseTo(1 / 3, 5);
    expect(VectorStore._chromaDistanceToScore('l2', 9)).toBeCloseTo(0.1, 5);
  });

  it('space=l2：d<0 时返回 1（异常值兜底）', () => {
    expect(VectorStore._chromaDistanceToScore('l2', -1)).toBe(1);
  });

  it('space=cosine：d=0 → score=1（完全相似）', () => {
    expect(VectorStore._chromaDistanceToScore('cosine', 0)).toBe(1);
  });

  it('space=cosine：d=1 → score=0（正交）', () => {
    expect(VectorStore._chromaDistanceToScore('cosine', 1)).toBe(0);
  });

  it('space=cosine：d=2 → score=-1（完全相反）', () => {
    expect(VectorStore._chromaDistanceToScore('cosine', 2)).toBe(-1);
  });

  it('space=ip：score=-d（负内积还原）', () => {
    // d=0 时 -0 === 0（===），但 Object.is(-0, +0) === false
    // 用 toBeCloseTo 避免 -0/+0 区分
    expect(VectorStore._chromaDistanceToScore('ip', 0)).toBeCloseTo(0, 10);
    expect(VectorStore._chromaDistanceToScore('ip', -5)).toBe(5);
    expect(VectorStore._chromaDistanceToScore('ip', 3)).toBe(-3);
  });

  it('space 未知时按 l2 处理', () => {
    expect(VectorStore._chromaDistanceToScore('unknown', 0)).toBe(1);
    expect(VectorStore._chromaDistanceToScore('unknown', 1)).toBeCloseTo(0.5, 5);
  });
});

// =================================================================
// _chromaGetSpace：从 collection 详情中提取 hnsw:space
// =================================================================
describe('_chromaGetSpace', () => {
  it('从 detail.metadata["hnsw:space"] 提取', () => {
    const detail = { metadata: { 'hnsw:space': 'cosine' } };
    expect(VectorStore._chromaGetSpace(detail)).toBe('cosine');
  });

  it('从 detail.configuration.fields["hnsw:space"] 提取', () => {
    const detail = { configuration: { fields: { 'hnsw:space': 'ip' } } };
    expect(VectorStore._chromaGetSpace(detail)).toBe('ip');
  });

  it('从 detail.configuration.hnsw.space 提取', () => {
    const detail = { configuration: { hnsw: { space: 'cosine' } } };
    expect(VectorStore._chromaGetSpace(detail)).toBe('cosine');
  });

  it('metadata 优先级高于 configuration', () => {
    const detail = {
      metadata: { 'hnsw:space': 'cosine' },
      configuration: { fields: { 'hnsw:space': 'l2' }, hnsw: { space: 'l2' } }
    };
    expect(VectorStore._chromaGetSpace(detail)).toBe('cosine');
  });

  it('所有字段都缺失时回退到 l2', () => {
    expect(VectorStore._chromaGetSpace({})).toBe('l2');
    expect(VectorStore._chromaGetSpace({ metadata: {} })).toBe('l2');
    expect(VectorStore._chromaGetSpace({ configuration: {} })).toBe('l2');
  });

  it('metadata 中 hnsw:space 为空字符串时回退到 l2', () => {
    // 空字符串 falsy，会继续向后查找
    const detail = { metadata: { 'hnsw:space': '' } };
    expect(VectorStore._chromaGetSpace(detail)).toBe('l2');
  });
});

// =================================================================
// parsePostgrestResponse：PostgREST 响应解析
// =================================================================
describe('parsePostgrestResponse', () => {
  it('204 空响应返回 success:true', async () => {
    const resp = new Response(null, { status: 204 });
    const result = await parsePostgrestResponse(resp);
    expect(result).toEqual({ success: true, status: 204 });
  });

  it('201 + JSON 响应解析为 data', async () => {
    const body = JSON.stringify({ id: 'abc', content: 'hello' });
    const resp = new Response(body, {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(true);
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ id: 'abc', content: 'hello' });
  });

  it('4xx + JSON 错误体：提取 message 字段', async () => {
    const body = JSON.stringify({ code: '23505', message: 'duplicate key' });
    const resp = new Response(body, {
      status: 409,
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toBe('duplicate key');
  });

  it('4xx + JSON 错误体无 message 字段时用 code', async () => {
    const body = JSON.stringify({ code: '42P01', detail: 'table not found' });
    const resp = new Response(body, {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(false);
    expect(result.error).toBe('42P01');
  });

  it('4xx + 非 JSON 文本：用原始文本作 error', async () => {
    const resp = new Response('Internal Server Error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Internal Server Error');
  });

  it('4xx + 空响应：用 HTTP 状态码作 error', async () => {
    const resp = new Response(null, { status: 502 });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe('HTTP 502');
  });

  it('200 + 非 JSON 文本：用 raw 字段保留原始文本', async () => {
    const resp = new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
    const result = await parsePostgrestResponse(resp);
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.raw).toBe('OK');
  });
});

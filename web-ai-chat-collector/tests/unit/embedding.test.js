// tests/unit/embedding.test.js
// lib/embedding.js 纯函数测试：chunkText / filterContentForEmbedding / cosineSimilarity

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadEmbedding } from '../helpers/load-source.js';

let EmbeddingService, cosineSimilarity;

beforeAll(() => {
  const lib = loadEmbedding();
  EmbeddingService = lib.EmbeddingService;
  cosineSimilarity = lib.cosineSimilarity;
});

// EmbeddingService 是单例对象，跨测试用例状态会保留，每个 it 前重置
beforeEach(() => {
  EmbeddingService._chunkSize = 500;
  EmbeddingService._chunkOverlap = 50;
  EmbeddingService._includeThinking = false;
  EmbeddingService._includeSearch = false;
});

// think 块标签用拼接构造
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';

// =================================================================
// chunkText：按 chunkSize/chunkOverlap 切片
// =================================================================
describe('chunkText', () => {
  it('空文本返回空数组', () => {
    expect(EmbeddingService.chunkText('')).toEqual([]);
    expect(EmbeddingService.chunkText(null)).toEqual([]);
  });

  it('短于 chunkSize 的文本返回单元素数组', () => {
    EmbeddingService._chunkSize = 100;
    expect(EmbeddingService.chunkText('短文本')).toEqual(['短文本']);
  });

  it('正好等于 chunkSize 的文本返回单元素数组', () => {
    EmbeddingService._chunkSize = 5;
    const text = '12345';
    expect(EmbeddingService.chunkText(text)).toEqual(['12345']);
  });

  it('长文本被切成多段', () => {
    EmbeddingService._chunkSize = 5;
    EmbeddingService._chunkOverlap = 0;
    const text = '123456789'; // 长度 9
    const chunks = EmbeddingService.chunkText(text);
    // step = 5 - 0 = 5
    // i=0: [0,5)='12345'; i=5: [5,10)='6789' (slice 不越界)
    expect(chunks).toEqual(['12345', '6789']);
  });

  it('overlap 时切片有重叠', () => {
    EmbeddingService._chunkSize = 5;
    EmbeddingService._chunkOverlap = 2; // step = 3
    const text = '123456789'; // 长度 9
    const chunks = EmbeddingService.chunkText(text);
    // i=0: [0,5)='12345'
    // i=3: [3,8)='45678'
    // i=6: [6,11)='789'
    expect(chunks).toEqual(['12345', '45678', '789']);
  });

  it('overlap 等于 chunkSize 时被截断为 size-1（避免无限循环）', () => {
    EmbeddingService._chunkSize = 5;
    EmbeddingService._chunkOverlap = 10; // 大于 size，被截断为 size-1=4，step=1
    const text = '1234567'; // 长度 7
    const chunks = EmbeddingService.chunkText(text);
    // step = 5 - 4 = 1
    // i=0: [0,5)='12345'
    // i=1: [1,6)='23456'
    // i=2: [2,7)='34567'
    expect(chunks).toEqual(['12345', '23456', '34567']);
  });

  it('chunkSize 为 1 时每个字符是一片', () => {
    EmbeddingService._chunkSize = 1;
    EmbeddingService._chunkOverlap = 0;
    expect(EmbeddingService.chunkText('abc')).toEqual(['a', 'b', 'c']);
  });

  it('最后一片短于 chunkSize 仍正确返回', () => {
    EmbeddingService._chunkSize = 10;
    EmbeddingService._chunkOverlap = 0;
    const text = '1234567890ABC'; // 长度 13
    const chunks = EmbeddingService.chunkText(text);
    expect(chunks).toEqual(['1234567890', 'ABC']);
  });
});

// =================================================================
// filterContentForEmbedding：根据设置剥离 think / search_result 块
// =================================================================
describe('filterContentForEmbedding', () => {
  it('空输入原样返回', () => {
    expect(EmbeddingService.filterContentForEmbedding('')).toBe('');
    expect(EmbeddingService.filterContentForEmbedding(null)).toBe(null);
  });

  it('无 think/search 块时原样返回（trim）', () => {
    EmbeddingService._includeThinking = false;
    EmbeddingService._includeSearch = false;
    expect(EmbeddingService.filterContentForEmbedding('  Hello  ')).toBe('Hello');
  });

  it('_includeThinking=false 剥离 think 块', () => {
    EmbeddingService._includeThinking = false;
    const input = THINK_OPEN + '思考过程' + THINK_CLOSE + '正式回答';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe('正式回答');
  });

  it('_includeThinking=true 保留 think 块', () => {
    EmbeddingService._includeThinking = true;
    const input = THINK_OPEN + '思考过程' + THINK_CLOSE + '正式回答';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe(input);
  });

  it('_includeSearch=false 剥离 search_result 块', () => {
    EmbeddingService._includeSearch = false;
    const input = '回答<search_result>来源</search_result>后续';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe('回答后续');
  });

  it('_includeSearch=true 保留 search_result 块', () => {
    EmbeddingService._includeSearch = true;
    const input = '回答<search_result>来源</search_result>后续';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe(input);
  });

  it('同时剥离 think 和 search_result（默认行为）', () => {
    EmbeddingService._includeThinking = false;
    EmbeddingService._includeSearch = false;
    const input = THINK_OPEN + '思考' + THINK_CLOSE +
                  '回答<search_result>来源</search_result>后续';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe('回答后续');
  });

  it('同时保留 think 和 search_result', () => {
    EmbeddingService._includeThinking = true;
    EmbeddingService._includeSearch = true;
    const input = THINK_OPEN + '思考' + THINK_CLOSE +
                  '回答<search_result>来源</search_result>后续';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe(input);
  });

  it('多个 think 块都被剥离', () => {
    EmbeddingService._includeThinking = false;
    const input = THINK_OPEN + '思考1' + THINK_CLOSE +
                  '回答1' +
                  THINK_OPEN + '思考2' + THINK_CLOSE +
                  '回答2';
    expect(EmbeddingService.filterContentForEmbedding(input)).toBe('回答1回答2');
  });
});

// =================================================================
// cosineSimilarity：余弦相似度
// =================================================================
describe('cosineSimilarity', () => {
  it('完全相同的向量返回 1', () => {
    const a = [1, 2, 3];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10);
  });

  it('正交向量返回 0', () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('维度不等的向量返回 0', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('空向量或 null 返回 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], null)).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  it('零向量返回 0（避免除零）', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('一般相似度计算正确', () => {
    // a=[1,0], b=[1,1]: cos = 1 / (1 * sqrt(2)) = 1/sqrt(2) ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it('方向相反的向量返回 -1', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });

  it('负值相似度计算正确', () => {
    // a=[1,1], b=[1,-1]: cos = 0 / (sqrt(2) * sqrt(2)) = 0
    const a = [1, 1];
    const b = [1, -1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('高维向量相似度稳定', () => {
    // 1024 维（与项目实际 embedding 维度一致）
    const a = Array.from({ length: 1024 }, (_, i) => i * 0.01);
    const b = Array.from({ length: 1024 }, (_, i) => i * 0.01 + 0.001);
    // 微小扰动，相似度应接近 1
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.999);
  });
});

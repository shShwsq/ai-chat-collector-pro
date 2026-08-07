import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { deepseekImporter } from './deepseek'
import { detectAndParse, ImportParseError } from './index'

/** 真实样例文件路径（references/deepseek/conversations.json）。
 * 从 frontend/src/lib/importers/ 回退 5 层到项目根。 */
const SAMPLE_PATH = resolve(
  __dirname,
  '../../../../../references/deepseek/conversations.json',
)

/** 构造一个最小但结构完整的 DeepSeek 会话（用户问→思考→助手答）。 */
function makeConv(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    title: '测试会话',
    inserted_at: '2025-02-20T17:11:10.895000+08:00',
    updated_at: '2025-02-20T17:17:26.247000+08:00',
    mapping: {
      root: { id: 'root', parent: null, children: ['1'], message: null },
      '1': {
        id: '1',
        parent: 'root',
        children: ['2'],
        message: {
          model: 'deepseek-reasoner',
          inserted_at: '2025-02-20T17:11:11+08:00',
          fragments: [{ type: 'REQUEST', content: '什么是知识图谱？' }],
        },
      },
      '2': {
        id: '2',
        parent: '1',
        children: ['3'],
        message: {
          model: 'deepseek-reasoner',
          inserted_at: '2025-02-20T17:11:15+08:00',
          fragments: [{ type: 'THINK', content: '我需要解释知识图谱…' }],
        },
      },
      '3': {
        id: '3',
        parent: '2',
        children: [],
        message: {
          model: 'deepseek-reasoner',
          inserted_at: '2025-02-20T17:12:00+08:00',
          fragments: [{ type: 'RESPONSE', content: '知识图谱是用图结构组织知识的方式。' }],
        },
      },
    },
    ...overrides,
  }
}

describe('deepseekImporter.detect', () => {
  it('识别标准 DeepSeek 导出数组', () => {
    expect(deepseekImporter.detect([makeConv()])).toBe(true)
  })

  it('拒绝空数组与非 DeepSeek 结构', () => {
    expect(deepseekImporter.detect([])).toBe(false)
    expect(deepseekImporter.detect({ foo: 'bar' })).toBe(false)
    expect(deepseekImporter.detect([{ nope: 1 }])).toBe(false)
  })
})

describe('deepseekImporter.parse', () => {
  it('把 mapping 树转换为顺序正确的 Markdown，并统计消息数', () => {
    const preview = deepseekImporter.parse([makeConv()])
    expect(preview.platform).toBe('deepseek')
    expect(preview.conversations).toHaveLength(1)

    const conv = preview.conversations[0]
    expect(conv.id).toBe('conv-1')
    expect(conv.title).toBe('测试会话')
    expect(conv.model).toBe('deepseek-reasoner')
    // REQUEST + RESPONSE = 2 条消息（THINK 不计入消息数）
    expect(conv.messageCount).toBe(2)

    // 顺序：用户 → 思考(折叠) → 助手
    expect(conv.markdown).toContain('## 用户')
    expect(conv.markdown).toContain('什么是知识图谱？')
    expect(conv.markdown).toContain('## 助手')
    expect(conv.markdown).toContain('知识图谱是用图结构组织知识的方式。')
    expect(conv.markdown).toContain('<details><summary>思考过程</summary>')
  })

  it('标题为空时用首条用户消息派生兜底标题', () => {
    const preview = deepseekImporter.parse([
      makeConv({ id: 'conv-2', title: '' }),
    ])
    expect(preview.conversations[0].title).toBe('什么是知识图谱？')
  })

  it('跨会话统计时间范围与总消息数', () => {
    const preview = deepseekImporter.parse([
      makeConv({
        id: 'a',
        inserted_at: '2025-01-01T00:00:00+08:00',
        updated_at: '2025-01-01T01:00:00+08:00',
      }),
      makeConv({
        id: 'b',
        inserted_at: '2025-03-01T00:00:00+08:00',
        updated_at: '2025-03-01T02:00:00+08:00',
      }),
    ])
    expect(preview.conversations).toHaveLength(2)
    expect(preview.totalMessages).toBe(4)
    expect(preview.timeRange).toEqual({
      start: '2025-01-01T00:00:00+08:00',
      end: '2025-03-01T02:00:00+08:00',
    })
    // 按发生时间升序
    expect(preview.conversations[0].id).toBe('a')
    expect(preview.conversations[1].id).toBe('b')
  })

  it('跳过工具产物片段（FILE/SEARCH/TOOL_*）', () => {
    const conv = makeConv({
      mapping: {
        root: { id: 'root', parent: null, children: ['1'], message: null },
        '1': {
          id: '1',
          parent: 'root',
          children: [],
          message: {
            model: 'deepseek-chat',
            inserted_at: '2025-02-20T17:11:11+08:00',
            fragments: [
              { type: 'REQUEST', content: '帮我搜点资料' },
              { type: 'SEARCH', content: 'some tool artifact' },
              { type: 'TOOL_OPEN', content: 'another artifact' },
              { type: 'RESPONSE', content: '这是搜索结果汇总。' },
            ],
          },
        },
      },
    })
    const preview = deepseekImporter.parse([conv])
    const md = preview.conversations[0].markdown
    expect(md).not.toContain('some tool artifact')
    expect(md).not.toContain('another artifact')
    expect(preview.conversations[0].messageCount).toBe(2)
  })
})

describe('detectAndParse', () => {
  it('从 JSON 文本自动识别并解析 DeepSeek 文件', () => {
    const text = JSON.stringify([makeConv()])
    const preview = detectAndParse(text)
    expect(preview.platform).toBe('deepseek')
    expect(preview.conversations).toHaveLength(1)
  })

  it('非法 JSON 抛 ImportParseError', () => {
    expect(() => detectAndParse('{not json')).toThrow(ImportParseError)
  })

  it('无法识别的格式抛 ImportParseError', () => {
    expect(() => detectAndParse(JSON.stringify({ foo: 'bar' }))).toThrow(
      ImportParseError,
    )
  })

  it('DeepSeek 文件但无有效会话抛 ImportParseError', () => {
    // 满足 detect（有 mapping + inserted_at）但 mapping 内无 message 节点
    const empty = [
      {
        id: 'x',
        title: '空',
        inserted_at: '2025-01-01T00:00:00+08:00',
        updated_at: '2025-01-01T00:00:00+08:00',
        mapping: { root: { id: 'root', parent: null, children: [], message: null } },
      },
    ]
    expect(() => detectAndParse(JSON.stringify(empty))).toThrow(ImportParseError)
  })
})

describe('真实样例文件 references/deepseek/conversations.json', () => {
  // 仅在样例文件存在时运行（CI 可能未携带 references 目录）
  const runIt = existsSync(SAMPLE_PATH) ? it : it.skip

  runIt('能完整解析 3000+ 条会话且统计合理', () => {
    const text = readFileSync(SAMPLE_PATH, 'utf-8')
    const preview = detectAndParse(text)

    expect(preview.platform).toBe('deepseek')
    // 样例包含 3036 条会话
    expect(preview.conversations.length).toBeGreaterThan(3000)
    // 每条会话都有非空 markdown 与正向消息数
    const first = preview.conversations[0]
    expect(first.markdown.length).toBeGreaterThan(0)
    expect(first.messageCount).toBeGreaterThan(0)
    expect(first.id).toBeTruthy()
    // 总消息数为正
    expect(preview.totalMessages).toBeGreaterThan(0)
    // 时间范围非空
    expect(preview.timeRange).not.toBeNull()
  })
})

// tests/unit/db.test.js
// lib/db.js 纯函数测试：_stripAugmentBlocks / tokenize / highlightSearchResult
// 这些函数是 IIFE 外的函数声明，加载后挂到 window 全局。

import { describe, it, expect, beforeAll } from 'vitest';
import { loadDb } from '../helpers/load-source.js';

let _stripAugmentBlocks, _reorderByDomOrder, tokenize, highlightSearchResult;

beforeAll(() => {
  const lib = loadDb();
  _stripAugmentBlocks = lib._stripAugmentBlocks;
  _reorderByDomOrder = lib._reorderByDomOrder;
  tokenize = lib.tokenize;
  highlightSearchResult = lib.highlightSearchResult;
});

// think 块的开闭标签用拼接构造，避免在源码中直接出现被工具误处理
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';

// =================================================================
// _stripAugmentBlocks：剥离思考块和搜索来源块，返回纯回答部分
// =================================================================
describe('_stripAugmentBlocks', () => {
  it('空输入返回空串', () => {
    expect(_stripAugmentBlocks('')).toBe('');
    expect(_stripAugmentBlocks(null)).toBe('');
    expect(_stripAugmentBlocks(undefined)).toBe('');
  });

  it('纯文本（无任何块）原样返回（trim 后）', () => {
    expect(_stripAugmentBlocks('Hello world')).toBe('Hello world');
    expect(_stripAugmentBlocks('  纯文本  ')).toBe('纯文本');
  });

  it('剥离 think 块（标准格式）', () => {
    const input = THINK_OPEN + '\n这是思考\n' + THINK_CLOSE + '\n\n这是回答';
    expect(_stripAugmentBlocks(input)).toBe('这是回答');
  });

  it('剥离 search_result 块', () => {
    const input = '回答\n<search_result>\n来源内容\n</search_result>\n更多回答';
    expect(_stripAugmentBlocks(input)).toBe('回答\n更多回答');
  });

  it('剥离千问 DOM 模式的【搜索】和【来源】标记', () => {
    const input = '【搜索】关键词1、关键词2\n【来源】来源1\n实际回答';
    expect(_stripAugmentBlocks(input)).toBe('实际回答');
  });

  it('剥离所有类型的块（混合场景）', () => {
    const input = THINK_OPEN + '\n思考过程\n' + THINK_CLOSE +
                  '\n【搜索】查询词\n【来源】来源\n' +
                  '<search_result>\n搜索结果\n</search_result>\n实际回答';
    expect(_stripAugmentBlocks(input)).toBe('实际回答');
  });

  it('保留多个 think 块之间的回答', () => {
    const input = THINK_OPEN + '\n思考1\n' + THINK_CLOSE +
                  '\n回答1\n' +
                  THINK_OPEN + '\n思考2\n' + THINK_CLOSE +
                  '\n回答2';
    expect(_stripAugmentBlocks(input)).toBe('回答1\n回答2');
  });

  it('只有 think 块无回答时返回空串', () => {
    const input = THINK_OPEN + '\n只有思考\n' + THINK_CLOSE;
    expect(_stripAugmentBlocks(input)).toBe('');
  });

  it('think 块未闭合时不被剥离（正则非贪婪匹配）', () => {
    // 未闭合的开标签不在剥离范围内，原样返回
    const input = THINK_OPEN + '\n思考未闭合\n这是回答';
    expect(_stripAugmentBlocks(input)).toBe(THINK_OPEN + '\n思考未闭合\n这是回答');
  });
});

// =================================================================
// tokenize：中文 bigram + 单字符分词
// =================================================================
describe('tokenize', () => {
  it('空输入返回空数组', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('纯英文：按空白分词，小写归一化', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('纯中文：生成 bigram + 整词', () => {
    const tokens = tokenize('你好世界');
    // 整词
    expect(tokens).toContain('你好世界');
    // bigram
    expect(tokens).toContain('你好');
    expect(tokens).toContain('好世');
    expect(tokens).toContain('世界');
  });

  it('中英混合：英文词独立，中文词生成 bigram', () => {
    const tokens = tokenize('Hello 世界');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('世界');
    // 'Hello 世界' 不在一个 word 内（被空白分隔），不产生跨语言的 bigram
    expect(tokens).not.toContain('o世');
  });

  it('中英连续（无空白）：会产生跨语言 bigram', () => {
    const tokens = tokenize('abc你好');
    // 整词
    expect(tokens).toContain('abc你好');
    // 跨语言 bigram：'c你'（'c' 不是中文但 '你' 是中文，触发 bigram）
    expect(tokens).toContain('c你');
    // 纯中文 bigram
    expect(tokens).toContain('你好');
  });

  it('过滤标点和特殊字符（只保留 \\w 和中文）', () => {
    // 'a.b' 被切为 ['a', 'b']（点号被替换为空白）
    const tokens = tokenize('a.b');
    expect(tokens).toContain('a');
    expect(tokens).toContain('b');
    expect(tokens).not.toContain('a.b');
  });

  it('去重：相同 token 只出现一次', () => {
    const tokens = tokenize('你好 你好 你好');
    const count = tokens.filter(t => t === '你好').length;
    expect(count).toBe(1);
  });

  it('数字被保留', () => {
    const tokens = tokenize('test123 hello');
    expect(tokens).toContain('test123');
    expect(tokens).toContain('hello');
  });

  it('空格分隔的多词都入 token', () => {
    const tokens = tokenize('foo bar baz');
    expect(tokens).toContain('foo');
    expect(tokens).toContain('bar');
    expect(tokens).toContain('baz');
  });
});

// =================================================================
// highlightSearchResult：在消息内容中标记匹配 token
// =================================================================
describe('highlightSearchResult', () => {
  it('空查询原样返回消息', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    expect(highlightSearchResult(messages, '')).toEqual(messages);
    expect(highlightSearchResult(messages, '   ')).toEqual(messages);
    expect(highlightSearchResult(messages, null)).toEqual(messages);
  });

  it('单 term 匹配被 <mark> 包裹', () => {
    const messages = [{ role: 'user', content: 'hello world' }];
    const result = highlightSearchResult(messages, 'hello');
    expect(result[0].highlighted).toBe('<mark>hello</mark> world');
  });

  it('多 term 全部高亮', () => {
    const messages = [{ role: 'user', content: 'foo bar baz' }];
    const result = highlightSearchResult(messages, 'foo bar');
    expect(result[0].highlighted).toBe('<mark>foo</mark> <mark>bar</mark> baz');
  });

  it('大小写不敏感匹配', () => {
    const messages = [{ role: 'user', content: 'Hello HELLO hello' }];
    const result = highlightSearchResult(messages, 'hello');
    expect(result[0].highlighted).toBe('<mark>Hello</mark> <mark>HELLO</mark> <mark>hello</mark>');
  });

  it('长 term 优先匹配（避免短 term 提前消费）', () => {
    // 'foobar' 比 'foo' 长，应先匹配，避免 'foo' 把 'foobar' 的前半截匹配掉
    const messages = [{ role: 'user', content: 'foobar foo' }];
    const result = highlightSearchResult(messages, 'foo foobar');
    expect(result[0].highlighted).toBe('<mark>foobar</mark> <mark>foo</mark>');
  });

  it('不修改原消息对象（返回新对象，含 highlighted 字段）', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = highlightSearchResult(messages, 'hello');
    expect(result[0]).not.toBe(messages[0]);
    expect(result[0].content).toBe('hello');
    expect(result[0].highlighted).toBe('<mark>hello</mark>');
  });

  it('中文 bigram 高亮', () => {
    const messages = [{ role: 'user', content: '你好世界' }];
    const result = highlightSearchResult(messages, '你好');
    expect(result[0].highlighted).toBe('<mark>你好</mark>世界');
  });

  it('content 为空时不抛错', () => {
    const messages = [{ role: 'user', content: '' }];
    const result = highlightSearchResult(messages, 'foo');
    expect(result[0].highlighted).toBe('');
  });

  it('多消息同时高亮', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world hello' }
    ];
    const result = highlightSearchResult(messages, 'hello');
    expect(result[0].highlighted).toBe('<mark>hello</mark>');
    expect(result[1].highlighted).toBe('world <mark>hello</mark>');
  });
});

// =================================================================
// _reorderByDomOrder：按 DOM 快照顺序重排消息（修复滚动加载顺序错乱）
// 场景：DOM 模式下 exporter-base.js 只把"未见过的消息"发给 db，db push 到末尾会
// 把向上滚动加载的旧消息错误地放到对话末尾。domOrder 是当前 DOM 完整快照的 hash 顺序。
// =================================================================
describe('_reorderByDomOrder', () => {
  // 构造消息对象：{ role, content, hash }
  const mkMsg = (hash, role = 'user') => ({ role, content: `msg-${hash}`, hash });

  // 取 hash 数组，便于断言顺序
  const hashes = (msgs) => msgs.map(m => m.hash);

  it('空 existing 返回空数组', () => {
    expect(_reorderByDomOrder([], ['a', 'b'])).toEqual([]);
  });

  it('domOrder 为空数组时保持原顺序', () => {
    const existing = [mkMsg('a'), mkMsg('b'), mkMsg('c')];
    expect(_reorderByDomOrder(existing, [])).toEqual(existing);
  });

  it('domOrder 非数组时保持原顺序', () => {
    const existing = [mkMsg('a'), mkMsg('b')];
    expect(_reorderByDomOrder(existing, null)).toEqual(existing);
    expect(_reorderByDomOrder(existing, undefined)).toEqual(existing);
    expect(_reorderByDomOrder(existing, 'abc')).toEqual(existing);
  });

  it('domOrder 与 existing 无交集时保持原顺序', () => {
    const existing = [mkMsg('a'), mkMsg('b')];
    // domOrder 里的 hash 都不在 existing 中（数据不一致）
    expect(_reorderByDomOrder(existing, ['x', 'y'])).toEqual(existing);
  });

  // 核心场景：向上滚动加载更早的旧消息
  // existing=[A,B,C]，新增 X（应在最前），DOM=[X,A,B]
  // 模拟 db 追加：push X 到末尾 → [A,B,C,X]，再重排
  it('向上滚动：旧消息 X 被错误 push 到末尾后，重排回最前', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];
    const newMsg = mkMsg('X');
    const domOrder = ['X', 'A', 'B'];  // 当前 DOM 快照顺序

    // 模拟 db.js 的 push 追加（错误顺序）
    const afterPush = [...existing, newMsg];
    // 重排
    const result = _reorderByDomOrder(afterPush, domOrder);
    expect(hashes(result)).toEqual(['X', 'A', 'B', 'C']);
  });

  // 向下滚动加载新消息
  // existing=[A,B,C]，新增 Y（应在最后），DOM=[B,C,Y]
  it('向下滚动：新消息 Y 追加到末尾，重排后保持正确顺序', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];
    const newMsg = mkMsg('Y');
    const domOrder = ['B', 'C', 'Y'];

    const afterPush = [...existing, newMsg];
    const result = _reorderByDomOrder(afterPush, domOrder);
    expect(hashes(result)).toEqual(['A', 'B', 'C', 'Y']);
  });

  // 中间滚动：existing 中有滚出视图的旧消息，DOM 只看到中间一段
  // existing=[A,B,C,D,E]，新增 X 在中间，DOM=[B,X,C,D]
  it('中间滚动：DOM 只看到中段，orphan 按原相对位置分前后', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C'), mkMsg('D'), mkMsg('E')];
    const newMsg = mkMsg('X');
    const domOrder = ['B', 'X', 'C', 'D'];

    const afterPush = [...existing, newMsg];
    const result = _reorderByDomOrder(afterPush, domOrder);
    // A 在锚点 B 之前 → beforeOrphan；E 在锚点之后 → afterOrphan
    expect(hashes(result)).toEqual(['A', 'B', 'X', 'C', 'D', 'E']);
  });

  // domOrder 包含 existing 全部消息：完全按 domOrder 排列
  it('domOrder 覆盖全部消息时，完全按 domOrder 顺序排列', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];
    const domOrder = ['C', 'A', 'B'];  // 完全不同的顺序
    const result = _reorderByDomOrder(existing, domOrder);
    expect(hashes(result)).toEqual(['C', 'A', 'B']);
  });

  // domOrder 含重复 hash：去重，不重复输出
  it('domOrder 含重复 hash 时去重', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];
    const domOrder = ['A', 'A', 'B', 'B', 'C'];
    const result = _reorderByDomOrder(existing, domOrder);
    expect(hashes(result)).toEqual(['A', 'B', 'C']);
  });

  // 多次滚动场景：先向下滚加载 Y，再向上滚加载 X
  // 第一次：existing=[A,B,C] + Y, domOrder=[B,C,Y] → [A,B,C,Y]
  // 第二次：existing=[A,B,C,Y] + X, domOrder=[X,A,B] → [X,A,B,C,Y]
  it('连续滚动：先向下加载 Y 再向上加载 X，顺序始终正确', () => {
    let existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];

    // 第一次：向下滚，加载 Y
    const newY = mkMsg('Y');
    existing = _reorderByDomOrder([...existing, newY], ['B', 'C', 'Y']);
    expect(hashes(existing)).toEqual(['A', 'B', 'C', 'Y']);

    // 第二次：向上滚，加载 X
    const newX = mkMsg('X');
    existing = _reorderByDomOrder([...existing, newX], ['X', 'A', 'B']);
    expect(hashes(existing)).toEqual(['X', 'A', 'B', 'C', 'Y']);
  });

  // 虚拟列表场景：domOrder 只含部分消息，existing 有滚出视图的旧消息在两端
  // existing=[A,B,C,D,E]，DOM=[C,D]（只看到中间），无新消息
  // 但此时 domOrder=[C,D]，重排后应保持 [A,B,C,D,E]（A,B 在锚点前；E 在锚点后）
  it('虚拟列表：domOrder 只含中段，两端 orphan 保持原位', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C'), mkMsg('D'), mkMsg('E')];
    const domOrder = ['C', 'D'];
    const result = _reorderByDomOrder(existing, domOrder);
    expect(hashes(result)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  // 不修改原数组（返回新数组）
  it('不修改原数组', () => {
    const existing = [mkMsg('A'), mkMsg('B'), mkMsg('C')];
    const domOrder = ['C', 'A', 'B'];
    const originalHashes = hashes(existing);
    _reorderByDomOrder(existing, domOrder);
    expect(hashes(existing)).toEqual(originalHashes);
  });
});

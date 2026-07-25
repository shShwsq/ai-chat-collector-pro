// tests/dom/katex-html-to-latex.test.js
// KaTeX HTML → LaTeX 反向解析测试
//
// Kimi 等平台移除了 KaTeX 的 <annotation> 可访问性层（原始 LaTeX 源码），
// 只保留 .katex-html 视觉渲染层。katex-html-to-latex.js 递归解析这个视觉层重建 LaTeX。
//
// 这些测试用例是"DOM 改了立刻发现"的第一道防线：
// KaTeX 升级、Kimi 改用 MathJax、或 katex-html-to-latex.js 重构后，任何公式解析偏差都会被立即捕获。
//
// fixtures 直接写在每个 it() 块内，便于阅读上下文。
// HTML 结构模拟 KaTeX v0.16 真实输出，但只保留解析器依赖的关键类名/属性。

import { describe, it, expect, beforeAll } from 'vitest';
import { loadHtmlToMarkdown, setBody } from '../helpers/load-source.js';

let KatexHtmlToLatex;

beforeAll(() => {
  const lib = loadHtmlToMarkdown();
  KatexHtmlToLatex = lib.KatexHtmlToLatex;
});

// 辅助：从 HTML 字符串构造 .katex-html 元素，调用 convert()
function convertHtml(htmlString) {
  document.body.innerHTML = htmlString;
  const el = document.body.querySelector('.katex-html');
  if (!el) throw new Error('fixture 中未找到 .katex-html');
  return KatexHtmlToLatex.convert(el);
}

// 构造 KaTeX v0.16 风格的 .katex-html 外壳
// 内部 base 内容由调用方提供
function katexHtml(innerBase) {
  return `<span class="katex-html" aria-hidden="true">
    <span class="base">${innerBase}</span>
  </span>`;
}

// 普通字符 .mord
const mord = (text) => `<span class="mord">${text}</span>`;
const mordMathnormal = (text) => `<span class="mord mathnormal">${text}</span>`;

// 操作符 .mop（KaTeX 输出 unicode 符号，如 ∫）
const mop = (symbol) => `<span class="mop">${symbol}</span>`;

// 关系符 .mrel（=）
const mrel = (text) => `<span class="mrel">${text}</span>`;
// 二元运算符 .mbin（+）
const mbin = (text) => `<span class="mbin">${text}</span>`;

// 上标 vlist 项：top 值 < -1.8 视为上标
// KaTeX 实际值：top:-3.063em（上标） / top:-0.8em（下标，但下标实际可能用正值或更接近 0）
function supEntry(content, top = -3.063) {
  return `<span style="top:${top}em;margin-right:0.05em;">
    <span class="pstrut" style="height:2.7em;"></span>
    <span class="mord mtight">${content}</span>
  </span>`;
}
function subEntry(content, top = -0.5) {
  return `<span style="top:${top}em;">
    <span class="pstrut" style="height:2.7em;"></span>
    <span class="mord mtight">${content}</span>
  </span>`;
}

// 上下标容器 .msupsub
function msupsub(...entries) {
  return `<span class="msupsub">
    <span class="vlist-t vlist-r">
      <span class="vlist">${entries.join('')}
      </span>
    </span>
  </span>`;
}

// 分数 .mfrac：KaTeX 0.16+ 实际用 .mord > .mopen.nulldelimiter + .mfrac + .mclose.nulldelimiter 包裹
// 分子 top 最负（在上方），分母 top 较大（在下方），中间有 frac-line（空文本）
function mfrac(numerator, denominator) {
  return `<span class="mord">
    <span class="mopen nulldelimiter"></span>
    <span class="mfrac">
      <span class="vlist-t vlist-r">
        <span class="vlist">
          <span style="top:-2.314em;"><span class="pstrut"></span><span class="mord mtight">${denominator}</span></span>
          <span style="top:-3.23em;"><span class="pstrut" style="height:3em;"></span><span class="frac-line"></span></span>
          <span style="top:-3.677em;"><span class="pstrut" style="height:3em;"></span><span class="mord mtight">${numerator}</span></span>
        </span>
      </span>
    </span>
    <span class="mclose nulldelimiter"></span>
  </span>`;
}

// 根号 .mord.sqrt：KaTeX 0.16+ 实际输出 class="mord sqrt"
// 被开方数在 .svg-align > .mord（带 padding-left）中，surd 在 .hide-tail > svg 中（无文本）
function msqrt(content) {
  return `<span class="mord sqrt">
    <span class="vlist-t vlist-t2">
      <span class="vlist-r">
        <span class="vlist">
          <span class="svg-align" style="top:-3em;">
            <span class="pstrut" style="height:3em;"></span>
            <span class="mord" style="padding-left:0.833em;">${content}</span>
          </span>
          <span style="top:-2.8092em;">
            <span class="pstrut" style="height:3em;"></span>
            <span class="hide-tail"><svg></svg></span>
          </span>
        </span>
        <span class="vlist-s">\u200b</span>
      </span>
      <span class="vlist-r"><span class="vlist"><span></span></span></span>
    </span>
  </span>`;
}

// n 次根号 .mord.sqrt（含 .root 子元素表示根指数）
// KaTeX 0.16+ 将根指数放在 .root > .vlist-t > ... > .sizing.mtight > .mord.mtight 中
function mrootN(rootIndex, content) {
  return `<span class="mord sqrt">
    <span class="root">
      <span class="vlist-t"><span class="vlist-r"><span class="vlist">
        <span style="top:-2.895em;">
          <span class="pstrut" style="height:2.5em;"></span>
          <span class="sizing reset-size6 size1 mtight"><span class="mord mtight"><span class="mord mtight">${rootIndex}</span></span></span>
        </span>
      </span></span></span>
    </span>
    <span class="vlist-t vlist-t2">
      <span class="vlist-r">
        <span class="vlist">
          <span class="svg-align" style="top:-3em;">
            <span class="pstrut" style="height:3em;"></span>
            <span class="mord" style="padding-left:0.833em;">${content}</span>
          </span>
          <span style="top:-2.8092em;">
            <span class="pstrut" style="height:3em;"></span>
            <span class="hide-tail"><svg></svg></span>
          </span>
        </span>
        <span class="vlist-s">\u200b</span>
      </span>
      <span class="vlist-r"><span class="vlist"><span></span></span></span>
    </span>
  </span>`;
}

// =================================================================
// 基础字符与符号
// =================================================================
describe('基础字符与符号', () => {
  it('简单变量赋值 x = 1', () => {
    const html = katexHtml(`${mordMathnormal('x')}${mrel('=')}${mord('1')}`);
    expect(convertHtml(html)).toBe('x = 1');
  });

  it('多个字符拼接 xy', () => {
    const html = katexHtml(`${mordMathnormal('x')}${mordMathnormal('y')}`);
    expect(convertHtml(html)).toBe('xy');
  });

  it('二元运算符 + 两侧有空格', () => {
    const html = katexHtml(`${mord('1')}${mbin('+')}${mord('2')}`);
    expect(convertHtml(html)).toBe('1 + 2');
  });

  it('mbin × → \\times（查 OP_MAP）', () => {
    const html = katexHtml(`${mordMathnormal('a')}${mbin('×')}${mordMathnormal('b')}`);
    expect(convertHtml(html)).toBe('a \\times b');
  });

  it('mbin ÷ → \\div（查 OP_MAP）', () => {
    const html = katexHtml(`${mord('1')}${mbin('÷')}${mord('2')}`);
    expect(convertHtml(html)).toBe('1 \\div 2');
  });

  it('关系符 = 两侧有空格', () => {
    const html = katexHtml(`${mord('x')}${mrel('=')}${mord('y')}`);
    expect(convertHtml(html)).toBe('x = y');
  });

  it('mrel ≥ → \\geq（查 OP_MAP）', () => {
    const html = katexHtml(`${mord('x')}${mrel('≥')}${mord('0')}`);
    expect(convertHtml(html)).toBe('x \\geq 0');
  });

  it('mrel ≈ → \\approx（查 OP_MAP）', () => {
    const html = katexHtml(`${mordMathnormal('a')}${mrel('≈')}${mordMathnormal('b')}`);
    expect(convertHtml(html)).toBe('a \\approx b');
  });

  it('strut 布局占位被忽略', () => {
    const html = katexHtml(
      `<span class="strut" style="height:0.6em;"></span>${mord('x')}`
    );
    expect(convertHtml(html)).toBe('x');
  });

  it('mspace 间隔转为单个空格', () => {
    const html = katexHtml(`${mord('x')}<span class="mspace"></span>${mord('y')}`);
    // mspace 返回 ' '，拼接为 'x y'，但 trim 后是 'x y'
    expect(convertHtml(html)).toBe('x y');
  });
});

// =================================================================
// 上下标
// =================================================================
describe('上下标', () => {
  it('上标 x^2', () => {
    const html = katexHtml(`${mordMathnormal('x')}${msupsub(supEntry('2'))}`);
    expect(convertHtml(html)).toBe('x^{2}');
  });

  it('下标 x_n', () => {
    const html = katexHtml(`${mordMathnormal('x')}${msupsub(subEntry('n'))}`);
    expect(convertHtml(html)).toBe('x_{n}');
  });

  it('上下标同时 x_n^2（先下后上）', () => {
    // KaTeX 输出顺序：先上标（top 更负）后下标
    const html = katexHtml(
      `${mordMathnormal('x')}${msupsub(supEntry('2'), subEntry('n'))}`
    );
    // entries 按 top 升序：上标(-3.063) 在前，下标(-0.5) 在后
    // 多 entries 时：第一个是上标 ^{2}，第二个是下标 _{n}
    // 结果应该是 _{n}^{2}（下标在前，上标在后，符合 LaTeX 惯例）
    expect(convertHtml(html)).toBe('x_{n}^{2}');
  });

  it('导数符号 x\' 不包裹 ^{}（直接输出）', () => {
    // ′ 在 OP_MAP 中映射为 '，且 entries[0].text === "'" 时直接输出
    const html = katexHtml(`${mordMathnormal('x')}${msupsub(supEntry('′'))}`);
    expect(convertHtml(html)).toBe("x'");
  });

  it('双重导数 x\'\'（″ 映射为 \'\'，作为整体 token 不触发单引号特例）', () => {
    // ″ 在 OP_MAP 中映射为 ''（两个单引号），entries[0].text === "''"
    // 单引号特例只匹配 entries[0].text === "'"（单个），所以 "''" 走 ^{''} 分支
    const html = katexHtml(`${mordMathnormal('x')}${msupsub(supEntry('″'))}`);
    expect(convertHtml(html)).toBe("x^{''}");
  });

  it('上标含多个字符（mord 包含 2n+1）', () => {
    // KaTeX 实际会把 2n+1 拆成多个 mord/mbin，这里简化为单个 mord
    const html = katexHtml(
      `${mordMathnormal('x')}${msupsub(supEntry('2n+1'))}`
    );
    expect(convertHtml(html)).toBe('x^{2n+1}');
  });

  it('嵌套上下标 x^{y^2}（_findDirectTopSpans 限定直接子层级）', () => {
    // 内层 msupsub 的 vlist 不应被外层 _processSupSub 递归选中
    // 外层上标内容 = y^{2}（由 _processNode 递归处理内层 msupsub 得到）
    const innerSup = msupsub(supEntry('2'));
    const html = katexHtml(
      `${mordMathnormal('x')}${msupsub(supEntry(`${mordMathnormal('y')}${innerSup}`))}`
    );
    expect(convertHtml(html)).toBe('x^{y^{2}}');
  });
});

// =================================================================
// 分数
// =================================================================
describe('分数', () => {
  it('简单分数 \\frac{1}{2}', () => {
    const html = katexHtml(mfrac('1', '2'));
    expect(convertHtml(html)).toBe('\\frac{1}{2}');
  });

  it('分子分母含变量 \\frac{x}{y}', () => {
    const html = katexHtml(mfrac('x', 'y'));
    expect(convertHtml(html)).toBe('\\frac{x}{y}');
  });

  it('嵌套分数 \\frac{\\frac{1}{2}}{3}（_findDirectTopSpans 限定直接子层级）', () => {
    // _processFrac 用 _findDirectTopSpans 只取当前 mfrac 直接子层级的 vlist 中的 span
    // 避免了 querySelectorAll 递归进入嵌套 mfrac 的内层 vlist
    // 内层 \frac{1}{2} 会被递归 _processNode 正确处理为 \frac{1}{2}
    const innerFrac = mfrac('1', '2');
    const html = katexHtml(mfrac(innerFrac, '3'));
    const result = convertHtml(html);
    expect(result).toBe('\\frac{\\frac{1}{2}}{3}');
  });

  it('嵌套分数 \\frac{1}{\\frac{2}{3}}（分母嵌套）', () => {
    const innerFrac = mfrac('2', '3');
    const html = katexHtml(mfrac('1', innerFrac));
    const result = convertHtml(html);
    expect(result).toBe('\\frac{1}{\\frac{2}{3}}');
  });
});

// =================================================================
// 根号
// =================================================================
describe('根号', () => {
  it('简单根号 \\sqrt{x}', () => {
    const html = katexHtml(msqrt(mordMathnormal('x')));
    expect(convertHtml(html)).toBe('\\sqrt{x}');
  });

  it('根号内含数字 \\sqrt{2}', () => {
    const html = katexHtml(msqrt(mord('2')));
    expect(convertHtml(html)).toBe('\\sqrt{2}');
  });

  it('n 次根号 \\sqrt[3]{x}', () => {
    const html = katexHtml(mrootN('3', mordMathnormal('x')));
    expect(convertHtml(html)).toBe('\\sqrt[3]{x}');
  });

  it('n 次根号内含分数 \\sqrt[3]{\\frac{a}{b}}', () => {
    const html = katexHtml(mrootN('3', mfrac('a', 'b')));
    expect(convertHtml(html)).toBe('\\sqrt[3]{\\frac{a}{b}}');
  });

  it('n 次根号含多位根指数 \\sqrt[10]{x}', () => {
    const html = katexHtml(mrootN('10', mordMathnormal('x')));
    expect(convertHtml(html)).toBe('\\sqrt[10]{x}');
  });

  it('嵌套根号 \\sqrt{\\sqrt{x}}', () => {
    const innerSqrt = msqrt(mordMathnormal('x'));
    const html = katexHtml(msqrt(innerSqrt));
    expect(convertHtml(html)).toBe('\\sqrt{\\sqrt{x}}');
  });
});

// =================================================================
// nulldelimiter 不可见分隔符
// =================================================================
describe('nulldelimiter 不可见分隔符', () => {
  it('.mopen.nulldelimiter 不输出括号', () => {
    // KaTeX 用 .mopen.nulldelimiter 作为 \frac 两侧的不可见占位
    const html = katexHtml(`<span class="mopen nulldelimiter"></span>${mord('x')}`);
    expect(convertHtml(html)).toBe('x');
  });

  it('.mclose.nulldelimiter 不输出括号', () => {
    const html = katexHtml(`${mord('x')}<span class="mclose nulldelimiter"></span>`);
    expect(convertHtml(html)).toBe('x');
  });

  it('分数两侧 nulldelimiter 不产生多余括号', () => {
    // 完整的 KaTeX \frac{a}{b} 结构包含 nulldelimiter，不应产生 (\\frac{a}{b})
    const html = katexHtml(mfrac('a', 'b'));
    expect(convertHtml(html)).toBe('\\frac{a}{b}');
  });

  it('可见括号 .mopen（无 nulldelimiter）仍输出 (', () => {
    const html = katexHtml(`<span class="mopen">(</span>${mord('x')}<span class="mclose">)</span>`);
    expect(convertHtml(html)).toBe('(x)');
  });
});

// =================================================================
// 操作符（OP_MAP 查表）
// =================================================================
describe('操作符 OP_MAP 查表', () => {
  it('积分 ∫ → \\int', () => {
    const html = katexHtml(mop('∫'));
    expect(convertHtml(html)).toBe('\\int');
  });

  it('求和 ∑ → \\sum', () => {
    const html = katexHtml(mop('∑'));
    expect(convertHtml(html)).toBe('\\sum');
  });

  it('乘号 × → \\times', () => {
    const html = katexHtml(`${mord('2')}${mop('×')}${mord('3')}`);
    expect(convertHtml(html)).toBe('2\\times3');
  });

  it('无穷 ∞ → \\infty', () => {
    const html = katexHtml(mop('∞'));
    expect(convertHtml(html)).toBe('\\infty');
  });

  it('不等 ≠ → \\neq（mrel 查 OP_MAP）', () => {
    // _processNode 中 mrel/mbin/mpunct 走 _textWithOpMap，将 ≤ ≥ ≠ 等转为 LaTeX 命令
    const html = katexHtml(`${mord('x')}${mrel('≠')}${mord('y')}`);
    expect(convertHtml(html)).toBe('x \\neq y');
  });

  it('小于等于 ≤ → \\leq（mrel 查 OP_MAP）', () => {
    const html = katexHtml(`${mord('x')}${mrel('≤')}${mord('y')}`);
    expect(convertHtml(html)).toBe('x \\leq y');
  });
});

// =================================================================
// 希腊字母
// =================================================================
describe('希腊字母', () => {
  it('α → \\alpha', () => {
    const html = katexHtml(mord('α'));
    expect(convertHtml(html)).toBe('\\alpha');
  });

  it('π → \\pi', () => {
    const html = katexHtml(mord('π'));
    expect(convertHtml(html)).toBe('\\pi');
  });

  it('θ → \\theta', () => {
    const html = katexHtml(mord('θ'));
    expect(convertHtml(html)).toBe('\\theta');
  });

  it('Σ（大写）→ \\Sigma', () => {
    const html = katexHtml(mord('Σ'));
    expect(convertHtml(html)).toBe('\\Sigma');
  });

  it('Δ → \\Delta', () => {
    const html = katexHtml(mord('Δ'));
    expect(convertHtml(html)).toBe('\\Delta');
  });
});

// =================================================================
// LaTeX 命令后跟字母的空格分隔
// =================================================================
// \partial、\alpha 等命令后紧跟字母时，KaTeX 渲染为独立的 .mord 兄弟节点，
// 直接拼接会得到 \partialx（未定义命令）。_processChildren 在此场景插入空格。
describe('LaTeX 命令后跟字母的空格分隔', () => {
  it('\\partial x（∂ + x 两个独立 mord）', () => {
    const html = katexHtml(mord('∂') + mordMathnormal('x'));
    expect(convertHtml(html)).toBe('\\partial x');
  });

  it('\\partial x\\partial y（∂x∂y，第二个 \\partial 前无需空格，\\ 自分隔）', () => {
    const html = katexHtml(
      mord('∂') + mordMathnormal('x') + mord('∂') + mordMathnormal('y')
    );
    // \partial x\partial y 是合法 LaTeX：\ 自身分隔命令名，无需额外空格
    expect(convertHtml(html)).toBe('\\partial x\\partial y');
  });

  it('\\rho uv（ρ + u + v，命令后多字母）', () => {
    const html = katexHtml(mord('ρ') + mordMathnormal('u') + mordMathnormal('v'));
    expect(convertHtml(html)).toBe('\\rho uv');
  });

  it('\\partial^{2} 不误插空格（命令后是 ^，非字母）', () => {
    const html = katexHtml(mord('∂') + msupsub(supEntry('2')));
    expect(convertHtml(html)).toBe('\\partial^{2}');
  });

  it('sin x 不误插空格（sin 不是 \\command）', () => {
    // sin 是 .mop 但不是反斜杠命令，不触发空格插入
    const html = katexHtml(mop('sin') + mordMathnormal('x'));
    expect(convertHtml(html)).toBe('sinx');
  });
});

// =================================================================
// 复杂组合公式
// =================================================================
describe('复杂组合公式', () => {
  it('定积分 \\int_0^1 x^2 dx', () => {
    // ∫ + 上下标（0 下标，1 上标）+ x + ^2 + d + x
    const html = katexHtml(
      mop('∫') +
      msupsub(supEntry('1'), subEntry('0')) +
      mordMathnormal('x') +
      msupsub(supEntry('2')) +
      mordMathnormal('d') +
      mordMathnormal('x')
    );
    // 期望：\int_{0}^{1}x^{2}dx
    expect(convertHtml(html)).toBe('\\int_{0}^{1}x^{2}dx');
  });

  it('求和公式 \\sum_{n=1}^{\\infty} \\frac{1}{n}', () => {
    const html = katexHtml(
      mop('∑') +
      msupsub(supEntry(mop('∞')), subEntry(`${mordMathnormal('n')}${mrel('=')}${mord('1')}`)) +
      mfrac('1', 'n')
    );
    // 上标：∞ → \infty
    // 下标：n=1（注意 n=1 中 = 是 mrel 会被 _processNode 处理为 ' = '，trim 后为 'n = 1'）
    expect(convertHtml(html)).toBe('\\sum_{n = 1}^{\\infty}\\frac{1}{n}');
  });

  it('二次公式 x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', () => {
    // 简化版：只验证核心结构，不追求完全等价
    const html = katexHtml(
      mordMathnormal('x') +
      mrel('=') +
      mfrac(
        `${mord('-')}${mordMathnormal('b')}${mop('±')}${msqrt(`${mordMathnormal('b')}${msupsub(supEntry('2'))}${mbin('-')}${mord('4')}${mordMathnormal('a')}${mordMathnormal('c')}`)}`,
        `${mord('2')}${mordMathnormal('a')}`
      )
    );
    const result = convertHtml(html);
    // 验证关键部分存在
    expect(result).toContain('x =');
    expect(result).toContain('\\frac{');
    expect(result).toContain('\\sqrt{');
    expect(result).toContain('b^{2}');
  });
});

// =================================================================
// 操作符带上下限（真实 KaTeX 嵌套结构）
// =================================================================
// Kimi 移除了 <annotation> 可访问性层后，这些结构的反向解析是积分/求和公式
// 能否正确导出的关键。覆盖两种 KaTeX inline 渲染结构：
//   1. .mop 容器 > .mop.op-symbol（∫）+ .msupsub（上下限）— 用于积分
//   2. .mop.op-limits 容器 > vlist > entries（下标/操作符/上标）— 用于 \sum、\lim
describe('操作符带上下限（真实 KaTeX 嵌套结构）', () => {
  // 结构 1：.mop 容器嵌套 .mop.op-symbol + .msupsub（积分等 large-op）
  // 修复前 _processOp 直接取整体 textContent（如 "∫01"），查不到 OP_MAP 导致输出乱码
  function mopNestedWithSupSub(symbol, ...supsubEntries) {
    return `<span class="mop">
      <span class="mop op-symbol large-op" style="margin-right:0.44445em;">${symbol}</span>
      ${msupsub(...supsubEntries)}
    </span>`;
  }

  it('inline 积分 \\int_{0}^{1}（.mop 嵌套 .mop.op-symbol + .msupsub）', () => {
    const html = katexHtml(
      mopNestedWithSupSub('∫', supEntry('1'), subEntry('0'))
    );
    expect(convertHtml(html)).toBe('\\int_{0}^{1}');
  });

  it('inline 环路积分 \\oint_{z=1}（.mop 嵌套，仅下标）', () => {
    const html = katexHtml(
      mopNestedWithSupSub('∮',
        subEntry(`${mordMathnormal('z')}${mrel('=')}${mord('1')}`)
      )
    );
    expect(convertHtml(html)).toBe('\\oint_{z = 1}');
  });

  // 结构 2：.mop.op-limits 容器 + vlist（\sum、\lim 等 limits 型操作符）
  // KaTeX vlist 中 entry 按 top 从大到小排列（下标 top 最接近 0，上标 top 最负）
  // 含 .mop 子元素的 entry 是操作符符号，其余根据 top 与操作符 top 的大小判断上下标
  function opLimitsEntry(innerHtml, top, isOperator) {
    const content = isOperator
      ? innerHtml
      : `<span class="sizing reset-size6 size3 mtight"><span class="mord mtight">${innerHtml}</span></span>`;
    return `<span style="top:${top}em;">
      <span class="pstrut" style="height:3em;"></span>
      <span>${content}</span>
    </span>`;
  }
  function opLimits(...entries) {
    return `<span class="mop op-limits">
      <span class="vlist-t vlist-r">
        <span class="vlist">${entries.join('')}</span>
      </span>
    </span>`;
  }

  it('inline 求和 \\sum_{k=1}^{\\infty}（.mop.op-limits vlist 3 entries）', () => {
    // 真实 KaTeX 文档顺序：下标(top=-2.4) → 操作符(top=-3) → 上标(top=-3.8)
    // ∞ 在 mtight 上下文中渲染为 .mord（非 .mop），不会误判为操作符 entry
    const html = katexHtml(
      opLimits(
        opLimitsEntry(`${mordMathnormal('k')}${mrel('=')}${mord('1')}`, -2.4, false),
        opLimitsEntry('<span class="mop op-symbol large-op">∑</span>', -3, true),
        opLimitsEntry('∞', -3.8, false)
      )
    );
    expect(convertHtml(html)).toBe('\\sum_{k = 1}^{\\infty}');
  });

  it('inline 极限 \\lim_{n \\to \\infty}（.mop.op-limits vlist 2 entries，仅下标）', () => {
    // lim 是文本操作符（.mop 无 op-symbol），下标在操作符下方
    const html = katexHtml(
      opLimits(
        opLimitsEntry(`${mordMathnormal('n')}${mrel('→')}${mord('∞')}`, -2.3857, false),
        opLimitsEntry('<span class="mop">lim</span>', -3, true)
      )
    );
    expect(convertHtml(html)).toBe('lim_{n \\to \\infty}');
  });

  it('积分 + 求和组合公式（端到端结构验证）', () => {
    // 模拟真实 Kimi HTML 中的组合结构：\int_{0}^{1} x \sum_{k=1}^{n} dx
    const html = katexHtml(
      mopNestedWithSupSub('∫', supEntry('1'), subEntry('0')) +
      mordMathnormal('x') +
      opLimits(
        opLimitsEntry(`${mordMathnormal('k')}${mrel('=')}${mord('1')}`, -2.4, false),
        opLimitsEntry('<span class="mop op-symbol large-op">∑</span>', -3, true),
        opLimitsEntry(mordMathnormal('n'), -3.8, false)
      ) +
      mordMathnormal('d') +
      mordMathnormal('x')
    );
    expect(convertHtml(html)).toBe('\\int_{0}^{1}x\\sum_{k = 1}^{n}dx');
  });
});

// =================================================================
// 降级处理
// =================================================================
describe('降级处理', () => {
  it('空 .katex-html 返回空字符串', () => {
    const html = `<span class="katex-html"><span class="base"></span></span>`;
    expect(convertHtml(html)).toBe('');
  });

  it('未识别的 class 节点降级为 textContent', () => {
    // .unknown 类未在分派表中，会走"递归子节点或 textContent"
    const html = katexHtml(`<span class="unknown-class">hello</span>`);
    expect(convertHtml(html)).toBe('hello');
  });

  it('未在 OP_MAP 中的符号原样返回', () => {
    // ❤ 不在 OP_MAP 中，原样输出
    const html = katexHtml(mord('❤'));
    expect(convertHtml(html)).toBe('❤');
  });

  it('解析异常时降级为 textContent（不抛错）', () => {
    // 构造一个会让 _processSupSub 抛错的场景：vlist 中 span 缺失 style 属性
    // 实际上当前实现用了 try-catch，会降级到 textContent
    const html = `<span class="katex-html">
      <span class="base">
        <span class="mord mathnormal">x</span>
        <span class="msupsub">
          <span class="vlist-t">
            <span class="vlist-r">
              <span class="vlist">broken structure</span>
            </span>
          </span>
        </span>
      </span>
    </span>`;
    // 不会抛错，至少返回 'x' 或包含 'x' 的字符串
    const result = convertHtml(html);
    expect(result).toContain('x');
  });

  it('.vlist-s 零宽空格不泄漏到输出', () => {
    // KaTeX 的 .vlist-s 元素 textContent 为 U+200B（零宽空格），用于布局间距
    // 若被降级路径处理会污染输出，导致 KaTeX 重新渲染时报 unknownSymbol 警告
    const html = katexHtml(
      `${mordMathnormal('x')}<span class="vlist-s">\u200b</span>${mordMathnormal('y')}`
    );
    const result = convertHtml(html);
    expect(result).toBe('xy');
    expect(result).not.toContain('\u200b');
  });

  it('根号结构中 .vlist-s 不泄漏零宽空格', () => {
    // msqrt fixture 已包含 .vlist-s，验证完整根号提取不产生 ZWSP
    const html = katexHtml(msqrt(mordMathnormal('x')));
    const result = convertHtml(html);
    expect(result).toBe('\\sqrt{x}');
    expect(result).not.toContain('\u200b');
  });
});

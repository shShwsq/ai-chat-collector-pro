// tests/dom/html-to-markdown.test.js
// html-to-markdown.js 测试：统一 HTML → Markdown 转换封装
//
// 这个测试套件覆盖：
//   1. 基础 Markdown 转换（标题、列表、加粗、斜体、链接、删除线）
//   2. 自定义段落规则（paragraphDiv / qkMdParagraphDiv / doubaoParagraphDiv）
//   3. 三平台代码块规则（DeepSeek / 千问 / 豆包）
//   4. KaTeX 行内/块级公式（标准 annotation 路径 + katex-html 降级路径）
//   5. 噪声元素移除（svg / button / .iconify / .action / .toolbar）
//
// "DOM 改了立刻发现"的关键回归点：
//   - 平台改用新 class 名（如 paragraph → section）→ 段落规则失效
//   - 平台重构代码块结构 → 语言提取失败
//   - KaTeX 升级改变 .katex-html 结构 → 公式反向解析失败

import { describe, it, expect, beforeAll } from 'vitest';
import { loadHtmlToMarkdown } from '../helpers/load-source.js';

let HtmlToMarkdown;

beforeAll(() => {
  const lib = loadHtmlToMarkdown();
  HtmlToMarkdown = lib.HtmlToMarkdown;
});

// 辅助：把 HTML 设置到 document.body 的临时容器中，返回容器元素
function makeRoot(htmlString) {
  document.body.innerHTML = `<div id="test-root">${htmlString}</div>`;
  return document.body.querySelector('#test-root');
}

// 辅助：转换 HTML 字符串为 Markdown
function convert(htmlString) {
  return HtmlToMarkdown.convert(makeRoot(htmlString));
}

// =================================================================
// 基础 Markdown 转换
// =================================================================
describe('基础 Markdown 转换', () => {
  it('空输入返回空字符串', () => {
    expect(HtmlToMarkdown.convert(null)).toBe('');
    expect(HtmlToMarkdown.convert(undefined)).toBe('');
  });

  it('纯文本原样返回', () => {
    expect(convert('hello world')).toBe('hello world');
  });

  it('h1 标题 → #', () => {
    expect(convert('<h1>Title</h1>')).toBe('# Title');
  });

  it('h2 标题 → ##', () => {
    expect(convert('<h2>Subtitle</h2>')).toBe('## Subtitle');
  });

  it('h3 标题 → ###', () => {
    expect(convert('<h3>Section</h3>')).toBe('### Section');
  });

  it('段落 <p> 之间用空行分隔', () => {
    const md = convert('<p>第一段</p><p>第二段</p>');
    expect(md).toBe('第一段\n\n第二段');
  });

  it('加粗 <strong> → **text**', () => {
    expect(convert('<strong>bold</strong>')).toBe('**bold**');
  });

  it('斜体 <em> → *text*', () => {
    expect(convert('<em>italic</em>')).toBe('*italic*');
  });

  it('内联链接 <a> → [text](url)', () => {
    expect(convert('<a href="https://example.com">link</a>')).toBe('[link](https://example.com)');
  });

  it('无序列表 <ul> → - item（turndown 默认 - 后跟 3 空格）', () => {
    const md = convert('<ul><li>item1</li><li>item2</li></ul>');
    // turndown CommonMark 风格：- 后跟 3 个空格
    expect(md).toMatch(/^-\s+item1$/m);
    expect(md).toMatch(/^-\s+item2$/m);
  });

  it('有序列表 <ol> → 1. item（turndown 默认 . 后跟 2 空格）', () => {
    const md = convert('<ol><li>first</li><li>second</li></ol>');
    expect(md).toMatch(/^1\.\s+first$/m);
    expect(md).toMatch(/^2\.\s+second$/m);
  });

  it('行内代码 <code> → `code`', () => {
    expect(convert('<code>inline code</code>')).toBe('`inline code`');
  });

  it('GFM 删除线 <del> → ~text~（turndown-plugin-gfm 默认用单 ~）', () => {
    // GFM 规范支持 ~ 和 ~~，turndown-plugin-gfm 默认输出单 ~
    expect(convert('<del>struck</del>')).toBe('~struck~');
  });
});

// =================================================================
// 自定义段落规则
// =================================================================
describe('自定义段落规则', () => {
  it('Kimi <div class="paragraph"> → 段落（前后空行）', () => {
    const md = convert('<div class="paragraph">段落内容</div>');
    expect(md).toBe('段落内容');
  });

  it('多个 div.paragraph 之间有空行', () => {
    const md = convert('<div class="paragraph">第一段</div><div class="paragraph">第二段</div>');
    expect(md).toBe('第一段\n\n第二段');
  });

  it('千问 <div class="qk-md-paragraph"> → 段落', () => {
    const md = convert('<div class="qk-md-paragraph">千问段落</div>');
    expect(md).toBe('千问段落');
  });

  it('豆包 <div class="container-enLQFx"> → 段落', () => {
    const md = convert('<div class="container-enLQFx">豆包段落</div>');
    expect(md).toBe('豆包段落');
  });

  it('class 含其他后缀的 paragraph 仍被识别（正则匹配 \\bparagraph\\b）', () => {
    const md = convert('<div class="my-paragraph-custom">内容</div>');
    expect(md).toBe('内容');
  });
});

// =================================================================
// DeepSeek 代码块规则
// =================================================================
describe('DeepSeek 代码块 (md-code-block)', () => {
  it('提取语言标签和代码内容', () => {
    const html = `<div class="md-code-block">
      <div class="md-code-block-banner-wrap">
        <span class="d813de27">bash</span>
        <div role="button">复制</div>
        <div role="button">下载</div>
      </div>
      <pre><code>echo hello</code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```bash');
    expect(md).toContain('echo hello');
    expect(md).toContain('```');
    // 复制/下载按钮文字不应出现在代码中
    expect(md).not.toContain('复制');
    expect(md).not.toContain('下载');
  });

  it('无 banner 时仍能提取代码（语言为空）', () => {
    const html = `<div class="md-code-block"><pre><code>print(1)</code></pre></div>`;
    const md = convert(html);
    expect(md).toContain('```');
    expect(md).toContain('print(1)');
  });

  it('多行代码保留换行', () => {
    const html = `<div class="md-code-block">
      <div class="md-code-block-banner-wrap"><span>python</span></div>
      <pre><code>def foo():
    return 1</code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```python');
    expect(md).toContain('def foo():');
    expect(md).toContain('    return 1');
  });
});

// =================================================================
// 千问代码块规则
// =================================================================
describe('千问代码块 (qw-md-code)', () => {
  it('从标题栏 span.mr-auto 提取语言，从 <pre> 提取代码', () => {
    const html = `<div class="qw-md-code">
      <div class="h-[36px]">
        <span class="font-medium mr-auto">python</span>
        <button>编辑</button>
        <button>复制</button>
      </div>
      <div class="codeHighlighterWrapper">
        <pre><code><span class="react-syntax-highlighter-line-number">1</span>print(1)</code></pre>
      </div>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```python');
    expect(md).toContain('print(1)');
    // 行号不应混入代码内容
    expect(md).not.toMatch(/1print/);
  });

  it('行号 span 被移除（多个行号都不混入代码）', () => {
    const html = `<div class="qw-md-code">
      <div><span class="font-medium">javascript</span></div>
      <pre><code>
        <span class="react-syntax-highlighter-line-number">1</span>const a = 1;
        <span class="react-syntax-highlighter-line-number">2</span>const b = 2;
      </code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('const a = 1;');
    expect(md).toContain('const b = 2;');
    expect(md).not.toMatch(/1const/);
    expect(md).not.toMatch(/2const/);
  });

  it('语言标签为 .font-medium（无 mr-auto）时也能提取', () => {
    const html = `<div class="qw-md-code">
      <div><span class="font-medium">go</span></div>
      <pre><code>fmt.Println("hi")</code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```go');
    expect(md).toContain('fmt.Println("hi")');
  });
});

// =================================================================
// 豆包代码块规则
// =================================================================
describe('豆包代码块 (code-block-element-*)', () => {
  it('从 <code class="language-xxx"> 提取语言', () => {
    const html = `<div class="code-block-element-R6c8c0">
      <div class="code-area-yxsM36">
        <div class="header-wrapper-Mbk8s6" data-copy-ignore="true">
          <div class="header-IAeXdE">
            <div class="title-TXcgFG"><div class="text-OkYU_0">bash</div></div>
            <div class="action-ysQCxz">运行</div>
          </div>
        </div>
        <div class="content-y8qlFa"><pre class="language-bash"><code class="language-bash">echo hi</code></pre></div>
      </div>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```bash');
    expect(md).toContain('echo hi');
    // 标题栏"运行"按钮文字不应混入
    expect(md).not.toContain('运行');
  });

  it('无 <code class="language-xxx"> 时从 <pre class="language-xxx"> 提取', () => {
    const html = `<div class="code-block-element-abc123">
      <div data-copy-ignore="true"><div class="title-xyz">python</div></div>
      <pre class="language-python"><code>print(1)</code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```python');
    expect(md).toContain('print(1)');
  });

  it('无任何 language-xxx 标记时从标题栏兜底提取', () => {
    const html = `<div class="code-block-element-xyz">
      <div data-copy-ignore="true">
        <div class="title-wrap"><div class="text">javascript</div></div>
      </div>
      <pre><code>const x = 1</code></pre>
    </div>`;
    const md = convert(html);
    expect(md).toContain('```javascript');
    expect(md).toContain('const x = 1');
  });
});

// =================================================================
// KaTeX 行内公式
// =================================================================
describe('KaTeX 行内公式', () => {
  // 直接调用 _extractKatexLatex：验证标准 annotation 提取路径
  it('_extractKatexLatex 直接调用：从 <annotation> 提取原始 LaTeX', () => {
    const html = `<span class="katex">
      <span class="katex-mathml">
        <math><semantics>
          <mrow><msup><mi>x</mi><mn>2</mn></msup></mrow>
          <annotation encoding="application/x-tex">x^2</annotation>
        </semantics></math>
      </span>
      <span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">x</span></span></span>
    </span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractKatexLatex(katexEl);
    expect(latex).toBe('x^2');
  });

  // 通过 convert 调用：annotation 被预提取到 data 属性，走无损优先路径
  it('convert 整体转换：annotation 预提取，走无损优先路径', () => {
    const html = `<p>公式 <span class="katex">
      <span class="katex-mathml"><math><annotation encoding="application/x-tex">x^2</annotation></math></span>
      <span class="katex-html" aria-hidden="true">
        <span class="base">
          <span class="mord mathnormal">x</span>
          <span class="msupsub"><span class="vlist-t vlist-r"><span class="vlist">
            <span style="top:-3.063em;"><span class="pstrut"></span><span class="mord mtight">2</span></span>
          </span></span></span>
        </span>
      </span>
    </span> 结束</p>`;
    const md = convert(html);
    // 走 annotation 优先路径：输出原始 LaTeX $x^2$（而非反向解析的 $x^{2}$）
    expect(md).toContain('$x^2$');
    expect(md).not.toContain('$x^{2}$');
  });

  // 通过 convert 调用：无 annotation（Kimi 等平台），走 katex-html 反向解析降级路径
  it('convert 整体转换：无 annotation 时走 katex-html 反向解析', () => {
    const html = `<p>公式 <span class="katex">
      <span class="katex-html" aria-hidden="true">
        <span class="base">
          <span class="mord mathnormal">x</span>
          <span class="msupsub"><span class="vlist-t vlist-r"><span class="vlist">
            <span style="top:-3.063em;"><span class="pstrut"></span><span class="mord mtight">2</span></span>
          </span></span></span>
        </span>
      </span>
    </span> 结束</p>`;
    const md = convert(html);
    // 无 annotation，走反向解析：输出 $x^{2}$
    expect(md).toContain('$x^{2}$');
  });

  it('KaTeX 节点缺失 annotation 和 katex-html 时降级为 textContent', () => {
    const html = `<span class="katex">纯文本</span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractKatexLatex(katexEl);
    expect(latex).toBe('纯文本');
  });
});

// =================================================================
// 豆包 copy-text 路径（行内公式 LaTeX 存在父容器属性，非 annotation）
// =================================================================
describe('豆包 copy-text 路径', () => {
  // 豆包行内公式结构：
  // <span class="container-xxx math-inline" copy-text="\(原始LaTeX\)">
  //   <span class="katex">
  //     <span class="katex-html">...</span>  ← 无 katex-mathml，无 annotation
  //   </span>
  // </span>

  it('_extractRawLatex 直接调用：从父元素 copy-text 属性提取（行内 \\(...\\) 定界符）', () => {
    const html = `<span class="math-inline" copy-text="\\(x^2 + y^2\\)">
      <span class="katex">
        <span class="katex-html" aria-hidden="true">
          <span class="base"><span class="mord mathnormal">x</span></span>
        </span>
      </span>
    </span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractRawLatex(katexEl);
    expect(latex).toBe('x^2 + y^2');
  });

  it('_extractRawLatex 直接调用：从父元素 copy-text 属性提取（块级 \\[...\\] 定界符）', () => {
    const html = `<span class="math-block" copy-text="\\[\\frac{1}{2}\\]">
      <span class="katex">
        <span class="katex-html" aria-hidden="true">
          <span class="base"><span class="mord"><span class="mfrac"></span></span></span>
        </span>
      </span>
    </span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractRawLatex(katexEl);
    expect(latex).toBe('\\frac{1}{2}');
  });

  it('_extractRawLatex：annotation 优先于 copy-text', () => {
    // 同时有 annotation 和 copy-text 时，应优先取 annotation
    const html = `<span class="math-inline" copy-text="\\(from-copy-text\\)">
      <span class="katex">
        <span class="katex-mathml"><math><annotation encoding="application/x-tex">from-annotation</annotation></math></span>
        <span class="katex-html"></span>
      </span>
    </span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractRawLatex(katexEl);
    expect(latex).toBe('from-annotation');
  });

  it('_extractRawLatex：无 annotation 且无 copy-text 时返回空字符串', () => {
    const html = `<span class="katex">
      <span class="katex-html" aria-hidden="true"><span class="base"></span></span>
    </span>`;
    const katexEl = makeRoot(html).querySelector('.katex');
    const latex = HtmlToMarkdown._extractRawLatex(katexEl);
    expect(latex).toBe('');
  });

  it('convert 整体转换：豆包行内公式走 copy-text 无损路径', () => {
    // 豆包行内公式：copy-text 属性有原始 LaTeX，katex 无 annotation
    const html = `<p>公式 <span class="container-wTfUs6 math-inline" copy-text="\\(\\frac{a^2 + b^2}{2}\\)">
      <span class="katex">
        <span class="katex-html" aria-hidden="true">
          <span class="base">
            <span class="mord"><span class="mfrac"><span class="vlist-t vlist-r"><span class="vlist">
              <span style="top:-2.314em;"><span class="pstrut"></span><span class="mord mtight">2</span></span>
              <span style="top:-3.23em;"><span class="pstrut"></span><span class="mord mtight">a</span></span>
            </span></span></span></span>
          </span>
        </span>
      </span>
    </span> 结束</p>`;
    const md = convert(html);
    // 走 copy-text 路径：输出原始 LaTeX，而非反向解析的 \frac{a^{2} + b^{2}}{2}
    expect(md).toContain('$\\frac{a^2 + b^2}{2}$');
  });

  it('convert 整体转换：豆包行内公式 copy-text 含复杂嵌套公式', () => {
    // 使用豆包真实 copy-text 内容（含 \displaystyle \int \sum \sqrt 等命令）
    const copyText = '\\(\\frac{\\displaystyle \\int_0^{\\pi/2} \\sin^n x \\, dx \\cdot \\sum_{k=0}^{\\infty} \\frac{(-1)^k}{(2k+1)!} x^{2k+1}}{\\sqrt{\\frac{a^2 + b^2}{2}}}\\)';
    const html = `<p>公式 <span class="math-inline" copy-text="${copyText}">
      <span class="katex">
        <span class="katex-html" aria-hidden="true">
          <span class="base"><span class="mord">复杂公式</span></span>
        </span>
      </span>
    </span> 结束</p>`;
    const md = convert(html);
    // 走 copy-text 路径：输出原始 LaTeX（含 \displaystyle \int 等标准命令）
    expect(md).toContain('\\displaystyle \\int_0^{\\pi/2}');
    expect(md).toContain('\\sum_{k=0}^{\\infty}');
    // 不应出现反向解析的特征（如 \int 不带参数或 Unicode 字符）
    expect(md).not.toContain('∫0π');
  });
});

// =================================================================
// KaTeX 块级公式
// =================================================================
describe('KaTeX 块级公式', () => {
  it('_extractKatexLatex 块级：从 annotation 提取', () => {
    const html = `<span class="katex-display">
      <span class="katex">
        <span class="katex-mathml"><math><annotation encoding="application/x-tex">\\int_0^1 x^2 dx</annotation></math></span>
        <span class="katex-html"></span>
      </span>
    </span>`;
    const displayEl = makeRoot(html).querySelector('.katex-display');
    const latex = HtmlToMarkdown._extractKatexLatex(displayEl);
    expect(latex).toBe('\\int_0^1 x^2 dx');
  });

  it('convert 块级公式：annotation 预提取，输出 $$...$$（前后空行）', () => {
    const html = `<span class="katex-display">
      <span class="katex">
        <span class="katex-mathml"><math><annotation encoding="application/x-tex">x^2</annotation></math></span>
        <span class="katex-html" aria-hidden="true">
          <span class="base">
            <span class="mord mathnormal">x</span>
            <span class="msupsub"><span class="vlist-t vlist-r"><span class="vlist">
              <span style="top:-3.063em;"><span class="pstrut"></span><span class="mord mtight">2</span></span>
            </span></span></span>
          </span>
        </span>
      </span>
    </span>`;
    const md = convert(html);
    // 走 annotation 优先路径：输出原始 LaTeX $$x^2$$（而非反向解析的 $$x^{2}$$）
    expect(md).toMatch(/^\$\$x\^2\$\$$/);
  });
});

// =================================================================
// 噪声元素移除
// =================================================================
describe('噪声元素移除', () => {
  it('svg 元素被移除', () => {
    const md = convert('<p>文本<svg><path d="..."></path></svg>后续</p>');
    expect(md).toBe('文本后续');
  });

  it('button 元素被移除', () => {
    const md = convert('<p>文本<button>复制</button>后续</p>');
    expect(md).toBe('文本后续');
  });

  it('.iconify 元素被移除', () => {
    const md = convert('<p>文本<span class="iconify">图标</span>后续</p>');
    expect(md).toBe('文本后续');
  });

  it('[class*="action"] 元素被移除', () => {
    const md = convert('<p>文本<span class="my-action-btn">按钮</span>后续</p>');
    expect(md).toBe('文本后续');
  });

  it('[class*="toolbar"] 元素被移除', () => {
    const md = convert('<p>文本<span class="my-toolbar-item">工具</span>后续</p>');
    expect(md).toBe('文本后续');
  });

  it('.segment-assistant-actions 被移除（Kimi 助手操作栏）', () => {
    const md = convert('<p>回答</p><div class="segment-assistant-actions"><button>复制</button></div>');
    expect(md).toBe('回答');
  });

  it('.thinking-container 被移除（思考块容器）', () => {
    const md = convert('<p>回答</p><div class="thinking-container">思考内容</div>');
    expect(md).toBe('回答');
  });

  it('多个噪声元素同时存在都被移除', () => {
    const html = `<div>
      <p>正文</p>
      <svg>icon</svg>
      <button>btn</button>
      <span class="iconify">icon</span>
      <div class="action-row">action</div>
      <div class="toolbar-row">toolbar</div>
    </div>`;
    const md = convert(html);
    expect(md).toBe('正文');
    expect(md).not.toContain('icon');
    expect(md).not.toContain('btn');
    expect(md).not.toContain('action');
    expect(md).not.toContain('toolbar');
  });

  it('.segment-code-header 被移除（Kimi 代码块标题栏含语言标签和复制按钮）', () => {
    // Kimi 代码块结构：.segment-code > .segment-code-header（噪声）+ .segment-code-content > pre > code
    // header 含 .segment-code-lang（语言标签）和 .kimi-tooltip（复制按钮），整体被 NOISE_SELECTORS 移除
    // 注意：语言标签随 header 一起被移除，turndown 默认 codeBlock 规则不提取语言（已知限制）
    const html = `<div class="segment-code">
      <div class="segment-code-header">
        <span class="segment-code-lang">python</span>
        <span class="kimi-tooltip">复制</span>
      </div>
      <div class="segment-code-content">
        <pre><code>def hello():
    print("hi")</code></pre>
      </div>
    </div>`;
    const md = convert(html);
    // 代码内容被提取（围栏代码块）
    expect(md).toContain('```');
    expect(md).toContain('def hello():');
    expect(md).toContain('print("hi")');
    // 标题栏噪声被移除
    expect(md).not.toContain('复制');
  });
});

// =================================================================
// 复杂组合场景
// =================================================================
describe('复杂组合场景', () => {
  it('段落 + 代码块 + 段落', () => {
    const html = `<div class="paragraph">前文</div>
    <div class="md-code-block">
      <div class="md-code-block-banner-wrap"><span>python</span></div>
      <pre><code>print(1)</code></pre>
    </div>
    <div class="paragraph">后文</div>`;
    const md = convert(html);
    expect(md).toContain('前文');
    expect(md).toContain('```python');
    expect(md).toContain('print(1)');
    expect(md).toContain('后文');
  });

  it('混合内容：标题 + 段落 + 列表 + 链接', () => {
    const html = `<h2>标题</h2>
    <div class="paragraph">段落 <a href="https://example.com">链接</a></div>
    <ul><li>项目1</li><li>项目2</li></ul>`;
    const md = convert(html);
    expect(md).toContain('## 标题');
    expect(md).toContain('段落');
    expect(md).toContain('[链接](https://example.com)');
    // turndown 默认 - 后跟 3 空格
    expect(md).toMatch(/^-\s+项目1$/m);
    expect(md).toMatch(/^-\s+项目2$/m);
  });

  it('多空行被压缩为单个空行', () => {
    const html = `<p>第一段</p>
    <p></p>
    <p></p>
    <p>第二段</p>`;
    const md = convert(html);
    // 多个空 p 会产生多余空行，convert 内部 \n{3,} → \n\n 压缩
    expect(md).not.toMatch(/\n{3,}/);
  });
});

// =================================================================
// 表格转换（GFM 插件）
// =================================================================
describe('表格转换（GFM）', () => {
  // turndown-plugin-gfm 负责将 <table> 转为 Markdown 表格
  // Kimi 等平台用标准 <table> 元素渲染表格（kimi_table.txt 确认）

  it('简单表格转为 Markdown 表格格式', () => {
    const html = `<table>
      <thead><tr><th>名称</th><th>值</th></tr></thead>
      <tbody>
        <tr><td>foo</td><td>1</td></tr>
        <tr><td>bar</td><td>2</td></tr>
      </tbody>
    </table>`;
    const md = convert(html);
    // 表头
    expect(md).toContain('名称');
    expect(md).toContain('值');
    // 分隔行（GFM 表格必须有 | --- | 分隔行）
    expect(md).toMatch(/\|[\s-]*\|/);
    // 数据行
    expect(md).toContain('foo');
    expect(md).toContain('bar');
    expect(md).toContain('1');
    expect(md).toContain('2');
  });

  it('表格与段落共存（Kimi .markdown > .paragraph + table 结构）', () => {
    const html = `<div class="markdown">
      <div class="paragraph">下面是对比表格：</div>
      <table>
        <thead><tr><th>方案</th><th>优点</th></tr></thead>
        <tbody><tr><td>A</td><td>简单</td></tr></tbody>
      </table>
      <div class="paragraph">以上是方案对比。</div>
    </div>`;
    const md = convert(html);
    // 段落内容保留
    expect(md).toContain('下面是对比表格');
    expect(md).toContain('以上是方案对比');
    // 表格内容保留
    expect(md).toContain('方案');
    expect(md).toContain('优点');
    expect(md).toContain('简单');
    // GFM 分隔行存在
    expect(md).toMatch(/\|[\s-]*\|/);
  });
});

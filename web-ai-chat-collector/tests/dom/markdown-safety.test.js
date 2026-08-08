import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadHtmlSanitizer } from '../helpers/load-source.js';

let sanitizer;

beforeAll(() => {
  sanitizer = loadHtmlSanitizer();
});

describe('Markdown HTML 安全清理', () => {
  it('移除 script、事件处理器和危险 URL 协议', () => {
    const output = sanitizer.sanitize(
      '<script>alert(1)</script><p onclick="alert(2)">ok</p>' +
      '<a href="javascript:alert(3)">bad</a><a href="https://example.com">safe</a>'
    );
    expect(output).not.toContain('<script');
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('javascript:');
    expect(output).toContain('href="#"');
    expect(output).toContain('rel="noopener noreferrer"');
  });

  it('整棵移除 SVG、MathML、iframe 和破损危险 HTML', () => {
    const output = sanitizer.sanitize(
      '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>' +
      '<math><mtext>bad</mtext></math><iframe srcdoc="<script>x</script>"></iframe>' +
      '<img src=x onerror=alert(1)><p>保留</p>'
    );
    expect(output).toBe('<p>保留</p>');
  });

  it('保留 Markdown 代码块和 KaTeX 所需的安全容器类', () => {
    const output = sanitizer.sanitize(
      '<pre><code class="language-js">const x = &lt;b&gt;;</code></pre>' +
      '<span class="katex"><span class="katex-html">x</span></span>'
    );
    expect(output).toContain('<pre><code class="language-js">');
    expect(output).toContain('class="katex"');
    expect(output).toContain('class="katex-html"');
  });

  it('阻止 data URL 和编码后的 javascript URL', () => {
    const output = sanitizer.sanitize(
      '<a href="data:text/html;base64,PHNjcmlwdD4=">data</a>' +
      '<a href="jav&#x61;script:alert(1)">encoded</a>'
    );
    expect(output).not.toContain('data:text/html');
    expect(output).not.toContain('javascript:');
  });
});



describe('Popup list injection safety', () => {
  it('escapes dynamic labels and whitelists message roles', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'popup', 'popup.js'), 'utf-8');
    expect(source).toContain("title=\"${escapeHtml(conv.title || '')}\"");
    expect(source).toContain("${escapeHtml(platformLabel || '')}");
    expect(source).toContain("m.role === 'user' ? 'user' : 'assistant'");
    expect(source).not.toContain('title="${conv.title}">${conv.title}');
    expect(source).not.toContain('msg-preview ${m.role}');
    expect(source).not.toContain('data-id="${conv.id}"');
  });
});

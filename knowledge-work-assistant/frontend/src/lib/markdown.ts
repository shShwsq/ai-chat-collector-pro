/**
 * 轻量 Markdown → HTML 渲染（无需引入第三方库）。
 *
 * 支持：
 * - ```lang ... ``` 围栏代码块（多行，保留换行，独立分隔块）
 * - # / ## / ### 标题
 * - - / * 无序列表
 * - 1. 有序列表
 * - 空行分段
 * - **加粗**
 * - 行内 `code`
 *
 * 不支持的语法原样输出为段落文本，保证降级内容也能展示。
 *
 * 安全：所有用户 / LLM 文本先转义 HTML 特殊字符（& / < / >），
 * 再做 Markdown 替换；代码块内不再做行内替换，避免 ``` 内容被
 * 误解析为加粗 / 行内代码。
 *
 * 用法：
 *   import { renderMarkdown } from '../lib/markdown'
 *   const html = renderMarkdown(md)
 *   <div dangerouslySetInnerHTML={{ __html: html }} />
 */

/** HTML 特殊字符转义。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 行内 Markdown：加粗 + 行内代码。仅在非代码块行内调用。 */
function inline(text: string): string {
  let s = escapeHtml(text)
  // 加粗 **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
  return s
}

/**
 * 把 Markdown 文本渲染为 HTML 字符串。
 *
 * 围栏代码块（```lang ... ```）被渲染为 `<pre class="md-code-block"><code>...</code></pre>`，
 * 内部文本仅做 HTML 转义，不做任何 Markdown 替换，保留原始换行与缩进。
 *
 * 其余行按标题 / 列表 / 段落规则处理。
 */
export function renderMarkdown(md: string): string {
  if (!md) return '<p class="md-empty">（内容为空）</p>'

  const lines = md.split(/\r?\n/)
  const html: string[] = []
  let inUl = false
  let inOl = false
  // 围栏代码块状态：进入 ``` 后收集代码行，直到下一个 ```
  let inCodeBlock = false
  let codeLang = ''
  let codeBuf: string[] = []

  const closeLists = () => {
    if (inUl) {
      html.push('</ul>')
      inUl = false
    }
    if (inOl) {
      html.push('</ol>')
      inOl = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\s+$/, '')

    // 围栏代码块处理
    if (inCodeBlock) {
      // 检查是否是结束围栏 ```
      if (/^```+\s*$/.test(line)) {
        // 输出累积的代码块
        const code = escapeHtml(codeBuf.join('\n'))
        const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''
        html.push(
          `<pre class="md-code-block"${langAttr}><code>${code}</code></pre>`,
        )
        codeBuf = []
        codeLang = ''
        inCodeBlock = false
      } else {
        // 累积代码行（保留原始内容，包括缩进）
        codeBuf.push(raw)
      }
      continue
    }

    // 检查是否是开始围栏 ```lang
    const fenceMatch = /^```+(\w*)\s*$/.exec(line)
    if (fenceMatch) {
      closeLists()
      inCodeBlock = true
      codeLang = fenceMatch[1] || ''
      codeBuf = []
      continue
    }

    if (!line.trim()) {
      closeLists()
      continue
    }

    // 标题
    let m: RegExpMatchArray | null
    if ((m = /^###\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h3>${inline(m[1])}</h3>`)
    } else if ((m = /^##\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h2>${inline(m[1])}</h2>`)
    } else if ((m = /^#\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h1>${inline(m[1])}</h1>`)
    } else if ((m = /^\s*[-*]\s+(.+)$/.exec(line))) {
      // 无序列表
      if (!inUl) {
        closeLists()
        html.push('<ul>')
        inUl = true
      }
      html.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = /^\s*\d+\.\s+(.+)$/.exec(line))) {
      // 有序列表
      if (!inOl) {
        closeLists()
        html.push('<ol>')
        inOl = true
      }
      html.push(`<li>${inline(m[1])}</li>`)
    } else {
      // 普通段落
      closeLists()
      html.push(`<p>${inline(line)}</p>`)
    }
  }

  // 兜底：如果代码块未闭合（LLM 输出中断），仍输出已累积内容
  if (inCodeBlock && codeBuf.length > 0) {
    const code = escapeHtml(codeBuf.join('\n'))
    const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ''
    html.push(`<pre class="md-code-block"${langAttr}><code>${code}</code></pre>`)
  }

  closeLists()
  return html.join('\n')
}

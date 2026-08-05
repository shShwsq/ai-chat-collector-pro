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
 * 安全：所有用户 / LLM 文本先转义 HTML 特殊字符（& < > " ' /），
 * 再做 Markdown 替换；代码块内不再做行内替换，避免 ``` 内容被
 * 误解析为加粗 / 行内代码。
 *
 * 渲染完成后还会过一遍 :func:`sanitizeHtml`，剥离 ``<script>`` /
 * ``<iframe>`` / 事件处理器属性 / ``javascript:`` URL 等高风险构造，
 * 作为 LLM prompt 注入 / 逃逸攻击的纵深防御层。
 *
 * 用法：
 *   import { renderMarkdown } from '../lib/markdown'
 *   const html = renderMarkdown(md)
 *   <div dangerouslySetInnerHTML={{ __html: html }} />
 */

/** HTML 特殊字符转义（覆盖 OWASP 推荐的 5 类字符）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
}

/**
 * HTML sanitizer：剥离高风险标签与属性。
 *
 * 处理对象是 :func:`renderMarkdown` 的输出（已经过 escapeHtml），
 * 因此理论上不会出现裸标签；本函数作为纵深防御层，防止：
 *  1. 未来扩展 markdown 语法（如链接 ``[t](url)``、原始 HTML 块）引入漏洞；
 *  2. LLM 输出 ``</script>`` 字符串经任何路径逃逸到 ``<script>`` 上下文；
 *  3. 通过属性值注入 ``on*`` 事件处理器或 ``javascript:`` URL。
 *
 * 处理规则：
 *  - 移除 ``<script>...</script>`` / ``<style>...</style>`` / ``<iframe>`` /
 *    ``<object>`` / ``<embed>`` / ``<link>`` / ``<meta>`` 整块标签及其内容；
 *  - 移除所有 ``on\w+`` 开头的属性；
 *  - 把 ``javascript:`` / ``vbscript:`` 开头的 URL 改写为 ``about:blank``。
 */
function sanitizeHtml(html: string): string {
  let s = html
  // 移除危险整块标签及其内容（script / style / iframe / object / embed / link / meta）
  s = s.replace(
    /<(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  )
  // 移除自闭合形式的危险标签（iframe / object / embed / link / meta）
  s = s.replace(
    /<(iframe|object|embed|link|meta)\b[^>]*\/?>/gi,
    '',
  )
  // 移除 ``</script>`` 等孤立闭合标签（防止字符串拼接时逃逸出 script 上下文）
  s = s.replace(/<\/(script|style|iframe|object|embed|link|meta)\s*>/gi, '')
  // 移除所有 on* 事件处理器属性（onclick / onerror / onload 等）
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // 把 javascript: / vbscript: URL 改写为 about:blank
  s = s.replace(
    /(href|src)\s*=\s*("|')\s*(javascript|vbscript):/gi,
    '$1=$2about:blank',
  )
  return s
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
  // 纵深防御：剥离可能残留的 script / iframe / 事件处理器 / javascript: URL
  return sanitizeHtml(html.join('\n'))
}

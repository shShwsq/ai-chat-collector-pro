// lib/sanitize-html.js - Markdown 输出的 DOM 白名单清理
// 只接受 marked 生成的 HTML，不把原始字符串交给正则消毒。
const HtmlSanitizer = {
  allowedTags: new Set([
    'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HR', 'I', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUB', 'SUP',
    'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL', 'SPAN', 'DIV'
  ]),
  allowedAttributes: new Set(['class', 'title', 'target', 'rel', 'href', 'colspan', 'rowspan']),
  allowedProtocols: new Set(['http:', 'https:', 'mailto:']),

  sanitize(html) {
    if (!html || typeof DOMParser === 'undefined') return '';
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';
    this._sanitizeChildren(root);
    return root.innerHTML;
  },

  _sanitizeChildren(parent) {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node;
      // SVG/MathML 及其被 HTML parser 提升出来的子节点都不属于 HTML namespace。
      // 按 namespace 丢弃，避免只删外层标签后留下带危险属性的子节点。
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        element.remove();
        continue;
      }
      if (!this.allowedTags.has(element.tagName)) {
        if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.tagName === 'IFRAME' || element.tagName === 'OBJECT' || element.tagName === 'EMBED' || element.tagName === 'SVG' || element.tagName === 'MATH') {
          element.remove();
          continue;
        }
        while (element.firstChild) parent.insertBefore(element.firstChild, element);
        element.remove();
        continue;
      }
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || !this.allowedAttributes.has(name)) {
          element.removeAttribute(attr.name);
        }
      }
      if (element.hasAttribute('href')) {
        const href = element.getAttribute('href').trim();
        let valid = false;
        try { valid = this.allowedProtocols.has(new URL(href, document.baseURI).protocol) && !href.toLowerCase().startsWith('javascript:'); } catch (_) { valid = false; }
        if (!valid) element.setAttribute('href', '#');
        if (element.tagName === 'A') {
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      }
      this._sanitizeChildren(element);
    }
  }
};

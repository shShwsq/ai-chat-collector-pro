// dom/katex-html-to-latex.js - KaTeX 渲染 HTML → LaTeX 源码反向解析器
//
// 适用场景：部分平台（如 Kimi）主动移除了 KaTeX 标准的 <annotation> 可访问性层，
// 仅保留 .katex-html 视觉渲染层，导致无法直接提取原始 LaTeX 源码。
// 本模块递归解析 .katex-html 的 DOM 结构，重建等价 LaTeX 字符串。
//
// 依赖：无（纯 DOM 解析）
// 挂载：window.KatexHtmlToLatex
// 入口：window.KatexHtmlToLatex.convert(katexHtmlEl)
//
// 支持的 KaTeX 结构（覆盖常见数学公式）：
//   - 普通字符 .mord / .mord.mathnormal（变量、常量）
//   - 操作符 .mop（∫→\int, ∑→\sum, ×→\times 等，查 OP_MAP 表）
//   - 括号 .mopen / .mclose（.nulldelimiter 为不可见占位，不输出）
//   - 二元运算符 .mbin（+, −）
//   - 关系符 .mrel（=, <, >, ≤, ≥, ≠）
//   - 标点 .mpunct
//   - 上下标 .msupsub（通过 vlist 的 top 值判断上标/下标）
//   - 分数 .mfrac
//   - 根号 .mord.sqrt（\sqrt{} 和 \sqrt[n]{}，通过 .root 子元素区分）
//   - 间隔 .mspace（忽略）
//   - 布局占位 .strut（忽略）
//
// 限制：
//   - 矩阵 .mtable 仅取文本拼接，不重建 \begin{matrix} 结构
//   - 复杂嵌套（如 \underbrace, \overbrace）降级为 textContent
//   - 解析失败时降级返回 textContent，保证不中断导出流程
(function () {
  'use strict';

  // 操作符符号 → LaTeX 命令映射表
  // KaTeX 渲染的操作符文本（如 ∫）需映射回 LaTeX 命令（如 \int）
  var OP_MAP = {
    '∫': '\\int',
    '∬': '\\iint',
    '∭': '\\iiint',
    '∮': '\\oint',
    '∑': '\\sum',
    '∏': '\\prod',
    '∐': '\\coprod',
    '⋃': '\\bigcup',
    '⋂': '\\bigcap',
    '⊕': '\\oplus',
    '⊗': '\\otimes',
    '⊙': '\\odot',
    '×': '\\times',
    '÷': '\\div',
    '±': '\\pm',
    '∓': '\\mp',
    '∞': '\\infty',
    '∂': '\\partial',
    '∇': '\\nabla',
    '∈': '\\in',
    '∉': '\\notin',
    '∋': '\\ni',
    '⊂': '\\subset',
    '⊃': '\\supset',
    '⊆': '\\subseteq',
    '⊇': '\\supseteq',
    '∪': '\\cup',
    '∩': '\\cap',
    '∅': '\\emptyset',
    '∀': '\\forall',
    '∃': '\\exists',
    '¬': '\\neg',
    '∧': '\\wedge',
    '∨': '\\vee',
    '→': '\\to',
    '←': '\\gets',
    '↔': '\\leftrightarrow',
    '⇒': '\\Rightarrow',
    '⇐': '\\Leftarrow',
    '⇔': '\\Leftrightarrow',
    '↦': '\\mapsto',
    '⇌': '\\rightleftharpoons',
    '↑': '\\uparrow',
    '↓': '\\downarrow',
    '≤': '\\leq',
    '≥': '\\geq',
    '≠': '\\neq',
    '≈': '\\approx',
    '≡': '\\equiv',
    '∼': '\\sim',
    '≃': '\\simeq',
    '≅': '\\cong',
    '∝': '\\propto',
    '·': '\\cdot',
    '…': '\\dots',
    '⋯': '\\cdots',
    '⋮': '\\vdots',
    '⋱': '\\ddots',
    'α': '\\alpha',
    'β': '\\beta',
    'γ': '\\gamma',
    'δ': '\\delta',
    'ε': '\\epsilon',
    'ζ': '\\zeta',
    'η': '\\eta',
    'θ': '\\theta',
    'λ': '\\lambda',
    'μ': '\\mu',
    'ν': '\\nu',
    'ξ': '\\xi',
    'π': '\\pi',
    'ρ': '\\rho',
    'σ': '\\sigma',
    'τ': '\\tau',
    'φ': '\\phi',
    'χ': '\\chi',
    'ψ': '\\psi',
    'ω': '\\omega',
    'Γ': '\\Gamma',
    'Δ': '\\Delta',
    'Θ': '\\Theta',
    'Λ': '\\Lambda',
    'Ξ': '\\Xi',
    'Π': '\\Pi',
    'Σ': '\\Sigma',
    'Φ': '\\Phi',
    'Ψ': '\\Psi',
    'Ω': '\\Omega',
    'ℕ': '\\mathbb{N}',
    'ℤ': '\\mathbb{Z}',
    'ℚ': '\\mathbb{Q}',
    'ℝ': '\\mathbb{R}',
    'ℂ': '\\mathbb{C}',
    'ℵ': '\\aleph',
    '∘': '\\circ',
    '′': "'",
    '″': "''",
    '‴': "'''",
    '°': '^\\circ',
    '∠': '\\angle',
    '⊥': '\\perp',
    '∥': '\\parallel',
    '√': '\\surd'
  };

  // 上标/下标判断阈值
  // KaTeX vlist 中，上标 top 值通常 < -2em（如 -3.063em），下标 top 值 > -1.5em
  var SUP_THRESHOLD = -1.8;

  var KatexHtmlToLatex = {
    // 主入口：将 .katex-html 元素转换为 LaTeX 字符串
    // @param {Element} katexHtmlEl - .katex-html DOM 元素
    // @return {string} LaTeX 源码
    convert: function (katexHtmlEl) {
      try {
        // .katex-html 下可能有多个 .base（如 = 号分隔的左右表达式）
        var bases = katexHtmlEl.querySelectorAll(':scope > .base');
        var result = '';
        for (var i = 0; i < bases.length; i++) {
          result += this._processChildren(bases[i]);
        }
        // 压缩连续多空格为单个（.mspace 与 .mbin/.mrel 的空格会叠加）
        // 移除零宽空格 U+200B（KaTeX 布局元素可能残留，导致 KaTeX 重新渲染时报 unknownSymbol 警告）
        return result.replace(/ {2,}/g, ' ').replace(/\u200b/g, '').trim();
      } catch (e) {
        console.warn('[KatexHtmlToLatex] 解析失败，降级为 textContent:', e);
        return katexHtmlEl.textContent.trim();
      }
    },

    // 处理一个元素的所有子节点，拼接结果
    _processChildren: function (el) {
      var result = '';
      var children = el.children;
      for (var i = 0; i < children.length; i++) {
        var token = this._processNode(children[i]);
        // LaTeX 命令（\xxx）后紧跟字母时插入空格，避免命令名粘连
        // 如 \partial + x → \partial x（否则 \partialx 是未定义命令）
        if (token && /\\[a-zA-Z]+$/.test(result) && /^[a-zA-Z]/.test(token)) {
          result += ' ';
        }
        result += token;
      }
      return result;
    },

    // 处理单个节点，根据 class 分派
    _processNode: function (node) {
      var cls = node.getAttribute('class') || '';

      // 布局占位（strut）和间隔（mspace）忽略
      if (/\bstrut\b/.test(cls)) return '';
      if (/\bmspace\b/.test(cls)) return ' ';
      if (/\bpstrut\b/.test(cls)) return '';
      // .vlist-s 是 KaTeX vlist 的间距占位，textContent 为零宽空格 U+200B，不能进入输出
      if (/\bvlist-s\b/.test(cls)) return '';

      // 上下标容器
      if (/\bmsupsub\b/.test(cls)) {
        return this._processSupSub(node);
      }

      // 分数
      if (/\bmfrac\b/.test(cls)) {
        return this._processFrac(node);
      }

      // 根号（KaTeX 0.16+ 输出 class="mord sqrt"，含可选 .root 子元素表示根指数）
      if (/\bsqrt\b/.test(cls)) {
        return this._processSqrt(node);
      }

      // 矩阵/表格（简化处理：逐格拼接）
      if (/\bmtable\b/.test(cls)) {
        return this._processMtable(node);
      }

      // 操作符带上下限（\sum、\lim、\prod 等）
      // KaTeX 对这类"limits"型操作符在 inline 模式下用 vlist 上下排列（非 msupsub），
      // 操作符符号本身也在 vlist 中间，需区分操作符 entry 和下标/上标 entry
      if (/\bop-limits\b/.test(cls)) {
        return this._processOpLimits(node);
      }

      // 操作符（∫ ∑ 等，需查表）
      if (/\bmop\b/.test(cls)) {
        return this._processOp(node);
      }

      // 括号
      if (/\bmopen\b/.test(cls)) {
        // nulldelimiter 是不可见分隔符（如 \frac 两侧的空占位），不输出
        if (/\bnulldelimiter\b/.test(cls)) return '';
        return '(';
      }
      if (/\bmclose\b/.test(cls)) {
        if (/\bnulldelimiter\b/.test(cls)) return '';
        // mclose 可能带上下标（如 )^2），先取括号再处理 msupsub
        var closeText = ')';
        var supsub = node.querySelector(':scope > .msupsub');
        if (supsub) {
          closeText += this._processSupSub(supsub);
        }
        return closeText;
      }

      // 二元运算符（+ − × ÷ 等）
      // 查 OP_MAP：× → \times、÷ → \div、± → \pm 等
      if (/\bmbin\b/.test(cls)) {
        return ' ' + this._textWithOpMap(node) + ' ';
      }

      // 关系符（= < > ≤ ≥ ≠）
      // 查 OP_MAP：≤ → \leq、≥ → \geq、≠ → \neq 等
      if (/\bmrel\b/.test(cls)) {
        return ' ' + this._textWithOpMap(node) + ' ';
      }

      // 标点
      // 查 OP_MAP：… → \dots 等
      if (/\bmpunct\b/.test(cls)) {
        return this._textWithOpMap(node) + ' ';
      }

      // 普通字符 .mord（可能是叶子，也可能嵌套，如 .mord > .mord.mathnormal + .msupsub）
      if (/\bmord\b/.test(cls)) {
        return this._processMord(node);
      }

      // 其他未识别类型：递归处理子节点，或叶子节点查 OP_MAP
      if (node.children.length > 0) {
        return this._processChildren(node);
      }
      return this._textWithOpMap(node);
    },

    // 处理 .mord 节点
    // .mord 可能是叶子（如 .mord.mathnormal "e"），也可能嵌套（.mord > .mord.mathnormal + .msupsub）
    _processMord: function (node) {
      // 如果是叶子节点（无子元素），查 OP_MAP 后取文本
      if (node.children.length === 0) {
        return this._textWithOpMap(node);
      }
      // 嵌套：递归处理子节点（会处理内部的 .mathnormal 和 .msupsub）
      return this._processChildren(node);
    },

    // 处理操作符 .mop
    // 叶子 .mop（如 <span class="mop">∫</span>）直接查 OP_MAP
    // 嵌套 .mop（如积分/求和带上下限：<span class="mop">
    //   <span class="mop op-symbol large-op">∫</span><span class="msupsub">...</span>
    // </span>）需递归处理子元素，分别提取操作符符号和上下限
    _processOp: function (node) {
      if (node.children.length > 0) {
        return this._processChildren(node);
      }
      return this._textWithOpMap(node);
    },

    // 处理 .mop.op-limits（\sum、\lim、\prod 等"limits"型操作符）
    // KaTeX 对这类操作符在 inline 模式下用 vlist 上下排列：
    //   .mop.op-limits > .vlist-t > .vlist-r > .vlist > span[style="top:Xem"]
    // 每个 entry 含 .pstrut（忽略）+ 内容。其中含 .mop 子元素的是操作符符号，
    // top 值更大（更接近 0）的是下标（在操作符下方），top 值更小（更负）的是上标（在操作符上方）
    _processOpLimits: function (node) {
      var topSpans = this._findDirectTopSpans(node);
      var entries = [];
      for (var i = 0; i < topSpans.length; i++) {
        var span = topSpans[i];
        var style = span.getAttribute('style') || '';
        var topMatch = style.match(/top:\s*(-?[\d.]+)em/);
        if (!topMatch) continue;
        var topVal = parseFloat(topMatch[1]);
        var contentParts = [];
        var children = span.children;
        var hasMop = false;
        for (var j = 0; j < children.length; j++) {
          var child = children[j];
          var childCls = child.getAttribute('class') || '';
          if (/\bpstrut\b/.test(childCls)) continue;
          // 检查内容是否含 .mop（操作符符号 entry）
          if (/\bmop\b/.test(childCls) || child.querySelector('.mop')) {
            hasMop = true;
          }
          contentParts.push(this._processNode(child));
        }
        entries.push({
          top: topVal,
          text: contentParts.join('').trim(),
          isOperator: hasMop
        });
      }

      // 找操作符 entry
      var operatorEntry = null;
      for (var k = 0; k < entries.length; k++) {
        if (entries[k].isOperator) {
          operatorEntry = entries[k];
          break;
        }
      }
      if (!operatorEntry) {
        // 未找到操作符 entry，降级为递归处理子节点
        return this._processChildren(node);
      }

      // 操作符在前，下标/上标在后：\sum_{k=1}^{\infty}
      var result = operatorEntry.text;
      for (var m = 0; m < entries.length; m++) {
        if (entries[m] === operatorEntry) continue;
        if (entries[m].top > operatorEntry.top) {
          // top 更大（更接近 0）→ 下标（在操作符下方）
          result += '_{' + entries[m].text + '}';
        } else {
          // top 更小（更负）→ 上标（在操作符上方）
          result += '^{' + entries[m].text + '}';
        }
      }
      return result;
    },

    // 取节点文本并查 OP_MAP（将 ∫ → \int、′ → ' 等符号映射为 LaTeX 命令）
    _textWithOpMap: function (node) {
      var text = node.textContent.trim();
      if (OP_MAP[text]) {
        return OP_MAP[text];
      }
      return text;
    },

    // 在元素直接子层级的 vlist 中查找带 top 样式的 span
    // 避免 querySelectorAll('.vlist > span[style*="top:"]') 递归进入嵌套结构
    // （如 \frac{\frac{1}{2}}{3} 的内层 mfrac，或 x^{y^2} 的内层 msupsub）
    // 方案：querySelector('.vlist') 返回文档顺序第一个 vlist（即外层），
    //       再用 :scope > 限定只取其直接子 span，不递归
    _findDirectTopSpans: function (containerEl) {
      var vlist = containerEl.querySelector('.vlist');
      if (!vlist) return [];
      return vlist.querySelectorAll(':scope > span[style*="top:"]');
    },

    // 处理上下标 .msupsub
    // 结构：.msupsub > .vlist-t > .vlist-r > .vlist > span[style="top:Xem"] > .pstrut + .sizing/.mord
    // 判断：top < SUP_THRESHOLD 为上标(^)，否则为下标(_)
    _processSupSub: function (supsubEl) {
      var self = this;
      var entries = [];
      // 只取当前 msupsub 直接子层级的 vlist 中的 span，不递归进入嵌套 msupsub
      var topSpans = this._findDirectTopSpans(supsubEl);
      for (var i = 0; i < topSpans.length; i++) {
        var span = topSpans[i];
        var style = span.getAttribute('style') || '';
        var topMatch = style.match(/top:\s*(-?[\d.]+)em/);
        if (!topMatch) continue;
        var topVal = parseFloat(topMatch[1]);
        // 内容在 .pstrut 之后的兄弟元素（.sizing 或直接 .mord/.mop）
        // 跳过 .pstrut，取其余子节点的内容
        var contentParts = [];
        var children = span.children;
        for (var j = 0; j < children.length; j++) {
          var child = children[j];
          var childCls = child.getAttribute('class') || '';
          if (/\bpstrut\b/.test(childCls)) continue;
          contentParts.push(this._processNode(child));
        }
        var contentText = contentParts.join('').trim();
        if (contentText) {
          entries.push({ top: topVal, text: contentText });
        }
      }

      if (entries.length === 0) return '';

      // 按 top 值排序（从小到大，最负的在前）
      entries.sort(function (a, b) { return a.top - b.top; });

      var result = '';
      if (entries.length === 1) {
        // 单个：根据 top 值判断上标或下标
        if (entries[0].top < SUP_THRESHOLD) {
          // 导数符号 ' 直接输出，不包裹 ^{}（LaTeX 中 x' 等价于 x^\prime）
          if (entries[0].text === "'") {
            result = "'";
          } else {
            result = '^{' + entries[0].text + '}';
          }
        } else {
          result = '_{' + entries[0].text + '}';
        }
      } else {
        // 多个：最负的是上标，其次为下标
        // 上标（top 最小）
        result = '^{' + entries[0].text + '}';
        // 下标（top 第二小，如果有）
        if (entries.length >= 2) {
          result = '_{' + entries[1].text + '}' + result;
        }
      }
      return result;
    },

    // 处理分数 .mfrac
    // 结构：.mfrac > .vlist-t > .vlist-r > .vlist
    //   分子：span[style="top:-Xem"] > .pstrut + 内容
    //   分母：span[style="top:Yem"] > .pstrut + 内容
    _processFrac: function (fracEl) {
      var entries = [];
      // 只取当前 mfrac 直接子层级的 vlist 中的 span，不递归进入嵌套 mfrac 的内层 vlist
      var topSpans = this._findDirectTopSpans(fracEl);
      for (var i = 0; i < topSpans.length; i++) {
        var span = topSpans[i];
        var style = span.getAttribute('style') || '';
        var topMatch = style.match(/top:\s*(-?[\d.]+)em/);
        if (!topMatch) continue;
        var topVal = parseFloat(topMatch[1]);
        var contentParts = [];
        var children = span.children;
        for (var j = 0; j < children.length; j++) {
          var child = children[j];
          var childCls = child.getAttribute('class') || '';
          if (/\bpstrut\b/.test(childCls)) continue;
          contentParts.push(this._processNode(child));
        }
        entries.push({ top: topVal, text: contentParts.join('').trim() });
      }
      if (entries.length < 2) {
        return this._nodeText(fracEl);
      }
      // 分子 top 最负（在最上方），分母 top 较大（在最下方）
      entries.sort(function (a, b) { return a.top - b.top; });
      return '\\frac{' + entries[0].text + '}{' + entries[entries.length - 1].text + '}';
    },

    // 处理根号 .mord.sqrt（KaTeX 0.16+ 实际输出 class="mord sqrt"）
    // 结构：
    //   <span class="mord sqrt">
    //     <span class="root">...根指数...</span>  <!-- 仅 \sqrt[n]{...} 有此元素 -->
    //     <span class="vlist-t vlist-t2">
    //       <span class="vlist-r"><span class="vlist">
    //         <span class="svg-align" style="top:..."><span class="pstrut"></span><span class="mord" style="padding-left:...">...被开方数...</span></span>
    //         <span style="top:..."><span class="pstrut"></span><span class="hide-tail"><svg>...</svg></span></span>
    //       </span></span>
    //     </span>
    //   </span>
    _processSqrt: function (sqrtEl) {
      // 查找根指数（仅 \sqrt[n]{...} 有 .root 子元素）
      var rootEl = sqrtEl.querySelector(':scope > .root');
      var rootIndex = '';
      if (rootEl) {
        rootIndex = this._processChildren(rootEl).trim();
      }

      // 查找被开方数：.svg-align 下的直接子 .mord（带 padding-left 样式）
      var radicandEl = sqrtEl.querySelector('.svg-align > .mord');
      var radicand = '';
      if (radicandEl) {
        radicand = this._processMord(radicandEl);
      } else {
        // 降级：处理所有子节点（排除 .root），移除根号符号 √
        var content = '';
        var children = sqrtEl.children;
        for (var i = 0; i < children.length; i++) {
          var childCls = children[i].getAttribute('class') || '';
          if (/\broot\b/.test(childCls)) continue;
          content += this._processNode(children[i]);
        }
        radicand = content.replace(/√/g, '').trim();
      }

      if (rootIndex) {
        return '\\sqrt[' + rootIndex + ']{' + radicand + '}';
      }
      return '\\sqrt{' + radicand + '}';
    },

    // 处理矩阵/表格 .mtable（简化：逐行逐格拼接）
    _processMtable: function (tableEl) {
      var rows = tableEl.querySelectorAll('.mtr');
      var rowTexts = [];
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll('.mtd');
        var cellTexts = [];
        for (var j = 0; j < cells.length; j++) {
          cellTexts.push(this._processChildren(cells[j]).trim());
        }
        rowTexts.push(cellTexts.join(' & '));
      }
      return '\\begin{matrix}' + rowTexts.join(' \\\\ ') + '\\end{matrix}';
    },

    // 取节点的文本内容（递归所有文本节点）
    _nodeText: function (node) {
      return node.textContent.trim();
    }
  };

  window.KatexHtmlToLatex = KatexHtmlToLatex;
})();

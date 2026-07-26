// content/dom/html-to-markdown.js
// 统一 HTML → Markdown 转换封装，基于 turndown.js v7.2.4 + turndown-plugin-gfm v1.0.2
//
// 依赖：lib/turndown.min.js（需在之前加载，暴露全局 TurndownService）
//      lib/turndown-plugin-gfm.js（需在之前加载，暴露全局 turndownPluginGfm）
//
// 各平台 DOM 适配器通过 window.HtmlToMarkdown.convert(el) 调用，
// 将渲染后的 HTML 容器（.markdown / .segment-content-box 等）转为 Markdown 文本。
//
// 自定义规则：
//   - <div class="paragraph"> 视作 <p> 段落
//   - 移除噪声：svg、.iconify、按钮、操作栏、引用标签等
//   - GFM 插件提供表格/删除线/任务列表/高亮代码块支持

(function () {
  'use strict';

  if (typeof TurndownService === 'undefined') {
    console.warn('[HtmlToMarkdown] TurndownService 未加载，转换将降级为 textContent');
    window.HtmlToMarkdown = {
      convert: function (el) {
        if (!el) return '';
        return el.textContent.trim();
      }
    };
    return;
  }

  var turndownService = new TurndownService({
    headingStyle: 'atx',         // # 风格标题（非 setext === 风格）
    hr: '---',
    bulletListMarker: '-',       // 无序列表用 -
    codeBlockStyle: 'fenced',    // ``` 围栏代码块
    fence: '```',
    emDelimiter: '*',            // *斜体*
    strongDelimiter: '**',       // **粗体**
    linkStyle: 'inlined',        // [text](url) 内联链接
    br: '  ',
    preformattedCode: false
  });

  // 启用 GFM 插件：表格 / 删除线 / 任务列表 / 高亮代码块
  // turndown v7.2.4 默认不转换 <table>，需 GFM 插件支持
  if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) {
    turndownService.use(turndownPluginGfm.gfm);
  } else {
    console.warn('[HtmlToMarkdown] turndownPluginGfm 未加载，表格将不被转换');
  }

  // 自定义规则：<div class="paragraph"> → 段落
  // Kimi 等平台用 div.paragraph 代替 <p>，turndown 默认将 div 视作块级（仅加换行），
  // 这里显式按段落处理，确保段落间有 \n\n 分隔
  turndownService.addRule('paragraphDiv', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bparagraph\b/.test(node.getAttribute('class'));
    },
    replacement: function (content) {
      return '\n\n' + content + '\n\n';
    }
  });

  // 自定义规则：千问 <div class="qk-md-paragraph"> → 段落
  // 千问用 div.qk-md-paragraph 代替 <p>，需同样按段落处理
  turndownService.addRule('qkMdParagraphDiv', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bqk-md-paragraph\b/.test(node.getAttribute('class'));
    },
    replacement: function (content) {
      return '\n\n' + content + '\n\n';
    }
  });

  // 自定义规则：豆包 <div class="container-enLQFx"> → 段落
  // 豆包用 div.container-enLQFx 作为段落容器（div 而非 p）
  turndownService.addRule('doubaoParagraphDiv', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bcontainer-enLQFx\b/.test(node.getAttribute('class'));
    },
    replacement: function (content) {
      return '\n\n' + content + '\n\n';
    }
  });

  // 自定义规则：DeepSeek 代码块
  // 结构：<div class="md-code-block"><div class="md-code-block-banner-wrap">...<span>bash</span>...复制/下载按钮...</div><pre>code</pre></div>
  // 问题：turndown 默认 codeBlock 规则不提取语言（语言在 banner 而非 <code class="language-xxx">），
  //       且 banner 中"复制""下载"按钮文字（<div role="button">，非 <button>）会泄漏到代码内容前
  // 方案：匹配 md-code-block 容器，从 banner 提取语言，从 <pre> 提取代码，输出带语言的围栏代码块
  turndownService.addRule('deepseekCodeBlock', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bmd-code-block\b/.test(node.getAttribute('class'));
    },
    replacement: function (content, node) {
      // 语言标记在 banner 内第一个 span（如 <span class="d813de27">bash</span>）
      var lang = '';
      var banner = node.querySelector('.md-code-block-banner-wrap');
      if (banner) {
        var langSpan = banner.querySelector('span');
        if (langSpan) {
          lang = langSpan.textContent.trim();
        }
      }
      // 代码在 <pre> 内（PrismJS token span 的 textContent 即原始代码）
      var pre = node.querySelector('pre');
      var code = pre ? pre.textContent : '';
      code = code.replace(/^\n+|\n+$/g, '');
      return '\n\n```' + lang + '\n' + code + '\n```\n\n';
    }
  });

  // 自定义规则：千问代码块
  // 结构：<div class="qw-md-code">
  //   <div class="h-[36px]..."><span class="font-medium mr-auto...">python</span><button>编辑/复制/...</button></div>
  //   <div class="codeHighlighterWrapper-..."><pre><code>...行号 span + token span...</code></pre></div>
  // </div>
  // 问题：与 DeepSeek 类似，语言在标题栏 span 而非 <code class="language-xxx">；
  //       标题栏"编辑"文字会泄漏；行号 span（.react-syntax-highlighter-line-number）会混入代码内容（如 "1print(...)"）
  // 方案：匹配 qw-md-code 容器，从标题栏 span 提取语言，从 <pre> 克隆并移除行号后提取代码
  turndownService.addRule('qianwenCodeBlock', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bqw-md-code\b/.test(node.getAttribute('class'));
    },
    replacement: function (content, node) {
      // 语言标记在标题栏的 span（class 含 mr-auto，用于将按钮推到右侧，是语言标签的稳定标识）
      var lang = '';
      var langSpan = node.querySelector('span.mr-auto, span.font-medium');
      if (langSpan) {
        lang = langSpan.textContent.trim();
      }
      // 代码在 <pre> 内，需先克隆并移除行号 span，避免行号混入代码内容
      var pre = node.querySelector('pre');
      if (!pre) return '\n\n';
      var preClone = pre.cloneNode(true);
      preClone.querySelectorAll(
        '.react-syntax-highlighter-line-number, .linenumber, [class*="linenumber"]'
      ).forEach(function (n) { n.remove(); });
      var code = preClone.textContent;
      code = code.replace(/^\n+|\n+$/g, '');
      return '\n\n```' + lang + '\n' + code + '\n```\n\n';
    }
  });

  // 自定义规则：豆包代码块
  // 结构：<div class="code-block-element-R6c8c0 ...">
  //   <div class="code-area-yxsM36 code-area">
  //     <div class="header-wrapper-Mbk8s6" data-copy-ignore="true">  ← 标题栏（语言标签 + 运行/复制按钮，需整体跳过）
  //       <div class="header-IAeXdE">
  //         <div class="title-TXcgFG"><div class="text-OkYU_0">bash</div>...</div>
  //         <div class="action-ysQCxz">运行/复制按钮</div>
  //       </div>
  //     </div>
  //     <div class="content-y8qlFa code-content"><pre class="... language-bash"><code class="language-bash">...</code></pre></div>
  //   </div>
  // </div>
  // 问题：turndown 默认 codeBlock 规则会遍历 <pre> 之前的兄弟节点（.header-wrapper），
  //       将"bash"语言标签和"运行"按钮文字当作正文段落输出到代码块前
  // 方案：匹配 code-block-element-* 容器（正则兼容哈希后缀），从 <pre> 提取代码
  //       语言优先从 <code class="language-xxx"> 提取（标准 PrismJS 约定，无哈希最稳定），
  //       标题栏文本仅作兜底（class 含哈希可能变化，用 [data-copy-ignore] 定位标题栏更稳健）
  turndownService.addRule('doubaoCodeBlock', {
    filter: function (node) {
      return node.nodeName === 'DIV' &&
             node.getAttribute('class') &&
             /\bcode-block-element-\w+\b/.test(node.getAttribute('class'));
    },
    replacement: function (content, node) {
      var pre = node.querySelector('pre');
      if (!pre) return '\n\n';
      var code = pre.textContent || '';
      code = code.replace(/^\n+|\n+$/g, '');

      // 语言提取（优先级：code.language-xxx > pre.language-xxx > 标题栏文本）
      var lang = '';
      var codeEl = pre.querySelector('code');
      if (codeEl) {
        var m = codeEl.className.match(/language-(\S+)/);
        if (m) lang = m[1];
      }
      if (!lang) {
        var m2 = pre.className.match(/language-(\S+)/);
        if (m2) lang = m2[1];
      }
      if (!lang) {
        // 兜底：从标题栏第一个文本节点提取（不依赖具体哈希 class）
        // 标题栏由 [data-copy-ignore] 标识，其内首个非空文本即语言标签
        var header = node.querySelector('[data-copy-ignore="true"]');
        if (header) {
          var titleEl = header.querySelector('[class*="title"]');
          if (titleEl) {
            // 取 title 容器内第一个文本节点的值（排除下拉图标 .icon-*）
            var langText = '';
            for (var i = 0; i < titleEl.childNodes.length; i++) {
              var cn = titleEl.childNodes[i];
              if (cn.nodeType === 3 && cn.textContent.trim()) { // 文本节点
                langText = cn.textContent.trim();
                break;
              }
              if (cn.nodeType === 1) { // 元素节点
                var cls = cn.getAttribute('class') || '';
                if (/\bicon\b/.test(cls)) continue; // 跳过下拉图标
                langText = cn.textContent.trim();
                if (langText) break;
              }
            }
            lang = langText;
          }
        }
      }
      return '\n\n```' + lang + '\n' + code + '\n```\n\n';
    }
  });

  // 自定义规则：KaTeX 行内公式
  // 标准结构：<span class="katex"><span class="katex-mathml"><math>...<annotation encoding="application/x-tex">LATEX</annotation></math></span><span class="katex-html">...</span></span>
  // 降级结构（Kimi 等）：仅有 .katex-html，无 <annotation>，调用 KatexHtmlToLatex 反向解析
  // 输出 $...$
  turndownService.addRule('katexInline', {
    filter: function (node) {
      if (node.nodeName !== 'SPAN') return false;
      var cls = node.getAttribute('class');
      if (!cls || !/\bkatex\b/.test(cls)) return false;
      // 排除被 .katex-display 包裹的情况（由 katexDisplay 规则统一处理）
      var parent = node.parentNode;
      if (parent && parent.getAttribute && parent.getAttribute('class') &&
          /\bkatex-display\b/.test(parent.getAttribute('class'))) {
        return false;
      }
      return true;
    },
    replacement: function (content, node) {
      var latex = HtmlToMarkdown._extractKatexLatex(node);
      return '$' + latex + '$';
    }
  });

  // 自定义规则：KaTeX 块级公式
  // 结构：<span class="katex-display [ds-markdown-math]"><span class="katex">...</span></span>
  // 输出 $$...$$，前后加空行确保 Markdown 块级渲染
  turndownService.addRule('katexDisplay', {
    filter: function (node) {
      return node.nodeName === 'SPAN' &&
             node.getAttribute('class') &&
             /\bkatex-display\b/.test(node.getAttribute('class'));
    },
    replacement: function (content, node) {
      var latex = HtmlToMarkdown._extractKatexLatex(node);
      return '\n\n$$' + latex + '$$\n\n';
    }
  });

  // 噪声元素选择器：转换前从克隆节点中移除
  var NOISE_SELECTORS = [
    'svg',
    '.iconify',
    'style',
    'script',
    'button',
    '.segment-assistant-actions',
    '.segment-user-action-row',
    '[class*="action"]',
    '[class*="toolbar"]',
    '.pua-ref-renderer',
    '.pua-ref-cite-tag',
    '.toolcall-title-container',
    '.thinking-container',
    // DeepSeek 引用图标容器（含 SVG 和隐藏的占位字符，引用编号在相邻的 .ds-markdown-cite 中）
    '._2ed5dee',
    // KaTeX MathML 层（含 <annotation> 原始 LaTeX 源码）
    // 源码已由 convert() 预提取到 .katex 的 data-latex-source 属性，此处安全移除，
    // 避免 <math> 标签内容被 turndown 作为普通文本重复渲染
    '.katex-mathml',
    // 千问搜索结果摘要（嵌套在思考内容中，显示"参考了N篇结果"）
    '[class*="search-wrapper"]',
    // 复旦搜索来源卡片和头像/复制按钮
    '.networking_card',
    '.headImgLeft',
    '.headImgRight',
    '.question_copy_icon',
    '.robot_name',
    '.iconfont',
    // 豆包操作栏、推荐问题、搜索结果块
    '[data-foundation-type="receive-message-action-bar"]',
    '[data-foundation-type="send-message-action-bar"]',
    '[data-foundation-type="receive-message-suggest-foundation"]',
    '[data-plugin-identifier*="block_type:10025"]',
    '[data-plugin-identifier*="block_type:10050"]',
    // 千问视频/文章推荐卡片（回答末尾的相关内容推荐，含缩略图+标题+作者，非回答正文）
    '[data-tpl*="card_video"]',
    // 千问搜索来源按钮（"N篇来源" + 站点图标，无实际 URL，点击才展开）
    '.reference-wrap-iEjeb3',
    // 千问推荐问题（回答结束后"猜你想问"）
    '.recommend-query-wrap',
    // 千问代码块行号（react-syntax-highlighter 行号 span，嵌在 <code> 内每行开头，
    // 兜底保护：若 qw-md-code 容器结构变化，行号也不会混入代码内容）
    '.react-syntax-highlighter-line-number',
    '.linenumber',
    // Kimi 代码块标题栏（含语言标签 .segment-code-lang 和复制按钮 .kimi-tooltip），
    // 与 <pre> 分属 .segment-code 下平级的 header 和 content 容器，移除后不影响代码提取
    '.segment-code-header'
  ];

  window.HtmlToMarkdown = {
    /**
     * 将 DOM 元素转换为 Markdown 文本
     * @param {Element} el - 要转换的 DOM 元素（如 .markdown 容器）
     * @returns {string} Markdown 文本
     */
    convert: function (el) {
      if (!el) return '';

      // 克隆后移除噪声元素，避免影响原文
      var clone = el.cloneNode(true);

      // 预提取 KaTeX 源码到 data 属性
      // 必须在移除 .katex-mathml（NOISE_SELECTORS）之前执行，按优先级提取原始 LaTeX：
      //   1. <annotation encoding="application/x-tex">（标准平台 + 豆包块级公式）
      //   2. 祖先元素的 copy-text 属性（豆包行内公式，LaTeX 存在父容器而非 annotation）
      // 无上述源的节点（如 Kimi）不设置 data 属性，自动降级到 katex-html 反向解析。
      var katexNodes = clone.querySelectorAll('.katex');
      katexNodes.forEach(function (katexNode) {
        var latex = HtmlToMarkdown._extractRawLatex(katexNode);
        if (latex) {
          katexNode.setAttribute('data-latex-source', latex);
        }
      });

      for (var i = 0; i < NOISE_SELECTORS.length; i++) {
        var nodes = clone.querySelectorAll(NOISE_SELECTORS[i]);
        nodes.forEach(function (n) { n.remove(); });
      }

      // 使用 turndown 转换
      var markdown = turndownService.turndown(clone);

      // 清理：多个连续空行合并为单个，去除首尾空白
      markdown = markdown
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/g, '');

      return markdown;
    },

    // 从 KaTeX 节点提取原始 LaTeX 源码（无损路径，不含反向解析）
    // 供 convert() 预提取和 _extractKatexLatex 路径 B 共用，按优先级尝试：
    //   1. <annotation encoding="application/x-tex">（标准 KaTeX 结构）
    //   2. 祖先元素的 copy-text 属性（豆包行内公式：LaTeX 存在父容器 math-inline 的
    //      copy-text 属性中，用 \(...\) 或 \[...\] 定界符包裹，katex 节点无 annotation）
    // 返回空字符串表示无无损源可用，调用方应降级到反向解析
    _extractRawLatex: function (katexNode) {
      // 优先路径 1：标准 <annotation>
      var ann = katexNode.querySelector('annotation[encoding="application/x-tex"]');
      if (ann && ann.textContent) {
        return ann.textContent;
      }

      // 优先路径 2：祖先元素的 copy-text 属性（豆包行内公式）
      // copy-text 在 .katex 的父元素（如 .math-inline 容器）上，用 closest 向上查找
      var copyTextParent = katexNode.closest('[copy-text]');
      if (copyTextParent) {
        var copyText = copyTextParent.getAttribute('copy-text');
        if (copyText) {
          // 去除定界符 \(...\)（行内）或 \[...\]（块级）
          var latex = copyText
            .replace(/^\\\(([\s\S]+)\\\)$/, '$1')
            .replace(/^\\\[(.+?)\\\]$/, '$1')
            .trim();
          if (latex) return latex;
        }
      }

      return '';
    },

    // 从 KaTeX 节点提取 LaTeX 源码（四级降级链）
    // 路径 A：预提取缓存 data-latex-source（convert() 预提取的 annotation 或 copy-text）
    // 路径 B：实时提取 annotation + copy-text（直接调用 _extractKatexLatex、未经 convert 预提取时命中）
    // 路径 C：调用 KatexHtmlToLatex 反向解析 .katex-html（Kimi 等无 annotation/copy-text 的平台）
    // 最终降级：纯文本（结构丢失，但保证不中断）
    _extractKatexLatex: function (node) {
      // 路径 A：预提取缓存
      // node 可能是 .katex（行内，data 属性设在自身）或 .katex-display（块级，
      // data 属性设在其内部 .katex 上），统一定位到 .katex 节点读取
      var katexEl = node.matches('.katex') ? node : node.querySelector('.katex');
      if (katexEl) {
        var cached = katexEl.getAttribute('data-latex-source');
        if (cached) return cached;
      }

      // 路径 B：实时提取 annotation + copy-text
      if (katexEl) {
        var raw = HtmlToMarkdown._extractRawLatex(katexEl);
        if (raw) return raw;
      }

      // 路径 C：反向解析 .katex-html
      if (typeof KatexHtmlToLatex !== 'undefined') {
        var katexHtml = node.querySelector('.katex-html');
        if (katexHtml) {
          return KatexHtmlToLatex.convert(katexHtml);
        }
      }
      // 最终降级：纯文本（结构丢失，但保证不中断）
      return node.textContent.trim();
    }
  };

  console.log('[HtmlToMarkdown] 初始化完成 (turndown v7.2.4)');
})();

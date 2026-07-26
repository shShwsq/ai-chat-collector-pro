# tests/ 测试套件开发指南

> 一句话定位：本目录是项目的"DOM 改了立刻发现"防线 + 核心纯函数单测，用 vitest + jsdom 跑；测试加载机制特殊——源码是 IIFE + 全局变量风格（不是 ES module），通过 `tests/helpers/load-source.js` 的 `runInWindow()` 用 indirect eval 在 jsdom 全局执行，并把 `const`/`let` 转 `var` 让顶层声明挂到 window。

## 模块职责

`tests/` 共 7 个文件，分三类：

### 测试加载器（1 个）

- **`helpers/load-source.js`**：唯一的 ES module 文件（`import fs from 'node:fs'`）。提供 `runInWindow(filePath)`（读源文件 → `const`/`let` 转 `var` → indirect eval 在 jsdom 全局执行）、`mockChrome(overrides)`（挂 `window.chrome.runtime` / `chrome.storage.local` mock）、`setBody(html)` / `setDocument(html)` / `setPathname(pathname)` / `setTitle(title)`（jsdom 环境辅助）。导出 5 个 loader 函数：`loadDb()` / `loadEmbedding()` / `loadVectorStore()` / `loadLlm()` / `loadHtmlToMarkdown()` / `loadDomAdapter(platform)`，每个 loader 先 `mockChrome()` 再 `runInWindow` 加载源文件及其依赖，返回需要测试的全局对象。

### DOM 适配器测试（3 个，"平台 DOM 改了立刻发现"防线）

- **`dom/adapters.test.js`**：5 个平台 DOM 适配器（kimi/deepseek/qianwen/fudan/doubao）的核心提取逻辑测试。每个平台用 1-2 个最小 DOM fixture 覆盖 `getConversationId` / `getTitle` / `isStreaming` / `extractMessages`。当平台升级 DOM 结构（改 class 名、重组容器层级、移除/新增节点）时，对应测试立即失败。
- **`dom/html-to-markdown.test.js`**：统一 HTML→Markdown 转换封装测试。覆盖基础 Markdown 转换（标题/列表/加粗/斜体/链接/删除线）、自定义段落规则（`paragraphDiv` / `qkMdParagraphDiv` / `doubaoParagraphDiv`）、三平台代码块规则（DeepSeek/千问/豆包）、KaTeX 行内/块级公式（标准 annotation 路径 + katex-html 降级路径）、噪声元素移除（svg/button/.iconify/.action/.toolbar）。
- **`dom/katex-html-to-latex.test.js`**：KaTeX HTML→LaTeX 反向解析测试。Kimi 等平台移除了 KaTeX 的 `<annotation>` 可访问性层，只保留 `.katex-html` 视觉渲染层，`katex-html-to-latex.js` 递归解析这个视觉层重建 LaTeX。fixtures 模拟 KaTeX v0.16 真实输出（`.mord` / `.mop` / `.mrel` / `.mbin` / `vlist` 上标下标）。

### 单元测试（4 个，核心纯函数）

- **`unit/db.test.js`**：`lib/db.js` 纯函数测试。覆盖 `_stripAugmentBlocks`（剥离 think/search_result/【搜索】/【来源】）、`tokenize`（中文 bigram + 单字符分词）、`highlightSearchResult`（`<mark>` 高亮）。
- **`unit/embedding.test.js`**：`lib/embedding.js` 纯函数测试。覆盖 `chunkText`（切片算法）、`filterContentForEmbedding`（内容过滤）、`cosineSimilarity`（向量相似度）。
- **`unit/llm.test.js`**：`lib/llm.js` 纯函数测试。覆盖 `_buildOpenAIChatUrl`（baseUrl 智能拼接 `/chat/completions`）、`_buildThinkingExtras`（**项目最复杂的函数**：6 厂商 × 3 思考模式 × 2 开关 = 36 种组合）、`AIAssistant._parseEmbId`（embId 格式解析）。`_buildThinkingExtras` 测试用例覆盖 project_memory 中记录的全部厂商差异：DashScope/Qwen 用 `enable_thinking` 布尔值；DeepSeek/智谱/Kimi 用 `thinking` 对象 `{type:"enabled"/"disabled"}`；豆包用 `thinking` 对象 + `fallbackThinking`（Endpoint ID 匹配不上 modelMeta）；MiniMax 用 `thinking {type:"adaptive"/"disabled"}` + `reasoning_split:true`。
- **`unit/vector-store.test.js`**：`lib/vector-store.js` 纯函数测试。覆盖 `_trimTrailingSlash`（剥末尾斜杠）、`_normalizeSupabaseUrl`（去 `/rest/v1` 后缀）、`_strToQdrantUUID`（字符串→UUID 确定性转换）、`_chromaDistanceToScore`（distance→score 转换）、`_chromaGetSpace`（从 collection 详情提取 distance function）、`parsePostgrestResponse`（PostgREST 204/201/4xx 响应解析）。

## 关键文件

| 文件 | 职责 | 重要函数/区域 |
|------|------|---------|
| `helpers/load-source.js` | 源文件加载器（ES module） | `runInWindow(filePath)`（fs.readFileSync + const/let→var + indirect eval）；`mockChrome(overrides)`（挂 chrome.runtime/storage mock）；`setBody(html)` / `setDocument(html)` / `setPathname(pathname)` / `setTitle(title)`（jsdom 辅助）；`loadDb()`（返回 `_stripAugmentBlocks` / `tokenize` / `highlightSearchResult`）；`loadEmbedding()`（返回 `EmbeddingService` / `cosineSimilarity`）；`loadVectorStore()`（先加载 embedding.js 依赖，返回 `VectorStore` / `parsePostgrestResponse`）；`loadLlm()`（先加载 db.js + embedding.js + vector-store.js 依赖，返回 `LLMService` / `AIAssistant`）；`loadHtmlToMarkdown()`（加载 turndown + turndown-plugin-gfm + katex-html-to-latex + html-to-markdown，返回 `HtmlToMarkdown` / `KatexHtmlToLatex` / `TurndownService`）；`loadDomAdapter(platform)`（加载 turndown + html-to-markdown + 指定平台 DOM 适配器，返回 `window.DOM_ADAPTERS[platform]`） |
| `dom/adapters.test.js` | 5 平台 DOM 适配器测试 | `resetEnv(pathname, search, title)`（每个测试前重置 jsdom body + location + title）；`THINK_OPEN` / `THINK_CLOSE`（拼接构造避免工具误处理）；`describe('Kimi 适配器')` / `describe('DeepSeek 适配器')` / `describe('千问适配器')` / `describe('复旦适配器')` / `describe('豆包适配器')`，每个 describe 内含 `getConversationId` / `getTitle` / `isStreaming` / `extractMessages` 的多个 `it` |
| `dom/html-to-markdown.test.js` | HTML→Markdown 转换测试 | `makeRoot(htmlString)`（注入 `#test-root` 容器）；`convert(htmlString)`（转换 HTML 字符串为 Markdown）；`describe('基础 Markdown 转换')`（空输入/纯文本/h1-h3/段落/加粗/斜体/链接/列表/删除线）；`describe('自定义段落规则')`（paragraphDiv/qkMdParagraphDiv/doubaoParagraphDiv）；`describe('代码块规则')`（DeepSeek/千问/豆包）；`describe('KaTeX 公式')`（行内/块级 + annotation/katex-html 路径）；`describe('噪声元素移除')` |
| `dom/katex-html-to-latex.test.js` | KaTeX HTML→LaTeX 反向解析测试 | `katexHtml(innerBase)`（构造 `.katex-html` 外壳）；`mord(text)` / `mordMathnormal(text)` / `mop(symbol)` / `mrel(text)` / `mbin(text)`（KaTeX 类名构造器）；`supEntry(content, top)` / `subEntry(content, top)`（vlist 上标下标项，top 值决定上下标）；覆盖积分/分式/上下标/导数等公式 |
| `unit/db.test.js` | db.js 纯函数测试 | `describe('_stripAugmentBlocks')`（空输入/纯文本/剥离 think/剥离 search_result/剥离千问标记/混合场景/多 think 块/未闭合块）；`describe('tokenize')`（中文 bigram + 单字符分词）；`describe('highlightSearchResult')`（`<mark>` 高亮） |
| `unit/embedding.test.js` | embedding.js 纯函数测试 | `describe('chunkText')`（空/短/等于 size/长文本/overlap）；`describe('filterContentForEmbedding')`（剥 think/search_result + includeThinking/includeSearch 开关）；`describe('cosineSimilarity')`（相同/正交/相反/不同维度返回 0） |
| `unit/llm.test.js` | llm.js 纯函数测试 | `MODELS_CATALOG` fixture（覆盖 6 厂商）；`describe('_buildOpenAIChatUrl')`（baseUrl 含/不含版本前缀）；`describe('_buildThinkingExtras')`（**36 种组合**：DashScope hybrid/only + DeepSeek hybrid + 智谱 hybrid + Kimi hybrid + 豆包 hybrid + fallbackThinking + MiniMax adaptive + reasoning_split + 关闭时显式传 disabled/false）；`describe('AIAssistant._parseEmbId')`（标准格式/缺字段/格式不匹配） |
| `unit/vector-store.test.js` | vector-store.js 纯函数测试 | `describe('_trimTrailingSlash')`（单/多斜杠/无斜杠/路径中含斜杠/空串/非字符串）；`describe('_normalizeSupabaseUrl')`（带/不带 /rest/v1 后缀）；`describe('_strToQdrantUUID')`（确定性/格式合法）；`describe('_chromaDistanceToScore')`（l2/cosine/ip）；`describe('_chromaGetSpace')`（三种结构 + 回退 l2）；`describe('parsePostgrestResponse')`（204 空/201 JSON/4xx 错误） |

## 开发工作流

### 跑测试

- `npm test`：跑所有 `tests/**/*.test.js` 一次。
- `npm run test:watch`：watch 模式，改文件自动重跑。
- `npm run test:dom`：只跑 `tests/dom/` 下的 DOM 适配器测试。
- `npm run test:unit`：只跑 `tests/unit/` 下的纯函数测试。
- `npm run test:coverage`：跑测试 + 收集覆盖率（v8 provider）。

### 改测试代码的典型流程

1. 改 `tests/**/*.test.js` 后，vitest watch 模式自动重跑；非 watch 模式手动 `npm test`。
2. 改 `tests/helpers/load-source.js` 后所有测试受影响，需全跑确认。
3. 改 `lib/*.js` 顶层声明（如新增 `const X = {}` 或 `function foo()`）后，需在对应 `loadXxx()` 函数中显式返回新导出，否则测试中访问不到。
4. 改 `content/dom/*.js` 适配器逻辑后，跑 `npm run test:dom` 确认未破坏。
5. 改 `lib/llm.js` 的 `_buildThinkingExtras` 后，必须跑 `tests/unit/llm.test.js` 确认 36 种组合都通过。

### 调试技巧

- **单测失败**：vitest 默认输出失败用例的 `expected` vs `actual`，定位到具体 `it` 块。
- **源文件加载失败**：`runInWindow` 抛错会打印文件路径与错误；常见原因：源码语法错误、`const`/`let` 转 `var` 后作用域变化（块级 const/let 转 var 会改变作用域，但项目源码中这类声明都是局部变量，没有跨作用域引用）。
- **jsdom 不支持的 API**：`fetch` / `indexedDB` / `chrome.runtime.getURL` 等需要 mock。`load-source.js` 的 `mockChrome` 已 mock `chrome.runtime.getURL` 返回 `chrome-extension://test/${p}`，但 `fetch` 未 mock——若测试中调用 `EmbeddingService.embed` 会真发 fetch 请求失败。单测只测纯函数（`chunkText` / `filterContentForEmbedding` / `cosineSimilarity` 等），不测网络请求。
- **DOM fixture 不生效**：`resetEnv(pathname, search, title)` 用 `Object.defineProperty(window, 'location', { value: ..., configurable: true, writable: true })` 重设 location；`document.body.innerHTML = '...'` 设置 body。注意 `document.head.innerHTML` 需单独设（部分适配器用 `document.querySelector('title')`）。
- **THINK_OPEN/THINK_CLOSE 拼接**：`const THINK_OPEN = '<' + 'think' + '>';` 是为了避免在源码中直接出现 `<think>` 被工具误处理（如某些 IDE/linter 会把 `<think>` 当 HTML 标签）。改测试时保持这个习惯。

### vitest.config.js 配置

- `environment: 'jsdom'`：所有测试在 jsdom 环境跑，有 `window` / `document` / `navigator` 等。
- `globals: true`：`describe` / `it` / `expect` / `beforeAll` / `beforeEach` 等全局可用，无需 import。
- `deps.inline: [/\.raw$/]`：测试加载源文件需要 `?raw` 拿到字符串后再 eval 注入到 jsdom window。
- `testTimeout: 10000`：DOM 转换涉及 turndown 初始化，给宽松些（默认 5s 可能不够）。
- `include: ['tests/**/*.test.js']`：只跑 tests 目录下的 .test.js 文件。
- `coverage.provider: 'v8'`、`include: ['lib/**', 'content/dom/**']`、`exclude: ['lib/*.min.js', 'lib/turndown-plugin-gfm.js']`：只收集 lib 与 content/dom 的覆盖率，排除第三方库。

## 代码约定

### 测试文件命名

- `tests/**/*.test.js`：vitest glob 匹配。
- `tests/unit/*.test.js`：纯函数单测，按被测文件命名（`db.test.js` 测 `lib/db.js`）。
- `tests/dom/*.test.js`：DOM 相关测试，按被测主题命名（`adapters.test.js` 测 5 平台适配器、`html-to-markdown.test.js` 测 HTML→Markdown、`katex-html-to-latex.test.js` 测 KaTeX 反向解析）。
- `tests/helpers/load-source.js`：加载器，非测试文件（无 `.test.js` 后缀）。

### 测试结构

- 顶部注释说明文件用途与"DOM 改了立刻发现"的防线定位。
- `import { describe, it, expect, beforeAll, beforeEach } from 'vitest';`（globals:true 时可省，但显式 import 更清晰）。
- `import { loadXxx } from '../helpers/load-source.js';`。
- `beforeAll(() => { const lib = loadXxx(); X = lib.X; })`：加载源文件一次，提取被测对象。
- `beforeEach(() => { ... })`：重置单例状态（如 `EmbeddingService._chunkSize = 500`）或 jsdom 环境（`resetEnv()`）。
- `describe('Xxx')` → `it('行为描述', () => { expect(...).toBe(...) })`。
- fixtures 直接写在每个 `it` 块内，便于阅读上下文。

### 命名规范

- **describe**：被测函数名或模块名（`describe('_stripAugmentBlocks')` / `describe('Kimi 适配器')` / `describe('基础 Markdown 转换')`）。
- **it**：行为描述，中文（`it('空输入返回空串'` / `it('剥离 think 块（标准格式）'` / `it('getConversationId 从 /chat/{uuid} 提取'`）。
- **辅助函数**：camelCase（`resetEnv` / `makeRoot` / `convert` / `katexHtml` / `mord` / `supEntry`）。
- **常量**：全大写下划线（`THINK_OPEN` / `THINK_CLOSE` / `MODELS_CATALOG`）。

### 断言风格

- 用 `expect(x).toBe(y)` 严格相等。
- 用 `expect(arr).toEqual([...])` 数组深比较。
- 用 `expect(arr).toEqual([])` 验证空数组。
- 用 `expect(fn).toThrow('error message')` 验证抛错。
- 不用 `expect(x).toBeTruthy()` / `toBeFalsy()`（不严格）。

## 常见任务

### 任务 1：为新平台 DOM 适配器加测试

**场景**：项目新增了第 6 个平台（如文心一言）的 DOM 适配器 `content/dom/yiyan.js`。

**步骤**：
1. 在 `tests/dom/adapters.test.js` 顶部 `beforeAll` 加 `yiyan = loadDomAdapter('yiyan');`。
2. 在文件末尾加 `describe('文心一言适配器')` 块，参考已有 5 平台结构：
   ```js
   describe('文心一言适配器', () => {
     beforeEach(() => resetEnv('/chat/xxx', '', '文心一言对话'));
     it('getConversationId 从 /chat/{uuid} 提取', () => { ... });
     it('getTitle 剥离后缀', () => { ... });
     it('isStreaming 检测 loading class', () => { ... });
     it('extractMessages 分离用户/助手消息', () => { ... });
   });
   ```
3. fixture 用最小 DOM 结构，只保留适配器依赖的关键 class/属性（参考 project_memory 中记录的真实 DOM）。
4. 真实平台 DOM 更复杂（含噪声元素、嵌套层级），但 fixture 足以验证核心提取逻辑。

**验证**：`npm run test:dom` 通过 → 新增的 describe 块全绿。

### 任务 2：为新纯函数加单测

**场景**：`lib/db.js` 新增了 `function normalizeWhitespace(text)` 函数。

**步骤**：
1. 在 `tests/unit/db.test.js` 顶部 `beforeAll` 中确认 `loadDb()` 返回了 `normalizeWhitespace`（若没有，改 `load-source.js` 的 `loadDb()` 加 `normalizeWhitespace: window.normalizeWhitespace.bind(window)`）。
2. 加 `describe('normalizeWhitespace')` 块，覆盖：
   - 空输入
   - 纯文本无变化
   - 多空格合并为单空格
   - 制表符/换行符处理
   - 中文全角空格
3. 每个 `it` 用最小输入输出断言。

**验证**：`npm run test:unit` 通过 → 新增 describe 块全绿。

### 任务 3：扩展 _buildThinkingExtras 测试覆盖

**场景**：新增了第 7 个 LLM 厂商（如百川）。

**步骤**：
1. 在 `tests/unit/llm.test.js` 的 `MODELS_CATALOG` fixture 加百川配置：
   ```js
   {
     id: 'baichuan',
     backend: 'openai',
     baseUrl: 'https://api.baichuan-ai.com/v1',
     supportsThinking: true,
     thinkingParam: 'thinking',
     models: [{ id: 'baichuan-4', thinking: 'hybrid', thinkingDefault: true }]
   }
   ```
2. 在 `describe('_buildThinkingExtras')` 加测试用例，覆盖：
   - hybrid 模式开启：`{ thinking: { type: 'enabled' } }`
   - hybrid 模式关闭：`{ thinking: { type: 'disabled' } }`
   - options.enableThinking 覆盖配置
3. 若百川有特殊思考参数格式（如 `reasoning_effort`），在 `lib/llm.js` 的 `_buildThinkingExtras` 加分支处理，并加对应测试。

**验证**：`npm run test:unit` 通过 → 新增用例全绿 → 改 `lib/llm.js` 后回归不破。

### 任务 4：为新向量库后端加测试

**场景**：`lib/vector-store.js` 新增了 Weaviate 后端。

**步骤**：
1. 在 `tests/unit/vector-store.test.js` 加 `describe('_strToWeaviateUUID')` 或 `describe('_normalizeWeaviateUrl')` 等纯函数测试。
2. Weaviate 用 UUID 作为 ID，可复用 `_strToQdrantUUID` 的测试结构（确定性、格式合法）。
3. 若 Weaviate 有特殊的 URL 处理（如去 `/v1` 后缀），加 `_normalizeWeaviateUrl` 测试。
4. 不测网络请求（fetch 未 mock），只测纯函数。

**验证**：`npm run test:unit` 通过 → 新增 describe 块全绿。

### 任务 5：调试 jsdom 加载失败

**场景**：`loadDb()` 抛错 "X is not defined"。

**步骤**：
1. 看 `runInWindow` 的错误堆栈，定位是哪个源文件哪一行抛错。
2. 常见原因：
   - 源文件依赖未先加载（如 `db.js` 依赖 `embedding.js` 的 `openEmbeddingDB`，但 `loadDb()` 没加载 `embedding.js`）—— 改 `loadDb()` 加 `runInWindow(path.join(ROOT, 'lib', 'embedding.js'))`。
   - 源文件用了 `const X = {}` 顶层声明，但 `const`/`let` 转 `var` 后作用域变化 —— 检查块级作用域内的 const/let（如 `if` / `for` 内），项目源码中这类声明都是局部变量，应该安全。
   - 源文件用了 jsdom 不支持的 API（如 `fetch` / `indexedDB`）—— 这些在纯函数中不应被调用，若被调用说明测试触发了非纯函数路径。
3. 用 `console.log(window.X)` 在 `runInWindow` 后检查全局对象是否挂载。

**验证**：`loadDb()` 不抛错 → `window._stripAugmentBlocks` 等函数可访问 → 测试通过。

### 任务 6：加覆盖率检查

**场景**：想确保 `lib/llm.js` 的 `_buildThinkingExtras` 所有分支都被覆盖。

**步骤**：
1. 跑 `npm run test:coverage`，vitest 生成 `coverage/` 目录。
2. 打开 `coverage/index.html` 查看 `lib/llm.js` 的覆盖率。
3. 找到 `_buildThinkingExtras` 函数，看哪些分支未覆盖（红色高亮）。
4. 在 `tests/unit/llm.test.js` 加对应测试用例覆盖未覆盖分支。
5. 重新跑覆盖率确认。

**验证**：`_buildThinkingExtras` 的分支覆盖率达到 100%（36 种组合全覆盖）。

## 扩展点

### 新增测试文件

- 在 `tests/unit/` 或 `tests/dom/` 加 `*.test.js` 文件，vitest 自动发现。
- 顶部 `import { describe, it, expect, beforeAll } from 'vitest';`。
- 用 `loadXxx()` 加载源文件，提取被测对象。
- 不需要修改 `vitest.config.js`（`include: ['tests/**/*.test.js']` 自动匹配）。

### 扩展 load-source.js

- 新增 `loadXxx()` 函数：先 `mockChrome()` 再 `runInWindow` 加载源文件及依赖，返回需要测试的全局对象。
- 若新源文件依赖其他源文件（如 `lib/llm.js` 依赖 `lib/db.js` + `lib/embedding.js` + `lib/vector-store.js`），按依赖顺序 `runInWindow`。
- 返回的对象用 `.bind(window)` 确保 `this` 指向 window（部分函数用 `this` 访问全局）。

### 扩展 mockChrome

- 当前 mock `chrome.runtime.id` / `getURL` / `storage.local.get` / `storage.local.set`。
- 若测试需要 mock 其他 API（如 `chrome.tabs.sendMessage` / `chrome.permissions.contains`），在 `mockChrome(overrides)` 的 `overrides` 参数中传入。
- 不修改默认 mock，避免影响其他测试。

### 扩展 jsdom 辅助函数

- 当前提供 `setBody` / `setDocument` / `setPathname` / `setTitle`。
- 可加 `setUrl(url)`（设置完整 URL）、`setUserAgent(ua)`、`mockFetch(handler)`（mock fetch 响应）等。
- 新辅助函数放 `tests/helpers/load-source.js`，export 出去。

### 集成测试扩展

- 当前只有单元测试与 DOM 适配器测试，无集成测试。
- 可加 `tests/integration/` 目录，测试完整流程（如 saveConversation → triggerEmbedding → VectorStore.addVectors）。
- 集成测试需要 mock fetch 与 indexedDB，复杂度较高，项目当前未做。

## 注意事项（坑）

### const/let 转 var 的副作用

- `runInWindow` 把 `const` / `let` 全局替换为 `var`：
  ```js
  const modified = code.replace(/\bconst\s+/g, 'var ').replace(/\blet\s+/g, 'var ');
  ```
- **块级作用域内的 const/let 转 var 会改变作用域**：如 `if (true) { const x = 1; } console.log(x);` 转 var 后 `x` 泄漏到函数作用域。但项目源码中这类声明都是局部变量，没有跨作用域引用，行为仍一致。
- **for 循环中的 let 转 var**：`for (let i = 0; ...)` 转 `for (var i = 0; ...)` 后 `i` 泄漏到函数作用域，但项目源码中没有闭包捕获循环变量的情况，安全。
- **解构声明**：`const { a, b } = obj` 转 `var { a, b } = obj` 在 ES2015+ 中合法。
- **不处理字符串/正则中的 const/let 关键字**：源码中无此情况（注释里有，但 `.replace` 会误替换——检查源码注释中是否有 "const" 单词，会被误转，但 indirect eval 时注释被忽略，不影响）。

### indirect eval 的全局作用域

- `(0, eval)(modified)` 是 indirect eval，在全局作用域执行（不是当前函数作用域）。
- 顶层函数声明 `function foo() {}` 挂到 window（OK）。
- 顶层 `var x = ...` 挂到 window（OK，因为 const/let 已转 var）。
- 顶层 `const/let` 不会挂到 window（已转 var，OK）。
- indirect eval 能访问 window / document / chrome 等浏览器全局（jsdom 提供 window/document，mockChrome 提供 chrome）。

### 单例对象跨测试用例状态污染

- `EmbeddingService` / `VectorStore` / `LLMService` 是单例对象，`beforeAll` 加载一次后跨 `it` 共享状态。
- `tests/unit/embedding.test.js` 的 `beforeEach` 重置 `EmbeddingService._chunkSize` / `_chunkOverlap` / `_includeThinking` / `_includeSearch`，避免上一个测试改的状态影响下一个。
- `tests/unit/llm.test.js` 的 `_buildThinkingExtras` 测试用 `LLMService._config = { provider: 'xxx', model: 'yyy' }` 显式设置，不依赖之前的状态。
- 改测试时注意：若 `it` 块修改了单例状态，在 `afterEach` 或 `beforeEach` 重置。

### loadXxx 的依赖顺序

- `loadDb()`：只加载 `lib/db.js`。但 `db.js` 的 `triggerEmbedding` 引用 `EmbeddingService` / `VectorStore`（在 SW 环境才有），测试中不调用 `triggerEmbedding` 即可。
- `loadEmbedding()`：只加载 `lib/embedding.js`。
- `loadVectorStore()`：先加载 `lib/embedding.js`（提供 `openEmbeddingDB` / `saveEmbedding` / `getAllEmbeddings` 等），再加载 `lib/vector-store.js`。
- `loadLlm()`：先加载 `lib/db.js` + `lib/embedding.js` + `lib/vector-store.js`（llm.js 引用 `getConversation` / `EmbeddingService` / `VectorStore` / `getRetrievalSettings`），再加载 `lib/llm.js`。
- `loadHtmlToMarkdown()`：先加载 `lib/turndown.min.js` + `lib/turndown-plugin-gfm.js`（提供 `TurndownService` / `turndownPluginGfm`），再加载 `content/dom/katex-html-to-latex.js` + `content/dom/html-to-markdown.js`。
- `loadDomAdapter(platform)`：先加载 turndown + turndown-plugin-gfm + katex-html-to-latex + html-to-markdown，再加载 `content/dom/${platform}.js`。
- 改 `loadXxx()` 时注意依赖顺序，否则会 "X is not defined"。

### loadDomAdapter 返回的是 window.DOM_ADAPTERS[platform]

- 各平台适配器在 `content/dom/<platform>.js` 中注册到 `window.DOM_ADAPTERS = { kimi: {...}, deepseek: {...}, ... }`。
- `loadDomAdapter(platform)` 返回 `window.DOM_ADAPTERS[platform]`，是适配器对象，含 `getConversationId` / `getTitle` / `isStreaming` / `extractMessages` 方法。
- 改适配器时，确保仍然注册到 `window.DOM_ADAPTERS`，否则测试找不到。

### THINK_OPEN/THINK_CLOSE 拼接

- `const THINK_OPEN = '<' + 'think' + '>';` 是为了避免在源码中直接出现 `<think>` 被工具误处理。
- 某些 IDE/linter 会把 `<think>` 当 HTML 标签解析，导致语法高亮错乱或自动补全异常。
- 拼接构造绕过这个问题，运行时拼出 `<think>` 字符串。
- 改测试时若需要 `<think>` 字符串，用同样的拼接方式。

### resetEnv 的 Object.defineProperty

- `resetEnv(pathname, search, title)` 用 `Object.defineProperty(window, 'location', { value: {...}, configurable: true, writable: true })` 重设 location。
- jsdom 的 `window.location` 默认不可写，必须用 `defineProperty` + `configurable: true`。
- `document.title` 同样不可写，用 `defineProperty`。
- `beforeEach(() => resetEnv(...))` 确保每个测试有干净的 jsdom 环境。

### fixture 的最小化原则

- DOM fixture 只保留适配器依赖的关键 class/属性，不含噪声元素。
- 如 Kimi 的 `extractMessages` fixture：
  ```html
  <div class="chat-detail-content">
    <div class="chat-content-item chat-content-item-user">
      <div class="segment segment-user">
        <div class="segment-content">
          <div class="segment-content-box">
            <div class="markdown-container"><div class="markdown">
              <div class="paragraph">你好</div>
            </div></div>
          </div>
        </div>
      </div>
    </div>
    ...
  </div>
  ```
- 真实平台 DOM 更复杂（含头像、操作按钮、时间戳等噪声），但 fixture 足以验证核心提取逻辑。
- 平台升级 DOM 时，若改了关键 class 名（如 `segment` → `section`），fixture 与适配器需同步更新。

### KaTeX fixture 的版本敏感

- `tests/dom/katex-html-to-latex.test.js` 的 fixture 模拟 KaTeX v0.16 输出。
- KaTeX 升级（如 v0.17）可能改变 `.katex-html` DOM 结构，导致 fixture 失效。
- 升级 `lib/katex.min.js` 后必须跑这个测试，若失败需更新 fixture 匹配新版 KaTeX 输出。
- 用真实 KaTeX 渲染一个公式，复制其 `.katex-html` outerHTML 作为 fixture 来源。

### vitest.config.js 的 coverage 排除

- `coverage.exclude: ['lib/*.min.js', 'lib/turndown-plugin-gfm.js']`：排除第三方库。
- `lib/turndown-plugin-gfm.js` 虽然不是 .min.js，但是第三方插件，排除。
- 若新增第三方库到 `lib/`，记得加到 `coverage.exclude`，避免拉低覆盖率。

### testTimeout 10s

- `testTimeout: 10000`：DOM 转换涉及 turndown 初始化，5s 可能不够。
- 若测试超时，检查是否有死循环（如 `chunkText` 的 overlap >= size 导致 step <= 0）。
- 单测应远快于 10s（通常 <100ms），超时说明有问题。

### jsdom 不支持 indexedDB

- jsdom 默认不提供 `indexedDB`，`lib/db.js` 的 `openDB()` 会抛错。
- `loadDb()` 只测纯函数（`_stripAugmentBlocks` / `tokenize` / `highlightSearchResult`），不调用 `openDB`。
- 若需要测 `saveConversation` 等 IndexedDB 操作，需引入 `fake-indexeddb` 包（项目当前未引入）。

### jsdom 不支持 fetch

- jsdom 默认不提供 `fetch`，`lib/embedding.js` 的 `embed()` 会抛错。
- `loadEmbedding()` 只测纯函数（`chunkText` / `filterContentForEmbedding` / `cosineSimilarity`），不调用 `embed`。
- 若需要测 `embed` 的网络请求，需 mock `window.fetch`（项目当前未做）。

### tests/helpers 不是测试目录

- `tests/helpers/load-source.js` 不匹配 `tests/**/*.test.js` glob，不会被 vitest 当测试文件。
- 改 `load-source.js` 不会触发 watch 模式重跑（vitest 只 watch 测试文件与其依赖）。
- 但 `load-source.js` 被 `*.test.js` import 后，改它会让 vitest 重新加载依赖测试。

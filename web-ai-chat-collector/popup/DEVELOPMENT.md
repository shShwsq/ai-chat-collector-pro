# popup/ 弹窗与设置页开发指南

> 一句话定位：本目录是扩展的前端 UI 层，包含两个独立页面——`popup.html`（点击扩展图标弹出的小窗，列表/搜索/查看/导出对话）与 `settings.html`（完整设置页，配置平台开关、Embedding、向量库、检索、LLM、存储位置、数据管理）；两页通过 `chrome.runtime.sendMessage` 与 Service Worker 通信，不直接访问 IndexedDB 或远程服务。

## 与 knowledge-work-assistant 的关系（插件 + 软件一体化）

本目录是 collector 的"配置与展示层"，与软件侧 [knowledge-work-assistant](../../knowledge-work-assistant/DEVELOPMENT.md) 的关系如下：

- **平台模式与 KWA 白名单对齐**：`settings.html` 的"对话提取"区 5 个平台 checkbox + DOM/网络拦截 radio 写入 `chrome.storage.local` 的 `platformModes`，5 个平台 ID 与 KWA 后端 [routers/plugin.py](../../knowledge-work-assistant/backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 白名单取交集；新增平台时需两侧同步（详见工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"任务 1"）。
- **本地应用对接分区**：collector 设置页原生提供"本地应用对接"分区，含：
  - 启用总开关
  - 自动推送开关
  - 定时推送间隔选择（1/5/10/30 分钟）
  - baseUrl 输入框（默认 `http://127.0.0.1:8788`）
  - 连通性测试按钮（调 `GET /api/plugin/health`）
  - 手动"推送全部"按钮
  - 设置保存到 `chrome.storage.local` 的 `localAppSettings` key
- **LLM 配置独立**：本目录 `settings.js` 的 LLM 配置（backend/baseUrl/apiKey/model/thinking）写入 `chrome.storage.local` 的 `llmSettings`，与 KWA 后端 [backend/.env](../../knowledge-work-assistant/backend/.env) 的 `LLM_API_KEY`/`LLM_BASE_URL` 等**完全独立**；共享 LLM 凭据时需在两侧各填一次。
- **本地查看器与 KWA 图谱 UI**：`popup.js` 的 `openViewer()` 弹出的对话查看器是 collector 本地的；KWA 前端的图谱视图（[frontend/src/components/graph/GraphView.tsx](../../knowledge-work-assistant/frontend/src/components/graph/GraphView.tsx)）是另一套 UI，不读 collector 数据。
- **数据管理独立**：`settings.js` 的"清空对话"/"重置设置"按钮只影响 collector 本地（IndexedDB + chrome.storage + 远程向量库）；**不会**删除已推送到 KWA 后端的 `Observation`（需在软件侧手动删除）。

跨子工程任务（应用 settings patch、同步 LLM Provider、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

`popup/` 共 6 个文件，按页面分组：

### popup（弹窗主页）

1. **`popup.html`**：弹窗结构。container 内含 header（标题 + 状态栏 `#status`）、toolbar（搜索框 + 平台过滤 + 导出全部/刷新/设置按钮）、`#conversationList`（对话列表）、`#viewerOverlay`（完整对话查看弹窗）。底部 `<script>` 引入 `lib/marked.min.js` + `lib/katex.min.js` + `popup.js`。
2. **`popup.css`**：弹窗样式（约 200 行）。定义 `.conv-item` 卡片样式、`.v-msg` 消息气泡、`.think-block` / `.search-block` 折叠块、`.math-block` / `.math-inline` 公式样式等。
3. **`popup.js`**：弹窗逻辑。`DOMContentLoaded` 后初始化：`loadStatus()` + `loadConversations()` + 绑定事件。核心函数：`createConvItem(conv)`（渲染对话卡片，含展开/折叠、查看/导出/删除按钮）、`openViewer(conv)`（弹完整对话查看器）、`renderViewerContent(content)`（用 marked 渲染 Markdown，提取 `<think>`/`<search_result>`/`$$...$$`/`$...$` 为占位符避免 marked 破坏，还原时渲染 KaTeX 与折叠块）、`renderMath(tex, displayMode)`（KaTeX 渲染，失败降级显示原始 LaTeX）。

### settings（设置页）

4. **`settings.html`**：设置页结构，9 大 section：(1) 对话提取（5 平台 checkbox + DOM/网络拦截 radio）、(2) Embedding 服务（厂商/模型/API Key/内容过滤/切片参数）、(3) 检索设置（mode/TopK/阈值/最大上下文）、(4) 向量库（类型/URL/Key/Collection + 测试连通性 + 重建索引按钮）、(5) LLM 服务（backend 切换 + OpenAI/Ollama 配置 + 思考开关）、(6) 存储位置（IndexedDB 详情 + 扩展 ID + DevTools 入口）、(7) 向量库数据管理（统计 + 清空）、(8) 帮助弹窗（动态加载 `docs/<xxx>-setup.md`）、(9) 数据管理 danger zone（清空对话/重置设置）。顶部 sticky header 含"保存设置"/"返回"/"存储位置"/"数据管理"导航按钮。
5. **`settings.css`**：设置页样式（约 600 行）。布局：左侧 section 流式排版，右侧无；自定义模型下拉组件（`.model-select` / `.model-dropdown` / `.model-option`）；折叠区域（`.collapsible`）；toast 通知（`.toast.show` / `.toast.error` / `.toast.success`）。
6. **`settings.js`**：设置页逻辑（约 1300 行，项目最大的 JS 文件）。`DOMContentLoaded` 后：`loadModelsCatalog()` 拉取 `models.json` → 填充下拉 → `loadSettings()` 读用户配置填表单 → 记录 `formSnapshot`（用于未保存提示）。核心函数：`saveSettings()`（按 6 类顺序保存：platforms → platformModes → embedding → retrieval → vectorStore → llm，含切片校验、向量库后端切换询问、权限申请）、`saveVectorStoreSettings({ interactive })`（interactive=true 弹后端切换询问，false 静默保存给测试连通性用）、`testEmbedding()` / `testLLM()` / `testVectorConnection()`（三者都是先保存再测试）、`rebuildIndex()`、`loadStorageInfo()`、`loadVectorStoreStats()`、`clearConversations()` / `resetSettings()`、自定义模型下拉交互（`renderModelOptions` / `openModelDropdown` / `closeModelDropdown`，含键盘导航 Enter/Escape）、`applyOpenaiPreset(providerId)`（预设厂商切换时自动填 baseUrl/模型列表/思考开关）、`updateOpenaiThinkingByModel()`（根据模型 thinking 模式更新开关状态）、`updateRetrievalModeUI()`（按 mode 显示/隐藏 TopK 与阈值输入框）、`openHelp(type)`（动态加载 `docs/<xxx>-setup.md` 渲染到帮助弹窗）、`urlToOrigin(rawUrl)`（提取 origin 用于权限申请）、`ensureHostPermission(rawUrl)`（申请远程向量库域名权限）、`showToast(message, isError)`、`toggleCollapse(headerEl, bodyEl)`。

## 关键文件

| 文件 | 职责 | 重要函数/区域 |
|------|------|---------|
| `popup.html` | 弹窗结构 | `#status`（顶部状态）、`#searchInput` + `#searchBtn`、`#platformFilter`（动态填充）、`#exportAllBtn` / `#refreshBtn` / `#settingsBtn`、`#conversationList`（列表容器）、`#viewerOverlay` + `#viewerTitle` + `#viewerBody` + `#viewerClose`（查看器弹窗）；底部 `<script src="../lib/marked.min.js">` + `<script src="../lib/katex.min.js">` + `<script src="popup.js">` |
| `popup.js` | 弹窗逻辑 | `loadStatus()`（发 `GET_STATUS`，更新状态栏 + 平台过滤选项）、`loadConversations()`（按 `currentSearchQuery` 发 `SEARCH_CONVERSATIONS` 或 `GET_CONVERSATIONS`）、`createConvItem(conv)`（渲染卡片，含 6 条消息预览 + 4 按钮）、`openViewer(conv)`（弹查看器，渲染所有消息）、`renderViewerContent(content)`（Markdown+KaTeX+折叠块渲染）、`renderMath(tex, displayMode)`（KaTeX 渲染）、`sendMessage(msg)`（Promise 包装 `chrome.runtime.sendMessage`）、`escapeHtml(text)`、`handleExportAll()`（confirm 选 markdown/json）、`handleSearch()` |
| `settings.html` | 设置页结构 | 9 大 section（见上）；`#saveBtn` / `#backBtn` / `#navStorageBtn` / `#navDataBtn`（sticky header）；`#testEmbeddingBtn` / `#testLlmBtn` / `#testVectorConnectionBtn` / `#rebuildIndexBtn`；`#clearConversationsBtn` / `#resetSettingsBtn`（danger zone）；`#helpOverlay` / `#helpTitle` / `#helpBody`（帮助弹窗）；自定义模型下拉 `#openaiModelSelect` / `#embeddingModelSelect`（含 `#xxxModelDropdown` 子元素） |
| `settings.js` | 设置页逻辑（约 1300 行） | `loadModelsCatalog()`（fetch models.json 填充下拉）、`loadSettings()`（发 6 次 `GET_SETTINGS` 填表单 + `formSnapshot`）、`saveSettings()`（按 6 类保存 + 校验 + 权限申请）、`saveVectorStoreSettings({ interactive })`（向量库专门保存，含后端切换询问）、`applyOpenaiPreset(providerId)`（预设厂商切换）、`updateOpenaiThinkingByModel()`、`updateEmbeddingModelHelp()`（显示维度/多模态/dimensionsParam 提示）、`renderModelOptions(keyword)` / `openModelDropdown()` / `closeModelDropdown()`（自定义下拉）、`renderEmbeddingOptions(keyword)` / `openEmbeddingDropdown()` / `closeEmbeddingDropdown()`、`testEmbedding()` / `testLLM()` / `testVectorConnection()` / `rebuildIndex()`、`loadStorageInfo()` / `loadVectorStoreStats()`、`clearConversations()` / `resetSettings()`、`openHelp(type)` / `closeHelp()`、`urlToOrigin(rawUrl)` / `ensureHostPermission(rawUrl)`、`showToast(message, isError)` / `toggleCollapse(headerEl, bodyEl)`、`serializeForm()` / `isFormDirty()`（未保存提示）、`updateRetrievalModeUI()` / `updateVectorHelpLink()` |
| `popup.css` | 弹窗样式 | `.conv-item` 卡片、`.conv-header` / `.conv-title` / `.conv-platform`、`.conv-messages-preview` / `.msg-preview.user` / `.msg-preview.assistant`、`.conv-actions` / `.btn` / `.btn-primary` / `.btn-danger`、`.viewer-overlay.open` / `.viewer-box` / `.viewer-header` / `.viewer-body`、`.v-msg` / `.v-role` / `.v-content`、`.think-block` / `.search-block` / `.collapsible-header` / `.collapsible-body.collapsed`、`.math-block` / `.math-inline`、`.empty-state` |
| `settings.css` | 设置页样式 | `.container` / `.sticky-top` / `header` / `.nav-btn` / `.nav-btn-primary`、`.setting-section` / `.form-group` / `label` / `input` / `select` / `small`、`.platform-row` / `.checkbox-row` / `.mode-options`、`.model-select` / `.model-dropdown` / `.model-option` / `.model-option.empty`、`.storage-info-section` / `.danger-zone`、`.toast` / `.toast.show` / `.toast.error` / `.toast.success`、`.help-overlay` / `.help-box`、`.collapsible` / `.collapsible.collapsed` |

## 开发工作流

### 改 popup 代码的典型流程

1. 改 `popup/popup.js` 或 `popup/popup.html` 或 `popup/popup.css` 后，关闭弹窗重新点击扩展图标即可生效（不需要重新加载扩展）。
2. 调试时在弹窗上右键 → "检查"打开 popup DevTools。
3. popup 关闭即销毁，DevTools 也会关闭；若需要持续查看日志，可以在 DevTools Console 中执行 `chrome.action.openPopup()` 重新打开（Chrome 99+）。
4. 改 `popup.js` 后 popup 重新打开会重新执行 `DOMContentLoaded`，重新 `loadStatus` + `loadConversations`。

### 改 settings 代码的典型流程

1. settings 是普通 tab 页（通过 `chrome.tabs.create({ url: chrome.runtime.getURL('popup/settings.html') })` 打开），改 `settings.html` / `settings.js` / `settings.css` 后刷新 tab 即可。
2. 在 settings tab 上 F12 打开 DevTools 调试。
3. settings 页与 SW 通信用 `chrome.runtime.sendMessage`，SW 响应通过 `chrome.runtime.sendMessage` 的 callback 接收。
4. 改 models.json 后需重新加载扩展（让 SW 重新 fetch）；settings 页也要刷新（它也 fetch models.json）。

### 调试技巧

- **popup 不显示**：检查 SW 是否启动（`chrome://extensions/` 看 SW 状态）；popup DevTools → Console 看错误。
- **对话列表为空**：popup DevTools → Console 看 `sendMessage` 返回值；SW DevTools → Application → IndexedDB → `AIChatCollector.conversations` 看是否有数据。
- **设置保存失败**：settings DevTools → Console 看 `saveSettings` 的 `resp`；SW DevTools 看 `[BG]` 错误日志。
- **测试连通性失败**：先看 SW DevTools → Network 是否有 fetch 请求；若 `Failed to fetch`，检查域名是否在 `host_permissions` 或 `optional_host_permissions` 中；CORS 是否放行扩展 origin。
- **模型下拉不显示**：检查 `loadModelsCatalog` 是否成功 fetch models.json（settings DevTools → Network）；`modelsCatalog` 变量是否非 null。
- **思考开关状态不对**：`applyOpenaiPreset` 与 `updateOpenaiThinkingByModel` 决定开关状态；only 模式强制勾选 + 禁用，hybrid 模式按 `thinkingDefault`，none 模式不勾选；用户手动改过开关后会标记 `dataset.userTouched='1'`，之后切换模型不再自动改开关。
- **未保存提示**：`formSnapshot` 在 `loadSettings` 完成后记录，`serializeForm()` 序列化当前表单值，`isFormDirty()` 比较；点"返回"时若 dirty 则 confirm。改表单字段时记得在 `serializeForm` 加新字段，否则未保存提示失效。

## 代码约定

### 加载方式

- 用 `<script src=>` 标签加载（非 ES module），见 `popup.html` 底部与 `settings.html` 底部。
- 第三方库（marked/katex）通过相对路径 `../lib/xxx.min.js` 引入。
- popup 自己的 JS 是 `popup.js`，settings 是 `settings.js`。
- 两个 JS 文件都是 `document.addEventListener('DOMContentLoaded', () => { ... })` 包裹，所有逻辑在闭包内。

### 命名规范

- **DOM 元素 ID**：camelCase（`#searchInput` / `#searchBtn` / `#platformFilter` / `#exportAllBtn` / `#refreshBtn` / `#settingsBtn` / `#conversationList` / `#viewerOverlay` / `#viewerTitle` / `#viewerBody` / `#viewerClose` / `#status`）。settings 中：`#saveBtn` / `#backBtn` / `#testEmbeddingBtn` / `#testLlmBtn` / `#testVectorConnectionBtn` / `#rebuildIndexBtn` / `#embeddingProvider` / `#embeddingModel` / `#dashscopeEmbeddingKey` / `#vectorStoreType` / `#vectorUrl` / `#vectorApiKey` / `#vectorCollection` / `#llmBackend` / `#openaiPreset` / `#openaiBaseUrl` / `#openaiApiKey` / `#openaiModel` / `#openaiEnableThinking` / `#ollamaBaseUrl` / `#ollamaModel` / `#retrievalMode` / `#retrievalTopK` / `#retrievalThreshold` / `#retrievalMaxContextChars` / `#toast` / `#helpOverlay` 等。
- **CSS 类**：kebab-case（`.conv-item` / `.conv-header` / `.viewer-overlay` / `.think-block` / `.collapsible-header` / `.model-select` / `.model-option` / `.setting-section` / `.form-group` / `.nav-btn` / `.toast` / `.danger-zone`）。
- **函数**：camelCase（`loadStatus` / `loadConversations` / `createConvItem` / `openViewer` / `closeViewer` / `renderViewerContent` / `renderMath` / `sendMessage` / `escapeHtml` / `handleExportAll` / `handleSearch`）。settings 中：`loadModelsCatalog` / `loadSettings` / `saveSettings` / `applyOpenaiPreset` / `updateOpenaiThinkingByModel` / `updateEmbeddingModelHelp` / `renderModelOptions` / `openModelDropdown` / `closeModelDropdown` / `saveVectorStoreSettings` / `testEmbedding` / `testLLM` / `testVectorConnection` / `rebuildIndex` / `loadStorageInfo` / `loadVectorStoreStats` / `clearConversations` / `resetSettings` / `openHelp` / `closeHelp` / `urlToOrigin` / `ensureHostPermission` / `showToast` / `toggleCollapse` / `serializeForm` / `isFormDirty` / `updateRetrievalModeUI` / `updateVectorHelpLink`。
- **常量**：全大写下划线（`VECTOR_HELP_MAP`）。

### 消息协议

- 用 `chrome.runtime.sendMessage({ type: 'XXX_YYY', ...payload }, callback)` 发消息给 SW。
- `sendMessage(msg)` 是 Promise 包装：`new Promise((resolve) => chrome.runtime.sendMessage(msg, (response) => resolve(response)))`。
- 不直接访问 IndexedDB 或远程服务（避免 popup/settings 与 SW 数据不一致）。
- settings 页发的消息类型：`GET_SETTINGS` / `SAVE_SETTINGS`（按 category 分发）、`TEST_EMBEDDING` / `TEST_LLM` / `TEST_VECTOR_CONNECTION` / `REBUILD_VECTOR_INDEX` / `GET_STORAGE_INFO` / `GET_VECTOR_STORE_STATS` / `CLEAR_VECTOR_STORE` / `CLEAR_ALL_CONVERSATIONS` / `RESET_ALL_SETTINGS` / `OPEN_SETTINGS`（settings 不用 OPEN_SETTINGS）。
- popup 页发：`GET_STATUS` / `GET_CONVERSATIONS` / `SEARCH_CONVERSATIONS` / `DELETE_CONVERSATION` / `EXPORT_CONVERSATION` / `EXPORT_ALL`。

### 错误处理

- `sendMessage` 失败（SW 未响应）时 callback 收到 `undefined`，代码用 `if (response && response.success)` 判断。
- 异步操作（testEmbedding 等）用 try/catch + `showToast(msg, isError)` 提示。
- 表单校验：`saveSettings` 中 `if (isNaN(sizeVal) || sizeVal < 100) { showToast('切片大小需为不小于 100 的整数'); return false; }`；`chunkOverlap >= chunkSize` 时 `showToast('切片重叠必须小于切片大小')`。
- 权限申请：`ensureHostPermission` 用 `chrome.permissions.request`，用户拒绝不阻塞保存（配置已持久化）。

## 常见任务

### 任务 1：在 popup 加一个新按钮

**场景**：想在对话卡片加"复制对话内容"按钮。

**步骤**：
1. 在 `popup/popup.js` 的 `createConvItem(conv)` 函数中，找到 `.conv-actions` 区，加 `<button class="btn copy-btn" data-id="${conv.id}">复制</button>`。
2. 在 `createConvItem` 末尾加事件绑定：`div.querySelector('.copy-btn').addEventListener('click', async (e) => { e.stopPropagation(); const text = conv.messages.map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n\n'); await navigator.clipboard.writeText(text); showToast('已复制'); });`。
3. 注意不能用内联 `onclick`（MV3 CSP 禁止），必须用 `addEventListener`。
4. 若需要 toast，参考 settings.js 的 `showToast` 实现，或用 `alert` 简化。

**验证**：打开 popup → 对话卡片出现"复制"按钮 → 点击 → 剪贴板含对话文本。

### 任务 2：在 settings 加新设置项

**场景**：想加"自动同步到远程向量库"开关。

**步骤**：
1. 在 `popup/settings.html` 的合适 section 加表单元素，如 Embedding 区加 `<input type="checkbox" id="autoSync" />`。
2. 在 `popup/settings.js` 顶部 DOM 元素声明区加 `const autoSync = document.getElementById('autoSync');`。
3. 在 `loadSettings()` 中读取并填充：在对应 category 的 `sendMessage({ type: 'GET_SETTINGS', category: 'xxx' })` 返回中读取 `autoSync.checked = resp.autoSync === true;`（或在 embedding category 加该字段）。
4. 在 `saveSettings()` 中保存：在对应 category 的 settings 对象加 `autoSync: autoSync.checked`。
5. 在 `serializeForm()` 中加 `autoSync: autoSync.checked`（用于未保存提示）。
6. 在 `lib/*.js` 的对应 `getXxxSettings` / `saveXxxSettings` 默认值中加 `autoSync: false`。
7. 在 `bg/settings-handlers.js` 的 `handleSaveSettings` 对应 case 中处理新字段（若需要在 SW 端触发副作用）。

**验证**：settings 页修改新字段 → 保存 → 刷新 settings 页 → 值保留 → SW DevTools → Application → Local Storage 查看对应 key。

### 任务 3：自定义模型下拉组件扩展

**场景**：自定义下拉想支持键盘上下箭头导航。

**步骤**：
1. 修改 `popup/settings.js` 的 `openaiModel.addEventListener('keydown', ...)` 处理函数，当前只处理 `Escape` 与 `Enter`：
   ```js
   } else if (e.key === 'ArrowDown' && modelDropdownItems.length > 0) {
     e.preventDefault();
     // 高亮下一个选项
   } else if (e.key === 'ArrowUp' && modelDropdownItems.length > 0) {
     e.preventDefault();
     // 高亮上一个选项
   }
   ```
2. 加 `let highlightedIdx = -1;` 状态变量，ArrowDown 时 `highlightedIdx = (highlightedIdx + 1) % modelDropdownItems.length;`，ArrowUp 时 `highlightedIdx = (highlightedIdx - 1 + modelDropdownItems.length) % modelDropdownItems.length;`。
3. 给 `modelDropdownItems[highlightedIdx]` 加 `.highlighted` class（在 `settings.css` 定义 `.model-option.highlighted { background: #e0f2fe; }`）。
4. Enter 时若有高亮项，选中 `modelDropdownItems[highlightedIdx].dataset.value` 而非第一个。
5. 同步给 `embeddingModel` 加同样逻辑（复制粘贴）。

**验证**：settings 页选预设厂商 → 模型输入框聚焦 → 按下箭头高亮下移 → Enter 选中高亮项。

### 任务 4：调整对话查看器渲染

**场景**：想在查看器中显示消息时间戳。

**步骤**：
1. 修改 `popup/popup.js` 的 `openViewer(conv)` 函数，当前：
   ```js
   viewerBody.innerHTML = conv.messages.map(m => {
     const contentHtml = renderViewerContent(m.content);
     return `<div class="v-msg ${m.role}">
       <div class="v-role">${m.role === 'user' ? '用户' : '助手'}</div>
       <div class="v-content">${contentHtml}</div>
     </div>`;
   }).join('');
   ```
2. 加时间戳：`<div class="v-time">${m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN') : ''}</div>`（需 content script 在保存对话时记录 `msg.timestamp`，见 `content/dom/*.js` 的 `extractMessages`）。
3. 在 `popup.css` 加 `.v-time { font-size: 11px; color: #9ca3af; margin-top: 4px; }`。
4. 注意：当前 `conv.messages` 中不一定有 `timestamp` 字段，老数据可能没有，需 fallback 显示空。

**验证**：popup 列表 → 点"查看" → 弹窗中每条消息下方显示时间戳（若有）。

### 任务 5：修改未保存提示逻辑

**场景**：想在用户改了任何字段后立即显示"未保存"标记。

**步骤**：
1. 当前 `isFormDirty()` 只在点"返回"时调用，可改为实时监听。
2. 在 `popup/settings.js` 的所有表单元素上加 `addEventListener('input', updateDirtyIndicator)` 与 `addEventListener('change', updateDirtyIndicator)`。
3. 实现 `updateDirtyIndicator()`：`saveBtn.classList.toggle('dirty', isFormDirty());`。
4. 在 `settings.css` 加 `.nav-btn.dirty { background: #fef3c7; border-color: #f59e0b; }`（黄色提示）。
5. `saveSettings` 成功后 `formSnapshot = serializeForm()`，`updateDirtyIndicator()` 自动清除 dirty 标记。

**验证**：settings 页改任何字段 → "保存设置"按钮变黄 → 保存 → 按钮恢复原色。

### 任务 6：调整帮助弹窗加载逻辑

**场景**：帮助弹窗当前从 `docs/<xxx>-setup.md` 加载，想改成预渲染 HTML。

**步骤**：
1. 修改 `popup/settings.js` 的 `openHelp(type)` 函数，当前用 `fetch(chrome.runtime.getURL(info.file))` 拉 markdown 文件，然后用 `marked.parse` 渲染。
2. 改为 `fetch(chrome.runtime.getURL('docs/<xxx>-setup.html'))` 拉 HTML，直接 `helpBody.innerHTML = html`。
3. 注意：HTML 文件需要预先准备，且要在 `manifest.json` 的 `web_accessible_resources` 中暴露（当前只暴露了 `lib/katex.min.css`）。
4. 或者保持 markdown 加载，但加目录跳转：用正则提取 `^##\s+(.+)$` 作为目录项，生成 sidebar。

**验证**：settings 页向量库区选 ChromaDB → 点"查看 ChromaDB 部署说明" → 帮助弹窗显示对应内容。

## 扩展点

### 新增 settings section

- 在 `settings.html` 加 `<section class="setting-section">`，包含 `<h2>` 标题与表单元素。
- 在 `settings.js` 顶部 DOM 元素声明区加 `const xxx = document.getElementById('xxx');`。
- 在 `loadSettings` / `saveSettings` / `serializeForm` 中加对应逻辑。
- 若涉及新设置类别（非现有 6 类），在 `bg/settings-handlers.js` 的 `handleGetSettings` / `handleSaveSettings` switch 加 case，并在 `lib/*.js` 加 `getXxxSettings` / `saveXxxSettings`。

### 自定义下拉组件复用

- 当前有两套自定义下拉：`openaiModelSelect` 与 `embeddingModelSelect`，逻辑高度相似。
- 可抽象为通用组件 `createModelSelect(inputEl, dropdownEl, getProvider, onSelect)`，但项目当前选择复制粘贴（避免过度抽象）。
- 新增下拉时复制 `renderModelOptions` / `openModelDropdown` / `closeModelDropdown` / `modelDropdownItems` 等代码，修改变量名。

### 帮助弹窗扩展

- `VECTOR_HELP_MAP` 当前映射 5 个向量库（chroma/milvus/pgvector/supabase/qdrant）到 `docs/<xxx>-setup.md`。
- 新增向量库时加映射 `{ weaviate: { title: 'Weaviate 部署说明', file: 'docs/weaviate-setup.md' } }`。
- 帮助弹窗用 marked 渲染 markdown，支持 GFM 表格、代码块等。

### toast 通知扩展

- `showToast(message, isError)` 默认 3 秒后隐藏（`setTimeout`）。
- 可加 `showToast(message, isError, duration)` 参数自定义时长。
- 可加 `showToast(message, isError, { action: '撤销', onAction: () => {} })` 支持操作按钮（用于"删除对话"后撤销）。

## 注意事项（坑）

### MV3 CSP 禁止内联事件处理器

- `popup/popup.html` 与 `popup/settings.html` 不能用 `onclick="..."` / `onload="..."` 等内联事件属性，会被 CSP 拦截不执行。
- 必须用 `addEventListener` 在 JS 中绑定。
- 修改 HTML 时不要图省事加内联事件。

### popup 关闭即销毁

- popup 关闭后 JS 上下文销毁，所有变量丢失。
- 不能在 popup 中保存状态（如当前选中的对话），重开 popup 会重置。
- 若需要持久化 UI 状态，存 `chrome.storage.local`，在 `DOMContentLoaded` 时读取。

### popup DevTools 关闭后无法重连

- popup 关闭后 DevTools 也关闭，重新打开 popup 需要重新"检查"。
- 调试时可在 DevTools Console 执行 `chrome.action.openPopup()` 重新打开 popup（Chrome 99+）。
- 或用 `chrome.runtime.sendMessage` 主动从 SW 推消息到 popup（但 popup 关闭时无法接收）。

### settings 保存触发权限申请导致 popup 失焦

- `saveSettings` 末尾若向量库为远程，会调 `ensureHostPermission(rawUrl)` 申请该域名权限。
- `chrome.permissions.request` 会弹权限对话框，导致 popup 失焦关闭（settings 是 tab 页不受影响）。
- 所以权限申请放在保存最后——配置已持久化，用户重开 popup 即可继续。
- settings 页因为是 tab 页，不会因失焦关闭，权限弹窗会正常显示。

### testEmbedding/testLLM 先保存再测试

- `testEmbedding()` / `testLLM()` / `testVectorConnection()` 都是先调 `saveSettings()` 持久化当前表单值，再发 `TEST_XXX` 消息。
- 这样确保 SW 端用最新的配置测试，避免"测试用的是旧配置"问题。
- `saveSettings` 返回 false 时（如校验失败）不进行测试。
- `testVectorConnection` 用 `saveVectorStoreSettings({ interactive: false })` 静默保存（不弹后端切换询问），避免测试时被询问打断。

### 自定义模型 ID 的兼容

- 豆包等厂商用 Endpoint ID（如 `ep-20240901xxxxx`）调用，modelMeta 匹配不上 models.json 中的 `id`。
- `updateEmbeddingModelHelp` 显示"自定义模型 ID"提示。
- `updateOpenaiThinkingByModel` 用 `provider.fallbackThinking` 作为默认思考模式（豆包是 `hybrid`）。
- `applyOpenaiPreset` 在模型匹配不上时仍填充模型下拉（用户可从列表选或直接输入 Endpoint ID）。

### 思考开关的 userTouched 标记

- `openaiEnableThinking.addEventListener('change', () => { openaiEnableThinking.dataset.userTouched = '1'; })`。
- `updateOpenaiThinkingByModel` 中 `if (!openaiEnableThinking.dataset.userTouched)` 才自动改开关状态。
- 用户手动改过开关后，切换模型不再自动改开关——避免覆盖用户选择。
- `loadSettings` 时若 `llmConfig.enableThinking !== undefined`，设 `dataset.userTouched = '1'`（恢复用户保存的设置）。

### retrievalMode 的 UI 联动

- `updateRetrievalModeUI()` 按 mode 显示/隐藏 TopK 与阈值输入框：
  - `topk`：显示 TopK，隐藏阈值。
  - `threshold`：隐藏 TopK，显示阈值（实际 topK 在 SW 端放大到 100）。
  - `combined`：都显示。
- `retrievalModeDesc` 显示对应说明文字。
- 改 mode 时触发 `updateRetrievalModeUI`，加载设置时也要调用一次。

### saveVectorStoreSettings 的 backendChanged 判定

- `oldBackend !== newBackend`（local↔remote 切换）。
- 或 `remote→remote` 且 `type` / `url` / `collection` 任一变化。
- `apiKey` 单独变化不算（不改变数据位置，不触发清理/重建）。
- `interactive=true` 时若 backendChanged，confirm 询问是否清空旧后端 + 重建新后端；`interactive=false`（测试连通性用）不询问。

### chunkSize/chunkOverlap 的前端校验

- `chunkSize` 最小 100（`if (isNaN(sizeVal) || sizeVal < 100)`）。
- `chunkOverlap` 最小 0。
- `overlap >= size` 时报错（`if (overlapVal >= sizeVal)`）。
- 实时校验：`chunkSize.addEventListener('input', ...)` 用 `setCustomValidity` + `reportValidity` 显示原生错误提示。

### SectionObserver 隐藏保存按钮

- settings.js 用 `IntersectionObserver` 监听"存储位置"与"数据管理"section 是否滚动到 sticky header 下方。
- `rootMargin: '-36px 0px -100% 0px'`：顶部排除 sticky header（约 36px），底部 -100% 把 root 收缩成 header 下边缘的一条线。
- 当 section 顶部抵达 header 下方时，`saveBtn.classList.add('hidden')` 隐藏保存按钮（避免遮挡 section 内容）。
- 改 sticky header 高度时需同步调整 `rootMargin` 的 `-36px`。

### urlToOrigin 的容错

- `urlToOrigin(rawUrl)` 用 `new URL(rawUrl)` 解析，失败返回 null。
- 用于权限申请：`chrome.permissions.contains({ origins: [`${origin}/*`] })` 检查是否已授权。
- 用户填的 URL 可能带路径（如 `http://localhost:6333/collections`），`origin` 提取为 `http://localhost:6333`。
- 不容错的情况：用户填了非法 URL（如 `localhost:6333` 缺协议），`new URL` 抛错，权限申请跳过（配置仍保存）。

### loadModelsCatalog 失败的 fallback

- `loadModelsCatalog()` fetch 失败时 `modelsCatalog = { llmProviders: [], embeddingProviders: [] }`。
- 下拉只显示"自定义"选项，用户需手动填写 baseUrl/model。
- 不阻塞 `loadSettings`，用户仍能编辑已保存的配置。

### 平台 checkbox 的默认值

- `loadSettings` 中 `platformFudan.checked = platformResp.fudan !== false;`（fudan 默认开启，其他默认关闭）。
- `platformResp.deepseek === true` 才勾选（deepseek 默认关闭）。
- 改默认行为时注意这个不对称——fudan 用 `!== false`，其他用 `=== true`。

### Kimi 的网络拦截 radio disabled

- `settings.html` 中 Kimi 的"网络拦截"radio 是 `disabled`：
  ```html
  <label title="Kimi 使用 WebSocket + protobuf，不支持网络拦截">
    <input type="radio" name="kimi-mode" value="network" disabled>网络拦截
  </label>
  ```
- `saveSettings` 中 Kimi 的 mode 固定 `'dom'`（`kimi: 'dom'`），不读 radio 值。
- 改 settings.html 时不要去掉 `disabled`，否则用户能选但保存后 SW 端不认。

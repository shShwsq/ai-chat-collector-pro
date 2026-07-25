# Tasks

## 后端
- [ ] Task 1: 扩展 `routers/plugin.py` 与 `schemas.py`，实现幂等去重、平台白名单、metadata 校验、WebSocket 广播
  - [ ] SubTask 1.1: 在 `schemas.py` 扩展 `PluginConversationResponse` 增加 `deduplicated: bool` 字段；新增 `PluginHealthResponse`、`PluginRecentConversationItem` schema
  - [ ] SubTask 1.2: 在 `graph_store.py` 新增 `list_observations_by_source(source, limit)` 与 `find_observation_by_dedup_key(dedup_key, within_hours=24)` 方法
  - [ ] SubTask 1.3: 在 `plugin.py` 顶部定义白名单常量 `SUPPORTED_PLATFORMS = {"chatgpt","claude","gemini","deepseek","qwen","doubao","kimi","fudan","custom"}`
  - [ ] SubTask 1.4: `push_conversation` 实现：白名单校验 → dedup_key 计算（基于 `metadata.conversation_id`）→ 查重 → 落库 → ws_notify.broadcast → 返回（含 deduplicated 字段）
  - [ ] SubTask 1.5: 扩展 `GET /contract` 返回 `version / supported_platforms / push_examples`
  - [ ] SubTask 1.6: 新增 `GET /conversations/recent?limit=20` 端点
  - [ ] SubTask 1.7: 新增 `GET /health` 端点（返回版本、平台列表、当前 ws 连接数或队列长度）

## 前端
- [ ] Task 2: 在 `SettingsPanel.tsx` 新增「插件对接」分区
  - [ ] SubTask 2.1: 在 `api.ts` 新增 `getPluginContract() / getPluginRecent(limit) / getPluginHealth()` 三个接口
  - [ ] SubTask 2.2: 在 `useAppStore.ts` 新增 `pluginRecent / pluginRecentLoading / pluginContract` 状态 + `loadPluginRecent / loadPluginContract` 动作
  - [ ] SubTask 2.3: 在 `ws.ts` 订阅 `plugin.conversation_received` 事件，回调写入 store 并触发 Toast
  - [ ] SubTask 2.4: 在 `useAppStore.ts` 新增 WebSocket 事件处理：收到 `plugin.conversation_received` 时调用 `pushToast` + 若当前 activeNav='graph' 且 mode='study' 则触发 `loadPendingNodes`
  - [ ] SubTask 2.5: 新增子组件 `PluginIntegrationSection.tsx`，渲染：webhook URL（可复制）、平台 chip 列表、「查看契约」按钮（弹窗 + JSON 高亮 + 复制）、最近推送记录列表（最多 20 条）、手动刷新按钮
  - [ ] SubTask 2.6: 在 `SettingsPanel.tsx` 中引入 `PluginIntegrationSection`，放在 API 配置区与请求队列区之间
  - [ ] SubTask 2.7: 在 `app.css` 新增 `.plugin-section / .plugin-url-box / .plugin-platform-chips / .plugin-recent-list / .plugin-contract-modal` 样式

## Plugin SDK
- [ ] Task 3: 创建 `knowledge-work-assistant/plugin-sdk/` 目录与核心文件
  - [ ] SubTask 3.1: 创建 `kwa-push.js`（UMD 模块，导出 `pushConversation` 函数，支持配置 webhook URL、超时、重试）
  - [ ] SubTask 3.2: 创建 `kwa-push.d.ts`（TypeScript 类型定义，与后端 schema 对齐）
  - [ ] SubTask 3.3: 创建 `README.md`（使用说明、API 文档、联调自检流程、暂不鉴权风险提示）
- [ ] Task 4: 创建 `plugin-sdk/example/chrome-extension/` 最小可运行示例
  - [ ] SubTask 4.1: `manifest.json`（MV3，含 popup 与可选 content script）
  - [ ] SubTask 4.2: `popup/popup.html` + `popup/popup.css` + `popup/popup.js`（一个「推送测试对话」按钮 + 结果显示区）
  - [ ] SubTask 4.3: `background.js`（引入 `kwa-push.js`，监听 popup 消息调用推送）
  - [ ] SubTask 4.4: 验证：加载扩展 → 点击按钮 → 本机后端 `/api/plugin/conversations` 收到测试对话
- [ ] Task 5: 创建 `plugin-sdk/ui/` 统一样式包与规范文档
  - [ ] SubTask 5.1: 创建 `kwa-plugin.css`（导出 `--kwa-accent / --kwa-surface / --kwa-border / --kwa-text / --kwa-radius-sm/md/lg` 等变量 + `.kwa-btn / .kwa-card / .kwa-badge / .kwa-input / .kwa-chip` 组件类；含 study/work 双模式变量）
  - [ ] SubTask 5.2: 创建 `style-guide.md`（颜色变量表、字体栈、圆角、阴影、组件外观、交互模式、暗色模式预留、暂不鉴权风险提示）

## 二次开发 patch
- [ ] Task 6: 创建 `plugin-sdk/secondary-dev/` 目录与 patch 文件
  - [ ] SubTask 6.1: `kwa-push-handler.js`（监听 chrome.runtime 消息 `'conversation_collected'` → 调用 `pushConversation`；含开关、500ms 节流、3 次指数退避重试）
  - [ ] SubTask 6.2: `styles.patch.js`（替换原 `content/ui/styles.js` 中所有 `#2563eb / #1d4ed8 / #667eea` 为 `var(--kwa-accent)` 等变量；在 `inject()` 方法中追加 `<link>` 引入 `kwa-plugin.css`）
  - [ ] SubTask 6.3: `settings.patch.html`（一段 HTML 片段，含「推送目标 URL」输入框 + 「测试推送」按钮 + 状态提示）
  - [ ] SubTask 6.4: `settings.patch.js`（在原 `settings.js` 加载时注入 patch UI；保存到 `chrome.storage.local.kwaPushUrl`；「测试推送」调用 `pushConversation` 发一条空对话）
  - [ ] SubTask 6.5: `PATCH-GUIDE.md`（备份原文件 → 复制 patch 文件到对应位置 → 修改 `manifest.json` 的 `background.service_worker` 与 `content_scripts.js` 引入 patch → 重载扩展）

## Git 安全
- [ ] Task 7: 修正 `.gitignore` 与 git 追踪
  - [ ] SubTask 7.1: 在根目录 `.gitignore` 追加 `步影/` 与 `web-ai-chat-collector/` 两条规则
  - [ ] SubTask 7.2: 执行 `git rm --cached -r 步影 web-ai-chat-collector`（仅移除追踪，不删本地文件）
  - [ ] SubTask 7.3: 验证 `git status` 中两个目录不再出现

## 验证
- [ ] Task 8: 端到端联调验证
  - [ ] SubTask 8.1: 启动后端，调用 `GET /api/plugin/health` 返回正常
  - [ ] SubTask 8.2: 调用 `POST /api/plugin/conversations` 推送一条测试对话 → 返回 `received: true, deduplicated: false` → 再次推送相同 conversation_id → 返回 `deduplicated: true`
  - [ ] SubTask 8.3: 启动前端，进入 SettingsPanel 看到「插件对接」分区，URL/平台/最近记录显示正确
  - [ ] SubTask 8.4: 点击「查看契约」弹窗展示 JSON
  - [ ] SubTask 8.5: 加载 `plugin-sdk/example/chrome-extension/` → 点击推送按钮 → 前端实时弹 Toast「收到新对话：xxx」→ 最近记录列表刷新
  - [ ] SubTask 8.6: 应用 secondary-dev patch 到一份原插件副本 → 重载 → 模拟采集对话 → 本应用后端收到推送

# Task Dependencies
- Task 2 依赖 Task 1（前端调用后端新端点）
- Task 4 依赖 Task 3（示例扩展使用 SDK）
- Task 6 依赖 Task 3 + Task 5（patch 文件引用 SDK 与样式包）
- Task 8 依赖 Task 1 ~ Task 7 全部完成
- Task 1、Task 3、Task 5、Task 7 可并行启动

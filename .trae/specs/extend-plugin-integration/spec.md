# 浏览器插件对接增强 Spec

## Why
原 `build-knowledge-work-assistant` 仅预留了 `POST /api/plugin/conversations` 的「接收 + 持久化」空实现，参考素材 `web-ai-chat-collector/` 也不主动推送外部服务（只本地 IndexedDB + 下载导出）。本次迭代把插件对接做实：①后端扩展契约自检、幂等去重、平台白名单、WebSocket 实时广播；②前端 SettingsPanel 新增「插件对接」分区（URL/平台/最近推送/契约查看）；③在仓库内新增 `plugin-sdk/`（含推送 SDK、TypeScript 类型、最小示例扩展、可引用样式包 `kwa-plugin.css`、UI 风格规范文档）；④提供对原 `web-ai-chat-collector` 的二次开发 patch（推送 handler + 主色统一），patch 文件独立存放不污染原素材；⑤修正根目录 `.gitignore`，确保「步影」与「web-ai-chat-collector」两个素材目录不被推到远程。

## What Changes
- **后端 `plugin.py` 增强**：
  - `POST /api/plugin/conversations` 增加幂等去重（基于 `metadata.conversation_id`，命中重复返回 200 + `deduplicated: true`，不写新记录）。
  - 增加来源平台白名单校验：`chatgpt / claude / gemini / deepseek / qwen / doubao / kimi / fudan / custom`，未命中返回 400。
  - `metadata` 字段类型校验（`title / url / model` 若提供必须为 string）。
  - 推送成功后通过 `ws_notify.broadcast({type: 'plugin.conversation_received', payload: {...}})` 广播给所有前端连接。
  - `GET /api/plugin/contract` 扩展返回字段：增加 `version`、`supported_platforms[]`、`push_examples[]`。
  - 新增 `GET /api/plugin/conversations/recent?limit=20`：返回最近 N 条 source='plugin' 的 Observation（含 platform / title / timestamp / observation_id / dedup_key）。
  - 新增 `GET /api/plugin/health`：返回 `{ok: true, version, supported_platforms, queue_size}`，供插件方联调自检。
- **前端「插件对接」面板（SettingsPanel 新分区）**：
  - 显示后端 webhook 完整 URL（如 `http://127.0.0.1:8000/api/plugin/conversations`，端口取自后端配置）。
  - 显示支持的平台列表（chip 形式）。
  - 「最近推送记录」列表（最多 20 条，显示 platform / title / timestamp / 是否去重），支持手动刷新。
  - 「查看契约」按钮：弹窗展示 `/api/plugin/contract` 完整 JSON（语法高亮 + 复制按钮）。
  - 监听 WebSocket `plugin.conversation_received` 事件 → 全局 Toast「收到新对话：{title}」；若当前在 study 模式图谱视图，刷新 PendingNodes。
- **`plugin-sdk/`（仓库内新增目录，独立可发布）**：
  - `kwa-push.js`：UMD 模块的推送函数 `pushConversation({platform, timestamp, conversationMarkdown, metadata})`，返回 Promise。
  - `kwa-push.d.ts`：TypeScript 类型定义，与后端 `PluginConversationRequest` 字段对齐。
  - `README.md`：使用说明 + 联调自检流程。
  - `example/chrome-extension/`：最小可加载的 Chrome MV3 扩展示例（含 manifest.json + popup + content script，演示如何调用 `kwa-push`）。
  - `ui/kwa-plugin.css`：可被插件 `<link>` 引用的样式包，导出主应用的 CSS 变量（`--kwa-accent / --kwa-surface / --kwa-border / --kwa-text` 等）+ 组件类（`.kwa-btn / .kwa-card / .kwa-badge / .kwa-input`）。
  - `ui/style-guide.md`：UI 风格规范文档（颜色变量表、字体栈、圆角、阴影、组件外观、交互模式、暗色模式预留）。
- **二次开发 patch（独立目录 `plugin-sdk/secondary-dev/`，不修改原素材）**：
  - `kwa-push-handler.js`：注入到原插件 background 的 handler，监听对话采集完成事件，调用 `kwa-push` 推送到本应用后端；含开关（默认开启）、批量节流（500ms）、失败重试（最多 3 次指数退避）。
  - `styles.patch.js`：替换原插件 `content/ui/styles.js` 中的硬编码 `#2563eb` 为 `var(--kwa-accent)` 等变量，并 `<link>` 引入 `kwa-plugin.css`。
  - `settings.patch.html` / `settings.patch.js`：在原插件设置页新增「推送目标 URL」输入框（默认 `http://127.0.0.1:8000/api/plugin/conversations`）+ 「测试推送」按钮。
  - `PATCH-GUIDE.md`：手动应用 patch 的步骤说明（备份 → 复制文件 → 修改 manifest → 重载扩展）。
- **Git 安全**：
  - 修正根目录 `.gitignore`，追加 `步影/` 和 `web-ai-chat-collector/` 两条规则。
  - 若已被跟踪，使用 `git rm --cached -r` 移除追踪（不删本地文件）。
- **暂不鉴权**：本轮不做 token / Origin 校验，仅本机环境使用；在 `style-guide.md` 与 `README.md` 中明确风险提示。

## Impact
- Affected specs: `build-knowledge-work-assistant`（在其插件对接预留接口基础上做实）
- Affected code:
  - 后端：`routers/plugin.py`（增强 + 新端点）、`schemas.py`（扩展 `PluginConversationResponse` 加 `deduplicated` 字段、新增 `PluginHealthResponse`、`PluginRecentConversationItem`）、`services/ws_notify.py`（确认 broadcast 接口可用）、`graph_store.py`（`list_observations_by_source` 新方法）。
  - 前端：`SettingsPanel.tsx`（新增「插件对接」分区子组件 `PluginIntegrationSection`）、`useAppStore.ts`（新增 `pluginRecent` 状态 + `loadPluginRecent` 动作 + WebSocket 事件订阅 `plugin.conversation_received`）、`api.ts`（新增 `getPluginContract / getPluginRecent / getPluginHealth`）、`ws.ts`（订阅新事件类型）、`app.css`（新分区样式）。
  - 新目录：`knowledge-work-assistant/plugin-sdk/`（含 `kwa-push.js / kwa-push.d.ts / README.md / example/ / ui/ / secondary-dev/`）。
  - 配置：根目录 `.gitignore` 追加两条规则。
- 不修改：`步影/` 与 `web-ai-chat-collector/` 目录内任何文件（二次开发 patch 独立存放在 `plugin-sdk/secondary-dev/`）。

## ADDED Requirements

### Requirement: 后端插件接口增强
The system SHALL extend the plugin webhook with idempotency, platform whitelist, metadata validation, and WebSocket broadcast.

#### Scenario: 幂等去重
- **WHEN** 插件推送的 `metadata.conversation_id` 在最近 24h 内已存在
- **THEN** 后端不写新 Observation，返回 `{received: true, deduplicated: true, observation_id: <existing>}`，HTTP 200

#### Scenario: 平台白名单
- **WHEN** 推送的 `platform` 不在白名单（chatgpt/claude/gemini/deepseek/qwen/doubao/kimi/fudan/custom）
- **THEN** 返回 400 + `{detail: "unsupported platform: xxx"}`

#### Scenario: WebSocket 实时广播
- **WHEN** 推送成功落库
- **THEN** 后端通过 ws_notify 广播 `{type: 'plugin.conversation_received', payload: {observation_id, platform, title, timestamp}}`，所有连接的前端收到事件

#### Scenario: 契约自检端点
- **WHEN** 插件方调用 `GET /api/plugin/health`
- **THEN** 返回 `{ok: true, version: "1.0", supported_platforms: [...], queue_size: <int>}`，HTTP 200

#### Scenario: 最近推送记录
- **WHEN** 前端调用 `GET /api/plugin/conversations/recent?limit=20`
- **THEN** 返回最近 20 条 source='plugin' 的 Observation 元数据（observation_id / platform / title / timestamp / dedup_key），按时间倒序

### Requirement: 前端插件对接面板
The system SHALL add a "Plugin Integration" section in SettingsPanel showing webhook URL, supported platforms, recent pushes, and contract viewer.

#### Scenario: 显示面板
- **WHEN** 用户进入 SettingsPanel
- **THEN** 看到「插件对接」分区，显示：webhook URL（可一键复制）、支持平台 chip 列表、「查看契约」按钮、最近推送记录列表（最多 20 条）

#### Scenario: 查看契约
- **WHEN** 用户点击「查看契约」
- **THEN** 弹窗展示 `/api/plugin/contract` 完整 JSON，支持语法高亮与复制

#### Scenario: 实时推送 Toast
- **WHEN** 前端收到 WebSocket `plugin.conversation_received` 事件
- **THEN** 全局 Toast 提示「收到新对话：{title}」（3 秒自动消失）；若当前在 study 模式图谱视图，自动刷新 PendingNodes

### Requirement: 插件推送 SDK
The system SHALL provide a JS SDK and TypeScript types in `plugin-sdk/` for the plugin developer to push conversations.

#### Scenario: SDK 调用
- **WHEN** 插件方在 background 调用 `pushConversation({platform: 'deepseek', timestamp: new Date().toISOString(), conversationMarkdown: '...', metadata: {conversation_id: 'xxx', title: '...', url: '...'}})`
- **THEN** SDK 通过 fetch POST 到配置的 webhook URL，返回 `{received, deduplicated, observation_id}`；失败时抛错并支持重试

#### Scenario: 最小示例扩展
- **WHEN** 开发者加载 `plugin-sdk/example/chrome-extension/` 到 chrome://extensions
- **THEN** 弹出 popup 演示一个「推送测试对话」按钮，点击后调用 SDK，本机后端收到对话

### Requirement: 统一 UI 风格规范
The system SHALL provide a `kwa-plugin.css` style pack and a `style-guide.md` document for plugins to align with the main app's visual language.

#### Scenario: 引用样式包
- **WHEN** 插件在页面 `<link rel="stylesheet" href=".../kwa-plugin.css">`
- **THEN** 插件可用 `.kwa-btn / .kwa-card / .kwa-badge / .kwa-input` 等类名，颜色取自主应用的 `--accent`（study 墨绿 / work 琥珀）、字体栈、圆角、阴影一致

#### Scenario: 风格规范文档
- **WHEN** 开发者阅读 `plugin-sdk/ui/style-guide.md`
- **THEN** 文档列出：颜色变量表（含 study/work 双模式）、字体栈、圆角（6/8/12）、阴影、组件外观（按钮/卡片/徽标/输入框）、交互模式（hover/active 过渡时长）、暗色模式预留

### Requirement: 二次开发 patch
The system SHALL provide patch files in `plugin-sdk/secondary-dev/` that add push capability and unify UI style to the original web-ai-chat-collector plugin, without modifying the original source.

#### Scenario: 推送 handler 注入
- **WHEN** 开发者按 `PATCH-GUIDE.md` 把 `kwa-push-handler.js` 注入原插件 background
- **THEN** 原插件采集到对话后自动调用 `kwa-push` 推送到本应用后端；推送目标 URL 可在设置页配置，默认 `http://127.0.0.1:8000/api/plugin/conversations`

#### Scenario: 主色统一
- **WHEN** 开发者应用 `styles.patch.js` 替换原插件 `content/ui/styles.js`
- **THEN** 原插件浮动球/面板/查看器的主色由硬编码 `#2563eb` 改为 `var(--kwa-accent)`，并 `<link>` 引入 `kwa-plugin.css`

#### Scenario: 设置页新增推送配置
- **WHEN** 开发者应用 `settings.patch.html` + `settings.patch.js`
- **THEN** 原插件设置页新增「推送目标 URL」输入框（含「测试推送」按钮），保存到 chrome.storage.local

### Requirement: Git 安全
The system SHALL ensure the reference material directories (`步影/` and `web-ai-chat-collector/`) are not pushed to the remote repository.

#### Scenario: gitignore 追加
- **WHEN** 开发者执行 `git status`
- **THEN** `步影/` 与 `web-ai-chat-collector/` 不出现在待提交列表；若已被跟踪，`git rm --cached -r` 移除追踪但不删本地文件

## MODIFIED Requirements

### Requirement: 浏览器插件对接接口（原 build-knowledge-work-assistant 预留）
原预留接口仅做接收 + 持久化，本次扩展为：幂等去重 + 平台白名单 + metadata 校验 + WebSocket 实时广播 + 契约自检 + 最近记录查询。原 `POST /api/plugin/conversations` 端点路径与请求体契约不变，仅扩展响应字段（增加 `deduplicated`）。

## REMOVED Requirements
无（本次为增量扩展，不移除既有能力；暂不鉴权为有意保留，后续迭代可加 token）。

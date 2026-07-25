# 验收清单

## 后端插件接口增强
- [ ] `POST /api/plugin/conversations` 推送新对话返回 `{received: true, deduplicated: false, observation_id: "..."}`
- [ ] 同一 `metadata.conversation_id` 在 24h 内重复推送，返回 `deduplicated: true`，不写新记录
- [ ] 推送 `platform: "unknown_platform"` 返回 400 + `{detail: "unsupported platform: unknown_platform"}`
- [ ] 推送 `metadata.title: 123`（非 string）返回 422
- [ ] 推送成功后前端 WebSocket 收到 `{type: 'plugin.conversation_received', payload: {observation_id, platform, title, timestamp}}`
- [ ] `GET /api/plugin/contract` 返回包含 `version / supported_platforms / push_examples` 字段
- [ ] `GET /api/plugin/conversations/recent?limit=20` 返回最多 20 条记录，按时间倒序，字段含 observation_id / platform / title / timestamp / dedup_key
- [ ] `GET /api/plugin/health` 返回 `{ok: true, version, supported_platforms, queue_size}`

## 前端插件对接面板
- [ ] 进入 SettingsPanel 看到「插件对接」分区，位于 API 配置区与请求队列区之间
- [ ] 显示后端 webhook URL（如 `http://127.0.0.1:8000/api/plugin/conversations`），含「复制」按钮
- [ ] 显示支持平台 chip 列表（chatgpt/claude/gemini/deepseek/qwen/doubao/kimi/fudan/custom）
- [ ] 「查看契约」按钮点击后弹窗展示完整 JSON，含语法高亮与复制按钮
- [ ] 「最近推送记录」列表显示最多 20 条，每条含 platform / title / timestamp / 是否去重徽标
- [ ] 「刷新」按钮可手动刷新最近记录
- [ ] 收到 WebSocket `plugin.conversation_received` 事件时，全局 Toast 显示「收到新对话：{title}」（3 秒自动消失）
- [ ] 若当前在 study 模式图谱视图（activeNav='graph' && mode='study'），收到事件后 PendingNodes 自动刷新

## Plugin SDK
- [ ] `knowledge-work-assistant/plugin-sdk/kwa-push.js` 存在，导出 UMD 模块，含 `pushConversation` 函数
- [ ] `kwa-push.d.ts` 类型定义完整，与后端 `PluginConversationRequest` 字段对齐
- [ ] `README.md` 含使用说明、API 文档、联调自检流程、暂不鉴权风险提示
- [ ] `example/chrome-extension/` 可加载到 chrome://extensions，popup 显示「推送测试对话」按钮
- [ ] 点击示例扩展按钮 → 本机后端收到测试对话 → 前端 Toast 弹出

## 统一 UI 风格规范
- [ ] `plugin-sdk/ui/kwa-plugin.css` 存在，导出 `--kwa-accent / --kwa-surface / --kwa-border / --kwa-text / --kwa-radius-sm/md/lg` 等变量
- [ ] 含 `.kwa-btn / .kwa-card / .kwa-badge / .kwa-input / .kwa-chip` 组件类
- [ ] 含 study 模式（墨绿 `#1a7f6e`）与 work 模式（琥珀 `#b45309`）双模式变量
- [ ] `style-guide.md` 含颜色变量表、字体栈、圆角（6/8/12）、阴影、组件外观、交互模式、暗色模式预留

## 二次开发 patch
- [ ] `plugin-sdk/secondary-dev/kwa-push-handler.js` 存在，含开关、500ms 节流、3 次指数退避重试逻辑
- [ ] `plugin-sdk/secondary-dev/styles.patch.js` 替换原 `#2563eb / #1d4ed8 / #667eea` 为 `var(--kwa-accent)` 等变量，并追加 `<link>` 引入 `kwa-plugin.css`
- [ ] `plugin-sdk/secondary-dev/settings.patch.html` 含「推送目标 URL」输入框 + 「测试推送」按钮
- [ ] `plugin-sdk/secondary-dev/settings.patch.js` 保存 URL 到 `chrome.storage.local.kwaPushUrl`，「测试推送」调用 `pushConversation`
- [ ] `plugin-sdk/secondary-dev/PATCH-GUIDE.md` 含完整应用步骤（备份 → 复制 → 改 manifest → 重载）
- [ ] 原素材目录 `web-ai-chat-collector/` 内文件未被修改

## Git 安全
- [ ] 根目录 `.gitignore` 包含 `步影/` 与 `web-ai-chat-collector/` 两条规则
- [ ] `git status` 中 `步影/` 与 `web-ai-chat-collector/` 不出现在待提交列表
- [ ] 两个素材目录的本地文件未被删除（仅移除 git 追踪）

## 端到端
- [ ] 后端 health 端点正常返回
- [ ] 推送 → 去重 → WebSocket 广播 → 前端 Toast 与最近记录刷新链路完整
- [ ] 示例扩展可加载并成功推送测试对话
- [ ] secondary-dev patch 应用到原插件副本后，模拟采集可触发推送
- [ ] 全流程无报错，UI 风格统一（study/work 双模式色彩正确）

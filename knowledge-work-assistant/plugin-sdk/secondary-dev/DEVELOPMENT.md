# secondary-dev/ 二次开发 Patch 开发指南

> 一句话定位：本目录是 KWA 插件 SDK 的"二次开发 patch 层"，向原 [web-ai-chat-collector](../../../web-ai-chat-collector/) 浏览器插件（Chrome MV3 扩展）提供两类 patch：**对话推送 patch**（采集到 AI 对话后自动推送到本机后端 `POST /api/plugin/conversations`）+ **UI 风格统一 patch**（硬编码主色替换为 CSS 变量 + `<link>` 引入统一样式包，随主应用 study / work 双模式联动）。所有 patch 文件独立存放在本目录，**不修改原 `web-ai-chat-collector/` 目录**，仅在副本上手动应用。

## 模块职责

```
secondary-dev/
├── kwa-push-handler.js       # background 推送 handler：监听采集事件 → 调用 pushConversation
├── styles.patch.js           # 替换 content/ui/styles.js（覆盖原文件）：硬编码主色 → CSS 变量
├── settings.patch.html       # 设置页 HTML 片段：「知识工作助手推送」分区
├── settings.patch.js         # 设置页 patch 脚本：保存 URL + 测试推送按钮
└── PATCH-GUIDE.md            # 手动应用 patch 的步骤说明（9 步 + 验证 + 回滚 + 注意事项）
```

## 关键文件说明

### `kwa-push-handler.js`（Background 推送 Handler）

- **职责**：监听原插件采集流程发出的 `conversation_collected` 事件，调用 `KwaPush.pushConversation` 推送到本机后端。
- **引入方式**：在原插件 `background.js` 的 `importScripts` 链末尾追加 `importScripts('kwa-push.js', 'kwa-push-handler.js')`（顺序不可颠倒，`KwaPush` 必须先于 handler 引入）。
- **节流窗口**：`DEDUP_WINDOW_MS` 默认 500ms，相同 `metadata.conversation_id` 在此窗口内重复触发只推送一次，避免采集器抖动。
- **事件 payload 期望**：
  ```js
  {
    type: 'conversation_collected',
    payload: {
      platform: '<platform>',
      timestamp: new Date().toISOString(),
      conversationMarkdown: markdown,
      metadata: { conversation_id, title, url, model }
    }
  }
  ```
- **转发监听**：注册 `kwa_push_test` 转发监听，popup 中无 `importScripts` 时通过 `chrome.runtime.sendMessage` 转发给 background，由 SW 中的 handler 调用 `KwaPush` 完成推送。
- **重要提醒**：原插件采集流程默认不会主动发出 `conversation_collected` 事件；需在 `bg/conversations.js` 或 `bg/data-handlers.js` 落库成功后补发该事件（属于「进阶改造」，详见 [PATCH-GUIDE.md](PATCH-GUIDE.md) Step 5）。

### `styles.patch.js`（样式 Patch）

- **职责**：整体覆盖原插件 `content/ui/styles.js`，保留原 `makeDraggable` / `AIChatStyles.inject` / `mainCSS` / `mathCSS` 全部功能，仅做两处改动：
  1. 把硬编码主色 `#2563eb` / `#1d4ed8` / `#667eea` 等蓝紫色替换为 CSS 变量 `var(--kwa-accent)` 等。
  2. 在 `inject()` 末尾追加动态创建 `<link>` 引入 `kwa-plugin.css`。
- **引入方式**：用本文件整体覆盖原插件 `content/ui/styles.js`（`Copy-Item -Force`）。
- **效果**：插件浮动球 / 面板 / 查看器颜色随 `data-kwa-mode` 联动（study 墨绿 / work 琥珀）。
- **不修改原文件**：原 `styles.js` 不修改，仅在副本 `web-ai-chat-collector-patched/` 上覆盖。

### `settings.patch.html`（设置页 HTML 片段）

- **职责**：原插件设置页 `popup/settings.html` 的「知识工作助手推送」分区 HTML 片段，含：
  - 推送开关（默认开启）
  - Webhook URL 输入框（默认 `http://127.0.0.1:8788/api/plugin/conversations`）
  - 「测试推送」按钮
  - 测试结果区
- **引入方式**：`settings.patch.js` 会在 DOMContentLoaded 时 `fetch` 本文件并插入到原「数据管理」section 之前；若 fetch 失败（如 `web_accessible_resources` 未配置），回退到内置兜底 HTML，功能等价。

### `settings.patch.js`（设置页 Patch 脚本）

- **职责**：
  1. DOMContentLoaded 时 `fetch` `settings.patch.html` 插入到原设置页「数据管理」section 之前。
  2. 读取 `chrome.storage.local` 中保存的 `kwaPushUrl` / `kwaPushEnabled` 回填表单。
  3. 表单变更时保存到 `chrome.storage.local`。
  4. 「测试推送」按钮点击时调用 `KwaPush.pushConversation`（popup 已引入 `kwa-push.js`）；若 `KwaPush` 未定义（漏引入），回退到 `chrome.runtime.sendMessage` 转发给 background，由 SW 中的 `kwa-push-handler.js` 调用 `KwaPush` 完成推送（handler 中已注册 `kwa_push_test` 转发监听）。
  5. 测试对话内容固定为含 `## 用户` / `## 助手` 的 Markdown，`metadata.conversation_id = 'kwa-test-<timestamp>'`，`title = '连通性测试'`。
- **引入方式**：在原插件 `popup/settings.html` 的 `</body>` 之前追加 `<script src="../kwa-push.js"></script>` 与 `<script src="settings.patch.js"></script>`。

### `PATCH-GUIDE.md`（Patch 应用指南）

- **9 步应用流程**：
  1. 复制 `kwa-push.js` 到 patched 插件根目录
  2. 复制 `kwa-plugin.css` 到 `content/ui/`
  3. 用 `styles.patch.js` 覆盖 `content/ui/styles.js`
  4. 复制 `kwa-push-handler.js` 到 patched 插件根目录
  5. 修改 `background.js` 追加 `importScripts('kwa-push.js', 'kwa-push-handler.js')`（含「进阶改造」补发 `conversation_collected` 事件）
  6. 复制 `settings.patch.html` / `settings.patch.js` 到 `popup/`
  7. 修改 `popup/settings.html` 追加 `<script>` 引入
  8. 修改 `manifest.json` 的 `web_accessible_resources` 加入 `kwa-plugin.css` 与 `popup/settings.patch.html`
  9. 在 `chrome://extensions` 重载扩展
- **验证**：4 项验证（采集 → 推送链路 / 主应用前端面板 / 插件设置页 / UI 风格统一）。
- **回滚**：删除 `web-ai-chat-collector-patched/` 目录或从备份恢复；原 `web-ai-chat-collector/` 从未被修改，无需还原。
- **注意事项**：9 条（不修改原插件 / 暂不鉴权 / 主色已变量化 / importScripts 顺序 / SW 冷启动 / 节流窗口 / 重试策略 / popup 无 importScripts / 回退路径）。
- **patch 文件清单表**：6 个文件的路径 / 用途 / 部署目标。

## 开发工作流

### 应用 patch 到原插件副本

详见 [PATCH-GUIDE.md](PATCH-GUIDE.md) 的 9 步流程。简要步骤：

1. 备份原插件：`Copy-Item -Recurse web-ai-chat-collector web-ai-chat-collector-patched`。
2. 按 Step 1-8 复制 patch 文件并修改 `background.js` / `settings.html` / `manifest.json`。
3. 在 `chrome://extensions` 重载扩展。
4. 按「验证」一节逐项验证。

### 修改 patch 文件

1. 修改本目录中的 patch 文件（如 `kwa-push-handler.js` / `settings.patch.js`）。
2. 把更新后的文件重新复制到 `web-ai-chat-collector-patched/` 对应位置。
3. 在 `chrome://extensions` 重载扩展。
4. 验证修改效果。

### 同步 SDK 升级

1. [kwa-push.js](../kwa-push.js) 升级后，把新版本复制到 `web-ai-chat-collector-patched/kwa-push.js`。
2. 同步复制到 `web-ai-chat-collector-patched/popup/` 引入路径（如 settings.html 的 `<script src="../kwa-push.js">`）。
3. 在 `chrome://extensions` 重载扩展。
4. 验证 SDK 调用正常。

### 修改推送配置

1. **运行时修改**：在 patched 插件设置页「知识工作助手推送」分区修改 Webhook URL 与开关，保存到 `chrome.storage.local`。
2. **代码层修改**：修改 `kwa-push-handler.js` 中的默认配置（如 `KwaPush.configure({ webhookUrl, timeout, maxRetries, retryDelayMs })`）。

## 代码约定

1. **不修改原插件目录**：所有 patch 操作仅在副本 `web-ai-chat-collector-patched/` 上进行；原 [web-ai-chat-collector/](../../../web-ai-chat-collector/) 目录由 `.gitignore` 排除在版本控制外，**不应推送到仓库**（见 [用户要求.md](../../../用户要求.md)）。
2. **patch 文件独立存放**：所有 patch 文件存放在本目录，不与原插件文件混合；应用时复制到 patched 副本对应位置。
3. **`importScripts` 顺序**：`kwa-push.js` 必须先于 `kwa-push-handler.js` 引入，否则 handler 注册时会因 `KwaPush` 未定义而早退。
4. **回退路径**：popup 中若无 `KwaPush`（漏引入 `kwa-push.js`），`settings.patch.js` 的「测试推送」回退到 `chrome.runtime.sendMessage` 转发给 background，由 SW 中的 handler 调用 `KwaPush` 完成推送。
5. **节流窗口**：`DEDUP_WINDOW_MS` 默认 500ms，避免采集器抖动导致重复推送；如需调整，修改 `kwa-push-handler.js` 中常量。
6. **重试策略**：网络层重试由 SDK 内置（默认 3 次指数退避 500ms / 1000ms / 2000ms），handler 层不再叠加；如需更激进的重试，调整 `KwaPush.configure({ maxRetries, retryDelayMs })`。
7. **暂不鉴权**：本轮后端 `/api/plugin/conversations` 不校验 token / Origin，仅本机环境使用；若部署到公网，自行在反向代理层加 token 鉴权。
8. **主色已变量化**：插件 UI 颜色由 [ui/kwa-plugin.css](../ui/kwa-plugin.css) 中的 CSS 变量决定（默认 study 墨绿 / `data-kwa-mode="work"` 琥珀）；切换模式可在原插件浮动球初始化时由主应用通过 `postMessage` 通知，或由用户手动加 attribute。

## 常见任务

### 修改节流窗口

修改 `kwa-push-handler.js` 中 `DEDUP_WINDOW_MS` 常量（默认 500ms）。

### 修改测试推送内容

修改 `settings.patch.js` 中「测试推送」按钮点击时构造的 `conversationMarkdown` / `metadata.title` / `metadata.conversation_id`。

### 添加新的 patch 文件

1. 在本目录创建新 patch 文件（如 `xxx.patch.js`）。
2. 在 [PATCH-GUIDE.md](PATCH-GUIDE.md) 添加对应 Step（复制到 patched 副本 + 修改原插件文件引入）。
3. 在 PATCH-GUIDE.md 的「patch 文件清单表」中添加新文件。
4. 验证 patch 生效。

### 修改 patch 应用步骤

1. 修改 [PATCH-GUIDE.md](PATCH-GUIDE.md) 对应 Step。
2. 在「验证」一节同步更新验证步骤。
3. 在「注意事项」一节补充新增注意点。

## 扩展点

1. **自动 patch 脚本**：当前 patch 应用为手动 9 步流程；可编写 PowerShell / Node 脚本自动应用，减少人为错误。
2. **patch 版本管理**：当前 patch 无版本号；如原插件升级，patch 可能失效；建议在 patch 文件头部标注适用的原插件版本范围。
3. **多插件支持**：当前 patch 仅针对 [web-ai-chat-collector](../../../web-ai-chat-collector/)；如需支持其他采集插件，新建对应 patch 文件并补充 PATCH-GUIDE。
4. **模式联动**：当前 `data-kwa-mode` 需手动设置；可扩展为主应用通过 `postMessage` 通知插件浮动球初始化时自动设置 attribute，实现模式联动。

## 注意事项

1. **不修改原插件目录**：所有 patch 操作仅在副本 `web-ai-chat-collector-patched/` 上进行；原 [web-ai-chat-collector/](../../../web-ai-chat-collector/) 目录由 `.gitignore` 排除，**不应推送到仓库**。
2. **`importScripts` 顺序**：`kwa-push.js` 必须先于 `kwa-push-handler.js` 引入；`background.js` 中 `importScripts('kwa-push.js', 'kwa-push-handler.js')` 顺序不可颠倒。
3. **`web_accessible_resources` 必需**：`kwa-plugin.css` 与 `popup/settings.patch.html` 必须加入 `web_accessible_resources`，否则 content script / popup fetch 时会被拦截。
4. **`conversation_collected` 事件需补发**：原插件采集流程默认不发出此事件；需在 `bg/conversations.js` 或 `bg/data-handlers.js` 落库成功后补发（属「进阶改造」）；若不改，推送 handler 不会被触发，但「测试推送」按钮仍可工作。
5. **popup 中无 `importScripts`**：popup 是普通 HTML 页面，必须用 `<script src>` 引入 `kwa-push.js` 与 `settings.patch.js`；不可在 popup 中调用 Service Worker 专属 API。
6. **回退路径**：若 popup 未引入 `kwa-push.js`（漏掉 Step 7 的第二个 script），`settings.patch.js` 的「测试推送」会自动回退到 `chrome.runtime.sendMessage` 转发给 background，由 SW 中的 handler 调用 `KwaPush` 完成推送。
7. **Service Worker 冷启动**：MV3 SW 会被 Chrome 闲置回收，重新唤醒时 `importScripts` 会重新执行，handler 会重新注册，无需手动处理。
8. **节流窗口**：相同 `metadata.conversation_id` 在 500ms 内重复触发只推送一次，避免采集器抖动；如需调整，修改 `kwa-push-handler.js` 中 `DEDUP_WINDOW_MS`。
9. **重试策略**：网络层重试由 SDK 内置（默认 3 次指数退避），handler 层不再叠加；如需更激进的重试，调整 `KwaPush.configure({ maxRetries, retryDelayMs })`。
10. **暂不鉴权**：后端 `/api/plugin/conversations` 不校验 token / Origin，仅本机环境使用；若部署到公网，自行在反向代理层加 token / Origin / IP 校验。
11. **主色已变量化**：插件 UI 颜色由 [ui/kwa-plugin.css](../ui/kwa-plugin.css) 中的 CSS 变量决定；默认 study 墨绿 `#1a7f6e`，在 `<html>` 上加 `data-kwa-mode="work"` 切换为 work 琥珀 `#b45309`。
12. **patch 文件清单**：6 个文件（`kwa-push.js` / `kwa-plugin.css` / `kwa-push-handler.js` / `styles.patch.js` / `settings.patch.html` / `settings.patch.js`），详见 [PATCH-GUIDE.md](PATCH-GUIDE.md) 末尾的清单表。

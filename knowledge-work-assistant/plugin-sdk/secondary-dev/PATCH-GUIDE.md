# PATCH-GUIDE — web-ai-chat-collector 二次开发 Patch 应用指南

## 1. 概述

本 patch 给原 `web-ai-chat-collector` 浏览器插件（Chrome MV3 扩展）加上两类能力：

1. **对话推送能力**：在采集到 AI 对话后，自动推送到本机知识工作助手（KWA）后端
   `POST /api/plugin/conversations`，由后端持久化为 Observation 待 Agent 抽取；
   并在原插件设置页新增「知识工作助手推送」分区，可配置 URL 与开关。
2. **UI 风格统一**：把原插件浮动球 / 面板 / 查看器中硬编码的 `#2563eb / #1d4ed8 / #667eea`
   蓝紫主色改为 CSS 变量 `var(--kwa-accent)` 等，并 `<link>` 引入 `kwa-plugin.css`，
   使插件 UI 跟随主应用 study（墨绿）/ work（琥珀）双模式。

所有 patch 文件独立存放在 `knowledge-work-assistant/plugin-sdk/secondary-dev/`，
**不修改原 `web-ai-chat-collector/` 目录**。本指南面向开发者手动应用 patch 到原插件副本。

---

## 2. 前置准备

1. **备份原插件目录**：复制 `web-ai-chat-collector/` 为 `web-ai-chat-collector-patched/`，
   本 patch 仅在副本上操作。
   ```powershell
   Copy-Item -Recurse web-ai-chat-collector web-ai-chat-collector-patched
   ```
2. **启动知识工作助手后端**：默认监听 `127.0.0.1:8788`，
   启动后访问 `GET /api/plugin/health` 应返回 `{ok: true, version, supported_platforms, queue_size}`。
3. **准备 SDK 与样式包**（已在仓库内）：
   - `knowledge-work-assistant/plugin-sdk/kwa-push.js`
   - `knowledge-work-assistant/plugin-sdk/ui/kwa-plugin.css`
4. **准备 patch 文件**（本目录）：
   - `kwa-push-handler.js`
   - `styles.patch.js`
   - `settings.patch.html`
   - `settings.patch.js`

> 鉴权提示：本轮后端与插件约定「暂不鉴权」，仅适用于本机 loopback 环境。
> 若后端部署到公网或局域网，需自行在反代层加 token / Origin 校验。

---

## 3. 应用步骤

> 以下所有路径均相对 `web-ai-chat-collector-patched/` 根目录。

### Step 1: 复制 kwa-push.js 到 patched 插件根目录

把 `knowledge-work-assistant/plugin-sdk/kwa-push.js` 复制到 `web-ai-chat-collector-patched/kwa-push.js`。

```powershell
Copy-Item knowledge-work-assistant/plugin-sdk/kwa-push.js `
          web-ai-chat-collector-patched/kwa-push.js
```

### Step 2: 复制 kwa-plugin.css 到 patched 插件 content/ui/ 目录

把 `knowledge-work-assistant/plugin-sdk/ui/kwa-plugin.css` 复制到
`web-ai-chat-collector-patched/content/ui/kwa-plugin.css`。

```powershell
Copy-Item knowledge-work-assistant/plugin-sdk/ui/kwa-plugin.css `
          web-ai-chat-collector-patched/content/ui/kwa-plugin.css
```

### Step 3: 用 styles.patch.js 替换 patched 插件 content/ui/styles.js（覆盖原文件）

用 `secondary-dev/styles.patch.js` 整体覆盖 `web-ai-chat-collector-patched/content/ui/styles.js`。

```powershell
Copy-Item -Force knowledge-work-assistant/plugin-sdk/secondary-dev/styles.patch.js `
                web-ai-chat-collector-patched/content/ui/styles.js
```

> 该文件保留原 `makeDraggable / AIChatStyles.inject / mainCSS / mathCSS` 全部功能，
> 仅把硬编码主色替换为 CSS 变量并在 `inject()` 末尾追加 `<link>` 引入 `kwa-plugin.css`。

### Step 4: 复制 kwa-push-handler.js 到 patched 插件根目录

把 `secondary-dev/kwa-push-handler.js` 复制到 `web-ai-chat-collector-patched/kwa-push-handler.js`。

```powershell
Copy-Item knowledge-work-assistant/plugin-sdk/secondary-dev/kwa-push-handler.js `
          web-ai-chat-collector-patched/kwa-push-handler.js
```

### Step 5: 修改 patched 插件 background.js

打开 `web-ai-chat-collector-patched/background.js`，在原 `importScripts` 链之后追加一行：

```js
importScripts('kwa-push.js', 'kwa-push-handler.js');
```

完整的 background.js 顶部应为：

```js
try {
  // 基础服务层
  importScripts('lib/db.js');
  importScripts('lib/embedding.js');
  importScripts('lib/vector-store.js');
  importScripts('lib/llm.js');
  // SW 业务模块
  importScripts('bg/init.js');
  importScripts('bg/conversations.js');
  importScripts('bg/export.js');
  importScripts('bg/ai-handlers.js');
  importScripts('bg/settings-handlers.js');
  importScripts('bg/vector-handlers.js');
  importScripts('bg/data-handlers.js');
  importScripts('bg/router.js');
  // KWA patch：推送 SDK 与 handler（必须在原 importScripts 链之后）
  importScripts('kwa-push.js', 'kwa-push-handler.js');
} catch (e) {
  console.error('[BG] 加载依赖失败:', e);
}
```

> ⚠️ 注意：原插件采集流程默认不会主动发出 `conversation_collected` 事件。
> 需要在 `bg/conversations.js`（或 `bg/data-handlers.js`）落库成功后补发：
>
> ```js
> chrome.runtime.sendMessage({
>   type: 'conversation_collected',
>   payload: {
>     platform: '<platform>',
>     timestamp: new Date().toISOString(),
>     conversationMarkdown: markdown,
>     metadata: {
>       conversation_id: conversationId,
>       title: title,
>       url: url,
>       model: model
>     }
>   }
> }, function () { /* ignore lastError */ });
> ```
>
> 这一步属于「进阶改造」，若暂不改原插件采集逻辑，则推送 handler 不会被触发，
> 但「测试推送」按钮（在 popup 中独立调用 KwaPush）仍可正常工作。

### Step 6: 复制 settings.patch.html 与 settings.patch.js 到 patched 插件 popup/ 目录

```powershell
Copy-Item knowledge-work-assistant/plugin-sdk/secondary-dev/settings.patch.html `
          web-ai-chat-collector-patched/popup/settings.patch.html
Copy-Item knowledge-work-assistant/plugin-sdk/secondary-dev/settings.patch.js `
          web-ai-chat-collector-patched/popup/settings.patch.js
```

### Step 7: 修改 patched 插件 popup/settings.html

打开 `web-ai-chat-collector-patched/popup/settings.html`，在 `</body>` 之前追加：

```html
<script src="../kwa-push.js"></script>
<script src="settings.patch.js"></script>
```

完整末尾应为：

```html
  <script src="../lib/marked.min.js"></script>
  <script src="settings.js"></script>
  <!-- KWA patch：引入推送 SDK 与设置页 patch -->
  <script src="../kwa-push.js"></script>
  <script src="settings.patch.js"></script>
</body>
```

> `settings.patch.js` 会在 DOMContentLoaded 时自动 fetch `popup/settings.patch.html`
> 并把「知识工作助手推送」section 插入到原「数据管理」section 之前。
> 若 fetch 失败（如 web_accessible_resources 未配置），会回退到内置兜底 HTML，功能等价。

### Step 8: 修改 patched 插件 manifest.json

MV3 `content_scripts` 不能直接引用 CSS 文件让浏览器自动注入；本 patch 已通过
`styles.patch.js` 在 `inject()` 中动态创建 `<link>` 引入 `kwa-plugin.css`，
因此 manifest 中无需在 `content_scripts` 加 CSS 引用。

需要做的是把 `kwa-plugin.css` 与 `popup/settings.patch.html` 加入
`web_accessible_resources`，否则 content script / popup fetch 时会被拦截。

打开 `web-ai-chat-collector-patched/manifest.json`，把 `web_accessible_resources` 改为：

```json
"web_accessible_resources": [
  {
    "resources": [
      "lib/katex.min.css",
      "content/ui/kwa-plugin.css",
      "popup/settings.patch.html"
    ],
    "matches": [
      "https://chat.deepseek.com/*",
      "https://www.qianwen.com/*",
      "https://aiagent.fudan.edu.cn/*",
      "https://www.doubao.com/*",
      "https://kimi.com/*",
      "https://www.kimi.com/*",
      "https://kimi.moonshot.cn/*"
    ]
  }
]
```

> `popup/settings.patch.html` 也需要列入 `web_accessible_resources`，
> 因为 `settings.patch.js` 会用 `chrome.runtime.getURL` + `fetch` 读取它。
> matches 也可以扩展为 `["<all_urls>"]` 以兼容更多平台，但保持最小权限原则建议沿用原列表。

### Step 9: 在 chrome://extensions 重载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `web-ai-chat-collector-patched/` 目录。
3. 若已加载过，点击该扩展卡片上的「刷新」按钮重载。
4. 打开扩展的 Service Worker 控制台（点击「Service Worker」链接），应看到日志：
   `[KWA-Push] kwa-push-handler 已加载，监听 conversation_collected 事件`

---

## 4. 验证

按以下顺序逐项验证 patch 是否生效：

### 4.1 采集 → 推送链路（需完成 Step 5 的「进阶改造」补发事件）

1. 打开任一支持的平台（如 `https://chat.deepseek.com/`），发起一段对话。
2. 等待原插件浮动球采集到对话（出现绿色 badge 数字）。
3. 在 Service Worker 控制台应看到日志：
   `[KWA-Push] 推送成功 ok=true deduplicated=false observation_id=...`
4. 在本机知识工作助手后端日志中应出现 `插件推送对话已接收` 或类似记录。

### 4.2 主应用前端面板

1. 打开知识工作助手前端，进入 SettingsPanel。
2. 在「插件对接」分区应看到最近推送记录（含 platform / title / timestamp）。
3. 若前端处于 study 模式图谱视图，收到 WebSocket `plugin.conversation_received` 事件后
   应弹出 Toast「收到新对话：xxx」并自动刷新 PendingNodes。

### 4.3 插件设置页

1. 点击原插件浮动球 → 设置按钮，打开 `popup/settings.html`。
2. 应看到「知识工作助手推送」分区（位于「数据管理」之前）。
3. 默认开关为开启，URL 为 `http://127.0.0.1:8788/api/plugin/conversations`。
4. 点击「测试推送」按钮：
   - 成功：绿色「✓ 推送成功 observation_id=xxx」
   - 去重：蓝色「✓ 已存在（去重）」（同一 conversation_id 在 24h 内重复推送）
   - 失败：红色「✗ 推送失败：xxx」
5. 测试对话内容为：
   ```
   ## 用户
   测试推送

   ## 助手
   收到，连通性正常
   ```
   metadata.conversation_id = `kwa-test-<timestamp>`，title = `连通性测试`。

### 4.4 UI 风格统一

1. 在已注入 styles.patch.js 的页面上，浮动球颜色应为墨绿（study 默认）。
2. 打开 DevTools 检查 `#ai-chat-ball` 的 `background`，计算值应为 `rgb(26, 127, 110)`。
3. 在 `<html>` 元素上加 `data-kwa-mode="work"`，浮动球应变为琥珀色 `rgb(180, 83, 9)`。

---

## 5. 回滚

1. 删除 `web-ai-chat-collector-patched/` 目录。
2. （若需要）从原备份恢复：
   ```powershell
   Copy-Item -Recurse web-ai-chat-collector web-ai-chat-collector-patched
   ```
3. 在 `chrome://extensions` 中移除已加载的 patched 扩展。

> 原始 `web-ai-chat-collector/` 目录在 patch 过程中从未被修改，无需还原。

---

## 6. 注意事项

1. **不得修改原 `web-ai-chat-collector/` 目录**：所有 patch 操作仅在副本
   `web-ai-chat-collector-patched/` 上进行；本仓库通过 `.gitignore` 把原素材目录
   排除在版本控制外。
2. **暂不鉴权**：本轮后端 `/api/plugin/conversations` 不校验 token / Origin，
   仅本机环境使用。若部署到公网，请自行在反向代理层加 token 鉴权。
3. **主色已变量化**：插件 UI 颜色由 `kwa-plugin.css` 中的 CSS 变量决定：
   - 默认 study 模式（墨绿 `#1a7f6e`）
   - 在 `<html>` 上加 `data-kwa-mode="work"` 切换为 work 模式（琥珀 `#b45309`）
   - 切换模式可在原插件浮动球初始化时由主应用通过 `postMessage` 通知，
     或由用户手动加 attribute；本 patch 不强制实现模式联动逻辑。
4. **importScripts 顺序**：`kwa-push.js` 必须先于 `kwa-push-handler.js` 引入，
   否则 handler 注册时会因 `KwaPush` 未定义而早退。
5. **Service Worker 冷启动**：MV3 SW 会被 Chrome 闲置回收，重新唤醒时
   `importScripts` 会重新执行，handler 会重新注册，无需手动处理。
6. **节流窗口**：相同 `metadata.conversation_id` 在 500ms 内重复触发只推送一次，
   避免采集器抖动；如需调整，修改 `kwa-push-handler.js` 中 `DEDUP_WINDOW_MS`。
7. **重试策略**：网络层重试由 SDK 内置（默认 3 次指数退避 500ms / 1000ms / 2000ms），
   handler 层不再叠加；如需更激进的重试，调整 `KwaPush.configure({ maxRetries, retryDelayMs })`。
8. **popup 中无 importScripts**：popup 是普通 HTML 页面，必须用 `<script src>` 引入
   `kwa-push.js` 与 `settings.patch.js`；不可在 popup 中调用 Service Worker 专属 API。
9. **回退路径**：若 popup 未引入 `kwa-push.js`（如漏掉 Step 7 的第二个 script），
   `settings.patch.js` 的「测试推送」会自动回退到 `chrome.runtime.sendMessage`
   转发给 background，由 SW 中的 `kwa-push-handler.js` 调用 KwaPush 完成推送
   （handler 中已注册 `kwa_push_test` 转发监听）。

---

## 附：patch 文件清单

| 文件 | 路径 | 用途 | 部署目标 |
|------|------|------|---------|
| `kwa-push.js` | `plugin-sdk/kwa-push.js` | 推送 SDK（UMD） | `web-ai-chat-collector-patched/kwa-push.js` |
| `kwa-plugin.css` | `plugin-sdk/ui/kwa-plugin.css` | 统一样式包（CSS 变量 + 组件类） | `web-ai-chat-collector-patched/content/ui/kwa-plugin.css` |
| `kwa-push-handler.js` | `secondary-dev/kwa-push-handler.js` | background 推送 handler | `web-ai-chat-collector-patched/kwa-push-handler.js` |
| `styles.patch.js` | `secondary-dev/styles.patch.js` | 替换 `content/ui/styles.js` | `web-ai-chat-collector-patched/content/ui/styles.js`（覆盖） |
| `settings.patch.html` | `secondary-dev/settings.patch.html` | 设置页 HTML 片段 | `web-ai-chat-collector-patched/popup/settings.patch.html` |
| `settings.patch.js` | `secondary-dev/settings.patch.js` | 设置页 patch 脚本 | `web-ai-chat-collector-patched/popup/settings.patch.js` |

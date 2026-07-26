# example/ 示例扩展开发指南

> 一句话定位：本目录是 KWA 插件 SDK 的"示例扩展层"，仅含一个子目录 `chrome-extension/`，是一个最小可运行的 Chrome MV3 扩展 demo，演示如何通过 [`kwa-push.js`](../kwa-push.js) SDK 把一条测试 AI 对话推送到本机后端 `POST http://127.0.0.1:8788/api/plugin/conversations`。本目录**不参与生产部署**，仅作为 SDK 调用示例与联调自检工具。

## 模块职责

```
example/
└── chrome-extension/         # Chrome MV3 扩展 demo（详见 chrome-extension/README.md）
    ├── manifest.json         # MV3 清单：permissions / host_permissions / background / action
    ├── background.js         # service worker：importScripts 引入 SDK + 监听 popup 消息
    ├── popup/
    │   ├── popup.html        # 弹窗结构：标题 + Webhook URL 显示 + 推送按钮 + 结果区
    │   ├── popup.css         # 弹窗样式：浅色主题 + 墨绿强调色 #1a7f6e
    │   └── popup.js          # 弹窗逻辑：构造测试对话 → sendMessage 给 background
    └── README.md             # 扩展加载与使用说明
```

## 关键文件说明

### `chrome-extension/manifest.json`（MV3 清单）

- `manifest_version: 3`：Chrome MV3 标准。
- `permissions: ["storage"]`：当前 demo 未实际使用 storage，保留以备扩展。
- `host_permissions: ["http://127.0.0.1:8788/*"]`：仅允许访问本机后端 8788 端口；如需访问其他源需扩展此列表。
- `background.service_worker: "background.js"`：MV3 service worker 入口。
- `action.default_popup: "popup/popup.html"`：点击扩展图标弹出 popup。

### `chrome-extension/background.js`（Service Worker）

- **顶层 `importScripts('../../kwa-push.js')`**：引入位于 `plugin-sdk/kwa-push.js` 的 SDK。
  - 路径计算：`background.js` → `example/chrome-extension/` → `../` = `example/` → `../` = `plugin-sdk/`，故 `../../kwa-push.js`。
  - **重要**：Chrome MV3 扩展只能加载扩展根目录之内的文件；`../../kwa-push.js` 位于根目录之外，实际加载会报错 `Failed to fetch imported script`。详见 [chrome-extension/README.md](chrome-extension/README.md) 的「运行时注意」一节，需把 `kwa-push.js` 复制进扩展目录后改为 `importScripts('kwa-push.js')`。
- **`chrome.runtime.onMessage` 监听器**：
  - 收到 `message.type === 'push_test_conversation'` 时调用 `KwaPush.pushConversation(message.payload)`。
  - 成功：`sendResponse({ ok: true, data: resp })`。
  - 失败：`sendResponse({ ok: false, error: { message, name, field, status, attempt } })`，结构化字段便于 popup 渲染。
  - **`return true`**：异步 `sendResponse` 必需，否则消息通道会在监听器返回后立即关闭。
- **非本监听器关心的消息**：`return false`，让其他监听器处理。

### `chrome-extension/popup/popup.html`（弹窗结构）

- 宽度 320px，标题「KWA 推送测试」。
- Webhook URL 显示行（默认 `http://127.0.0.1:8788/api/plugin/conversations`）。
- 中部「推送测试对话」按钮，按钮下方为结果区。
- 底部为测试对话的 Markdown 预览（`<pre>` 显示）。
- 引入 `popup.css` 与 `popup.js`。

### `chrome-extension/popup/popup.js`（弹窗逻辑）

- 点击「推送测试对话」按钮时构造测试对话 payload：
  - `platform: 'custom'`
  - `timestamp`: 当前 ISO8601 时间戳
  - `conversationMarkdown`: 含 `## user` / `## assistant` 的固定 Markdown
  - `metadata.conversation_id`: `'kwa-demo-' + Date.now()`（每次都不同，避免去重）
  - `metadata.title`: `'KWA 示例对话'`
- 通过 `chrome.runtime.sendMessage({ type: 'push_test_conversation', payload })` 发送给 `background.js`。
- 收到响应后渲染到结果区：
  - 成功：`[成功] 推送完成` + `received: true` + `deduplicated: false` + `observation_id: <uuid>`。
  - 去重：`deduplicated: true`（需在 `popup.js` 中固定 `conversation_id` 才能观察）。
  - 失败：`KwaPushError` + `status=0` + `attempt` 次数（默认最多重试 3 次）。

### `chrome-extension/popup/popup.css`（弹窗样式）

- 浅色主题，墨绿强调色 `#1a7f6e`（与主应用 study 模式一致）。
- 不引入 [ui/kwa-plugin.css](../ui/kwa-plugin.css)，样式独立硬编码（demo 简化处理，生产插件应引入样式包）。

### `chrome-extension/README.md`（扩展使用说明）

- 目录结构说明。
- **运行时注意：Chrome MV3 文件访问限制**：详细说明 `importScripts('../../kwa-push.js')` 会报错的原因与两种解决方案（方法 A：复制 SDK 进扩展目录；方法 B：上移扩展根目录到 `plugin-sdk/`）。
- 前置条件：本机后端启动 + Chrome 浏览器。
- 加载扩展到 Chrome 的步骤（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序）。
- 使用流程：点击扩展图标 → 点击「推送测试对话」按钮 → 查看结果区。
- 预期结果：成功 / 去重 / 失败三种情况。
- 鉴权与安全提示。
- 故障排查：扩展加载报错 / 无回应 / 推送失败 status=0 / status=400。

## 开发工作流

### 修改测试对话内容

1. 编辑 `popup/popup.js` 中构造 payload 的部分。
2. 修改 `conversationMarkdown` / `metadata.title` / `metadata.conversation_id` 等字段。
3. 如需观察幂等去重，把 `conversation_id` 固定为常量（如 `'kwa-demo-fixed'`），重复点击按钮第二次会返回 `deduplicated: true`。

### 修改推送目标 URL

1. 当前 demo 不支持运行时修改 URL（直接调用 `KwaPush.pushConversation` 用默认 `webhookUrl`）。
2. 如需修改，在 `background.js` 中调用 `KwaPush.configure({ webhookUrl: '...' })` 后再 `pushConversation`。
3. 或在 `popup.js` 中让用户输入 URL，通过 `sendMessage` 传给 `background.js`，由后者调用 `configure`。
4. 生产场景参考 [secondary-dev/settings.patch.js](../secondary-dev/settings.patch.js) 的实现（保存到 `chrome.storage.local`）。

### 验证 SDK 修改

1. 修改 [kwa-push.js](../kwa-push.js) 后，把更新后的文件复制到 `chrome-extension/kwa-push.js`（按 README 方法 A）。
2. 在 `chrome://extensions` 点击扩展卡片的「刷新」按钮重载。
3. 打开 Service Worker 控制台（点击「Service Worker」链接），查看日志与错误。
4. 点击扩展图标 → 点击「推送测试对话」按钮，验证调用链路。

### 添加新的测试场景

1. 在 `popup.html` 添加新按钮（如「推送长对话」「推送多语言对话」）。
2. 在 `popup.js` 添加按钮点击监听器，构造对应 payload，通过 `sendMessage` 发送（`type` 区分不同场景）。
3. 在 `background.js` 的 `onMessage` 监听器中按 `message.type` 分支处理。

## 代码约定

1. **MV3 标准**：所有代码必须符合 Chrome MV3 标准（service worker / `chrome.runtime` API / 无 `XMLHttpRequest`）。
2. **`importScripts` 顶层同步**：MV3 service worker 中 `importScripts` 必须在顶层同步调用，不能放在异步回调中。
3. **`return true` 异步 sendResponse**：`onMessage` 监听器若要异步 `sendResponse`，必须 `return true`，否则消息通道会在监听器返回后立即关闭。
4. **结构化错误响应**：`sendResponse` 的 `error` 字段必须含 `message` / `name` / `field` / `status` / `attempt`，便于 popup 渲染不同错误类型。
5. **不修改 SDK 文件**：本目录作为消费方，不修改 [kwa-push.js](../kwa-push.js) / [kwa-push.d.ts](../kwa-push.d.ts) / SDK 的 [README.md](../README.md)；如需修改 SDK，在 [plugin-sdk/](../) 根目录操作。
6. **样式独立硬编码**：demo 不引入 [ui/kwa-plugin.css](../ui/kwa-plugin.css)，样式在 `popup.css` 中硬编码（简化 demo 部署）；生产插件应引入样式包。
7. **`host_permissions` 最小权限**：仅声明 `http://127.0.0.1:8788/*`，扩展无法访问其他源；如需访问其他源需扩展此列表并说明理由。

## 常见任务

### 修改扩展名称或版本

编辑 `manifest.json` 的 `name` / `version` / `description` 字段；在 `chrome://extensions` 重新加载扩展后生效。

### 添加 popup 配置项

1. 在 `popup.html` 添加输入框 / 开关。
2. 在 `popup.js` 读取用户输入，加入 `sendMessage` 的 payload。
3. 在 `background.js` 的 `onMessage` 监听器中读取并处理（如调用 `KwaPush.configure`）。
4. 如需持久化，用 `chrome.storage.local` 保存（需在 `manifest.json` 的 `permissions` 中声明 `"storage"`，当前已声明）。

### 调试 Service Worker

1. 在 `chrome://extensions` 找到「KWA Push Demo」卡片。
2. 点击「Service Worker」链接，打开 DevTools。
3. 在 Console 查看日志与错误。
4. 在 Sources 面板设断点调试 `background.js`。
5. MV3 SW 会被 Chrome 闲置回收，重新唤醒时 `importScripts` 会重新执行；如需保持 SW 活跃，可在 Console 中调用 `chrome.alarms.create(...)` 定时唤醒（需 `alarms` 权限）。

### 调试 popup

1. 点击扩展图标打开 popup。
2. 右键 popup → 「检查」（Inspeccionar），打开 DevTools。
3. 在 Console 查看日志与错误。
4. popup 关闭后 JS 上下文销毁，所有状态丢失；如需持久化用 `chrome.storage.local`。

## 扩展点

1. **引入样式包**：把 [ui/kwa-plugin.css](../ui/kwa-plugin.css) 复制进扩展目录并 `<link>` 引入，替换 `popup.css` 中的硬编码色值，使 popup 颜色随 `data-kwa-mode` 联动。
2. **多场景测试**：添加多个按钮测试不同场景（长对话 / 多语言 / 含代码块 / 含图片等），验证 SDK 对各类 Markdown 内容的兼容性。
3. **配置持久化**：用 `chrome.storage.local` 保存 `webhookUrl` 等配置，popup 打开时读取回填；参考 [secondary-dev/settings.patch.js](../secondary-dev/settings.patch.js)。
4. **content script 集成**：添加 content script 自动采集页面对话（需扩展 `host_permissions` 与 `content_scripts` 字段），参考 [secondary-dev/PATCH-GUIDE.md](../secondary-dev/PATCH-GUIDE.md)。

## 注意事项

1. **Chrome MV3 文件访问限制**：`importScripts('../../kwa-push.js')` 引用了扩展根目录之外的文件，Chrome 加载时会报错；实际运行需把 `kwa-push.js` 复制进扩展目录（详见 [chrome-extension/README.md](chrome-extension/README.md) 方法 A），SDK 升级时记得同步该副本。
2. **Service Worker 冷启动**：MV3 SW 会被 Chrome 闲置回收（约 30 秒无活动后），重新唤醒时 `importScripts` 会重新执行，全局变量 `KwaPush` 重新挂载；无需手动处理，但需注意 SW 中不维护长期状态（用 `chrome.storage` 持久化）。
3. **`return true` 必需**：`onMessage` 监听器中异步 `sendResponse` 必须 `return true`，否则 popup 会显示「未收到 background.js 的回应」。
4. **`host_permissions` 限制**：仅 `http://127.0.0.1:8788/*` 可访问；如后端换端口或部署到其他地址，需同步修改 `manifest.json`。
5. **幂等去重验证**：默认每次点击 `conversation_id` 都不同（`'kwa-demo-' + Date.now()`），后端不会去重；如需观察去重，在 `popup.js` 中固定 `conversation_id` 为常量后再次点击。
6. **不修改 SDK 文件**：本目录作为消费方，不修改 [kwa-push.js](../kwa-push.js) / [kwa-push.d.ts](../kwa-push.d.ts) / SDK 的 [README.md](../README.md)；SDK 修改在 [plugin-sdk/](../) 根目录操作。
7. **样式独立硬编码**：demo 不引入 [ui/kwa-plugin.css](../ui/kwa-plugin.css)，颜色在 `popup.css` 中硬编码为墨绿 `#1a7f6e`；如需 study / work 双模式联动，需引入样式包并在 `<html>` 上设置 `data-kwa-mode`。
8. **本机后端必需**：demo 默认后端 `http://127.0.0.1:8788`，需先启动 [backend](../../backend/)；如后端未启动，推送失败 `status=0` + `attempt=3`（重试耗尽）。
9. **demo 不入库生产**：本目录仅作为联调自检工具，不参与生产部署；生产插件参考 [secondary-dev/](../secondary-dev/) 的 patch 流程对 [web-ai-chat-collector](../../../web-ai-chat-collector/) 二次开发。

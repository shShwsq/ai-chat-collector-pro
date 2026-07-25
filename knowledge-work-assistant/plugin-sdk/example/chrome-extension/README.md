# KWA Push Demo - Chrome MV3 扩展示例

本目录是一个最小可运行的 Chrome MV3 扩展示例，演示如何通过 `kwa-push` SDK
将一条测试 AI 对话推送到本机后端 `POST http://127.0.0.1:8788/api/plugin/conversations`。

## 目录结构

```
chrome-extension/
├── manifest.json         # MV3 清单
├── background.js         # service worker：importScripts 引入 SDK + 监听 popup 消息
├── popup/
│   ├── popup.html        # 弹窗结构
│   ├── popup.css         # 弹窗样式（浅色主题 + 墨绿强调色 #1a7f6e）
│   └── popup.js          # 弹窗逻辑：构造测试对话 → sendMessage 给 background
└── README.md             # 本文件
```

`background.js` 通过 `importScripts('../../kwa-push.js')` 引入位于
`plugin-sdk/kwa-push.js` 的 SDK：本扩展目录位于 `plugin-sdk/example/chrome-extension/`，
往上一级是 `example/`，再往上一级才是 `plugin-sdk/`，故相对路径为 `../../kwa-push.js`。

## 运行时注意：Chrome MV3 文件访问限制

> 本节是一个重要提醒。Chrome MV3 扩展只能加载位于**扩展根目录**
> （即加载扩展时选择的 `chrome-extension/` 目录）之内的文件。
> `importScripts('../../kwa-push.js')` 引用的 `kwa-push.js` 位于扩展根目录之外
> （`plugin-sdk/kwa-push.js`），Chrome 在加载 service worker 时会因找不到该脚本
> 而报错（`Failed to fetch imported script`），扩展无法注册 background。

这是 Chrome 扩展安全模型的限制，与本示例的代码组织无关。本示例按 spec
保留 `importScripts('../../kwa-push.js')` 以体现代码组织关系，静态检查
（`node --check`、JSON 解析）均通过；若要让示例在 Chrome 中真正可运行，
请按下述任一方式处理：

### 方法 A：把 SDK 复制进扩展目录（推荐，最简单）

```powershell
# 在 chrome-extension/ 目录下执行
Copy-Item ..\..\kwa-push.js .\kwa-push.js
```

然后把 `background.js` 中的：

```javascript
importScripts('../../kwa-push.js');
```

改为：

```javascript
importScripts('kwa-push.js');
```

之后重新加载扩展即可。SDK 升级时记得同步该副本（也可写一个简单的 build 脚本自动复制）。

### 方法 B：把扩展根目录上移到 `plugin-sdk/`

把 `manifest.json` 中所有相对路径补上 `example/chrome-extension/` 前缀，
然后把 Chrome「加载已解压的扩展程序」选择的目录改为 `plugin-sdk/`。
此方法无需复制文件，但要改动 manifest 中所有路径，侵入性较大，不推荐。

> 无论采用哪种方法，**不要修改** `plugin-sdk/kwa-push.js` / `kwa-push.d.ts` /
> SDK 的 `README.md`（这些由 Task 3 完成，本示例仅作为消费方）。

## 前置条件

1. 已启动本机后端，默认监听 `127.0.0.1:8788`。
   - 联调自检：浏览器访问 `http://127.0.0.1:8788/api/plugin/health`，应返回 JSON
     （含 `version` / `supported_platforms` 等）。
2. 本机已安装 Chrome 或任何 Chromium 内核浏览器（Edge / Brave 等亦可）。

## 加载扩展到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions` 回车。
2. 右上角打开「开发者模式」开关。
3. 点击左上角「加载已解压的扩展程序」。
4. 选择本目录：`knowledge-work-assistant/plugin-sdk/example/chrome-extension/`。
5. 扩展列表中应出现「KWA Push Demo」卡片，状态为「已启用」。
6. 点击浏览器右上角扩展图标（若未固定，点击拼花图标找到「KWA Push Demo」并固定）。

## 使用流程

1. 点击扩展图标，弹出 popup 窗口（宽 320px）。
2. 顶部标题「KWA 推送测试」，下方为 Webhook URL 显示行
   （默认 `http://127.0.0.1:8788/api/plugin/conversations`）。
3. 中部为「推送测试对话」按钮，按钮下方为结果区。
4. 底部为测试对话的 Markdown 预览（`<pre>` 显示）。
5. 点击「推送测试对话」按钮：
   - `popup.js` 构造测试对话 payload：
     - `platform: 'custom'`
     - `timestamp`: 当前 ISO8601 时间戳
     - `conversationMarkdown`: 含 `## user` / `## assistant` 的固定 Markdown
     - `metadata.conversation_id`: `'kwa-demo-' + Date.now()`（每次都不同）
     - `metadata.title`: `'KWA 示例对话'`
   - 通过 `chrome.runtime.sendMessage` 发送给 `background.js`。
   - `background.js` 调用 `KwaPush.pushConversation(payload)` 推送到后端。
   - 结果回传给 popup 渲染到结果区。
6. 重复点击：每次 `conversation_id` 都不同，后端不会去重；如需观察去重，
   可在 `popup.js` 中把 `conversation_id` 固定为常量后再次点击。

## 预期结果

- 成功：结果区显示
  ```
  [成功] 推送完成
  received: true
  deduplicated: false
  observation_id: <uuid>
  ```
- 去重：在后端已收到同一 `conversation_id` 的情况下，再次推送相同 id，
  应返回 `deduplicated: true`。
- 失败（如后端未启动）：结果区显示 `KwaPushError`，`status=0`，
  并显示已重试的 `attempt` 次数（默认最多重试 3 次）。

## 鉴权与安全提示

- 本示例与后端约定「暂不鉴权」，仅适用于本机开发环境（loopback `127.0.0.1`）。
- 若将后端部署到公网或局域网，请自行在反向代理层加 token / Origin 校验，
  否则任何能访问该端点的客户端均可写入数据。
- `manifest.json` 的 `host_permissions` 仅声明 `http://127.0.0.1:8788/*`，
  扩展无法访问其他源。
- 本示例不修改 SDK 的 `kwa-push.js` / `kwa-push.d.ts` / SDK 的 `README.md`，
  仅作为消费方调用。

## 故障排查

- 扩展加载报错「无法加载 background script」：检查 `background.js` 是否存在、
  `importScripts` 路径是否正确（应为 `../../kwa-push.js`）。
- 点击按钮后结果区一直显示「未收到 background.js 的回应」：检查
  `background.js` 是否在 `onMessage` 监听器中 `return true`（异步 sendResponse 必需）。
- 推送失败 `status=0`：后端未启动或被防火墙拦截，先访问
  `http://127.0.0.1:8788/api/plugin/health` 自检。
- 推送失败 `status=400`：payload 字段不合法，对照 SDK 的 `validateOptions`
  检查 `platform / timestamp / conversationMarkdown` 是否非空。

# plugin-sdk/ 插件 SDK 开发指南

> 一句话定位：本目录是 KWA 软件侧对外开放的"插件对接 SDK 包"，向浏览器插件（如二次开发后的 [web-ai-chat-collector](../../web-ai-chat-collector/)）提供三类能力：**推送 SDK**（`kwa-push.js` + `kwa-push.d.ts`，把采集到的 AI 对话推送到本机后端）、**统一样式包**（`ui/`，与主应用 study / work 双模式联动的 CSS 变量 + 组件类）、**二次开发 patch**（`secondary-dev/`，对原 web-ai-chat-collector 的 patch 文件与指南）、**示例扩展**（`example/`，最小可运行的 Chrome MV3 demo）。本目录**不依赖主应用前端**，可独立分发。

## 模块职责

```
plugin-sdk/
├── kwa-push.js                # 推送 SDK 主文件（UMD 模块，兼容 CJS / AMD / 浏览器全局 KwaPush）
├── kwa-push.d.ts              # TypeScript 类型定义，与 kwa-push.js 运行时导出一一对应
├── README.md                  # SDK 使用说明、API 文档、联调自检流程、风险提示
│
├── ui/                        # 统一样式包（详见 ui/DEVELOPMENT.md）
│   ├── kwa-plugin.css         #   导出 --kwa-accent 等变量 + .kwa-btn 等组件类
│   └── style-guide.md         #   颜色变量表、字体栈、圆角、阴影、暗色模式预留
│
├── example/                   # 示例扩展（详见 example/DEVELOPMENT.md）
│   └── chrome-extension/      #   最小可运行的 Chrome MV3 扩展 demo
│       ├── manifest.json
│       ├── background.js
│       ├── popup/{popup.html, popup.css, popup.js}
│       └── README.md
│
└── secondary-dev/             # 二次开发 patch（详见 secondary-dev/DEVELOPMENT.md）
    ├── kwa-push-handler.js    #   background 监听采集事件 → 调用 pushConversation
    ├── styles.patch.js        #   替换硬编码主色为 var(--kwa-accent)
    ├── settings.patch.html    #   设置页新增「推送目标 URL」输入框片段
    ├── settings.patch.js      #   保存 URL 到 chrome.storage.local + 测试推送按钮
    └── PATCH-GUIDE.md         #   手动应用 patch 的步骤说明
```

## 关键文件说明

### `kwa-push.js`（推送 SDK 主文件）

- **模块格式**：UMD（兼容 CommonJS / AMD / 浏览器全局变量 `KwaPush`）。
- **依赖**：`fetch` API + `AbortController`（浏览器与 Node 18+ 原生支持，无外部依赖）。
- **核心导出**：
  - `pushConversation(options, config?)`：推送一条 AI 对话到后端，返回 `Promise<{received, deduplicated, observation_id}>`。
  - `configure(options)`：配置全局默认值（`webhookUrl` / `timeout` / `maxRetries` / `retryDelayMs`）。
  - `createClient(options?)`：创建独立客户端实例，持有自己的配置副本，互不影响。
  - `SUPPORTED_PLATFORMS`：支持的平台白名单常量数组。
  - `KwaPushError` / `KwaPushValidationError`：自定义错误类。
- **默认配置**：
  - `webhookUrl`: `http://127.0.0.1:8788/api/plugin/conversations`
  - `timeout`: 10000ms
  - `maxRetries`: 3（不含首次尝试）
  - `retryDelayMs`: 500（指数退避基数，实际等待 = `retryDelayMs * 2^attempt`）
- **支持的平台白名单**：`chatgpt` / `claude` / `gemini` / `deepseek` / `qwen` / `doubao` / `kimi` / `fudan` / `custom`，与后端 [routers/plugin.py](../backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 对齐。
- **行为流程**：
  1. 客户端基本校验（`platform` / `timestamp` / `conversationMarkdown` 非空），失败抛 `KwaPushValidationError`。
  2. 将 camelCase 字段转为后端 snake_case 契约（`conversationMarkdown` → `conversation_markdown`）。
  3. 通过 `fetch` POST 到 `webhookUrl`，带 `AbortController` 超时控制。
  4. 失败重试：仅对**网络错误与 5xx** 重试，**4xx 不重试**；指数退避 `retryDelayMs * 2^attempt`。
  5. 重试到达上限后抛出 `KwaPushError`（含 `status` / `attempt` 字段）。
- **引入方式**：
  - CommonJS（Node / Electron 主进程）：`const { pushConversation } = require('./kwa-push')`。
  - ESM / TypeScript：`import { pushConversation } from './kwa-push'`。
  - 浏览器 `<script>` 标签：`<script src="./kwa-push.js"></script>` + 全局变量 `KwaPush`。
  - Chrome MV3 service worker：`importScripts('./kwa-push.js')` + 全局变量 `KwaPush`。

### `kwa-push.d.ts`（TypeScript 类型定义）

- 与 `kwa-push.js` 运行时导出一一对应。
- 与后端 [schemas.py](../backend/app/models/schemas.py) 的 `PluginConversationRequest` / `PluginConversationResponse` 字段对齐。
- **核心类型**：
  - `PushMetadata`：可选元数据，含 `conversation_id`（**强烈推荐**，用于 24h 幂等去重）、`title` / `url` / `model` + 任意附加字段。
  - `PushConversationOptions`：`pushConversation` 入参（camelCase）。
  - `KwaPushConfig`：运行时配置项（`webhookUrl` / `timeout` / `maxRetries` / `retryDelayMs` / `signal`）。
  - `PushConversationResponse`：成功响应，含 `received` / `deduplicated` / `observation_id`。
  - `KwaPushClient`：`createClient` 返回的独立客户端实例接口。
- **错误类声明**：`KwaPushError`（含 `status` / `attempt` / `responseBody`）+ `KwaPushValidationError`（含 `field`）。
- **全局命名空间**：`export as namespace KwaPush` 声明浏览器全局变量类型。

### `README.md`（SDK 使用说明）

- 三种引入方式的快速开始示例（CommonJS / ESM / `<script>` 标签）。
- 完整 API 文档（`pushConversation` / `configure` / `createClient` / `SUPPORTED_PLATFORMS`）。
- 请求字段说明（SDK camelCase ↔ 后端 snake_case 对照表）。
- 错误处理示例（`KwaPushValidationError` / `KwaPushError` + `AbortSignal` 取消）。
- 联调自检流程（5 步：启动后端 → 健康检查 → 推送测试对话 → 确认落库 → 确认幂等去重）。
- 风险提示（暂不鉴权，仅适用本机 loopback）。
- 目录结构说明。

## 开发工作流

### 修改 SDK 主文件

1. 修改 `kwa-push.js`，保持 UMD 模块格式（`define` / `module.exports` / `root.KwaPush` 三分支）。
2. 同步修改 `kwa-push.d.ts`，保持类型与运行时导出一一对应。
3. 更新 `README.md` 的 API 文档与示例。
4. 在 `example/chrome-extension/` 中验证（如修改了推送逻辑）。
5. 在 `secondary-dev/PATCH-GUIDE.md` 中检查是否需同步更新 patch 步骤。

### 新增一个 API 方法

1. 在 `kwa-push.js` 的 factory 返回对象中添加新方法（如 `pushXxx`）。
2. 在 `kwa-push.d.ts` 添加对应类型声明（如 `export declare function pushXxx(...)`）。
3. 在 `README.md` 的 API 文档中添加新方法说明。
4. 在 `example/chrome-extension/popup.js` 或 `background.js` 中添加调用示例。

### 修改默认配置

1. 在 `kwa-push.js` 顶部修改 `DEFAULT_WEBHOOK_URL` / `DEFAULT_TIMEOUT` / `DEFAULT_MAX_RETRIES` / `DEFAULT_RETRY_DELAY_MS` 常量。
2. 在 `kwa-push.d.ts` 的 `KwaPushConfig` 注释中更新 `@default` 值。
3. 在 `README.md` 的配置项表格中更新默认值。
4. 检查 `example/` 与 `secondary-dev/` 是否有硬编码的旧默认值需同步。

### 修改支持的平台白名单

1. 在 `kwa-push.js` 的 `SUPPORTED_PLATFORMS` 数组添加 / 删除平台标识。
2. 在 `kwa-push.d.ts` 的 `SUPPORTED_PLATFORMS` 声明同步修改（`readonly [...]`）。
3. **后端同步**：[backend/app/routers/plugin.py](../backend/app/routers/plugin.py) 的 `SUPPORTED_PLATFORMS` 必须同步修改，否则后端返回 400。
4. 在 `README.md` 的「支持的平台」表格中更新。
5. 在 [frontend/src/lib/types.ts](../frontend/src/lib/types.ts) 与 [PluginIntegrationSection.tsx](../frontend/src/components/PluginIntegrationSection.tsx) 中检查是否需同步。

## 代码约定

1. **UMD 模块格式**：`kwa-push.js` 必须保持 UMD 格式，兼容 CommonJS / AMD / 浏览器全局变量三种引入方式；不使用 ES module `export`（Chrome MV3 service worker 的 `importScripts` 不支持 ESM）。
2. **零外部依赖**：SDK 仅依赖 `fetch` + `AbortController`，不引入任何 npm 包；体积约 8KB（minified），适合直接内联到插件。
3. **camelCase 对外 / snake_case 对内**：SDK 对外暴露 camelCase（如 `conversationMarkdown`），发送到后端时自动转为 snake_case（如 `conversation_markdown`）；`metadata` 内的自由字段保留原样（如 `conversation_id`）。
4. **错误分类**：`KwaPushValidationError`（客户端校验失败，不重试）vs `KwaPushError`（运行时错误，含 `status` / `attempt`）；4xx 不重试，5xx 与网络错误重试。
5. **幂等去重**：`metadata.conversation_id` 用于后端 24h 幂等去重，`dedup_key = {platform}:{conversation_id}`；命中去重时返回 `deduplicated: true` + 既有 `observation_id`，不写新记录、不广播 WebSocket 事件。
6. **类型定义同步**：`kwa-push.d.ts` 必须与 `kwa-push.js` 运行时导出一一对应；修改任一文件必须同步另一个。
7. **暂不鉴权**：当前 SDK 与后端约定「暂不鉴权」，仅适用本机 loopback；如需鉴权，在 `KwaPushConfig` 增加 `token` 字段，在 `fetch` header 中注入 `Authorization: Bearer <token>`。
8. **不修改原插件**：`secondary-dev/` 中的 patch 文件**不修改**原 [web-ai-chat-collector/](../../web-ai-chat-collector/) 目录，仅在副本 `web-ai-chat-collector-patched/` 上操作；原插件目录由 `.gitignore` 排除在版本控制外。
9. **样式包独立**：`ui/kwa-plugin.css` 不依赖主应用前端样式，可独立分发；插件方只需 `<link>` 引入并在根容器设置 `data-kwa-mode` 属性即可切换强调色。

## 常见任务

### 升级 SDK 版本

1. 修改 `kwa-push.js` 顶部注释中的版本号（如有）。
2. 在 `README.md` 的「变更日志」中记录变更（当前未建立 changelog，建议新增）。
3. 如有 breaking change，在 `example/` 与 `secondary-dev/` 中同步更新调用示例。
4. 通知插件方升级（如 web-ai-chat-collector 的 patched 副本需重新应用 patch）。

### 添加一个新的推送字段

1. 在 `kwa-push.js` 的 `validateOptions` 中添加字段校验（如需）。
2. 在 `buildRequestBody` 中添加字段转换（camelCase → snake_case）。
3. 在 `kwa-push.d.ts` 的 `PushConversationOptions` 或 `PushMetadata` 中添加字段声明。
4. **后端同步**：[backend/app/models/schemas.py](../backend/app/models/schemas.py) 的 `PluginConversationRequest` 添加对应字段。
5. 在 `README.md` 的请求字段表格中更新。
6. 在 `example/chrome-extension/popup.js` 中添加示例。

### 修改重试策略

1. 在 `kwa-push.js` 的 `pushConversation` 中修改重试条件（如 4xx 也重试）。
2. 修改 `DEFAULT_MAX_RETRIES` / `DEFAULT_RETRY_DELAY_MS` 常量。
3. 在 `kwa-push.d.ts` 的 `KwaPushConfig` 注释中更新 `@default` 值与重试条件说明。
4. 在 `README.md` 的「行为」一节中更新。

### 修改样式包变量

1. 在 [ui/kwa-plugin.css](ui/kwa-plugin.css) 的 `:root` 或 `[data-kwa-mode="..."]` 中修改变量值。
2. 在 [ui/style-guide.md](ui/style-guide.md) 的变量表中同步更新。
3. **主应用同步**：[frontend/src/styles/app.css](../frontend/src/styles/app.css) 的 `--accent` / `--accent-soft` 必须与 `--kwa-accent` / `--kwa-accent-soft` 保持一致（study 墨绿 `#1a7f6e` / work 琥珀 `#b45309`）。

## 扩展点

1. **鉴权支持**：在 `KwaPushConfig` 增加 `token` 字段，在 `fetch` header 中注入 `Authorization: Bearer <token>`；后端在 `/api/plugin/conversations` 校验。
2. **批量推送**：新增 `pushConversations(options[], config?)` 方法，内部并发调用 `pushConversation`，限制并发数避免后端过载。
3. **WebSocket 推送**：新增 `KwaPushSocket` 类，建立 WebSocket 连接实时推送对话（替代 HTTP POST），适用于高频采集场景。
4. **多后端支持**：`createClient` 已支持独立配置副本，可同时对接 dev / staging / prod 多个后端。
5. **TypeScript 重写**：当前 `kwa-push.js` 为纯 JS + JSDoc；如需 TS 重写，用 `tsc` 编译为 UMD 输出，保持 `kwa-push.d.ts` 自动生成。

## 注意事项

1. **暂不鉴权风险**：本 SDK 与后端约定「暂不鉴权」，仅适用本机 loopback（`127.0.0.1:8788`）；若后端绑定 `0.0.0.0` 或部署到公网 / 局域网，必须自行在反向代理层加 token / Origin / IP 校验。
2. **Chrome MV3 文件访问限制**：`example/chrome-extension/` 中的 `importScripts('../../kwa-push.js')` 引用了扩展根目录之外的文件，Chrome 加载时会报错；实际运行需把 `kwa-push.js` 复制进扩展目录（详见 [example/chrome-extension/README.md](example/chrome-extension/README.md) 的「方法 A」）。
3. **`importScripts` 顺序**：在 `secondary-dev/kwa-push-handler.js` 中 `KwaPush` 必须先于 handler 引入，否则 handler 注册时会因 `KwaPush` 未定义而早退；`background.js` 中 `importScripts('kwa-push.js', 'kwa-push-handler.js')` 顺序不可颠倒。
4. **Service Worker 冷启动**：MV3 SW 会被 Chrome 闲置回收，重新唤醒时 `importScripts` 会重新执行，handler 会重新注册，无需手动处理。
5. **节流窗口**：`kwa-push-handler.js` 中 `DEDUP_WINDOW_MS` 默认 500ms，相同 `metadata.conversation_id` 在此窗口内重复触发只推送一次，避免采集器抖动。
6. **幂等去重窗口**：后端基于 `dedup_key = {platform}:{conversation_id}` 在 24h 内幂等去重；命中去重时返回 `deduplicated: true`，不写新记录、不广播 WebSocket 事件。
7. **不修改原插件目录**：`secondary-dev/` 中的 patch 文件仅在副本 `web-ai-chat-collector-patched/` 上操作；原 [web-ai-chat-collector/](../../web-ai-chat-collector/) 目录由 `.gitignore` 排除，**不应推送到仓库**（见 [用户要求.md](../../用户要求.md)）。
8. **样式包暂不参与鉴权**：`ui/kwa-plugin.css` 中的色值、变量名、类名结构可被任何能加载该文件的页面读取；请勿在 CSS 中放置敏感信息。
9. **`metadata` 自由字段**：`PushMetadata` 用 `[k: string]: unknown` 兜底任意附加字段，后端原样存入 `observations.metadata_json`；前端类型仅声明已知字段。
10. **SDK 与后端契约同步**：修改 `kwa-push.js` / `kwa-push.d.ts` 的字段或行为时，必须同步后端 [backend/app/routers/plugin.py](../backend/app/routers/plugin.py) 与 [schemas.py](../backend/app/models/schemas.py)，否则后端返回 400 / 422。

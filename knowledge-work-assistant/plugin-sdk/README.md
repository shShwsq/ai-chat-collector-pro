# KWA Plugin Push SDK

知识工作助手（Knowledge Work Assistant）的浏览器插件推送 SDK。供插件方（如二次开发后的 `web-ai-chat-collector`）调用，将采集到的 AI 对话推送到本机后端 `POST /api/plugin/conversations`，由后端持久化为 Observation 原始记录，待后续 Agent 抽取知识点。SDK 提供 UMD 模块（兼容 CommonJS / AMD / 浏览器全局变量）、超时控制、指数退避重试与幂等去重支持。

---

## 快速开始

SDK 文件位于 `plugin-sdk/kwa-push.js`，类型定义位于 `plugin-sdk/kwa-push.d.ts`。三种引入方式如下：

### 1. CommonJS（Node / Electron 主进程 / 构建脚本）

```js
const { pushConversation, configure } = require('./kwa-push');

configure({ webhookUrl: 'http://127.0.0.1:8788/api/plugin/conversations' });

(async () => {
  const res = await pushConversation({
    platform: 'deepseek',
    timestamp: new Date().toISOString(),
    conversationMarkdown: '## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是……',
    metadata: { conversation_id: 'ds-001', title: '什么是知识图谱' },
  });
  console.log(res);
  // { received: true, deduplicated: false, observation_id: '...' }
})();
```

### 2. ESM / TypeScript（Vite / Webpack / Rollup）

```ts
import { pushConversation, SUPPORTED_PLATFORMS } from './kwa-push';

const res = await pushConversation(
  {
    platform: 'chatgpt',
    timestamp: '2025-01-01T12:00:00+08:00',
    conversationMarkdown: '## 用户\n请解释 RAG。\n\n## 助手\nRAG 是……',
    metadata: { conversation_id: 'gpt-001', title: 'RAG 解释', model: 'gpt-4o-mini' },
  },
  { timeout: 8000, maxRetries: 2 }
);

console.log(SUPPORTED_PLATFORMS); // ['chatgpt','claude','gemini',...]
```

### 3. 浏览器 `<script>` 标签（Chrome MV3 popup / content script / 普通网页）

```html
<script src="./kwa-push.js"></script>
<script>
  // 挂载为全局变量 window.KwaPush
  KwaPush.configure({ webhookUrl: 'http://127.0.0.1:8788/api/plugin/conversations' });
  document.getElementById('push').addEventListener('click', async () => {
    try {
      const res = await KwaPush.pushConversation({
        platform: 'claude',
        timestamp: new Date().toISOString(),
        conversationMarkdown: '## 用户\n你好\n\n## 助手\n你好',
        metadata: { conversation_id: 'claude-001' },
      });
      console.log(res);
    } catch (e) {
      console.error(e);
    }
  });
</script>
```

> Chrome MV3 service worker 中可通过 `importScripts('./kwa-push.js')` 引入，全局变量 `KwaPush` 同样可用。

---

## API 文档

### `pushConversation(options, config?)`

推送一条 AI 对话到后端。返回 `Promise<{received, deduplicated, observation_id}>`。

**参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `options.platform` | `string` | 是 | 来源平台，必须在 `SUPPORTED_PLATFORMS` 内 |
| `options.timestamp` | `string` | 是 | 对话发生时间，ISO8601 字符串 |
| `options.conversationMarkdown` | `string` | 是 | 对话原文 Markdown（非空） |
| `options.metadata` | `object \| null` | 否 | 可选元数据，推荐填 `conversation_id` |
| `config.webhookUrl` | `string` | 否 | 后端推送端点，默认 `http://127.0.0.1:8788/api/plugin/conversations` |
| `config.timeout` | `number` | 否 | 单次请求超时（毫秒），默认 `10000` |
| `config.maxRetries` | `number` | 否 | 失败重试次数上限（不含首次），默认 `3` |
| `config.retryDelayMs` | `number` | 否 | 指数退避基数（毫秒），默认 `500` |
| `config.signal` | `AbortSignal` | 否 | 支持取消整个推送流程 |

**示例**

```js
const res = await pushConversation(
  {
    platform: 'gemini',
    timestamp: '2025-01-01T09:30:00+08:00',
    conversationMarkdown: '## 用户\n你好\n\n## 助手\n你好',
    metadata: { conversation_id: 'gemini-001', title: '打招呼' },
  },
  { timeout: 5000, maxRetries: 2, retryDelayMs: 400 }
);
// res = { received: true, deduplicated: false, observation_id: 'abc123...' }
```

**行为**

1. 客户端基本校验（`platform` / `timestamp` / `conversationMarkdown` 非空），失败抛 `KwaPushValidationError`。
2. 将 camelCase 字段转为后端 snake_case 契约（`conversationMarkdown` → `conversation_markdown`）。
3. 通过 `fetch` POST 到 `webhookUrl`，带 `AbortController` 超时控制。
4. 失败重试：仅对**网络错误与 5xx** 重试，**4xx 不重试**；指数退避 `retryDelayMs * 2^attempt`。
5. 重试到达上限后抛出 `KwaPushError`（含 `status` / `attempt` 字段）。

### `configure(options)`

配置全局默认值，后续无 config 参数的 `pushConversation` 调用将使用此处的值。

```js
configure({
  webhookUrl: 'http://127.0.0.1:8788/api/plugin/conversations',
  timeout: 8000,
  maxRetries: 2,
  retryDelayMs: 400,
});
```

> `configure` 不支持 `signal`（`signal` 仅在单次 `pushConversation` 调用中传入）。

### `createClient(options?)`

创建独立客户端实例，持有自己的配置副本，互不影响。适用于同时对接多个后端的场景（如 dev / staging）。

```js
const devClient = createClient({ webhookUrl: 'http://127.0.0.1:8788/api/plugin/conversations' });
const stagingClient = createClient({ webhookUrl: 'http://staging.example:8788/api/plugin/conversations' });

// 各客户端独立调用，互不影响
await devClient.pushConversation({ platform: 'deepseek', timestamp: '...', conversationMarkdown: '...' });
await stagingClient.pushConversation({ platform: 'deepseek', timestamp: '...', conversationMarkdown: '...' });

// 也可在调用时临时覆写单次配置
await devClient.pushConversation(
  { platform: 'deepseek', timestamp: '...', conversationMarkdown: '...' },
  { timeout: 3000 }  // 仅本次覆写 timeout，其余继承 devClient 配置
);

// 运行期更新客户端配置
devClient.configure({ maxRetries: 5 });
```

**返回的客户端实例**

| 字段 / 方法 | 类型 | 说明 |
| --- | --- | --- |
| `config` | `object` | 当前客户端配置快照（`configure` 后同步更新） |
| `pushConversation(options, config?)` | `function` | 使用本客户端配置推送；可传 config 临时覆写 |
| `configure(options)` | `function` | 更新本客户端配置（仅更新提供的字段） |

### `SUPPORTED_PLATFORMS`

支持的平台白名单常量数组，与后端 `routers/plugin.py` 对齐：

```js
['chatgpt', 'claude', 'gemini', 'deepseek', 'qwen', 'doubao', 'kimi', 'fudan', 'custom']
```

---

## 请求字段说明

SDK 对外使用 camelCase，发送到后端时自动转为 snake_case。下表字段对齐后端 `PluginConversationRequest`。

| SDK 字段（camelCase） | 后端字段（snake_case） | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `platform` | `platform` | `string` | 是 | 来源平台，必须在白名单内，否则后端返回 400 |
| `timestamp` | `timestamp` | `string` | 是 | 对话发生时间，ISO8601；解析失败时落库 `occurred_at=None`，不阻断接收 |
| `conversationMarkdown` | `conversation_markdown` | `string` | 是 | 对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料 |
| `metadata` | `metadata` | `object \| null` | 否 | 可选附加元数据，原样存入 `observations.metadata_json` |

**`metadata` 子字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `conversation_id` | `string` | **强烈推荐**。后端基于 `{platform}:{conversation_id}` 计算 `dedup_key`，24h 内对同一 id 重复推送返回 `deduplicated: true`，不写新记录 |
| `title` | `string` | 对话标题；若提供必须为 string，否则后端返回 422 |
| `url` | `string` | 对话原始 URL；同上类型约束 |
| `model` | `string` | 模型名（如 `gpt-4o-mini`）；同上类型约束 |
| 其他 | `unknown` | 任意附加字段，原样存入后端 metadata |

---

## 支持的平台

| 平台标识 | 说明 |
| --- | --- |
| `chatgpt` | OpenAI ChatGPT |
| `claude` | Anthropic Claude |
| `gemini` | Google Gemini |
| `deepseek` | DeepSeek |
| `qwen` | 阿里通义千问 |
| `doubao` | 字节豆包 |
| `kimi` | Moonshot Kimi |
| `fudan` | 复旦 MOSS / 其他复旦系 |
| `custom` | 兜底：插件自定义 / 未列举的平台 |

未命中白名单的 `platform` 后端返回 `400 + {detail: "unsupported platform: xxx"}`（属 4xx，SDK **不会重试**）。

---

## 错误处理

SDK 抛出两种自定义错误类，均继承自 `Error`。

### `KwaPushValidationError`

客户端校验失败（字段缺失 / 类型不符 / 空值）时抛出，**在发起网络请求前**抛出。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 固定 `'KwaPushValidationError'` |
| `message` | `string` | 错误描述 |
| `field` | `string \| null` | 出错字段名：`'platform'` / `'timestamp'` / `'conversationMarkdown'` / `'metadata'` / `'options'` |

### `KwaPushError`

推送运行时错误（网络错误 / 超时 / 5xx / 4xx / 重试耗尽 / 调用方取消）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 固定 `'KwaPushError'` |
| `message` | `string` | 错误描述 |
| `status` | `number` | HTTP 状态码；网络错误 / 超时 / 调用方取消时为 `0` |
| `attempt` | `number` | 失败时所处的尝试序号（`0` 表示首次尝试） |
| `responseBody` | `unknown` | 后端返回的解析后响应体（若可解析为 JSON），否则 `undefined` |

### try / catch 示例

```js
const { pushConversation, KwaPushError, KwaPushValidationError } = require('./kwa-push');

async function safePush() {
  try {
    const res = await pushConversation({
      platform: 'deepseek',
      timestamp: new Date().toISOString(),
      conversationMarkdown: '## 用户\n你好\n\n## 助手\n你好',
      metadata: { conversation_id: 'ds-001' },
    });
    console.log('推送成功:', res);
  } catch (e) {
    if (e instanceof KwaPushValidationError) {
      // 客户端校验失败：无需重试，修正入参后重试
      console.error(`[校验失败] field=${e.field} | ${e.message}`);
    } else if (e instanceof KwaPushError) {
      // 网络错误 / 4xx / 5xx / 重试耗尽
      if (e.status === 0) {
        console.error(`[网络/超时] attempt=${e.attempt} | ${e.message}`);
      } else if (e.status >= 400 && e.status < 500) {
        console.error(`[客户端错误 ${e.status}]`, e.responseBody);
      } else {
        console.error(`[服务端错误 ${e.status}] attempt=${e.attempt}`, e.responseBody);
      }
    } else {
      console.error('[未知错误]', e);
    }
  }
}
```

### 使用 AbortSignal 取消

```js
const controller = new AbortController();
// 5 秒后取消（含退避等待期）
setTimeout(() => controller.abort(), 5000);

try {
  await pushConversation(
    { platform: 'deepseek', timestamp: '...', conversationMarkdown: '...' },
    { signal: controller.signal, maxRetries: 5 }
  );
} catch (e) {
  if (e instanceof KwaPushError && e.message.includes('aborted')) {
    console.log('已取消');
  }
}
```

---

## 联调自检流程

对接后端前的完整自检步骤。后端代码位于 `knowledge-work-assistant/backend/`。

### 步骤 1：启动后端

```bash
cd knowledge-work-assistant/backend
uvicorn app.main:app --reload --port 8788
```

> 端口 `8788` 为本项目约定（避免和步影 `8787` 冲突），见 `backend/app/config.py`。

### 步骤 2：调用 `GET /api/plugin/health` 确认后端可达

```bash
curl http://127.0.0.1:8788/api/plugin/health
```

预期返回（HTTP 200）：

```json
{
  "ok": true,
  "version": "1.0",
  "supported_platforms": ["chatgpt","claude","custom","deepseek","doubao","fudan","gemini","kimi","qwen"],
  "queue_size": 0
}
```

### 步骤 3：用 SDK 推送一条测试对话

```js
const { pushConversation } = require('./kwa-push');

const res = await pushConversation({
  platform: 'deepseek',
  timestamp: new Date().toISOString(),
  conversationMarkdown: '## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是一种用图结构组织知识的方式……',
  metadata: {
    conversation_id: 'self-test-001',
    title: '知识图谱简介',
    url: 'https://chat.deepseek.com/c/self-test-001',
    model: 'deepseek-chat',
  },
});

console.log(res);
// 预期：{ received: true, deduplicated: false, observation_id: '<32位十六进制>' }
```

### 步骤 4：调用 `GET /api/plugin/conversations/recent?limit=5` 确认落库

```bash
curl "http://127.0.0.1:8788/api/plugin/conversations/recent?limit=5"
```

预期返回中包含刚才推送的记录（`platform: "deepseek"`、`title: "知识图谱简介"`）。

### 步骤 5：再次推送相同 `conversation_id`，确认幂等去重

```js
const res2 = await pushConversation({
  platform: 'deepseek',
  timestamp: new Date().toISOString(),
  conversationMarkdown: '## 用户\n什么是知识图谱？\n\n## 助手\n知识图谱是一种用图结构组织知识的方式……',
  metadata: { conversation_id: 'self-test-001', title: '知识图谱简介' },
});

console.log(res2);
// 预期：{ received: true, deduplicated: true, observation_id: '<与步骤3相同>' }
```

> 去重窗口为 24 小时，去重键为 `deepseek:self-test-001`。命中去重时后端不写新记录、不广播 WebSocket 事件。

---

## 风险提示

**本 SDK 与后端约定「暂不鉴权」，仅适用于本机开发环境（loopback `127.0.0.1`）。**

- 后端 `POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，任何能访问该端点的客户端均可写入数据。
- 默认监听 `127.0.0.1:8788`，理论上仅本机可访问；但若您将后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必自行在反向代理层（如 Nginx / Caddy）增加以下至少一项防护：
  - **Token 鉴权**：在请求头加 `Authorization: Bearer <token>`，反向代理校验。
  - **Origin 白名单**：仅允许可信来源（如 `chrome-extension://<id>`、`http://localhost:5174`）。
  - **IP 限制**：仅允许本机 / 内网 IP 访问 `/api/plugin/` 前缀。
- 后续迭代计划在 `plugin-sdk` 与后端增加可选 token 字段，本轮不实现。
- 在 `style-guide.md` 与本 README 中均明确标注此风险，提醒插件方不要在生产环境直连未鉴权的后端。

---

## 目录结构

`plugin-sdk/` 目录当前包含以下文件（后续 Task 将补充示例扩展、样式包与二次开发 patch）：

```
plugin-sdk/
├── kwa-push.js        # UMD 模块主文件（兼容 CommonJS / AMD / 浏览器全局变量 KwaPush）
├── kwa-push.d.ts      # TypeScript 类型定义，与 kwa-push.js 运行时导出一一对应
└── README.md          # 本文档：使用说明、API 文档、联调自检流程、风险提示
```

**规划中（由后续 Task 添加，当前不存在）**：

```
plugin-sdk/
├── example/                      # Task 4: 最小可运行的 Chrome MV3 示例扩展
│   └── chrome-extension/
│       ├── manifest.json
│       ├── popup/{popup.html,popup.css,popup.js}
│       └── background.js
├── ui/                           # Task 5: 统一样式包与规范文档
│   ├── kwa-plugin.css            #   导出 --kwa-accent 等变量 + .kwa-btn 等组件类
│   └── style-guide.md            #   颜色变量表、字体栈、圆角、阴影、暗色模式预留
└── secondary-dev/                # Task 6: 对原 web-ai-chat-collector 的二次开发 patch
    ├── kwa-push-handler.js       #   监听采集事件 → 调用 pushConversation
    ├── styles.patch.js           #   替换硬编码主色为 var(--kwa-accent)
    ├── settings.patch.html       #   设置页新增「推送目标 URL」输入框
    ├── settings.patch.js         #   保存 URL 到 chrome.storage.local
    └── PATCH-GUIDE.md            #   手动应用 patch 的步骤说明
```

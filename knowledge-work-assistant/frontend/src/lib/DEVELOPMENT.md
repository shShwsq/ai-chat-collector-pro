# lib/ 通信层与类型契约开发指南

> 一句话定位：本目录是 KWA 前端渲染进程的"通信层 + 类型契约层"，5 个文件分别承担 HTTP 客户端（`api.ts`）、WebSocket 客户端（`ws.ts`）、前后端类型契约（`types.ts`）、节点模板镜像（`nodeTemplates.ts`）、Electron 桥类型声明（`electron.d.ts`）。本目录**不写业务逻辑**，只做"通信封装 + 类型定义"；业务态由 [`store/useAppStore.ts`](../store/useAppStore.ts) 管理，组件层通过 `useAppStore` 间接调用本目录 API。

## 模块职责

```
lib/
├── api.ts               # HTTP 客户端：/api 前缀 + file:// 环境地址解析 + ApiError + 全部 API 方法
├── ws.ts                # WebSocket 客户端：TestSocket 类 + generateSessionId + 后端协议对齐
├── types.ts             # 与 backend/app/models/schemas.py 一一对应的 TypeScript 类型定义
├── nodeTemplates.ts     # 与 backend/app/models/node_types.py 一一对应的节点模板镜像
├── electron.d.ts        # window.electronAPI 全局类型声明（与 electron/preload.ts 对齐）
└── __tests__/           # 库测试套件，vitest 跑（详见 __tests__/DEVELOPMENT.md）
    └── kwa-push.test.ts # plugin-sdk/kwa-push.js SDK 单元测试
```

## 关键文件说明

### `api.ts`（HTTP 客户端）

- **核心导出**：`api`（类型化方法集合）、`ApiError`（统一错误类）、`ApiClient`（typeof api）。
- **基地址解析**（`httpBase()`）：
  - `file://` 协议（生产环境 Electron）：优先 `window.electronAPI?.backend?.getUrl()`，兜底 `http://127.0.0.1:8788`。
  - 其他协议（dev 环境 Vite）：返回空字符串，使用相对路径走 Vite 代理（见 [vite.config.ts](../../vite.config.ts) 的 `/api` 代理）。
- **请求封装**（`request<T>(path, init?)`）：
  - 自动拼接 `/api` 前缀。
  - 自动设置 `Content-Type: application/json`（除非 body 是 FormData）。
  - 网络错误抛 `ApiError(code='network_error', status=0)`。
  - HTTP 非 2xx 抛 `ApiError`，`code` / `detail` 来自后端响应体。
  - 响应体优先按 JSON 解析，失败则保留原始文本。
- **查询字符串**（`withQuery(base, params)`）：跳过 undefined / 空值。
- **API 方法分组**（按后端路由模块）：
  - 健康检查：`getHealth`
  - 图谱管理：`getGraphs` / `createGraph` / `getGraph` / `getFullGraph` / `renameGraph` / `deleteGraph` / `getGraphStats`
  - 节点 CRUD：`createNode` / `listNodes` / `updateNode` / `deleteNode` / `generateNodeDetail` / `appendUserFill`
  - 节点延伸：`extendNode` / `revokeExtend`
  - 边 CRUD：`createEdge` / `listEdges` / `deleteEdge`
  - 插件对接：`pushPluginConversation` / `getPluginContract` / `getPluginHealth` / `getPluginRecent`
  - Study 抽取：`listObservations` / `extractNodes` / `batchCreateNodes` / `extractAndConfirm`
  - Study 测验：`generateQuiz` / `answerQuiz` / `listQuizzes` / `getQuiz`
  - Work 业务：`extractWorkObjects` / `confirmWorkObjects` / `generateTrends` / `addTrendToGraph` / `generateReport` / `exportReportDocx` / `askWorkQuestion`
  - 推荐 / touch / remind / star：`getRecommendations` / `touchNode` / `setRemind` / `clearRemind` / `setStar`
  - LLM 配置：`getLlmRequests` / `cancelLlmRequest` / `getLlmConfig` / `updateLlmConfig` / **`testLlmConnection(body: LlmTestConnectionRequest) → LlmTestConnectionResponse`**（POST `/llm/test-connection`，保存前即时验证连通性；字段全部可选，后端以传入值优先、否则用已保存配置；永远返回 200 不抛 HTTP 异常）
  - 流式触发：`streamNodeDetail` / `streamAskQuestion` / `streamGenerateReport`
  - 多轮对话 Chat（与 [backend/app/routers/chat.py](../../../backend/app/routers/chat.py) 对齐）：`createChatSession(body: CreateChatSessionRequest) → ChatSession` / `listChatSessions(mode?, graphId?, limit?) → ChatSession[]`（解包 `{ sessions, count }`）/ `getChatMessages(sessionId) → ChatMessage[]`（解包 `{ messages, count }`）/ `startChatStream(sessionId, body: StartChatStreamRequest) → ChatStreamStartedResponse` / `cancelChatStream(requestId) → CancelChatResponse` / `confirmChatToolCall(requestId, body: ConfirmToolCallRequest) → ConfirmToolCallResponse` / `triggerChatCheckpoint(sessionId) → TriggerCheckpointResponse` / `getChatCheckpoint(sessionId) → ChatCheckpoint`
- **特殊方法 `exportReportDocx`**：不走 `request<T>` 封装，直接 `fetch` 拿 Blob 触发浏览器下载；从 `Content-Disposition` 解析文件名（支持 RFC5987 `filename*=UTF-8''xxx`）。
- **`getLlmRequests` 兜底**：后端返回 `{ requests, count }` 包装结构，此处解包为纯数组；非预期结构返回 `[]`，避免组件 `.filter/.map` 白屏。

### `ws.ts`（WebSocket 客户端）

- **核心导出**：`TestSocket` 类、`generateSessionId` 函数。
- **基地址解析**（`wsBase()`）：
  - `file://` 协议（生产环境）：优先 `window.electronAPI?.backend?.getWsUrl()`，兜底 `ws://127.0.0.1:8788`。
  - 其他协议（dev 环境）：根据当前页 `loc.protocol` 拼 `ws://` 或 `wss://` + `loc.host`，走 Vite 代理（见 [vite.config.ts](../../vite.config.ts) 的 `/ws` 代理）。
- **`TestSocket` 类**：
  - `connect(sessionId?)`：建立连接，URL 拼 `?session_id=<sessionId>` 查询参数；resolve 后即可发送消息。
  - `onEvent(handler)`：订阅任意事件，返回取消订阅函数。
  - `send(message: WsOutgoing)`：自动 JSON 序列化发送。
  - `ping()` / `sendText(text)`：测试用，分别触发后端 `pong` / `echo` 响应。
  - `close()`：关闭连接并清理所有订阅。
  - `get isOpen` / `get sessionId` / `get requestedSession`：状态查询。
- **session_id 注册机制**：连接时传入 `sessionId`（前端生成的 UUID），后端把该连接注册到对应 session 下；后台流式 LLM 任务通过 `notify_session` 精确推送 token 到本连接。未传入时注册到 `"default"`，仅接收全局广播（如插件对话已接收事件）。
- **`generateSessionId()`**：优先 `crypto.randomUUID()`，回退 `Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10)`。
- **协议对齐**（与 [backend/app/routers/ws.py](../../../backend/app/routers/ws.py) 对齐）：
  - 连接建立 → 后端推送 `{ type: "welcome", message, session_id }`
  - 客户端发 `{ type: "ping" }` → 后端回 `{ type: "pong" }`
  - 客户端发其他 JSON → 后端回 `{ type: "echo", data }`
  - 流式 LLM 推送：`graph_agent_token` / `graph_agent_done` / `graph_agent_cancelled` / `graph_agent_error`
  - 插件对话广播：`plugin.conversation_received`
  - 多轮对话 Chat 推送：`chat_token` / `chat_done` / `chat_cancelled` / `chat_error` / `chat_tool_call` / `chat_tool_result` / `chat_tool_call_confirmation`

### `types.ts`（前后端类型契约）

- **与 [backend/app/models/schemas.py](../../../backend/app/models/schemas.py) 一一对应**，作为前后端通信契约。
- **命名约定**：前端用 camelCase（如 `conversationMarkdown`），后端用 snake_case（如 `conversation_markdown`）；转换在 `api.ts` 请求构造时完成。
- **核心类型分组**：
  - 通用：`HealthResponse` / `ErrorResponse`
  - WebSocket 事件：`WsEvent` 联合类型、`GraphAgentOp`、`GraphAgentTokenEvent` / `GraphAgentDoneEvent` / `GraphAgentCancelledEvent` / `GraphAgentErrorEvent`、`PluginConversationReceivedEvent`
  - 图谱：`Graph` / `GraphCreate` / `GraphUpdate` / `FullGraph` / `GraphStats` / `Mode` / `ViewType`
  - 节点：`Node` / `NodeCreate` / `NodeUpdate` / `NodeDetailResponse` / `UserFillAppend` / `NodeDetail` / `ExtensionDirection`
  - 边：`Edge` / `EdgeCreate`
  - 延伸：`ExtendMode` / `ExtendRequest` / `ExtendResponse` / `ExtendRevokeResponse`
  - 抽取：`ExtractRequest` / `ExtractResponse` / `CandidateNode` / `BatchCreateNodesRequest` / `BatchCreateNodesResponse`
  - 测验：`Quiz` / `QuizType` / `QuizOption` / `QuizGenerateRequest` / `QuizAnswerRequest` / `QuizGradeResult`（含 `ChoiceGradeResult` / `FeynmanGradeResult`）
  - Work：`CandidateWorkObject` / `WorkExtractRequest` / `WorkExtractResponse` / `WorkConfirmRequest` / `WorkConfirmResponse` / `Trend` / `TrendsResponse` / `TrendAddResponse` / `ReportPeriod` / `ReportRequest` / `ReportResponse` / `WorkAskRequest` / `WorkAskResponse` / `AskSource`
  - 插件：`PluginConversationRequest` / `PluginConversationResponse` / `PluginHealthResponse` / `PluginRecentConversationItem` / `PluginRecentConversationsResponse`
  - 推荐：`RecommendationItem` / `RecommendationsResponse`
  - LLM 配置：`LlmConfig` / `LlmConfigUpdate` / `LlmConfigUpdateResponse` / `LlmRequestInfo` / `LlmCancelResponse` / **`LlmTestConnectionRequest`**（`base_url? / api_key? / model?` 全部可选，空则后端用已保存值）/ **`LlmTestConnectionResponse`**（`ok: boolean` + `latency_ms: number` + `model: string` + `base_url: string` + `message: string` + `reply?: string`，永远返回不抛 HTTP 异常）
  - 流式：`StreamStartedResponse`
  - 多轮对话 Chat（约 20 个类型）：
    - 会话：`ChatSession` / `CreateChatSessionRequest` / `ListChatSessionsResponse`
    - 消息：`ChatMessage`（含可选 `tool_calls?: ToolCall[]`）/ `ListChatMessagesResponse`
    - 工具调用：`ToolCall`（id / tool / args / result? / status: 'pending'|'done'|'error'）
    - Checkpoint：`ChatCheckpoint` / `TriggerCheckpointResponse`
    - 流式：`StartChatStreamRequest` / `ChatStreamStartedResponse` / `CancelChatResponse`
    - 工具确认：`ConfirmToolCallRequest` / `ConfirmToolCallResponse` / `ToolConfirmation`（含 request_id / tool / args / timeout / session_id?）
    - WS 事件：`ChatOp`（'chat'）/ `ChatToolCallEvent` / `ChatToolResultEvent` / `ChatToolConfirmationEvent` / `ChatTokenEvent` / `ChatDoneEvent` / `ChatCancelledEvent` / `ChatErrorEvent`
    - `WsEvent` 联合类型扩展加入上述 7 个 chat 事件
  - 通用删除：`DeleteResult`

### `nodeTemplates.ts`（节点模板镜像）

- **与 [backend/app/models/node_types.py](../../../backend/app/models/node_types.py) 一一对应的镜像常量**。
- **Study 学科枚举**：`STUDY_SUBJECTS`（含 chinese / math / english / history / geography / politics / biology / chemistry / physics / programming / llm / general）+ 中文标签 `STUDY_SUBJECT_LABELS`。
- **Work 工作对象枚举**：`WORK_OBJECTS`（含 thread / key_person / commitment / expectation / event / decision / risk / material / preference / review）+ 中文标签 `WORK_OBJECT_LABELS`。
- **模板定义**：`STUDY_TEMPLATES` / `WORK_TEMPLATES` + 通用兜底 `FALLBACK_TEMPLATE`。
- **核心函数**：`getTemplate(graphType, nodeType)` 按图谱类型与节点类型选取模板，未命中走兜底（不空白、不报错）。
- **用户留白类型**：`USER_FILL_TYPES`（疑问 / 联想 / 考点 / 易错点 / 笔记）+ 标签 `USER_FILL_LABELS`。
- **详情卡 generated 字段键**：`DETAIL_KEY_SUMMARY` / `DETAIL_KEY_IMPORTANT` / `DETAIL_KEY_EXTENSIONS` / `DETAIL_KEY_TEMPLATE` / `DETAIL_KEY_DEGRADED` / `DETAIL_KEY_REASON`。

### `electron.d.ts`（Electron 桥类型声明）

- 声明 `window.electronAPI` 全局类型，与 [electron/preload.ts](../../electron/preload.ts) 的 `contextBridge.exposeInMainWorld('electronAPI', ...)` 对齐。
- **`BackendApi` 接口**：
  - `getUrl(): string`：获取后端 HTTP 基地址（生产环境 `http://127.0.0.1:8788`）。
  - `getWsUrl(): string`：获取后端 WebSocket 基地址（生产环境 `ws://127.0.0.1:8788`）。
- **`ElectronAPI` 接口**：`{ backend: BackendApi }`。
- **`Window` 接口扩展**：`electronAPI?: ElectronAPI`（非 Electron 环境下为 undefined，调用方需用可选链防御）。
- 该文件无运行时代码（`export {}` 仅用于声明模块），仅提供 TS 类型支持。

## 开发工作流

### 新增一个后端 API 调用

1. **后端先行**：在 [backend/app/routers/](../../../backend/app/routers/) 添加路由，在 [schemas.py](../../../backend/app/models/schemas.py) 添加请求 / 响应 Pydantic 模型。
2. **同步类型**：在 `types.ts` 添加对应的 TS 类型，命名保持 camelCase；如带请求体，定义 `XxxRequest`；如带响应体，定义 `XxxResponse`。
3. **添加 API 方法**：在 `api.ts` 的 `api` 对象中添加方法，按业务域分组放置；用 `request<T>(path, init)` 封装，路径不含 `/api` 前缀（由 `request` 自动拼）。
4. **添加 store action**：在 [useAppStore.ts](../store/useAppStore.ts) 添加状态字段与 action，组件层不直接调 `api.xxx`。
5. **联调验证**：dev 环境通过 Vite 代理访问后端；如遇 CORS 问题，检查 [vite.config.ts](../../vite.config.ts) 的 proxy 配置。

### 新增一个 WebSocket 事件类型

1. 后端在 [ws.py](../../../backend/app/routers/ws.py) 添加推送逻辑。
2. 在 `types.ts` 的 `WsEvent` 联合类型添加新事件类型（如 `{ type: 'xxx_yyy'; foo: string }`）。
3. 在 [App.tsx](../App.tsx) 的 `onEvent` 回调中按 `event.type` 分支处理。
4. 如需更新业务态，在 [useAppStore.ts](../store/useAppStore.ts) 添加对应 handler action（参考 `handlePluginConversationReceived`）。

### 新增节点类型

1. 后端在 [node_types.py](../../../backend/app/models/node_types.py) 添加枚举值与模板。
2. 在 `nodeTemplates.ts` 同步添加：
   - 枚举常量（如 `STUDY_SUBJECT_XXX = 'xxx'`）。
   - 加入 `STUDY_SUBJECTS` / `WORK_OBJECTS` 数组。
   - 中文标签 `STUDY_SUBJECT_LABELS[xxx] = '中文'`。
   - 模板字段定义加入 `STUDY_TEMPLATES` / `WORK_TEMPLATES`。
3. 前端组件（NodeEditor / NodeDetailCard）自动按新模板渲染，无需改动。

### 新增一个 LLM 流式操作类型

1. 后端在 [services/graph_agent.py](../../../backend/app/services/graph_agent.py) 添加流式方法（如 `generate_xxx_stream`）。
2. 在 `types.ts` 的 `GraphAgentOp` 联合类型添加新值（如 `'generate_xxx'`）。
3. 在 [useAppStore.ts](../store/useAppStore.ts) 添加对应流式状态字段（如 `xxxStreamingText` / `xxxStreamingActive`）。
4. 在 `handleGraphAgentToken` / `handleGraphAgentDone` / `handleGraphAgentCancelled` / `handleGraphAgentError` 中按 `op` 分支处理新值。
5. 在 `api.ts` 添加 `streamXxx` 触发方法。
6. 在 store 添加 `xxxStream` action 调用 `api.streamXxx`，参考 `askWorkQuestionStream`。

## 代码约定

1. **命名**：前端一律 camelCase，后端 snake_case，转换在 `api.ts` 请求构造时完成；`metadata` 内的自由字段保留 snake_case（如 `conversation_id`）。
2. **类型契约**：所有 API 方法的入参与返回值必须有 TS 类型，与 `types.ts` 对齐；禁止 `any`。
3. **错误处理**：`api.ts` 统一抛 `ApiError`，store 层 catch 后写入 `error` 状态或弹 Toast；组件层不直接 catch。
4. **环境隔离**：`api.ts` / `ws.ts` 必须同时支持 dev（Vite 代理）与生产（`file://` 直连）两种环境，通过 `httpBase()` / `wsBase()` 解析。
5. **可选链防御**：访问 `window.electronAPI` 必须用可选链（`window.electronAPI?.backend?.getUrl()`），dev 环境下该字段为 undefined。
6. **请求体序列化**：`request<T>` 自动 `JSON.stringify`，调用方传对象即可；`FormData` 不序列化，原样传递。
7. **WebSocket 单连接**：全局只维护一个 `TestSocket` 实例（在 [App.tsx](../App.tsx) 中），所有流式任务共用；通过 `session_id` 区分不同任务。
8. **类型导入**：用 `import type { ... }` 而非 `import { ... }`，避免运行时引入无用代码（符合 `isolatedModules: true` 约束）。

## 常见任务

### 修改后端端口

后端默认监听 `8788`，如需修改：

1. 后端 [config.py](../../../backend/app/config.py) 改 `port`。
2. 本目录 `api.ts` 改 `FALLBACK_BACKEND_ORIGIN`。
3. 本目录 `ws.ts` 改 `FALLBACK`。
4. [vite.config.ts](../../vite.config.ts) 改 proxy target。
5. [electron/launcher.ts](../../electron/launcher.ts) 改健康检查 URL。

### 添加查询参数过滤

参考 `listObservations` 实现：用 `withQuery(base, params)` 拼接，跳过 undefined / 空值。

```ts
listObservations: (params?: { processed?: boolean; source?: string }) => {
  const q: Record<string, string> = {}
  if (params?.processed !== undefined) q.processed = String(params.processed)
  if (params?.source) q.source = params.source
  return request<Observation[]>(withQuery('/observations', q))
},
```

### 添加文件下载 API

参考 `exportReportDocx` 实现：不走 `request<T>` 封装，直接 `fetch` 拿 Blob。

```ts
exportXxxFile: async (graphId: string) => {
  const url = `${httpBase()}/api/graphs/${graphId}/xxx/export`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) throw new ApiError(`导出失败：HTTP ${res.status}`, 'http_error', res.status)
  const blob = await res.blob()
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = 'xxx.docx'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  return { ok: true }
},
```

## 扩展点

1. **API 客户端实例化**：当前 `api` 是单例对象；如需多后端（dev / staging），可参考 `kwa-push.js` 的 `createClient` 模式封装。
2. **WebSocket 重连**：当前 `TestSocket` 不自动重连；如需重连，在 `onclose` 中延迟 `connect` 并指数退避。
3. **请求拦截器**：当前无全局请求拦截器（如添加 `Authorization` header）；如需鉴权，在 `request<T>` 中读取 token 注入 header。
4. **类型生成**：当前 `types.ts` 手写维护；后续可引入 `openapi-typescript` 从后端 OpenAPI 自动生成。

## 注意事项

1. **dev 与生产环境差异**：dev 用相对路径走 Vite 代理（避免 CORS）；生产用绝对路径直连后端（`file://` 加载时无同源限制）。修改基地址逻辑时两种环境都要测。
2. **`window.electronAPI` 在 dev 为 undefined**：dev 环境下渲染进程直接由 Vite 加载，preload 未注入；所有访问必须用可选链。
3. **WebSocket 在 dev 走 Vite 代理**：[vite.config.ts](../../vite.config.ts) 已为 `/ws` 开启 `ws: true` 代理；如代理失效，检查 `target` 是否指向后端 8788。
4. **流式 token 顺序**：后端按 `seq` 递增推送 token，但 WebSocket 不保证严格顺序；前端按到达顺序追加，不依赖 `seq` 重排。
5. **`metadata` 自由字段**：插件推送的 `metadata` 可含任意字段，后端原样存入 `metadata_json`；前端类型仅声明已知字段，其余用 `[k: string]: unknown` 兜底。
6. **类型同步**：后端 schema 变更后必须同步 `types.ts`，否则前端类型与实际响应不一致；建议联调时用 `console.log` 验证响应结构。
7. **`ApiError` 的 `status=0`**：网络错误 / 超时 / 调用方取消时 `status=0`，无法区分；如需区分，扩展 `ApiError` 增加 `code` 字段（如 `timeout` / `aborted`）。
8. **`exportReportDocx` 文件名**：后端用 RFC5987 编码中文文件名，前端用正则解析 `filename*=UTF-8''xxx`；如解析失败回退 `filename="xxx"`，再失败用默认名 `work_<period>.docx`。

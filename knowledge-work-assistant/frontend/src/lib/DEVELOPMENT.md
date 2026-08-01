# lib/ 通信层与类型契约开发指南

> 一句话定位：本目录是 KWA 前端渲染进程的"通信层 + 类型契约层 + 外观主题层 + 动效运行时层"，8 个文件分别承担 HTTP 客户端（`api.ts`）、WebSocket 客户端（`ws.ts`）、前后端类型契约（`types.ts`）、外观系统主题（`themes.ts`）、节点模板镜像（`nodeTemplates.ts`）、时间工具（`date.ts`）、动效运行时（`motion.ts`）、Electron 桥类型声明（`electron.d.ts`）。本目录**不写业务逻辑**，只做"通信封装 + 类型定义 + 主题常量 + 动效基建"；业务态由 [`store/useAppStore.ts`](../store/useAppStore.ts) 管理，组件层通过 `useAppStore` 间接调用本目录 API。

## 模块职责

```
lib/
├── api.ts               # HTTP 客户端：/api 前缀 + file:// 环境地址解析 + ApiError + 全部 API 方法
├── ws.ts                # WebSocket 客户端：TestSocket 类 + generateSessionId + 后端协议对齐
├── types.ts             # 与 backend/app/models/schemas.py 一一对应的 TypeScript 类型定义
├── themes.ts            # 外观系统主题定义：Theme 类型 + THEMES 元信息 + localStorage 持久化
├── nodeTemplates.ts     # 与 backend/app/models/node_types.py 一一对应的节点模板镜像
├── date.ts              # 时间解析与格式化工具：parseDate / formatDateTime / formatShortTime
├── motion.ts            # 动效运行时：MotionProvider（自适应画质降级）+ MOTION 常量 + handoffReducer 状态机
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

### `themes.ts`（外观系统主题定义）

- **与模式（mode）解耦的中性色板系统**：主题决定 bg / surface / border / text 等中性灰阶，mode 仅决定 `--accent` 强调色；新增主题无需改组件代码，仅追加 `THEMES` 项 + app.css 对应 `data-theme` 块。
- **主题集合**：3 个预置主题（后续可扩展）：
  - `simple-white`（默认）：明亮克制的日常工作台，强调清晰层级与舒适留白；
  - `simple-black`：低眩光深灰工作台，适合长时间专注与图谱浏览；
  - `angular-white`：锐角工业控制台，使用紧凑结构与明确状态标记。
- **核心类型与常量**：
  - `Theme`：主题 id 字面量联合类型（`'simple-white' | 'simple-black' | 'angular-white'`）。
  - `ThemeMeta`：主题元信息（id / label / description / isDark），用于设置面板的主题卡片展示。
  - `DEFAULT_THEME: Theme = 'simple-white'`：localStorage 缺失或非法时的回退值。
  - `THEME_STORAGE_KEY: string = 'kwa.theme'`：localStorage 持久化键名。
  - `THEMES: ThemeMeta[]`：全部可选主题，按设置面板展示顺序排列。
- **类型守卫**：`isValidTheme(id: unknown): id is Theme`——localStorage 读取后的类型守卫，避免把非法字符串直接当作 Theme 使用；未命中时返回 `false`，调用方用 `DEFAULT_THEME` 回退。
- **`resolveStoredTheme(storage)`**：从给定 `Storage`（或 `null`）安全读取并校验主题，非法 / 缺失 / 隐私模式禁用 localStorage 时回退 `DEFAULT_THEME`。抽离此函数是为了让 [main.tsx](../main.tsx) 在 React 首次渲染前同步设置 `document.documentElement.dataset.theme`（消除主题 FOUC），同时 [useAppStore.ts](../store/useAppStore.ts) 的 `loadInitialTheme` 复用同一逻辑；传入 `null` 时直接回退默认，便于 SSR / 非浏览器环境兜底。
- **在 App 层的接入**：[main.tsx](../main.tsx) 在 `createRoot` 前同步设置 `dataset.theme` 与 `colorScheme`；[App.tsx](../App.tsx) 启动时从 localStorage 读取并校验后写入 `store.theme`；`useEffect` 监听 `theme` 变化，把值写到 `document.documentElement.dataset.theme` 与 `<meta name="theme-color">`（PWA 顶栏色）；`.app-shell` 根节点同时带 `data-mode` 与 `data-theme` 两个属性，CSS 通过双重属性选择器定位。

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

### `date.ts`（时间解析与格式化工具）（新增）

- **一句话定位**：统一处理后端返回的 UTC 时间字符串，修复 naive ISO 字符串被错误按本地时区解析的问题。
- **背景**：后端数据库存储 UTC 时间（`datetime.now(UTC)`），FastAPI 序列化为 ISO 8601 格式。对于带时区后缀的字符串（`+00:00` / `Z`），JS 的 `new Date()` 能正确识别；但对于无时区后缀的 naive 字符串，JS 会按**本地时区**解析，导致 UTC 时间被错误加上/减去时区偏差（东八区快 8 小时）。
- **核心函数**：
  - `parseDate(v: unknown): Date | null`：安全解析后端返回的时间值。
    - `number` / 纯数字字符串：当作 Unix **秒** 时间戳（后端 `time.time()`）。
    - ISO string：若末尾无时区标记（`Z` / `+HH:MM` / `-HH:MM`），追加 `'Z'` 当作 UTC。
    - `Date`：直接返回。
    - 其他 / 无效值：返回 `null`。
  - `formatDateTime(v: unknown): string`：格式化为「YYYY-MM-DD HH:MM」本地时间（用于列表项、时间线等）。
  - `formatShortTime(v: unknown): string`：格式化为「MM-DD HH:MM」简短本地时间（用于消息、最近记录）。
  - `formatTime(v: unknown): string`：格式化为「HH:MM」时分（用于当日时间线）。
- **使用场景**（当前已接入的 7 个组件 / 文件，统一替换早期各自实现的本地 `formatTime` / `new Date(...)`）：
  - [`components/RecommendationCard.tsx`](../components/RecommendationCard.tsx)：work 模式提醒时间 `formatRemindAt`（用 `parseDate`）。
  - [`components/PluginIntegrationSection.tsx`](../components/PluginIntegrationSection.tsx)：最近推送对话时间戳（用 `formatShortTime`）。
  - [`components/ChatExpandedOverlay.tsx`](../components/ChatExpandedOverlay.tsx)：节点详情卡的提醒时间、创建时间（用 `parseDate`）。
  - [`components/GraphList.tsx`](../components/GraphList.tsx)：图谱列表项的"更新于 ..."（用 `formatShortTime`）。
  - [`components/graph/NodeDetailCard.tsx`](../components/graph/NodeDetailCard.tsx)：节点详情相关 ISO 字符串（用 `parseDate`）。
  - [`components/graph/PendingNodes.tsx`](../components/graph/PendingNodes.tsx)：观察项时间显示（用 `formatShortTime`）。
  - [`components/graph/QuizPanel.tsx`](../components/graph/QuizPanel.tsx)：测验生成时间 / 作答时间（用 `formatShortTime`）。
  - 后续所有涉及后端时间显示的地方应统一使用此模块，避免直接 `new Date(iso_string)`。
- **注意事项**：
  - **不要直接 `new Date(iso_string)`**：对于无时区后缀的 naive 字符串，必须通过 `parseDate` 追加 `'Z'` 后再解析。
  - **Unix 时间戳识别**：后端 `time.time()` 返回秒级时间戳，前端需乘 1000 转 ms；本模块自动判断数值范围（大于 1e12 认为已是 ms）。
  - **类型安全**：入参为 `unknown`，调用方无需前置判断；返回 `null` 时调用方用空字符串兜底。

### `motion.ts`（动效运行时）（新增）

- **一句话定位**：统一 motion（Framer Motion）动效入口，提供自适应画质降级、统一时长常量与大卡生命周期状态机；组件层通过 `useMotionRuntime()` 读取当前画质并据此缩放时长，**不**在各组件自行 `requestAnimationFrame` 采样。
- **依赖**：`motion@^12.43.0`（`motion/react`），由 [package.json](../../package.json) 声明。
- **`MotionProvider`**：在 [main.tsx](../main.tsx) 顶层包裹 `<App />`，做三件事：
  1. **初始画质**：`initialQuality()` 按 `navigator.hardwareConcurrency` / `deviceMemory` 决定起步画质（≤4 核或≤4GB 内存起步 `standard`，否则 `high`）。
  2. **FPS 自适应降级**：用 `requestAnimationFrame` 采样 120 帧，统计 FPS 与长帧（>34ms）比例；FPS<30 或长帧>35% → `reduced`，FPS<48 或长帧>16%（且当前为 high）→ `standard`。采样仅在不隐藏页签时累积，避免后台空转。`prefers-reduced-motion` 命中时直接锁定 `reduced` 不再采样。
  3. **写回 DOM**：把当前画质写到 `document.documentElement.dataset.motionQuality`，供 CSS 按 `html[data-motion-quality='standard'|'reduced']` 调整 / 关闭过渡（见 [styles/DEVELOPMENT.md](../styles/DEVELOPMENT.md)）；卸载时删除该属性。同时用 `MotionConfig` 把 `reducedMotion` / 默认 `transition` 下发给所有 motion 子树。
- **`useMotionRuntime()`**：返回 `{ quality, reduceMotion, allowBlur, duration }`。`duration(seconds)` 在 `reduced` 画质返回 `0`、`standard` 返回 `seconds * 0.65`、`high` 原值返回；组件用它包裹 `MOTION.xxx` 常量得到实际渲染时长。`allowBlur` 在 `reduced` 或用户偏好减少动效时为 `false`，供高斯模糊类装饰据此跳过。
- **`MOTION` 常量**：`fast=0.16` / `panel=0.22` / `expand=0.34` / `handoff=0.26`（秒）+ `ease` / `springEase` 两条缓动曲线。所有动效时长应取自此处，禁止散落硬编码。
- **`handoffReducer` + `HandoffPhase` / `HandoffEvent`**：大卡生命周期的显式有限状态机（`closed → opening → open → handoff/closing → closed`），替代早期多个布尔值组合出非法状态的写法。由 [ChatExpandedOverlay.tsx](../components/ChatExpandedOverlay.tsx) `useReducer` 持有，非法 / 重复事件保持当前状态。
- **注意事项**：
  - **降级只影响装饰性动画**：位移、淡入、布局动画的时长会被缩放或归零，但**不影响交互回调**（如 `onLayoutAnimationComplete` 仍会触发），保证接力完成逻辑不被降级卡死。
  - **不要在组件内自行采样 FPS**：统一由 `MotionProvider` 采样并下发，组件只读 `useMotionRuntime()`。
  - **`MotionProvider` 必须在 `App` 之外**：在 [main.tsx](../main.tsx) 包裹，确保 `useMotionRuntime` 在所有组件可用。

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

1. **API 客户端实例化**：当前 `api` 是单例对象；如需多后端（dev / staging），可参考 OpenAI 兼容客户端的工厂模式自行封装 `createClient(baseUrl)` 函数。
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

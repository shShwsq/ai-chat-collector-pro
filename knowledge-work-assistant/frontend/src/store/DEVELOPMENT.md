# store/ 全局状态开发指南

> 一句话定位：本目录是 KWA 前端的"全局状态层"，仅有一个文件 `useAppStore.ts`，用 **Zustand** 集中管理渲染进程的全部业务态（模式 / 视图 / 图谱 / 节点 / 候选 / 测验 / Work 业务 / 推荐 / 设置 / 流式 / Toast）与对应 action。本目录**不写 UI**，只做"状态 + 副作用"；组件层通过 `useAppStore(s => s.xxx)` 选择器订阅所需字段，action 调用 [`lib/api.ts`](../lib/api.ts) 与后端通信。

## 模块职责

```
store/
├── useAppStore.ts    # Zustand 单一 store：所有业务态 + 全部 action（约 90+ 字段 / 80+ action）
└── __tests__/        # 状态测试套件，vitest 跑（详见 __tests__/DEVELOPMENT.md）
    └── useAppStore.plugin-event.test.ts # WS 事件处理 action 测试（插件事件 + chat 事件）
```

## 关键文件说明

### `useAppStore.ts`（单一 store）

- **状态规模**：约 90+ 状态字段 + 80+ action，是 KWA 前端最大的单文件（约 2900+ 行）。
- **核心导出**：`useAppStore`（Zustand hook）、`ToastType` / `ToastMessage` / `ActiveNav` / `WorkPanel` / `QaMessage` 类型。
- **设计原则**：
  1. **单一 store**：所有业务态集中管理，避免多 store 同步问题；UI 控制态（如 `isHover`）由组件本地 state 管理。
  2. **模式切换即隔离**：`setMode` 清空当前模式相关状态后重新加载新模式图谱，确保 study 与 work 数据互不交叉。
  3. **错误不抛出**：所有 action 捕获异常后写入 `error` 状态并返回 falsy（`false` / `null`），组件层据此展示，不中断渲染。
  4. **创建后自动选中**：`createGraph` 成功后自动 `select` 新图谱并加载完整数据，减少用户操作步数。
  5. **延伸后整图刷新**：`extendNode` / `revokeExtend` / `batchCreateNodes` / `confirmWorkObjects` / `addTrendToGraph` 成功后调用 `loadFullGraph` 重新拉取整图，确保前后端状态一致；同时 `flashNodes` 触发新建 / 已存在节点闪烁高亮。
  6. **测验流程三段式**：config → answering → result，每次生成新题进入 answering，作答后进入 result；历史项可点击复盘重新进入 result 阶段。
  7. **流式优先回退**：有 `streamingSessionId` 时优先调用流式 API（`askWorkQuestionStream` / `generateReportStream` / `generateNodeDetailStream`），否则回退非流式（`askWorkQuestion` / `generateReport` / `generateNodeDetail`）。

### 状态字段分组

#### 基础态

- `mode: Mode`（study / work）、`view: ViewType`（graph / card）、`activeNav: ActiveNav`（chat / graph / settings）、`navDirection: -1 | 0 | 1`（普通导航切换方向：1 向右进入 / -1 向左进入 / 0 不播放位移，由 `setActiveNav` 按 chat<graph<settings 顺序计算，供 [App.tsx](../App.tsx) 的 `AnimatePresence` 视图切换做方向化横向滑动）
- `theme: Theme`（simple-white / simple-black / angular-white，由 [themes.ts](../lib/themes.ts) 定义；启动时从 localStorage 读取 `isValidTheme` 校验，非法回退 `DEFAULT_THEME`）
- `currentGraphId: string | null`、`graphs: Graph[]`、`fullGraph: FullGraph | null`、`selectedNodeId: string | null`
- `loading: boolean`、`error: string`、`reminderCount: number`

#### Task 8 节点延伸

- `extensionBatchId: string | null`、`extensionBatchNodeId: string | null`、`extending: boolean`、`flashNodeIds: string[]`

#### Task 11 候选节点抽取

- `pendingObservations: Observation[]`、`candidateNodes: CandidateNode[]`、`candidateObservationId: string | null`
- `extracting: boolean`、`batchCreating: boolean`、`pendingPanelOpen: boolean`

#### Task 12 测验

- `quizPanelOpen: boolean`、`quizStage: 'config' | 'answering' | 'result'`、`quizType: QuizType`、`quizNodeIds: string[] | null`
- `currentQuiz: Quiz | null`、`quizHistory: Quiz[]`、`quizGradeResult: QuizGradeResult | null`
- `generatingQuiz: boolean`、`answeringQuiz: boolean`、`loadingQuizHistory: boolean`

#### Task 13/14/15/16 Work 业务

- `workActivePanel: WorkPanel`（none / input / trends / report / qa）、`candidateWorkObjects: CandidateWorkObject[]`
- `workExtracting: boolean`、`workConfirming: boolean`
- `trends: Trend[]`、`trendsLoading: boolean`、`trendAddingIndex: number | null`
- `reportPeriod: ReportPeriod`、`reportResult: ReportResponse | null`、`reportGenerating: boolean`、`reportExporting: boolean`
- `qaMessages: QaMessage[]`、`qaAsking: boolean`

#### 推荐 / touch / remind / star

- `recommendations: RecommendationItem[]`、`recommendationsLoading: boolean`、`recommendationsError: string`、`recommendationsMode: 'study' | 'work'`

#### 设置面板：LLM 配置

- `llmRequests: LlmRequestInfo[]`、`llmRequestsLoading: boolean`、`llmRequestsError: string`、`llmCancellingId: string | null`
- `llmConfig: LlmConfig | null`、`llmConfigLoading: boolean`、`llmConfigSaving: boolean`
- **新增（LLM 连接测试：`llmTesting: boolean`、`llmTestResult: LlmTestConnectionResponse | null`（「测试连接」按钮加载态与结果展示）

#### 设置面板：插件对接

- `pluginRecent: PluginRecentConversationItem[]`、`pluginRecentLoading: boolean`、`pluginRecentError: string`、`pluginContract: Record<string, unknown> | null`

#### 流式输出态

- `streamingSessionId: string | null`（由 [App.tsx](../App.tsx) 启动时生成 UUID 并设置）
- `qaStreamingText: string`、`qaStreamingActive: boolean`
- `reportStreamingText: string`、`reportStreamingActive: boolean`
- `nodeDetailStreamingText: string`、`nodeDetailStreamingActive: boolean`、`nodeDetailStreamingNodeId: string | null`

#### Task 9 多轮对话 Chat + Task 10 高风险工具确认

- `chatSessions: ChatSession[]`、`currentChatSession: ChatSession | null`、`chatMessages: ChatMessage[]`
- `chatStreamingActive: boolean`、`chatStreamingText: string`、`chatStreamingRequestId: string | null`、`chatAsking: boolean`
- `currentCheckpoint: ChatCheckpoint | null`
- `planMode: boolean`（Work 模式 Plan/Build 切换）
- `pendingToolConfirmation: ToolConfirmation | null`（Task 10 高风险工具确认）
- `chatExpandedNodeId: string | null`（对话首页大卡浮层展开态，提升到全局以跨视图存活）
- `graphHandoffPhase: 'idle' | 'preparing' | 'graph-ready' | 'landing'`（对话大卡到图谱详情卡的跨视图接力阶段，由 [ChatExpandedOverlay](../components/ChatExpandedOverlay.tsx) 在「延伸拓展」流程中驱动：preparing → 等图谱/节点就绪 → graph-ready → 布局动画完成 → landing → idle）

#### 通用 Toast

- `toast: ToastMessage | null`（含 `id` / `type` / `message`）

### 关键 action

#### 模式 / 视图 / 导航

- `setMode(mode)`：清空当前模式相关状态（含延伸 / 候选 / 测验 / Work / 流式 / Chat 会话与消息 / 工具确认态 / 大卡浮层态 / Toast），重新加载新模式图谱列表。
- `setTheme(theme)`：切换外观主题；写入 `theme` 状态并同步到 `localStorage.setItem(THEME_STORAGE_KEY, theme)`；App.tsx 的 `useEffect` 监听后会把值同步到 `document.documentElement.dataset.theme` 与 `theme-color` meta 标签。
- `setView(view)`：切换内容区视图（graph / card）。
- `setActiveNav(nav)`：切换左侧竖排导航；按 chat(0) < graph(1) < settings(2) 顺序计算 `navDirection`（向右进入=1 / 向左进入=-1）写入状态，供 [App.tsx](../App.tsx) 的 `AnimatePresence` 做方向化视图滑动；进入 `chat` 时加载推荐 + 刷新角标 + 调 `loadChatSessions()`，进入 `settings` 时懒加载 LLM 配置。
- `setSelectedNode(id)`：选中节点（图谱视图与卡片视图间同步）。
- `selectGraph(id)`：切换图谱，清空选中节点 / 延伸批次 / 候选 / 测验作答态 / Work 业务态 / 流式态 / Chat 会话与消息 / 工具确认态 / 大卡浮层态；自动加载完整图谱。

#### 图谱 CRUD

- `loadGraphs()`：加载当前模式图谱列表。
- `loadFullGraph(id)`：加载指定图谱完整数据（含 nodes / edges / stats）。
- `createGraph(name)`：新建图谱，成功后自动选中并加载完整数据。返回新建图谱或 null。
- `renameGraph(id, name)` / `deleteGraph(id)`：重命名 / 删除图谱。

#### 节点操作

- `updateNode(nodeId, body)`：更新节点字段，本地同步替换 `fullGraph.nodes`。
- `deleteNode(nodeId)`：删除节点，本地同步移除 nodes / edges / stats；如删除的是选中节点，清空 selectedNodeId。
- `appendUserFill(nodeId, fillType, content)`：向节点 user_fill 追加一条内容。
- `generateNodeDetail(nodeId)`：生成（或复用缓存）节点详情卡内容。
- **新增 `syncNodeDetailToGraph(nodeId)`**：从 `recommendations` 中查找同 id item 的预生成 `detail_payload`，合并写入 `fullGraph.nodes[nodeId].detail_payload`，用于用户从推荐大卡切换到图谱视图时复用详情、避免重复生成；找不到 item 或无 detail_payload 时为安全 no-op，不覆盖已存在的 detail_payload。
- `extendNode(nodeId, mode, directionName?)`：基于源节点生成延伸节点；mode='all' 双击触发全部延伸（可撤销），mode='single' 单击方向触发单点延伸（不进 batch）。
- `revokeExtend()`：撤销上一次全部延伸（删除该批新节点与边）。
- `flashNodes(ids, autoClear=true)`：触发指定节点闪烁高亮；1.8s 后自动清空（`FLASH_AUTO_CLEAR_MS`）。

#### 候选节点抽取（Task 11）

- `loadPendingObservations()`：加载未处理观察记录列表。
- `extractCandidates(observationId)`：从一条观察记录抽取候选节点（不入图）。
- `clearCandidates()`：清空当前候选节点列表。
- `batchCreateNodes(nodes, observationId?)`：批量创建已确认节点（归一去重），成功后整图刷新 + 闪烁 + 清空候选 + 刷新待抽取列表。
- `togglePendingPanel(open?)`：切换待抽取面板展开 / 收起。

#### 测验（Task 12）

- `setQuizPanelOpen(open?)`：切换测验面板展开 / 收起；打开时自动加载当前图谱历史。
- `setQuizStage(stage)` / `setQuizType(type)` / `setQuizNodeIds(ids)`：阶段 / 题型 / 限定节点设置。
- `generateQuiz()`：调用后端生成一道测验题，成功后进入 answering 阶段、刷新历史。
- `answerQuiz(answer)`：提交作答并判分；选择题本地判分（严格集合相等），费曼题 Agent 语义判分；成功后进入 result 阶段。
- `loadQuizHistory()`：加载当前图谱测验历史。
- `clearQuiz()`：清空当前作答状态，回到 config 阶段。
- `reviewQuiz(quizId)`：复盘历史项，从历史拉取详情并填充 result 阶段。

#### Work 业务（Task 13/14/15/16）

- `setWorkPanel(panel)`：切换当前激活的 Work 浮层面板（传 'none' 关闭全部）；同时清空所有进行中标记避免卡死。
- `extractWorkObjects(text)`：从文本抽取候选工作对象（不入图）。
- `clearCandidateWorkObjects()`：清空当前候选工作对象列表。
- `confirmWorkObjects(objects)`：批量确认工作对象入图（归一去重 + 建立关系边）。
- `generateTrends()`：基于当前 work 图谱生成风口推荐。
- `addTrendToGraph(index)`：把指定风口转为图谱节点。
- `setReportPeriod(period)`：设置报告周期（weekly / monthly）。
- `generateReport()`：生成工作报告（非流式）。
- `exportReportDocx()`：导出当前报告为 .docx 并触发浏览器下载。
- `askWorkQuestion(question)`：提交用户提问（非流式），追加到 qaMessages。
- `clearQaMessages()`：清空提问对话历史。

#### 推荐 / touch / remind / star

- `loadRecommendations(mode)`：加载当前图谱的推荐列表（study 复习 / work 到期提醒）。
- `touchNode(id)`：触发节点 touch，刷新 last_reviewed_at / review_count。
- `setRemind(id, remindAt)` / `clearRemind(id)`：设置 / 清除节点提醒时间。
- `toggleStar(id)`：切换节点星标。
- `loadReminderCount()`：从推荐列表统计到期数量，写入 reminderCount。

#### Task 9 多轮对话 Chat + Task 10 高风险工具确认（17 个 action）

- **会话管理**：`loadChatSessions()` / `createChatSession(body?)` / `selectChatSession(session)` / `clearChat()`
- **消息发送**：`sendMessage(content)` / `cancelChat()`
- **工具确认（Task 10）**：`confirmToolCall()` / `rejectToolCall(reason?)`
- **Checkpoint**：`loadCheckpoint()` / `triggerCheckpoint()`
- **Plan/Build**：`setPlanMode(plan)`
- **大卡浮层**：`setChatExpandedNodeId(id)`、`setGraphHandoffPhase(phase)`（写入跨视图接力阶段，相同值 no-op 避免多余渲染）
- **WS 事件处理**：`handleChatToken` / `handleChatToolCall` / `handleChatToolResult` / `handleChatToolConfirmation` / `handleChatDone` / `handleChatCancelled` / `handleChatError`

#### 通用 Toast

- `pushToast(message, type='info')`：推送一条 Toast 消息；`_toastSeq` 全局自增 id。
- `clearToast()`：清空当前 Toast 消息。

#### 设置面板：LLM 配置

- `loadLlmRequests()`：拉取当前 LLM 请求列表（含活跃 + 近期终态）。
- `cancelLlmRequest(id)`：取消指定 LLM 请求；成功后立即刷新列表。
- `loadLlmConfig()`：拉取当前 LLM 配置（api_key 掩码）。
- `updateLlmConfig(config)`：更新 LLM 配置（仅传需更新字段）；成功后刷新 llmConfig。
- **新增 `testLlmConnection(config: Partial<LlmTestConnectionRequest>)`**：向后端发 `POST /api/llm/test-connection`；加载态写 `llmTesting=true`，完成后把响应写入 `llmTestResult`；捕获异常后仍写失败结果 `{ ok: false, latency_ms: 0, ... }`，不抛错保证组件不白屏；请求体字段可选，未传则后端使用已保存配置验证。

#### 设置面板：插件对接

- `loadPluginRecent(limit=20)`：拉取最近推送的对话记录。
- `loadPluginContract()`：拉取插件对接接口契约 JSON。
- `handlePluginConversationReceived(payload)`：处理 WebSocket 推送的"插件对话已接收"事件：弹 Toast + 若处于图谱视图且为学习模式则刷新待抽取列表。

#### 流式输出 action

- `setStreamingSessionId(id)`：设置 WebSocket session_id（由 [App.tsx](../App.tsx) 启动时调用）。
- `handleGraphAgentToken(event)`：按 `op` 类型追加到对应流式文本状态（answer_question → qaStreamingText + 同步更新最后一条 assistant 消息；generate_report → reportStreamingText + 同步更新 reportResult.markdown；generate_node_detail → nodeDetailStreamingText）。
- `handleGraphAgentDone(event)`：终结流式状态，用 `full_text` 兜底。
- `handleGraphAgentCancelled(event)`：终结流式状态，保留已生成部分文本。
- `handleGraphAgentError(event)`：终结流式状态，弹 Toast 提示错误。
- `askWorkQuestionStream(question)`：流式提问；无 session_id 回退非流式。
- `generateReportStream()`：流式生成报告；无 session_id 回退非流式。
- `generateNodeDetailStream(nodeId)`：流式生成节点详情卡；无 session_id 回退非流式。
- `clearQaStreaming()` / `clearReportStreaming()` / `clearNodeDetailStreaming()`：清空对应流式状态。

## 开发工作流

### 新增一个业务态字段

1. 在 `AppState` interface 添加字段声明（含类型）与对应 action 签名。
2. 在 `create<AppState>((set, get) => ({ ... }))` 中添加字段初始值与 action 实现。
3. action 内部用 `set({ xxx: ... })` 更新状态，用 `get().xxx` 读取当前状态。
4. 异步 action 用 `async` + `try/catch`，catch 后写 `error` 状态 + 弹 Toast + 返回 falsy。
5. 如需联动其他状态（如整图刷新），在 action 内调用 `await get().loadFullGraph(graphId)`。
6. 组件层用 `useAppStore(s => s.xxx)` 订阅，action 用 `useAppStore(s => s.xxxAction)` 获取。

### 新增一个流式操作类型

参考 `askWorkQuestionStream` 实现：

1. 在 [types.ts](../lib/types.ts) 的 `GraphAgentOp` 添加新值。
2. 添加流式状态字段：`xxxStreamingText: string` + `xxxStreamingActive: boolean`。
3. 在 `handleGraphAgentToken` / `handleGraphAgentDone` / `handleGraphAgentCancelled` / `handleGraphAgentError` 中按 `op` 分支处理新值。
4. 添加 `xxxStream()` action：检查 `streamingSessionId` 与 `currentGraphId`，缺失时回退非流式；否则设置流式态后调用 `api.streamXxx`。
5. 添加 `clearXxxStreaming()` action。
6. 在 `setMode` / `selectGraph` 的清空逻辑中加入新流式字段。
7. 在 [api.ts](../lib/api.ts) 添加 `streamXxx` 触发方法。
8. 在组件层（如 [graph/XxxPanel.tsx](../components/graph/)) 调用 `xxxStream()` 并订阅 `xxxStreamingText`。

### 添加一个新的浮层面板

参考 `setWorkPanel` 模式：

1. 在 `WorkPanel` 类型（或新增类似类型）添加新值。
2. 添加 `xxxPanelOpen: boolean` 或复用 `workActivePanel` 状态。
3. 添加 `setXxxPanel(open?)` action。
4. 在 `setMode` / `selectGraph` 的清空逻辑中加入新字段。
5. 在 [App.tsx](../App.tsx) 挂载浮层组件，组件内订阅 `xxxPanelOpen` 并渲染。

## 代码约定

1. **单一 store**：所有业务态集中在 `useAppStore`，不拆分多 store；如状态规模过大，考虑用 Zustand 的 `slice` 模式按业务域拆分文件，但仍合并为单一 store。
2. **选择器订阅**：组件层必须用 `useAppStore(s => s.xxx)` 选择器订阅，避免全量订阅导致无关状态变化触发重渲染。
3. **action 命名**：动词开头，返回 `Promise<boolean>` 或 `Promise<T | null>`；成功返回 truthy，失败返回 falsy。
4. **错误处理**：所有异步 action 必须用 `errMsg(e)` 提取错误消息，写入 `error` 状态 + `pushToast` 弹 Toast + 返回 falsy；不抛出异常到组件层。
5. **状态清空**：`setMode` / `selectGraph` 等切换类 action 必须清空所有相关业务态（延伸 / 候选 / 测验 / Work / 流式），避免跨模式 / 跨图谱残留。
6. **副作用顺序**：先 `set` 更新本地态（如 `loading: true`），再 `await` 异步操作，最后 `set` 更新结果态；如需联动其他 action（如 `loadFullGraph`），在 `try` 块末尾 `await`。
7. **Toast 不刷屏**：高频轮询类 action（如 `loadLlmRequests` / `loadPluginRecent`）失败时不弹 Toast，仅写 `error` 状态供组件层展示。
8. **闪烁定时器**：`flashNodes(ids, true)` 通过模块级 `_flashClearTimer` 管理 1.8s 自动清空；组件层无需手动清理。
9. **类型导入**：用 `import type { ... }` 导入类型，避免运行时引入无用代码。
10. **模块级变量**：`_toastSeq` / `_flashClearTimer` 等模块级变量不进入 store 状态，避免组件订阅触发多余渲染。

## 常见任务

### 修改闪烁高亮时长

修改 `FLASH_AUTO_CLEAR_MS` 常量（默认 1800ms）。

### 修改 Toast 默认类型

`pushToast(message, type='info')` 的 `type` 参数默认 `'info'`；调用方需显式传 `'success'` / `'warning'` / `'error'`。

### 添加一个轮询类 action

参考 `loadLlmRequests` 实现：失败时仅写 `error` 状态，不弹 Toast（避免轮询刷屏）。

```ts
loadXxxList: async () => {
  set({ xxxListLoading: true, xxxListError: '' })
  try {
    const list = await api.getXxxList()
    set({ xxxList: list, xxxListLoading: false })
  } catch (e) {
    const msg = errMsg(e)
    set({ xxxListLoading: false, xxxListError: msg })
    // 不弹 toast，避免轮询刷屏；错误信息在面板内展示
  }
},
```

### 同步更新多个关联状态

用 `set({ ... })` 一次更新多个字段，避免多次 `set` 触发多次渲染。

```ts
set({
  currentGraphId: null,
  fullGraph: null,
  selectedNodeId: null,
  error: '',
  // ... 其他相关字段
})
```

## 扩展点

1. **状态拆分**：如 store 规模继续增长，可按业务域拆分为多个 slice 文件（如 `graphSlice` / `quizSlice` / `workSlice`），再合并为单一 store。
2. **持久化**：当前 store 不持久化；如需持久化部分字段（如 `mode` / `view`），用 `zustand/middleware` 的 `persist`。
3. **DevTools**：Zustand 自带 DevTools middleware，可集成 Redux DevTools 调试状态变化。
4. **测试**：action 是纯函数（除副作用外），已引入 vitest，`store/__tests__/` 下有测试（详见 __tests__/DEVELOPMENT.md）；mock `api` 后即可单元测试。

## 注意事项

1. **状态规模**：本文件约 2100 行，是 KWA 前端最大的单文件；修改时务必先 `Ctrl+F` 定位到对应分组，避免误改其他业务态。
2. **`setMode` 清空逻辑**：每次新增业务态字段，必须同步加入 `setMode` 与 `selectGraph` 的清空逻辑，否则跨模式 / 跨图谱会残留脏数据。
3. **`workActivePanel` 单例**：同一时间只能打开一个 Work 浮层，`setWorkPanel` 切换时会清空所有进行中标记，避免并发触发卡死。
4. **流式态隔离**：`qaStreamingText` / `reportStreamingText` / `nodeDetailStreamingText` 三个流式态相互独立，但共用同一 WebSocket 连接；切换图谱 / 模式时由 `setMode` / `selectGraph` 统一清空。
5. **`_toastSeq` 全局自增**：模块级变量，不进入 store 状态；多次快速 `pushToast` 时 id 单调递增，避免短时间多条消息 id 冲突。
6. **`_flashClearTimer` 模块级**：闪烁自动清除计时器，避免组件卸载后残留；`clearFlash()` 时手动 `clearTimeout`。
7. **`errMsg(e)` 统一错误提取**：`ApiError` 时拼接 `message + detail`，其他错误取 `message`，兜底 `'未知错误'`；所有 action 必须用此函数提取错误消息。
8. **`replaceNode(full, updated)` 工具函数**：用更新后的节点替换 `fullGraph.nodes` 中的同 id 节点；多个 action（`updateNode` / `appendUserFill` / `generateNodeDetail` / `touchNode` / `setRemind` / `clearRemind` / `toggleStar`）复用此函数。
9. **降级处理**：所有依赖 LLM 的 action 必须处理 `degraded=true`，弹 warning Toast 提示用户；不阻断流程。
10. **`handlePluginConversationReceived`**：仅当 `activeNav='graph'` 且 `mode='study'` 时刷新待抽取列表，避免在 Work 模式或非图谱视图时无谓请求。

/**
 * 全局应用状态（Task 3 / Task 8 / Task 11 / Task 12）。
 *
 * 使用 zustand 集中管理：
 * - ``mode``：当前模式（study / work），切换时自动重载该模式图谱列表并清空当前选中
 * - ``view``：内容区视图类型（graph / card），Task 5/6 填充具体渲染
 * - ``currentGraphId`` / ``fullGraph``：当前选中图谱及其完整数据（含 nodes/edges）
 * - ``graphs``：当前模式下的图谱列表
 * - ``loading`` / ``error``：加载与错误状态
 *
 * Task 8 节点延伸：
 * - ``extensionBatchId`` / ``extensionBatchNodeId``：当前可撤销的延伸批次（仅 mode=all）
 * - ``extending``：延伸请求进行中标记
 * - ``flashNodeIds``：需闪烁高亮的节点 id（命中已存在节点 / 新建延伸节点）
 *
 * Task 11 候选节点抽取：
 * - ``pendingObservations``：未处理观察记录列表（侧栏「待抽取」入口）
 * - ``candidateNodes`` / ``candidateObservationId``：当前抽取出的候选节点列表
 * - ``extracting`` / ``batchCreating``：抽取 / 批量创建进行中标记
 *
 * Task 12 测验：
 * - ``quizPanelOpen``：测验面板是否展开
 * - ``quizStage``：测验面板当前阶段（config 配置 / answering 作答 / result 结果）
 * - ``quizType``：当前选择的题型（single_choice / multi_choice / feynman）
 * - ``quizNodeIds``：限定题目涉及的节点 ID 列表（None = 全图随机）
 * - ``currentQuiz``：当前正在作答 / 已作答的测验题
 * - ``quizHistory``：当前图谱的测验历史列表
 * - ``quizGradeResult``：最近一次判分结果（作答后填充）
 * - ``generatingQuiz`` / ``answeringQuiz`` / ``loadingQuizHistory``：进行中标记
 *
 * 通用：
 * - ``toast``：轻量提示消息（成功 / 警告 / 错误），由各 action 触发，组件层消费
 *
 * 动作：setMode / setView / selectGraph / loadGraphs / loadFullGraph /
 * createGraph / renameGraph / deleteGraph / clearError / updateNode / deleteNode /
 * appendUserFill / generateNodeDetail / extendNode / revokeExtend /
 * loadPendingObservations / extractCandidates / clearCandidates / batchCreateNodes /
 * flashNodes / pushToast / clearToast /
 * setQuizPanelOpen / setQuizStage / setQuizType / setQuizNodeIds /
 * generateQuiz / answerQuiz / loadQuizHistory / clearQuiz / reviewQuiz。
 *
 * 设计要点：
 * 1. **模式切换即隔离**：``setMode`` 清空 currentGraphId / fullGraph / graphs 后
 *    重新加载新模式图谱，确保 study 与 work 数据互不交叉。
 * 2. **错误不抛出**：所有 action 捕获异常后写入 ``error`` 状态并返回 falsy，
 *    组件层据此展示，不中断渲染。
 * 3. **创建后自动选中**：``createGraph`` 成功后自动 select 新图谱并加载完整数据，
 *    减少用户操作步数。
 * 4. **延伸后整图刷新**：``extendNode`` / ``revokeExtend`` / ``batchCreateNodes``
 *    成功后调用 ``loadFullGraph`` 重新拉取整图，确保前后端状态一致；
 *    同时 ``flashNodes`` 触发新建 / 已存在节点闪烁高亮。
 * 5. **测验流程三段式**：config → answering → result，每次生成新题进入 answering，
 *    作答后进入 result；历史项可点击复盘重新进入 result 阶段。
 */

import { create } from 'zustand'

import { api, ApiError } from '../lib/api'
import { DEFAULT_THEME, isValidTheme, THEME_STORAGE_KEY, type Theme } from '../lib/themes'
import type {
  AskSource,
  BatchCreateNodesRequest,
  BatchCreateNodesResponse,
  CancelChatResponse,
  CandidateNode,
  CandidateWorkObject,
  ChatCancelledEvent,
  ChatCheckpoint,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatSession,
  ChatStreamStartedResponse,
  ChatThinkingEvent,
  ChatToolCallEvent,
  ChatToolConfirmationEvent,
  ChatToolResultEvent,
  ChatTokenEvent,
  ConfirmToolCallResponse,
  CreateChatSessionRequest,
  ExtendMode,
  ExtendResponse,
  FullGraph,
  Graph,
  GraphAgentCancelledEvent,
  GraphAgentDoneEvent,
  GraphAgentErrorEvent,
  GraphAgentTokenEvent,
  LlmConfig,
  LlmConfigUpdate,
  LlmRequestInfo,
  LlmTestConnectionRequest,
  LlmTestConnectionResponse,
  Mode,
  Node,
  NodeDetailResponse,
  NodeUpdate,
  Observation,
  PluginRecentConversationItem,
  Quiz,
  QuizAnswerRequest,
  QuizGenerateRequest,
  QuizGradeResult,
  QuizOption,
  QuizType,
  RecommendationItem,
  ReportPeriod,
  ReportResponse,
  ToolCall,
  ToolConfirmation,
  Trend,
  TriggerCheckpointResponse,
  ViewType,
  WorkConfirmResponse,
  WorkExtractResponse,
  WorkAskResponse,
} from '../lib/types'
// GraphAgentOp 仅作为类型字面量出现在事件 payload 中，无需在此处导入

/** Toast 类型。 */
export type ToastType = 'info' | 'success' | 'warning' | 'error'

/** Toast 消息体。 */
export interface ToastMessage {
  id: number
  type: ToastType
  message: string
}

/** 左侧竖排导航当前激活项：chat 对话 / graph 图谱 / settings 设置。 */
export type ActiveNav = 'chat' | 'graph' | 'settings'

// ============================================================================
// 模式快照：切换 study/work 时保存当前模式的关键状态，切回时直接恢复
// ============================================================================

/** 模式快照：保存切换模式前的关键状态，切回时恢复，避免重新加载。 */
export interface ModeSnapshot {
  currentGraphId: string | null
  fullGraph: FullGraph | null
  graphs: Graph[]
  selectedNodeId: string | null
  extensionBatchId: string | null
  extensionBatchNodeId: string | null
  flashNodeIds: string[]
  pendingObservations: Observation[]
  candidateNodes: CandidateNode[]
  candidateObservationId: string | null
  pendingPanelOpen: boolean
  quizPanelOpen: boolean
  quizStage: 'config' | 'answering' | 'result'
  quizType: QuizType
  quizNodeIds: string[] | null
  currentQuiz: Quiz | null
  quizHistory: Quiz[]
  quizGradeResult: QuizGradeResult | null
  workActivePanel: WorkPanel
  candidateWorkObjects: CandidateWorkObject[]
  trends: Trend[]
  trendAddingIndex: number | null
  reportPeriod: ReportPeriod
  reportResult: ReportResponse | null
  qaMessages: QaMessage[]
  recommendations: RecommendationItem[]
  recommendationsMode: 'study' | 'work'
}

// ============================================================================
// Task 13 / 14 / 15 / 16：Work 模式业务
// ============================================================================

/** Work 模式当前激活的浮层面板（同一时间仅一个打开）。 */
export type WorkPanel = 'none' | 'input' | 'trends' | 'report' | 'qa'

/** 提问对话历史中的一条消息（前端维护的会话上下文）。 */
export interface QaMessage {
  /** 角色：user 用户提问 / assistant Agent 回答。 */
  role: 'user' | 'assistant'
  /** 消息文本（用户问题或 Agent 回答）。 */
  content: string
  /** Agent 回答引用的来源节点（仅 assistant 消息）。 */
  sources?: AskSource[]
  /** Agent 回答置信度（仅 assistant 消息）。 */
  confidence?: number
  /** 是否走降级路径（仅 assistant 消息）。 */
  degraded?: boolean
  /** 降级原因（仅 assistant 消息）。 */
  degradeReason?: string
  /** 本条消息的本地时间戳（用于前端展示顺序）。 */
  ts: number
}

interface AppState {
  // ===== 状态 =====
  mode: Mode
  view: ViewType
  currentGraphId: string | null
  graphs: Graph[]
  fullGraph: FullGraph | null
  /** 当前选中节点 ID（图谱视图与卡片视图间同步）。 */
  selectedNodeId: string | null
  loading: boolean
  error: string

  // 左侧竖排导航：当前激活视图（chat / graph / settings），默认 'graph'
  activeNav: ActiveNav

  // 当前外观主题 id，启动时从 localStorage 恢复
  theme: Theme

  // 「对话」导航项红点角标计数（待处理提醒数量），默认 0 即不显示
  // 后续 Task 8 会写入实际数量
  reminderCount: number

  // Task 8：节点延伸
  /** 当前可撤销延伸批次的 batch_id（仅 mode=all 且有新建时设置；撤销后清空）。 */
  extensionBatchId: string | null
  /** 当前可撤销延伸批次的源节点 ID（与 batch 配对，用于调用撤销接口）。 */
  extensionBatchNodeId: string | null
  /** 延伸请求进行中标记，前端据此禁用按钮 / 显示加载态。 */
  extending: boolean
  /** 需闪烁高亮的节点 ID 列表（新建延伸节点 / 命中已存在节点）。 */
  flashNodeIds: string[]

  // Task 11：候选节点抽取
  /** 未处理观察记录列表（侧栏「待抽取」入口展示）。 */
  pendingObservations: Observation[]
  /** 当前抽取出的候选节点列表（待用户确认后入图）。 */
  candidateNodes: CandidateNode[]
  /** 当前候选节点所属的观察记录 ID（batch 成功后用于标记已处理）。 */
  candidateObservationId: string | null
  /** 抽取请求进行中标记。 */
  extracting: boolean
  /** 批量创建请求进行中标记。 */
  batchCreating: boolean
  /** 待抽取面板是否展开（侧栏入口切换）。 */
  pendingPanelOpen: boolean

  // Task 12：测验
  /** 测验面板是否展开（content-toolbar「开始测验」按钮切换）。 */
  quizPanelOpen: boolean
  /** 测验面板当前阶段。 */
  quizStage: 'config' | 'answering' | 'result'
  /** 当前选择的题型。 */
  quizType: QuizType
  /** 限定题目涉及的节点 ID 列表（null = 全图随机）。 */
  quizNodeIds: string[] | null
  /** 当前正在作答 / 已作答的测验题。 */
  currentQuiz: Quiz | null
  /** 当前图谱的测验历史（按创建时间倒序）。 */
  quizHistory: Quiz[]
  /** 最近一次判分结果（作答后填充，复盘时也填充）。 */
  quizGradeResult: QuizGradeResult | null
  /** 题目生成进行中标记。 */
  generatingQuiz: boolean
  /** 作答判分进行中标记。 */
  answeringQuiz: boolean
  /** 历史加载进行中标记。 */
  loadingQuizHistory: boolean

  // Task 13 / 14 / 15 / 16：Work 模式业务
  /** 当前激活的 Work 浮层面板（同一时间仅一个打开）。 */
  workActivePanel: WorkPanel
  /** Task 13：抽取出的候选工作对象列表（待用户确认入图）。 */
  candidateWorkObjects: CandidateWorkObject[]
  /** Task 13：工作对象抽取请求进行中标记。 */
  workExtracting: boolean
  /** Task 13：工作对象批量确认入图请求进行中标记。 */
  workConfirming: boolean
  /** Task 14：当前风口推荐列表。 */
  trends: Trend[]
  /** Task 14：风口生成请求进行中标记。 */
  trendsLoading: boolean
  /** Task 14：正在加入图谱的风口 index（用于按钮加载态），null = 无。 */
  trendAddingIndex: number | null
  /** Task 15：报告周期。 */
  reportPeriod: ReportPeriod
  /** Task 15：最近一次生成的报告结果（null = 未生成）。 */
  reportResult: ReportResponse | null
  /** Task 15：报告生成请求进行中标记。 */
  reportGenerating: boolean
  /** Task 15：报告导出 docx 请求进行中标记。 */
  reportExporting: boolean
  /** Task 16：提问对话历史（按时间正序）。 */
  qaMessages: QaMessage[]
  /** Task 16：提问请求进行中标记。 */
  qaAsking: boolean

  // 推荐 / touch / remind / star
  /** 当前推荐列表（按 score 倒序）。 */
  recommendations: RecommendationItem[]
  /** 推荐列表加载中标记。 */
  recommendationsLoading: boolean
  /** 推荐列表最近一次加载错误（空字符串表示无错误）。 */
  recommendationsError: string
  /** 当前推荐列表对应的模式（study 复习推荐 / work 到期提醒）。 */
  recommendationsMode: 'study' | 'work'

  // 设置面板：LLM 请求队列与配置
  /** 当前已知的 LLM 请求列表（含活跃 + 近期终态，由后端按时间倒序返回）。 */
  llmRequests: LlmRequestInfo[]
  /** LLM 请求列表加载中标记（首次或刷新时）。 */
  llmRequestsLoading: boolean
  /** LLM 请求列表最近一次加载错误（空字符串表示无错误）。 */
  llmRequestsError: string
  /** 当前正在取消的 LLM 请求 id（用于按钮加载态），null = 无。 */
  llmCancellingId: string | null
  /** 当前 LLM 配置（api_key 已掩码），null = 未加载。 */
  llmConfig: LlmConfig | null
  /** LLM 配置加载中标记。 */
  llmConfigLoading: boolean
  /** LLM 配置保存中标记。 */
  llmConfigSaving: boolean
  /** LLM 连接测试中标记（「测试连接」按钮加载态）。 */
  llmTesting: boolean
  /** 最近一次 LLM 连接测试结果，null = 未测试。 */
  llmTestResult: LlmTestConnectionResponse | null

  // 设置面板：插件对接分区（懒加载，进入插件分区时拉取）
  /** 最近推送的对话记录列表（按 created_at 倒序）。 */
  pluginRecent: PluginRecentConversationItem[]
  /** 最近推送列表加载中标记。 */
  pluginRecentLoading: boolean
  /** 最近推送列表最近一次加载错误（空字符串表示无错误）。 */
  pluginRecentError: string
  /** 插件对接接口契约 JSON，null = 未加载。 */
  pluginContract: Record<string, unknown> | null

  // ===== 流式输出状态 =====
  /** WebSocket 连接的 session_id（App.tsx 启动时生成并设置）。 */
  streamingSessionId: string | null

  /** QA 问答流式文本（逐 token 累积，流式完成后清空）。 */
  qaStreamingText: string
  /** QA 问答流式是否进行中。 */
  qaStreamingActive: boolean

  /** 工作报告流式 Markdown 文本（逐 token 累积）。 */
  reportStreamingText: string
  /** 工作报告流式是否进行中。 */
  reportStreamingActive: boolean

  /** 节点详情卡流式 Markdown 文本（逐 token 累积）。 */
  nodeDetailStreamingText: string
  /** 节点详情卡流式是否进行中。 */
  nodeDetailStreamingActive: boolean
  /** 当前正在流式生成详情卡的节点 ID（null = 无）。 */
  nodeDetailStreamingNodeId: string | null

  // 通用 Toast
  toast: ToastMessage | null

  // 模式快照：切换模式时保存当前模式的关键状态，切回时直接恢复，
  // 避免重新加载图谱列表 / 重新选中图谱 / fullGraph 重新拉取。
  // 配合 App.tsx 的横向滑动过渡，实现"切换模式时状态保留 + 视觉滑动"。
  modeSnapshots: Partial<Record<Mode, ModeSnapshot>>

  // 对话首页瀑布流中"点击展开为中央大卡"的节点 ID。
  // 提升到全局是为了让大卡浮层（ChatExpandedOverlay）在 activeNav 从 'chat'
  // 切到 'graph'（无缝衔接图谱）时仍能存活——本地 state 会随 ChatHome 卸载而丢失。
  chatExpandedNodeId: string | null

  // ===== Task 9：多轮对话 chat 状态 =====
  /** 当前模式下的 chat 会话列表（按 created_at 倒序）。 */
  chatSessions: ChatSession[]
  /** 当前选中的 chat 会话（null = 未选中，进入对话页时自动创建/恢复）。 */
  currentChatSession: ChatSession | null
  /** 当前会话的消息历史（按 created_at 升序，含工具调用记录）。 */
  chatMessages: ChatMessage[]
  /** chat 流式 token 是否进行中（用于禁用输入框与显示打字机）。 */
  chatStreamingActive: boolean
  /** chat 流式文本累积（逐 token 拼接，done/cancelled 时清空）。 */
  chatStreamingText: string
  /** chat 流式请求的 request_id（用于取消）。 */
  chatStreamingRequestId: string | null
  /** chat 是否处于提问/回答中（含工具调用阶段，禁用输入框）。 */
  chatAsking: boolean
  /** 当前会话最新的 checkpoint（null = 未加载或无）。 */
  currentCheckpoint: ChatCheckpoint | null
  /** Plan 模式开关（false = Build 默认；true = Plan 只读模式）。
   *  仅 Work 模式有意义；Study 模式忽略此开关。 */
  planMode: boolean
  /** 待处理的高风险工具确认请求（非 null 时弹确认对话框）。 */
  pendingToolConfirmation: ToolConfirmation | null
  /** 工作对象逐条确认开关（false = 批量确认默认；true = 每项可勾选）。
   *  仅对 graph_confirm_work_objects 工具有效；持久化到 localStorage。 */
  workObjectSingleConfirm: boolean

  // ===== 动作 =====
  /** 切换模式：保存当前模式快照，恢复目标模式快照（若有），加载新模式图谱列表。 */
  setMode: (mode: Mode) => void
  /** 切换外观主题并持久化到 localStorage。 */
  setTheme: (theme: Theme) => void
  /** 切换内容区视图类型。 */
  setView: (view: ViewType) => void
  /** 切换左侧竖排导航激活项（chat / graph / settings）。 */
  setActiveNav: (nav: ActiveNav) => void
  /** 设置「对话」导航项红点角标计数（0 不显示）。 */
  setReminderCount: (n: number) => void
  /** 设置对话首页瀑布流中展开为大卡的节点 ID（null = 收回）。 */
  setChatExpandedNodeId: (id: string | null) => void
  /** 选中节点（传 null 取消选中），用于图谱视图与卡片视图间同步选中态。 */
  setSelectedNode: (id: string | null) => void
  /** 选中图谱（传 null 取消选中），自动加载完整图谱。 */
  selectGraph: (id: string | null) => void
  /** 加载当前模式下的图谱列表。 */
  loadGraphs: () => Promise<void>
  /** 加载指定图谱的完整数据（含 nodes/edges/stats）。 */
  loadFullGraph: (id: string) => Promise<void>
  /** 在当前模式下新建图谱，成功后自动选中。返回新建图谱或 null。 */
  createGraph: (name: string) => Promise<Graph | null>
  /** 重命名图谱。返回是否成功。 */
  renameGraph: (id: string, name: string) => Promise<boolean>
  /** 删除图谱。若删除的是当前选中图谱，自动取消选中。返回是否成功。 */
  deleteGraph: (id: string) => Promise<boolean>
  /** 更新当前图谱下指定节点的字段（标题/概括/类型/detail_payload 等）。 */
  updateNode: (nodeId: string, body: NodeUpdate) => Promise<boolean>
  /** 删除当前图谱下指定节点（级联清理相关边），并清空对应选中态。 */
  deleteNode: (nodeId: string) => Promise<boolean>
  /** 向节点 user_fill 追加一条内容，更新 fullGraph 中的节点。 */
  appendUserFill: (
    nodeId: string,
    fillType: string,
    content: string,
  ) => Promise<boolean>
  /** 生成（或复用缓存）节点详情卡内容，更新 fullGraph 中的节点并返回详情。 */
  generateNodeDetail: (nodeId: string) => Promise<NodeDetailResponse | null>
  /**
   * 将 recommendations 中某节点的 detail_payload 同步到 fullGraph 的对应节点。
   * 用于从对话大卡切换到图谱视图时，把推荐列表预生成的详情带到图谱中，
   * 避免图谱 NodeDetailCard 因 fullGraph 无缓存而重新生成（LLM 不可用时降级为空）。
   */
  syncNodeDetailToGraph: (nodeId: string) => void
  /** 清空错误状态。 */
  clearError: () => void

  // Task 8：节点延伸
  /**
   * 基于源节点生成延伸节点。
   * - mode="all"：双击触发，生成全部延伸（灰色 + extends 边），成功后整图刷新，
   *   记录 batch_id 供撤销；命中已存在节点不重复创建，加入 flash 列表闪烁提示。
   * - mode="single"：单击方向触发，仅生成指定 direction_name 一个延伸节点，
   *   不进 batch（不可撤销）。
   * 返回响应数据（用于前端即时反馈），失败返回 null。
   */
  extendNode: (
    nodeId: string,
    mode: ExtendMode,
    directionName?: string,
  ) => Promise<ExtendResponse | null>
  /** 撤销上一次全部延伸（删除该批新节点与边），成功后整图刷新。返回是否成功。 */
  revokeExtend: () => Promise<boolean>
  /** 触发指定节点闪烁高亮（autoClear=true 时 1.6s 后自动清空）。 */
  flashNodes: (ids: string[], autoClear?: boolean) => void
  /** 清空闪烁高亮节点列表。 */
  clearFlash: () => void

  // Task 11：候选节点抽取
  /** 加载未处理观察记录列表（默认 processed=false）。 */
  loadPendingObservations: () => Promise<void>
  /** 从一条观察记录抽取候选节点（不入图），存入 candidateNodes 供面板展示。返回是否成功。 */
  extractCandidates: (observationId: string) => Promise<boolean>
  /** 清空当前候选节点列表与关联的 observation id。 */
  clearCandidates: () => void
  /** 批量创建已确认节点（归一去重），成功后整图刷新并清空候选列表。返回响应或 null。 */
  batchCreateNodes: (
    nodes: CandidateNode[],
    observationId?: string,
  ) => Promise<BatchCreateNodesResponse | null>
  /** 切换待抽取面板展开 / 收起。 */
  togglePendingPanel: (open?: boolean) => void

  // Task 12：测验
  /** 切换测验面板展开 / 收起（关闭时清空作答态，保留历史）。 */
  setQuizPanelOpen: (open?: boolean) => void
  /** 切换测验面板阶段。 */
  setQuizStage: (stage: 'config' | 'answering' | 'result') => void
  /** 设置当前题型（config 阶段切换）。 */
  setQuizType: (type: QuizType) => void
  /** 设置限定节点 ID 列表（null = 全图随机）。 */
  setQuizNodeIds: (ids: string[] | null) => void
  /**
   * 调用后端生成一道测验题，成功后进入 answering 阶段、刷新历史。
   * - 降级题目也照常进入作答流程（前端据此提示用户）。
   * 返回是否成功。
   */
  generateQuiz: () => Promise<boolean>
  /**
   * 提交作答并判分。
   * - 选择题：本地判分（严格集合相等），返回 ChoiceGradeResult。
   * - 费曼题：Agent 语义判分，返回 FeynmanGradeResult。
   * 成功后进入 result 阶段、刷新历史。返回是否成功。
   */
  answerQuiz: (answer: string[] | string) => Promise<boolean>
  /** 加载当前图谱的测验历史。 */
  loadQuizHistory: () => Promise<void>
  /** 清空当前作答状态（currentQuiz / gradeResult），回到 config 阶段。 */
  clearQuiz: () => void
  /** 复盘历史项：从历史拉取详情并填充 result 阶段。 */
  reviewQuiz: (quizId: string) => Promise<boolean>

  // Task 13 / 14 / 15 / 16：Work 模式业务
  /** 切换当前激活的 Work 浮层面板（传 'none' 关闭全部）。 */
  setWorkPanel: (panel: WorkPanel) => void
  /** Task 13：从文本抽取候选工作对象（不入图），存入 candidateWorkObjects。返回是否成功。 */
  extractWorkObjects: (text: string) => Promise<boolean>
  /** Task 13：清空当前候选工作对象列表。 */
  clearCandidateWorkObjects: () => void
  /** Task 13：批量确认工作对象入图（归一去重 + 建立关系边），成功后整图刷新。返回响应或 null。 */
  confirmWorkObjects: (
    objects: CandidateWorkObject[],
  ) => Promise<WorkConfirmResponse | null>
  /** Task 14：基于当前 work 图谱生成风口推荐，存入 trends。返回是否成功。 */
  generateTrends: () => Promise<boolean>
  /** Task 14：把指定风口转为图谱节点，成功后整图刷新。返回是否成功。 */
  addTrendToGraph: (index: number) => Promise<boolean>
  /** Task 15：设置报告周期（weekly / monthly）。 */
  setReportPeriod: (period: ReportPeriod) => void
  /** Task 15：生成工作报告，存入 reportResult。返回是否成功。 */
  generateReport: () => Promise<boolean>
  /** Task 15：导出当前报告为 .docx 并触发浏览器下载。返回是否成功。 */
  exportReportDocx: () => Promise<boolean>
  /** Task 16：提交用户提问，追加到 qaMessages 并展示 Agent 回答。返回是否成功。 */
  askWorkQuestion: (question: string) => Promise<boolean>
  /** Task 16：清空提问对话历史。 */
  clearQaMessages: () => void

  // 推荐 / touch / remind / star
  /**
   * 加载当前图谱的推荐列表。
   * - mode=study：复习推荐（按错误率与距上次复习天数排序）；
   * - mode=work：到期提醒（按到期 / 临近状态排序）。
   * 无 currentGraphId 时清空 recommendations 并返回。
   */
  loadRecommendations: (mode: 'study' | 'work') => Promise<void>
  /**
   * 触发节点 touch（如打开详情卡），刷新 fullGraph 中对应节点的
   * last_reviewed_at / review_count。
   */
  touchNode: (id: string) => Promise<void>
  /** 设置节点提醒时间，更新 fullGraph 中对应节点的 remind_at。返回是否成功。 */
  setRemind: (id: string, remindAt: string) => Promise<boolean>
  /** 清除节点提醒，更新 fullGraph 中对应节点的 remind_at 为 null。返回是否成功。 */
  clearRemind: (id: string) => Promise<boolean>
  /**
   * 切换节点星标：读取当前 is_starred 取反后调用 setStar，
   * 成功后更新 fullGraph 中对应节点。返回是否成功。
   */
  toggleStar: (id: string) => Promise<boolean>
  /**
   * 从推荐列表统计到期数量（is_overdue=true），写入 reminderCount。
   * 推荐列表为空时先按当前模式加载再统计。
   */
  loadReminderCount: () => Promise<void>

  // 通用 Toast
  /** 推送一条 Toast 消息。 */
  pushToast: (message: string, type?: ToastType) => void
  /** 清空当前 Toast 消息。 */
  clearToast: () => void

  // 设置面板：LLM 请求队列与配置
  /** 拉取当前 LLM 请求列表（含活跃 + 近期终态），写入 llmRequests。 */
  loadLlmRequests: () => Promise<void>
  /** 取消指定 LLM 请求；成功后立即刷新列表。返回是否取消成功。 */
  cancelLlmRequest: (id: string) => Promise<boolean>
  /** 拉取当前 LLM 配置（api_key 掩码），写入 llmConfig。 */
  loadLlmConfig: () => Promise<void>
  /** 更新 LLM 配置（仅传需更新字段）；成功后刷新 llmConfig。返回是否成功。 */
  updateLlmConfig: (config: LlmConfigUpdate) => Promise<boolean>
  /** 测试 LLM 连接（用传入的临时配置或已保存配置）；结果写入 llmTestResult。返回是否成功。 */
  testLlmConnection: (config: LlmTestConnectionRequest) => Promise<boolean>

  // 设置面板：插件对接分区
  /** 拉取最近推送的对话记录（默认 20 条），写入 pluginRecent。 */
  loadPluginRecent: (limit?: number) => Promise<void>
  /** 拉取插件对接接口契约 JSON，写入 pluginContract 并返回。 */
  loadPluginContract: () => Promise<Record<string, unknown> | null>
  /**
   * 处理 WebSocket 推送的「插件对话已接收」事件：
   * 1. 弹 Toast 提示收到新对话；
   * 2. 若当前处于图谱视图且为学习模式，刷新待抽取列表（PendingNodes）。
   */
  handlePluginConversationReceived: (payload: {
    observation_id: string
    platform: string
    title: string
    timestamp: string | null
  }) => void

  // ===== 流式输出动作 =====
  /** 设置 WebSocket session_id（App.tsx 启动时调用）。 */
  setStreamingSessionId: (id: string | null) => void
  /**
   * 处理流式 token 事件：按 op 类型追加到对应流式文本状态。
   * - answer_question：追加到 qaStreamingText 并同步更新最后一条 assistant 消息。
   * - generate_report：追加到 reportStreamingText 并同步更新 reportResult.markdown。
   * - generate_node_detail：追加到 nodeDetailStreamingText。
   */
  handleGraphAgentToken: (event: GraphAgentTokenEvent) => void
  /**
   * 处理流式完成事件：按 op 类型终结流式状态。
   * - answer_question：qaStreamingActive=false，用 full_text 兜底最后一条消息。
   * - generate_report：reportStreamingActive=false，写入最终 reportResult。
   * - generate_node_detail：nodeDetailStreamingActive=false，保留 full_text 供详情卡展示。
   */
  handleGraphAgentDone: (event: GraphAgentDoneEvent) => void
  /** 处理流式被取消事件：终结流式状态，保留已生成部分文本。 */
  handleGraphAgentCancelled: (event: GraphAgentCancelledEvent) => void
  /** 处理流式失败事件：终结流式状态，弹 Toast 提示错误。 */
  handleGraphAgentError: (event: GraphAgentErrorEvent) => void
  /**
   * 流式提问：追加 user 消息 + 空 assistant 占位消息，触发后端 ask-stream。
   * 需 streamingSessionId 与 currentGraphId，缺失时回退到非流式 askWorkQuestion。
   * 返回是否成功触发。
   */
  askWorkQuestionStream: (question: string) => Promise<boolean>
  /**
   * 流式生成报告：清空旧报告，触发后端 report-stream。
   * 需 streamingSessionId 与 currentGraphId，缺失时回退到非流式 generateReport。
   * 返回是否成功触发。
   */
  generateReportStream: () => Promise<boolean>
  /**
   * 流式生成节点详情卡：触发后端 detail-stream。
   * 需 streamingSessionId 与 currentGraphId，缺失时回退到非流式 generateNodeDetail。
   * 返回是否成功触发。
   */
  generateNodeDetailStream: (nodeId: string) => Promise<boolean>
  /** 清空 QA 流式状态（流式完成或取消后调用）。 */
  clearQaStreaming: () => void
  /** 清空报告流式状态。 */
  clearReportStreaming: () => void
  /** 清空节点详情流式状态。 */
  clearNodeDetailStreaming: () => void

  // ===== Task 9：多轮对话 chat 动作 =====
  /**
   * 加载当前模式下的 chat 会话列表。
   * 无 currentGraphId 时仅按 mode 过滤（拉取该模式全部会话）；
   * 有 currentGraphId 时优先按 graph_id 过滤，找不到则回退到按 mode 拉取。
   */
  loadChatSessions: () => Promise<void>
  /**
   * 创建新 chat 会话并自动选中。
   * - body.mode 默认用当前 store.mode；
   * - body.graph_id 默认用 currentGraphId；
   * - 创建成功后写入 chatSessions 头部并设为 currentChatSession，
   *   同时清空 chatMessages（新会话无历史）。
   * 返回新建的会话或 null。
   */
  createChatSession: (
    body?: Partial<CreateChatSessionRequest>,
  ) => Promise<ChatSession | null>
  /**
   * 选中指定会话：写入 currentChatSession 并加载其消息历史。
   * 传 null 时清空当前会话与消息列表。
   */
  selectChatSession: (session: ChatSession | null) => Promise<void>
  /**
   * 发送消息：追加 user 消息 + 空 assistant 占位，触发后端 chat/stream。
   * - 自动确保 currentChatSession 存在（缺失时按当前 mode + graphId 自动创建）；
   * - 自动确保 streamingSessionId 存在（缺失时仅追加消息不触发流式）；
   * - 流式 token / tool_call / done 等通过 WS 事件实时更新占位消息。
   * 返回是否成功触发流式（false 表示已降级或失败）。
   */
  sendMessage: (content: string) => Promise<boolean>
  /**
   * 取消当前 chat 流式请求（标记 cancelled，触发 MainAgent.cancel）。
   * 通过 chatStreamingRequestId 调用 cancelChatStream API。
   * 返回是否成功标记取消。
   */
  cancelChat: () => Promise<boolean>
  /**
   * 同意高风险工具调用：调 confirmChatToolCall(approved=true) + 清空 pendingToolConfirmation。
   * modifiedArgs 用于逐条确认场景，回传用户勾选后的 objects 子集。
   * 返回是否成功。
   */
  confirmToolCall: (modifiedArgs?: Record<string, unknown>) => Promise<boolean>
  /**
   * 拒绝高风险工具调用：调 confirmChatToolCall(approved=false, reason) + 清空 pendingToolConfirmation。
   * 返回是否成功。
   */
  rejectToolCall: (reason?: string) => Promise<boolean>
  /** 切换工作对象逐条确认开关并持久化到 localStorage。 */
  setWorkObjectSingleConfirm: (on: boolean) => void
  /** 加载当前会话最新 checkpoint，写入 currentCheckpoint。 */
  loadCheckpoint: () => Promise<void>
  /** 手动触发 writer_agent 生成 checkpoint。返回是否成功。 */
  triggerCheckpoint: () => Promise<boolean>
  /**
   * 切换 Plan/Build 模式（仅 Work 模式有意义）。
   * - planMode=true：Plan 只读模式，高风险工具一律拒绝；
   * - planMode=false：Build 默认模式，高风险工具走确认弹框。
   */
  setPlanMode: (plan: boolean) => void
  /** 清空当前 chat 会话与消息（用于「返回首页」按钮）。 */
  clearChat: () => void

  // ===== Task 9：chat WS 事件处理 =====
  /**
   * 处理 chat 流式 token 事件（op="chat"）：
   * 累加到 chatStreamingText，同步更新最后一条 assistant 占位消息的 content。
   */
  handleChatToken: (event: ChatTokenEvent) => void
  /**
   * 处理 chat 工具调用开始事件：在最后一条 assistant 消息的 tool_calls
   * 数组追加一条 pending 项（status=pending），UI 据此展示「正在查询…」状态。
   */
  handleChatToolCall: (event: ChatToolCallEvent) => void
  /**
   * 处理 chat 工具结果事件：把对应 tool_call 的 status 改为 done 并写入 result。
   */
  handleChatToolResult: (event: ChatToolResultEvent) => void
  /**
   * 处理 chat 高风险工具确认事件：写入 pendingToolConfirmation，
   * 触发前端弹确认对话框（ChatPanel 中的 ToolConfirmDialog）。
   */
  handleChatToolConfirmation: (event: ChatToolConfirmationEvent) => void
  /**
   * 处理 chat 思维链增量事件：把 reasoning_content 累积到最后一条 assistant
   * 占位消息的 thinking 字段，前端在气泡上方折叠展示，不混入正文 content。
   */
  handleChatThinking: (event: ChatThinkingEvent) => void
  /**
   * 处理 chat 正文替换事件：后端剥离测验题内容后，替换前端已显示的正文。
   * 用于 graph_generate_quiz 等工具调用后，LLM 在正文手写了工具产出物的场景。
   */
  handleChatContentReplace: (event: { content: string; type?: string }) => void
  /**
   * 处理 chat 流式完成事件：终结流式状态，用 full_text 兜底最后一条消息。
   */
  handleChatDone: (event: ChatDoneEvent) => void
  /**
   * 处理 chat 流式被取消事件：终结流式状态，保留已生成部分文本。
   */
  handleChatCancelled: (event: ChatCancelledEvent) => void
  /**
   * 处理 chat 流式失败事件：终结流式状态，弹错误 Toast。
   */
  handleChatError: (event: ChatErrorEvent) => void
}

/** 统一提取错误消息。 */
function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    return e.detail ? `${e.message}（${e.detail}）` : e.message
  }
  return (e as Error)?.message ?? '未知错误'
}

/** 闪烁高亮自动清除时长（ms）。 */
const FLASH_AUTO_CLEAR_MS = 1800

/** 全局自增 toast id，避免短时间多条消息 id 冲突。 */
let _toastSeq = 0

/** 闪烁自动清除计时器（模块级，避免组件卸载后残留）。 */
let _flashClearTimer: ReturnType<typeof setTimeout> | null = null

/** 用更新后的节点替换 fullGraph.nodes 中的同 id 节点。 */
function replaceNode(full: FullGraph, updated: Node): FullGraph {
  return {
    ...full,
    nodes: full.nodes.map((n) => (n.id === updated.id ? updated : n)),
  }
}

/** 从 localStorage 读取布尔型设置项（隐私模式或禁用时回退默认值）。 */
function _loadBoolSetting(key: string, defaultValue: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === 'true') return true
    if (v === 'false') return false
  } catch {
    // 静默降级
  }
  return defaultValue
}

/** 把布尔型设置项写入 localStorage（隐私模式或禁用时静默降级）。 */
function _saveBoolSetting(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // 静默降级
  }
}

/** 从 localStorage 读取已保存的主题，非法或缺失时回退到默认主题。 */
function loadInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (isValidTheme(saved)) return saved
  } catch {
    // 隐私模式或 localStorage 被禁用：静默降级
  }
  return DEFAULT_THEME
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: 'study',
  view: 'graph',
  currentGraphId: null,
  graphs: [],
  fullGraph: null,
  selectedNodeId: null,
  loading: false,
  error: '',

  // 左侧竖排导航：默认进入图谱视图
  activeNav: 'graph',

  // 当前外观主题：启动时从 localStorage 恢复（缺失 / 非法则回退默认）
  theme: loadInitialTheme(),

  // 「对话」导航项红点角标计数（默认 0，不显示；后续 Task 8 写入）
  reminderCount: 0,

  // Task 8：节点延伸
  extensionBatchId: null,
  extensionBatchNodeId: null,
  extending: false,
  flashNodeIds: [],

  // Task 11：候选节点抽取
  pendingObservations: [],
  candidateNodes: [],
  candidateObservationId: null,
  extracting: false,
  batchCreating: false,
  pendingPanelOpen: false,

  // Task 12：测验
  quizPanelOpen: false,
  quizStage: 'config',
  quizType: 'single_choice',
  quizNodeIds: null,
  currentQuiz: null,
  quizHistory: [],
  quizGradeResult: null,
  generatingQuiz: false,
  answeringQuiz: false,
  loadingQuizHistory: false,

  // Task 13 / 14 / 15 / 16：Work 模式业务
  workActivePanel: 'none',
  candidateWorkObjects: [],
  workExtracting: false,
  workConfirming: false,
  trends: [],
  trendsLoading: false,
  trendAddingIndex: null,
  reportPeriod: 'weekly',
  reportResult: null,
  reportGenerating: false,
  reportExporting: false,
  qaMessages: [],
  qaAsking: false,

  // 推荐 / touch / remind / star
  recommendations: [],
  recommendationsLoading: false,
  recommendationsError: '',
  recommendationsMode: 'study',

  // 设置面板：LLM 请求队列与配置（懒加载，进入设置面板时才拉取）
  llmRequests: [],
  llmRequestsLoading: false,
  llmRequestsError: '',
  llmCancellingId: null,
  llmConfig: null,
  llmConfigLoading: false,
  llmConfigSaving: false,
  llmTesting: false,
  llmTestResult: null,

  // 设置面板：插件对接分区（懒加载，进入分区时拉取）
  pluginRecent: [],
  pluginRecentLoading: false,
  pluginRecentError: '',
  pluginContract: null,

  // ===== 流式输出状态 =====
  streamingSessionId: null,
  qaStreamingText: '',
  qaStreamingActive: false,
  reportStreamingText: '',
  reportStreamingActive: false,
  nodeDetailStreamingText: '',
  nodeDetailStreamingActive: false,
  nodeDetailStreamingNodeId: null,

  // Toast
  toast: null,

  // 模式快照初始为空，首次切换时填充
  modeSnapshots: {},

  // 对话首页大卡浮层初始无展开
  chatExpandedNodeId: null,

  // ===== Task 9：多轮对话 chat 初始状态 =====
  chatSessions: [],
  currentChatSession: null,
  chatMessages: [],
  chatStreamingActive: false,
  chatStreamingText: '',
  chatStreamingRequestId: null,
  chatAsking: false,
  currentCheckpoint: null,
  // 默认 Build 模式；Work 模式下用户可切到 Plan
  planMode: false,
  pendingToolConfirmation: null,
  // 工作对象逐条确认（默认关闭=批量）；从 localStorage 读取
  workObjectSingleConfirm: _loadBoolSetting('kwa.workObjectSingleConfirm', false),

  setMode: (mode) => {
    if (mode === get().mode) return
    // 切换模式：保存当前模式快照，恢复目标模式快照（若有），加载新模式图谱列表。
    // 配合 App.tsx 横向滑动过渡，实现"切换模式时状态保留 + 视觉滑动"。
    const prevMode = get().mode
    const cur = get()
    // 保存当前模式的关键状态到快照
    const snapshot: ModeSnapshot = {
      currentGraphId: cur.currentGraphId,
      fullGraph: cur.fullGraph,
      graphs: cur.graphs,
      selectedNodeId: cur.selectedNodeId,
      extensionBatchId: cur.extensionBatchId,
      extensionBatchNodeId: cur.extensionBatchNodeId,
      flashNodeIds: cur.flashNodeIds,
      pendingObservations: cur.pendingObservations,
      candidateNodes: cur.candidateNodes,
      candidateObservationId: cur.candidateObservationId,
      pendingPanelOpen: cur.pendingPanelOpen,
      quizPanelOpen: cur.quizPanelOpen,
      quizStage: cur.quizStage,
      quizType: cur.quizType,
      quizNodeIds: cur.quizNodeIds,
      currentQuiz: cur.currentQuiz,
      quizHistory: cur.quizHistory,
      quizGradeResult: cur.quizGradeResult,
      workActivePanel: cur.workActivePanel,
      candidateWorkObjects: cur.candidateWorkObjects,
      trends: cur.trends,
      trendAddingIndex: cur.trendAddingIndex,
      reportPeriod: cur.reportPeriod,
      reportResult: cur.reportResult,
      qaMessages: cur.qaMessages,
      recommendations: cur.recommendations,
      recommendationsMode: cur.recommendationsMode,
    }
    const newSnapshots = {
      ...cur.modeSnapshots,
      [prevMode]: snapshot,
    }
    // 从目标模式快照恢复（若有）
    const target = cur.modeSnapshots[mode]
    if (target) {
      // 有快照：直接恢复，不重新加载图谱列表
      set({
        mode,
        modeSnapshots: newSnapshots,
        currentGraphId: target.currentGraphId,
        fullGraph: target.fullGraph,
        graphs: target.graphs,
        selectedNodeId: target.selectedNodeId,
        loading: false,
        error: '',
        extensionBatchId: target.extensionBatchId,
        extensionBatchNodeId: target.extensionBatchNodeId,
        extending: false,
        flashNodeIds: target.flashNodeIds,
        pendingObservations: target.pendingObservations,
        candidateNodes: target.candidateNodes,
        candidateObservationId: target.candidateObservationId,
        extracting: false,
        batchCreating: false,
        pendingPanelOpen: target.pendingPanelOpen,
        quizPanelOpen: target.quizPanelOpen,
        quizStage: target.quizStage,
        quizType: target.quizType,
        quizNodeIds: target.quizNodeIds,
        currentQuiz: target.currentQuiz,
        quizHistory: target.quizHistory,
        quizGradeResult: target.quizGradeResult,
        generatingQuiz: false,
        answeringQuiz: false,
        loadingQuizHistory: false,
        workActivePanel: target.workActivePanel,
        candidateWorkObjects: target.candidateWorkObjects,
        workExtracting: false,
        workConfirming: false,
        trends: target.trends,
        trendsLoading: false,
        trendAddingIndex: target.trendAddingIndex,
        reportPeriod: target.reportPeriod,
        reportResult: target.reportResult,
        reportGenerating: false,
        reportExporting: false,
        qaMessages: target.qaMessages,
        qaAsking: false,
        recommendations: target.recommendations,
        recommendationsLoading: false,
        recommendationsError: '',
        recommendationsMode: target.recommendationsMode,
        // 流式状态：切模式时清空，避免跨模式残留
        qaStreamingText: '',
        qaStreamingActive: false,
        reportStreamingText: '',
        reportStreamingActive: false,
        nodeDetailStreamingText: '',
        nodeDetailStreamingActive: false,
        nodeDetailStreamingNodeId: null,
        // Task 9：切模式时清空 chat 会话与流式状态（按 mode 重新加载）
        chatSessions: [],
        currentChatSession: null,
        chatMessages: [],
        chatStreamingActive: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
        chatAsking: false,
        currentCheckpoint: null,
        planMode: false,
        pendingToolConfirmation: null,
        toast: null,
      })
      // 测验面板打开时自动加载该图谱历史
      if (target.quizPanelOpen && target.currentGraphId) {
        void get().loadQuizHistory()
      }
    } else {
      // 无快照：清空状态并加载新模式图谱列表
      set({
        mode,
        modeSnapshots: newSnapshots,
        currentGraphId: null,
        fullGraph: null,
        graphs: [],
        selectedNodeId: null,
        loading: true,
        error: '',
        extensionBatchId: null,
        extensionBatchNodeId: null,
        extending: false,
        flashNodeIds: [],
        pendingObservations: [],
        candidateNodes: [],
        candidateObservationId: null,
        extracting: false,
        batchCreating: false,
        pendingPanelOpen: false,
        quizPanelOpen: false,
        quizStage: 'config',
        quizType: 'single_choice',
        quizNodeIds: null,
        currentQuiz: null,
        quizHistory: [],
        quizGradeResult: null,
        generatingQuiz: false,
        answeringQuiz: false,
        loadingQuizHistory: false,
        workActivePanel: 'none',
        candidateWorkObjects: [],
        workExtracting: false,
        workConfirming: false,
        trends: [],
        trendsLoading: false,
        trendAddingIndex: null,
        reportPeriod: 'weekly',
        reportResult: null,
        reportGenerating: false,
        reportExporting: false,
        qaMessages: [],
        qaAsking: false,
        recommendations: [],
        recommendationsLoading: false,
        recommendationsError: '',
        recommendationsMode: mode,
        qaStreamingText: '',
        qaStreamingActive: false,
        reportStreamingText: '',
        reportStreamingActive: false,
        nodeDetailStreamingText: '',
        nodeDetailStreamingActive: false,
        nodeDetailStreamingNodeId: null,
        // Task 9：切模式时清空 chat 会话与流式状态（按 mode 重新加载）
        chatSessions: [],
        currentChatSession: null,
        chatMessages: [],
        chatStreamingActive: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
        chatAsking: false,
        currentCheckpoint: null,
        planMode: false,
        pendingToolConfirmation: null,
        toast: null,
      })
      void get().loadGraphs()
    }
  },

  setTheme: (theme) => {
    set({ theme })
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // 隐私模式或 localStorage 被禁用：静默降级，不抛错
    }
  },

  setView: (view) => set({ view }),

  setActiveNav: (nav) => {
    if (nav === get().activeNav) return
    set({ activeNav: nav })
    if (nav === 'chat') {
      // 进入对话视图：加载当前模式推荐 + 刷新角标计数 + 拉取 chat 会话列表
      void get().loadRecommendations(get().recommendationsMode)
      void get().loadReminderCount()
      void get().loadChatSessions()
    } else if (nav === 'settings') {
      // 进入设置面板：懒加载 LLM 配置与请求列表
      void get().loadLlmConfig()
      void get().loadLlmRequests()
    }
    // 进入 'graph' 时不清空 recommendations，便于切回 chat 快速显示
  },

  setReminderCount: (n) => set({ reminderCount: n }),

  setChatExpandedNodeId: (id) => {
    if (id === get().chatExpandedNodeId) return
    set({ chatExpandedNodeId: id })
  },

  setSelectedNode: (id) => {
    if (id === get().selectedNodeId) return
    set({ selectedNodeId: id })
  },

  selectGraph: (id) => {
    if (id === get().currentGraphId) return
    // 切换图谱时清空选中节点与延伸批次，避免跨图谱残留。
    // 不清空 fullGraph：保留旧图谱视图直到新图谱加载完成，
    // 避免 loading 文本白屏与 GraphView 卸载/重建造成的视觉闪动。
    // loading=true 时 App.tsx 的 `loading && !fullGraph` 仍为 false（旧图谱还在），
    // 不会显示 loading 占位；新图谱到达后由 loadFullGraph 替换 fullGraph。
    set({
      currentGraphId: id,
      loading: true,
      selectedNodeId: null,
      error: '',
      extensionBatchId: null,
      extensionBatchNodeId: null,
      flashNodeIds: [],
      candidateNodes: [],
      candidateObservationId: null,
      // Task 12：切换图谱时清空测验作答态，但保留面板打开（history 自动重载）
      quizStage: 'config',
      currentQuiz: null,
      quizGradeResult: null,
      quizHistory: [],
      generatingQuiz: false,
      answeringQuiz: false,
      // Task 13/14/15/16：切换图谱时清空 Work 业务态（面板关闭、候选/趋势/报告/问答清空）
      workActivePanel: 'none',
      candidateWorkObjects: [],
      workExtracting: false,
      workConfirming: false,
      trends: [],
      trendsLoading: false,
      trendAddingIndex: null,
      reportResult: null,
      reportGenerating: false,
      reportExporting: false,
      qaMessages: [],
      qaAsking: false,
      // 流式状态：切换图谱时清空，避免跨图谱残留
      qaStreamingText: '',
      qaStreamingActive: false,
      reportStreamingText: '',
      reportStreamingActive: false,
      nodeDetailStreamingText: '',
      nodeDetailStreamingActive: false,
      nodeDetailStreamingNodeId: null,
      // Task 9：切换图谱时清空 chat 会话与流式状态
      // （下次进入对话页时会按新 graph_id 拉取该图谱的 chat 会话列表）
      currentChatSession: null,
      chatMessages: [],
      chatStreamingActive: false,
      chatStreamingText: '',
      chatStreamingRequestId: null,
      chatAsking: false,
      currentCheckpoint: null,
      pendingToolConfirmation: null,
    })
    if (id) {
      void get().loadFullGraph(id)
      // 测验面板打开时自动加载该图谱历史
      if (get().quizPanelOpen) void get().loadQuizHistory()
      // 进入对话页时自动按新 graph_id 拉取 chat 会话列表
      if (get().activeNav === 'chat') void get().loadChatSessions()
    }
  },

  loadGraphs: async () => {
    const mode = get().mode
    set({ loading: true, error: '' })
    try {
      const graphs = await api.getGraphs(mode)
      set({ graphs, loading: false })
    } catch (e) {
      set({ loading: false, error: errMsg(e) })
    }
  },

  loadFullGraph: async (id) => {
    set({ loading: true, error: '' })
    try {
      const full = await api.getFullGraph(id)
      set({ fullGraph: full, loading: false })
    } catch (e) {
      set({ loading: false, error: errMsg(e) })
    }
  },

  createGraph: async (name) => {
    const mode = get().mode
    set({ error: '' })
    try {
      const g = await api.createGraph({ name, type: mode })
      set({ graphs: [g, ...get().graphs] })
      // 创建后自动选中并加载完整数据
      set({ currentGraphId: g.id, fullGraph: null })
      void get().loadFullGraph(g.id)
      return g
    } catch (e) {
      set({ error: errMsg(e) })
      return null
    }
  },

  renameGraph: async (id, name) => {
    set({ error: '' })
    try {
      const g = await api.renameGraph(id, name)
      set({ graphs: get().graphs.map((x) => (x.id === id ? g : x)) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  deleteGraph: async (id) => {
    set({ error: '' })
    try {
      await api.deleteGraph(id)
      const graphs = get().graphs.filter((x) => x.id !== id)
      const cur = get().currentGraphId
      const isCurrent = cur === id
      set({
        graphs,
        currentGraphId: isCurrent ? null : cur,
        fullGraph: isCurrent ? null : get().fullGraph,
        selectedNodeId: isCurrent ? null : get().selectedNodeId,
      })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  updateNode: async (nodeId, body) => {
    const graphId = get().currentGraphId
    if (!graphId) return false
    set({ error: '' })
    try {
      const updated = await api.updateNode(graphId, nodeId, body)
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, updated) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  deleteNode: async (nodeId) => {
    const graphId = get().currentGraphId
    if (!graphId) return false
    set({ error: '' })
    try {
      await api.deleteNode(graphId, nodeId)
      const full = get().fullGraph
      if (full) {
        const nodes = full.nodes.filter((n) => n.id !== nodeId)
        const edges = full.edges.filter(
          (e) => e.src_id !== nodeId && e.dst_id !== nodeId,
        )
        set({
          fullGraph: {
            ...full,
            nodes,
            edges,
            stats: {
              ...full.stats,
              node_count: nodes.length,
              edge_count: edges.length,
            },
          },
          selectedNodeId:
            get().selectedNodeId === nodeId ? null : get().selectedNodeId,
        })
      }
      // 节点变更后刷新推荐（仅在对话视图时，避免图谱视图无谓请求）
      if (get().activeNav === 'chat') {
        void get().loadRecommendations(get().recommendationsMode)
      }
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  appendUserFill: async (nodeId, fillType, content) => {
    const graphId = get().currentGraphId
    if (!graphId) return false
    set({ error: '' })
    try {
      const updated = await api.appendUserFill(graphId, nodeId, {
        fill_type: fillType,
        content,
      })
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, updated) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  generateNodeDetail: async (nodeId) => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    set({ error: '' })
    try {
      const resp = await api.generateNodeDetail(graphId, nodeId)
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, resp.node) })
      return resp
    } catch (e) {
      set({ error: errMsg(e) })
      return null
    }
  },

  syncNodeDetailToGraph: (nodeId) => {
    const full = get().fullGraph
    if (!full) return
    const graphNode = full.nodes.find((n) => n.id === nodeId)
    if (!graphNode) return
    // 已有缓存则无需同步
    if (graphNode.detail_payload && Object.keys(graphNode.detail_payload).length > 0) return
    // 从 recommendations 中查找同 id 节点，取其 detail_payload
    const recItem = get().recommendations.find((r) => r.node.id === nodeId)
    if (!recItem?.node?.detail_payload) return
    const updated: Node = {
      ...graphNode,
      detail_payload: { ...recItem.node.detail_payload },
    }
    set({ fullGraph: replaceNode(full, updated) })
  },

  clearError: () => set({ error: '' }),

  // ===== Task 8：节点延伸 =====
  extendNode: async (nodeId, mode, directionName) => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    set({ extending: true, error: '' })
    try {
      const resp = await api.extendNode(graphId, nodeId, mode, directionName)
      // 整图刷新：拉取最新 nodes/edges（含新建灰色节点 + extends 边）
      await get().loadFullGraph(graphId)
      // 闪烁高亮：新建 + 命中已存在节点
      const flashIds = [
        ...resp.created.map((c) => c.node_id),
        ...resp.existing.map((c) => c.node_id),
      ].filter(Boolean)
      if (flashIds.length > 0) {
        get().flashNodes(flashIds, true)
      }
      // 仅 mode=all 且有新建时记录 batch_id 供撤销；单点延伸不进 batch
      if (mode === 'all' && resp.batch_id && resp.created.length > 0) {
        set({
          extensionBatchId: resp.batch_id,
          extensionBatchNodeId: nodeId,
        })
      }
      // Toast 反馈
      const createdCnt = resp.created.length
      const existingCnt = resp.existing.length
      if (resp.degraded) {
        get().pushToast(
          `已走降级路径延伸 ${createdCnt} 个节点（LLM 不可用）`,
          'warning',
        )
      } else if (mode === 'all') {
        const parts: string[] = []
        if (createdCnt > 0) parts.push(`新建 ${createdCnt} 个延伸节点`)
        if (existingCnt > 0) parts.push(`${existingCnt} 个已存在节点未重复创建`)
        get().pushToast(
          parts.length > 0 ? parts.join('，') + '（可撤销）' : '未生成新延伸节点',
          createdCnt > 0 ? 'success' : 'info',
        )
      } else {
        // single 模式：单击方向
        if (createdCnt > 0) {
          get().pushToast('已生成该方向延伸节点', 'success')
        } else if (existingCnt > 0) {
          get().pushToast('该方向节点已存在，已高亮', 'info')
        } else {
          get().pushToast('未生成延伸节点', 'info')
        }
      }
      set({ extending: false })
      // 节点变更后刷新推荐（仅在对话视图时，避免图谱视图无谓请求）
      if (get().activeNav === 'chat') {
        void get().loadRecommendations(get().recommendationsMode)
      }
      return resp
    } catch (e) {
      set({ extending: false, error: errMsg(e) })
      get().pushToast(`延伸失败：${errMsg(e)}`, 'error')
      return null
    }
  },

  revokeExtend: async () => {
    const graphId = get().currentGraphId
    const batchId = get().extensionBatchId
    const nodeId = get().extensionBatchNodeId
    if (!graphId || !batchId || !nodeId) {
      get().pushToast('没有可撤销的延伸批次', 'warning')
      return false
    }
    set({ extending: true, error: '' })
    try {
      const resp = await api.revokeExtend(graphId, nodeId, batchId)
      // 整图刷新：删除的节点 / 边将消失
      await get().loadFullGraph(graphId)
      set({
        extensionBatchId: null,
        extensionBatchNodeId: null,
        extending: false,
      })
      get().pushToast(
        `已撤销延伸（删除 ${resp.deleted_nodes} 节点 / ${resp.deleted_edges} 边）`,
        'success',
      )
      return true
    } catch (e) {
      set({ extending: false, error: errMsg(e) })
      get().pushToast(`撤销失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  flashNodes: (ids, autoClear = true) => {
    set({ flashNodeIds: ids })
    if (_flashClearTimer) {
      clearTimeout(_flashClearTimer)
      _flashClearTimer = null
    }
    if (autoClear && ids.length > 0) {
      _flashClearTimer = setTimeout(() => {
        _flashClearTimer = null
        // 仅在当前 flashNodeIds 与设置时一致时清空，
        // 避免清空后续新设置的闪烁
        if (get().flashNodeIds === ids) {
          set({ flashNodeIds: [] })
        }
      }, FLASH_AUTO_CLEAR_MS)
    }
  },

  clearFlash: () => {
    if (_flashClearTimer) {
      clearTimeout(_flashClearTimer)
      _flashClearTimer = null
    }
    set({ flashNodeIds: [] })
  },

  // ===== Task 11：候选节点抽取 =====
  loadPendingObservations: async () => {
    set({ error: '' })
    try {
      const list = await api.listObservations({ processed: false, limit: 100 })
      set({ pendingObservations: list })
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  extractCandidates: async (observationId) => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    set({ extracting: true, error: '' })
    try {
      const resp = await api.extractNodes(observationId, graphId)
      set({
        candidateNodes: resp.candidates,
        candidateObservationId: observationId,
        extracting: false,
      })
      if (resp.degraded || resp.candidates.length === 0) {
        get().pushToast(
          '未抽取到候选节点（LLM 可能不可用，可降级手工添加）',
          'warning',
        )
      } else {
        get().pushToast(`抽取到 ${resp.candidates.length} 个候选节点`, 'success')
      }
      return true
    } catch (e) {
      set({ extracting: false, error: errMsg(e) })
      get().pushToast(`抽取失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  clearCandidates: () => {
    set({ candidateNodes: [], candidateObservationId: null })
  },

  batchCreateNodes: async (nodes, observationId) => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    const obsId = observationId ?? get().candidateObservationId ?? undefined
    set({ batchCreating: true, error: '' })
    try {
      const body: BatchCreateNodesRequest = {
        nodes,
        observation_id: obsId,
      }
      const resp = await api.batchCreateNodes(graphId, body)
      // 整图刷新：包含新创建的节点
      await get().loadFullGraph(graphId)
      // 闪烁高亮新建节点
      const createdIds = resp.created.map((n) => n.id)
      if (createdIds.length > 0) {
        get().flashNodes(createdIds, true)
      }
      // 清空候选列表（已入图）
      set({
        candidateNodes: [],
        candidateObservationId: null,
        batchCreating: false,
      })
      // 刷新待抽取列表（observation 已标记 processed）
      void get().loadPendingObservations()
      const parts: string[] = [`新建 ${resp.created_count} 个节点`]
      if (resp.skipped_count > 0) {
        parts.push(`${resp.skipped_count} 个已存在跳过`)
      }
      get().pushToast(parts.join('，'), 'success')
      return resp
    } catch (e) {
      set({ batchCreating: false, error: errMsg(e) })
      get().pushToast(`入图失败：${errMsg(e)}`, 'error')
      return null
    }
  },

  togglePendingPanel: (open) => {
    set({ pendingPanelOpen: open ?? !get().pendingPanelOpen })
  },

  // ===== Task 12：测验 =====
  setQuizPanelOpen: (open) => {
    const next = open ?? !get().quizPanelOpen
    set({ quizPanelOpen: next })
    // 打开面板时自动加载当前图谱历史
    if (next && get().currentGraphId) {
      void get().loadQuizHistory()
    }
  },

  setQuizStage: (stage) => set({ quizStage: stage }),

  setQuizType: (type) => set({ quizType: type }),

  setQuizNodeIds: (ids) => set({ quizNodeIds: ids }),

  generateQuiz: async () => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    set({ generatingQuiz: true, error: '' })
    try {
      const body: QuizGenerateRequest = {
        node_ids: get().quizNodeIds ?? undefined,
        quiz_type: get().quizType,
        count: 1,
      }
      const quiz = await api.generateQuiz(graphId, body)
      set({
        currentQuiz: quiz,
        quizGradeResult: null,
        quizStage: 'answering',
        generatingQuiz: false,
      })
      // 判断是否降级题目
      const payload = (quiz.payload ?? {}) as Record<string, unknown>
      if (payload.degraded) {
        get().pushToast(
          '题目生成服务暂不可用（已生成降级占位题，可继续作答）',
          'warning',
        )
      } else {
        get().pushToast('题目已生成，请作答', 'success')
      }
      // 刷新历史列表
      void get().loadQuizHistory()
      return true
    } catch (e) {
      set({ generatingQuiz: false, error: errMsg(e) })
      get().pushToast(`题目生成失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  answerQuiz: async (answer) => {
    const graphId = get().currentGraphId
    const quiz = get().currentQuiz
    if (!graphId || !quiz) {
      get().pushToast('当前没有可作答的题目', 'warning')
      return false
    }
    // 选择题至少校验一个选项；费曼题非空校验放后端
    if (Array.isArray(answer) && answer.length === 0) {
      get().pushToast('请选择至少一个选项', 'warning')
      return false
    }
    set({ answeringQuiz: true, error: '' })
    try {
      const body: QuizAnswerRequest = { answer }
      const result = await api.answerQuiz(graphId, quiz.id, body)
      set({
        quizGradeResult: result,
        quizStage: 'result',
        answeringQuiz: false,
      })
      // Toast 反馈
      if (result.type === 'feynman') {
        const level = result.understanding_level
        const score = result.score
        if (result.degraded) {
          get().pushToast(
            `已判分（降级模式）：${score} 分（${level}）`,
            'warning',
          )
        } else if (level === 'good') {
          get().pushToast(`理解度评分 ${score} 分，理解到位`, 'success')
        } else if (level === 'partial') {
          get().pushToast(`理解度评分 ${score} 分，部分掌握`, 'info')
        } else {
          get().pushToast(`理解度评分 ${score} 分，需加强`, 'warning')
        }
      } else {
        // 选择题
        if (result.degraded) {
          get().pushToast('已判分（题目为降级占位题）', 'warning')
        } else if (result.correct) {
          get().pushToast('回答正确', 'success')
        } else {
          get().pushToast('回答错误，已显示正确答案与解析', 'warning')
        }
      }
      // 刷新历史列表（answered 状态变化）
      void get().loadQuizHistory()
      return true
    } catch (e) {
      set({ answeringQuiz: false, error: errMsg(e) })
      get().pushToast(`作答失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  loadQuizHistory: async () => {
    const graphId = get().currentGraphId
    if (!graphId) {
      set({ quizHistory: [] })
      return
    }
    set({ loadingQuizHistory: true, error: '' })
    try {
      const list = await api.listQuizzes(graphId)
      set({ quizHistory: list, loadingQuizHistory: false })
    } catch (e) {
      set({ loadingQuizHistory: false, error: errMsg(e) })
    }
  },

  clearQuiz: () => {
    set({
      currentQuiz: null,
      quizGradeResult: null,
      quizStage: 'config',
      // 清除生成/作答进行中标记（避免卡死）
      generatingQuiz: false,
      answeringQuiz: false,
    })
  },

  reviewQuiz: async (quizId) => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    set({ error: '' })
    try {
      const quiz = await api.getQuiz(graphId, quizId)
      // 已作答题目：从 result 中重建 gradeResult 以便复用 result 视图
      let grade: QuizGradeResult | null = null
      if (quiz.answered && quiz.result) {
        const r = quiz.result as Record<string, unknown>
        if (quiz.type === 'feynman') {
          grade = {
            quiz_id: quiz.id,
            type: 'feynman',
            node_id: quiz.node_id,
            score: Number(r.score ?? 0),
            understanding_level: (r.understanding_level as 'good' | 'partial' | 'poor') ?? 'poor',
            feedback: String(r.feedback ?? ''),
            missed_points: (r.missed_points as string[]) ?? [],
            reference_points: (r.reference_points as string[]) ?? [],
            prompt: String((quiz.payload as Record<string, unknown>)?.prompt ?? ''),
            degraded: Boolean(r.degraded),
            degrade_reason: r.degrade_reason ? String(r.degrade_reason) : undefined,
            result: r,
          }
        } else {
          const payload = (quiz.payload ?? {}) as Record<string, unknown>
          grade = {
            quiz_id: quiz.id,
            type: quiz.type as 'single_choice' | 'multi_choice',
            node_id: quiz.node_id,
            correct: Boolean(r.correct),
            user_answer: (r.user_answer as string[]) ?? [],
            correct_answers: (r.correct_answers as string[]) ?? [],
            explanation: String(r.explanation ?? ''),
            options: (payload.options as QuizOption[]) ?? [],
            degraded: Boolean(r.degraded),
            result: r,
          }
        }
      }
      set({
        currentQuiz: quiz,
        quizGradeResult: grade,
        quizStage: quiz.answered ? 'result' : 'answering',
      })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      get().pushToast(`加载历史题目失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  // ===== Task 13 / 14 / 15 / 16：Work 模式业务 =====
  setWorkPanel: (panel) => {
    // 切换面板：若关闭当前面板或切换到其他面板，清空进行中标记避免卡死
    set({
      workActivePanel: panel,
      workExtracting: false,
      workConfirming: false,
      trendsLoading: false,
      trendAddingIndex: null,
      reportGenerating: false,
      reportExporting: false,
      qaAsking: false,
    })
  },

  extractWorkObjects: async (text) => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    if (!text.trim()) {
      get().pushToast('请输入工作信息文本', 'warning')
      return false
    }
    set({ workExtracting: true, error: '' })
    try {
      const resp: WorkExtractResponse = await api.extractWorkObjects(graphId, text)
      set({
        candidateWorkObjects: resp.objects,
        workExtracting: false,
      })
      if (resp.degraded || resp.objects.length === 0) {
        get().pushToast(
          '未抽取到工作对象（AI 服务可能不可用，可降级手工添加）',
          'warning',
        )
      } else {
        get().pushToast(`抽取到 ${resp.objects.length} 个候选工作对象`, 'success')
      }
      return true
    } catch (e) {
      set({ workExtracting: false, error: errMsg(e) })
      get().pushToast(`抽取失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  clearCandidateWorkObjects: () => {
    set({ candidateWorkObjects: [] })
  },

  confirmWorkObjects: async (objects) => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    set({ workConfirming: true, error: '' })
    try {
      const resp = await api.confirmWorkObjects(graphId, { objects })
      // 整图刷新：包含新创建的节点与关系边
      await get().loadFullGraph(graphId)
      // 闪烁高亮新建节点
      const createdIds = resp.created.map((n) => n.id)
      if (createdIds.length > 0) {
        get().flashNodes(createdIds, true)
      }
      // 清空候选列表（已入图）
      set({ candidateWorkObjects: [], workConfirming: false })
      const parts: string[] = [`新建 ${resp.created_count} 个对象`]
      if (resp.skipped_count > 0) {
        parts.push(`${resp.skipped_count} 个已存在跳过`)
      }
      if (resp.edges_created > 0) {
        parts.push(`建立 ${resp.edges_created} 条关系`)
      }
      get().pushToast(parts.join('，'), 'success')
      return resp
    } catch (e) {
      set({ workConfirming: false, error: errMsg(e) })
      get().pushToast(`入图失败：${errMsg(e)}`, 'error')
      return null
    }
  },

  generateTrends: async () => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    set({ trendsLoading: true, error: '' })
    try {
      const resp = await api.generateTrends(graphId)
      set({ trends: resp.trends, trendsLoading: false })
      if (resp.degraded || resp.trends.length === 0) {
        get().pushToast(
          '未生成风口推荐（AI 服务可能不可用，或图谱内容过少）',
          'warning',
        )
      } else {
        get().pushToast(`生成 ${resp.trends.length} 条风口推荐`, 'success')
      }
      return true
    } catch (e) {
      set({ trendsLoading: false, error: errMsg(e) })
      get().pushToast(`风口生成失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  addTrendToGraph: async (index) => {
    const graphId = get().currentGraphId
    if (!graphId) return false
    set({ trendAddingIndex: index, error: '' })
    try {
      const resp = await api.addTrendToGraph(graphId, index)
      // 整图刷新：新节点已加入
      await get().loadFullGraph(graphId)
      // 闪烁高亮新建节点
      get().flashNodes([resp.node.id], true)
      set({ trendAddingIndex: null })
      get().pushToast(`已把「${resp.trend_title}」加入图谱`, 'success')
      return true
    } catch (e) {
      set({ trendAddingIndex: null, error: errMsg(e) })
      get().pushToast(`加入图谱失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  setReportPeriod: (period) => set({ reportPeriod: period }),

  generateReport: async () => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    const period = get().reportPeriod
    set({ reportGenerating: true, error: '' })
    try {
      const resp = await api.generateReport(graphId, { period })
      set({ reportResult: resp, reportGenerating: false })
      if (resp.degraded) {
        get().pushToast(
          '报告已生成（降级模式：AI 服务不可用，仅含结构化骨架）',
          'warning',
        )
      } else {
        get().pushToast('工作报告已生成', 'success')
      }
      return true
    } catch (e) {
      set({ reportGenerating: false, error: errMsg(e) })
      get().pushToast(`报告生成失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  exportReportDocx: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return false
    const period = get().reportPeriod
    set({ reportExporting: true, error: '' })
    try {
      const result = await api.exportReportDocx(graphId, period)
      set({ reportExporting: false })
      get().pushToast(`已导出 ${result.filename}`, 'success')
      return true
    } catch (e) {
      set({ reportExporting: false, error: errMsg(e) })
      get().pushToast(`导出失败：${errMsg(e)}`, 'error')
      return false
    }
  },

  askWorkQuestion: async (question) => {
    const graphId = get().currentGraphId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    if (!question.trim()) {
      get().pushToast('请输入问题', 'warning')
      return false
    }
    // 立即把用户问题追加到对话历史，保证流式体验
    const userMsg: QaMessage = {
      role: 'user',
      content: question,
      ts: Date.now(),
    }
    set({
      qaMessages: [...get().qaMessages, userMsg],
      qaAsking: true,
      error: '',
    })
    try {
      const resp: WorkAskResponse = await api.askWorkQuestion(graphId, {
        question,
      })
      const assistantMsg: QaMessage = {
        role: 'assistant',
        content: resp.answer,
        sources: resp.sources,
        confidence: resp.confidence,
        degraded: resp.degraded,
        degradeReason: resp.degrade_reason,
        ts: Date.now(),
      }
      set({
        qaMessages: [...get().qaMessages, assistantMsg],
        qaAsking: false,
      })
      if (resp.degraded) {
        get().pushToast(
          '已回答（降级模式：AI 服务不可用）',
          'warning',
        )
      }
      return true
    } catch (e) {
      // 追加一条错误占位消息，便于用户感知失败
      const errMsgText = errMsg(e)
      const failMsg: QaMessage = {
        role: 'assistant',
        content: `（回答失败：${errMsgText}）`,
        ts: Date.now(),
        degraded: true,
        degradeReason: errMsgText,
      }
      set({
        qaMessages: [...get().qaMessages, failMsg],
        qaAsking: false,
        error: errMsgText,
      })
      get().pushToast(`提问失败：${errMsgText}`, 'error')
      return false
    }
  },

  clearQaMessages: () => set({ qaMessages: [] }),

  // ===== 推荐 / touch / remind / star =====
  loadRecommendations: async (mode) => {
    const graphId = get().currentGraphId
    if (!graphId) {
      // 无选中图谱：清空推荐并同步模式后返回
      set({ recommendations: [], recommendationsMode: mode })
      return
    }
    set({ recommendationsLoading: true, recommendationsError: '' })
    try {
      const resp = await api.getRecommendations(graphId, mode)
      set({
        recommendations: resp.items,
        recommendationsMode: mode,
        recommendationsLoading: false,
      })
    } catch (e) {
      set({
        recommendationsLoading: false,
        recommendationsError: errMsg(e),
      })
    }
  },

  touchNode: async (id) => {
    set({ error: '' })
    try {
      const updated = await api.touchNode(id)
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, updated) })
    } catch (e) {
      set({ error: errMsg(e) })
    }
  },

  setRemind: async (id, remindAt) => {
    set({ error: '' })
    try {
      const updated = await api.setRemind(id, remindAt)
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, updated) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  clearRemind: async (id) => {
    set({ error: '' })
    try {
      const updated = await api.clearRemind(id)
      const full = get().fullGraph
      if (full) set({ fullGraph: replaceNode(full, updated) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  toggleStar: async (id) => {
    const full = get().fullGraph
    const node = full?.nodes.find((n) => n.id === id)
    if (!node) {
      get().pushToast('未找到该节点', 'warning')
      return false
    }
    const next = !node.is_starred
    set({ error: '' })
    try {
      const updated = await api.setStar(id, next)
      if (full) set({ fullGraph: replaceNode(full, updated) })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  loadReminderCount: async () => {
    // 推荐列表非空：直接统计到期数；为空则先按当前模式加载再统计
    if (get().recommendations.length === 0) {
      await get().loadRecommendations(get().recommendationsMode)
    }
    const count = get().recommendations.filter((r) => r.is_overdue).length
    set({ reminderCount: count })
  },

  // ===== 通用 Toast =====
  pushToast: (message, type = 'info') => {
    _toastSeq += 1
    set({ toast: { id: _toastSeq, type, message } })
  },

  clearToast: () => set({ toast: null }),

  // ===== 设置面板：LLM 请求队列与配置 =====
  loadLlmRequests: async () => {
    set({ llmRequestsLoading: true, llmRequestsError: '' })
    try {
      const list = await api.getLlmRequests()
      set({ llmRequests: list, llmRequestsLoading: false })
    } catch (e) {
      const msg = errMsg(e)
      set({
        llmRequestsLoading: false,
        llmRequestsError: msg,
      })
      // 不弹 toast，避免轮询时刷屏；错误信息在面板内展示
    }
  },

  cancelLlmRequest: async (id) => {
    set({ llmCancellingId: id, llmRequestsError: '' })
    try {
      const resp = await api.cancelLlmRequest(id)
      // 立即刷新列表，反映取消后的状态
      await get().loadLlmRequests()
      set({ llmCancellingId: null })
      if (resp.cancelled) {
        get().pushToast('已取消该 LLM 请求', 'success')
      } else {
        get().pushToast(
          '该请求已结束，无需取消（可能已完成或失败）',
          'info',
        )
      }
      return resp.cancelled
    } catch (e) {
      set({ llmCancellingId: null })
      const msg = errMsg(e)
      get().pushToast(`取消失败：${msg}`, 'error')
      return false
    }
  },

  loadLlmConfig: async () => {
    set({ llmConfigLoading: true })
    try {
      const cfg = await api.getLlmConfig()
      set({ llmConfig: cfg, llmConfigLoading: false })
    } catch (e) {
      const msg = errMsg(e)
      set({ llmConfigLoading: false })
      get().pushToast(`加载 LLM 配置失败：${msg}`, 'error')
    }
  },

  updateLlmConfig: async (config) => {
    set({ llmConfigSaving: true })
    try {
      const resp = await api.updateLlmConfig(config)
      // 用响应中的最新配置覆盖本地
      set({ llmConfig: resp.config, llmConfigSaving: false })
      get().pushToast(
        resp.message
          ? `配置已保存：${resp.message}`
          : 'LLM 配置已保存（部分变更可能需重启后端生效）',
        'success',
      )
      return true
    } catch (e) {
      set({ llmConfigSaving: false })
      const msg = errMsg(e)
      get().pushToast(`保存配置失败：${msg}`, 'error')
      return false
    }
  },

  testLlmConnection: async (config) => {
    set({ llmTesting: true })
    try {
      const resp = await api.testLlmConnection(config)
      set({ llmTestResult: resp, llmTesting: false })
      return resp.ok
    } catch (e) {
      const msg = errMsg(e)
      // 网络错误等：构造一个失败结果，便于面板内联展示
      set({
        llmTesting: false,
        llmTestResult: {
          ok: false,
          latency_ms: 0,
          model: '',
          base_url: '',
          message: `请求失败：${msg}`,
        },
      })
      return false
    }
  },

  // ===== 设置面板：插件对接分区 =====
  loadPluginRecent: async (limit) => {
    set({ pluginRecentLoading: true, pluginRecentError: '' })
    try {
      const resp = await api.getPluginRecent(limit ?? 20)
      set({
        pluginRecent: resp.items ?? [],
        pluginRecentLoading: false,
      })
    } catch (e) {
      const msg = errMsg(e)
      set({
        pluginRecentLoading: false,
        pluginRecentError: msg,
      })
      // 不弹 toast，避免轮询刷屏；错误信息在面板内展示
    }
  },

  loadPluginContract: async () => {
    try {
      const contract = await api.getPluginContract()
      set({ pluginContract: contract })
      return contract
    } catch (e) {
      const msg = errMsg(e)
      get().pushToast(`加载插件契约失败：${msg}`, 'error')
      return null
    }
  },

  handlePluginConversationReceived: (payload) => {
    // 1. 弹 Toast 提示收到新对话
    get().pushToast(
      `收到新对话：${payload.title || payload.platform}`,
      'info',
    )
    // 2. 若处于图谱视图且为学习模式，刷新待抽取列表（PendingNodes）
    if (get().activeNav === 'graph' && get().mode === 'study') {
      void get().loadPendingObservations()
    }
  },

  // ===== 流式输出动作 =====

  setStreamingSessionId: (id) => set({ streamingSessionId: id }),

  handleGraphAgentToken: (event) => {
    const { op, content } = event
    if (!content) return

    if (op === 'answer_question') {
      // 追加到 QA 流式文本
      const nextText = get().qaStreamingText + content
      set({ qaStreamingText: nextText })
      // 同步更新最后一条 assistant 消息的内容（实时打字机效果）
      const messages = get().qaMessages
      if (messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant') {
          const updated = { ...last, content: nextText }
          set({
            qaMessages: [
              ...messages.slice(0, -1),
              updated,
            ],
          })
        }
      }
    } else if (op === 'generate_report') {
      // 追加到报告流式文本
      const nextText = get().reportStreamingText + content
      set({ reportStreamingText: nextText })
      // 同步更新 reportResult.markdown（实时预览）
      const cur = get().reportResult
      if (cur) {
        set({
          reportResult: { ...cur, markdown: nextText },
        })
      } else {
        // 流式过程中 reportResult 尚未创建，构造一个流式占位
        set({
          reportResult: {
            markdown: nextText,
            sections: { progress: [], plan: [], risks: [], commitments: [] },
            period: get().reportPeriod,
            degraded: false,
            degrade_reason: '',
          },
        })
      }
    } else if (op === 'generate_node_detail') {
      // 仅更新与当前流式节点匹配的事件
      const streamingNodeId = get().nodeDetailStreamingNodeId
      if (event.node_id && streamingNodeId && event.node_id !== streamingNodeId) {
        return
      }
      const nextText = get().nodeDetailStreamingText + content
      set({ nodeDetailStreamingText: nextText })
    }
  },

  handleGraphAgentDone: (event) => {
    const { op, full_text } = event

    if (op === 'answer_question') {
      // 终结 QA 流式
      set({ qaStreamingActive: false, qaAsking: false })
      // 用 full_text 兜底最后一条 assistant 消息（防止 token 丢失）
      const messages = get().qaMessages
      if (messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant' && full_text) {
          const updated = { ...last, content: full_text }
          set({
            qaMessages: [...messages.slice(0, -1), updated],
          })
        }
      }
      // 清空流式文本（已写入消息）
      set({ qaStreamingText: '' })
    } else if (op === 'generate_report') {
      // 终结报告流式
      set({ reportStreamingActive: false, reportGenerating: false })
      // 写入最终报告
      set({
        reportResult: {
          markdown: full_text,
          sections: { progress: [], plan: [], risks: [], commitments: [] },
          period: get().reportPeriod,
          degraded: false,
          degrade_reason: '',
        },
        reportStreamingText: '',
      })
      get().pushToast('工作报告已生成', 'success')
    } else if (op === 'generate_node_detail') {
      // 终结节点详情流式
      set({
        nodeDetailStreamingActive: false,
        nodeDetailStreamingText: full_text,
      })
      get().pushToast('节点详情已生成', 'success')
    }
  },

  handleGraphAgentCancelled: (event) => {
    const { op, full_text } = event
    if (op === 'answer_question') {
      set({ qaStreamingActive: false, qaAsking: false, qaStreamingText: '' })
      // 把已生成部分写入最后一条 assistant 消息
      const messages = get().qaMessages
      if (messages.length > 0 && full_text) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant') {
          const updated = {
            ...last,
            content: full_text + '\n\n（已取消）',
            degraded: true,
            degradeReason: '用户取消生成',
          }
          set({
            qaMessages: [...messages.slice(0, -1), updated],
          })
        }
      }
      get().pushToast('已取消回答生成', 'info')
    } else if (op === 'generate_report') {
      set({
        reportStreamingActive: false,
        reportGenerating: false,
        reportStreamingText: '',
      })
      get().pushToast('已取消报告生成', 'info')
    } else if (op === 'generate_node_detail') {
      set({
        nodeDetailStreamingActive: false,
        nodeDetailStreamingText: full_text,
      })
      get().pushToast('已取消详情生成', 'info')
    }
  },

  handleGraphAgentError: (event) => {
    const { op, message } = event
    if (op === 'answer_question') {
      set({
        qaStreamingActive: false,
        qaAsking: false,
        qaStreamingText: '',
      })
      // 在最后一条 assistant 消息上标记降级
      const messages = get().qaMessages
      if (messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant') {
          const updated = {
            ...last,
            content: last.content || `（回答失败：${message}）`,
            degraded: true,
            degradeReason: message,
          }
          set({
            qaMessages: [...messages.slice(0, -1), updated],
          })
        }
      }
      get().pushToast(`回答失败：${message}`, 'error')
    } else if (op === 'generate_report') {
      set({
        reportStreamingActive: false,
        reportGenerating: false,
        reportStreamingText: '',
      })
      get().pushToast(`报告生成失败：${message}`, 'error')
    } else if (op === 'generate_node_detail') {
      set({
        nodeDetailStreamingActive: false,
        nodeDetailStreamingText: '',
        nodeDetailStreamingNodeId: null,
      })
      get().pushToast(`详情生成失败：${message}`, 'error')
    }
  },

  askWorkQuestionStream: async (question) => {
    const graphId = get().currentGraphId
    const sessionId = get().streamingSessionId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    if (!question.trim()) {
      get().pushToast('请输入问题', 'warning')
      return false
    }
    // 无 session_id：回退到非流式
    if (!sessionId) {
      return get().askWorkQuestion(question)
    }
    // 立即追加 user 消息 + 空 assistant 占位消息
    const userMsg: QaMessage = {
      role: 'user',
      content: question,
      ts: Date.now(),
    }
    const assistantPlaceholder: QaMessage = {
      role: 'assistant',
      content: '',
      ts: Date.now(),
    }
    set({
      qaMessages: [...get().qaMessages, userMsg, assistantPlaceholder],
      qaAsking: true,
      qaStreamingActive: true,
      qaStreamingText: '',
      error: '',
    })
    try {
      await api.streamAskQuestion(graphId, question, sessionId)
      // 流式 token 将通过 WS 事件 handleGraphAgentToken 实时更新
      return true
    } catch (e) {
      // 触发失败：标记占位消息为错误
      const msg = errMsg(e)
      const messages = get().qaMessages
      if (messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant') {
          const updated: QaMessage = {
            ...last,
            content: `（回答失败：${msg}）`,
            degraded: true,
            degradeReason: msg,
          }
          set({
            qaMessages: [...messages.slice(0, -1), updated],
          })
        }
      }
      set({
        qaAsking: false,
        qaStreamingActive: false,
        qaStreamingText: '',
        error: msg,
      })
      get().pushToast(`提问失败：${msg}`, 'error')
      return false
    }
  },

  generateReportStream: async () => {
    const graphId = get().currentGraphId
    const sessionId = get().streamingSessionId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    if (!sessionId) {
      return get().generateReport()
    }
    const period = get().reportPeriod
    set({
      reportGenerating: true,
      reportStreamingActive: true,
      reportStreamingText: '',
      // 清空旧报告，流式过程中逐步填充
      reportResult: null,
      error: '',
    })
    try {
      await api.streamGenerateReport(graphId, period, sessionId)
      return true
    } catch (e) {
      const msg = errMsg(e)
      set({
        reportGenerating: false,
        reportStreamingActive: false,
        reportStreamingText: '',
        error: msg,
      })
      get().pushToast(`报告生成失败：${msg}`, 'error')
      return false
    }
  },

  generateNodeDetailStream: async (nodeId) => {
    const graphId = get().currentGraphId
    const sessionId = get().streamingSessionId
    if (!graphId) {
      get().pushToast('请先选中一个图谱', 'warning')
      return false
    }
    if (!sessionId) {
      // 回退到非流式
      const resp = await get().generateNodeDetail(nodeId)
      return resp !== null
    }
    set({
      nodeDetailStreamingActive: true,
      nodeDetailStreamingText: '',
      nodeDetailStreamingNodeId: nodeId,
      error: '',
    })
    try {
      await api.streamNodeDetail(graphId, nodeId, sessionId)
      return true
    } catch (e) {
      const msg = errMsg(e)
      set({
        nodeDetailStreamingActive: false,
        nodeDetailStreamingText: '',
        nodeDetailStreamingNodeId: null,
        error: msg,
      })
      get().pushToast(`详情生成失败：${msg}`, 'error')
      return false
    }
  },

  clearQaStreaming: () =>
    set({ qaStreamingText: '', qaStreamingActive: false }),

  clearReportStreaming: () =>
    set({ reportStreamingText: '', reportStreamingActive: false }),

  clearNodeDetailStreaming: () =>
    set({
      nodeDetailStreamingText: '',
      nodeDetailStreamingActive: false,
      nodeDetailStreamingNodeId: null,
    }),

  // ===== Task 9：多轮对话 chat 动作 =====

  loadChatSessions: async () => {
    const mode = get().mode
    const graphId = get().currentGraphId
    try {
      // 优先按 graph_id 过滤；无 currentGraphId 时按 mode 拉取全部
      const sessions = await api.listChatSessions(mode, graphId ?? undefined, 50)
      set({ chatSessions: sessions })
      // 自动恢复最近一个会话为 currentChatSession（若当前未选中）
      if (!get().currentChatSession && sessions.length > 0) {
        await get().selectChatSession(sessions[0])
      }
    } catch (e) {
      // 静默降级：不弹 toast，仅写 error
      set({ error: errMsg(e) })
    }
  },

  createChatSession: async (body) => {
    const mode = body?.mode ?? get().mode
    let graphId = body?.graph_id !== undefined ? body.graph_id : get().currentGraphId
    // graph_id 为 null 时，自动查找当前模式的第一个图谱
    if (!graphId) {
      try {
        const graphs = await api.getGraphs(mode)
        if (graphs && graphs.length > 0) {
          graphId = graphs[0].id
        }
      } catch {
        // 查找图谱失败时静默降级，graphId 保持 null
      }
    }
    set({ error: '' })
    try {
      const session = await api.createChatSession({
        mode,
        graph_id: graphId,
        title: body?.title,
      })
      set({
        chatSessions: [session, ...get().chatSessions],
        currentChatSession: session,
        chatMessages: [],
        chatStreamingActive: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
        chatAsking: false,
        currentCheckpoint: null,
        pendingToolConfirmation: null,
      })
      return session
    } catch (e) {
      const msg = errMsg(e)
      set({ error: msg })
      get().pushToast(`创建会话失败：${msg}`, 'error')
      return null
    }
  },

  selectChatSession: async (session) => {
    if (session === null) {
      set({
        currentChatSession: null,
        chatMessages: [],
        chatStreamingActive: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
        chatAsking: false,
        currentCheckpoint: null,
        pendingToolConfirmation: null,
      })
      return
    }
    set({ currentChatSession: session, error: '' })
    try {
      const messages = await api.getChatMessages(session.id)
      set({ chatMessages: messages })
    } catch (e) {
      const msg = errMsg(e)
      set({ error: msg })
      get().pushToast(`加载消息历史失败：${msg}`, 'error')
    }
  },

  sendMessage: async (content) => {
    const trimmed = content.trim()
    if (!trimmed) {
      get().pushToast('请输入问题', 'warning')
      return false
    }
    if (get().chatAsking) {
      get().pushToast('当前对话进行中，请稍候', 'warning')
      return false
    }

    // 确保 currentChatSession 存在：缺失时按当前 mode + graphId 自动创建
    let session = get().currentChatSession
    if (!session) {
      session = await get().createChatSession()
      if (!session) return false
    }

    const sessionId = get().streamingSessionId
    if (!sessionId) {
      get().pushToast('WebSocket 未连接，无法流式对话', 'error')
      return false
    }

    // 追加 user 消息 + 空 assistant 占位消息
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: `local-user-${Date.now()}`,
      session_id: session.id,
      role: 'user',
      content: trimmed,
      attachments: [],
      created_at: now,
    }
    const assistantPlaceholder: ChatMessage = {
      id: `local-assistant-${Date.now()}`,
      session_id: session.id,
      role: 'assistant',
      content: '',
      attachments: [],
      created_at: now,
      tool_calls: [],
    }
    set({
      chatMessages: [...get().chatMessages, userMsg, assistantPlaceholder],
      chatAsking: true,
      chatStreamingActive: true,
      chatStreamingText: '',
      chatStreamingRequestId: null,
      error: '',
    })

    try {
      const resp: ChatStreamStartedResponse = await api.startChatStream(
        session.id,
        {
          content: trimmed,
          session_id: sessionId,
          plan_mode: get().planMode,
        },
      )
      // 保存 request_id 用于取消
      set({ chatStreamingRequestId: resp.request_id })
      // 流式 token / tool_call / done 等通过 WS 事件实时更新占位消息
      return true
    } catch (e) {
      const msg = errMsg(e)
      // 标记占位 assistant 消息为错误
      const messages = get().chatMessages
      if (messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'assistant') {
          const updated: ChatMessage = {
            ...last,
            content: `（回答失败：${msg}）`,
          }
          set({
            chatMessages: [...messages.slice(0, -1), updated],
          })
        }
      }
      set({
        chatAsking: false,
        chatStreamingActive: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
        error: msg,
      })
      get().pushToast(`发送失败：${msg}`, 'error')
      return false
    }
  },

  cancelChat: async () => {
    const requestId = get().chatStreamingRequestId
    // 无论 requestId 是否存在，都强制重置本地流式状态，避免 UI 卡死
    const _resetStreamingState = () => {
      set({
        chatStreamingActive: false,
        chatAsking: false,
        chatStreamingText: '',
        chatStreamingRequestId: null,
      })
    }
    if (!requestId) {
      // requestId 缺失但仍处于流式状态时，强制重置并重载消息
      _resetStreamingState()
      const session = get().currentChatSession
      if (session) {
        try {
          const messages = await api.getChatMessages(session.id)
          set({ chatMessages: messages })
        } catch {
          // 重载失败时静默降级
        }
      }
      get().pushToast('已强制取消流式状态', 'info')
      return true
    }
    try {
      const resp: CancelChatResponse = await api.cancelChatStream(requestId)
      if (resp.ok) {
        _resetStreamingState()
        // 重载消息以获取后端已保存的部分响应
        const session = get().currentChatSession
        if (session) {
          try {
            const messages = await api.getChatMessages(session.id)
            set({ chatMessages: messages })
          } catch {
            // 重载失败时静默降级
          }
        }
        get().pushToast('已取消当前对话', 'info')
      } else {
        // API 返回失败时也强制重置，避免 UI 卡死
        _resetStreamingState()
      }
      return resp.ok
    } catch (e) {
      const msg = errMsg(e)
      // 异常时强制重置，避免 UI 卡死
      _resetStreamingState()
      get().pushToast(`取消异常已强制重置：${msg}`, 'error')
      return false
    }
  },

  confirmToolCall: async (modifiedArgs) => {
    const pending = get().pendingToolConfirmation
    if (!pending) return false
    try {
      const resp: ConfirmToolCallResponse = await api.confirmChatToolCall(
        pending.request_id,
        { approved: true, modified_args: modifiedArgs },
      )
      if (resp.ok) {
        set({ pendingToolConfirmation: null })
        get().pushToast('已同意执行，继续对话…', 'info')
      }
      return resp.ok
    } catch (e) {
      const msg = errMsg(e)
      get().pushToast(`确认失败：${msg}`, 'error')
      return false
    }
  },

  setWorkObjectSingleConfirm: (on) => {
    _saveBoolSetting('kwa.workObjectSingleConfirm', on)
    set({ workObjectSingleConfirm: on })
  },

  rejectToolCall: async (reason) => {
    const pending = get().pendingToolConfirmation
    if (!pending) return false
    try {
      const resp: ConfirmToolCallResponse = await api.confirmChatToolCall(
        pending.request_id,
        { approved: false, reason: reason ?? '用户拒绝执行' },
      )
      if (resp.ok) {
        set({ pendingToolConfirmation: null })
        get().pushToast('已拒绝执行，agent 将据此调整后续对话', 'info')
      }
      return resp.ok
    } catch (e) {
      const msg = errMsg(e)
      get().pushToast(`拒绝失败：${msg}`, 'error')
      return false
    }
  },

  loadCheckpoint: async () => {
    const session = get().currentChatSession
    if (!session) {
      set({ currentCheckpoint: null })
      return
    }
    try {
      const cp = await api.getChatCheckpoint(session.id)
      set({ currentCheckpoint: cp })
    } catch (e) {
      // 静默：checkpoint 加载失败不打扰用户
      set({ error: errMsg(e) })
    }
  },

  triggerCheckpoint: async () => {
    const session = get().currentChatSession
    if (!session) {
      get().pushToast('当前无选中会话', 'warning')
      return false
    }
    try {
      const resp: TriggerCheckpointResponse = await api.triggerChatCheckpoint(
        session.id,
      )
      if (resp.ok) {
        get().pushToast('已生成 checkpoint', 'success')
        // 刷新 checkpoint 状态
        await get().loadCheckpoint()
      } else {
        get().pushToast(
          `未生成 checkpoint：${resp.reason ?? '未知原因'}`,
          'warning',
        )
      }
      return resp.ok
    } catch (e) {
      const msg = errMsg(e)
      get().pushToast(`触发 checkpoint 失败：${msg}`, 'error')
      return false
    }
  },

  setPlanMode: (plan) => {
    if (get().mode !== 'work') {
      // Study 模式不支持 Plan，强制 Build
      set({ planMode: false })
      return
    }
    set({ planMode: plan })
    get().pushToast(
      plan ? '已切换到 Plan 模式（只读，高风险操作将被拒绝）' : '已切换到 Build 模式',
      'info',
    )
  },

  clearChat: () =>
    set({
      currentChatSession: null,
      chatMessages: [],
      chatStreamingActive: false,
      chatStreamingText: '',
      chatStreamingRequestId: null,
      chatAsking: false,
      currentCheckpoint: null,
      pendingToolConfirmation: null,
    }),

  // ===== Task 9：chat WS 事件处理 =====

  handleChatToken: (event) => {
    const { content } = event
    if (!content) return
    // 累加流式文本
    const nextText = get().chatStreamingText + content
    set({ chatStreamingText: nextText })
    // 同步更新最后一条 assistant 占位消息的 content（打字机效果）
    const messages = get().chatMessages
    if (messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant') {
        const updated: ChatMessage = { ...last, content: nextText }
        set({
          chatMessages: [...messages.slice(0, -1), updated],
        })
      }
    }
  },

  handleChatToolCall: (event) => {
    const { tool, args, tool_call_id } = event
    const messages = get().chatMessages
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'assistant') return
    // 追加 pending tool_call 项
    const newCall: ToolCall = {
      id: tool_call_id || `${tool}-${Date.now()}`,
      tool,
      args,
      status: 'pending',
    }
    const toolCalls = [...(last.tool_calls ?? []), newCall]
    const updated: ChatMessage = { ...last, tool_calls: toolCalls }
    set({
      chatMessages: [...messages.slice(0, -1), updated],
    })
  },

  handleChatToolResult: (event) => {
    const { tool, result } = event
    const messages = get().chatMessages
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'assistant') return
    const toolCalls = (last.tool_calls ?? []).map((c) =>
      c.tool === tool && c.status === 'pending'
        ? { ...c, status: 'done' as const, result }
        : c,
    )
    const updated: ChatMessage = { ...last, tool_calls: toolCalls }
    set({
      chatMessages: [...messages.slice(0, -1), updated],
    })
  },

  handleChatToolConfirmation: (event) => {
    const { request_id, tool, args, timeout } = event
    const confirmation: ToolConfirmation = {
      request_id,
      tool,
      args,
      timeout,
      session_id: get().currentChatSession?.id,
    }
    set({ pendingToolConfirmation: confirmation })
    get().pushToast(
      `Agent 想执行高风险操作：${tool}，请确认`,
      'warning',
    )
  },

  handleChatThinking: (event) => {
    const { content } = event
    if (!content) return
    // 累积到最后一条 assistant 占位消息的 thinking 字段
    const messages = get().chatMessages
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'assistant') return
    const nextThinking = (last.thinking ?? '') + content
    const updated: ChatMessage = { ...last, thinking: nextThinking }
    set({
      chatMessages: [...messages.slice(0, -1), updated],
    })
  },

  handleChatContentReplace: (event) => {
    const { content } = event
    if (!content) return
    // 替换最后一条 assistant 消息的正文（后端剥离测验题内容后推送）
    const messages = get().chatMessages
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'assistant') return
    const updated: ChatMessage = { ...last, content }
    set({
      chatMessages: [...messages.slice(0, -1), updated],
      chatStreamingText: content,
    })
  },

  handleChatDone: (event) => {
    const { full_text } = event
    // 终结流式状态
    set({
      chatStreamingActive: false,
      chatAsking: false,
      chatStreamingText: '',
      chatStreamingRequestId: null,
    })
    // 用 full_text 兜底最后一条 assistant 消息
    const messages = get().chatMessages
    if (messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant' && full_text) {
        const updated: ChatMessage = { ...last, content: full_text }
        set({
          chatMessages: [...messages.slice(0, -1), updated],
        })
      }
    }
    // 异步刷新会话列表（updated_at 变更）+ checkpoint
    void get().loadChatSessions()
    void get().loadCheckpoint()
  },

  handleChatCancelled: (event) => {
    const { full_text } = event
    set({
      chatStreamingActive: false,
      chatAsking: false,
      chatStreamingText: '',
      chatStreamingRequestId: null,
    })
    const messages = get().chatMessages
    if (messages.length > 0 && full_text) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant') {
        const updated: ChatMessage = {
          ...last,
          content: full_text + '\n\n（已取消）',
        }
        set({
          chatMessages: [...messages.slice(0, -1), updated],
        })
      }
    }
    get().pushToast('已取消对话生成', 'info')
  },

  handleChatError: (event) => {
    const { message } = event
    set({
      chatStreamingActive: false,
      chatAsking: false,
      chatStreamingText: '',
      chatStreamingRequestId: null,
    })
    // 在最后一条 assistant 消息上标记失败
    const messages = get().chatMessages
    if (messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant') {
        const updated: ChatMessage = {
          ...last,
          content: last.content || `（回答失败：${message}）`,
        }
        set({
          chatMessages: [...messages.slice(0, -1), updated],
        })
      }
    }
    get().pushToast(`对话失败：${message}`, 'error')
  },
}))

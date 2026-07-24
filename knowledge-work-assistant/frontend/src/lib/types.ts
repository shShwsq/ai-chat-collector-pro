/**
 * 前端 TypeScript 类型定义。
 *
 * 与 backend/app/models/schemas.py 一一对应，作为前后端通信契约。
 * 当前为联调骨架，仅定义健康检查与 WebSocket 测试相关类型；
 * 后续业务路由（图谱 / 节点 / 测验等）上线时在此扩展。
 */

// ===== 通用 =====

export interface HealthResponse {
  /** 健康状态：固定为 "ok"。 */
  status: string
  /** 后端服务名：固定为 "knowledge-work-assistant-backend"。 */
  service: string
  /** 后端版本号（来自 app.__version__）。 */
  version: string
}

export interface ErrorResponse {
  error: string
  code: string
  detail?: string
}

// ===== WebSocket 测试事件（与 backend/app/routers/ws.py 协议对齐）=====

/**
 * 后端 WebSocket 推送的事件类型。
 *
 * 协议：
 * - 连接建立 → 推送 ``{ type: "welcome", message: "..." }``
 * - 收到 ``{ type: "ping" }`` → 回复 ``{ type: "pong" }``
 * - 收到其他 JSON → 回复 ``{ type: "echo", data: <原消息> }``
 */
export type WsEvent =
  | { type: 'welcome'; message: string }
  | { type: 'pong' }
  | { type: 'echo'; data: unknown }
  | { type: 'error'; message: string }

/** 客户端可发送的测试消息。 */
export type WsOutgoing =
  | { type: 'ping' }
  | { type: 'echo-test'; payload: string }
  | Record<string, unknown>

// ============================================================================
// 双模式与视图（Task 3）
// ============================================================================

/** 应用模式：study 学习模式 / work 工作模式。与后端 Graph.type 对齐。 */
export type Mode = 'study' | 'work'

/** 内容区视图类型：graph 图谱视图 / card 卡片视图（Task 5/6 填充）。 */
export type ViewType = 'graph' | 'card'

// ============================================================================
// 图谱相关类型（Task 4，与 backend/app/models/schemas.py 一一对应）
// ============================================================================

/** 知识图谱。 */
export interface Graph {
  id: string
  name: string
  /** 图谱模式，与 Mode 对齐。 */
  type: Mode
  created_at: string
  updated_at: string
}

/** 图谱节点（小卡片）。 */
export interface Node {
  id: string
  graph_id: string
  /** 节点子类型：Study 为学科枚举，Work 为工作对象枚举。 */
  type: string
  title: string
  summary: string
  /** 详情字段（按节点类型模板填充）。 */
  detail_payload: Record<string, unknown>
  is_gray: boolean
  /** 用户留白区：{ doubt/association/exam_point/error_point/note: string[] }。 */
  user_fill: Record<string, unknown>
  /** 来源：agent / user / plugin / extension。 */
  source: string
  confidence: number
  /** 最后复习时间（用户打开详情卡时更新）。 */
  last_reviewed_at?: string | null
  /** 复习次数。 */
  review_count?: number
  /** 被提及次数（Agent 抽取/延伸/提问命中时 +1）。 */
  mention_count?: number
  /** 提醒时间（Work 模式节点用）。 */
  remind_at?: string | null
  /** 星标（用户手动标记）。 */
  is_starred?: boolean
  created_at: string
  updated_at: string
}

/** 图谱无向边。 */
export interface Edge {
  id: string
  graph_id: string
  src_id: string
  dst_id: string
  /** 边关系语义：related / prerequisite / extends / belongs_to / ... */
  relation: string
  created_at: string
}

/** 图谱统计。 */
export interface GraphStats {
  node_count: number
  edge_count: number
  quiz_count: number
}

/** 完整图谱（含节点与边），供前端可视化一次性加载。 */
export interface FullGraph {
  graph: Graph
  nodes: Node[]
  edges: Edge[]
  stats: GraphStats
}

/** 创建图谱请求。 */
export interface GraphCreate {
  name: string
  type: Mode
}

/** 更新图谱请求（仅重命名）。 */
export interface GraphUpdate {
  name: string
}

/** 创建节点请求。 */
export interface NodeCreate {
  type: string
  title: string
  summary?: string
  detail_payload?: Record<string, unknown>
  is_gray?: boolean
  user_fill?: Record<string, unknown>
  source?: string
  confidence?: number
}

/** 更新节点请求（仅更新非 undefined 字段）。 */
export interface NodeUpdate {
  title?: string
  summary?: string
  detail_payload?: Record<string, unknown>
  is_gray?: boolean
  user_fill?: Record<string, unknown>
  type?: string
  confidence?: number
}

/** 创建边请求。 */
export interface EdgeCreate {
  src_id: string
  dst_id: string
  relation?: string
}

/** 删除操作响应。 */
export interface DeleteResult {
  deleted: boolean
  id: string
}

// ============================================================================
// 节点详情卡与用户留白（Task 7 / Task 9，与 backend/app/routers/nodes.py 对齐）
// ============================================================================

/** 延伸方向推荐项。 */
export interface ExtensionDirection {
  /** 延伸名称。 */
  name: string
  /** 为什么值得延伸。 */
  reason: string
}

/** 节点详情卡内容（由后端 generate_node_detail 生成或从 detail_payload 缓存读取）。 */
export interface NodeDetail {
  /** 一句话概括。 */
  summary: string
  /** 重要点 / 关键材料列表。 */
  important_points: string[]
  /** 延伸方向推荐列表。 */
  extension_directions: ExtensionDirection[]
  /** 模板字段内容（已剔除下划线前缀元数据键）。 */
  detail_fields: Record<string, unknown>
  /** 实际命中的模板标识（具体类型名或 "default"）。 */
  template_used: string
  /** LLM 推断出的更具体类型（可能与原 type 不同）。 */
  inferred_type: string
  /** 是否降级（LLM 不可用）。 */
  degraded: boolean
  /** 降级原因。 */
  degrade_reason?: string
  /** 是否命中缓存（未重新调用 LLM）。 */
  cached?: boolean
}

/** 生成节点详情响应：更新后的节点 + 详情。 */
export interface NodeDetailResponse {
  node: Node
  detail: NodeDetail
}

/** 追加用户留白请求。 */
export interface UserFillAppend {
  /** 留白类型：doubt/association/exam_point/error_point/note。 */
  fill_type: string
  /** 留白内容。 */
  content: string
}

// ============================================================================
// 节点延伸（Task 8，与 backend/app/routers/extensions.py 对齐）
// ============================================================================

/** 延伸模式：all=双击全部延伸（可撤销）；single=单击方向单点延伸。 */
export type ExtendMode = 'all' | 'single'

/** 延伸请求体。 */
export interface ExtendRequest {
  mode: ExtendMode
  /** mode=single 时指定的延伸方向名。 */
  direction_name?: string
}

/** 单个延伸节点结果（新建或已存在）。 */
export interface ExtendResultItem {
  node_id: string
  title: string
  summary: string
  type: string
  direction_name: string
  is_gray: boolean
  existing: boolean
}

/** 延伸响应。 */
export interface ExtendResponse {
  /** 本次新建的延伸节点列表。 */
  created: ExtendResultItem[]
  /** 命中已存在节点（不重复创建）的列表，前端高亮闪烁提示。 */
  existing: ExtendResultItem[]
  /** 本次延伸的批次 ID（仅 mode=all 且有新建时返回，用于撤销）。 */
  batch_id: string
  /** 同 batch_id，兼容字段名。 */
  revoked_batch_id: string
  /** 是否走 LLM 降级路径。 */
  degraded: boolean
  /** 本次延伸模式。 */
  mode: ExtendMode
}

/** 撤销延伸请求体。 */
export interface ExtendRevokeRequest {
  batch_id: string
}

/** 撤销延伸响应。 */
export interface ExtendRevokeResponse {
  deleted_nodes: number
  deleted_edges: number
  batch_id: string
}

// ============================================================================
// 观察记录与节点抽取（Task 11，与 backend/app/routers/extraction.py 对齐）
// ============================================================================

/** 观察记录（对话原文，待 Agent 抽取知识点）。 */
export interface Observation {
  id: string
  platform: string
  /** 对话发生时间，可为 null（插件 timestamp 解析失败时）。 */
  occurred_at: string | null
  conversation_markdown: string
  metadata: Record<string, unknown>
  source: string
  graph_id: string | null
  processed: boolean
  created_at: string
}

/** 抽取请求体。 */
export interface ExtractRequest {
  graph_id: string
}

/** 候选节点（Agent 抽取，待用户确认入图）。 */
export interface CandidateNode {
  title: string
  summary: string
  type: string
  detail_payload?: Record<string, unknown>
  confidence: number
  /** 抽取依据，供用户判断是否采纳。 */
  source_reason: string
}

/** 抽取响应。 */
export interface ExtractResponse {
  observation_id: string
  graph_id: string
  candidates: CandidateNode[]
  degraded: boolean
}

/** 批量创建节点请求体。 */
export interface BatchCreateNodesRequest {
  nodes: CandidateNode[]
  /** 可选：成功创建后标记该 observation 为已处理。 */
  observation_id?: string
}

/** 跳过项（已存在或创建失败）。 */
export interface SkippedItem {
  title: string
  existing_node_id?: string
  error?: string
}

/** 批量创建响应。 */
export interface BatchCreateNodesResponse {
  created: Node[]
  skipped: SkippedItem[]
  created_count: number
  skipped_count: number
  observation_processed: boolean
}

// ============================================================================
// 浏览器插件对接（Task 10）
// ============================================================================

/** 插件推送对话请求。 */
export interface PluginConversationRequest {
  platform: string
  /** ISO8601 字符串。 */
  timestamp: string
  conversation_markdown: string
  metadata?: Record<string, unknown>
}

/** 插件推送对话响应。 */
export interface PluginConversationResponse {
  received: boolean
  observation_id: string
}

// ============================================================================
// Study 测验（Task 12，与 backend/app/routers/quiz.py 对齐）
// ============================================================================

/** 测验题型：单选 / 多选 / 费曼解释题。 */
export type QuizType = 'single_choice' | 'multi_choice' | 'feynman'

/** 选择题选项。 */
export interface QuizOption {
  /** 选项 id：A / B / C / D。 */
  id: string
  /** 选项内容。 */
  text: string
}

/** 测验题目（与后端 Quiz 表对齐，payload 已剥离答案字段）。
 *
 * - 选择题：``payload.question`` / ``payload.options`` / ``payload.explanation``
 *   （``correct_answers`` 在服务端剥离，作答后由 answer 接口返回）。
 * - 费曼题：``payload.prompt``（``reference_points`` 在服务端剥离，作答后返回）。
 */
export interface Quiz {
  id: string
  graph_id: string
  /** 关联节点 ID，用于复盘。 */
  node_id: string
  type: QuizType
  /** 题目内容（已剥离答案字段）。 */
  payload: Record<string, unknown>
  /** 标准答案（选择题未作答时为空字符串，由服务端隔离避免泄题）。 */
  answer: string
  /** 作答结果（未作答为空对象）。 */
  result: Record<string, unknown>
  answered: boolean
  created_at: string
  answered_at: string | null
}

/** 生成测验请求体。 */
export interface QuizGenerateRequest {
  /** 限定题目涉及的节点 ID 列表；不传则从全图随机选取。 */
  node_ids?: string[]
  /** 题型。 */
  quiz_type: QuizType
  /** 题目数量，当前固定为 1。 */
  count?: number
}

/** 作答请求体。
 *
 * - 选择题：选项 id 数组，如 ``['A']`` 或 ``['A','C']``。
 * - 费曼题：用户解释文本。
 */
export interface QuizAnswerRequest {
  answer: string[] | string
}

/** 选择题作答判分结果。 */
export interface ChoiceGradeResult {
  quiz_id: string
  type: 'single_choice' | 'multi_choice'
  node_id: string
  /** 是否答对（多选题部分对算错，严格集合相等）。 */
  correct: boolean
  /** 用户答案（归一化为选项 id 数组）。 */
  user_answer: string[]
  /** 正确答案。 */
  correct_answers: string[]
  /** 答案解析。 */
  explanation: string
  /** 选项列表（作答后回显）。 */
  options: QuizOption[]
  /** 是否走降级路径（题目本身是降级占位题）。 */
  degraded: boolean
  /** 落库的完整 result。 */
  result: Record<string, unknown>
}

/** 费曼题判分结果。 */
export interface FeynmanGradeResult {
  quiz_id: string
  type: 'feynman'
  node_id: string
  /** 0-100 评分。 */
  score: number
  /** 理解度等级：good / partial / poor。 */
  understanding_level: 'good' | 'partial' | 'poor'
  /** 反馈文本。 */
  feedback: string
  /** 未覆盖的参考要点。 */
  missed_points: string[]
  /** 参考要点（作答后回显）。 */
  reference_points: string[]
  /** 题目提示语。 */
  prompt: string
  /** 是否走降级路径（LLM 不可用时基于关键词覆盖率判分）。 */
  degraded: boolean
  degrade_reason?: string
  /** 落库的完整 result。 */
  result: Record<string, unknown>
}

/** 作答判分结果（选择题或费曼题）。 */
export type QuizGradeResult = ChoiceGradeResult | FeynmanGradeResult

// ============================================================================
// Work 模式业务（Task 13 / 14 / 15 / 16，与 backend/app/routers/work.py 对齐）
// ============================================================================

/** 工作对象关系（confirm 时携带）。 */
export interface WorkRelation {
  /** 关系目标对象标题。 */
  to_title: string
  /** 关系语义：related/belongs_to/involves/committed_to/depends_on/
   *  waiting_for/influences/source_of/alternative_to。 */
  relation: string
}

/** 候选工作对象（extract 抽取，待用户确认入图）。 */
export interface CandidateWorkObject {
  title: string
  summary: string
  /** 工作对象子类型：thread/key_person/commitment/expectation/event/
   *  decision/risk/material/preference/review。 */
  type: string
  /** 与其他对象的关系数组。 */
  relations: WorkRelation[]
}

/** 抽取工作对象请求体。 */
export interface WorkExtractRequest {
  text: string
}

/** 抽取工作对象响应。 */
export interface WorkExtractResponse {
  graph_id: string
  objects: CandidateWorkObject[]
  degraded: boolean
}

/** 批量确认入图请求体。 */
export interface WorkConfirmRequest {
  objects: CandidateWorkObject[]
}

/** 批量确认入图响应。 */
export interface WorkConfirmResponse {
  /** 新建节点列表。 */
  created: Node[]
  /** 跳过项（已存在或创建失败）。 */
  skipped: { title: string; existing_node_id?: string; error?: string }[]
  /** 建立的关系边数量。 */
  edges_created: number
  created_count: number
  skipped_count: number
}

/** 单个风口推荐。 */
export interface Trend {
  title: string
  /** 为何认为这是风口（结合图谱内容的可解释理由）。 */
  reason: string
  /** 与用户工作的相关度：high/medium/low。 */
  relevance: 'high' | 'medium' | 'low'
  /** 建议行动数组（2-4 个具体动作）。 */
  suggested_actions: string[]
}

/** 风口推荐响应。 */
export interface TrendsResponse {
  trends: Trend[]
  degraded: boolean
  cached: boolean
}

/** 风口加入图谱响应。 */
export interface TrendAddResponse {
  node: Node
  trend_title: string
}

/** 报告周期：weekly 周报 / monthly 月报。 */
export type ReportPeriod = 'weekly' | 'monthly'

/** 工作报告生成请求体。 */
export interface ReportRequest {
  period: ReportPeriod
}

/** 工作报告生成响应。 */
export interface ReportResponse {
  /** 完整 Markdown 报告文本。 */
  markdown: string
  /** 结构化分段：progress/plan/risks/commitments。 */
  sections: {
    progress: string[]
    plan: string[]
    risks: string[]
    commitments: string[]
  }
  period: string
  degraded: boolean
  degrade_reason: string
}

/** 用户提问请求体。 */
export interface WorkAskRequest {
  question: string
}

/** 问答来源引用（标注答案出处）。 */
export interface AskSource {
  /** 来源节点标题。 */
  node_title: string
  /** 相关度：high/medium/low。 */
  relevance: 'high' | 'medium' | 'low'
}

/** 用户提问响应。 */
export interface WorkAskResponse {
  /** Agent 回答文本。 */
  answer: string
  /** 引用来源数组（标注答案基于哪些节点）。 */
  sources: AskSource[]
  /** 置信度 0.0-1.0。 */
  confidence: number
  degraded: boolean
  degrade_reason: string
}

// ============================================================================
// LLM 配置与请求队列（设置面板用，与 backend/app/routers/llm_admin.py 协议对齐）
// ============================================================================

/** LLM 请求状态：queued 排队 / running 进行中 / completed 完成 / cancelled 取消 / failed 失败。 */
export type LlmRequestStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** 单个 LLM 请求的元信息（来自 LlmRequestRegistry）。 */
export interface LlmRequestInfo {
  /** 请求唯一标识（16 位十六进制）。 */
  id: string
  /** 调用用途标签，如 generate_node_detail / extend_node / generate_quiz 等。 */
  purpose: string
  /** 请求当前状态。 */
  status: LlmRequestStatus
  /** 注册时的时间戳（Unix 秒）。 */
  started_at: number
  /** 关联节点 ID（可选）。 */
  node_id?: string | null
  /** 关联图谱 ID（可选）。 */
  graph_id?: string | null
  /** 进入终态时的时间戳；活跃请求为 null。 */
  completed_at?: number | null
  /** failed 状态下的错误消息。 */
  error?: string | null
  /** 附加展示元数据（如 model / 节点标题）。 */
  meta?: Record<string, unknown>
}

/** LLM 配置读取响应（敏感字段已掩码）。 */
export interface LlmConfig {
  /** LLM 服务基地址（如 https://api.openai.com/v1）。 */
  base_url: string
  /** 默认模型名。 */
  model: string
  /** API Key 掩码字符串（如 sk-****-1234），仅展示用。 */
  api_key_masked: string
  /** 是否就绪（key 与 base_url 均已配置）。 */
  ready?: boolean
}

/** LLM 配置更新请求体（仅传需更新的字段）。 */
export interface LlmConfigUpdate {
  /** 新的 LLM 服务基地址。 */
  base_url?: string
  /** 新的默认模型名。 */
  model?: string
  /** 新的 API Key（明文，由后端加密存储；不传则保持原值）。 */
  api_key?: string
}

/** 取消 LLM 请求响应。 */
export interface LlmCancelResponse {
  /** 是否取消成功（请求不存在或已终态时返回 false）。 */
  cancelled: boolean
  /** 被取消的请求 id（失败时为空字符串）。 */
  id: string
}

/** LLM 配置更新响应。 */
export interface LlmConfigUpdateResponse {
  /** 是否更新成功。 */
  updated: boolean
  /** 更新后的配置快照（掩码后的 api_key）。 */
  config: LlmConfig
  /** 提示信息（如建议重启后端）。 */
  message?: string
}

// ============================================================================
// 推荐 / touch / remind / star（与 backend/app/routers/recommendations.py 等对齐）
// ============================================================================

/** 单条推荐项（含完整节点对象与推荐统计指标）。 */
export interface RecommendationItem {
  /** 推荐对应的完整节点对象。 */
  node: Node
  /** 推荐分 0-100。 */
  score: number
  /** 推荐理由（可解释文本）。 */
  reason: string
  /** 是否到期（work 模式：remind_at 已过）。 */
  is_overdue: boolean
  /** 是否临近（work 模式：remind_at 临近当前时间）。 */
  is_upcoming: boolean
  /** 错误率 0-1（study 模式：该节点关联测验的错误比例）。 */
  error_rate: number
  /** 距上次复习天数（study 模式：未复习过为 null）。 */
  days_since_review: number | null
}

/** 推荐列表响应。 */
export interface RecommendationsResponse {
  /** 推荐项数组（按 score 倒序）。 */
  items: RecommendationItem[]
  /** 总数（与 items.length 通常一致）。 */
  total: number
}

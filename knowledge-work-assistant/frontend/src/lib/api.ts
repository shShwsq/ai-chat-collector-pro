/**
 * 统一 HTTP 客户端。
 *
 * - 自动在路径前拼接 /api 前缀；
 * - 在 Electron file:// 环境下通过 preload 桥获取后端地址
 *   （生产环境 http://127.0.0.1:8788，由 launcher 启动）；
 * - 在 Vite dev 环境下使用相对路径（由 vite.config.ts 代理转发）；
 * - 统一 JSON 解析与错误抛出（ApiError）。
 *
 * 与 backend/app/routers/{health,graphs,plugin,extraction,extensions,quiz}.py 的路由一一对应：
 * - 健康检查：GET /api/health
 * - 图谱管理（Task 4）：/api/graphs、/api/graphs/{id}/nodes|edges
 * - 浏览器插件对接（Task 10）：/api/plugin/conversations、/api/plugin/contract
 * - Study 测验（Task 12）：/api/graphs/{id}/quiz[/generate|/{qid}/answer|/{qid}]
 */

import type {
  BatchCreateNodesRequest,
  BatchCreateNodesResponse,
  CancelChatResponse,
  ChatCheckpoint,
  ClearResult,
  ChatMessage,
  ChatSession,
  ChatStreamStartedResponse,
  ConfirmToolCallRequest,
  ConfirmToolCallResponse,
  CreateChatSessionRequest,
  DeleteChatSessionResponse,
  DeleteResult,
  Edge,
  EdgeCreate,
  ExtendMode,
  ExtendRequest,
  ExtendResponse,
  ExtendRevokeResponse,
  ExtractRequest,
  ExtractResponse,
  FullGraph,
  Graph,
  GraphCreate,
  GraphStats,
  GraphUpdate,
  HealthResponse,
  ListChatMessagesResponse,
  ListChatSessionsResponse,
  ChatSearchResponse,
  UpdateChatSessionRequest,
  LlmCancelResponse,
  LlmConfig,
  LlmConfigUpdate,
  LlmConfigUpdateResponse,
  LlmRequestInfo,
  LlmTestConnectionRequest,
  LlmTestConnectionResponse,
  Mode,
  Node,
  NodeCreate,
  NodeDetailResponse,
  NodeUpdate,
  ObservationListResponse,
  PluginBatchImportRequest,
  PluginBatchImportResponse,
  PluginConversationRequest,
  PluginConversationResponse,
  PluginHealthResponse,
  PluginRecentConversationsResponse,
  Quiz,
  QuizAnswerRequest,
  QuizGenerateRequest,
  QuizGradeResult,
  RecommendationsResponse,
  ReportRequest,
  ReportResponse,
  StartChatStreamRequest,
  StreamStartedResponse,
  TrendAddResponse,
  TrendsResponse,
  TriggerCheckpointResponse,
  UserFillAppend,
  WorkAskRequest,
  WorkAskResponse,
  WorkConfirmRequest,
  WorkConfirmResponse,
  WorkExtractRequest,
  WorkExtractResponse,
  WsTokenResponse,
} from './types'

const FILE_PROTOCOL = 'file:'
// 兜底地址：preload 桥不可用时（纯浏览器 / electronAPI 未注入）使用。
// 后端默认监听 8788 端口（见 backend/app/main.py）。
const FALLBACK_BACKEND_ORIGIN = 'http://127.0.0.1:8788'

/** 解析 HTTP 基地址：dev 用相对路径走 Vite 代理；file:// 直连后端。 */
function httpBase(): string {
  if (typeof window !== 'undefined' && window.location.protocol === FILE_PROTOCOL) {
    // 生产环境（file://）：优先通过 preload 桥获取后端地址
    return window.electronAPI?.backend?.getUrl() ?? FALLBACK_BACKEND_ORIGIN
  }
  return ''
}

/** 统一错误类型。 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly detail?: string

  constructor(message: string, code: string, status: number, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** 底层 fetch 封装：统一加 /api 前缀、JSON 处理与错误抛出。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${httpBase()}/api${path}`

  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  }
  const body = init?.body
  if (body !== undefined && !(body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (e) {
    // AbortError 透传，让调用方区分「用户取消」与「真实网络错误」
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(
      (e as Error).message || '网络请求失败',
      'network_error',
      0,
    )
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const err = data as { error?: string; code?: string; detail?: string } | null
    throw new ApiError(
      err?.error ?? `HTTP ${res.status}`,
      err?.code ?? 'http_error',
      res.status,
      err?.detail,
    )
  }

  return data as T
}

/** 拼接查询字符串（跳过空值）。 */
function withQuery(base: string, params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, v)
  }
  const qs = usp.toString()
  return qs ? `${base}?${qs}` : base
}

/** 类型化 API 方法集合。 */
export const api = {
  // ===== 健康检查 =====
  getHealth: () => request<HealthResponse>('/health'),

  // ===== 鉴权 =====
  /** 获取 WebSocket 短期 token(15 分钟有效),用于 WS 握手鉴权。 */
  getWsToken: () => request<WsTokenResponse>('/auth/ws-token'),

  // ===== 图谱管理（Task 4）=====
  /** 列出图谱，可选按模式过滤（study/work 隔离）。 */
  getGraphs: (mode?: Mode) =>
    request<Graph[]>(withQuery('/graphs', mode ? { mode } : {})),
  /** 创建图谱。 */
  createGraph: (body: GraphCreate) =>
    request<Graph>('/graphs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 获取单个图谱。 */
  getGraph: (id: string) => request<Graph>(`/graphs/${id}`),
  /** 获取完整图谱（含 nodes/edges/stats）。 */
  getFullGraph: (id: string) => request<FullGraph>(`/graphs/${id}/full`),
  /** 重命名图谱。 */
  renameGraph: (id: string, name: string) =>
    request<Graph>(`/graphs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name } satisfies GraphUpdate),
    }),
  /** 删除图谱（级联清理）。 */
  deleteGraph: (id: string) =>
    request<DeleteResult>(`/graphs/${id}`, { method: 'DELETE' }),
  /** 获取图谱统计。 */
  getGraphStats: (id: string) => request<GraphStats>(`/graphs/${id}/stats`),

  // ===== 节点 CRUD =====
  /** 在图谱下创建节点。 */
  createNode: (graphId: string, body: NodeCreate) =>
    request<Node>(`/graphs/${graphId}/nodes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 列出图谱下的节点，可按 type 过滤。 */
  listNodes: (graphId: string, type?: string) =>
    request<Node[]>(withQuery(`/graphs/${graphId}/nodes`, type ? { type } : {})),
  /** 更新节点字段（仅更新非 undefined 字段）。 */
  updateNode: (graphId: string, nodeId: string, body: NodeUpdate) =>
    request<Node>(`/graphs/${graphId}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** 删除节点（级联清理相关边与测验）。 */
  deleteNode: (graphId: string, nodeId: string) =>
    request<DeleteResult>(`/graphs/${graphId}/nodes/${nodeId}`, {
      method: 'DELETE',
    }),
  /** 生成（或复用缓存）节点详情卡内容，更新 detail_payload 并返回详情。 */
  generateNodeDetail: (graphId: string, nodeId: string) =>
    request<NodeDetailResponse>(
      `/graphs/${graphId}/nodes/${nodeId}/detail`,
      { method: 'POST' },
    ),
  /** 向节点 user_fill 追加一条内容（疑问/联想/考点/易错点/笔记）。 */
  appendUserFill: (graphId: string, nodeId: string, body: UserFillAppend) =>
    request<Node>(`/graphs/${graphId}/nodes/${nodeId}/user-fill`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== 节点延伸（Task 8）=====
  /**
   * 基于源节点生成延伸节点。
   * - mode="all"：双击节点触发的全部延伸（灰色新节点 + extends 边），返回
   *   batch_id 供撤销；existing 列表为命中已存在节点（不重复创建）。
   * - mode="single"：单击方向触发的单点延伸，仅生成指定 direction_name。
   */
  extendNode: (
    graphId: string,
    nodeId: string,
    mode: ExtendMode,
    directionName?: string,
  ) =>
    request<ExtendResponse>(
      `/graphs/${graphId}/nodes/${nodeId}/extend`,
      {
        method: 'POST',
        body: JSON.stringify({
          mode,
          direction_name: directionName,
        } satisfies ExtendRequest),
      },
    ),
  /** 撤销上一次全部延伸（删除该批新节点与边）。 */
  revokeExtend: (graphId: string, nodeId: string, batchId: string) =>
    request<ExtendRevokeResponse>(
      `/graphs/${graphId}/nodes/${nodeId}/extend-revoke`,
      {
        method: 'POST',
        body: JSON.stringify({ batch_id: batchId }),
      },
    ),

  // ===== 边 CRUD =====
  /** 在图谱下创建无向边（同两端同关系幂等）。 */
  createEdge: (graphId: string, body: EdgeCreate) =>
    request<Edge>(`/graphs/${graphId}/edges`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 列出图谱下的全部边。 */
  listEdges: (graphId: string) => request<Edge[]>(`/graphs/${graphId}/edges`),
  /** 删除边。 */
  deleteEdge: (graphId: string, edgeId: string) =>
    request<DeleteResult>(`/graphs/${graphId}/edges/${edgeId}`, {
      method: 'DELETE',
    }),

  // ===== 浏览器插件对接（Task 10）=====
  /** 推送插件采集的对话，后端持久化为 Observation。 */
  pushPluginConversation: (body: PluginConversationRequest) =>
    request<PluginConversationResponse>('/plugin/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 批量导入对话（手动导入功能）：单事务批量落库 + FTS 批量回填。 */
  pushPluginConversationsBatch: (body: PluginBatchImportRequest) =>
    request<PluginBatchImportResponse>('/plugin/conversations/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 获取插件对接接口契约说明。 */
  getPluginContract: () =>
    request<Record<string, unknown>>('/plugin/contract'),
  /** 插件对接健康检查：返回版本、支持平台、当前队列长度。 */
  getPluginHealth: () => request<PluginHealthResponse>('/plugin/health'),
  /** 拉取最近推送的对话记录（默认 20 条，按创建时间倒序）。 */
  getPluginRecent: (limit: number = 20) =>
    request<PluginRecentConversationsResponse>(
      withQuery('/plugin/conversations/recent', { limit: String(limit) }),
    ),

  // ===== Study 对话抽取（Task 11）=====
  /** 列出观察记录，可按处理状态过滤（默认前端调用时传 processed=false）。 */
  listObservations: (params?: {
    processed?: boolean
    source?: string
    graphId?: string
    limit?: number
    offset?: number
  }) => {
    const q: Record<string, string> = {}
    if (params?.processed !== undefined) {
      q.processed = String(params.processed)
    }
    if (params?.source) q.source = params.source
    if (params?.graphId) q.graph_id = params.graphId
    if (params?.limit !== undefined) q.limit = String(params.limit)
    if (params?.offset !== undefined) q.offset = String(params.offset)
    return request<ObservationListResponse>(withQuery('/observations', q))
  },
  /** 从一条 Observation 抽取候选节点（不入图，返回待确认列表）。
   *  支持传入 AbortSignal 以实现超时取消。 */
  extractNodes: (
    observationId: string,
    graphId: string,
    init?: { signal?: AbortSignal },
  ) =>
    request<ExtractResponse>(`/observations/${observationId}/extract`, {
      method: 'POST',
      body: JSON.stringify({ graph_id: graphId } satisfies ExtractRequest),
      signal: init?.signal,
    }),
  /** 批量创建已确认节点（归一去重，相似标题跳过）。 */
  batchCreateNodes: (
    graphId: string,
    body: BatchCreateNodesRequest,
  ) =>
    request<BatchCreateNodesResponse>(`/graphs/${graphId}/nodes/batch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 一步抽取并直接入图（简化流程）。 */
  extractAndConfirm: (observationId: string, graphId: string) =>
    request<BatchCreateNodesResponse>(
      `/observations/${observationId}/extract-and-confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ graph_id: graphId } satisfies ExtractRequest),
      },
    ),

  // ===== Study 测验（Task 12）=====
  /**
   * 生成一道测验题并持久化。
   * - 选择题：``payload`` 含 question/options/explanation（correct_answers 由服务端隔离，作答后回显）。
   * - 费曼题：``payload`` 含 prompt（reference_points 由服务端隔离，作答后回显）。
   * - LLM 不可用时返回 ``degraded=true`` 占位题，前端据此提示。
   */
  generateQuiz: (graphId: string, body: QuizGenerateRequest) =>
    request<Quiz>(`/graphs/${graphId}/quiz/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 作答并判分。
   * - 选择题：本地对比 correct_answers，返回 ChoiceGradeResult（含正确答案与解析）。
   * - 费曼题：调用 Agent 语义判分，返回 FeynmanGradeResult（含理解度评分与反馈）。
   */
  answerQuiz: (
    graphId: string,
    quizId: string,
    body: QuizAnswerRequest,
  ) =>
    request<QuizGradeResult>(
      `/graphs/${graphId}/quiz/${quizId}/answer`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  /** 列出该图谱的测验历史，按创建时间倒序。可按作答状态过滤。 */
  listQuizzes: (graphId: string, answered?: boolean) =>
    request<Quiz[]>(
      withQuery(`/graphs/${graphId}/quiz`, {
        answered: answered === undefined ? undefined : String(answered),
      }),
    ),
  /** 获取单题详情（payload 已剥离答案字段，避免泄题）。 */
  getQuiz: (graphId: string, quizId: string) =>
    request<Quiz>(`/graphs/${graphId}/quiz/${quizId}`),

  // ===== Work 模式业务（Task 13 / 14 / 15 / 16）=====
  /**
   * 从用户输入文本抽取候选工作对象（不入图，返回带关系信息的候选列表）。
   * LLM 不可用时返回空列表 + degraded=true，前端显示降级提示。
   */
  extractWorkObjects: (graphId: string, text: string) =>
    request<WorkExtractResponse>(`/graphs/${graphId}/work/extract`, {
      method: 'POST',
      body: JSON.stringify({ text } satisfies WorkExtractRequest),
    }),
  /**
   * 批量确认工作对象入图（归一去重 + 按 relation 建立边）。
   * 返回 created/skipped/edges_created 等统计信息。
   */
  confirmWorkObjects: (graphId: string, body: WorkConfirmRequest) =>
    request<WorkConfirmResponse>(`/graphs/${graphId}/work/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 基于当前 work 图谱生成行业风口推荐。
   * 返回 [{title, reason, relevance, suggested_actions}] 列表。
   */
  generateTrends: (graphId: string) =>
    request<TrendsResponse>(`/graphs/${graphId}/work/trends`, {
      method: 'POST',
    }),
  /**
   * 把指定风口转为图谱节点（复用工作线索类型）。
   * 若缓存中无对应 index，后端会重新生成后再取回。
   */
  addTrendToGraph: (graphId: string, index: number) =>
    request<TrendAddResponse>(
      `/graphs/${graphId}/work/trends/${index}/add-to-graph`,
      { method: 'POST' },
    ),
  /**
   * 生成结构化工作报告（Markdown + sections）。
   * period=weekly 周报 / monthly 月报。
   */
  generateReport: (graphId: string, body: ReportRequest) =>
    request<ReportResponse>(`/graphs/${graphId}/work/report`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 把工作报告导出为 .docx 文件流并触发浏览器下载。
   * 后端用 python-docx 生成，文件名按周期 + 时间戳。
   */
  exportReportDocx: async (graphId: string, period: ReportRequest['period']) => {
    const url = `${httpBase()}/api/graphs/${graphId}/work/report/export-docx`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period } satisfies ReportRequest),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(
        `导出失败：HTTP ${res.status}`,
        'http_error',
        res.status,
        text,
      )
    }
    // 从响应头解析文件名（支持 RFC5987 filename*=UTF-8''xxx）
    const disp = res.headers.get('Content-Disposition') ?? ''
    let filename = `work_${period}.docx`
    const m1 = /filename\*=UTF-8''([^;]+)/i.exec(disp)
    if (m1?.[1]) {
      try {
        filename = decodeURIComponent(m1[1])
      } catch {
        filename = m1[1]
      }
    } else {
      const m2 = /filename="?([^";]+)"?/i.exec(disp)
      if (m2?.[1]) filename = m2[1]
    }
    const blob = await res.blob()
    // 触发浏览器下载
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
    return { ok: true, filename }
  },
  /**
   * 基于工作图谱上下文回答用户提问，标注来源与置信度。
   * LLM 不可用时返回兜底回答 + degraded=true。
   */
  askWorkQuestion: (graphId: string, body: WorkAskRequest) =>
    request<WorkAskResponse>(`/graphs/${graphId}/work/ask`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== 推荐 / touch / remind / star =====
  /**
   * 拉取图谱推荐列表。
   * - mode=study：按错误率与距上次复习天数排序的复习推荐；
   * - mode=work：按到期 / 临近状态排序的提醒推荐。
   * limit 默认 20。
   */
  getRecommendations: (
    graphId: string,
    mode: 'study' | 'work',
    limit?: number,
  ) =>
    request<RecommendationsResponse>(
      `/graphs/${graphId}/recommendations?mode=${mode}&limit=${limit ?? 20}`,
    ),
  /** 触发节点 touch（如打开详情卡），刷新 last_reviewed_at / review_count。 */
  touchNode: (id: string) =>
    request<Node>(`/nodes/${id}/touch`, { method: 'POST' }),
  /** 设置节点提醒时间（work 模式用），返回更新后的节点。 */
  setRemind: (id: string, remindAt: string) =>
    request<Node>(`/nodes/${id}/remind`, {
      method: 'POST',
      body: JSON.stringify({ remind_at: remindAt }),
    }),
  /** 清除节点提醒，返回更新后的节点。 */
  clearRemind: (id: string) =>
    request<Node>(`/nodes/${id}/remind`, { method: 'DELETE' }),
  /**
   * 设置 / 取消节点星标。
   * - starred=true：POST /nodes/{id}/star 标记星标；
   * - starred=false：DELETE /nodes/{id}/star 取消星标。
   */
  setStar: (id: string, starred: boolean) =>
    request<Node>(`/nodes/${id}/star`, {
      method: starred ? 'POST' : 'DELETE',
    }),

  // ===== LLM 配置与请求队列（设置面板用）=====
  /**
   * 列出当前活跃的 LLM 请求（status=queued/running）。
   * 后端实际返回 { requests: [...], count: int } 包装结构，此处解包为纯数组；
   * 兜底处理非预期结构，确保始终返回数组，避免组件 .filter / .map 抛错导致白屏。
   */
  getLlmRequests: async () => {
    const resp = await request<{
      requests?: LlmRequestInfo[]
      count?: number
    }>('/llm/requests')
    return resp?.requests ?? []
  },
  /**
   * 取消指定 LLM 请求（仅对 queued / running 生效；已终态返回 cancelled=false）。
   * 流式调用在下一个 chunk 边界由客户端主动中断，非流式调用仅作软标记。
   */
  cancelLlmRequest: (id: string) =>
    request<LlmCancelResponse>(`/llm/requests/${id}/cancel`, {
      method: 'POST',
    }),
  /** 读取当前 LLM 配置（api_key 已掩码，仅展示用）。 */
  getLlmConfig: () => request<LlmConfig>('/llm/config'),
  /**
   * 更新 LLM 配置（仅传需更新字段）。
   * 后端会持久化到 .env / DB settings，但生效通常需重启或热重载。
   * 返回更新后的配置快照 + 提示消息。
   */
  updateLlmConfig: (body: LlmConfigUpdate) =>
    request<LlmConfigUpdateResponse>('/llm/config', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * 测试 LLM 连接是否可用。
   * 请求体字段均可选，未传则用后端已保存配置；用于保存前验证配置正确性。
   * 后端发送一条极简 ping 消息，返回 ok/latency_ms/message。
   * 该端点不抛 HTTP 异常，所有错误通过 ok=false 返回。
   */
  testLlmConnection: (body: LlmTestConnectionRequest) =>
    request<LlmTestConnectionResponse>('/llm/test-connection', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== 流式触发（与 backend/app/routers/stream.py 对齐）=====
  /**
   * 触发节点详情卡流式生成。
   * 后台异步调用 GraphAgent.generate_node_detail_stream，逐 token 通过
   * WebSocket 推送至 session_id 对应的前端连接。
   * 前端监听 graph_agent_token / graph_agent_done / graph_agent_error 事件。
   */
  streamNodeDetail: (graphId: string, nodeId: string, sessionId: string) =>
    request<StreamStartedResponse>(
      `/graphs/${graphId}/nodes/${nodeId}/detail-stream`,
      {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId }),
      },
    ),
  /**
   * 触发 Work 问答流式生成。
   * 后台异步调用 GraphAgent.answer_question_stream，逐 token 推送。
   */
  streamAskQuestion: (
    graphId: string,
    question: string,
    sessionId: string,
  ) =>
    request<StreamStartedResponse>(
      `/graphs/${graphId}/work/ask-stream`,
      {
        method: 'POST',
        body: JSON.stringify({ question, session_id: sessionId }),
      },
    ),
  /**
   * 触发工作报告流式生成。
   * 后台异步调用 GraphAgent.generate_report_stream，逐 token 推送。
   */
  streamGenerateReport: (
    graphId: string,
    period: ReportRequest['period'],
    sessionId: string,
  ) =>
    request<StreamStartedResponse>(
      `/graphs/${graphId}/work/report-stream`,
      {
        method: 'POST',
        body: JSON.stringify({ period, session_id: sessionId }),
      },
    ),

  // ===== 多轮对话 chat（Task 9，与 backend/app/routers/chat.py 对齐）=====
  /**
   * 创建 chat 会话。
   * 写入 sessions 表（含 mode / graph_id 字段），返回会话快照。
   */
  createChatSession: (body: CreateChatSessionRequest) =>
    request<ChatSession>('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 更新会话字段（目前仅支持 title 重命名）。
   * 字段全部可选，未传字段保持原值。返回更新后的会话快照。
   */
  updateChatSession: (
    sessionId: string,
    body: UpdateChatSessionRequest,
  ): Promise<ChatSession> =>
    request<ChatSession>(`/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /**
   * 删除会话（后端级联清理 messages / checkpoints）。
   * 幂等：删除已不存在的会话也返回 ok=true。
   */
  deleteChatSession: (sessionId: string): Promise<DeleteChatSessionResponse> =>
    request<DeleteChatSessionResponse>(`/chat/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  /**
   * 列出 chat 会话（按 created_at 倒序，可按 mode / graph_id 过滤）。
   * 后端返回 { sessions: [...], count } 包装结构。
   */
  listChatSessions: async (
    mode?: Mode,
    graphId?: string,
    limit?: number,
  ): Promise<ChatSession[]> => {
    const params = new URLSearchParams()
    if (mode) params.set('mode', mode)
    if (graphId) params.set('graph_id', graphId)
    if (limit !== undefined) params.set('limit', String(limit))
    const qs = params.toString()
    const url = qs ? `/chat/sessions?${qs}` : '/chat/sessions'
    const resp = await request<ListChatSessionsResponse>(url)
    return resp?.sessions ?? []
  },
  /**
   * 全文搜索会话消息内容。
   * 后端跨会话搜索 message.content，返回命中的会话列表（每个会话附带
   * 最多 limit_per_session 条命中消息片段）。结果按会话 updated_at 倒序。
   */
  searchChatMessages: async (
    q: string,
    options?: {
      mode?: Mode
      graphId?: string
      limit?: number
      limitPerSession?: number
    },
  ): Promise<ChatSearchResponse> => {
    const params = new URLSearchParams({ q })
    if (options?.mode) params.set('mode', options.mode)
    if (options?.graphId) params.set('graph_id', options.graphId)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.limitPerSession !== undefined) {
      params.set('limit_per_session', String(options.limitPerSession))
    }
    return request<ChatSearchResponse>(`/chat/search?${params.toString()}`)
  },
  /**
   * 获取会话消息历史（按 created_at 升序）。
   * 后端返回 { messages: [...], count } 包装结构，此处解包为纯数组。
   */
  getChatMessages: async (sessionId: string): Promise<ChatMessage[]> => {
    const resp = await request<ListChatMessagesResponse>(
      `/chat/sessions/${sessionId}/messages`,
    )
    return resp?.messages ?? []
  },
  /**
   * 触发流式对话。
   * HTTP 立即返回 request_id，后台异步跑 main_agent.chat_stream，
   * 逐 token 通过 WS 推送至 session_id 对应的前端连接（op="chat"）。
   */
  startChatStream: (sessionId: string, body: StartChatStreamRequest) =>
    request<ChatStreamStartedResponse>(`/chat/sessions/${sessionId}/stream`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 取消流式对话。
   * 标记 LLM 请求为 cancelled，并触发 MainAgent.cancel() 让流式循环
   * 在下一个 chunk 边界主动中断，最终推送 graph_agent_cancelled 事件。
   */
  cancelChatStream: (requestId: string) =>
    request<CancelChatResponse>(`/chat/requests/${requestId}/cancel`, {
      method: 'POST',
    }),
  /**
   * 确认高风险工具调用。
   * 唤醒 main_agent.request_tool_confirmation 暂停的工具循环：
   * - approved=true：执行工具，结果回填给 agent 继续；
   * - approved=false：把拒绝原因作为工具结果回填，agent 据此调整后续对话。
   */
  confirmChatToolCall: (requestId: string, body: ConfirmToolCallRequest) =>
    request<ConfirmToolCallResponse>(`/chat/requests/${requestId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * 手动触发 writer_agent 生成 checkpoint。
   * 通常由 context_manager 在阈值触发时自动派发；此端点供用户主动触发。
   */
  triggerChatCheckpoint: (sessionId: string) =>
    request<TriggerCheckpointResponse>(
      `/chat/sessions/${sessionId}/checkpoint`,
      { method: 'POST' },
    ),
  /**
   * 获取会话最新 checkpoint 内容（11 字段结构化数据）。
   * 无 checkpoint 时返回 has_checkpoint=false。
   */
  getChatCheckpoint: (sessionId: string) =>
    request<ChatCheckpoint>(`/chat/sessions/${sessionId}/checkpoint`),

  // ===== 数据管理（设置面板「数据管理 / Danger Zone」用）=====
  /**
   * 批量清空 chat 会话（级联清理 messages / checkpoints）。
   * mode 省略=清空全部，study/work 仅清该模式。幂等。
   */
  clearChatSessions: (mode?: Mode) =>
    request<ClearResult>(withQuery('/chat/sessions/clear', mode ? { mode } : {}), {
      method: 'POST',
    }),
  /**
   * 批量清空图谱（级联清理各图谱下 nodes / edges / quizzes）。
   * mode 省略=清空全部，study/work 仅清该模式。observations 不会被删除
   *（其 graph_id 被 SET NULL 解绑）；需一并清空请额外调 clearObservations。
   */
  clearGraphs: (mode?: Mode) =>
    request<ClearResult>(withQuery('/graphs/clear', mode ? { mode } : {}), {
      method: 'POST',
    }),
  /**
   * 批量清空观察记录（observations 不区分模式，按 source 过滤）。
   * source 省略=清空全部。
   */
  clearObservations: (source?: string) =>
    request<ClearResult>(
      withQuery('/observations/clear', source ? { source } : {}),
      { method: 'POST' },
    ),
  /**
   * 导出全部数据为 JSON 备份文件并触发浏览器下载。
   * mode 仅过滤 sessions/graphs 及其级联子表；observations 始终全量导出。
   * 复用 exportReportDocx 的 blob 下载模式（fetch → blob → anchor）。
   */
  exportData: async (mode?: Mode) => {
    const url = `${httpBase()}/api/data/export${mode ? `?mode=${mode}` : ''}`
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ApiError(
        `导出失败：HTTP ${res.status}`,
        'http_error',
        res.status,
        text,
      )
    }
    // 从响应头解析文件名（支持 RFC5987 filename*=UTF-8''xxx）
    const disp = res.headers.get('Content-Disposition') ?? ''
    let filename = `kwa_backup.json`
    const m1 = /filename\*=UTF-8''([^;]+)/i.exec(disp)
    if (m1?.[1]) {
      try {
        filename = decodeURIComponent(m1[1])
      } catch {
        filename = m1[1]
      }
    } else {
      const m2 = /filename="?([^";]+)"?/i.exec(disp)
      if (m2?.[1]) filename = m2[1]
    }
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
    return { ok: true, filename }
  },
}

export type ApiClient = typeof api

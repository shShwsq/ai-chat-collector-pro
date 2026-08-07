/**
 * 设置面板（左侧导航「设置」激活时显示）。
 *
 * 两大区域：
 *
 *   ① **API 配置区** —— 配置 LLM 服务的 base_url / model / api_key：
 *      - 字段初始值从 ``store.llmConfig`` 读取（首次进入面板时由 store 懒加载）；
 *      - base_url / model 为明文输入框，api_key 为密码输入框（显示掩码占位）；
 *      - 点击「保存配置」→ ``store.updateLlmConfig``（仅传用户修改过的字段）；
 *      - 保存成功后 Toast 提示「需重启后端或自动刷新配置才生效」。
 *
 *   ② **请求队列区** —— 查看与取消正在进行 / 排队中的 LLM 请求：
 *      - 列表来自 ``store.llmRequests``（含活跃 + 近期终态，按时间倒序）；
 *      - 每行显示 purpose / status / started_at / node_id / graph_id 等；
 *      - queued / running 状态的请求显示「取消」按钮，调用 ``store.cancelLlmRequest``；
 *      - 顶部「刷新」按钮手动刷新；进入面板与挂载时启动 3 秒轮询，离开面板时停止；
 *      - 空队列时显示「暂无活跃请求」。
 *
 * 数据流：
 * - 进入面板（``setActiveNav('settings')``）时 store 自动调用 loadLlmConfig 与
 *   loadLlmRequests；本组件挂载后再启动轮询定时器，卸载时清理。
 * - 取消请求后 store 立即刷新列表，UI 自动反映新状态。
 */

import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './graph/ConfirmDialog'
import { PluginIntegrationSection } from './PluginIntegrationSection'
import { THEMES } from '../lib/themes'
import type { LlmRequestInfo, LlmRequestStatus, Mode } from '../lib/types'

/** 请求队列自动轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 3000

/** 状态对应的中文文案与颜色类名。 */
function statusMeta(s: LlmRequestStatus): { label: string; cls: string } {
  switch (s) {
    case 'queued':
      return { label: '排队中', cls: 'is-queued' }
    case 'running':
      return { label: '进行中', cls: 'is-running' }
    case 'completed':
      return { label: '已完成', cls: 'is-completed' }
    case 'cancelled':
      return { label: '已取消', cls: 'is-cancelled' }
    case 'failed':
      return { label: '失败', cls: 'is-failed' }
    default:
      return { label: s, cls: '' }
  }
}

/** 把 Unix 秒级时间戳格式化为本地「时:分:秒」展示。 */
function formatTs(ts?: number | null): string {
  if (!ts) return '-'
  try {
    const d = new Date(ts * 1000)
    if (Number.isNaN(d.getTime())) return '-'
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return '-'
  }
}

/** 把 purpose（snake_case）转为可读中文标签（部分常见用途映射，未命中则原样展示）。 */
const PURPOSE_LABELS: Record<string, string> = {
  generate_node_detail: '生成节点详情',
  extend_node: '节点延伸',
  generate_directions: '生成延伸方向',
  generate_quiz: '生成测验题',
  grade_feynman: '费曼题判分',
  generate_trends: '生成风口推荐',
  generate_report: '生成工作报告',
  answer_question: '回答提问',
  extract_work_objects: '抽取工作对象',
  extract_nodes: '抽取知识点',
}

function purposeLabel(p: string): string {
  return PURPOSE_LABELS[p] ?? p
}

export function SettingsPanel() {
  return (
    <div className="settings-panel">
      <AppearanceSection />
      <WorkConfirmSection />
      <ApiConfigSection />
      <PluginIntegrationSection />
      <RequestQueueSection />
      <DangerZoneSection />
      <HelpSection />
    </div>
  )
}

// ============================================================================
// 帮助区：重新查看引导
// ============================================================================
function HelpSection() {
  const setOnboardingVisible = useAppStore((s) => s.setOnboardingVisible)
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">帮助</h2>
          <p className="settings-section__desc">
            忘了怎么用？随时可以重新查看首次启动引导，了解双模式、知识图谱、
            AI 抽取、测验与报告等核心功能。
          </p>
        </div>
      </header>
      <button
        type="button"
        className="settings-section__ghost-btn"
        onClick={() => setOnboardingVisible(true)}
        title="重新查看首次启动引导向导"
      >
        重新查看引导 →
      </button>
    </section>
  )
}

// ============================================================================
// API 配置区
// ============================================================================

function ApiConfigSection() {
  const llmConfig = useAppStore((s) => s.llmConfig)
  const llmConfigLoading = useAppStore((s) => s.llmConfigLoading)
  const llmConfigSaving = useAppStore((s) => s.llmConfigSaving)
  const loadLlmConfig = useAppStore((s) => s.loadLlmConfig)
  const updateLlmConfig = useAppStore((s) => s.updateLlmConfig)
  const llmTesting = useAppStore((s) => s.llmTesting)
  const llmTestResult = useAppStore((s) => s.llmTestResult)
  const testLlmConnection = useAppStore((s) => s.testLlmConnection)

  // 本地表单状态：base_url / model 为明文，api_key 仅在用户输入新值时才提交
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  // 标记是否已用后端返回的配置初始化过本地表单（避免每次刷新都覆盖用户输入）
  const [inited, setInited] = useState(false)

  // 后端配置加载完成后，把字段同步到本地表单（仅首次或刷新后）
  useEffect(() => {
    if (llmConfig && !inited) {
      setBaseUrl(llmConfig.base_url)
      setModel(llmConfig.model)
      setApiKey('')
      setInited(true)
    }
  }, [llmConfig, inited])

  // 用户主动点「重新加载」时，重置 inited 让 useEffect 再次同步
  const handleReload = () => {
    setInited(false)
    void loadLlmConfig()
  }

  const handleSave = async () => {
    // 仅传与当前配置不同的字段，避免覆盖未变更的值
    const patch: {
      base_url?: string
      model?: string
      api_key?: string
    } = {}
    if (llmConfig && baseUrl.trim() && baseUrl.trim() !== llmConfig.base_url) {
      patch.base_url = baseUrl.trim()
    }
    if (llmConfig && model.trim() && model.trim() !== llmConfig.model) {
      patch.model = model.trim()
    }
    if (apiKey.trim()) {
      patch.api_key = apiKey.trim()
    }
    if (Object.keys(patch).length === 0) {
      return
    }
    const ok = await updateLlmConfig(patch)
    if (ok) {
      // 保存成功后清空 api_key 输入框（避免重复提交）
      setApiKey('')
    }
  }

  const hasChange = useMemo(() => {
    if (!llmConfig) return false
    if (baseUrl.trim() !== llmConfig.base_url) return true
    if (model.trim() !== llmConfig.model) return true
    if (apiKey.trim()) return true
    return false
  }, [llmConfig, baseUrl, model, apiKey])

  // 测试连接：用当前表单值构造请求（api_key 留空则后端用已保存值）。
  // 仅当 base_url / model 至少有值时才允许触发。
  const handleTest = async () => {
    const patch: {
      base_url?: string
      api_key?: string
      model?: string
    } = {}
    if (baseUrl.trim()) patch.base_url = baseUrl.trim()
    if (model.trim()) patch.model = model.trim()
    if (apiKey.trim()) patch.api_key = apiKey.trim()
    await testLlmConnection(patch)
  }

  const canTest = !!llmConfig && (!!baseUrl.trim() || !!model.trim() || !!apiKey.trim())

  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">LLM API 配置</h2>
          <p className="settings-section__desc">
            配置后端调用大语言模型的服务地址、模型名与 API Key。保存后新配置
            将在下一次 LLM 调用时自动生效，无需重启后端。
          </p>
        </div>
        <button
          type="button"
          className="settings-section__ghost-btn"
          onClick={handleReload}
          disabled={llmConfigLoading}
          title="重新从后端拉取最新配置"
        >
          {llmConfigLoading ? '加载中…' : '重新加载'}
        </button>
      </header>

      {llmConfigLoading && !llmConfig ? (
        <div className="settings-section__loading">正在加载 LLM 配置…</div>
      ) : !llmConfig ? (
        <div className="settings-section__error">
          配置加载失败，请点击「重新加载」重试。
        </div>
      ) : (
        <div className="settings-form">
          <div className="settings-form__row">
            <label className="settings-form__label" htmlFor="llm-base-url">
              Base URL
              <span className="settings-form__hint">
                OpenAI 兼容服务的 API 基地址
              </span>
            </label>
            <input
              id="llm-base-url"
              className="settings-form__input"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="settings-form__row">
            <label className="settings-form__label" htmlFor="llm-model">
              Model
              <span className="settings-form__hint">
                默认模型名，如 gpt-4o-mini / qwen-plus
              </span>
            </label>
            <input
              id="llm-model"
              className="settings-form__input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="settings-form__row">
            <label className="settings-form__label" htmlFor="llm-api-key">
              API Key
              <span className="settings-form__hint">
                {llmConfig.api_key_masked
                  ? `当前已配置（${llmConfig.api_key_masked}）。留空则不修改。`
                  : '尚未配置。粘贴新 Key 后保存。'}
              </span>
            </label>
            <input
              id="llm-api-key"
              className="settings-form__input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="留空保持原 Key 不变"
              autoComplete="new-password"
              spellCheck={false}
            />
          </div>

          <div className="settings-form__actions">
            <button
              type="button"
              className="settings-form__save-btn"
              onClick={handleSave}
              disabled={llmConfigSaving || !hasChange}
              title={
                !hasChange
                  ? '没有需要保存的变更'
                  : llmConfigSaving
                    ? '正在保存…'
                    : '保存配置（新配置将在下次 LLM 调用时生效）'
              }
            >
              {llmConfigSaving ? '保存中…' : '保存配置'}
            </button>
            <button
              type="button"
              className="settings-form__test-btn"
              onClick={handleTest}
              disabled={llmTesting || !canTest}
              title={
                !canTest
                  ? '请先填写 base_url / model / api_key 至少一项'
                  : llmTesting
                    ? '正在测试连接…'
                    : '用当前表单值向后端发送一条 ping 消息验证连通性（无需保存）'
              }
            >
              {llmTesting ? '测试中…' : '测试连接'}
            </button>
            <span className="settings-form__tip">
              保存后请重启后端进程，或等待后端热加载配置。
            </span>
          </div>

          {llmTestResult && (
            <div
              className={`settings-form__test-result${
                llmTestResult.ok ? ' is-ok' : ' is-fail'
              }`}
              role="status"
            >
              <span className="settings-form__test-icon">
                {llmTestResult.ok ? '✓' : '✕'}
              </span>
              <span className="settings-form__test-text">
                {llmTestResult.message}
                {llmTestResult.ok && llmTestResult.reply && (
                  <span className="settings-form__test-reply">
                    {' '}回复：{llmTestResult.reply}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ============================================================================
// 请求队列区
// ============================================================================

function RequestQueueSection() {
  const llmRequests = useAppStore((s) => s.llmRequests)
  const llmRequestsLoading = useAppStore((s) => s.llmRequestsLoading)
  const llmRequestsError = useAppStore((s) => s.llmRequestsError)
  const llmCancellingId = useAppStore((s) => s.llmCancellingId)
  const loadLlmRequests = useAppStore((s) => s.loadLlmRequests)
  const cancelLlmRequest = useAppStore((s) => s.cancelLlmRequest)

  // 进入面板时启动 3 秒轮询，卸载时清理
  useEffect(() => {
    // 立即拉一次，确保进入面板时数据最新
    void loadLlmRequests()
    const timer = setInterval(() => {
      void loadLlmRequests()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [loadLlmRequests])

  const activeCount = useMemo(
    () =>
      llmRequests.filter(
        (r) => r.status === 'queued' || r.status === 'running',
      ).length,
    [llmRequests],
  )

  const handleRefresh = () => {
    void loadLlmRequests()
  }

  const handleCancel = (id: string) => {
    void cancelLlmRequest(id)
  }

  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">
            LLM 请求队列
            {activeCount > 0 && (
              <span className="settings-section__badge">{activeCount} 活跃</span>
            )}
          </h2>
          <p className="settings-section__desc">
            查看当前正在进行或排队中的 LLM 请求，可取消单个请求。列表每 3 秒
            自动刷新一次。
          </p>
        </div>
        <button
          type="button"
          className="settings-section__ghost-btn"
          onClick={handleRefresh}
          disabled={llmRequestsLoading}
          title="手动刷新请求列表"
        >
          {llmRequestsLoading ? '刷新中…' : '刷新'}
        </button>
      </header>

      {llmRequestsError && (
        <div className="settings-section__error">
          加载请求列表失败：{llmRequestsError}
        </div>
      )}

      {!llmRequestsError && llmRequests.length === 0 ? (
        <div className="settings-section__empty">
          {llmRequestsLoading ? '正在加载…' : '暂无活跃请求'}
        </div>
      ) : (
        <div className="settings-queue">
          <div className="settings-queue__head">
            <div className="settings-queue__cell settings-queue__cell--purpose">
              用途
            </div>
            <div className="settings-queue__cell settings-queue__cell--status">
              状态
            </div>
            <div className="settings-queue__cell settings-queue__cell--started">
              开始时间
            </div>
            <div className="settings-queue__cell settings-queue__cell--node">
              关联节点
            </div>
            <div className="settings-queue__cell settings-queue__cell--action">
              操作
            </div>
          </div>
          <ul className="settings-queue__body">
            {llmRequests.map((r) => (
              <RequestRow
                key={r.id}
                req={r}
                cancelling={llmCancellingId === r.id}
                onCancel={() => handleCancel(r.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** 单行请求展示。 */
function RequestRow({
  req,
  cancelling,
  onCancel,
}: {
  req: LlmRequestInfo
  cancelling: boolean
  onCancel: () => void
}) {
  const meta = statusMeta(req.status)
  const cancellable = req.status === 'queued' || req.status === 'running'
  // 优先用 meta 中的节点标题（若后端附带），其次用 node_id 截短
  const metaNodeTitle = (() => {
    const m = req.meta as Record<string, unknown> | undefined
    if (!m) return ''
    const v = m.node_title ?? m.title
    return typeof v === 'string' ? v : ''
  })()
  const nodeDisplay = metaNodeTitle || req.node_id || '-'

  return (
    <li className={`settings-queue__row is-${req.status}`}>
      <div
        className="settings-queue__cell settings-queue__cell--purpose"
        title={req.purpose}
      >
        <span className="settings-queue__purpose">
          {purposeLabel(req.purpose)}
        </span>
        <span className="settings-queue__purpose-id">{req.purpose}</span>
      </div>
      <div className="settings-queue__cell settings-queue__cell--status">
        <span className={`settings-queue__status ${meta.cls}`}>
          {meta.label}
        </span>
      </div>
      <div
        className="settings-queue__cell settings-queue__cell--started"
        title={req.completed_at ? `结束于 ${formatTs(req.completed_at)}` : ''}
      >
        {formatTs(req.started_at)}
      </div>
      <div
        className="settings-queue__cell settings-queue__cell--node"
        title={req.node_id ?? ''}
      >
        {nodeDisplay}
      </div>
      <div className="settings-queue__cell settings-queue__cell--action">
        {cancellable ? (
          <button
            type="button"
            className="settings-queue__cancel-btn"
            onClick={onCancel}
            disabled={cancelling}
            title="取消该请求（流式调用在下一 chunk 边界中断；非流式仅软标记）"
          >
            {cancelling ? '取消中…' : '取消'}
          </button>
        ) : req.error ? (
          <span className="settings-queue__error" title={req.error}>
            错误
          </span>
        ) : (
          <span className="settings-queue__noop">—</span>
        )}
      </div>
    </li>
  )
}

// ============================================================================
// 外观区：主题切换
// ============================================================================
function AppearanceSection() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">外观</h2>
          <p className="settings-section__desc">
            选择应用的整体配色主题，切换即时生效。
          </p>
        </div>
      </header>
      <div className="appearance-list">
        {THEMES.map((item) => {
          const active = item.id === theme
          return (
            <button
              key={item.id}
              type="button"
              className={`appearance-item${active ? ' is-active' : ''}`}
              onClick={() => setTheme(item.id)}
              aria-pressed={active}
            >
              <span className="appearance-item__preview" data-theme-preview={item.id} aria-hidden="true">
                <span className="appearance-item__preview-rail" />
                <span className="appearance-item__preview-main">
                  <span className="appearance-item__preview-line" />
                  <span className="appearance-item__preview-card">
                    <span />
                    <span />
                  </span>
                  <span className="appearance-item__preview-accents">
                    <i />
                    <i />
                  </span>
                </span>
              </span>
              <span className="appearance-item__info">
                <span className="appearance-item__label">{item.label}</span>
                <span className="appearance-item__desc">{item.description}</span>
              </span>
              {active && <span className="appearance-item__check" aria-hidden="true">✓</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

// ============================================================================
// 工作对象确认模式区
// ============================================================================
function WorkConfirmSection() {
  const workObjectSingleConfirm = useAppStore(
    (s) => s.workObjectSingleConfirm,
  )
  const setWorkObjectSingleConfirm = useAppStore(
    (s) => s.setWorkObjectSingleConfirm,
  )
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">工作对象确认模式</h2>
          <p className="settings-section__desc">
            控制高风险工具「工作对象批量入图」的确认方式。关闭=批量确认
            （一次同意全部）；开启=逐条确认（每个对象可单独勾选，仅入图勾选项）。
          </p>
        </div>
      </header>
      <div className="settings-toggle">
        <label className="settings-toggle__label">
          <input
            type="checkbox"
            className="settings-toggle__checkbox"
            checked={workObjectSingleConfirm}
            onChange={(e) => setWorkObjectSingleConfirm(e.target.checked)}
          />
          <span className="settings-toggle__text">
            {workObjectSingleConfirm ? '逐条确认（已开启）' : '批量确认（默认）'}
          </span>
        </label>
        <p className="settings-toggle__hint">
          {workObjectSingleConfirm
            ? '开启后，工作对象入图确认框将显示勾选列，可取消不想要的项。'
            : '当前为批量确认：一次同意即入图全部候选工作对象。开启后可逐条筛选。'}
        </p>
      </div>
    </section>
  )
}

// ============================================================================
// 数据管理 / Danger Zone 区：批量清空与导出备份
// ============================================================================

/** 清空范围。``all`` = 全部模式；``study`` / ``work`` = 仅该模式。 */
type ClearScope = 'all' | Mode

/** 当前打开的确认弹窗类型。 */
type ClearTarget = 'sessions' | 'graphs' | 'observations' | null

const SCOPE_OPTIONS: { value: ClearScope; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'study', label: 'Study' },
  { value: 'work', label: 'Work' },
]

function DangerZoneSection() {
  const clearingData = useAppStore((s) => s.clearingData)
  const exportingData = useAppStore((s) => s.exportingData)
  const clearAllChatSessions = useAppStore((s) => s.clearAllChatSessions)
  const clearAllGraphs = useAppStore((s) => s.clearAllGraphs)
  const clearAllObservations = useAppStore((s) => s.clearAllObservations)
  const exportAllData = useAppStore((s) => s.exportAllData)

  const [scope, setScope] = useState<ClearScope>('all')
  const [target, setTarget] = useState<ClearTarget>(null)
  // 清空图谱时是否同时清空观察记录（源对话，不区分模式）
  const [clearObsWithGraphs, setClearObsWithGraphs] = useState(false)

  const modeArg = scope === 'all' ? undefined : scope
  const scopeLabel = scope === 'all' ? '全部模式' : `${scope} 模式`

  const handleExport = () => {
    void exportAllData(modeArg)
  }

  const handleConfirm = async () => {
    const t = target
    setTarget(null)
    if (t === 'sessions') {
      await clearAllChatSessions(modeArg)
    } else if (t === 'graphs') {
      // 勾选时先清观察记录（全量），再清图谱；不勾选仅清图谱（observations 解绑保留）
      if (clearObsWithGraphs) {
        await clearAllObservations()
      }
      await clearAllGraphs(modeArg)
    } else if (t === 'observations') {
      await clearAllObservations()
    }
    setClearObsWithGraphs(false)
  }

  const handleCancel = () => {
    setTarget(null)
    setClearObsWithGraphs(false)
  }

  // 各操作的确认弹窗文案
  const dialogConfig: Record<
    Exclude<ClearTarget, null>,
    { title: string; message: string }
  > = {
    sessions: {
      title: `清空${scopeLabel}所有对话会话`,
      message: `将永久删除${scopeLabel}的全部 chat 会话及其消息历史与 checkpoint，不可恢复。建议先导出备份。`,
    },
    graphs: {
      title: `清空${scopeLabel}所有图谱`,
      message: `将永久删除${scopeLabel}的全部图谱及其下节点 / 边 / 测验，不可恢复。观察记录（源对话）默认保留并自动解绑。建议先导出备份。`,
    },
    observations: {
      title: '清空所有观察记录',
      message:
        '将永久删除全部观察记录（浏览器插件推送 / 导入的原始对话，不区分模式），不可恢复。图谱数据不受影响。建议先导出备份。',
    },
  }

  return (
    <section className="settings-section danger-zone">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">数据管理</h2>
          <p className="settings-section__desc">
            批量清空对话会话 / 图谱 / 观察记录，或导出全部数据为 JSON 备份。
            清空操作不可恢复，请先导出备份并谨慎确认。
          </p>
        </div>
      </header>

      <div className="danger-zone__body">
        {/* 范围选择器：控制清空会话 / 图谱的作用域 */}
        <div className="danger-zone__scope">
          <span className="danger-zone__scope-label">清空范围：</span>
          <div className="danger-zone__segmented" role="radiogroup" aria-label="清空范围">
            {SCOPE_OPTIONS.map((opt) => {
              const active = opt.value === scope
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`danger-zone__segmented-btn${active ? ' is-active' : ''}`}
                  onClick={() => setScope(opt.value)}
                  disabled={clearingData || exportingData}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <span className="danger-zone__scope-hint">
            仅影响对话会话与图谱；观察记录不区分模式。
          </span>
        </div>

        {/* 导出备份（随时可点，也作为清空前提示） */}
        <div className="danger-zone__row danger-zone__row--export">
          <div className="danger-zone__row-info">
            <span className="danger-zone__row-title">导出数据备份</span>
            <span className="danger-zone__row-desc">
              将当前范围的全部数据导出为 JSON 文件（观察记录始终全量导出）。
            </span>
          </div>
          <button
            type="button"
            className="danger-zone__export-btn"
            onClick={handleExport}
            disabled={clearingData || exportingData}
          >
            {exportingData ? '导出中…' : '导出 JSON'}
          </button>
        </div>

        {/* 清空对话会话 */}
        <div className="danger-zone__row">
          <div className="danger-zone__row-info">
            <span className="danger-zone__row-title">
              清空{scopeLabel}所有对话会话
            </span>
            <span className="danger-zone__row-desc">
              删除会话及其消息历史与 checkpoint（{scopeLabel}）。
            </span>
          </div>
          <button
            type="button"
            className="danger-zone__danger-btn"
            onClick={() => setTarget('sessions')}
            disabled={clearingData || exportingData}
          >
            清空对话
          </button>
        </div>

        {/* 清空图谱 */}
        <div className="danger-zone__row">
          <div className="danger-zone__row-info">
            <span className="danger-zone__row-title">
              清空{scopeLabel}所有图谱
            </span>
            <span className="danger-zone__row-desc">
              删除图谱及其下节点 / 边 / 测验（{scopeLabel}）。观察记录默认保留。
            </span>
          </div>
          <button
            type="button"
            className="danger-zone__danger-btn"
            onClick={() => setTarget('graphs')}
            disabled={clearingData || exportingData}
          >
            清空图谱
          </button>
        </div>

        {/* 清空观察记录（全局，不受范围控制） */}
        <div className="danger-zone__row">
          <div className="danger-zone__row-info">
            <span className="danger-zone__row-title">清空所有观察记录</span>
            <span className="danger-zone__row-desc">
              删除全部源对话（插件推送 / 导入），不区分模式。图谱数据不受影响。
            </span>
          </div>
          <button
            type="button"
            className="danger-zone__danger-btn"
            onClick={() => setTarget('observations')}
            disabled={clearingData || exportingData}
          >
            清空观察
          </button>
        </div>
      </div>

      {target && (
        <ConfirmDialog
          open
          danger
          title={dialogConfig[target].title}
          message={dialogConfig[target].message}
          confirmText="清空"
          cancelText="取消"
          confirmPhrase="清空"
          onExport={handleExport}
          exportText="先导出备份"
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
          extra={
            target === 'graphs' ? (
              <label className="confirm-dialog__checkbox">
                <input
                  type="checkbox"
                  checked={clearObsWithGraphs}
                  onChange={(e) => setClearObsWithGraphs(e.target.checked)}
                />
                <span>同时清空所有观察记录（源对话，不区分模式）</span>
              </label>
            ) : null
          }
        />
      )}
    </section>
  )
}

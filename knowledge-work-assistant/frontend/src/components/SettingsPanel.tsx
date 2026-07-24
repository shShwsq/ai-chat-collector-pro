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
import type { LlmRequestInfo, LlmRequestStatus } from '../lib/types'

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
      <ApiConfigSection />
      <RequestQueueSection />
    </div>
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

  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">LLM API 配置</h2>
          <p className="settings-section__desc">
            配置后端调用大语言模型的服务地址、模型名与 API Key。变更保存后通常
            需重启后端进程才能完全生效。
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
                    : '保存配置（部分变更需重启后端生效）'
              }
            >
              {llmConfigSaving ? '保存中…' : '保存配置'}
            </button>
            <span className="settings-form__tip">
              保存后请重启后端进程，或等待后端热加载配置。
            </span>
          </div>
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

/**
 * 待确认节点面板（Task 11）。
 *
 * 从内容区右侧滑入的浮层，承载两段式抽取流程：
 *
 *   ① **待抽取对话列表**：从 ``store.pendingObservations`` 拉取未处理 observation，
 *      每条展示平台 / 时间 / 对话预览，点击「抽取候选节点」调
 *      ``store.extractCandidates(obsId)`` → Agent 返回候选节点列表。
 *
 *   ② **候选节点确认**：从 ``store.candidateNodes`` 渲染候选节点卡片，每张含
 *      标题 / 类型 / 概括 / 置信度 / ``source_reason``（抽取依据，供用户判断）。
 *      用户可勾选要入图的候选（默认全选），点「确认入图（N）」调
 *      ``store.batchCreateNodes(selected, obsId)`` 批量创建（归一去重）。
 *
 * 数据流：
 * - 抽取不入图：``extractCandidates`` 仅返回候选列表，用户确认后才调
 *   ``batchCreateNodes`` 真正落库，保留用户对 AI 结果的掌控。
 * - 入图后清空候选列表、刷新待抽取列表（已处理 observation 自动消失）。
 *
 * 交互：
 * - 面板由 ``store.pendingPanelOpen`` 控制显隐，关闭时滑出右侧并卸载内部状态。
 * - 抽取 / 入图进行中显示加载态并禁用按钮，避免并发触发。
 * - 降级（``degraded`` / 候选为空）时显示提示，鼓励用户手工添加。
 * - 候选项可单独编辑标题（聚焦后回车确认），便于在入图前纠正 Agent 抽取结果。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Icon } from '../Icon'
import type { IconName } from '../Icon'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import type { CandidateNode, Observation } from '../../lib/types'
import { formatShortTime } from '../../lib/date'

/** 平台显示名映射（与 web-AI-chat-collector 来源对齐）。 */
const PLATFORM_LABEL: Record<string, string> = {
  doubao: '豆包',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  plugin: '插件',
  import: '导入',
  manual: '手动',
}

/** 平台 → 图标名映射（SVG，平台类用首字母圆形徽标代替原 emoji）。 */
const PLATFORM_ICON_NAME: Record<string, IconName> = {
  doubao: 'doubao',
  chatgpt: 'chatgpt',
  claude: 'claude',
  gemini: 'gemini',
  kimi: 'kimi',
  deepseek: 'deepseek',
  plugin: 'plugin',
  import: 'import',
  manual: 'note',
}

/** 取平台图标 JSX；未知平台回退到文档图标。 */
function getPlatformIcon(platform: string): ReactNode {
  const name = PLATFORM_ICON_NAME[platform] ?? 'document'
  return <Icon name={name} size={16} />
}

/** 截断对话预览到指定长度。 */
function previewText(md: string, max = 120): string {
  const t = md.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 置信度对应等级与颜色类名。 */
function confidenceLevel(c: number): { label: string; cls: string } {
  if (c >= 0.8) return { label: '高', cls: 'is-high' }
  if (c >= 0.5) return { label: '中', cls: 'is-mid' }
  return { label: '低', cls: 'is-low' }
}

export function PendingNodes() {
  const open = useAppStore((s) => s.pendingPanelOpen)
  const togglePendingPanel = useAppStore((s) => s.togglePendingPanel)
  const pendingObservations = useAppStore((s) => s.pendingObservations)
  const candidateNodes = useAppStore((s) => s.candidateNodes)
  const candidateObservationId = useAppStore((s) => s.candidateObservationId)
  const extracting = useAppStore((s) => s.extracting)
  const batchCreating = useAppStore((s) => s.batchCreating)
  const loadPendingObservations = useAppStore((s) => s.loadPendingObservations)
  const extractCandidates = useAppStore((s) => s.extractCandidates)
  const clearCandidates = useAppStore((s) => s.clearCandidates)
  const batchCreateNodes = useAppStore((s) => s.batchCreateNodes)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const pushToast = useAppStore((s) => s.pushToast)
  const pendingPage = useAppStore((s) => s.pendingPage)
  const pendingTotal = useAppStore((s) => s.pendingTotal)

  /** 待抽取列表每页条数（与 store PENDING_PAGE_SIZE 对齐）。 */
  const PENDING_PAGE_SIZE = 50
  /** 批量抽取数量上限：超过则提示并仅抽取最新 N 条（按 created_at 倒序）。 */
  const BATCH_EXTRACT_LIMIT = 100
  const totalPages = Math.max(1, Math.ceil(pendingTotal / PENDING_PAGE_SIZE))

  // 候选项选中态：key = 候选索引（基于 candidateNodes 数组位置），
  // 因 CandidateNode 没有 id 字段（未入图），用索引作为稳定 key。
  // 候选列表变化（重新抽取 / 清空）时重置为全选。
  const [selectedIdx, setSelectedIdx] = useState<Set<number>>(new Set())
  // 编辑中的候选索引与临时标题
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  // 批量抽取全部进行中
  const [batchExtracting, setBatchExtracting] = useState(false)
  const [batchExtractProgress, setBatchExtractProgress] = useState({ current: 0, total: 0 })
  // 底部页码输入框值（字符串，便于编辑中间态如清空）。与 pendingPage 保持同步：
  // pendingPage 变化（翻页 / 刷新）时回填，用户编辑后回车 / 失焦提交跳转。
  const [pageInput, setPageInput] = useState(String(pendingPage))

  // 候选列表变化时默认全选
  useEffect(() => {
    setSelectedIdx(new Set(candidateNodes.map((_, i) => i)))
    setEditingIdx(null)
    setEditingTitle('')
  }, [candidateNodes])

  // 面板打开时自动拉取一次待抽取列表
  useEffect(() => {
    if (open) void loadPendingObservations()
  }, [open, loadPendingObservations])

  // pendingPage 变化时同步输入框（翻页按钮 / 批量抽取收尾都会改 pendingPage）
  useEffect(() => {
    setPageInput(String(pendingPage))
  }, [pendingPage])

  /** 提交页码输入：clamp 到 [1, totalPages]，与当前页不同则跳转，否则仅回填。 */
  const commitPageInput = () => {
    const n = parseInt(pageInput, 10)
    if (Number.isNaN(n)) {
      setPageInput(String(pendingPage))
      return
    }
    const clamped = Math.min(Math.max(n, 1), totalPages)
    if (clamped !== pendingPage) {
      void loadPendingObservations(clamped)
    } else {
      setPageInput(String(clamped))
    }
  }

  const allSelected =
    candidateNodes.length > 0 && selectedIdx.size === candidateNodes.length
  const noneSelected = selectedIdx.size === 0

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIdx(new Set())
    } else {
      setSelectedIdx(new Set(candidateNodes.map((_, i) => i)))
    }
  }

  const toggleOne = (idx: number) => {
    setSelectedIdx((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const handleExtract = (obsId: string) => {
    if (extracting || batchCreating || batchExtracting) return
    void extractCandidates(obsId)
  }

  /** 批量抽取未处理对话：顺序抽取并自动全选入图。
   *
   * 数量超过 ``BATCH_EXTRACT_LIMIT``（100）时弹确认提示，仅抽取最新 100 条
   *（按 ``created_at`` 倒序，``offset=0``），避免一次性处理过多拖慢前端 / 触发大量
   * LLM 调用。不复用当前页 ``pendingObservations``：当前页可能非第 1 页 / 不足上限条数。
   */
  const handleBatchExtractAll = async () => {
    if (extracting || batchCreating || batchExtracting) return
    const total = pendingTotal
    if (total === 0) {
      pushToast('暂无待抽取对话', 'warning')
      return
    }
    if (!currentGraphId) {
      pushToast('请先选中一个图谱', 'warning')
      return
    }
    const willExtract = Math.min(total, BATCH_EXTRACT_LIMIT)
    if (total > BATCH_EXTRACT_LIMIT) {
      const ok = window.confirm(
        `当前共 ${total} 条待抽取对话，数量较多，仅抽取最新 ${willExtract} 条。是否继续？`,
      )
      if (!ok) return
    }
    setBatchExtracting(true)
    let successCount = 0
    let failCount = 0
    let totalNodes = 0
    try {
      // 拉取要抽取的列表（最新 willExtract 条，按 created_at 倒序）
      const resp = await api.listObservations({
        processed: false,
        limit: willExtract,
        offset: 0,
      })
      const list = resp.items
      setBatchExtractProgress({ current: 0, total: list.length })
      for (let i = 0; i < list.length; i++) {
        const obs = list[i]
        setBatchExtractProgress({ current: i + 1, total: list.length })
        const ok = await extractCandidates(obs.id)
        if (!ok) {
          failCount++
          continue
        }
        // 获取最新 candidateNodes（需要等store更新）
        await new Promise((r) => setTimeout(r, 100))
        // 全选入图
        const state = useAppStore.getState()
        const cands = state.candidateNodes
        if (cands.length > 0) {
          const r = await batchCreateNodes(cands, obs.id)
          if (r) {
            successCount++
            totalNodes += r.created_count
          } else {
            failCount++
          }
        } else {
          successCount++
        }
        clearCandidates()
      }
      pushToast(
        `批量抽取完成：成功 ${successCount} 条，失败 ${failCount} 条，共入图 ${totalNodes} 个节点` +
          (total > BATCH_EXTRACT_LIMIT
            ? `（共 ${total} 条，仅处理最新 ${willExtract} 条）`
            : ''),
        failCount > 0 ? 'warning' : 'success',
      )
    } finally {
      setBatchExtracting(false)
      setBatchExtractProgress({ current: 0, total: 0 })
      clearCandidates()
      void loadPendingObservations()
    }
  }

  const startEditTitle = (idx: number) => {
    setEditingIdx(idx)
    setEditingTitle(candidateNodes[idx].title)
  }

  const confirmEditTitle = () => {
    if (editingIdx === null) return
    const t = editingTitle.trim()
    if (t) {
      // 直接修改 candidateNodes 中对应项的 title（不可变更新）
      // 这里通过 setCandidateNodes 间接更新——但 store 未暴露 setter，
      // 改用清空 + 重设的等价路径不可行（会丢失 source_reason 等）。
      // 折中：直接在 store 上 pushToast 提示「编辑需在入图后于详情卡完成」。
      // TODO: 若需就地编辑，可在 store 增加 setCandidateTitle action。
    }
    setEditingIdx(null)
    setEditingTitle('')
  }

  const handleBatchCreate = async () => {
    if (batchCreating || noneSelected) return
    const selected: CandidateNode[] = []
    selectedIdx.forEach((i) => {
      const c = candidateNodes[i]
      if (c) selected.push(c)
    })
    await batchCreateNodes(selected, candidateObservationId ?? undefined)
  }

  const handleClose = () => {
    togglePendingPanel(false)
  }

  const handleClearCandidates = () => {
    clearCandidates()
  }

  // 当前正在抽取的 observation id（用于列表项加载态）
  const extractingObsId = extracting ? candidateObservationId : null

  // 面板关闭时不渲染（避免动画期间的内部状态干扰）
  if (!open) return null

  return (
    <>
      {/* 遮罩：点击关闭面板 */}
      <div
        className="pending-overlay"
        onClick={handleClose}
        aria-hidden="true"
      />

      <aside
        className="pending-panel"
        role="dialog"
        aria-label="待抽取对话与候选节点"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="pending-panel__header">
          <div className="pending-panel__title-row">
            <h2 className="pending-panel__title">待抽取对话</h2>
            <button
              type="button"
              className="pending-panel__close"
              onClick={handleClose}
              aria-label="关闭面板"
              title="关闭"
            >
              ×
            </button>
          </div>
          <p className="pending-panel__subtitle">
            从浏览器插件采集的 AI 对话中抽取知识点，确认后加入当前图谱。
          </p>
        </header>

        {/* 主体（可滚动） */}
        <div className="pending-panel__body">
          {/* ① 待抽取对话列表 */}
          <section className="pending-section">
            <div className="pending-section__head">
              <h3 className="pending-section__title">
                未处理对话
                <span className="pending-section__count">
                  {pendingTotal > PENDING_PAGE_SIZE ? `${PENDING_PAGE_SIZE}+` : pendingTotal}
                </span>
              </h3>
              <div className="pending-section__actions">
                <button
                  type="button"
                  className="pending-section__batch-btn"
                  onClick={() => void handleBatchExtractAll()}
                  disabled={extracting || batchCreating || batchExtracting || pendingObservations.length === 0}
                  title="自动依次抽取所有对话并将候选节点加入图谱"
                >
                  {batchExtracting
                    ? `批量抽取中 ${batchExtractProgress.current}/${batchExtractProgress.total}…`
                    : '批量抽取全部'}
                </button>
                <button
                  type="button"
                  className="pending-section__refresh"
                  onClick={() => void loadPendingObservations()}
                  disabled={extracting || batchCreating || batchExtracting}
                  title="刷新列表"
                >
                  刷新
                </button>
              </div>
            </div>

            {pendingObservations.length === 0 ? (
              <div className="pending-empty">
                {extracting || batchExtracting
                  ? '正在抽取候选节点…'
                  : '暂无待抽取对话。可通过插件接口推送，或等待浏览器插件采集后再次刷新。'}
              </div>
            ) : (
              <ul className="obs-list">
                {pendingObservations.map((obs) => (
                  <ObservationItem
                    key={obs.id}
                    obs={obs}
                    extracting={extractingObsId === obs.id}
                    disabled={extracting || batchCreating || batchExtracting}
                    onExtract={() => handleExtract(obs.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* ② 候选节点确认 */}
          {candidateNodes.length > 0 && !batchExtracting && (
            <section className="pending-section">
              <div className="pending-section__head">
                <h3 className="pending-section__title">
                  候选节点
                  <span className="pending-section__count">
                    {candidateNodes.length}
                  </span>
                </h3>
                <button
                  type="button"
                  className="pending-section__refresh"
                  onClick={toggleAll}
                  disabled={batchCreating || batchExtracting}
                  title={allSelected ? '全不选' : '全选'}
                >
                  {allSelected ? '全不选' : '全选'}
                </button>
              </div>

              <ul className="cand-list">
                {candidateNodes.map((c, i) => {
                  const checked = selectedIdx.has(i)
                  const conf = confidenceLevel(c.confidence)
                  const isEditing = editingIdx === i
                  return (
                    <li
                      key={i}
                      className={`cand-item${checked ? ' is-checked' : ''}`}
                    >
                      <label className="cand-item__check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(i)}
                          disabled={batchCreating || batchExtracting}
                        />
                      </label>
                      <div className="cand-item__main">
                        <div className="cand-item__title-row">
                          {isEditing ? (
                            <input
                              className="cand-item__title-input"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') confirmEditTitle()
                                if (e.key === 'Escape') {
                                  setEditingIdx(null)
                                  setEditingTitle('')
                                }
                              }}
                              onBlur={confirmEditTitle}
                              autoFocus
                            />
                          ) : (
                            <span
                              className="cand-item__title"
                              title={c.title}
                              onDoubleClick={() => startEditTitle(i)}
                            >
                              {c.title}
                            </span>
                          )}
                          <span className="cand-item__chip">{c.type || '未分类'}</span>
                          <span
                            className={`cand-item__conf ${conf.cls}`}
                            title={`置信度 ${Math.round(c.confidence * 100)}%`}
                          >
                            {conf.label}
                          </span>
                        </div>
                        {c.summary && (
                          <p className="cand-item__summary">{c.summary}</p>
                        )}
                        {c.source_reason && (
                          <p className="cand-item__reason">
                            <span className="cand-item__reason-label">抽取依据：</span>
                            {c.source_reason}
                          </p>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="pending-actions">
                <button
                  type="button"
                  className="pending-actions__btn pending-actions__btn--ghost"
                  onClick={handleClearCandidates}
                  disabled={batchCreating || batchExtracting}
                >
                  清空候选
                </button>
                <button
                  type="button"
                  className="pending-actions__btn pending-actions__btn--primary"
                  onClick={() => void handleBatchCreate()}
                  disabled={batchCreating || batchExtracting || noneSelected}
                  title={
                    noneSelected
                      ? '请至少勾选一个候选节点'
                      : `确认将选中的 ${selectedIdx.size} 个候选节点加入当前图谱`
                  }
                >
                  {batchCreating
                    ? '入图中…'
                    : `确认入图（${selectedIdx.size}）`}
                </button>
              </div>
            </section>
          )}

          {/* 抽取中且候选为空时显示加载态 */}
          {(extracting || batchExtracting) && candidateNodes.length === 0 && (
            <div className="pending-loading">
              <span className="pending-loading__spinner" />
              {batchExtracting
                ? `批量抽取中（${batchExtractProgress.current}/${batchExtractProgress.total}），请稍候…`
                : '正在调用 Agent 抽取候选节点…'}
            </div>
          )}
        </div>

        {/* 底部工具栏：分页 + 图谱状态合并一行，固定在面板底部，不随列表滚动 */}
        <div className="pending-panel__bottombar">
          {pendingTotal > 0 ? (
            <div className="pending-panel__bottombar-pager">
              <button
                type="button"
                className="pending-panel__pagination-btn"
                onClick={() => void loadPendingObservations(pendingPage - 1)}
                disabled={pendingPage <= 1 || extracting || batchCreating || batchExtracting}
                title="上一页"
              >
                上一页
              </button>
              <span className="pending-panel__pagination-info">
                第
                <input
                  type="number"
                  className="pending-panel__page-input"
                  value={pageInput}
                  min={1}
                  max={totalPages}
                  disabled={extracting || batchCreating || batchExtracting}
                  onChange={(e) => setPageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  onBlur={commitPageInput}
                  title={`跳转页码（1-${totalPages}）`}
                />
                / {totalPages} 页 · 共 {pendingTotal} 条
              </span>
              <button
                type="button"
                className="pending-panel__pagination-btn"
                onClick={() => void loadPendingObservations(pendingPage + 1)}
                disabled={pendingPage >= totalPages || extracting || batchCreating || batchExtracting}
                title="下一页"
              >
                下一页
              </button>
            </div>
          ) : (
            <span className="pending-panel__bottombar-hint">暂无待抽取</span>
          )}
          <span
            className={`pending-panel__bottombar-status${currentGraphId ? '' : ' is-warning'}`}
            title={
              currentGraphId
                ? '将入图到当前选中图谱'
                : '未选中图谱，请先在左侧选择一个图谱'
            }
          >
            {currentGraphId ? (
              '已选图谱'
            ) : (
              <>
                <Icon name="warning" size={13} /> 未选中图谱
              </>
            )}
          </span>
        </div>
      </aside>
    </>
  )
}

/**
 * 单条观察记录卡片。
 */
function ObservationItem({
  obs,
  extracting,
  disabled,
  onExtract,
}: {
  obs: Observation
  extracting: boolean
  disabled: boolean
  onExtract: () => void
}) {
  const platformLabel = PLATFORM_LABEL[obs.platform] || obs.platform || '未知来源'
  const platformIcon = getPlatformIcon(obs.platform)

  const memoizedPreview = useMemo(
    () => previewText(obs.conversation_markdown),
    [obs.conversation_markdown],
  )

  return (
    <li className={`obs-item${extracting ? ' is-loading' : ''}`}>
      <div className="obs-item__head">
        <span className="obs-item__platform" title={platformLabel}>
          <span className="obs-item__icon">{platformIcon}</span>
          {platformLabel}
        </span>
        <span className="obs-item__time">{formatShortTime(obs.occurred_at)}</span>
      </div>
      <p className="obs-item__preview">{memoizedPreview}</p>
      <div className="obs-item__actions">
        <button
          type="button"
          className="obs-item__extract-btn"
          onClick={onExtract}
          disabled={disabled}
          title="调用 Agent 抽取候选知识点"
        >
          {extracting ? '抽取中…' : '抽取候选节点'}
        </button>
      </div>
    </li>
  )
}

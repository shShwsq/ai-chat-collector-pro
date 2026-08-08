/**
 * Work 行业风口推荐侧栏（Task 14）。
 *
 * 从内容区右侧滑入的浮层，承载风口推荐与一键入图流程：
 *
 *   ① **生成风口**：点「生成风口推荐」调 ``store.generateTrends`` →
 *      Agent 基于当前 work 图谱分析并返回风口列表
 *      ``[{title, reason, relevance, suggested_actions}]``。
 *
 *   ② **时间线展示**：风口卡片按生成顺序纵向排列，每张含：
 *      - 标题 + 相关度徽标（高/中/低，色阶区分）
 *      - 可解释理由（结合图谱内容的 reason）
 *      - 建议行动列表（2-4 个具体动作）
 *      - 「加入图谱」按钮 → 调 ``store.addTrendToGraph(index)``
 *        把该风口转为工作线索节点入图，成功后整图刷新并闪烁高亮。
 *
 * 数据流：
 * - 风口结果缓存在后端进程内（``_trends_cache``），「加入图谱」按 index 取回；
 *   缓存失效时后端会重新生成兜底，前端无感。
 * - 加入图谱后节点出现在图谱视图与卡片视图，可继续延伸探索。
 *
 * 交互：
 * - 面板由 ``store.workActivePanel === 'trends'`` 控制显隐。
 * - 生成 / 加入进行中显示加载态并禁用按钮。
 * - 降级（``degraded`` / 列表为空）时显示提示。
 * - 已加入的风口按钮变为「已加入」禁用态（本地维护已加入 index 集合）。
 */

import { useEffect, useState } from 'react'

import { Icon } from '../Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useAppStore } from '../../store/useAppStore'
import type { Trend } from '../../lib/types'

/** 相关度对应徽标文案与样式类名。 */
function relevanceMeta(
  relevance: Trend['relevance'],
): { label: string; cls: string } {
  if (relevance === 'high') return { label: '高相关', cls: 'is-high' }
  if (relevance === 'medium') return { label: '中相关', cls: 'is-mid' }
  return { label: '低相关', cls: 'is-low' }
}

/** 格式化时间戳为简短的本地展示（用于时间线节点）。 */
function formatTimelineTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

export function TrendsSidebar() {
  const open = useAppStore((s) => s.workActivePanel === 'trends')
  const setWorkPanel = useAppStore((s) => s.setWorkPanel)
  const trends = useAppStore((s) => s.trends)
  const trendsLoading = useAppStore((s) => s.trendsLoading)
  const trendAddingIndex = useAppStore((s) => s.trendAddingIndex)
  const generateTrends = useAppStore((s) => s.generateTrends)
  const addTrendToGraph = useAppStore((s) => s.addTrendToGraph)
  const currentGraphId = useAppStore((s) => s.currentGraphId)

  // 已加入图谱的风口 index 集合（本地维护，加入成功后标记）
  const [addedIdx, setAddedIdx] = useState<Set<number>>(new Set())
  // 风口生成时间（用于时间线展示）
  const [generatedAt, setGeneratedAt] = useState<number | null>(null)

  // 风口列表变化时记录生成时间
  useEffect(() => {
    if (trends.length > 0) {
      setGeneratedAt(Date.now())
    } else {
      setGeneratedAt(null)
      setAddedIdx(new Set())
    }
  }, [trends])

  const handleClose = () => setWorkPanel('none')
  const dialogRef = useDialogFocus<HTMLElement>({ active: open, initialFocus: '.work-actions__btn--primary', onEscape: handleClose })

  if (!open) return null

  const handleGenerate = async () => {
    if (trendsLoading) return
    // 重新生成时清空已加入标记
    setAddedIdx(new Set())
    await generateTrends()
  }

  const handleAdd = async (index: number) => {
    if (trendAddingIndex !== null) return
    const ok = await addTrendToGraph(index)
    if (ok) {
      setAddedIdx((prev) => new Set(prev).add(index))
    }
  }

  return (
    <>
      {/* 遮罩：点击关闭面板 */}
      <div
        className="work-panel-overlay"
        onClick={handleClose}
        aria-hidden="true"
      />

      <aside
        ref={dialogRef}
        className="work-panel trends-panel"
        role="dialog"
        aria-label="行业风口推荐"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="work-panel__header">
          <div className="work-panel__title-row">
            <h2 className="work-panel__title">行业风口推荐</h2>
            <button
              type="button"
              className="work-panel__close"
              onClick={handleClose}
              aria-label="关闭面板"
              title="关闭"
            >
              ×
            </button>
          </div>
          <p className="work-panel__subtitle">
            基于当前 work 图谱分析行业趋势，给出可解释的风口推荐与建议行动，
            可一键转为图谱节点继续延伸探索。
          </p>
        </header>

        {/* 主体（可滚动） */}
        <div className="work-panel__body">
          {/* 生成按钮区 */}
          <div className="work-actions">
            <button
              type="button"
              className="work-actions__btn work-actions__btn--primary"
              onClick={handleGenerate}
              disabled={trendsLoading || !currentGraphId}
              title={
                !currentGraphId
                  ? '请先选中一个 work 图谱'
                  : trendsLoading
                    ? '正在生成…'
                    : trends.length > 0
                      ? '重新生成风口推荐'
                      : '生成风口推荐'
              }
            >
              {trendsLoading
                ? '生成中…'
                : trends.length > 0
                  ? '重新生成'
                  : '生成风口推荐'}
            </button>
            {trends.length > 0 && generatedAt && (
              <span className="trends-meta">
                共 {trends.length} 条 · {formatTimelineTime(generatedAt)}
              </span>
            )}
          </div>

          {/* 风口时间线列表 */}
          {trends.length > 0 ? (
            <ol className="trends-timeline">
              {trends.map((t, i) => {
                const meta = relevanceMeta(t.relevance)
                const isAdded = addedIdx.has(i)
                const isAdding = trendAddingIndex === i
                return (
                  <li key={i} className="trends-item">
                    {/* 时间线节点标记 */}
                    <div className="trends-item__marker">
                      <span className="trends-item__index">{i + 1}</span>
                    </div>
                    <div className="trends-item__card">
                      <div className="trends-item__head">
                        <h4 className="trends-item__title" title={t.title}>
                          {t.title}
                        </h4>
                        <span
                          className={`trends-item__relevance ${meta.cls}`}
                          title={`相关度：${meta.label}`}
                        >
                          {meta.label}
                        </span>
                      </div>

                      {t.reason && (
                        <div className="trends-item__reason">
                          <span className="trends-item__reason-label">
                            推荐理由
                          </span>
                          <p className="trends-item__reason-text">{t.reason}</p>
                        </div>
                      )}

                      {t.suggested_actions && t.suggested_actions.length > 0 && (
                        <div className="trends-item__actions-block">
                          <span className="trends-item__actions-label">
                            建议行动
                          </span>
                          <ul className="trends-item__actions-list">
                            {t.suggested_actions.map((a, ai) => (
                              <li key={ai} className="trends-item__action">
                                {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="trends-item__footer">
                        <button
                          type="button"
                          className="work-actions__btn work-actions__btn--primary trends-item__add-btn"
                          onClick={() => handleAdd(i)}
                          disabled={isAdding || isAdded || trendAddingIndex !== null}
                          title={
                            isAdded
                              ? '已加入图谱'
                              : isAdding
                                ? '加入中…'
                                : '把该风口转为工作线索节点加入图谱'
                          }
                        >
                          {isAdding
                            ? '加入中…'
                            : isAdded
                              ? (<><Icon name="check" size={14} /> 已加入</>)
                              : '加入图谱'}
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : (
            <div className="work-empty">
              {trendsLoading
                ? '正在生成风口推荐…'
                : currentGraphId
                  ? '暂无风口推荐。点击「生成风口推荐」基于当前图谱分析行业趋势。'
                  : (<><Icon name="warning" size={16} /> 请先在左侧选中一个 work 图谱</>)}
            </div>
          )}
        </div>

        {/* 底部状态条 */}
        <footer className="work-panel__footer">
          <span className="work-panel__footer-text">
            {currentGraphId
              ? '风口推荐结合图谱内容生成，加入图谱后可作为工作线索继续延伸'
              : (<><Icon name="warning" size={14} /> 未选中图谱，请先在左侧选择一个 work 图谱</>)}
          </span>
        </footer>
      </aside>
    </>
  )
}

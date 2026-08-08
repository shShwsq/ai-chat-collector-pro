/**
 * Work 工作对象抽取与入图面板（Task 13）。
 *
 * 从内容区右侧滑入的浮层，承载工作对象的两段式入图流程：
 *
 *   ① **文本输入与抽取**：用户在 textarea 粘贴 / 输入工作信息
 *      （会议纪要、周报、聊天记录、备忘等），点「抽取工作对象」调
 *      ``store.extractWorkObjects(text)`` → Agent 返回候选工作对象列表，
 *      每项含 ``title / summary / type / relations``。
 *
 *   ② **候选确认入图**：从 ``store.candidateWorkObjects`` 渲染候选卡片，
 *      每张含标题（可就地编辑）、子类型下拉（线索/关键人/承诺/…/复盘）、
 *      概括、关系列表（→ 目标对象 + 关系语义）。用户可勾选要入图的候选
 *      （默认全选），点「确认入图（N）」调 ``store.confirmWorkObjects(selected)``
 *      批量创建（归一去重 + 按 relation 建立边），成功后整图刷新。
 *
 * 数据流：
 * - 抽取不入图：``extractWorkObjects`` 仅返回候选列表，用户确认后才调
 *   ``confirmWorkObjects`` 真正落库，保留用户对 AI 结果的掌控。
 * - 入图后清空候选列表与输入文本，整图刷新并闪烁高亮新建节点。
 *
 * 交互：
 * - 面板由 ``store.workActivePanel === 'input'`` 控制显隐，关闭时滑出右侧。
 * - 抽取 / 入图进行中显示加载态并禁用按钮，避免并发触发。
 * - 降级（``degraded`` / 候选为空）时显示提示，鼓励用户手工添加。
 * - 候选项可单独编辑标题与子类型，便于在入图前纠正 Agent 抽取结果。
 * - 关系列表以「→ 目标（关系语义）」形式展示，让用户直观看到对象间关联。
 */

import { useEffect, useState } from 'react'

import { Icon } from '../Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useAppStore } from '../../store/useAppStore'
import {
  WORK_OBJECTS,
  WORK_OBJECT_LABELS,
} from '../../lib/nodeTemplates'
import type { CandidateWorkObject, WorkRelation } from '../../lib/types'

/** 关系语义中文映射（与后端 EDGE_RELATIONS 对齐）。 */
const RELATION_LABELS: Record<string, string> = {
  related: '相关',
  belongs_to: '属于',
  involves: '涉及',
  committed_to: '承诺给',
  depends_on: '依赖',
  waiting_for: '等待',
  influences: '影响',
  source_of: '来源',
  alternative_to: '替代',
  prerequisite: '前置',
  extends: '延伸',
}

/** 输入区示例文本（placeholder，引导用户输入工作信息）。 */
const SAMPLE_PLACEHOLDER = `在此粘贴工作信息文本，例如：

- 今天和王总开会，他承诺下周三前给出方案 B 的报价，我们需要依赖该报价才能推进合同。
- 风险：客户对交付时间敏感，若方案 B 延迟可能转向竞品。
- 决策：采用方案 A 作为兜底。`

/** 候选项本地编辑态：标题 + 子类型（按候选索引维护）。 */
interface CandidateEdit {
  title: string
  type: string
}

export function WorkInput() {
  const open = useAppStore((s) => s.workActivePanel === 'input')
  const setWorkPanel = useAppStore((s) => s.setWorkPanel)
  const candidateWorkObjects = useAppStore((s) => s.candidateWorkObjects)
  const workExtracting = useAppStore((s) => s.workExtracting)
  const workConfirming = useAppStore((s) => s.workConfirming)
  const extractWorkObjects = useAppStore((s) => s.extractWorkObjects)
  const confirmWorkObjects = useAppStore((s) => s.confirmWorkObjects)
  const clearCandidateWorkObjects = useAppStore((s) => s.clearCandidateWorkObjects)
  const currentGraphId = useAppStore((s) => s.currentGraphId)

  // 输入文本
  const [text, setText] = useState('')
  // 候选项选中态：key = 候选索引
  const [selectedIdx, setSelectedIdx] = useState<Set<number>>(new Set())
  // 候选项本地编辑态（标题 / 子类型），按索引存
  const [edits, setEdits] = useState<Record<number, CandidateEdit>>({})

  // 候选列表变化时默认全选并重置编辑态
  useEffect(() => {
    setSelectedIdx(new Set(candidateWorkObjects.map((_, i) => i)))
    setEdits({})
  }, [candidateWorkObjects])

  const allSelected =
    candidateWorkObjects.length > 0 &&
    selectedIdx.size === candidateWorkObjects.length
  const noneSelected = selectedIdx.size === 0

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIdx(new Set())
    } else {
      setSelectedIdx(new Set(candidateWorkObjects.map((_, i) => i)))
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

  const handleExtract = async () => {
    if (workExtracting || workConfirming) return
    await extractWorkObjects(text)
  }

  const handleEditTitle = (idx: number, title: string) => {
    setEdits((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], title },
    }))
  }

  const handleEditType = (idx: number, type: string) => {
    setEdits((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], type },
    }))
  }

  const handleClose = () => setWorkPanel('none')

  const handleClearCandidates = () => {
    clearCandidateWorkObjects()
  }

  // 组装确认入图的对象列表（合并本地编辑）
  const buildConfirmObjects = (): CandidateWorkObject[] => {
    const result: CandidateWorkObject[] = []
    selectedIdx.forEach((i) => {
      const c = candidateWorkObjects[i]
      if (!c) return
      const edit = edits[i]
      result.push({
        title: (edit?.title ?? c.title).trim() || c.title,
        summary: c.summary,
        type: edit?.type ?? c.type,
        relations: c.relations ?? [],
      })
    })
    return result
  }

  const handleConfirm = async () => {
    if (workConfirming || noneSelected) return
    const objects = buildConfirmObjects()
    const resp = await confirmWorkObjects(objects)
    if (resp) {
      // 入图成功后清空输入文本
      setText('')
    }
  }

  const dialogRef = useDialogFocus<HTMLElement>({
    active: open,
    initialFocus: '.work-textarea',
    onEscape: handleClose,
  })

  // Ctrl/Cmd + Enter 触发抽取
  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleExtract()
    }
  }

  if (!open) return null

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
        className="work-panel work-input-panel"
        role="dialog"
        aria-label="工作对象抽取与入图"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="work-panel__header">
          <div className="work-panel__title-row">
            <h2 className="work-panel__title">工作对象抽取</h2>
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
            粘贴工作信息文本，Agent 抽取工作对象（线索/关键人/承诺/风险等）并建立关系，
            确认后加入当前 work 图谱。
          </p>
        </header>

        {/* 主体（可滚动） */}
        <div className="work-panel__body">
          {/* ① 文本输入与抽取 */}
          <section className="work-section">
            <div className="work-section__head">
              <h3 className="work-section__title">工作信息输入</h3>
              <span className="work-section__hint">Ctrl + Enter 快速抽取</span>
            </div>

            <textarea
              className="work-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleTextKeyDown}
              placeholder={SAMPLE_PLACEHOLDER}
              rows={10}
              disabled={workExtracting || workConfirming}
              aria-label="工作信息文本"
            />

            <div className="work-actions">
              <button
                type="button"
                className="work-actions__btn work-actions__btn--primary"
                onClick={handleExtract}
                disabled={
                  workExtracting ||
                  workConfirming ||
                  !text.trim() ||
                  !currentGraphId
                }
                title={
                  !currentGraphId
                    ? '请先选中一个 work 图谱'
                    : !text.trim()
                      ? '请输入工作信息文本'
                      : '从文本抽取候选工作对象'
                }
              >
                {workExtracting ? '抽取中…' : '抽取工作对象'}
              </button>
              {candidateWorkObjects.length > 0 && (
                <button
                  type="button"
                  className="work-actions__btn work-actions__btn--ghost"
                  onClick={handleClearCandidates}
                  disabled={workExtracting || workConfirming}
                >
                  清空候选
                </button>
              )}
            </div>
          </section>

          {/* ② 候选工作对象确认 */}
          {candidateWorkObjects.length > 0 && (
            <section className="work-section">
              <div className="work-section__head">
                <h3 className="work-section__title">
                  候选工作对象
                  <span className="work-section__count">
                    {candidateWorkObjects.length}
                  </span>
                </h3>
                <button
                  type="button"
                  className="work-section__toggle"
                  onClick={toggleAll}
                  disabled={workConfirming}
                  title={allSelected ? '全不选' : '全选'}
                >
                  {allSelected ? '全不选' : '全选'}
                </button>
              </div>

              <ul className="work-cand-list">
                {candidateWorkObjects.map((c, i) => {
                  const checked = selectedIdx.has(i)
                  const edit = edits[i]
                  const title = edit?.title ?? c.title
                  const type = edit?.type ?? c.type
                  return (
                    <li
                      key={i}
                      className={`work-cand-item${checked ? ' is-checked' : ''}`}
                    >
                      <label className="work-cand-item__check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(i)}
                          disabled={workConfirming}
                        />
                      </label>
                      <div className="work-cand-item__main">
                        <div className="work-cand-item__title-row">
                          <input
                            className="work-cand-item__title"
                            value={title}
                            onChange={(e) => handleEditTitle(i, e.target.value)}
                            disabled={workConfirming}
                            title="点击编辑标题"
                          />
                          <select
                            className="work-cand-item__type-select"
                            value={type}
                            onChange={(e) => handleEditType(i, e.target.value)}
                            disabled={workConfirming}
                            title="选择工作对象子类型"
                          >
                            {WORK_OBJECTS.map((t) => (
                              <option key={t} value={t}>
                                {WORK_OBJECT_LABELS[t] ?? t}
                              </option>
                            ))}
                          </select>
                        </div>
                        {c.summary && (
                          <p className="work-cand-item__summary">{c.summary}</p>
                        )}
                        {c.relations && c.relations.length > 0 && (
                          <div className="work-cand-item__relations">
                            <span className="work-cand-item__relations-label">
                              关系：
                            </span>
                            <ul className="work-cand-item__relations-list">
                              {c.relations.map((r: WorkRelation, ri) => (
                                <li
                                  key={ri}
                                  className="work-cand-item__relation"
                                  title={`→ ${r.to_title}`}
                                >
                                  <span className="work-cand-item__relation-arrow">
                                    →
                                  </span>
                                  <span className="work-cand-item__relation-target">
                                    {r.to_title}
                                  </span>
                                  <span className="work-cand-item__relation-tag">
                                    {RELATION_LABELS[r.relation] ?? r.relation}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="work-actions">
                <button
                  type="button"
                  className="work-actions__btn work-actions__btn--primary"
                  onClick={handleConfirm}
                  disabled={workConfirming || noneSelected}
                  title={
                    noneSelected
                      ? '请至少勾选一个候选对象'
                      : `确认将选中的 ${selectedIdx.size} 个对象加入图谱`
                  }
                >
                  {workConfirming
                    ? '入图中…'
                    : `确认入图（${selectedIdx.size}）`}
                </button>
              </div>
            </section>
          )}

          {/* 抽取中且候选为空时显示加载态 */}
          {workExtracting && candidateWorkObjects.length === 0 && (
            <div className="work-empty">正在抽取候选工作对象…</div>
          )}

          {/* 未选中图谱提示 */}
          {!currentGraphId && (
            <div className="work-empty">
              <Icon name="warning" size={16} /> 请先在左侧选中一个 work 图谱
            </div>
          )}
        </div>

        {/* 底部状态条 */}
        <footer className="work-panel__footer">
          <span className="work-panel__footer-text">
            {currentGraphId
              ? '抽取后可编辑标题与子类型，确认入图将建立对象间关系'
              : (<><Icon name="warning" size={14} /> 未选中图谱，请先在左侧选择一个 work 图谱</>)}
          </span>
        </footer>
      </aside>
    </>
  )
}

// ============================================================================
// 备注：WORK_OBJECTS / WORK_OBJECT_LABELS 复用自 lib/nodeTemplates，
// 与后端 node_types.WORK_OBJECT_* 枚举一一对应，保证前后端语义一致。
// ============================================================================

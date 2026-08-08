/**
 * 高风险工具调用确认对话框（Task 10.5 + 本土化扩展）。
 *
 * 当 ``store.pendingToolConfirmation`` 非 null 时由 ChatPanel 渲染本组件：
 * - 显示工具名（如「从观察抽取节点」）+ 参数摘要；
 * - **图谱变化预览**（本土化扩展）：对 ``graph_confirm_work_objects`` 工具，
 *   从 ``args.objects`` 解析出待创建的节点 + 边，以表格形式预览，让用户在
 *   同意前清楚看到图谱将发生什么变化；
 * - **逐条确认**（本土化扩展）：当 ``store.workObjectSingleConfirm`` 开启时，
 *   每个工作对象前显示勾选框，用户可取消不想要的项；同意时通过
 *   ``modified_args`` 回传勾选后的 objects 子集，后端仅入图勾选项；
 * - 「同意」按钮调 store.confirmToolCall（可传 modifiedArgs）；
 * - 「拒绝」按钮 + 可选拒绝原因输入框调 store.rejectToolCall；
 * - 显示倒计时（基于 timeout 字段，到 0 时后端视为拒绝）。
 */

import { useEffect, useMemo, useState } from 'react'

import { useDialogFocus } from '../hooks/useDialogFocus'

import { useAppStore } from '../store/useAppStore'
import type { ToolConfirmation } from '../lib/types'

/** 工具名 → 中文友好名称映射。 */
const TOOL_NAME_LABEL: Record<string, string> = {
  graph_extract_from_observation: '从观察记录抽取节点入图',
  graph_confirm_work_objects: '工作对象批量入图',
  graph_query_nodes: '查询图谱节点',
  graph_get_node_detail: '获取节点详情',
  graph_get_context: '获取图谱上下文',
  graph_generate_quiz: '生成测验题',
  graph_generate_trends: '生成风口推荐',
  graph_generate_report: '生成工作报告',
}

/** 工具名 → 风险等级文案。 */
const TOOL_RISK_LABEL: Record<string, string> = {
  graph_extract_from_observation:
    '该操作会调用 LLM 从观察记录抽取节点并写入图谱，不可自动撤销',
  graph_confirm_work_objects:
    '该操作会批量创建工作对象节点与关系边到图谱，不可自动撤销',
}

/** 工作对象结构（graph_confirm_work_objects 的 args.objects 数组项）。 */
interface WorkObject {
  title: string
  summary?: string
  type?: string
  relations?: Array<{
    to_title?: string
    relation?: string
  }>
}

/** 从 args.objects 解析工作对象列表。 */
function parseWorkObjects(
  args: Record<string, unknown>,
): WorkObject[] {
  const raw = args.objects
  if (!Array.isArray(raw)) return []
  return raw
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      title: String(o.title ?? '').trim(),
      summary: o.summary != null ? String(o.summary) : undefined,
      type: o.type != null ? String(o.type) : undefined,
      relations: Array.isArray(o.relations)
        ? o.relations
            .filter(
              (r): r is Record<string, unknown> =>
                typeof r === 'object' && r !== null,
            )
            .map((r) => ({
              to_title: r.to_title != null ? String(r.to_title) : undefined,
              relation: r.relation != null ? String(r.relation) : undefined,
            }))
        : undefined,
    }))
    .filter((o) => o.title.length > 0)
}

/** 从工作对象列表推导出预览的边列表（from→to + relation）。 */
function deriveEdges(objects: WorkObject[]): Array<{
  from: string
  to: string
  relation: string
}> {
  const edges: Array<{ from: string; to: string; relation: string }> = []
  for (const obj of objects) {
    if (!obj.relations) continue
    for (const rel of obj.relations) {
      if (!rel.to_title) continue
      edges.push({
        from: obj.title,
        to: rel.to_title,
        relation: rel.relation || 'related',
      })
    }
  }
  return edges
}

/** 把工具参数对象格式化为简短可读字符串。 */
function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return '（无参数）'
  return entries
    .map(([k, v]) => {
      const valStr = typeof v === 'string' ? v : JSON.stringify(v)
      const truncated =
        valStr.length > 80 ? `${valStr.slice(0, 80)}…` : valStr
      return `${k}: ${truncated}`
    })
    .join('\n')
}

interface ToolConfirmDialogProps {
  /** 待确认的工具调用信息（来自 store.pendingToolConfirmation）。 */
  confirmation: ToolConfirmation
}

export function ToolConfirmDialog({ confirmation }: ToolConfirmDialogProps) {
  const confirmToolCall = useAppStore((s) => s.confirmToolCall)
  const rejectToolCall = useAppStore((s) => s.rejectToolCall)
  const workObjectSingleConfirm = useAppStore(
    (s) => s.workObjectSingleConfirm,
  )
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [remaining, setRemaining] = useState(confirmation.timeout)
  const dialogRef = useDialogFocus<HTMLDivElement>({
    initialFocus: '[data-dialog-initial="reject"]',
    resetKey: confirmation.request_id,
    onEscape: () => {
      if (!submitting) void rejectToolCall(reason.trim() || undefined)
    },
  })

  // 倒计时（每秒递减，到 0 停止）
  useEffect(() => {
    setRemaining(confirmation.timeout)
    const timer = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [confirmation.request_id, confirmation.timeout])

  // ---- 图谱变化预览数据（仅 graph_confirm_work_objects）----
  const workObjects = useMemo(
    () => parseWorkObjects(confirmation.args),
    [confirmation.args],
  )
  const previewEdges = useMemo(
    () => deriveEdges(workObjects),
    [workObjects],
  )
  const isWorkObjectsTool = confirmation.tool === 'graph_confirm_work_objects'

  // ---- 逐条确认：每项勾选状态 ----
  const [checkedSet, setCheckedSet] = useState<Set<number>>(new Set())
  useEffect(() => {
    // 新确认请求到来时重置勾选（默认全选）
    setCheckedSet(new Set(workObjects.map((_, i) => i)))
  }, [confirmation.request_id, workObjects])

  const checkedCount = checkedSet.size
  const allChecked = checkedCount === workObjects.length
  const noneChecked = checkedCount === 0

  const toggleItem = (idx: number) => {
    setCheckedSet((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }
  const toggleAll = () => {
    if (allChecked) setCheckedSet(new Set())
    else setCheckedSet(new Set(workObjects.map((_, i) => i)))
  }

  const handleApprove = async () => {
    if (submitting) return
    // 逐条确认 + 工作对象工具：回传勾选后的 objects 子集
    let modifiedArgs: Record<string, unknown> | undefined
    if (isWorkObjectsTool && workObjectSingleConfirm && workObjects.length > 0) {
      const selectedObjects = workObjects.filter((_, i) => checkedSet.has(i))
      if (selectedObjects.length === 0) return
      if (selectedObjects.length < workObjects.length) {
        modifiedArgs = {
          ...confirmation.args,
          objects: selectedObjects,
        }
      }
    }
    setSubmitting(true)
    await confirmToolCall(modifiedArgs)
    setSubmitting(false)
  }

  const handleReject = async () => {
    if (submitting) return
    setSubmitting(true)
    await rejectToolCall(reason.trim() || undefined)
    setSubmitting(false)
    setReason('')
  }

  const toolLabel = TOOL_NAME_LABEL[confirmation.tool] ?? confirmation.tool
  const riskLabel = TOOL_RISK_LABEL[confirmation.tool]
  const argsSummary = summarizeArgs(confirmation.args)
  const remainingSec = Math.max(0, remaining)

  // 逐条确认模式下的同意按钮文案
  const approveBtnLabel = (() => {
    if (submitting) return '处理中…'
    if (isWorkObjectsTool && workObjectSingleConfirm && workObjects.length > 0) {
      return noneChecked
        ? '请至少勾选一项'
        : `同意入图 ${checkedCount}/${workObjects.length} 项`
    }
    return '同意执行'
  })()

  return (
    <div
      className="tool-confirm-overlay"
      role="presentation"
    >
      <div
        className="tool-confirm-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-confirm-title"
        aria-describedby="tool-confirm-description"
        tabIndex={-1}
      >
        <header className="tool-confirm__header">
          <h3 id="tool-confirm-title" className="tool-confirm__title">
            高风险操作确认
          </h3>
          <span
            className={`tool-confirm__countdown${
              remainingSec <= 10 ? ' is-urgent' : ''
            }`}
            title={`后端将在 ${confirmation.timeout} 秒后视为拒绝`}
          >
            剩余 {remainingSec}s
          </span>
        </header>

        <div className="tool-confirm__body">
          <p id="tool-confirm-description" className="tool-confirm__desc">
            Agent 想调用以下工具，该操作可能修改图谱数据，请确认是否允许执行。
          </p>

          <dl className="tool-confirm__info">
            <div className="tool-confirm__info-row">
              <dt>工具</dt>
              <dd>
                <code className="tool-confirm__tool-name">{confirmation.tool}</code>
                <span className="tool-confirm__tool-label">{toolLabel}</span>
              </dd>
            </div>
            <div className="tool-confirm__info-row">
              <dt>参数</dt>
              <dd>
                <pre className="tool-confirm__args">{argsSummary}</pre>
              </dd>
            </div>
            {riskLabel && (
              <div className="tool-confirm__info-row">
                <dt>风险</dt>
                <dd className="tool-confirm__risk">{riskLabel}</dd>
              </div>
            )}
          </dl>

          {/* ---- 图谱变化预览（仅 graph_confirm_work_objects）---- */}
          {isWorkObjectsTool && workObjects.length > 0 && (
            <GraphChangePreview
              objects={workObjects}
              edges={previewEdges}
              singleConfirm={workObjectSingleConfirm}
              checkedSet={checkedSet}
              onToggleItem={toggleItem}
              onToggleAll={toggleAll}
              allChecked={allChecked}
            />
          )}

          {/* ---- 抽取节点工具提示（无法预览具体节点）---- */}
          {confirmation.tool === 'graph_extract_from_observation' && (
            <div className="tool-confirm__preview-note">
              <span className="tool-confirm__preview-note-icon" aria-hidden="true">
                ℹ
              </span>
              具体抽取的节点将由 LLM 在执行时生成，无法在此预览。
              同意后 Agent 将从观察记录中抽取候选节点并写入图谱。
            </div>
          )}

          <label className="tool-confirm__reason-label">
            拒绝原因（可选）
            <textarea
              className="tool-confirm__reason-input"
              name="rejectReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：暂不希望抽取节点 / 抽取依据不充分…"
              rows={2}
              disabled={submitting}
            />
          </label>
        </div>

        <footer className="tool-confirm__footer">
          <button
            type="button"
            className="tool-confirm__btn tool-confirm__btn--reject"
            data-dialog-initial="reject"
            onClick={handleReject}
            disabled={submitting}
            title="拒绝执行，agent 将收到原因并调整后续对话"
          >
            {submitting ? '处理中…' : '拒绝'}
          </button>
          <button
            type="button"
            className="tool-confirm__btn tool-confirm__btn--approve"
            onClick={handleApprove}
            disabled={
              submitting ||
              (isWorkObjectsTool &&
                workObjectSingleConfirm &&
                workObjects.length > 0 &&
                noneChecked)
            }
            title="同意执行，结果回填给 agent 继续"
          >
            {approveBtnLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ============================================================================
// 图谱变化预览子组件（节点 + 边表格）
// ============================================================================

interface GraphChangePreviewProps {
  objects: WorkObject[]
  edges: Array<{ from: string; to: string; relation: string }>
  singleConfirm: boolean
  checkedSet: Set<number>
  onToggleItem: (idx: number) => void
  onToggleAll: () => void
  allChecked: boolean
}

function GraphChangePreview({
  objects,
  edges,
  singleConfirm,
  checkedSet,
  onToggleItem,
  onToggleAll,
  allChecked,
}: GraphChangePreviewProps) {
  return (
    <div className="graph-preview">
      <div className="graph-preview__header">
        <span className="graph-preview__title">图谱变化预览</span>
        <span className="graph-preview__summary">
          将创建 {objects.length} 个节点
          {edges.length > 0 && `、${edges.length} 条边`}
        </span>
        {singleConfirm && objects.length > 0 && (
          <label className="graph-preview__check-all">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={onToggleAll}
            />
            全选
          </label>
        )}
      </div>

      {/* 节点表格 */}
      <div className="graph-preview__section">
        <h4 className="graph-preview__section-title">
          节点（{objects.length}）
        </h4>
        <div className="graph-preview__table">
          <div className="graph-preview__row graph-preview__row--head">
            {singleConfirm && <div className="graph-preview__cell graph-preview__cell--check" />}
            <div className="graph-preview__cell graph-preview__cell--title">标题</div>
            <div className="graph-preview__cell graph-preview__cell--type">类型</div>
            <div className="graph-preview__cell graph-preview__cell--summary">摘要</div>
          </div>
          {objects.map((obj, i) => (
            <div
              key={i}
              className={`graph-preview__row${
                singleConfirm && !checkedSet.has(i)
                  ? ' graph-preview__row--unchecked'
                  : ''
              }`}
            >
              {singleConfirm && (
                <div className="graph-preview__cell graph-preview__cell--check">
                  <input
                    type="checkbox"
                    checked={checkedSet.has(i)}
                    onChange={() => onToggleItem(i)}
                  />
                </div>
              )}
              <div
                className="graph-preview__cell graph-preview__cell--title"
                title={obj.title}
              >
                {obj.title}
              </div>
              <div className="graph-preview__cell graph-preview__cell--type">
                {obj.type || '—'}
              </div>
              <div
                className="graph-preview__cell graph-preview__cell--summary"
                title={obj.summary || ''}
              >
                {obj.summary
                  ? obj.summary.length > 40
                    ? `${obj.summary.slice(0, 40)}…`
                    : obj.summary
                  : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 边列表 */}
      {edges.length > 0 && (
        <div className="graph-preview__section">
          <h4 className="graph-preview__section-title">
            关系边（{edges.length}）
          </h4>
          <ul className="graph-preview__edges">
            {edges.map((e, i) => (
              <li key={i} className="graph-preview__edge">
                <span className="graph-preview__edge-node">{e.from}</span>
                <span className="graph-preview__edge-rel">{e.relation}</span>
                <span className="graph-preview__edge-arrow" aria-hidden="true">→</span>
                <span className="graph-preview__edge-node">{e.to}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

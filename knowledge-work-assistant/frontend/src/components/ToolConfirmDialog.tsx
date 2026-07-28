/**
 * 高风险工具调用确认对话框（Task 10.5）。
 *
 * 当 store.pendingToolConfirmation 非 null 时由 ChatPanel 渲染本组件：
 * - 显示工具名（如「从观察抽取节点」）+ 参数摘要；
 * - 「同意」按钮调 store.confirmToolCall；
 * - 「拒绝」按钮 + 可选拒绝原因输入框调 store.rejectToolCall；
 * - 显示倒计时（基于 timeout 字段，到 0 时后端视为拒绝）。
 *
 * 设计要点：
 * - 全屏遮罩 + 居中卡片，强制用户作出选择（高风险操作不容许默认放行）；
 * - 拒绝原因可选，但填入后会让 agent 据此调整后续对话；
 * - 倒计时归零时本地仍保持对话框，等待后端推送 cancelled 事件；
 *   后端会在 60s 超时后视为拒绝并回填「用户未响应，视为拒绝」。
 */

import { useEffect, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { ToolConfirmation } from '../lib/types'

/** 工具名 → 中文友好名称映射。 */
const TOOL_NAME_LABEL: Record<string, string> = {
  graph_extract_from_observation: '从观察记录抽取节点入图',
  graph_query_nodes: '查询图谱节点',
  graph_get_node_detail: '获取节点详情',
  graph_get_context: '获取图谱上下文',
  graph_generate_quiz: '生成测验题',
  graph_generate_trends: '生成风口推荐',
  graph_generate_report: '生成工作报告',
}

/** 工具名 → 风险等级文案。 */
const TOOL_RISK_LABEL: Record<string, string> = {
  graph_extract_from_observation: '该操作会向图谱写入新节点，不可自动撤销',
}

/** 把工具参数对象格式化为简短可读字符串。 */
function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return '（无参数）'
  return entries
    .map(([k, v]) => {
      const valStr =
        typeof v === 'string' ? v : JSON.stringify(v)
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
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [remaining, setRemaining] = useState(confirmation.timeout)

  // 倒计时（每秒递减，到 0 停止）
  useEffect(() => {
    setRemaining(confirmation.timeout)
    const timer = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [confirmation.request_id, confirmation.timeout])

  const handleApprove = async () => {
    if (submitting) return
    setSubmitting(true)
    await confirmToolCall()
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

  return (
    <div
      className="tool-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tool-confirm-title"
    >
      <div className="tool-confirm-dialog">
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
          <p className="tool-confirm__desc">
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

          <label className="tool-confirm__reason-label">
            拒绝原因（可选）
            <textarea
              className="tool-confirm__reason-input"
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
            disabled={submitting}
            title="同意执行，结果回填给 agent 继续"
          >
            {submitting ? '处理中…' : '同意执行'}
          </button>
        </footer>
      </div>
    </div>
  )
}

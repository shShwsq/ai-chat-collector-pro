/**
 * 应用内确认弹窗（Task 9.2）。
 *
 * 用于删除节点等危险操作的二次确认，替代 ``window.confirm``：
 * - 模态遮罩 + 居中卡片，点击遮罩或按 Esc 取消
 * - ``danger`` 模式下确认按钮走红色强调，提示风险
 * - ``confirmPhrase`` 传入后启用 type-to-confirm：需在输入框键入指定文字
 *   （如「清空」）确认按钮才可点击，防误操作（用于不可逆的批量清空）
 * - ``onExport`` 传入后在按钮区多渲染一个次要「导出备份」按钮
 *   （满足「清空前提示导出」诉求，不强制）
 * - 内容受控（``open``），由父组件控制显隐
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ConfirmDialogProps {
  /** 是否显示。 */
  open: boolean
  /** 标题。 */
  title: string
  /** 正文说明。 */
  message: string
  /** 确认按钮文案，默认「确认」。 */
  confirmText?: string
  /** 取消按钮文案，默认「取消」。 */
  cancelText?: string
  /** 是否为危险操作（确认按钮走红色）。 */
  danger?: boolean
  /** 启用 type-to-confirm：用户需在输入框键入该文字确认按钮才启用。
   *  不传则不显示输入框，确认按钮始终启用（向后兼容）。 */
  confirmPhrase?: string
  /** 输入框上方提示文案，默认「请键入 {confirmPhrase} 以确认」。 */
  confirmPhraseLabel?: string
  /** 传入则渲染一个次要「导出备份」按钮（清空前提示导出，不强制）。 */
  onExport?: () => void
  /** 导出按钮文案，默认「导出备份」。 */
  exportText?: string
  /** 正文与按钮区之间的额外内容（如勾选项），可选。 */
  extra?: ReactNode
  /** 点击确认回调。 */
  onConfirm: () => void
  /** 点击取消 / 遮罩 / Esc 回调。 */
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  confirmPhrase,
  confirmPhraseLabel,
  onExport,
  exportText = '导出备份',
  extra,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const [phraseInput, setPhraseInput] = useState('')

  const phraseOk = !confirmPhrase || phraseInput === confirmPhrase

  // 打开时记录触发元素、重置输入、聚焦首个可交互元素
  useEffect(() => {
    if (!open) return
    triggerRef.current = document.activeElement as HTMLElement | null
    setPhraseInput('')
    // 下一帧聚焦，确保 DOM 已渲染
    requestAnimationFrame(() => {
      if (confirmPhrase) {
        inputRef.current?.focus()
      } else {
        dialogRef.current
          ?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
      }
    })
    return () => triggerRef.current?.focus()
  }, [open, confirmPhrase])

  // Esc 关闭 + Tab 焦点陷阱
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onCancel()
      }
      if (ev.key !== 'Tab' || !dialogRef.current) return
      // 焦点陷阱含按钮与输入框
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ),
      )
      if (focusable.length < 2) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault()
        last.focus()
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onClick={onCancel}
    >
      <div
        className="confirm-dialog"
        ref={dialogRef}
        onClick={(ev) => ev.stopPropagation()}
      >
        <h3 id="confirm-title" className="confirm-dialog__title">
          {title}
        </h3>
        <p className="confirm-dialog__message">{message}</p>

        {confirmPhrase && (
          <div className="confirm-dialog__phrase">
            <label className="confirm-dialog__phrase-label" htmlFor="confirm-phrase-input">
              {confirmPhraseLabel ?? `请键入「${confirmPhrase}」以确认`}
            </label>
            <input
              id="confirm-phrase-input"
              ref={inputRef}
              className="confirm-dialog__phrase-input"
              type="text"
              value={phraseInput}
              onChange={(e) => setPhraseInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={confirmPhrase}
            />
          </div>
        )}

        {extra && <div className="confirm-dialog__extra">{extra}</div>}

        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--ghost"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          {onExport && (
            <button
              type="button"
              className="confirm-dialog__btn confirm-dialog__btn--export"
              onClick={onExport}
            >
              {exportText}
            </button>
          )}
          <button
            type="button"
            className={`confirm-dialog__btn confirm-dialog__btn--primary${
              danger ? ' is-danger' : ''
            }`}
            onClick={onConfirm}
            disabled={!phraseOk}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

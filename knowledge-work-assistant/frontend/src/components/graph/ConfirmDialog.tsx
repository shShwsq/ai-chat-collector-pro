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

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { useDialogFocus } from '../../hooks/useDialogFocus'

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
  const titleId = useId()
  const descriptionId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [phraseInput, setPhraseInput] = useState('')
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: open,
    initialFocus: confirmPhrase
      ? '[data-dialog-initial="phrase"]'
      : '[data-dialog-initial="cancel"]',
    onEscape: onCancel,
  })

  const phraseOk = !confirmPhrase || phraseInput === confirmPhrase

  useEffect(() => {
    if (!open) return
    setPhraseInput('')
  }, [open])

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="confirm-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="confirm-dialog__title">
          {title}
        </h3>
        <p id={descriptionId} className="confirm-dialog__message">{message}</p>

        {confirmPhrase && (
          <div className="confirm-dialog__phrase">
            <label className="confirm-dialog__phrase-label" htmlFor="confirm-phrase-input">
              {confirmPhraseLabel ?? `请键入「${confirmPhrase}」以确认`}
            </label>
            <input
              id="confirm-phrase-input"
              ref={inputRef}
              data-dialog-initial="phrase"
              className="confirm-dialog__phrase-input"
              type="text"
              name="confirmPhrase"
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
            data-dialog-initial="cancel"
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

/**
 * 应用内确认弹窗（Task 9.2）。
 *
 * 用于删除节点等危险操作的二次确认，替代 ``window.confirm``：
 * - 模态遮罩 + 居中卡片，点击遮罩或按 Esc 取消
 * - ``danger`` 模式下确认按钮走红色强调，提示风险
 * - 内容受控（``open``），由父组件控制显隐
 */

import { useEffect } from 'react'

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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onCancel()
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
        onClick={(ev) => ev.stopPropagation()}
      >
        <h3 id="confirm-title" className="confirm-dialog__title">
          {title}
        </h3>
        <p className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--ghost"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn confirm-dialog__btn--primary${
              danger ? ' is-danger' : ''
            }`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 全局 Toast 提示组件（Task 8 / Task 11 通用反馈）。
 *
 * 消费 ``store.toast`` 状态，在屏幕底部居中展示一条轻量提示：
 * - ``success``：绿色（延伸成功 / 入图成功 / 撤销成功）
 * - ``info``：中性灰（已存在节点高亮 / 未生成延伸节点等中性反馈）
 * - ``warning``：琥珀色（降级路径 / 未选中图谱 / 候选为空）
 * - ``error``：红色（延伸失败 / 抽取失败 / 入图失败）
 *
 * 交互：
 * - 自动消失：3.2s 后自动清空（``store.clearToast``）
 * - 手动关闭：点击 × 按钮立即清空
 * - 鼠标悬停时暂停自动消失（便于阅读长消息）
 *
 * 实现：受控于 store，组件本身仅负责渲染与计时；
 * 同一时间仅显示一条（后到的覆盖前一条，由 store 的 id 自增保证 React key 变化）。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Icon } from './Icon'
import { useAppStore } from '../store/useAppStore'
import type { ToastType } from '../store/useAppStore'

/** 自动消失时长（ms）。 */
const AUTO_DISMISS_MS = 3200

/** 类型 → 图标（SVG，避免使用 emoji）。 */
const TYPE_ICON: Record<ToastType, ReactNode> = {
  success: <Icon name="check" size={16} />,
  info: 'i',
  warning: '!',
  error: '×',
}

export function Toast() {
  const toast = useAppStore((s) => s.toast)
  const clearToast = useAppStore((s) => s.clearToast)
  const [hovered, setHovered] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!toast || hovered) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      clearToast()
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [toast, hovered, clearToast])

  if (!toast) return null

  const type = toast.type
  const icon = TYPE_ICON[type]

  return (
    <div
      className={`toast toast--${type}`}
      role="status"
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      key={toast.id}
    >
      <span className="toast__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="toast__msg">{toast.message}</span>
      <button
        type="button"
        className="toast__close"
        onClick={clearToast}
        aria-label="关闭提示"
        title="关闭"
      >
        ×
      </button>
    </div>
  )
}

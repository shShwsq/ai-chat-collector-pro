import { useLayoutEffect, useRef } from 'react'

interface Options {
  /** 最大高度(px),超过后内部滚动。默认 120 */
  maxHeight?: number
}

/**
 * 让 textarea 随内容自动撑高，达到 maxHeight 后内部滚动。
 *
 * 用法：
 * ```ts
 * const ref = useAutoGrowTextarea<HTMLTextAreaElement>(value, { maxHeight: 120 })
 * return <textarea ref={ref} ... />
 * ```
 *
 * 注意：textarea 自身需设置 `resize: none` 和 `min-height`，撑高逻辑只控制
 * `height`（从 `auto` 重算 `scrollHeight`，再 clamp 到 `[min, maxHeight]`）。
 */
export function useAutoGrowTextarea<T extends HTMLTextAreaElement>(
  value: string,
  options: Options = {},
) {
  const { maxHeight = 120 } = options
  const ref = useRef<T>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 先重置为 auto，才能让 scrollHeight 反映真实内容高度
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    // 超过上限时启用滚动条，否则隐藏（避免短内容出现空滚动条）
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, maxHeight])

  return ref
}

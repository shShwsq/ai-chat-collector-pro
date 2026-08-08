import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface DialogFocusOptions {
  active?: boolean
  initialFocus?: string
  resetKey?: string
  onEscape: () => void
}

export function useDialogFocus<T extends HTMLElement>({
  active = true,
  initialFocus,
  resetKey,
  onEscape,
}: DialogFocusOptions): RefObject<T> {
  const dialogRef = useRef<T>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  useEffect(() => {
    if (!active) return

    triggerRef.current = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const target = initialFocus
        ? dialogRef.current?.querySelector<HTMLElement>(initialFocus)
        : dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      target?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        escapeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const trigger = triggerRef.current
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      if (trigger?.isConnected) trigger.focus()
    }
  }, [active, initialFocus, resetKey])

  return dialogRef
}

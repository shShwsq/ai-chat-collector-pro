/**
 * Study / Work 模式切换开关（Task 3）。
 *
 * 右上角胶囊式二选一切换器：
 * - 当前模式高亮（深色文字 + 强调色副标题），未选中模式为次要色
 * - 滑动指示器（``mode-switch__indicator``）用 CSS transform 平滑过渡，
 *   280ms cubic-bezier，无 JS 动画库依赖
 * - 强调色随当前模式切换（study 墨绿 / work 琥珀），通过
 *   ``.app-shell[data-mode]`` 上的 CSS 变量 ``--accent`` 联动
 *
 * 切换由 ``useAppStore.setMode`` 触发，store 内部会清空当前选中并加载新模式图谱。
 *
 * 模式切换的横向"推出"过渡用 View Transitions API 实现：
 * - ``document.startViewTransition`` 捕获新旧 DOM 快照（旧模式内容 + 新模式内容），
 *   分别对 ``::view-transition-old`` / ``::view-transition-new`` 应用滑出/滑入动画，
 *   实现"旧内容向一侧推出 + 新内容从另一侧推入"的轮播效果。
 * - 方向通过 ``document.documentElement.dataset.modeTransition`` 标记：
 *   · study→work（to-work）：旧 study 向左滑出，新 work 从右滑入
 *   · work→study（to-study）：旧 work 向右滑出，新 study 从左滑入
 * - 时长 280ms，与 ``.mode-switch__indicator`` 的 transform 过渡一致。
 * - 不支持 View Transitions API 的浏览器降级为直接切换（无动画）。
 * - 用 ``flushSync`` 强制 React 同步提交 DOM，确保 startViewTransition
 *   回调中能捕获到新模式渲染后的状态。
 */

import { flushSync } from 'react-dom'

import { useAppStore } from '../store/useAppStore'
import type { Mode } from '../lib/types'

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: 'study', label: '学习', desc: 'Study' },
  { value: 'work', label: '工作', desc: 'Work' },
]

/** startViewTransition 的最小类型声明（兼容旧浏览器）。 */
type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

export function ModeSwitch() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)

  const handleModeChange = (newMode: Mode) => {
    if (newMode === mode) return
    const doc = document as ViewTransitionDoc
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion && typeof doc.startViewTransition === 'function') {
      // 标记方向，供 ::view-transition-old/new 选择对应动画
      document.documentElement.dataset.modeTransition =
        newMode === 'work' ? 'to-work' : 'to-study'
      const transition = doc.startViewTransition.call(doc, () => {
        // flushSync 强制 React 同步提交，确保快照捕获到新模式 DOM
        flushSync(() => {
          setMode(newMode)
        })
      })
      transition.finished.finally(() => {
        delete document.documentElement.dataset.modeTransition
      })
    } else {
      setMode(newMode)
    }
  }

  return (
    <div className="mode-switch" aria-label="模式切换：学习 / 工作" data-mode={mode}>
      <span className="mode-switch__indicator" aria-hidden="true" />
      {MODES.map((m) => {
        const active = mode === m.value
        return (
          <button
            key={m.value}
            type="button"
            aria-pressed={active}
            className={`mode-switch__btn${active ? ' is-active' : ''}`}
            onClick={() => handleModeChange(m.value)}
          >
            <span className="mode-switch__btn-label">{m.label}</span>
            <span className="mode-switch__btn-desc">{m.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

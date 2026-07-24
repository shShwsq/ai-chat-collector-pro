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
 */

import { useAppStore } from '../store/useAppStore'
import type { Mode } from '../lib/types'

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: 'study', label: '学习', desc: 'Study' },
  { value: 'work', label: '工作', desc: 'Work' },
]

export function ModeSwitch() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)

  return (
    <div
      className="mode-switch"
      role="tablist"
      aria-label="模式切换：学习 / 工作"
      data-mode={mode}
    >
      <span className="mode-switch__indicator" aria-hidden="true" />
      {MODES.map((m) => {
        const active = mode === m.value
        return (
          <button
            key={m.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`mode-switch__btn${active ? ' is-active' : ''}`}
            onClick={() => setMode(m.value)}
          >
            <span className="mode-switch__btn-label">{m.label}</span>
            <span className="mode-switch__btn-desc">{m.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

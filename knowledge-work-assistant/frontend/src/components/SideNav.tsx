/**
 * 左侧竖排导航条。
 *
 * 替换原 GraphList 顶部位置作为最左侧固定窄栏（56px 宽），结构分为两组：
 *
 *   顶部主导航（``side-nav__main``）：
 *   ① **对话**（chat）— 切换到 ChatPanel（Work 模式复用 QAPanel，Study 模式提示
 *      对话采集通过浏览器插件完成，待抽取对话在图谱视图中查看）
 *      右上角预留红点角标 slot（``side-nav__badge``），数字由 ``store.reminderCount``
 *      提供，默认 0 不显示；后续 Task 8 会写入实际待处理提醒数量。
 *   ② **图谱**（graph）— 切换回原 GraphList + content-area 主内容区，保持现有功能
 *
 *   底部独立项（``side-nav__bottom``，通过 ``margin-top: auto`` 推到导航条最底部）：
 *   ③ **设置**（settings）— 切换到 SettingsPanel，配置 LLM API 与查看 / 取消
 *      正在进行或队列中的 LLM 请求
 *      上方有分隔线（``side-nav__divider``）与主导航视觉区分。
 *
 * 视觉：
 * - 当前选中项左侧 3px 强调色色条 + 浅色背景；
 * - 未选中项 hover 时浅灰背景；
 * - 图标使用 inline SVG（不依赖外部图标库），24x24，stroke=currentColor；
 * - 按钮下方显示中文标签（11px），便于辨识。
 *
 * 数据：
 * - 当前激活项由 ``store.activeNav`` 管理（'chat' | 'graph' | 'settings'）；
 * - 切换调用 ``store.setActiveNav``，store 内部进入 'settings' 时会懒加载
 *   LLM 配置与请求列表；
 * - 红点角标计数由 ``store.reminderCount`` 提供（0 不显示）。
 */

import { useAppStore } from '../store/useAppStore'
import type { ActiveNav } from '../store/useAppStore'

/** 导航项配置：value 用于切换 / icon 渲染 SVG 路径 / label 显示中文标签。 */
interface NavItem {
  value: ActiveNav
  label: string
  /** SVG 路径数据（24x24 viewBox 内的 path d 属性）。 */
  icon: React.ReactNode
}

/** 对话图标：圆角气泡 + 三点。 */
function ChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
      <circle cx="9" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 图谱图标：三个节点 + 连线。 */
function GraphIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M6.7 7.4 10.6 16" />
      <path d="M17.3 7.4 13.4 16" />
      <path d="M7 6h10" />
    </svg>
  )
}

/** 设置图标：齿轮。 */
function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/** 顶部主导航项配置表（对话 / 图谱）。 */
const MAIN_ITEMS: NavItem[] = [
  { value: 'chat', label: '对话', icon: <ChatIcon /> },
  { value: 'graph', label: '图谱', icon: <GraphIcon /> },
]

/** 底部独立项配置表（设置，通过 margin-top: auto 推到导航条最底部）。 */
const BOTTOM_ITEMS: NavItem[] = [
  { value: 'settings', label: '设置', icon: <SettingsIcon /> },
]

export function SideNav() {
  const activeNav = useAppStore((s) => s.activeNav)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  // 「对话」红点角标计数（0 不显示），后续 Task 8 会写入实际数量
  const reminderCount = useAppStore((s) => s.reminderCount) ?? 0

  return (
    <nav
      className="side-nav"
      aria-label="主导航：对话 / 图谱 / 设置"
    >
      <div className="side-nav__main">
        {MAIN_ITEMS.map((item) => {
          const active = item.value === activeNav
          return (
            <button
              key={item.value}
              type="button"
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              className={`side-nav__btn${active ? ' is-active' : ''}`}
              onClick={() => setActiveNav(item.value)}
            >
              <span className="side-nav__icon">{item.icon}</span>
              <span className="side-nav__label">{item.label}</span>
              {/* 「对话」右上角红点角标 slot（count > 0 时显示） */}
              {item.value === 'chat' && reminderCount > 0 && (
                <span className="side-nav__badge" aria-label={`${reminderCount} 条未读提醒`}>
                  {reminderCount > 99 ? '99+' : reminderCount}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="side-nav__bottom">
        <div className="side-nav__divider" />
        {BOTTOM_ITEMS.map((item) => {
          const active = item.value === activeNav
          return (
            <button
              key={item.value}
              type="button"
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
              className={`side-nav__btn${active ? ' is-active' : ''}`}
              onClick={() => setActiveNav(item.value)}
            >
              <span className="side-nav__icon">{item.icon}</span>
              <span className="side-nav__label">{item.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

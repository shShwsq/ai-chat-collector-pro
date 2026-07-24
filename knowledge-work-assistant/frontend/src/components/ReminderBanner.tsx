/**
 * 提醒横幅（对话首页顶部）。
 *
 * 当 ``reminderCount > 0`` 时显示一条橙色横条，提示"N 项提醒已到期"，
 * 右侧带"查看"按钮；点击整个横幅（包括按钮）均触发 ``onClick``。
 *
 * 用法：由 ``ChatHome`` 读取 store 的 ``reminderCount`` 后渲染，
 * 点击通常滚动到第一个到期卡片或跳转图谱视图。
 */

/** 铃铛 SVG 图标（左侧提示图标，inline SVG，无外部依赖）。 */
function BellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

export interface ReminderBannerProps {
  /** 到期提醒数量（>0 时才渲染本组件）。 */
  count: number
  /** 横幅点击回调。 */
  onClick: () => void
}

export function ReminderBanner({ count, onClick }: ReminderBannerProps) {
  if (count <= 0) return null

  return (
    <div
      className="reminder-banner"
      onClick={onClick}
      role="button"
      tabIndex={0}
      title="查看到期提醒"
    >
      <span className="reminder-banner__icon">
        <BellIcon />
      </span>
      <span className="reminder-banner__text">
        <span className="reminder-banner__count">{count}</span>
        项提醒已到期
      </span>
      <span className="reminder-banner__action">查看</span>
    </div>
  )
}

export default ReminderBanner

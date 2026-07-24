/**
 * 推荐卡片（对话首页瀑布流单元）。
 *
 * 展示单条 ``RecommendationItem``：
 * - 顶部：节点标题 + 类型标签（小圆角 chip）
 * - 中部：推荐理由（灰色小字）
 * - 底部信息行（按 ``mode`` 感知）：
 *   - study 模式：上次复习时间（``days_since_review`` 为 null 显示"未复习"，
 *     否则"N 天前"） + 错误率徽标（``error_rate * 100%``，>50% 红色背景）
 *   - work 模式：提醒时间（``node.remind_at`` 格式化为"MM/DD HH:mm"，
 *     到期标红） + 星标图标（``node.is_starred`` 实心星）
 * - 到期（``is_overdue``）：整卡左边框红色 + 浅红背景
 * - 临近（``is_upcoming``）：左边框橙色
 * - 悬停：上浮 + 阴影；点击：调用 ``onClick``
 *
 * 图标全部使用 inline SVG，不依赖外部图标库。
 */

import type { RecommendationItem } from '../lib/types'

export interface RecommendationCardProps {
  /** 推荐项数据。 */
  item: RecommendationItem
  /** 当前模式：study 学习 / work 工作，决定底部信息行渲染策略。 */
  mode: 'study' | 'work'
  /** 卡片点击回调（通常为跳转图谱视图并选中该节点）。 */
  onClick: () => void
}

/** 把 ISO 时间字符串格式化为 "MM/DD HH:mm"，解析失败时回退原值。 */
function formatRemindAt(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

/** 实心星标 SVG（node.is_starred=true 时显示）。 */
function StarIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  )
}

export function RecommendationCard({ item, mode, onClick }: RecommendationCardProps) {
  const { node, reason, is_overdue, is_upcoming, error_rate, days_since_review } = item

  // 卡片样式类：到期 / 临近分别加修饰类
  const cardCls = [
    'rec-card',
    is_overdue ? 'rec-card--overdue' : '',
    is_upcoming ? 'rec-card--upcoming' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 错误率百分比（study 模式）
  const errorPct = Math.round(error_rate * 100)
  const errorHigh = errorPct > 50

  // 复习时间文案（study 模式）
  const reviewText =
    days_since_review == null ? '未复习' : `${days_since_review} 天前`

  // 提醒时间文案（work 模式）
  const remindText = formatRemindAt(node.remind_at)

  return (
    <article className={cardCls} onClick={onClick} role="button" tabIndex={0}>
      {/* 顶部：标题 + 类型标签 */}
      <div className="rec-card__head">
        <span className="rec-card__title" title={node.title}>
          {node.title || '（无标题）'}
        </span>
        <span className="rec-card__tag">{node.type || '未分类'}</span>
      </div>

      {/* 中部：推荐理由 */}
      {reason && <p className="rec-card__reason">{reason}</p>}

      {/* 底部信息行（mode 感知） */}
      <div className="rec-card__meta">
        {mode === 'study' ? (
          <>
            <span className="rec-card__meta-text">{reviewText}</span>
            <span
              className={`rec-card__error-badge${errorHigh ? ' is-high' : ''}`}
              title={`错误率 ${errorPct}%`}
            >
              错误率 {errorPct}%
            </span>
          </>
        ) : (
          <>
            <span
              className={`rec-card__meta-text${is_overdue ? ' is-overdue' : ''}`}
            >
              {remindText ? `提醒 ${remindText}` : '无提醒'}
            </span>
            {node.is_starred && (
              <span className="rec-card__star" title="已星标">
                <StarIcon />
              </span>
            )}
          </>
        )}
      </div>
    </article>
  )
}

export default RecommendationCard

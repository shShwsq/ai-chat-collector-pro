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
 * 交互增强（对话首页改造）：
 * - ``enterDelay`` / ``enterDuration``：mount 时飞入动画的延迟与时长，
 *   由父组件 ChatHome 为每张卡片算出不均匀值（先有先后、有快有慢）。
 * - ``isDimmed``：其他卡片被展开为大卡时，本卡加高斯模糊 + 半透明。
 * - ``forwardRef``：暴露 article DOM，供父组件做 FLIP First 测量。
 *
 * 图标全部使用 inline SVG，不依赖外部图标库。
 */

import { forwardRef } from 'react'

import type { RecommendationItem } from '../lib/types'

export interface RecommendationCardProps {
  /** 推荐项数据。 */
  item: RecommendationItem
  /** 当前模式：study 学习 / work 工作，决定底部信息行渲染策略。 */
  mode: 'study' | 'work'
  /** 卡片点击回调（父组件用于触发展开为大卡）。 */
  onClick: () => void
  /** mount 时飞入动画延迟（ms）。 */
  enterDelay?: number
  /** mount 时飞入动画时长（ms）。 */
  enterDuration?: number
  /** mount 时飞入起始 X 偏移（px），增加横向无序感。 */
  enterX?: number
  /** mount 时飞入起始 Y 偏移（px），增加纵向无序感。 */
  enterY?: number
  /** mount 时飞入起始旋转角度（deg），增加倾斜无序感。 */
  enterRot?: number
  /** 其他卡片展开为大卡时，本卡加高斯模糊 + 半透明。 */
  isDimmed?: boolean
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

export const RecommendationCard = forwardRef<HTMLButtonElement, RecommendationCardProps>(
  function RecommendationCard(
    { item, mode, onClick, enterDelay, enterDuration, enterX, enterY, enterRot, isDimmed },
    ref,
  ) {
  const { node, reason, is_overdue, is_upcoming, error_rate, days_since_review } = item

  // 卡片样式类：到期 / 临近 / 飞入 / dimmed 分别加修饰类
  const cardCls = [
    'rec-card',
    is_overdue ? 'rec-card--overdue' : '',
    is_upcoming ? 'rec-card--upcoming' : '',
    enterDelay != null ? 'rec-card--entering' : '',
    isDimmed ? 'rec-card--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 飞入动画内联变量：延迟 / 时长 / 起始位置 / 旋转（仅当 enterDelay 传入时生效）
  const enterStyle =
    enterDelay != null
      ? ({
          '--rec-delay': `${enterDelay}ms`,
          '--rec-dur': `${enterDuration ?? 500}ms`,
          '--rec-x': `${enterX ?? 0}px`,
          '--rec-ty': `${enterY ?? 80}px`,
          '--rec-rot': `${enterRot ?? 0}deg`,
        } as React.CSSProperties)
      : undefined

  // 错误率百分比（study 模式）
  const errorPct = Math.round(error_rate * 100)
  const errorHigh = errorPct > 50

  // 复习时间文案（study 模式）
  const reviewText =
    days_since_review == null ? '未复习' : `${days_since_review} 天前`

  // 提醒时间文案（work 模式）
  const remindText = formatRemindAt(node.remind_at)

  return (
    <button
      type="button"
      ref={ref}
      className={cardCls}
      style={enterStyle}
      onClick={onClick}
      aria-label={`打开推荐：${node.title || '无标题'}`}
    >
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
    </button>
  )
  },
)

export default RecommendationCard

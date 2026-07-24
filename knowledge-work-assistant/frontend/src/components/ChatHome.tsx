/**
 * 对话首页瀑布流主体组件。
 *
 * 结构（从上到下）：
 * 1. ``ReminderBanner``：仅 ``reminderCount > 0`` 时显示，点击滚动到第一个
 *    ``is_overdue`` 卡片。
 * 2. 居中输入框（大圆角）：受控组件，回车提交。
 *    - study 模式：回车后按标题包含关键字过滤瀑布流。
 *    - work 模式：回车后调 ``onAsk``（由父组件 ``ChatPanel`` 传入，
 *      触发 ``askWorkQuestion``）。
 * 3. 瀑布流推荐卡片（CSS ``columns`` 实现，2-3 列响应式）。
 *
 * 数据来源：``store.recommendations`` / ``recommendationsLoading`` /
 * ``recommendationsError`` / ``reminderCount``；卡片点击调用
 * ``store.setActiveNav('graph')`` + ``store.selectNode(node.id)``。
 *
 * 设计要点：
 * - 不引入 JS masonry 库，瀑布流用 CSS ``columns`` + ``break-inside: avoid``。
 * - 组件挂载时若 ``recommendations`` 为空，调 ``store.loadRecommendations(mode)``。
 * - loading 显示"正在加载推荐…"；error 显示错误提示；空列表显示空状态文案。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { RecommendationItem } from '../lib/types'
import { RecommendationCard } from './RecommendationCard'
import { ReminderBanner } from './ReminderBanner'

export interface ChatHomeProps {
  /** 当前模式：study 学习 / work 工作。 */
  mode: 'study' | 'work'
  /** work 模式回车提交回调（触发 askWorkQuestion）。study 模式不使用。 */
  onAsk?: (q: string) => void
}

export function ChatHome({ mode, onAsk }: ChatHomeProps) {
  // ===== store 状态与动作 =====
  const recommendations = useAppStore((s) => s.recommendations)
  const recommendationsLoading = useAppStore((s) => s.recommendationsLoading)
  const recommendationsError = useAppStore((s) => s.recommendationsError)
  const reminderCount = useAppStore((s) => s.reminderCount)
  const loadRecommendations = useAppStore((s) => s.loadRecommendations)
  const loadReminderCount = useAppStore((s) => s.loadReminderCount)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)

  // ===== 本地状态 =====
  const [input, setInput] = useState('')
  /** study 模式下的标题过滤关键字（回车后写入，空字符串表示不过滤）。 */
  const [filterKeyword, setFilterKeyword] = useState('')

  // 瀑布流容器引用，用于点击 banner 后滚动定位
  const waterfallRef = useRef<HTMLDivElement>(null)
  // 第一个到期卡片的引用，用于 banner 点击时滚动定位
  const firstOverdueRef = useRef<HTMLDivElement>(null)

  // ===== 挂载时按需加载推荐 =====
  useEffect(() => {
    if (recommendations.length === 0 && !recommendationsLoading) {
      void loadRecommendations(mode)
    }
    // 仅在挂载时触发一次，mode 由父组件保证稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 提醒红点轻量轮询：60 秒刷新一次到期计数 =====
  // 仅在对话视图内有效，组件卸载即停止，避免后台无谓请求
  useEffect(() => {
    // 挂载时立即刷新一次，保证进入对话视图后红点是最新的
    void loadReminderCount()
    const timer = setInterval(() => {
      void loadReminderCount()
    }, 60_000)
    return () => clearInterval(timer)
    // loadReminderCount 由 zustand 稳定返回，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 过滤后的推荐列表（study 模式按标题包含关键字过滤） =====
  const visibleItems: RecommendationItem[] = useMemo(() => {
    if (mode !== 'study' || !filterKeyword) return recommendations
    const kw = filterKeyword.toLowerCase()
    return recommendations.filter((r) =>
      r.node.title?.toLowerCase().includes(kw),
    )
  }, [recommendations, mode, filterKeyword])

  // ===== 输入框回车提交 =====
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const q = input.trim()
    if (!q) return
    if (mode === 'study') {
      // study 模式：按标题包含关键字过滤瀑布流
      setFilterKeyword(q)
    } else {
      // work 模式：调父组件传入的 onAsk
      onAsk?.(q)
      setInput('')
    }
  }

  // ===== 卡片点击：跳转图谱视图并选中节点 =====
  const handleCardClick = (item: RecommendationItem) => {
    setActiveNav('graph')
    setSelectedNode(item.node.id)
  }

  // ===== Study 模式：跳转到图谱视图搜索当前关键字 =====
  // 当前图谱视图暂无关键字高亮 / 过滤能力，仅完成跳转；
  // 后续可在图谱视图加 search/highlight 入口接住 filterKeyword。
  // TODO: 图谱视图增加关键字搜索 / 高亮过滤
  const handleSearchInGraph = () => {
    setActiveNav('graph')
  }

  // ===== Banner 点击：滚动到第一个到期卡片 =====
  const handleBannerClick = () => {
    // 优先滚动到第一个到期卡片
    if (firstOverdueRef.current) {
      firstOverdueRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      return
    }
    // 没有到期卡片时回退到瀑布流顶部
    waterfallRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  // ===== 占位文案 =====
  const placeholder =
    mode === 'study'
      ? '输入要复习/搜索的知识点'
      : '输入工作提问'

  // 渲染第一个到期卡片的引用赋值（仅一次）
  let overdueAssigned = false

  return (
    <div className="chat-home">
      {/* 顶部提醒横幅（仅 reminderCount > 0 时显示） */}
      <ReminderBanner count={reminderCount} onClick={handleBannerClick} />

      {/* 居中输入框 */}
      <div className="chat-home__input-wrap">
        <input
          className="chat-home__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {/* Study 模式回车过滤后：提供「在图谱视图中搜索」快捷入口。
            过滤结果为空时也自动显示，便于用户转去图谱视图继续查找。 */}
        {mode === 'study' && filterKeyword && (
          <button
            type="button"
            className="chat-home__search-graph-btn"
            onClick={handleSearchInGraph}
          >
            在图谱视图中搜索「{filterKeyword}」
          </button>
        )}
      </div>

      {/* 瀑布流推荐卡片 */}
      <div className="chat-home__waterfall" ref={waterfallRef}>
        {recommendationsLoading ? (
          <div className="chat-home__empty">正在加载推荐…</div>
        ) : recommendationsError ? (
          <div className="chat-home__empty chat-home__empty--error">
            加载推荐失败：{recommendationsError}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="chat-home__empty">
            {recommendations.length === 0
              ? '暂无推荐，去图谱视图添加节点吧'
              : `没有匹配「${filterKeyword}」的推荐`}
            {/* 过滤结果为空且有关键字时，自动展示跳转图谱入口 */}
            {mode === 'study' && filterKeyword && (
              <button
                type="button"
                className="chat-home__search-graph-btn"
                onClick={handleSearchInGraph}
              >
                在图谱视图中搜索「{filterKeyword}」
              </button>
            )}
          </div>
        ) : (
          visibleItems.map((item) => {
            // 第一个到期卡片绑定 ref，供 banner 点击滚动定位
            const isOverdue = item.is_overdue
            const ref = isOverdue && !overdueAssigned ? firstOverdueRef : null
            if (ref) overdueAssigned = true
            return (
              <div key={item.node.id} ref={ref}>
                <RecommendationCard
                  item={item}
                  mode={mode}
                  onClick={() => handleCardClick(item)}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default ChatHome

/**
 * 对话首页瀑布流主体组件（交互增强版）。
 *
 * 结构（从上到下）：
 * 1. ``ReminderBanner``：仅 ``reminderCount > 0`` 时显示。
 * 2. 居中输入框（大圆角）：受控组件，回车提交。
 *    - study 模式：回车后按标题包含关键字过滤瀑布流。
 *    - work 模式：回车后触发 sending 过渡（输入框下移到底部 + 卡片飞出），
 *      动画完成后再调 ``onAsk`` 由父组件 ``ChatPanel`` 触发 ``askWorkQuestionStream``。
 * 3. 瀑布流推荐卡片（CSS ``columns`` 实现，2-3 列响应式）。
 *
 * 交互增强（4 项需求）：
 * - **卡片飞入**：mount 时每张卡片从下方不均匀飞上来（先后/快慢不同），
 *   由 ``enterConfig`` 给每张卡算出随机 delay/duration，传给 RecommendationCard。
 * - **滚轮覆盖**：鼠标悬停卡片 + 滚轮向下时，整片瀑布流上移盖住输入框，
 *   输入框同步渐进式高斯模糊（``--cover`` CSS 变量驱动，0~1）。
 * - **点击展开**：卡片点击 → ``setChatExpandedNodeId`` 触发顶层 ChatExpandedOverlay
 *   把卡片飞到中央展开为大卡；其余卡片加 ``isDimmed`` 高斯模糊。
 * - **sending 过渡**（仅 work）：回车提交时 ``phase='sending'``，输入框下移到底部、
 *   卡片向下飞出，动画完成后调 ``onAsk(q)`` 切到对话视图。
 *
 * 数据来源：``store.recommendations`` / ``recommendationsLoading`` /
 * ``recommendationsError`` / ``reminderCount``；``store.chatExpandedNodeId``
 * 控制哪张卡片处于展开态（null = 无）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { RecommendationItem } from '../lib/types'
import { RecommendationCard } from './RecommendationCard'
import { ReminderBanner } from './ReminderBanner'

export interface ChatHomeProps {
  /** 当前模式：study 学习 / work 工作。 */
  mode: 'study' | 'work'
  /** work 模式回车提交回调（触发 askWorkQuestionStream）。study 模式不使用。 */
  onAsk?: (q: string) => void
}

type Phase = 'idle' | 'sending'

export function ChatHome({ mode, onAsk }: ChatHomeProps) {
  // ===== store 状态与动作 =====
  const recommendations = useAppStore((s) => s.recommendations)
  const recommendationsLoading = useAppStore((s) => s.recommendationsLoading)
  const recommendationsError = useAppStore((s) => s.recommendationsError)
  const reminderCount = useAppStore((s) => s.reminderCount)
  const loadRecommendations = useAppStore((s) => s.loadRecommendations)
  const loadReminderCount = useAppStore((s) => s.loadReminderCount)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  const chatExpandedNodeId = useAppStore((s) => s.chatExpandedNodeId)
  const setChatExpandedNodeId = useAppStore((s) => s.setChatExpandedNodeId)

  // ===== 本地状态 =====
  const [input, setInput] = useState('')
  /** study 模式下的标题过滤关键字（回车后写入，空字符串表示不过滤）。 */
  const [filterKeyword, setFilterKeyword] = useState('')
  /** 阶段：idle 初始态 / sending 发送消息过渡中（仅 work）。 */
  const [phase, setPhase] = useState<Phase>('idle')
  /** 滚轮覆盖量 0~1（瀑布流上移盖住输入框的比例）。 */
  const [coverProgress, setCoverProgress] = useState(0)
  /** 输入框区域高度（px），用于瀑布流上移量。 */
  const [inputH, setInputH] = useState(0)
  /** sending 时输入框下移距离（px），由提交时测量视口算出。 */
  const [slideY, setSlideY] = useState(0)

  // ===== refs =====
  const waterfallRef = useRef<HTMLDivElement>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const firstOverdueRef = useRef<HTMLDivElement>(null)
  /** 鼠标是否悬停在任一卡片上（wheel 覆盖交互仅在此态生效）。 */
  const hoveringCardRef = useRef(false)
  /** 最新状态快照，供 wheel 监听闭包读取（避免重绑定）。 */
  const stateRef = useRef({ phase, coverProgress, expandedId: chatExpandedNodeId })
  stateRef.current = { phase, coverProgress, expandedId: chatExpandedNodeId }

  // ===== 挂载时按需加载推荐 =====
  useEffect(() => {
    if (recommendations.length === 0 && !recommendationsLoading) {
      void loadRecommendations(mode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 提醒红点轻量轮询：60 秒刷新一次到期计数 =====
  useEffect(() => {
    void loadReminderCount()
    const timer = setInterval(() => {
      void loadReminderCount()
    }, 60_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 测量输入框区域高度，注入 --input-h 让瀑布流知道上移多少 =====
  useEffect(() => {
    const measure = () => {
      const el = inputWrapRef.current
      if (!el) return
      // 高度 + 下方 16px gap，覆盖时瀑布流要完全盖住输入框
      setInputH(el.offsetHeight + 16)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // ===== 滚轮覆盖交互（需求3）=====
  // 非被动监听：悬停卡片 + 滚轮向下时，整片瀑布流上移盖住输入框，输入框渐进模糊。
  useEffect(() => {
    const wf = waterfallRef.current
    if (!wf) return
    const onWheel = (e: WheelEvent) => {
      const { phase: p, coverProgress: cp, expandedId } = stateRef.current
      // 仅 idle 态 + 无展开大卡时拦截
      if (p !== 'idle' || expandedId !== null) return
      // 必须悬停在卡片上才生效
      if (!hoveringCardRef.current) return
      if (e.deltaY > 0) {
        // 向下：未满覆盖时拦截累积；满覆盖后放行内部滚动
        if (cp < 1) {
          e.preventDefault()
          const next = Math.min(1, cp + e.deltaY / 200)
          setCoverProgress(next)
        }
      } else if (e.deltaY < 0) {
        // 向上：有覆盖且内部已滚到顶时回退覆盖；否则放行内部滚动
        if (cp > 0) {
          if (wf.scrollTop <= 0) {
            e.preventDefault()
            const next = Math.max(0, cp + e.deltaY / 200)
            setCoverProgress(next)
          }
        }
      }
    }
    wf.addEventListener('wheel', onWheel, { passive: false })
    return () => wf.removeEventListener('wheel', onWheel)
  }, [])

  // ===== 卡片悬停态维护 =====
  const onCardsMouseEnter = () => {
    hoveringCardRef.current = true
  }
  const onCardsMouseLeave = () => {
    hoveringCardRef.current = false
    // 离开卡片时若处于部分覆盖态，回退到无覆盖（避免卡在中间态）
    if (stateRef.current.coverProgress > 0 && stateRef.current.coverProgress < 1) {
      setCoverProgress(0)
    }
  }

  // ===== 过滤后的推荐列表（study 模式按标题包含关键字过滤） =====
  const visibleItems: RecommendationItem[] = useMemo(() => {
    if (mode !== 'study' || !filterKeyword) return recommendations
    const kw = filterKeyword.toLowerCase()
    return recommendations.filter((r) =>
      r.node.title?.toLowerCase().includes(kw),
    )
  }, [recommendations, mode, filterKeyword])

  // ===== 卡片飞入动画配置（每张卡不均匀的 delay/duration）=====
  const enterConfig = useMemo(() => {
    const map = new Map<string, { delay: number; duration: number }>()
    visibleItems.forEach((item, i) => {
      // 基础延迟按索引递增 + ±60ms 随机抖动 → 先后有别
      const jitter = (Math.random() - 0.5) * 120
      const delay = i * 90 + jitter
      // 持续时长 500~800ms 随机 → 快慢不一
      const duration = 500 + Math.random() * 300
      map.set(item.node.id, { delay, duration })
    })
    return map
  }, [visibleItems])

  // ===== 输入框回车提交 =====
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const q = input.trim()
    if (!q) return
    if (mode === 'study') {
      // study 模式：按标题包含关键字过滤瀑布流（无 sending 过渡）
      setFilterKeyword(q)
    } else {
      // work 模式：触发 sending 过渡，动画完成后再调 onAsk
      if (phase === 'sending') return
      // 测量输入框到视口底部的距离，作为下移量
      const el = inputWrapRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        // 下移到视口底部外（留一点边距让输入框刚好到底部 footer 上方）
        setSlideY(window.innerHeight - rect.top + 20)
      }
      setPhase('sending')
      // 等 sending 动画完成（输入框下移 450ms + 卡片飞出 450ms）后调 onAsk
      // onAsk 触发 store 推消息 → qaMessages 长度变化 → ChatPanel 切到对话视图
      window.setTimeout(() => {
        onAsk?.(q)
        setInput('')
      }, 480)
    }
  }

  // ===== 卡片点击：触发顶层大卡浮层（不再直接跳图谱）=====
  const handleCardClick = (item: RecommendationItem) => {
    setChatExpandedNodeId(item.node.id)
  }

  // ===== Study 模式：跳转到图谱视图搜索当前关键字 =====
  const handleSearchInGraph = () => {
    setActiveNav('graph')
  }

  // ===== Banner 点击：滚动到第一个到期卡片 =====
  const handleBannerClick = () => {
    if (firstOverdueRef.current) {
      firstOverdueRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      return
    }
    waterfallRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  // ===== 占位文案 =====
  const placeholder =
    mode === 'study' ? '输入要复习/搜索的知识点' : '输入工作提问'

  // 渲染第一个到期卡片的引用赋值（仅一次）
  let overdueAssigned = false

  // chat-home 根元素样式：注入 --cover / --input-h / --slide-y CSS 变量
  const homeStyle = {
    '--cover': coverProgress,
    '--input-h': `${inputH}px`,
    '--slide-y': `${slideY}px`,
  } as React.CSSProperties

  const homeCls = [
    'chat-home',
    phase === 'sending' ? 'chat-home--sending' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={homeCls} style={homeStyle}>
      {/* 顶部提醒横幅（仅 reminderCount > 0 时显示） */}
      <ReminderBanner count={reminderCount} onClick={handleBannerClick} />

      {/* 居中输入框 */}
      <div className="chat-home__input-wrap" ref={inputWrapRef}>
        <input
          className="chat-home__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={phase === 'sending'}
        />
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
      <div
        className="chat-home__waterfall"
        ref={waterfallRef}
        onMouseEnter={onCardsMouseEnter}
        onMouseLeave={onCardsMouseLeave}
      >
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
            const isOverdue = item.is_overdue
            const ref =
              isOverdue && !overdueAssigned ? firstOverdueRef : null
            if (ref) overdueAssigned = true
            const cfg = enterConfig.get(item.node.id)
            // 其他卡片展开为大卡时，本卡 dimmed
            const isDimmed =
              chatExpandedNodeId !== null &&
              chatExpandedNodeId !== item.node.id
            return (
              <div
                key={item.node.id}
                ref={ref}
                data-rec-node-id={item.node.id}
              >
                <RecommendationCard
                  item={item}
                  mode={mode}
                  onClick={() => handleCardClick(item)}
                  enterDelay={cfg?.delay}
                  enterDuration={cfg?.duration}
                  isDimmed={isDimmed}
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

/**
 * 对话首页瀑布流主体组件（自然滚动版）。
 *
 * 结构（从上到下）：
 * 1. ``ReminderBanner``：仅 ``reminderCount > 0`` 时显示。
 * 2. 居中输入框（大圆角）：受控组件，回车提交。
 *    - study 模式：回车后按标题包含关键字过滤瀑布流。
 *    - work 模式：回车后触发 sending 过渡（输入框下移到底部 + 卡片飞出），
 *      动画完成后再调 ``onAsk`` 由父组件 ``ChatPanel`` 触发 ``sendMessage``。
 * 3. 瀑布流推荐卡片（CSS grid 实现，2-4 列响应式）。
 *
 * 交互：
 * - **整页自然滚动**：不再是内部滚动，从页面最底到最顶都可滑动，无可见滚动条。
 * - **卡片飞入**：mount 时每张卡片从下方不均匀飞上来（先后/快慢不同），
 *   由 ``enterConfig`` 给每张卡算出随机 delay/duration，传给 RecommendationCard。
 * - **点击展开**：卡片点击 → ``setChatExpandedNodeId`` 触发顶层 ChatExpandedOverlay
 *   把卡片飞到中央展开为大卡；其余卡片加 ``isDimmed`` 高斯模糊。
 * - **sending 过渡**（仅 work）：回车提交时 ``phase='sending'``，输入框下移到底部、
 *   卡片向下飞出，动画完成后调 ``onAsk(q)`` 切到对话视图。
 *
 * 数据来源：``store.recommendations`` / ``recommendationsLoading`` /
 * ``recommendationsError`` / ``reminderCount``；``store.chatExpandedNodeId``
 * 控制哪张卡片处于展开态（null = 无）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import { useAutoGrowTextarea } from '../hooks/useAutoGrowTextarea'
import type { RecommendationItem } from '../lib/types'
import { GraphSelector } from './GraphSelector'
import { RecommendationCard } from './RecommendationCard'
import { ReminderBanner } from './ReminderBanner'

export interface ChatHomeProps {
  /** 当前模式：study 学习 / work 工作。 */
  mode: 'study' | 'work'
  /** work 模式回车提交回调（触发 sendMessage）。study 模式不使用。 */
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
  const chatExpandedNodeId = useAppStore((s) => s.chatExpandedNodeId)
  const setChatExpandedNodeId = useAppStore((s) => s.setChatExpandedNodeId)

  // ===== 本地状态 =====
  const [input, setInput] = useState('')
  /** 阶段：idle 初始态 / sending 发送消息过渡中。 */
  const [phase, setPhase] = useState<Phase>('idle')
  /** sending 时输入框下移距离（px），由提交时测量视口算出。 */
  const [slideY, setSlideY] = useState(0)
  /** textarea 自适应撑高（最多 5 行左右） */
  const textareaRef = useAutoGrowTextarea<HTMLTextAreaElement>(input, {
    maxHeight: 120,
  })
  // ===== refs =====
  const homeRef = useRef<HTMLDivElement>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const firstOverdueRef = useRef<HTMLDivElement>(null)
  const sendTimerRef = useRef<number | null>(null)

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

  // ===== 滚动监听：瀑布流上滑时输入框渐变高斯模糊 =====
  useEffect(() => {
    const panel = inputWrapRef.current?.closest<HTMLElement>('.chat-panel')
    if (!panel) return
    let frame = 0
    const updateBlur = () => {
      frame = 0
      const coverDistance = inputWrapRef.current?.offsetHeight ?? 100
      const blur = Math.min((panel.scrollTop / coverDistance) * 8, 8)
      homeRef.current?.style.setProperty('--input-blur', `${blur}px`)
    }
    const handleScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateBlur)
    }
    panel.addEventListener('scroll', handleScroll, { passive: true })
    updateBlur()
    return () => {
      panel.removeEventListener('scroll', handleScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  // ===== 卡片飞入动画配置（由稳定 id 推导，保证刷新与录屏可复现）=====
  const enterConfig = useMemo(() => {
    const map = new Map<string, { delay: number; duration: number; x: number; y: number; rot: number }>()
    // 估算列数：与 CSS auto-fill minmax(260px, 1fr) 对齐
    const containerW = Math.min(
      (typeof window !== 'undefined' ? window.innerWidth : 1200) - 40,
      1280,
    )
    const cols = Math.max(1, Math.floor((containerW + 16) / (260 + 16)))
    recommendations.forEach((item, i) => {
      let seed = 0
      for (const char of item.node.id) seed = (seed * 31 + char.charCodeAt(0)) >>> 0
      const unit = (shift: number) => ((seed >>> shift) & 0xff) / 255
      const row = Math.floor(i / cols)
      const delay = Math.max(0, row * 90 + (unit(0) - 0.5) * 50)
      const duration = 300 + unit(8) * 60
      const x = (unit(16) - 0.5) * 24
      const y = 28 + unit(4) * 24
      const rot = (unit(12) - 0.5) * 3
      map.set(item.node.id, { delay, duration, x, y, rot })
    })
    return map
  }, [recommendations])

  // ===== 输入框回车提交（两种模式都发送对话） =====
  const submitQuestion = useCallback(() => {
    const q = input.trim()
    if (!q || phase === 'sending') return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const el = inputWrapRef.current
    if (el && !reduceMotion) {
      const rect = el.getBoundingClientRect()
      setSlideY(window.innerHeight - rect.top + 40)
    }
    setPhase('sending')
    if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current)
    sendTimerRef.current = window.setTimeout(() => {
      onAsk?.(q)
      setInput('')
      sendTimerRef.current = null
    }, reduceMotion ? 0 : 450)
  }, [input, onAsk, phase])

  useEffect(() => () => {
    if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current)
  }, [])

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 提交、Shift+Enter 换行（与 ChatPanel 行为一致）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitQuestion()
    }
  }

  // ===== 发送按钮点击 =====
  const handleSendClick = submitQuestion

  // ===== 卡片点击：触发顶层大卡浮层 =====
  const handleCardClick = (item: RecommendationItem) => {
    setChatExpandedNodeId(item.node.id)
  }

  // ===== Banner 点击：滚动到第一个到期卡片 =====
  const handleBannerClick = () => {
    if (firstOverdueRef.current) {
      firstOverdueRef.current.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      })
      return
    }
    // 无到期卡片时，滚动到瀑布流顶部
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }

  // ===== 占位文案 =====
  const placeholder =
    mode === 'study' ? '输入你的问题，回车发送对话…' : '输入工作提问，回车发送…'

  // 渲染第一个到期卡片的引用赋值（仅一次）
  let overdueAssigned = false

  // chat-home 根元素样式：注入 --slide-y / --input-blur CSS 变量
  const homeStyle = {
    '--slide-y': `${slideY}px`,
  } as React.CSSProperties

  const homeCls = [
    'chat-home',
    phase === 'sending' ? 'chat-home--sending' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={homeRef} className={homeCls} style={homeStyle}>
      {/* 顶部提醒横幅（仅 reminderCount > 0 时显示） */}
      <ReminderBanner count={reminderCount} onClick={handleBannerClick} />

      {/* 占位：让输入框初始位于视口中央 */}
      <div className="chat-home__input-spacer" />

      {/* 对话输入框（sticky 固定在视口中央偏下，瀑布流卡片从下方滑上覆盖） */}
      <div className="chat-home__input-wrap" ref={inputWrapRef}>
        <GraphSelector />
        <div className="chat-home__input-row">
          <textarea
            ref={textareaRef}
            id="chat-home-question"
            className="chat-home__input"
            name="chat-home-question"
            autoComplete="off"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={placeholder}
            aria-label="输入对话问题"
            disabled={phase === 'sending'}
          />
          <button
            type="button"
            className="chat-home__send-btn"
            onClick={handleSendClick}
            disabled={phase === 'sending' || !input.trim()}
            title="发送对话（Enter）"
            aria-label="发送"
          >
            {phase === 'sending' ? (
              <span className="chat-home__send-spinner" />
            ) : (
              <SendIcon />
            )}
          </button>
        </div>
      </div>

      {/* 瀑布流推荐卡片 */}
      <div className="chat-home__waterfall">
        {recommendationsLoading ? (
          <div className="chat-home__empty">正在加载推荐…</div>
        ) : recommendationsError ? (
          <div className="chat-home__empty chat-home__empty--error">
            加载推荐失败：{recommendationsError}
          </div>
        ) : recommendations.length === 0 ? (
          <div className="chat-home__empty">
            暂无推荐，去图谱视图添加节点吧
          </div>
        ) : (
          recommendations.map((item) => {
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
                  enterX={cfg?.x}
                  enterY={cfg?.y}
                  enterRot={cfg?.rot}
                  isDimmed={isDimmed}
                />
              </div>
            )
          })
        )}
      </div>

      {/* 底部渐变高斯模糊：sticky 钉在视口底部，卡片滑过时模糊 */}
      <div className="chat-home__bottom-blur" />
    </div>
  )
}

// ============================================================================
// 发送按钮 SVG 图标（与 ChatPanel 的 SendIcon 保持一致，统一视觉）
// ============================================================================

function SendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

export default ChatHome

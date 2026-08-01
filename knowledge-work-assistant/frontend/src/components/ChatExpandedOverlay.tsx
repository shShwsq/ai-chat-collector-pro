import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { motion } from 'motion/react'

import { useAppStore } from '../store/useAppStore'
import { parseDate } from '../lib/date'
import { prepareGraphHandoffTarget, waitForGraphHandoffView } from '../lib/graphHandoff'
import { createPostHandoffExtensionRunner } from '../lib/postHandoffExtension'
import type { Node, RecommendationItem } from '../lib/types'
import { handoffReducer, MOTION, useMotionRuntime } from '../lib/motion'
import type { GraphViewHandle } from './graph/GraphView'

interface ChatExpandedOverlayProps {
  graphViewRef?: React.RefObject<GraphViewHandle> | null
}

const HANDOFF_TIMEOUT_MS = 3500

interface FixedRect {
  left: number
  top: number
  width: number
  height: number
  borderRadius: number
}

function readRecommendationRect(nodeId: string): FixedRect | null {
  const wrappers = document.querySelectorAll<HTMLElement>('[data-rec-node-id]')
  const wrapper = Array.from(wrappers).find((element) => element.dataset.recNodeId === nodeId)
  const card = wrapper?.querySelector<HTMLElement>('.rec-card')
  if (!card) return null
  const rect = card.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    borderRadius: 14,
  }
}

function getExpandedRect(): FixedRect {
  const width = Math.min(560, window.innerWidth - 48)
  const height = Math.min(680, window.innerHeight * 0.85)
  return {
    left: (window.innerWidth - width) / 2,
    top: (window.innerHeight - height) / 2,
    width,
    height,
    borderRadius: 20,
  }
}

export function ChatExpandedOverlay({ graphViewRef }: ChatExpandedOverlayProps) {
  const chatExpandedNodeId = useAppStore((s) => s.chatExpandedNodeId)
  const setChatExpandedNodeId = useAppStore((s) => s.setChatExpandedNodeId)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  const setView = useAppStore((s) => s.setView)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)
  const graphHandoffPhase = useAppStore((s) => s.graphHandoffPhase)
  const setGraphHandoffPhase = useAppStore((s) => s.setGraphHandoffPhase)
  const selectGraph = useAppStore((s) => s.selectGraph)
  const extendNode = useAppStore((s) => s.extendNode)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const fullGraph = useAppStore((s) => s.fullGraph)
  const recommendations = useAppStore((s) => s.recommendations)
  const mode = useAppStore((s) => s.mode)
  const { duration } = useMotionRuntime()

  const [phase, dispatch] = useReducer(handoffReducer, 'closed')
  const handoffCompletedRef = useRef(false)
  const postHandoffExtensionRef = useRef<ReturnType<typeof createPostHandoffExtensionRunner>>()
  if (!postHandoffExtensionRef.current) {
    postHandoffExtensionRef.current = createPostHandoffExtensionRunner(extendNode)
  }
  const [renderedNodeId, setRenderedNodeId] = useState<string | null>(null)
  const [cardRect, setCardRect] = useState<FixedRect | null>(null)
  const [handoffTimedOut, setHandoffTimedOut] = useState(false)

  const isOpen = chatExpandedNodeId !== null
  const activeNodeId = chatExpandedNodeId ?? renderedNodeId

  // 找到当前展开的推荐项
  const recItem: RecommendationItem | undefined = recommendations.find(
    (r: RecommendationItem) => r.node.id === activeNodeId,
  )
  const node: Node | undefined = recItem?.node ?? fullGraph?.nodes.find((n: Node) => n.id === activeNodeId)
  const reason = recItem?.reason
  const isOverdue = recItem?.is_overdue
  const isUpcoming = recItem?.is_upcoming
  const daysSinceReview = recItem?.days_since_review
  const errorRate = recItem?.error_rate

  useLayoutEffect(() => {
    if (!chatExpandedNodeId) return
    const sourceRect = readRecommendationRect(chatExpandedNodeId)
    if (!sourceRect) return
    setRenderedNodeId(chatExpandedNodeId)
    setCardRect(sourceRect)
    setHandoffTimedOut(false)
    dispatch({ type: 'OPEN' })
    const frame = requestAnimationFrame(() => {
      setCardRect(getExpandedRect())
      dispatch({ type: 'OPENED' })
    })
    return () => cancelAnimationFrame(frame)
  }, [chatExpandedNodeId])

  const handleClose = () => {
    if (phase === 'handoff') {
      setGraphHandoffPhase('idle')
      setChatExpandedNodeId(null)
      setRenderedNodeId(null)
      setCardRect(null)
      dispatch({ type: 'RESET' })
      return
    }
    if (!activeNodeId) return
    const sourceRect = readRecommendationRect(activeNodeId)
    dispatch({ type: 'START_CLOSE' })
    if (sourceRect) setCardRect(sourceRect)
    setChatExpandedNodeId(null)
  }

  const handleExtend = () => {
    if (!chatExpandedNodeId || !node) return
    handoffCompletedRef.current = false
    postHandoffExtensionRef.current?.reset()
    setHandoffTimedOut(false)
    setSelectedNode(null)
    dispatch({ type: 'START_HANDOFF' })
    setGraphHandoffPhase('preparing')
    if (node.graph_id && node.graph_id !== currentGraphId) selectGraph(node.graph_id)
  }

  useEffect(() => {
    if (phase !== 'handoff' || !node) return
    const targetGraphReady = currentGraphId === node.graph_id && fullGraph?.graph.id === node.graph_id
    if (!targetGraphReady) return

    const nodeExists = fullGraph.nodes.some((item) => item.id === node.id)
    if (!nodeExists) return

    let cancelled = false
    const complete = async () => {
      setView('graph')
      setActiveNav('graph')

      const graphView = await waitForGraphHandoffView(() => graphViewRef?.current)
      if (cancelled) return
      const targetRect = await prepareGraphHandoffTarget(graphView, node.id)
      if (cancelled) return

      if (targetRect) {
        setCardRect({ ...targetRect, borderRadius: 10 })
        setGraphHandoffPhase('graph-ready')
      }
    }
    void complete()
    return () => {
      cancelled = true
    }
  }, [
    phase,
    node,
    currentGraphId,
    fullGraph,
    graphViewRef,
    setActiveNav,
    setChatExpandedNodeId,
    setSelectedNode,
    setView,
    setGraphHandoffPhase,
  ])

  const completeHandoff = useCallback(() => {
    if (handoffCompletedRef.current) return
    handoffCompletedRef.current = true
    const completedNodeId = activeNodeId
    setHandoffTimedOut(false)
    setGraphHandoffPhase('landing')
    setSelectedNode(null)
    setChatExpandedNodeId(null)
    setRenderedNodeId(null)
    setCardRect(null)
    dispatch({ type: 'RESET' })
    requestAnimationFrame(() => setGraphHandoffPhase('idle'))
    // 动画已正常落地或超时淡出完成后才发起延伸，避免整图刷新打断飞行动画。
    if (completedNodeId) postHandoffExtensionRef.current?.trigger(completedNodeId)
  }, [activeNodeId, setChatExpandedNodeId, setGraphHandoffPhase, setSelectedNode])

  const handleCardAnimationComplete = () => {
    if (phase === 'handoff' && graphHandoffPhase === 'graph-ready') completeHandoff()
    if (phase === 'closing') {
      setRenderedNodeId(null)
      setCardRect(null)
      dispatch({ type: 'RESET' })
    }
  }

  useEffect(() => {
    if (phase !== 'handoff') return
    let fadeId: number | undefined
    const timeoutId = window.setTimeout(() => {
      setHandoffTimedOut(true)
      fadeId = window.setTimeout(completeHandoff, 280)
    }, HANDOFF_TIMEOUT_MS)
    return () => {
      window.clearTimeout(timeoutId)
      if (fadeId !== undefined) window.clearTimeout(fadeId)
    }
  }, [phase, completeHandoff])

  useEffect(() => {
    if (phase !== 'closing') return
    const timeoutId = window.setTimeout(() => {
      setRenderedNodeId(null)
      setCardRect(null)
      dispatch({ type: 'RESET' })
    }, 600)
    return () => window.clearTimeout(timeoutId)
  }, [phase])

  // ESC 键关闭
  useLayoutEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // 获取标签样式
  const getStatusBadge = () => {
    if (!node) return null
    if (isOverdue) return { cls: 'badge--overdue', text: '已到期' }
    if (isUpcoming) return { cls: 'badge--soon', text: '即将到期' }
    if (errorRate !== undefined && errorRate > 0.4) return { cls: 'badge--error', text: '高错误率' }
    return null
  }
  const badge = getStatusBadge()

  // 类型标签映射（学习模式 + 工作模式）
  const typeLabels: Record<string, string> = {
    // 学习模式
    concept: '概念', method: '方法', person: '人物',
    book: '书籍', problem: '问题', event: '事件',
    general: '通用',
    // 工作模式
    work_task: '任务', work_todo: '待办', work_meeting: '会议',
    work_note: '笔记', work_project: '项目',
    COMMITMENT: '承诺', RISK: '风险', EVENT: '事件',
    KEY_PERSON: '关键人物', THREAD: '线索', EXPECTATION: '期望',
    DECISION: '决策', REVIEW: '复盘',
  }
  // 格式化类型显示：优先使用中文映射；未映射的做简单美化（下划线→空格，首字母大写）
  const formatTypeLabel = (t: string | undefined): string => {
    if (!t) return '节点'
    if (typeLabels[t]) return typeLabels[t]
    return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
  const typeLabel = node ? formatTypeLabel(node.type) : '节点'

  return (
    (isOpen || phase === 'closing' || phase === 'handoff') && node && cardRect ? (
        <div
          className="expanded-overlay"
          data-overlay-phase={phase}
          data-handoff-phase={graphHandoffPhase}
          data-handoff-timeout={handoffTimedOut || undefined}
          style={{ '--expanded-transition-duration': `${duration(MOTION.expand)}s` } as React.CSSProperties}
        >
          <div
            className="expanded-overlay__backdrop"
            onPointerDown={handleClose}
            onClick={handleClose}
            aria-hidden="true"
          />
          <motion.div
            className="expanded-overlay__card"
            initial={false}
            animate={{
              left: cardRect.left,
              top: cardRect.top,
              width: cardRect.width,
              height: cardRect.height,
              borderRadius: cardRect.borderRadius,
            }}
            style={{ position: 'fixed', maxHeight: cardRect.height }}
            transition={{ duration: duration(MOTION.expand), ease: MOTION.springEase }}
            onAnimationComplete={handleCardAnimationComplete}
            onPointerDown={(event) => event.stopPropagation()}
          >
        <div className="expanded-card__source-proxy" aria-hidden="true">
          <div className="expanded-card__source-head">
            <span className="expanded-card__source-title">{node.title || '（无标题）'}</span>
            <span className="expanded-card__source-tag">{node.type || '未分类'}</span>
          </div>
          {reason && <p className="expanded-card__source-reason">{reason}</p>}
          <div className="expanded-card__source-meta">
            <span>{mode === 'study' ? (daysSinceReview == null ? '未复习' : `${daysSinceReview} 天前`) : '知识卡片'}</span>
            {mode === 'study' && errorRate !== undefined && <span>错误率 {Math.round(errorRate * 100)}%</span>}
          </div>
        </div>
        {/* 关闭按钮 */}
        <button
          type="button"
          className="expanded-overlay__close"
          onClick={handleClose}
          aria-label="关闭"
        >
          ×
        </button>

        {/* 卡片头部 */}
        <div className="expanded-card__header is-visible">
          <div className="expanded-card__top-row">
            <span className="expanded-card__type">{typeLabel}</span>
            {badge && (
              <span className={`expanded-card__badge ${badge.cls}`}>{badge.text}</span>
            )}
          </div>
          <h2 className="expanded-card__title">{node.title || '（无标题）'}</h2>
        </div>

        {/* 卡片内容区 */}
        <div className="expanded-card__body is-visible">
          {/* 概括/摘要 */}
          {(node.summary || reason) && (
            <section className="expanded-card__section">
              <h3 className="expanded-card__section-title">
                {node.summary ? '内容概括' : '推荐理由'}
              </h3>
              <p className="expanded-card__summary">
                {node.summary || reason}
              </p>
            </section>
          )}

          {/* 元信息 */}
          <section className="expanded-card__section">
            <h3 className="expanded-card__section-title">信息</h3>
            <div className="expanded-card__meta">
              {daysSinceReview !== null && daysSinceReview !== undefined && (
                <div className="expanded-card__meta-item">
                  <span className="expanded-card__meta-label">上次复习</span>
                  <span className="expanded-card__meta-value">
                    {daysSinceReview === 0 ? '今天' : `${daysSinceReview} 天前`}
                  </span>
                </div>
              )}
              {errorRate !== undefined && (
                <div className="expanded-card__meta-item">
                  <span className="expanded-card__meta-label">错误率</span>
                  <span className="expanded-card__meta-value">
                    {Math.round(errorRate * 100)}%
                  </span>
                </div>
              )}
              {mode === 'work' && node.remind_at && (
                <div className="expanded-card__meta-item">
                  <span className="expanded-card__meta-label">提醒时间</span>
                  <span className="expanded-card__meta-value">
                    {(() => {
                      const d = parseDate(node.remind_at)
                      return d
                        ? d.toLocaleString('zh-CN', {
                            month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit',
                          })
                        : ''
                    })()}
                  </span>
                </div>
              )}
              {node.created_at && (
                <div className="expanded-card__meta-item">
                  <span className="expanded-card__meta-label">创建时间</span>
                  <span className="expanded-card__meta-value">
                    {(() => {
                      const d = parseDate(node.created_at)
                      return d
                        ? d.toLocaleDateString('zh-CN')
                        : ''
                    })()}
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* 详情内容（如果节点有详细字段） */}
          {node.detail_payload && Object.keys(node.detail_payload).length > 0 && (
            <section className="expanded-card__section">
              <h3 className="expanded-card__section-title">详细内容</h3>
              <div className="expanded-card__details">
                {Object.entries(node.detail_payload)
                  .filter(([k]) => !k.startsWith('_') && k !== 'extensions')
                  .slice(0, 6)
                  .map(([key, val]) => (
                    <div key={key} className="expanded-card__detail-row">
                      <span className="expanded-card__detail-key">{key}</span>
                      <span className="expanded-card__detail-val">
                        {typeof val === 'string' ? val : JSON.stringify(val)}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>

        {/* 操作按钮区 */}
        <div className="expanded-card__footer is-visible">
          <button
            type="button"
            className="expanded-card__btn expanded-card__btn--ghost"
            onClick={handleClose}
          >
            关闭
          </button>
          <button
            type="button"
            className="expanded-card__btn expanded-card__btn--primary"
            onClick={handleExtend}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v8M8 12h8" />
            </svg>
            延伸拓展
          </button>
        </div>
      </motion.div>
    </div>
    ) : null
  )
}

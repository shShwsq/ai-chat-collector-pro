/**
 * 大卡浮层：卡片点击后「飞出来」展开的全屏浮层。
 *
 * 动画：FLIP (First → Last → Invert → Play)
 * - 点击卡片时记录原位置 (First)
 * - 大卡最终在屏幕中央 (Last)
 * - 初始 transform 把大卡放回原位置 (Invert)
 * - 下一帧移除 transform，卡片"飞"到中央 (Play)
 *
 * 关闭时反向飞回原位。
 */

import { useLayoutEffect, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import { parseDate } from '../lib/date'
import type { Node, RecommendationItem } from '../lib/types'

interface ChatExpandedOverlayProps {
  graphViewRef?: React.RefObject<unknown> | null
}

export function ChatExpandedOverlay(_props: ChatExpandedOverlayProps) {
  const chatExpandedNodeId = useAppStore((s) => s.chatExpandedNodeId)
  const setChatExpandedNodeId = useAppStore((s) => s.setChatExpandedNodeId)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)
  const fullGraph = useAppStore((s) => s.fullGraph)
  const recommendations = useAppStore((s) => s.recommendations)
  const mode = useAppStore((s) => s.mode)

  // DOM refs
  const originRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // 动画状态
  const [isPlaying, setIsPlaying] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [contentVisible, setContentVisible] = useState(false)
  const contentTimerRef = useRef<number | null>(null)

  const isOpen = chatExpandedNodeId !== null

  // 找到当前展开的推荐项
  const recItem: RecommendationItem | undefined = isOpen
    ? recommendations.find((r: RecommendationItem) => r.node.id === chatExpandedNodeId)
    : undefined
  const node: Node | undefined = recItem?.node ?? fullGraph?.nodes.find((n: Node) => n.id === chatExpandedNodeId)
  const reason = recItem?.reason
  const isOverdue = recItem?.is_overdue
  const isUpcoming = recItem?.is_upcoming
  const daysSinceReview = recItem?.days_since_review
  const errorRate = recItem?.error_rate

  useLayoutEffect(() => {
    if (contentTimerRef.current) window.clearTimeout(contentTimerRef.current)
    if (!isOpen) {
      setIsPlaying(false)
      setIsClosing(false)
      setIsTransitioning(false)
      setContentVisible(false)
      return
    }

    // 找到原卡片 DOM
    const originEl = document.querySelector<HTMLElement>(
      `[data-rec-node-id="${chatExpandedNodeId}"]`,
    )
    if (originEl) {
      const rect = originEl.getBoundingClientRect()
      originRef.current = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
    } else {
      // 找不到原卡时从屏幕外飞入
      originRef.current = {
        left: window.innerWidth / 2 - 80,
        top: window.innerHeight + 100,
        width: 160,
        height: 200,
      }
    }

    if (!cardRef.current || !originRef.current) {
      requestAnimationFrame(() => {
        setIsPlaying(true)
        contentTimerRef.current = window.setTimeout(() => setContentVisible(true), 200)
      })
      return
    }

    const card = cardRef.current
    // 先重置到初始状态
    setIsPlaying(false)
    setContentVisible(false)

    requestAnimationFrame(() => {
      const cardRect = card.getBoundingClientRect()
      const first = originRef.current!
      const dx = first.left - cardRect.left
      const dy = first.top - cardRect.top
      const scale = cardRect.width > 0 ? first.width / cardRect.width : 0.8

      card.style.setProperty('--flip-x', `${dx}px`)
      card.style.setProperty('--flip-y', `${dy}px`)
      card.style.setProperty('--flip-scale', `${scale * 0.85}`)
      card.style.setProperty('--flip-rot', '-6deg')
      void card.offsetWidth // 触发 reflow

      requestAnimationFrame(() => {
        setIsPlaying(true)
        card.style.setProperty('--flip-rot', '0deg')
        // 内容延迟淡入
        contentTimerRef.current = window.setTimeout(() => setContentVisible(true), 150)
      })
    })
    return () => {
      if (contentTimerRef.current) window.clearTimeout(contentTimerRef.current)
    }
  }, [isOpen, chatExpandedNodeId])

  const handleClose = () => {
    if (!cardRef.current) {
      setChatExpandedNodeId(null)
      return
    }

    setIsPlaying(false)
    setIsClosing(true)
    setContentVisible(false)
    const card = cardRef.current

    if (originRef.current) {
      const cardRect = card.getBoundingClientRect()
      const first = originRef.current
      const dx = first.left - cardRect.left
      const dy = first.top - cardRect.top
      const scale = cardRect.width > 0 ? first.width / cardRect.width : 0.8
      card.style.setProperty('--flip-x', `${dx}px`)
      card.style.setProperty('--flip-y', `${dy}px`)
      card.style.setProperty('--flip-scale', `${scale * 0.85}`)
      card.style.setProperty('--flip-rot', '5deg')
    }

    if (contentTimerRef.current) window.clearTimeout(contentTimerRef.current)
    contentTimerRef.current = window.setTimeout(() => {
      setChatExpandedNodeId(null)
    }, 400)
  }

  const handleExtend = () => {
    if (!chatExpandedNodeId) return
    setIsTransitioning(true)
    setContentVisible(false)
    window.setTimeout(() => {
      // 切换到图谱视图并选中该节点
      setSelectedNode(chatExpandedNodeId)
      setActiveNav('graph')
      setChatExpandedNodeId(null)
    }, 280)
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose()
  }

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

  if (!isOpen || !node) return null

  // 获取标签样式
  const getStatusBadge = () => {
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
  const typeLabel = formatTypeLabel(node.type)

  const overlayCls = [
    'expanded-overlay',
    isPlaying ? 'is-playing' : '',
    isClosing ? 'is-closing' : '',
    isTransitioning ? 'is-transitioning' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={overlayCls}
      onClick={handleBackdropClick}
    >
      <div className="expanded-overlay__backdrop" />
      <div className="expanded-overlay__card" ref={cardRef}>
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
        <div className={`expanded-card__header${contentVisible ? ' is-visible' : ''}`}>
          <div className="expanded-card__top-row">
            <span className="expanded-card__type">{typeLabel}</span>
            {badge && (
              <span className={`expanded-card__badge ${badge.cls}`}>{badge.text}</span>
            )}
          </div>
          <h2 className="expanded-card__title">{node.title || '（无标题）'}</h2>
        </div>

        {/* 卡片内容区 */}
        <div className={`expanded-card__body${contentVisible ? ' is-visible' : ''}`}>
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
        <div className={`expanded-card__footer${contentVisible ? ' is-visible' : ''}`}>
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
      </div>
    </div>
  )
}

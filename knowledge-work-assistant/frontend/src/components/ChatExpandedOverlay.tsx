/**
 * 对话首页"点击卡片飞到中央展开为大卡"的顶层浮层。
 *
 * 为什么放在 App 顶层而不是 ChatHome 内：
 * - 大卡浮层需要在 ``activeNav`` 从 'chat' 切到 'graph'（无缝衔接图谱）时仍存活，
 *   而 ChatHome 会随 ChatPanel 卸载而消失——本地 state 会丢失。
 * - 把浮层提到 App 顶层、读全局 ``chatExpandedNodeId``，可跨视图存活，
 *   实现"大卡在中央 → 切图谱视图 → 大卡淡出露出图谱 NodeDetailCard"的无缝衔接。
 *
 * FLIP 飞入动画：
 * 1. ``chatExpandedNodeId`` 变为非空时，查询 ChatHome DOM 中带 ``data-rec-node-id`` 的卡片，
 *    记录其 ``getBoundingClientRect()`` 作为 First。
 * 2. 浮层中央大卡渲染后（Last = 居中位置），用 CSS 变量 ``--flip-x/y/scale`` 把大卡
 *    "倒回"到 First 位置（Invert）。
 * 3. 下一帧加 ``is-playing`` 类，transform 过渡到 ``translate(0,0) scale(1)``（Play）。
 * 4. 收回（backdrop 点击 / 关闭按钮）：去掉 ``is-playing``，大卡反向飞回 First 位置，
 *    过渡结束后 ``setChatExpandedNodeId(null)`` 卸载。
 *
 * 无缝切图谱（onRequestGraphSwitch / onEdit / onDelete）：
 * - 加 ``is-transitioning`` 类：backdrop 淡出、大卡准备淡出
 * - ``setSelectedNode(nodeId)`` + ``setActiveNav('graph')`` + ``focusNodeAtCenter(nodeId)``
 * - 双 rAF 后（等图谱视图与 NodeDetailCard 渲染好）大卡 opacity 淡出
 * - 淡出完成 → ``setChatExpandedNodeId(null)`` 卸载浮层
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAppStore } from '../store/useAppStore'
import type { Node } from '../lib/types'
import type { GraphViewHandle } from './graph/GraphView'
import { NodeDetailCard } from './graph/NodeDetailCard'

export interface ChatExpandedOverlayProps {
  /** 图谱视图 ref，用于无缝切换时把目标节点平移到视口中央。 */
  graphViewRef: React.RefObject<GraphViewHandle | null>
}

interface OriginRect {
  left: number
  top: number
  width: number
  height: number
}

export function ChatExpandedOverlay({ graphViewRef }: ChatExpandedOverlayProps) {
  const expandedId = useAppStore((s) => s.chatExpandedNodeId)
  const setExpandedId = useAppStore((s) => s.setChatExpandedNodeId)
  const fullGraph = useAppStore((s) => s.fullGraph)
  const mode = useAppStore((s) => s.mode)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)
  const setActiveNav = useAppStore((s) => s.setActiveNav)

  const overlayRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const originRef = useRef<OriginRect | null>(null)

  /** 控制 opacity 淡入淡出（浮层开/关）。 */
  const [isOpen, setIsOpen] = useState(false)
  /** 控制 FLIP Play（大卡从原位飞到中央）。 */
  const [isPlaying, setIsPlaying] = useState(false)
  /** 控制无缝切图谱时大卡与 backdrop 的淡出。 */
  const [isTransitioning, setIsTransitioning] = useState(false)
  /** FLIP 初始变换 CSS 变量（Invert 阶段）。
   *  用 ``React.CSSProperties`` 的索引签名扩展自定义 CSS 变量，
   *  避免 TS 严格模式拒绝 ``--flip-x`` 等非标准属性。 */
  const [flipVars, setFlipVars] = useState<
    | {
        '--flip-x': string
        '--flip-y': string
        '--flip-scale': string
        [key: string]: string
      }
    | null
  >(null)

  const node =
    expandedId && fullGraph
      ? (fullGraph.nodes.find((n) => n.id === expandedId) ?? null)
      : null

  // ===== 开：捕获 First rect + 算 Invert 变量 =====
  useLayoutEffect(() => {
    if (!expandedId) {
      // 关闭：重置所有状态
      setIsOpen(false)
      setIsPlaying(false)
      setIsTransitioning(false)
      setFlipVars(null)
      originRef.current = null
      return
    }

    // 查 ChatHome 中带 data-rec-node-id 的原卡片，记 First
    const originEl = document.querySelector(
      `[data-rec-node-id="${CSS.escape(expandedId)}"]`,
    )
    if (originEl) {
      const r = originEl.getBoundingClientRect()
      originRef.current = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      }
    } else {
      originRef.current = null
    }

    // 先把浮层显示出来（opacity 淡入），但大卡仍位于中央（尚未设 flip 变量）
    setIsTransitioning(false)
    setIsOpen(true)
    setIsPlaying(false)
    setFlipVars(null)
  }, [expandedId])

  // ===== 算 Invert 变量 + 触发 Play =====
  // 直接操作 DOM 设置 CSS 变量（不走 React state），避免 setFlipVars 与
  // setIsPlaying 被 React 18 concurrent mode 批处理到同一帧，导致 Invert
  // transform 未被浏览器绘制、CSS transition 无起点、动画不播放。
  // 配合 force reflow 确保浏览器已将 Invert transform 应用到渲染层，
  // 下一帧再添加 is-playing 类触发 Play，transition 才能正确插值。
  useLayoutEffect(() => {
    if (!isOpen || !originRef.current || !cardRef.current) {
      // 无原卡片 rect：直接 Play（仅淡入+缩放，无 FLIP 位移）
      if (isOpen) {
        const raf = requestAnimationFrame(() =>
          requestAnimationFrame(() => setIsPlaying(true)),
        )
        return () => cancelAnimationFrame(raf)
      }
      return
    }
    const card = cardRef.current
    // Last：大卡当前居中位置
    const cardRect = card.getBoundingClientRect()
    const first = originRef.current
    // Invert：把大卡从中央位移到 First 位置，并缩放到 First 尺寸
    const dx = first.left - cardRect.left
    const dy = first.top - cardRect.top
    const scale =
      cardRect.width > 0 ? first.width / cardRect.width : 1
    // 直接写 DOM style 的 CSS 变量，立即生效（无需等 React 重渲染）
    card.style.setProperty('--flip-x', `${dx}px`)
    card.style.setProperty('--flip-y', `${dy}px`)
    card.style.setProperty('--flip-scale', `${scale}`)
    // force reflow：强制浏览器将当前样式（Invert transform）刷到渲染层，
    // 否则后续 is-playing 的 transform 变更可能被合并，transition 不触发。
    void card.offsetWidth
    // 下一帧 Play：transform 过渡到 translate(0,0) scale(1)
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setIsPlaying(true)),
    )
    return () => cancelAnimationFrame(raf)
  }, [isOpen])

  // ===== 关闭：反向 FLIP 飞回原位，结束后卸载 =====
  const handleClose = () => {
    if (!originRef.current) {
      // 无原位：直接卸载
      setExpandedId(null)
      return
    }
    // 去掉 is-playing → transform 回到 flip 变量（原位）
    setIsPlaying(false)
    // 等过渡结束再卸载（与 CSS transform 420ms 对齐，留点余量）
    window.setTimeout(() => {
      setExpandedId(null)
    }, 440)
  }

  // ===== 无缝切图谱 =====
  const handleSwitchToGraph = (nodeId: string) => {
    if (isTransitioning) return
    setIsTransitioning(true)
    setSelectedNode(nodeId)
    setActiveNav('graph')
    // 让目标节点平移到视口中央（图谱视图渲染后调用）。
    // 用 setTimeout 而非双 rAF：React 18 concurrent mode 下 rAF 回调可能
    // 因重渲染批次被延迟或丢弃，导致 setExpandedId(null) 永不执行（浮层不卸载）。
    // setTimeout 更可靠地等到 GraphView 挂载完成。
    window.setTimeout(() => {
      graphViewRef.current?.focusNodeAtCenter(nodeId)
    }, 60)
    // 等 GraphView 的 NodeDetailCard 渲染好后再淡出大卡。
    // is-transitioning 已让大卡 opacity 淡出（250ms），280ms 后卸载浮层。
    window.setTimeout(() => {
      setExpandedId(null)
    }, 340)
  }

  if (!expandedId || !node) return null

  const overlayCls = [
    'chat-expanded-overlay',
    isOpen ? 'is-open' : '',
    isPlaying ? 'is-playing' : '',
    isTransitioning ? 'is-transitioning' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div ref={overlayRef} className={overlayCls}>
      <div
        className="chat-expanded-overlay__backdrop"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div
        ref={cardRef}
        className="chat-expanded-overlay__card"
        style={(flipVars as React.CSSProperties) ?? undefined}
      >
        <NodeDetailCard
          node={node}
          graphType={mode}
          pinned
          position={{ left: 0, top: 0, width: 0, maxHeight: 9999 /* 由外层 .chat-expanded-overlay__card max-height: 80vh 兜底 */ }}
          onCardMouseEnter={() => {}}
          onCardMouseLeave={() => {}}
          onClose={handleClose}
          onEdit={(n: Node) => handleSwitchToGraph(n.id)}
          onDelete={(n: Node) => handleSwitchToGraph(n.id)}
          onRequestGraphSwitch={(id) => handleSwitchToGraph(id)}
        />
      </div>
    </div>,
    document.body,
  )
}

export default ChatExpandedOverlay

/**
 * 图谱视图（Task 5）。
 *
 * 基于 d3-force 力导向布局 + 自定义 SVG 渲染：
 * - 每个节点渲染为小卡片（180×72px）：常显「标题（一行截断）+ 一句话概括（两行截断）
 *   + 类型标签（左下角 chip）」
 * - 灰色节点（``is_gray=true``）用浅灰背景 + 虚线边框区分
 * - 边用二次贝塞尔曲线连接两节点中心，hover 高亮
 * - 节点可拖拽（拖拽时固定位置 fx/fy，松开后保持）
 * - 画布支持鼠标滚轮缩放（以光标为中心）、空白处拖拽平移
 * - 力导向自适应布局：charge 互斥、link 距离、center 居中、collide 防重叠
 * - 通过 ``ref`` 暴露 ``relayout()`` 方法供 toolbar「重新布局」按钮调用
 *
 * 性能策略：
 * - tick 高频回调中通过 ``nodeElsRef`` / ``edgeElsRef`` 直接更新 DOM 的 transform / d 属性，
 *   不触发 React 重渲染；位置快照存于 ``positionsRef`` 供 React 重渲染时读取
 * - 仅在 fullGraph / selectedNodeId / hoveredNodeId 等低频状态变化时触发 React 重渲染
 * - ``alphaDecay`` 设为 0.045，使模拟在约 100 帧内收敛停止
 *
 * 交互桩（Task 7/8 实现）：``onNodeHover`` / ``onNodeClick`` / ``onNodeDoubleClick``
 * 当前仅 console.log，便于后续接入悬停详情卡 / 单击选中 / 双击延伸。
 *
 * Task 7/9 已接入：
 * - 悬停 400ms 显示 NodeDetailCard，移开 250ms 消失；单击节点固定（pinned）详情卡
 * - 详情卡内「编辑」打开 NodeEditor，「删除」打开 ConfirmDialog 二次确认
 * - 详情卡定位随节点坐标计算，靠右展示，溢出翻左并夹取到视口内
 *
 * Task 8 已接入：
 * - 双击节点触发全部延伸（``store.extendNode(node.id, 'all')``）：
 *   新建灰色节点 + extends 边，命中已存在节点不重复创建；延伸进行中
 *   显示加载提示；成功后整图刷新，新建 / 已存在节点加入 ``flashNodeIds`` 闪烁。
 * - ``flashNodeIds`` 命中的节点添加 ``is-flash`` 类触发 CSS 闪烁动画。
 * - 单击方向的单点延伸由 NodeDetailCard 触发（``store.extendNode(node.id, 'single', directionName)``）。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

import { useAppStore } from '../../store/useAppStore'
import type { Edge, FullGraph, Node } from '../../lib/types'
import {
  CARD_PAD_X,
  clampScale,
  edgePath,
  estimateTextWidth,
  isSameGraphStructure,
  NODE_HEIGHT,
  NODE_WIDTH,
  truncateText,
  wrapText,
} from './graphUtils'
import { ConfirmDialog } from './ConfirmDialog'
import { NodeDetailCard } from './NodeDetailCard'
import { NodeEditor } from './NodeEditor'

/** d3-force 节点数据（扩展 Node，附加坐标 / 速度 / 固定位置字段）。 */
type SimNode = Node & SimulationNodeDatum

/** d3-force 边数据；forceLink 初始化后 source/target 会被替换为节点对象引用。 */
type SimEdge = {
  id: string
  relation: string
  source: SimNode | string
  target: SimNode | string
}

/** 暴露给父组件（toolbar「重新布局」按钮）的命令接口。 */
export interface GraphViewHandle {
  /** 重置力导向：清除所有固定位置、随机重排、重新加热模拟。 */
  relayout: () => void
  /** 重置缩放与平移到默认（1x，居中）。 */
  resetView: () => void
  /**
   * 平移画布让指定节点位于视口正中央（缩放保持不变）。
   * 用于对话首页大卡无缝切换到图谱视图时把目标节点居中。
   * 节点不存在或位置未就绪时静默返回。
   */
  focusNodeAtCenter: (nodeId: string) => void
}

export interface GraphViewProps {
  /** 节点悬停回调桩（Task 7 接入详情卡）。 */
  onNodeHover?: (node: Node | null) => void
  /** 节点单击回调桩（Task 7 接入选中固定详情卡）。 */
  onNodeClick?: (node: Node) => void
  /** 节点双击回调桩（Task 8 接入全部延伸 / 详情面板）。 */
  onNodeDoubleClick?: (node: Node) => void
}

/** 拖拽状态机：无 / 平移画布 / 拖拽节点。 */
type DragState =
  | { kind: 'none' }
  | {
      kind: 'pan'
      startClientX: number
      startClientY: number
      startTranslateX: number
      startTranslateY: number
    }
  | {
      kind: 'node'
      nodeId: string
      startClientX: number
      startClientY: number
      startNodeX: number
      startNodeY: number
      moved: boolean
    }

// 卡片内字号
const FONT_TITLE = 13
const FONT_SUMMARY = 11
const FONT_CHIP = 10

// 力导向参数
const LINK_DISTANCE = 170
const CHARGE_STRENGTH = -420
const COLLIDE_RADIUS = 92
const ALPHA_DECAY = 0.045

export const GraphView = forwardRef<GraphViewHandle, GraphViewProps>(
  function GraphView(props, ref) {
    const { onNodeHover, onNodeClick, onNodeDoubleClick } = props

    const fullGraph = useAppStore((s) => s.fullGraph)
    const selectedNodeId = useAppStore((s) => s.selectedNodeId)
    const setSelectedNode = useAppStore((s) => s.setSelectedNode)
    const mode = useAppStore((s) => s.mode)
    const deleteNode = useAppStore((s) => s.deleteNode)
    // 当前图谱 ID：用于在切换时触发固定时长的过渡动画，
    // 避免 loading 状态持续时间过短导致 CSS transition 看不出效果。
    const currentGraphId = useAppStore((s) => s.currentGraphId)
    // 加载态：用于切换图谱时的淡入淡出过渡
    const loading = useAppStore((s) => s.loading)
    // Task 8：节点延伸
    const extendNodeAction = useAppStore((s) => s.extendNode)
    const extending = useAppStore((s) => s.extending)
    const flashNodeIds = useAppStore((s) => s.flashNodeIds)

    // 切换图谱过渡：currentGraphId 变化时标记 transitioning=true 并保留旧 displayGraph，
    // 让旧图谱先高斯模糊一段时间；fullGraph 变化（新图谱到达）后延迟更新 displayGraph
    // 并清除 transitioning，实现"先模糊 → 切过去 → 不模糊"的视觉顺序。
    const [displayGraph, setDisplayGraph] = useState<FullGraph | null>(fullGraph)
    const [transitioning, setTransitioning] = useState(false)
    const prevGraphIdRef = useRef<string | null>(currentGraphId)
    // 等待新图谱到达标记：currentGraphId 变化时置 true，fullGraph 真正变化时消费
    const waitingNewGraphRef = useRef(false)
    // 记录上一次同步到 displayGraph 的 fullGraph 引用，用于判断 fullGraph 是否真正变化
    const lastSyncedGraphRef = useRef<FullGraph | null>(fullGraph)

    // currentGraphId 变化（用户点击切换）：立即触发 blur，保留旧 displayGraph
    useEffect(() => {
      const prevId = prevGraphIdRef.current
      if (prevId !== currentGraphId) {
        if (prevId !== null && currentGraphId !== null) {
          // 切换图谱：挂上 blur，标记等待新图谱到达
          setTransitioning(true)
          waitingNewGraphRef.current = true
        }
        prevGraphIdRef.current = currentGraphId
      }
    }, [currentGraphId])

    // fullGraph 变化（新图谱数据到达）：延迟更新 displayGraph，让旧图谱 blur 一段时间
    useEffect(() => {
      if (fullGraph === null) {
        // 切回空状态（如切换模式）：立即清空
        setDisplayGraph(null)
        setTransitioning(false)
        waitingNewGraphRef.current = false
        lastSyncedGraphRef.current = null
        return
      }
      // fullGraph 引用未变化（仅 transitioning 变化触发的重执行）：跳过
      if (fullGraph === lastSyncedGraphRef.current) {
        return
      }
      // 正在等待新图谱到达（切换图谱过渡）：延迟 160ms 让旧图谱 blur 完整展示
      if (waitingNewGraphRef.current) {
        waitingNewGraphRef.current = false
        const timer = setTimeout(() => {
          setDisplayGraph(fullGraph)
          lastSyncedGraphRef.current = fullGraph
          // displayGraph 切换后，再延迟一帧清除 transitioning，让新图谱从 blur 淡入还原
          requestAnimationFrame(() => {
            setTransitioning(false)
          })
        }, 160)
        return () => clearTimeout(timer)
      }
      // 非过渡场景（如节点更新、延伸刷新、首次加载）：直接同步
      setDisplayGraph(fullGraph)
      lastSyncedGraphRef.current = fullGraph
    }, [fullGraph])

    const containerRef = useRef<HTMLDivElement>(null)
    const svgRef = useRef<SVGSVGElement>(null)
    const simRef = useRef<Simulation<SimNode, SimEdge> | null>(null)
    /** 节点 DOM 元素 Map（id → <g>），tick 时直接更新 transform。 */
    const nodeElsRef = useRef<Map<string, SVGGElement>>(new Map())
    /** 边 DOM 元素 Map（id → <path>），tick 时直接更新 d。 */
    const edgeElsRef = useRef<Map<string, SVGPathElement>>(new Map())
    /** 节点最新坐标快照，React 重渲染时读取以保证 transform 一致。 */
    const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
    /** 已初始化 transform 的节点 id 集合：避免重渲染时 ref callback 用过期 pos 覆盖 d3 tick 写入的 DOM。 */
    const nodeInitRef = useRef<Set<string>>(new Set())
    /** 已初始化 d 属性的边 id 集合：同上，避免重渲染覆盖 d3 tick 写入的 path。 */
    const edgeInitRef = useRef<Set<string>>(new Set())
    /** 当前拖拽状态。 */
    const dragRef = useRef<DragState>({ kind: 'none' })
    /** 上一次用于重建 simulation 的图谱结构快照，用于判断是字段更新还是结构更新。 */
    const lastGraphSnapshotRef = useRef<{ nodeIds: string[]; edgeKeys: string[] } | null>(null)
    /** 最新画布尺寸（避免尺寸变化重建 simulation）。 */
    const sizeRef = useRef<{ width: number; height: number }>({ width: 800, height: 600 })
    /** 最新 transform（供 mousemove 闭包读取）。 */
    const transformRef = useRef({ x: 0, y: 0, k: 1 })
    /** Task 7：悬停/离开延时计时器 + 卡片悬停标记。 */
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const isCardHoveredRef = useRef(false)

    const [size, setSize] = useState({ width: 800, height: 600 })
    const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
    const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
    // Task 7/9：悬停详情卡 / 编辑器 / 删除确认
    const [hoveredNode, setHoveredNode] = useState<Node | null>(null)
    const [detailPosition, setDetailPosition] = useState({
      left: 0,
      top: 0,
      width: 340,
      maxHeight: 500,
    })
    const [showEditor, setShowEditor] = useState(false)
    const [editorNode, setEditorNode] = useState<Node | null>(null)
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState<Node | null>(null)
    // forceRender：simulation 停止后若需强制重渲染（如 relayout 重排后）触发
    const [, forceRender] = useReducer((x: number) => x + 1, 0)

    // 详情卡显示节点：悬停优先，悬停离开后回退到选中（固定）节点
    // 基于 displayGraph（延迟同步的视图状态）而非 store 的 fullGraph，
    // 确保切换图谱过渡期间详情卡跟随旧图谱视图。
    const selectedNodeObj = useMemo(
      () => displayGraph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
      [displayGraph, selectedNodeId],
    )
    const displayedNode = hoveredNode ?? selectedNodeObj
    const pinned = displayedNode !== null && displayedNode.id === selectedNodeId

    // 同步 transform 到 ref，供事件闭包读取最新值
    useEffect(() => {
      transformRef.current = transform
    }, [transform])

    // ===== 容器尺寸观察 =====
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) {
          const { width, height } = e.contentRect
          const next = {
            width: Math.max(width, 100),
            height: Math.max(height, 100),
          }
          sizeRef.current = next
          setSize(next)
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    // ===== 重建 simulation（图谱数据变化时）=====
    // 依赖 displayGraph：切换图谱过渡期间 displayGraph 保持为旧值，
    // 旧 simulation 不会被销毁，直到 displayGraph 切换到新图谱才重建。
    useEffect(() => {
      if (!displayGraph) {
        simRef.current?.stop()
        simRef.current = null
        nodeElsRef.current.clear()
        edgeElsRef.current.clear()
        positionsRef.current.clear()
        nodeInitRef.current.clear()
        edgeInitRef.current.clear()
        lastGraphSnapshotRef.current = null
        return
      }

      // 若已有 simulation 且结构未变，仅 React 重渲染更新节点文本/样式，
      // 不重建 simulation，避免点击节点生成详情时整图受力重排抽动。
      if (simRef.current && lastGraphSnapshotRef.current) {
        // 用上一个 displayGraph 快照与新 displayGraph 比较结构
        const prevGraph: FullGraph = {
          graph: displayGraph.graph,
          stats: displayGraph.stats,
          nodes: lastGraphSnapshotRef.current.nodeIds.map((id) => ({ id } as Node)),
          edges: lastGraphSnapshotRef.current.edgeKeys.map((k) => {
            const [src, dst] = k.split('->')
            return { id: k, src_id: src, dst_id: dst } as Edge
          }),
        }
        if (isSameGraphStructure(prevGraph, displayGraph)) {
          return
        }
      }

      const { width, height } = sizeRef.current
      // 节点初始位置：按 index 在中心周围均匀环形分布（替代 Math.random），
      // 让新图谱到达时仿真启动视觉更稳定，避免"爆炸式"随机散开。
      const N = displayGraph.nodes.length
      const baseR = N > 0 ? Math.min(width, height) * 0.18 : 0
      const nodes: SimNode[] = displayGraph.nodes.map((n, i) => {
        const angle = N > 0 ? (i / N) * Math.PI * 2 : 0
        const r = baseR + (i % 3) * 12 // 微小分层避免完全重合
        return {
          ...n,
          x: width / 2 + Math.cos(angle) * r,
          y: height / 2 + Math.sin(angle) * r,
          vx: 0,
          vy: 0,
          fx: null,
          fy: null,
        }
      })
      const edges: SimEdge[] = displayGraph.edges.map((e: Edge) => ({
        id: e.id,
        relation: e.relation,
        source: e.src_id,
        target: e.dst_id,
      }))

      const newSim = forceSimulation<SimNode>(nodes)
        .force(
          'link',
          forceLink<SimNode, SimEdge>(edges)
            .id((d) => d.id)
            .distance(LINK_DISTANCE)
            .strength(0.25),
        )
        .force('charge', forceManyBody().strength(CHARGE_STRENGTH))
        .force('center', forceCenter(width / 2, height / 2))
        .force(
          'collide',
          forceCollide<SimNode>().radius(COLLIDE_RADIUS),
        )
        .alphaDecay(ALPHA_DECAY)
        .on('tick', () => {
          // 直接更新 DOM，避免高频 setState
          for (const n of nodes) {
            const el = nodeElsRef.current.get(n.id)
            const x = n.x ?? 0
            const y = n.y ?? 0
            positionsRef.current.set(n.id, { x, y })
            if (el) el.setAttribute('transform', `translate(${x},${y})`)
          }
          for (const e of edges) {
            const s = typeof e.source === 'string' ? null : e.source
            const t = typeof e.target === 'string' ? null : e.target
            if (s && t) {
              const el = edgeElsRef.current.get(e.id)
              if (el) el.setAttribute('d', edgePath(s.x ?? 0, s.y ?? 0, t.x ?? 0, t.y ?? 0))
            }
          }
        })

      simRef.current = newSim
      lastGraphSnapshotRef.current = {
        nodeIds: displayGraph.nodes.map((n) => n.id),
        edgeKeys: displayGraph.edges.map((e) => `${e.src_id}->${e.dst_id}`),
      }

      return () => {
        newSim.stop()
      }
      // 仅在图谱切换时重建；尺寸变化通过 center force 更新
    }, [displayGraph])

    // ===== 尺寸变化时更新 center force =====
    useEffect(() => {
      const sim = simRef.current
      if (!sim) return
      sim
        .force('center', forceCenter(size.width / 2, size.height / 2))
        .alpha(0.3)
        .restart()
    }, [size.width, size.height])

    // ===== 全局鼠标移动 / 松开（拖拽与平移）=====
    useEffect(() => {
      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current
        const svg = svgRef.current
        if (!svg) return
        if (drag.kind === 'pan') {
          const dx = ev.clientX - drag.startClientX
          const dy = ev.clientY - drag.startClientY
          setTransform((prev) => ({
            ...prev,
            x: drag.startTranslateX + dx,
            y: drag.startTranslateY + dy,
          }))
        } else if (drag.kind === 'node') {
          const dx = ev.clientX - drag.startClientX
          const dy = ev.clientY - drag.startClientY
          // 位移未超过阈值时视为点击，不设 fx/fy、不重启 simulation，
          // 避免微移误触发力导向重排导致整图抽动
          if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return
          const { k } = transformRef.current
          const nx = drag.startNodeX + dx / k
          const ny = drag.startNodeY + dy / k
          const sim = simRef.current
          if (!sim) return
          const node = sim.nodes().find((n) => n.id === drag.nodeId)
          if (!node) return
          node.fx = nx
          node.fy = ny
          positionsRef.current.set(node.id, { x: nx, y: ny })
          const el = nodeElsRef.current.get(node.id)
          if (el) el.setAttribute('transform', `translate(${nx},${ny})`)
          sim.alphaTarget(0.3).restart()
          if (!drag.moved) {
            dragRef.current = { ...drag, moved: true }
          }
        }
      }
      const onUp = () => {
        const drag = dragRef.current
        if (drag.kind === 'node') {
          // 松开后保持固定位置（fx/fy 不清空）
          const sim = simRef.current
          if (sim) sim.alphaTarget(0)
        }
        dragRef.current = { kind: 'none' }
        // 清除节点拖拽时设置的 cursor
        if (svgRef.current) svgRef.current.style.cursor = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
    }, [])

    // ===== 滚轮缩放（以光标为中心）=====
    const onWheel = useCallback((ev: React.WheelEvent<SVGSVGElement>) => {
      ev.preventDefault()
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const cx = ev.clientX - rect.left
      const cy = ev.clientY - rect.top
      const { x, y, k } = transformRef.current
      // 缩放因子： deltaY > 0 向下滚 → 缩小
      const factor = ev.deltaY > 0 ? 0.9 : 1.1
      const nk = clampScale(k * factor)
      if (nk === k) return
      // 保持光标处 svg 坐标不变：t' = mouse - svgBefore * k'
      const svgX = (cx - x) / k
      const svgY = (cy - y) / k
      const nx = cx - svgX * nk
      const ny = cy - svgY * nk
      setTransform({ x: nx, y: ny, k: nk })
    }, [])

    // ===== 画布平移：在背景层 mousedown =====
    const onBackgroundMouseDown = useCallback(
      (ev: React.MouseEvent<SVGRectElement>) => {
        // 仅左键
        if (ev.button !== 0) return
        const { x, y } = transformRef.current
        dragRef.current = {
          kind: 'pan',
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startTranslateX: x,
          startTranslateY: y,
        }
        if (svgRef.current) svgRef.current.style.cursor = 'grabbing'
      },
      [],
    )

    // ===== 节点 mousedown：开始拖拽节点 =====
    const onNodeMouseDown = useCallback(
      (ev: React.MouseEvent<SVGGElement>, node: Node) => {
        if (ev.button !== 0) return
        ev.stopPropagation()
        const svg = svgRef.current
        if (!svg) return
        const pos = positionsRef.current.get(node.id) ?? { x: 0, y: 0 }
        dragRef.current = {
          kind: 'node',
          nodeId: node.id,
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startNodeX: pos.x,
          startNodeY: pos.y,
          moved: false,
        }
        svg.style.cursor = 'grabbing'
      },
      [],
    )

    // ===== Task 7/9：悬停详情卡 / 编辑 / 删除 =====
    const clearHoverTimer = useCallback(() => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }, [])
    const clearLeaveTimer = useCallback(() => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current)
        leaveTimerRef.current = null
      }
    }, [])

    // 详情卡定位：基于节点在容器内的坐标，默认靠右展示，溢出时翻到左侧并夹取到视口内
    const updateDetailPosition = useCallback(
      (node: Node) => {
        const container = containerRef.current
        if (!container) return
        const rect = container.getBoundingClientRect()
        const cw = rect.width
        const ch = rect.height
        const pos = positionsRef.current.get(node.id)
        if (!pos) return
        const { x, y, k } = transformRef.current
        const cx = x + pos.x * k
        const cy = y + pos.y * k
        const cardW = 340
        const cardMaxH = 500
        const gap = 12
        const nodeHalfW = (NODE_WIDTH / 2) * k
        let left = cx + nodeHalfW + gap
        if (left + cardW > cw - 8) {
          left = cx - nodeHalfW - gap - cardW
        }
        left = Math.max(8, Math.min(left, cw - cardW - 8))
        const effMaxH = Math.min(cardMaxH, ch - 16)
        let top = cy - 60
        top = Math.max(8, Math.min(top, ch - effMaxH - 8))
        setDetailPosition({ left, top, width: cardW, maxHeight: cardMaxH })
      },
      [],
    )

    // 悬停进入：300-500ms 后显示详情卡
    const handleNodeMouseEnter = useCallback(
      (node: Node) => {
        clearLeaveTimer()
        if (hoveredNode?.id === node.id) {
          clearHoverTimer()
          return
        }
        clearHoverTimer()
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null
          setHoveredNode(node)
        }, 400)
      },
      [hoveredNode?.id, clearHoverTimer, clearLeaveTimer],
    )

    // 悬停离开：200-300ms 后清除悬停态（卡片悬停时保持）
    const handleNodeMouseLeave = useCallback(() => {
      clearHoverTimer()
      if (isCardHoveredRef.current) return
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        if (isCardHoveredRef.current) return
        setHoveredNode(null)
      }, 250)
    }, [clearHoverTimer, clearLeaveTimer])

    const handleCardMouseEnter = useCallback(() => {
      isCardHoveredRef.current = true
      clearLeaveTimer()
    }, [clearLeaveTimer])

    const handleCardMouseLeave = useCallback(() => {
      isCardHoveredRef.current = false
      clearLeaveTimer()
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        if (isCardHoveredRef.current) return
        setHoveredNode(null)
      }, 250)
    }, [clearLeaveTimer])

    const handleCloseDetail = useCallback(() => {
      clearHoverTimer()
      clearLeaveTimer()
      setHoveredNode(null)
      setSelectedNode(null)
    }, [clearHoverTimer, clearLeaveTimer, setSelectedNode])

    const handleEdit = useCallback((node: Node) => {
      setEditorNode(node)
      setShowEditor(true)
    }, [])

    const handleDelete = useCallback((node: Node) => {
      setDeleteTarget(node)
      setShowDeleteConfirm(true)
    }, [])

    const handleConfirmDelete = useCallback(async () => {
      const target = deleteTarget
      if (!target) return
      setShowDeleteConfirm(false)
      setDeleteTarget(null)
      const ok = await deleteNode(target.id)
      if (ok) {
        setHoveredNode(null)
      }
    }, [deleteTarget, deleteNode])

    const handleCancelDelete = useCallback(() => {
      setShowDeleteConfirm(false)
      setDeleteTarget(null)
    }, [])

    // ===== 节点单击 / 双击 / 悬停 =====
    const onNodeClickInner = useCallback(
      (ev: React.MouseEvent<SVGGElement>, node: Node) => {
        // 若刚刚是拖拽，不触发 click
        if (dragRef.current.kind === 'node' && dragRef.current.moved) return
        ev.stopPropagation()
        setSelectedNode(node.id)
        onNodeClick?.(node)
        // eslint-disable-next-line no-console
        console.log('[GraphView] node click', node.id, node.title)
      },
      [onNodeClick, setSelectedNode],
    )

    const onNodeDoubleClickInner = useCallback(
      (ev: React.MouseEvent<SVGGElement>, node: Node) => {
        ev.stopPropagation()
        // Task 8：双击节点触发全部延伸。延伸进行中时忽略重复触发，
        // 避免短时间产生多批 batch。结果由 store 处理（整图刷新 + 闪烁）。
        if (extending) return
        void extendNodeAction(node.id, 'all')
        onNodeDoubleClick?.(node)
        // eslint-disable-next-line no-console
        console.log('[GraphView] node double click → extend all', node.id, node.title)
      },
      [onNodeDoubleClick, extendNodeAction, extending],
    )

    const onNodeHoverInner = useCallback(
      (node: Node | null) => {
        setHoveredNodeId(node?.id ?? null)
        onNodeHover?.(node)
        if (node) {
          handleNodeMouseEnter(node)
        } else {
          handleNodeMouseLeave()
        }
      },
      [onNodeHover, handleNodeMouseEnter, handleNodeMouseLeave],
    )

    // ===== Task 7：详情卡随显示节点变化更新定位 =====
    useEffect(() => {
      if (!displayedNode) return
      updateDetailPosition(displayedNode)
      // 仅在显示节点 id 变化时重定位（避免高频 tick 触发）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [displayedNode?.id])

    // ===== Task 7：组件卸载时清理悬停计时器 =====
    useEffect(() => {
      return () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      }
    }, [])

    // ===== 暴露 relayout / resetView =====
    useImperativeHandle(
      ref,
      () => ({
        relayout: () => {
          const sim = simRef.current
          if (!sim) return
          const { width, height } = sizeRef.current
          // 清除所有固定位置 + 随机重排
          for (const n of sim.nodes()) {
            n.fx = null
            n.fy = null
            const angle = Math.random() * Math.PI * 2
            const r = 40 + Math.random() * 80
            n.x = width / 2 + Math.cos(angle) * r
            n.y = height / 2 + Math.sin(angle) * r
            n.vx = 0
            n.vy = 0
          }
          sim
            .force('center', forceCenter(width / 2, height / 2))
            .alpha(1)
            .restart()
          forceRender()
        },
        resetView: () => {
          setTransform({ x: 0, y: 0, k: 1 })
        },
        focusNodeAtCenter: (nodeId: string) => {
          const pos = positionsRef.current.get(nodeId)
          if (!pos) return
          const { width, height } = sizeRef.current
          if (!width || !height) return
          // 保持当前缩放 k，平移让节点位于视口正中
          const cur = transformRef.current
          setTransform({
            x: width / 2 - pos.x * cur.k,
            y: height / 2 - pos.y * cur.k,
            k: cur.k,
          })
        },
      }),
      [],
    )

    // ===== 点击空白取消选中 =====
    const onSvgClick = useCallback(() => {
      // 仅在背景层 click 时触发（节点 click 已 stopPropagation）
      if (dragRef.current.kind === 'none') {
        setSelectedNode(null)
      }
    }, [setSelectedNode])

    // 渲染基于 displayGraph：切换过渡期间显示旧图谱视图
    const nodes = displayGraph?.nodes ?? []
    const edges = displayGraph?.edges ?? []

    // 节点标题文本宽度上限（卡片宽 - 左右内边距）
    const titleMaxW = NODE_WIDTH - CARD_PAD_X * 2
    const summaryMaxW = NODE_WIDTH - CARD_PAD_X * 2

    return (
      <div
        className={
          transitioning ? 'gv-container gv-transitioning' : 'gv-container'
        }
        ref={containerRef}
        data-loading={loading || undefined}
        data-empty={!displayGraph || undefined}
      >
        <svg
          ref={svgRef}
          className="gv-svg"
          width={size.width}
          height={size.height}
          onWheel={onWheel}
          onClick={onSvgClick}
        >
          {/* 背景层：用于平移与点击空白取消选中 */}
          <rect
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            fill="transparent"
            onMouseDown={onBackgroundMouseDown}
          />
          {/* 缩放平移容器 */}
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {/* 边层（在节点下层，端点被卡片遮挡） */}
            <g className="gv-edges">
              {edges.map((e) => {
                const isHovered = hoveredEdgeId === e.id
                // 初始 d：从快照读，否则用两端节点中心
                const sp = positionsRef.current.get(e.src_id)
                const tp = positionsRef.current.get(e.dst_id)
                const d =
                  sp && tp
                    ? edgePath(sp.x, sp.y, tp.x, tp.y)
                    : `M0,0L0,0`
                return (
                  <path
                    key={e.id}
                    ref={(el) => {
                      if (el) {
                        edgeElsRef.current.set(e.id, el)
                        // 仅首次挂载设置初始路径；后续 d 由 d3 tick handler 独占更新
                        if (!edgeInitRef.current.has(e.id)) {
                          edgeInitRef.current.add(e.id)
                          el.setAttribute('d', d)
                        }
                      } else {
                        edgeElsRef.current.delete(e.id)
                      }
                    }}
                    className={`gv-edge${isHovered ? ' is-hovered' : ''}`}
                    onMouseEnter={() => setHoveredEdgeId(e.id)}
                    onMouseLeave={() => setHoveredEdgeId(null)}
                  />
                )
              })}
            </g>
            {/* 节点层 */}
            <g className="gv-nodes">
              {nodes.map((n) => {
                const pos =
                  positionsRef.current.get(n.id) ?? { x: size.width / 2, y: size.height / 2 }
                const isSelected = selectedNodeId === n.id
                const isHovered = hoveredNodeId === n.id
                const isGray = n.is_gray
                const isFlash = flashNodeIds.includes(n.id)
                const title = truncateText(n.title || '（无标题）', titleMaxW, FONT_TITLE)
                const summaryLines = wrapText(n.summary || '', summaryMaxW, FONT_SUMMARY, 2)
                const chipText = n.type || '未分类'
                const chipW = estimateTextWidth(chipText, FONT_CHIP) + 12
                return (
                  <g
                    key={n.id}
                    ref={(el) => {
                      if (el) {
                        nodeElsRef.current.set(n.id, el)
                        // 仅首次挂载设置初始位置；后续 transform 由 d3 tick handler 独占更新。
                        // 注意：ref(null) 时不清除 nodeInitRef，否则 React 重渲染的 null→el 循环
                        // 会误判为"首次挂载"再次 setAttribute，用过期 pos 覆盖 tick 写入的 DOM
                        if (!nodeInitRef.current.has(n.id)) {
                          nodeInitRef.current.add(n.id)
                          el.setAttribute('transform', `translate(${pos.x},${pos.y})`)
                        }
                      } else {
                        nodeElsRef.current.delete(n.id)
                      }
                    }}
                    className={[
                      'gv-node',
                      isGray ? 'is-gray' : '',
                      isSelected ? 'is-selected' : '',
                      isHovered ? 'is-hovered' : '',
                      isFlash ? 'is-flash' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseDown={(ev) => onNodeMouseDown(ev, n)}
                    onClick={(ev) => onNodeClickInner(ev, n)}
                    onDoubleClick={(ev) => onNodeDoubleClickInner(ev, n)}
                    onMouseEnter={() => onNodeHoverInner(n)}
                    onMouseLeave={() => onNodeHoverInner(null)}
                  >
                    {/* 内层 g：负责 hover 微提升 scale，与外层 translate 解耦 */}
                    <g className="gv-node__inner">
                      {/* 卡片背景 */}
                      <rect
                        x={-NODE_WIDTH / 2}
                        y={-NODE_HEIGHT / 2}
                        width={NODE_WIDTH}
                        height={NODE_HEIGHT}
                        rx={10}
                        ry={10}
                        className="gv-node__bg"
                      />
                      {/* 标题（单行） */}
                      <text
                        x={-NODE_WIDTH / 2 + CARD_PAD_X}
                        y={-NODE_HEIGHT / 2 + 18}
                        className="gv-node__title"
                      >
                        {title}
                      </text>
                      {/* 概括（最多两行） */}
                      {summaryLines.length > 0 && (
                        <text
                          x={-NODE_WIDTH / 2 + CARD_PAD_X}
                          y={-NODE_HEIGHT / 2 + 34}
                          className="gv-node__summary"
                        >
                          {summaryLines.map((line, i) => (
                            <tspan
                              key={i}
                              x={-NODE_WIDTH / 2 + CARD_PAD_X}
                              dy={i === 0 ? 0 : 14}
                            >
                              {line}
                            </tspan>
                          ))}
                        </text>
                      )}
                      {/* 类型标签 chip（左下角） */}
                      <g
                        className="gv-node__chip"
                        transform={`translate(${-NODE_WIDTH / 2 + CARD_PAD_X}, ${
                          NODE_HEIGHT / 2 - 16
                        })`}
                      >
                        <rect x={0} y={0} width={chipW} height={14} rx={7} ry={7} />
                        <text x={6} y={10}>
                          {chipText}
                        </text>
                      </g>
                    </g>
                  </g>
                )
              })}
            </g>
          </g>
        </svg>

        {/* 画布无节点的引导（有图谱但无节点）。
            切换图谱时由 CSS `.gv-container.gv-transitioning .gv-empty-hint` 淡出，
            避免提示卡片闪烁。基于 displayGraph 判断，跟随视图状态。 */}
        {displayGraph && nodes.length === 0 && (
          <div className="gv-empty-hint">
            <div className="gv-empty-hint__title">该图谱还没有节点</div>
            <div className="gv-empty-hint__desc">
              通过 API 创建节点后，这里会以小卡片形式展示。后续 Task 7/8 接入悬停详情卡与
              双击延伸生成。
            </div>
          </div>
        )}

        {/* 加载过渡浮层：
            - 首次加载（loading 且无 displayGraph）：中央指示器
            - 切换图谱（transitioning 且有 displayGraph）：顶部进度条 + 旧视图高斯模糊 */}
        {loading && !displayGraph && (
          <div className="gv-loading-overlay" role="status" aria-live="polite">
            <div className="gv-loading-overlay__pill">
              <span className="gv-loading-overlay__spinner" />
              正在加载图谱数据…
            </div>
          </div>
        )}
        {transitioning && displayGraph && (
          <div className="gv-loading-bar" role="status" aria-live="polite">
            <span className="gv-loading-bar__fill" />
          </div>
        )}

        {/* 缩放指示 */}
        <div className="gv-zoom-hint">{Math.round(transform.k * 100)}%</div>

        {/* Task 8：延伸进行中加载提示 */}
        {extending && (
          <div className="gv-extending-overlay" role="status" aria-live="polite">
            <div className="gv-extending-overlay__pill">
              <span className="gv-extending-overlay__spinner" />
              正在生成延伸节点…
            </div>
          </div>
        )}

        {/* Task 7：节点悬停详情卡（悬停优先，回退到选中固定节点） */}
        {displayedNode && (
          <NodeDetailCard
            node={displayedNode}
            graphType={mode}
            pinned={pinned}
            position={detailPosition}
            onCardMouseEnter={handleCardMouseEnter}
            onCardMouseLeave={handleCardMouseLeave}
            onClose={handleCloseDetail}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}

        {/* Task 9：节点编辑器 */}
        <NodeEditor
          open={showEditor}
          node={editorNode}
          graphType={mode}
          onClose={() => setShowEditor(false)}
        />

        {/* Task 9：删除确认弹窗 */}
        <ConfirmDialog
          open={showDeleteConfirm}
          title="删除节点"
          message={`确定删除节点「${deleteTarget?.title ?? ''}」吗？相关连接也会一并移除，此操作不可撤销。`}
          confirmText="删除"
          danger
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      </div>
    )
  },
)

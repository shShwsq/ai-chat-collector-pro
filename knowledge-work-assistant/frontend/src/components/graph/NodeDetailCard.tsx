/**
 * 节点悬停详情卡（Task 7 / Task 8）。
 *
 * 五区域布局（参考设计方案.md 第二部分）：
 *   ① 节点标题 + 类型标签（含「切换类型」下拉，记忆到后端）
 *   ② 知识点概括（优先 generated summary，回退 node.summary / 首字段）
 *   ③ 重要点 / 关键材料（generated important_points 列表 + 其余模板字段）
 *   ④ 延伸方向推荐（generated extension_directions，可点击，Task 8 触发单点延伸）
 *   ⑤ 我的补充留白区（输入框 + 类型选择 + 保存 / 保存并延伸）
 *
 * 详情来源策略：
 * - 若节点 ``detail_payload`` 已含 ``_important_points`` 键（已生成过），直接从
 *   缓存构建详情，不调用后端。
 * - 否则调用 ``store.generateNodeDetail`` → 后端 ``POST .../detail`` 生成并回写
 *   ``detail_payload``，返回详情。降级（degraded）时显示「AI 内容暂不可用」提示。
 *
 * 定位：由父组件（GraphView）计算 ``position``（left/top/width/maxHeight），
 * 卡片绝对定位、不超出视口；卡片自身可滚动。
 *
 * 交互：
 * - 鼠标移入卡片时通知父组件保持显示（避免悬停延时隐藏）
 * - 「编辑」「删除」按钮触发父组件打开 NodeEditor / 确认弹窗
 * - 「关闭」按钮（仅固定态显示）清除选中与显示
 *
 * Task 8 已接入：
 * - 单击「延伸方向推荐」项 → ``store.extendNode(node.id, 'single', direction.name)``
 *   仅生成该方向一个延伸节点，不进 batch（不可撤销）。
 * - 「我的补充」区「保存并延伸」按钮：先保存留白内容，再以该内容作为
 *   ``direction_name`` 触发单点延伸，便于用户基于自己的思考扩展图谱。
 * - ``extending`` 进行中时禁用延伸类按钮，避免并发触发。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../../store/useAppStore'
import { parseDate } from '../../lib/date'
import { renderMarkdown } from '../../lib/markdown'
import type {
  ExtensionDirection,
  Mode,
  Node,
  NodeDetail,
} from '../../lib/types'
import {
  DETAIL_KEY_DEGRADED,
  DETAIL_KEY_EXTENSIONS,
  DETAIL_KEY_IMPORTANT,
  DETAIL_KEY_REASON,
  DETAIL_KEY_SUMMARY,
  DETAIL_KEY_TEMPLATE,
  USER_FILL_LABELS,
  USER_FILL_TYPES,
  getTypeOptions,
  getTemplate,
  stripMetaKeys,
} from '../../lib/nodeTemplates'

export interface NodeDetailCardProps {
  /** 待展示节点（用于取 id 等基础信息，实际数据从 store 读取最新）。 */
  node: Node
  /** 当前图谱模式。 */
  graphType: Mode
  /** 是否为固定态（单击选中触发）。固定态显示关闭按钮、不随鼠标离开消失。 */
  pinned: boolean
  /** 卡片定位与尺寸（相对容器，px）。 */
  position: { left: number; top: number; width: number; maxHeight: number }
  /** 鼠标移入卡片（父组件据此保持显示）。 */
  onCardMouseEnter: () => void
  /** 鼠标移出卡片（父组件据此启动隐藏延时）。 */
  onCardMouseLeave: () => void
  /** 关闭卡片（清除固定与显示）。 */
  onClose: () => void
  /** 点击「编辑」按钮。 */
  onEdit: (node: Node) => void
  /** 点击「删除」按钮。 */
  onDelete: (node: Node) => void
  /**
   * 点击延伸类操作（延伸方向推荐 / 保存并延伸）时额外触发。
   * 用于对话首页大卡浮层无缝切换到图谱视图；图谱视图内调用时为 undefined，无副作用。
   */
  onRequestGraphSwitch?: (nodeId: string) => void
}

/** 从节点 detail_payload 缓存构建 NodeDetail。 */
function extractDetailFromCache(n: Node): NodeDetail {
  const dp = n.detail_payload || {}
  return {
    summary: (dp[DETAIL_KEY_SUMMARY] as string) || '',
    important_points: (dp[DETAIL_KEY_IMPORTANT] as string[]) || [],
    extension_directions:
      (dp[DETAIL_KEY_EXTENSIONS] as ExtensionDirection[]) || [],
    detail_fields: stripMetaKeys(dp),
    template_used: (dp[DETAIL_KEY_TEMPLATE] as string) || '',
    inferred_type: n.type,
    degraded: Boolean(dp[DETAIL_KEY_DEGRADED]),
    degrade_reason: (dp[DETAIL_KEY_REASON] as string) || '',
    cached: true,
  }
}

/** 判断节点是否已有生成缓存。
 *
 * 后端/手动创建的节点可能已在 detail_payload 中写入模板字段（如 what_is、
 * why_important），但没有 _important_points 等元数据键。若只看 _important_points，
 * 这些节点会被误判为"未生成"，导致对话界面有详情而图谱详情卡显示"生成详情"。
 * 因此同时检查：元数据键 或 任意非下划线非空模板字段。
 */
function hasCachedDetail(n: Node): boolean {
  const dp = n.detail_payload
  if (!dp || typeof dp !== 'object' || Object.keys(dp).length === 0) return false
  if (dp[DETAIL_KEY_IMPORTANT]) return true
  return Object.entries(dp).some(
    ([k, v]) =>
      !k.startsWith('_') && k !== 'extensions' && v != null &&
      (typeof v === 'string' ? v.trim().length > 0 : true)
  )
}

/** 解析 extensions 字段（字符串 / 数组）为延伸方向列表（兜底）。 */
function parseExtensionsField(val: unknown): ExtensionDirection[] {
  if (Array.isArray(val)) {
    return val
      .map((v) => {
        if (typeof v === 'string') return { name: v.trim(), reason: '' }
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>
          return {
            name: String(o.name || '').trim(),
            reason: String(o.reason || '').trim(),
          }
        }
        return { name: String(v ?? '').trim(), reason: '' }
      })
      .filter((d) => d.name)
  }
  if (typeof val === 'string' && val.trim()) {
    return val
      .split(/[\n、；;,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ name: s, reason: '' }))
  }
  return []
}

/** 将 detail_fields 中的某个字段值规整为字符串展示。 */
function fieldToString(val: unknown): string {
  if (val == null) return ''
  if (typeof val === 'string') return val
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('；')
  }
  return String(val)
}

/**
 * 将 ISO 时间字符串格式化为提醒徽标文本「提醒于 MM/DD HH:mm」。
 * 解析失败时回退为「已设提醒」，避免空徽标。
 */
function formatRemind(isoString: string): string {
  const d = parseDate(isoString)
  if (!d) return '已设提醒'
  const pad = (n: number) => String(n).padStart(2, '0')
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  return `提醒于 ${mm}/${dd} ${hh}:${mi}`
}

/**
 * 将 ISO 时间字符串转为 ``<input type="datetime-local">`` 所需的本地时间值
 * （格式 ``YYYY-MM-DDTHH:mm``），用于编辑提醒时预填当前值。
 */
function toDatetimeLocalValue(isoString: string): string {
  const d = parseDate(isoString)
  if (!d) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function NodeDetailCard({
  node,
  graphType,
  pinned,
  position,
  onCardMouseEnter,
  onCardMouseLeave,
  onClose,
  onEdit,
  onDelete,
  onRequestGraphSwitch,
}: NodeDetailCardProps) {
  // 优先从 store 读取最新节点（生成 / 编辑 / 留白后会更新）。
  // 若外部传入的 node prop 自带 detail_payload 缓存（如推荐列表中的节点），
  // 而 fullGraph 中尚未同步，则合并 prop 中的缓存，避免切换视图后详情丢失。
  const storeNode = useAppStore((s) => s.fullGraph?.nodes.find((n) => n.id === node.id))
  const latestNode: Node = storeNode
    ? {
        ...storeNode,
        detail_payload:
          storeNode.detail_payload && Object.keys(storeNode.detail_payload).length > 0
            ? storeNode.detail_payload
            : node.detail_payload,
      }
    : node
  const generateNodeDetail = useAppStore((s) => s.generateNodeDetail)
  const generateNodeDetailStream = useAppStore((s) => s.generateNodeDetailStream)
  const clearNodeDetailStreaming = useAppStore((s) => s.clearNodeDetailStreaming)
  // 流式状态：仅当当前节点正处于流式生成时展示流式预览
  const nodeDetailStreamingActive = useAppStore((s) => s.nodeDetailStreamingActive)
  const nodeDetailStreamingText = useAppStore((s) => s.nodeDetailStreamingText)
  const nodeDetailStreamingNodeId = useAppStore((s) => s.nodeDetailStreamingNodeId)
  const updateNode = useAppStore((s) => s.updateNode)
  const appendUserFill = useAppStore((s) => s.appendUserFill)
  // Task 8：单点延伸与留白延伸
  const extendNodeAction = useAppStore((s) => s.extendNode)
  const extending = useAppStore((s) => s.extending)
  // touch / remind / star：固定态触发 touch、Work 节点提醒设置、节点星标切换
  const touchNode = useAppStore((s) => s.touchNode)
  const setRemind = useAppStore((s) => s.setRemind)
  const clearRemind = useAppStore((s) => s.clearRemind)
  const toggleStar = useAppStore((s) => s.toggleStar)

  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [typeChanging, setTypeChanging] = useState(false)

  // 留白输入区
  const [fillType, setFillType] = useState<string>('doubt')
  const [fillContent, setFillContent] = useState('')
  const [fillSaving, setFillSaving] = useState(false)
  // 留白延伸按钮状态：保存留白后紧接着调单点延伸
  const [fillExtending, setFillExtending] = useState(false)

  // Work 节点提醒设置：内联编辑器开关 / 受控值 / 保存中 / 清除中
  const [remindEditing, setRemindEditing] = useState(false)
  const [remindValue, setRemindValue] = useState('')
  const [remindSaving, setRemindSaving] = useState(false)
  const [remindClearing, setRemindClearing] = useState(false)
  // 星标切换进行中标记
  const [starToggling, setStarToggling] = useState(false)

  const cached = hasCachedDetail(latestNode)

  // 当前节点是否处于流式生成中（仅匹配 node_id 时才生效）
  const isStreamingThisNode =
    nodeDetailStreamingNodeId === latestNode.id &&
    (nodeDetailStreamingActive || nodeDetailStreamingText.length > 0)

  // 详情获取：有缓存直接用缓存，无缓存不自动调 LLM（需用户点击"生成详情"按钮）
  // 这样避免悬停/单击多个节点时触发大量 LLM 请求
  useEffect(() => {
    if (cached) {
      setDetail(extractDetailFromCache(latestNode))
      setError('')
      return
    }
    // 无缓存：清空详情，显示"生成详情"按钮供用户主动触发
    setDetail(null)
    setError('')
    // 仅在节点 id 变化或缓存状态变化时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestNode.id, cached])

  // 节点切换或组件卸载时清空流式状态，避免跨节点残留流式文本
  useEffect(() => {
    return () => {
      // 仅当离开的节点正是当前流式节点时才清空，避免误清空其他节点的流式
      if (nodeDetailStreamingNodeId === latestNode.id) {
        clearNodeDetailStreaming()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestNode.id])

  // 固定态触发 touch：仅在 pinned=true（单击选中固定显示）时调用 touchNode，
  // 同一节点同一固定态只 touch 一次（用 ref 去重），避免悬停态频繁调用与重复 touch。
  // 取消固定时重置 ref，使下次重新固定该节点会再次 touch。
  const touchedRef = useRef<string | null>(null)
  useEffect(() => {
    if (pinned && latestNode.id !== touchedRef.current) {
      touchedRef.current = latestNode.id
      void touchNode(latestNode.id)
    }
    if (!pinned) {
      touchedRef.current = null
    }
  }, [pinned, latestNode.id, touchNode])

  /**
   * 用户显式点击"生成详情"按钮时触发流式生成。
   *
   * 流式输出（WebSocket 推送）：
   * - 调用 ``store.generateNodeDetailStream(nodeId)`` 触发后端 detail-stream；
   * - 后端逐 token 推送 ``graph_agent_token`` 事件，store 实时累积到
   *   ``nodeDetailStreamingText``，本组件订阅展示打字机效果；
   * - 完成后 ``nodeDetailStreamingActive=false`` 但 ``nodeDetailStreamingText``
   *   保留最终 Markdown 供展示。
   * - 无 sessionId 时 store 内部自动回退到非流式 generateNodeDetail。
   */
  const handleGenerateDetail = async () => {
    if (loading || isStreamingThisNode) return
    setLoading(true)
    setError('')
    // 流式触发：store 内部会判断 sessionId，缺失时回退到非流式
    const ok = await generateNodeDetailStream(latestNode.id)
    if (!ok) {
      // 流式触发失败（如 session_id 缺失且回退也失败）：尝试纯非流式兜底
      const resp = await generateNodeDetail(latestNode.id)
      if (resp) {
        setDetail(resp.detail)
      } else {
        setError('详情生成失败，请检查后端与 LLM 配置')
      }
    }
    // 流式成功：等待 WS 事件推送 token，loading 在流式结束（active=false）后清除
    // 非流式回退成功：直接清除 loading
    if (!useAppStore.getState().nodeDetailStreamingActive) {
      setLoading(false)
    }
  }

  // 流式结束后清除 loading（监听 nodeDetailStreamingActive 由 true→false）
  useEffect(() => {
    if (!nodeDetailStreamingActive && loading && isStreamingThisNode) {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeDetailStreamingActive, isStreamingThisNode])

  const template = useMemo(
    () => getTemplate(graphType, latestNode.type),
    [graphType, latestNode.type],
  )
  const typeOptions = useMemo(() => getTypeOptions(graphType), [graphType])

  // 概括文本：generated summary → node.summary → 首个模板字段值
  const summaryText = useMemo(() => {
    const firstFieldKey = template[0]?.key
    const firstVal = firstFieldKey
      ? fieldToString(latestNode.detail_payload?.[firstFieldKey])
      : ''
    return (
      detail?.summary ||
      latestNode.summary ||
      firstVal ||
      ''
    )
  }, [detail, latestNode, template])

  // 重要点：优先 generated，回退 key_points 字段拆分
  const importantPoints = useMemo(() => {
    const gen = detail?.important_points ?? []
    if (gen.length > 0) return gen
    const kp = fieldToString(latestNode.detail_payload?.key_points)
    if (kp) {
      return kp
        .split(/[\n、；;,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
    return []
  }, [detail, latestNode])

  // 延伸方向：优先 generated，回退 extensions 字段解析
  const extensionDirections = useMemo(() => {
    const gen = detail?.extension_directions ?? []
    if (gen.length > 0) return gen
    return parseExtensionsField(latestNode.detail_payload?.extensions)
  }, [detail, latestNode])

  // 关键材料：模板中除首字段（概括）与 extensions 外的字段
  const keyMaterials = useMemo(() => {
    const out: { label: string; value: string }[] = []
    for (let i = 1; i < template.length; i++) {
      const f = template[i]
      if (f.key === 'extensions') continue
      const val = fieldToString(latestNode.detail_payload?.[f.key])
      if (val) out.push({ label: f.label, value: val })
    }
    return out
  }, [template, latestNode])

  // Markdown → HTML 预渲染：LLM 输出可能包含 ## 标题、- 列表、```代码块``` 等
  // Markdown 语法，直接当纯文本显示会导致代码块换行丢失、标题不显眼。
  // 这里用共享 renderMarkdown 把 summary / importantPoints / keyMaterials 转成 HTML，
  // 配合 CSS（.ndc-md .md-code-block 等）让代码块独立分隔、字体用 Comic Sans MS。
  const summaryHtml = useMemo(() => renderMarkdown(summaryText), [summaryText])
  const importantPointsHtml = useMemo(
    () => importantPoints.map((p) => renderMarkdown(p)),
    [importantPoints],
  )
  const keyMaterialsHtml = useMemo(
    () => keyMaterials.map((m) => ({ label: m.label, html: renderMarkdown(m.value) })),
    [keyMaterials],
  )

  // 已有留白条目（按类型分组）
  const fillEntries = useMemo(() => {
    const uf = (latestNode.user_fill || {}) as Record<string, unknown>
    const out: { type: string; content: string }[] = []
    for (const t of USER_FILL_TYPES) {
      const list = uf[t]
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string' && item.trim()) {
            out.push({ type: t, content: item })
          }
        }
      }
    }
    return out
  }, [latestNode])

  const degraded = detail?.degraded ?? false

  const handleTypeChange = async (newType: string) => {
    if (newType === latestNode.type || typeChanging) return
    setTypeChanging(true)
    await updateNode(latestNode.id, { type: newType })
    setTypeChanging(false)
  }

  const handleSaveFill = async () => {
    const content = fillContent.trim()
    if (!content || fillSaving) return
    setFillSaving(true)
    const ok = await appendUserFill(latestNode.id, fillType, content)
    setFillSaving(false)
    if (ok) {
      setFillContent('')
    }
  }

  /**
   * Task 8「保存并延伸」：先以 ``fillType`` 保存留白内容，
   * 再以该内容作为 ``direction_name`` 触发单点延伸。
   *
   * 设计意图：让用户基于自己的思考 / 联想 / 疑问快速扩展图谱，
   * 同时把原始想法沉淀到节点的 user_fill 区，避免内容丢失。
   * 单点延伸不进 batch（不可撤销），与单击方向推荐同路径。
   */
  const handleSaveAndExtend = async () => {
    const content = fillContent.trim()
    if (!content || fillSaving || fillExtending || extending) return
    setFillExtending(true)
    setFillSaving(true)
    const ok = await appendUserFill(latestNode.id, fillType, content)
    setFillSaving(false)
    if (!ok) {
      setFillExtending(false)
      return
    }
    // 通知浮层无缝切换到图谱视图（在 await 延伸前触发，让视图先切过去）
    onRequestGraphSwitch?.(latestNode.id)
    // 以用户输入作为延伸方向名调用 Agent 生成新节点
    await extendNodeAction(latestNode.id, 'single', content)
    setFillExtending(false)
    setFillContent('')
  }

  /**
   * Task 8 单点延伸：单击详情卡中的「延伸方向推荐」项。
   * 调用 ``store.extendNode(node.id, 'single', direction.name)``。
   * 延伸进行中禁用，避免并发。
   */
  const handleExtensionClick = async (direction: ExtensionDirection) => {
    if (extending) return
    // 通知浮层无缝切换到图谱视图（在 await 延伸前触发）
    onRequestGraphSwitch?.(latestNode.id)
    await extendNodeAction(latestNode.id, 'single', direction.name)
  }

  /**
   * 打开提醒编辑：已有提醒则预填其时间，否则预填 1 小时后便于快速设置。
   */
  const handleStartRemindEdit = () => {
    if (remindSaving) return
    if (latestNode.remind_at) {
      setRemindValue(toDatetimeLocalValue(latestNode.remind_at))
    } else {
      const d = new Date(Date.now() + 3600 * 1000)
      setRemindValue(toDatetimeLocalValue(d.toISOString()))
    }
    setRemindEditing(true)
  }

  /** 确认提醒：将 datetime-local 本地值转为 ISO 字符串后调用 setRemind。 */
  const handleConfirmRemind = async () => {
    if (!remindValue || remindSaving) return
    setRemindSaving(true)
    const iso = new Date(remindValue).toISOString()
    await setRemind(latestNode.id, iso)
    setRemindSaving(false)
    setRemindEditing(false)
    setRemindValue('')
  }

  /** 取消提醒编辑，恢复初始态。 */
  const handleCancelRemind = () => {
    setRemindEditing(false)
    setRemindValue('')
  }

  /** 清除已有提醒。 */
  const handleClearRemind = async () => {
    if (remindClearing) return
    setRemindClearing(true)
    await clearRemind(latestNode.id)
    setRemindClearing(false)
  }

  /** 切换节点星标。 */
  const handleToggleStar = async () => {
    if (starToggling) return
    setStarToggling(true)
    await toggleStar(latestNode.id)
    setStarToggling(false)
  }

  const cardStyle: React.CSSProperties = {
    left: position.left,
    top: position.top,
  }
  if (position.width > 0) cardStyle.width = position.width
  if (position.maxHeight > 0 && position.maxHeight < 9999) {
    cardStyle.maxHeight = position.maxHeight
  }

  return (
    <div
      className={`node-detail-card${pinned ? ' is-pinned' : ''}`}
      style={cardStyle}
      role="dialog"
      aria-label={`节点详情：${latestNode.title}`}
      onMouseEnter={onCardMouseEnter}
      onMouseLeave={onCardMouseLeave}
      onClick={(ev) => ev.stopPropagation()}
    >
      {/* ① 标题 + 类型 + 操作 */}
      <div className="ndc-header">
        <div className="ndc-header__title-row">
          <span className="ndc-header__title" title={latestNode.title}>
            {latestNode.title || '（无标题）'}
          </span>
          <div className="ndc-header__actions">
            {/* 星标切换（study / work 均可用） */}
            <button
              type="button"
              className={`ndc-icon-btn ndc-star-btn${latestNode.is_starred ? ' ndc-star-btn--active' : ''}`}
              onClick={() => void handleToggleStar()}
              disabled={starToggling}
              title={latestNode.is_starred ? '取消星标' : '加入星标'}
              aria-label={latestNode.is_starred ? '取消星标' : '加入星标'}
              aria-pressed={!!latestNode.is_starred}
            >
              {latestNode.is_starred ? (
                <svg
                  className="ndc-star-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z" />
                </svg>
              ) : (
                <svg
                  className="ndc-star-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z" />
                </svg>
              )}
            </button>
            {/* 提醒设置（仅 Work 节点） */}
            {graphType === 'work' && (
              <button
                type="button"
                className="ndc-icon-btn ndc-remind-btn"
                onClick={handleStartRemindEdit}
                disabled={remindSaving || remindClearing}
                title={latestNode.remind_at ? '修改提醒时间' : '设置提醒时间'}
                aria-label={latestNode.remind_at ? '修改提醒时间' : '设置提醒时间'}
              >
                {latestNode.remind_at ? '修改提醒' : '提醒我'}
              </button>
            )}
            <button
              type="button"
              className="ndc-icon-btn"
              onClick={() => onEdit(latestNode)}
              title="编辑节点"
              aria-label="编辑节点"
            >
              编辑
            </button>
            <button
              type="button"
              className="ndc-icon-btn ndc-icon-btn--danger"
              onClick={() => onDelete(latestNode)}
              title="删除节点"
              aria-label="删除节点"
            >
              删除
            </button>
            {pinned && (
              <button
                type="button"
                className="ndc-icon-btn ndc-icon-btn--close"
                onClick={onClose}
                title="关闭"
                aria-label="关闭详情卡"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="ndc-header__type-row">
          <span className="ndc-type-chip">
            {typeOptions.find((o) => o.value === latestNode.type)?.label ||
              latestNode.type ||
              '未分类'}
          </span>
          <select
            className="ndc-type-select"
            value={latestNode.type}
            onChange={(e) => void handleTypeChange(e.target.value)}
            disabled={typeChanging}
            title="切换节点类型"
            aria-label="切换节点类型"
          >
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {typeChanging && <span className="ndc-mini-hint">切换中…</span>}
        </div>
        {/* Work 节点提醒：已设提醒时显示徽标 + 清除按钮；编辑时显示内联 datetime-local */}
        {graphType === 'work' &&
          (latestNode.remind_at || remindEditing) && (
            <div className="ndc-remind-row">
              {!remindEditing && latestNode.remind_at && (
                <>
                  <span className="ndc-remind-badge">
                    {formatRemind(latestNode.remind_at)}
                  </span>
                  <button
                    type="button"
                    className="ndc-remind-clear"
                    onClick={() => void handleClearRemind()}
                    disabled={remindClearing}
                    title="清除提醒"
                  >
                    {remindClearing ? '清除中…' : '清除提醒'}
                  </button>
                </>
              )}
              {remindEditing && (
                <div className="ndc-remind-editor">
                  <input
                    type="datetime-local"
                    className="ndc-remind-input"
                    value={remindValue}
                    onChange={(e) => setRemindValue(e.target.value)}
                    disabled={remindSaving}
                    aria-label="提醒时间"
                  />
                  <button
                    type="button"
                    className="ndc-remind-confirm"
                    onClick={() => void handleConfirmRemind()}
                    disabled={remindSaving || !remindValue}
                  >
                    {remindSaving ? '保存中…' : '确认'}
                  </button>
                  <button
                    type="button"
                    className="ndc-remind-cancel"
                    onClick={handleCancelRemind}
                    disabled={remindSaving}
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          )}
      </div>

      <div className="ndc-body">
        {loading && !isStreamingThisNode && (
          <div className="ndc-loading">正在生成详情…</div>
        )}

        {!loading && error && (
          <div className="ndc-error">{error}</div>
        )}

        {/* 流式生成预览块：流式进行中或流式完成但未写入缓存时展示。
            流式过程中逐 token 累积 nodeDetailStreamingText，末尾闪烁光标；
            流式完成后保留最终 Markdown 文本展示，用户可继续操作或切换节点。 */}
        {isStreamingThisNode && !error && (
          <div className="ndc-stream-preview">
            <div className="ndc-stream-preview__head">
              <span className="ndc-stream-preview__title">
                AI 详情流式生成
              </span>
              {nodeDetailStreamingActive && (
                <span className="ndc-stream-preview__badge" aria-live="polite">
                  生成中…
                </span>
              )}
            </div>
            <pre className="ndc-stream-preview__text">
              {nodeDetailStreamingText || '（等待首个 token…）'}
              {nodeDetailStreamingActive && (
                <span className="ndc-stream-cursor" aria-hidden="true">▋</span>
              )}
            </pre>
            {nodeDetailStreamingActive && (
              <p className="ndc-mini-hint">
                内容逐 token 推送，完成后可继续编辑或延伸。
              </p>
            )}
          </div>
        )}

        {/* 无缓存且未在流式生成：显示"生成详情"按钮，由用户主动触发流式 LLM 调用 */}
        {!loading && !error && !cached && !detail && !isStreamingThisNode && (
          <div className="ndc-gen-prompt">
            <p className="ndc-gen-prompt__text">
              该节点尚未生成 AI 详情。点击下方按钮流式生成知识点概括、重要点与延伸方向推荐。
            </p>
            <button
              type="button"
              className="ndc-gen-btn"
              onClick={() => void handleGenerateDetail()}
              disabled={loading || isStreamingThisNode}
            >
              生成详情（流式）
            </button>
          </div>
        )}

        {!loading && !error && degraded && (
          <div className="ndc-degraded">
            AI 内容暂不可用，请配置 LLM 凭据。可点击「编辑」手动补充。
          </div>
        )}

        {!loading && !error && detail && (
          <>
            {/* ② 知识点概括 */}
            <section className="ndc-section">
              <h4 className="ndc-section__title">概括</h4>
              {summaryText ? (
                <div
                  className="ndc-section__text ndc-md"
                  dangerouslySetInnerHTML={{ __html: summaryHtml }}
                />
              ) : (
                <p className="ndc-empty-text">暂无概括</p>
              )}
            </section>

            {/* ③ 重要点 / 关键材料 */}
            <section className="ndc-section">
              <h4 className="ndc-section__title">重要点 / 关键材料</h4>
              {importantPoints.length > 0 ? (
                <ul className="ndc-list">
                  {importantPointsHtml.map((html, i) => (
                    <li
                      key={i}
                      className="ndc-list__item ndc-md"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="ndc-empty-text">暂无重要点</p>
              )}
              {keyMaterialsHtml.length > 0 && (
                <dl className="ndc-kv">
                  {keyMaterialsHtml.map((m) => (
                    <div className="ndc-kv__row" key={m.label}>
                      <dt className="ndc-kv__label">{m.label}</dt>
                      <dd
                        className="ndc-kv__value ndc-md"
                        dangerouslySetInnerHTML={{ __html: m.html }}
                      />
                    </div>
                  ))}
                </dl>
              )}
            </section>

            {/* ④ 延伸方向推荐 */}
            <section className="ndc-section">
              <h4 className="ndc-section__title">
                延伸方向推荐
                <span className="ndc-section__hint">单击延伸</span>
              </h4>
              {extensionDirections.length > 0 ? (
                <ul className="ndc-ext-list">
                  {extensionDirections.map((d, i) => {
                    const disabled = extending
                    return (
                      <li key={i} className="ndc-ext-item">
                        <button
                          type="button"
                          className="ndc-ext-item__btn"
                          onClick={() => void handleExtensionClick(d)}
                          disabled={disabled}
                          title={d.reason || '单击延伸此方向'}
                        >
                          <span className="ndc-ext-item__name">{d.name}</span>
                          {d.reason && (
                            <span className="ndc-ext-item__reason">
                              {d.reason}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="ndc-empty-text">暂无延伸方向</p>
              )}
              {extending && (
                <p className="ndc-mini-hint">正在生成延伸节点…</p>
              )}
            </section>

            {/* ⑤ 我的补充留白区 */}
            <section className="ndc-section">
              <h4 className="ndc-section__title">我的补充</h4>
              <div className="ndc-fill">
                <div className="ndc-fill__row">
                  <select
                    className="ndc-fill__select"
                    value={fillType}
                    onChange={(e) => setFillType(e.target.value)}
                    aria-label="留白类型"
                    disabled={fillSaving || fillExtending}
                  >
                    {USER_FILL_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {USER_FILL_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ndc-fill__save"
                    onClick={() => void handleSaveFill()}
                    disabled={fillSaving || fillExtending || !fillContent.trim()}
                  >
                    {fillSaving && !fillExtending ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    className="ndc-fill__extend"
                    onClick={() => void handleSaveAndExtend()}
                    disabled={
                      fillExtending ||
                      fillSaving ||
                      extending ||
                      !fillContent.trim()
                    }
                    title="保存留白并基于此内容生成一个延伸节点"
                  >
                    {fillExtending ? '延伸中…' : '保存并延伸'}
                  </button>
                </div>
                <textarea
                  className="ndc-fill__input"
                  value={fillContent}
                  onChange={(e) => setFillContent(e.target.value)}
                  placeholder="记录疑问 / 联想 / 考点 / 易错点 / 笔记，可「保存并延伸」生成节点"
                  rows={2}
                  disabled={fillSaving || fillExtending}
                />
              </div>
              {fillEntries.length > 0 && (
                <ul className="ndc-fill-list">
                  {fillEntries.map((e, i) => (
                    <li key={i} className="ndc-fill-list__item">
                      <span className={`ndc-fill-tag ndc-fill-tag--${e.type}`}>
                        {USER_FILL_LABELS[e.type] || e.type}
                      </span>
                      <span className="ndc-fill-list__content">{e.content}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

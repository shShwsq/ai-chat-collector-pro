/**
 * 图谱视图纯函数工具（Task 5）。
 *
 * 包含：
 * - ``truncateText``：按字符宽度估算对文本做单行截断，附加省略号
 * - ``wrapText``：将文本按宽度估算拆分为最多 N 行，最后一行超长截断
 * - ``edgePath``：计算两节点中心之间的二次贝塞尔曲线路径（带轻微弧度）
 * - ``screenToSvg``：屏幕坐标转 SVG 内部坐标（考虑 translate + scale 变换）
 *
 * 这些函数不依赖 React，便于在 tick 高频回调中直接复用。
 */

import type { FullGraph } from '../../lib/types'

/** 节点小卡片尺寸（与 GraphView / CardView 保持一致）。 */
export const NODE_WIDTH = 180
export const NODE_HEIGHT = 72

/** 卡片内边距。 */
export const CARD_PAD_X = 12
export const CARD_PAD_TOP = 10

/** 估算单字符宽度：CJK 全角 ≈ fontSize，其余 ≈ 0.55 * fontSize。 */
function charWidth(ch: string, fontSize: number): number {
  // 中日韩统一表意文字 + 全角标点 + 全角符号
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d]/.test(ch)) {
    return fontSize
  }
  return fontSize * 0.55
}

/** 估算字符串在指定字号下的渲染宽度（px）。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of Array.from(text)) w += charWidth(ch, fontSize)
  return w
}

/**
 * 单行截断：超出 maxWidth 时按字符宽度截断并附加「…」。
 */
export function truncateText(text: string, maxWidth: number, fontSize: number): string {
  if (!text) return ''
  const chars = Array.from(text)
  const ellipsisW = fontSize * 0.8
  let width = 0
  let i = 0
  for (; i < chars.length; i++) {
    const w = charWidth(chars[i], fontSize)
    if (width + w > maxWidth - ellipsisW) break
    width += w
  }
  if (i >= chars.length) return text
  return chars.slice(0, i).join('') + '…'
}

/**
 * 多行拆分：按 maxWidth 将文本拆分为最多 maxLines 行；
 * 最后一行若仍超长则单行截断。返回行数组。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
): string[] {
  if (!text) return []
  const chars = Array.from(text)
  const lines: string[] = []
  let current = ''
  let width = 0
  for (const ch of chars) {
    const w = charWidth(ch, fontSize)
    if (width + w > maxWidth && current) {
      lines.push(current)
      current = ch
      width = w
      if (lines.length >= maxLines - 1) break
    } else {
      current += ch
      width += w
    }
  }
  if (current) lines.push(current)

  // 若原文未消费完（被 maxLines 截断），最后一行做单行截断
  const consumed = lines.join('')
  if (consumed.length < text.length && lines.length > 0) {
    lines[lines.length - 1] = truncateText(
      lines[lines.length - 1],
      maxWidth,
      fontSize,
    )
  }
  return lines
}

/**
 * 计算两节点中心之间的二次贝塞尔曲线路径。
 * 在中点处沿法线方向加一个轻微偏移，避免双向边完全重叠。
 */
export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curvature = 0.12,
): string {
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy)
  if (dist < 1) return `M${x1},${y1}L${x2},${y2}`
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  // 法线方向（垂直于连线）
  const nx = -dy / dist
  const ny = dx / dist
  const offset = Math.min(dist * curvature, 36)
  return `M${x1},${y1}Q${mx + nx * offset},${my + ny * offset} ${x2},${y2}`
}

/**
 * 屏幕坐标转 SVG 内部坐标（仅适用于 translate + scale 复合变换）。
 * svgPoint = (screen - translate) / scale
 */
export function screenToSvg(
  clientX: number,
  clientY: number,
  svg: SVGSVGElement,
  translate: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const rect = svg.getBoundingClientRect()
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  return {
    x: (sx - translate.x) / scale,
    y: (sy - translate.y) / scale,
  }
}

/** 限制缩放系数范围。 */
export function clampScale(k: number, min = 0.2, max = 3): number {
  return Math.min(max, Math.max(min, k))
}

/**
 * 判断两图谱结构是否相同（节点 id 集合与边端点集合一致）。
 * 结构相同时仅字段（detail_payload/title/summary 等）变化，
 * GraphView 不应重建 d3-force simulation，避免整图受力重排抽动。
 */
export function isSameGraphStructure(a: FullGraph, b: FullGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  const aNodeIds = new Set(a.nodes.map((n) => n.id))
  const bNodeIds = new Set(b.nodes.map((n) => n.id))
  if (aNodeIds.size !== bNodeIds.size) return false
  for (const id of aNodeIds) if (!bNodeIds.has(id)) return false
  const aEdgeKeys = new Set(a.edges.map((e) => `${e.src_id}->${e.dst_id}`))
  const bEdgeKeys = new Set(b.edges.map((e) => `${e.src_id}->${e.dst_id}`))
  if (aEdgeKeys.size !== bEdgeKeys.size) return false
  for (const k of aEdgeKeys) if (!bEdgeKeys.has(k)) return false
  return true
}

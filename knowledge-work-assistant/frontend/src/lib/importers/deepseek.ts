/**
 * DeepSeek 对话导出解析器。
 *
 * DeepSeek 一键导出的 ``conversations.json`` 结构：
 * - 顶层为数组，每个元素形如
 *   ``{ id, title, inserted_at, updated_at, mapping }``
 * - ``mapping`` 是树状节点字典：``{ nodeId: { id, parent, children, message } }``
 * - ``message`` 可空（如 root 节点），非空时形如
 *   ``{ model, inserted_at, fragments: [{ type, content }] }``
 * - ``fragments[].type`` 取值：
 *     · REQUEST  —— 用户输入
 *     · RESPONSE —— 助手回答
 *     · THINK    —— 思考链（reasoning）
 *     · FILE / SEARCH / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND —— 工具产物
 *
 * 转换策略：
 * 1. 收集 mapping 中所有非空 message 节点；
 * 2. 按 ``message.inserted_at`` 解析为时间戳排序，保证对话顺序正确
 *    （树可能有 regenerate 分支，时间排序是最稳健的线性化方式）；
 * 3. 依次输出 Markdown 片段：
 *    - REQUEST  → ``## 用户`` 段
 *    - RESPONSE → ``## 助手`` 段
 *    - THINK    → ``<details>`` 折叠块（保留思考链但不干扰正文）
 *    - 其他工具产物 → 跳过（对知识抽取价值低且噪音大）
 * 4. ``messageCount`` = REQUEST + RESPONSE 片段数（用户与助手的实际回合）。
 *
 * 与插件推送格式对齐：产出的 Markdown 即 ``conversation_markdown``，
 * 会话 id 透传为 ``metadata.conversation_id`` 供后端 24h 幂等去重。
 */

import {
  ImportParseError,
  type ImportPreview,
  type ImportedConversation,
  type PlatformImporter,
} from './types'

/** DeepSeek mapping 中单个节点的形状。 */
interface DeepSeekNode {
  id: string
  parent: string | null
  children?: string[]
  message?: DeepSeekMessage | null
}

/** DeepSeek message 的形状。 */
interface DeepSeekMessage {
  model?: string
  inserted_at?: string
  fragments?: DeepSeekFragment[]
}

/** DeepSeek fragment 的形状。 */
interface DeepSeekFragment {
  type?: string
  content?: string
}

/** DeepSeek 顶层会话的形状。 */
interface DeepSeekConversation {
  id?: string
  title?: string
  inserted_at?: string
  updated_at?: string
  mapping?: Record<string, DeepSeekNode>
}

/** 跳过的 fragment 类型（工具产物，不写入 Markdown）。 */
const SKIPPED_FRAGMENT_TYPES = new Set([
  'FILE',
  'SEARCH',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_FIND',
])

/**
 * 把 ISO8601 字符串解析为时间戳数值，用于跨时区安全排序。
 * 解析失败返回 ``Infinity``（排到末尾，保持稳定）。
 */
function toEpochMs(v: string | undefined): number {
  if (!v) return Infinity
  const t = Date.parse(v)
  return Number.isNaN(t) ? Infinity : t
}

/** 截取首条用户消息作为兜底标题（标题为空时使用）。 */
function deriveTitle(firstUserContent: string | undefined): string {
  if (!firstUserContent) return ''
  // 去掉多余空白与换行，截断到 40 字
  const flat = firstUserContent.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
}

/**
 * 把单个 DeepSeek 会话转换为统一中间结构。
 */
function convertConversation(conv: DeepSeekConversation): ImportedConversation | null {
  const mapping = conv.mapping
  if (!mapping || typeof mapping !== 'object') return null

  // 收集所有非空 message 节点
  const nodes: { msg: DeepSeekMessage; ts: number }[] = []
  for (const node of Object.values(mapping)) {
    const msg = node?.message
    if (!msg) continue
    nodes.push({ msg, ts: toEpochMs(msg.inserted_at) })
  }
  if (nodes.length === 0) return null

  // 按时间升序，时间相同的保持稳定（splice 不改顺序）
  nodes.sort((a, b) => a.ts - b.ts)

  const parts: string[] = []
  let messageCount = 0
  let firstUserContent: string | undefined
  let model: string | undefined

  for (const { msg } of nodes) {
    if (!model && msg.model) model = msg.model
    const frags = msg.fragments
    if (!Array.isArray(frags) || frags.length === 0) continue
    for (const frag of frags) {
      const type = frag?.type
      const content = (frag?.content ?? '').trim()
      if (!type || SKIPPED_FRAGMENT_TYPES.has(type)) continue
      if (type === 'REQUEST') {
        if (firstUserContent === undefined) firstUserContent = content
        messageCount += 1
        parts.push(`## 用户\n\n${content}`)
      } else if (type === 'RESPONSE') {
        messageCount += 1
        parts.push(`## 助手\n\n${content}`)
      } else if (type === 'THINK') {
        // 思考链折叠展示，保留信息但不干扰正文阅读
        parts.push(
          `<details><summary>思考过程</summary>\n\n${content}\n\n</details>`,
        )
      }
      // 未知类型静默跳过，向前兼容后续平台新增 fragment 类型
    }
  }

  if (parts.length === 0) return null

  const title = (conv.title ?? '').trim() || deriveTitle(firstUserContent)
  const id = conv.id ?? ''
  // 无 id 时用标题 + 首条时间生成稳定 id，避免去重失效导致重复落库
  const effectiveId =
    id ||
    `ds-${toEpochMs(conv.inserted_at).toString(36)}-${title.slice(0, 16)}`

  return {
    id: effectiveId,
    title,
    occurredAt: conv.inserted_at ?? '',
    updatedAt: conv.updated_at ?? '',
    messageCount,
    markdown: parts.join('\n\n'),
    model,
  }
}

/** DeepSeek 解析器实例。 */
export const deepseekImporter: PlatformImporter = {
  platform: 'deepseek',

  detect: (data: unknown): boolean => {
    if (!Array.isArray(data) || data.length === 0) return false
    const first = data[0] as DeepSeekConversation | undefined
    if (!first || typeof first !== 'object') return false
    // 关键特征：mapping 字段 + inserted_at 时间戳
    return (
      'mapping' in first &&
      typeof first.mapping === 'object' &&
      first.mapping !== null &&
      'inserted_at' in first
    )
  },

  parse: (data: unknown): ImportPreview => {
    if (!Array.isArray(data)) {
      throw new ImportParseError('DeepSeek 文件应为会话数组')
    }
    const conversations: ImportedConversation[] = []
    let minTs = Infinity
    let maxTs = -Infinity
    let minIso = ''
    let maxIso = ''

    for (const raw of data as DeepSeekConversation[]) {
      const conv = convertConversation(raw)
      if (!conv) continue
      conversations.push(conv)
      // 时间范围用 occurredAt(起始) 与 updatedAt(最后活动) 跨会话取极值
      const startTs = toEpochMs(conv.occurredAt)
      const endTs = toEpochMs(conv.updatedAt) !== Infinity ? toEpochMs(conv.updatedAt) : startTs
      if (startTs !== Infinity && startTs < minTs) {
        minTs = startTs
        minIso = conv.occurredAt
      }
      if (endTs !== Infinity && endTs > maxTs) {
        maxTs = endTs
        maxIso = conv.updatedAt || conv.occurredAt
      }
    }

    if (conversations.length === 0) {
      throw new ImportParseError('文件中未解析到任何有效 DeepSeek 会话')
    }

    // 按发生时间升序，便于预览列表阅读
    conversations.sort(
      (a, b) => toEpochMs(a.occurredAt) - toEpochMs(b.occurredAt),
    )

    const totalMessages = conversations.reduce(
      (sum, c) => sum + c.messageCount,
      0,
    )
    const timeRange =
      minIso && maxIso ? { start: minIso, end: maxIso } : null

    return {
      platform: 'deepseek',
      conversations,
      timeRange,
      totalMessages,
    }
  },
}

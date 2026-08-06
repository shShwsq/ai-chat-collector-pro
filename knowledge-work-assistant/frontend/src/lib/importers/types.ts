/**
 * 平台对话导入器类型定义。
 *
 * 用于「手动导入对话」功能：用户上传平台导出的文件，前端自动识别来源平台
 * 与格式，解析为统一的 ``ImportPreview`` 结构供 UI 预览，再由用户勾选要导入
 * 的会话，调用现有插件推送接口（POST /api/plugin/conversations）落库为
 * Observation。
 *
 * 设计要点：
 * 1. **平台自适应**：每个平台一个解析器（``PlatformImporter``），通过
 *    ``detect()`` 判断是否匹配；``detectAndParse`` 依次尝试，命中即解析。
 * 2. **统一中间结构**：各平台解析结果统一为 ``ImportedConversation``，
 *    屏蔽 DeepSeek 的 mapping 树等平台差异。
 * 3. **幂等去重交由后端**：``id`` 透传到 ``metadata.conversation_id``，
 *    后端按 ``{platform}:{id}`` 做 24h 去重，重复导入安全。
 */

/**
 * 支持的导入来源平台标识（与后端 SUPPORTED_PLATFORMS 白名单对齐）。
 * 目前仅支持 DeepSeek，后续扩展在此追加。
 */
export type ImportPlatform = 'deepseek'

/** 单条解析后的会话（平台无关中间结构）。 */
export interface ImportedConversation {
  /** 平台侧的会话唯一标识（用于幂等去重，透传到 metadata.conversation_id）。 */
  id: string
  /** 会话标题（缺失时由 UI 兜底显示「无标题」）。 */
  title: string
  /** 会话发生时间 ISO8601（DeepSeek 的 inserted_at）。 */
  occurredAt: string
  /** 会话最后更新时间 ISO8601（DeepSeek 的 updated_at）。 */
  updatedAt: string
  /** 对话消息数（用户 + 助手回合数，用于预览统计与列表展示）。 */
  messageCount: number
  /** 转换后的对话 Markdown（与插件推送的 conversation_markdown 格式一致）。 */
  markdown: string
  /** 模型名（取首条消息的 model，可空）。 */
  model?: string
}

/** 解析后的预览结果。 */
export interface ImportPreview {
  /** 来源平台。 */
  platform: ImportPlatform
  /** 全部会话列表（按 occurredAt 升序）。 */
  conversations: ImportedConversation[]
  /** 时间范围（无有效时间时为 null）。 */
  timeRange: { start: string; end: string } | null
  /** 总消息数（所有会话 messageCount 之和）。 */
  totalMessages: number
}

/** 解析错误（文件无法识别或格式不符）。 */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportParseError'
  }
}

/** 单个平台的解析器接口。 */
export interface PlatformImporter {
  /** 平台标识。 */
  platform: ImportPlatform
  /** 判断给定已解析的 JSON 数据是否匹配本平台格式。 */
  detect: (data: unknown) => boolean
  /** 解析为统一预览结构。失败抛 ImportParseError。 */
  parse: (data: unknown) => ImportPreview
}

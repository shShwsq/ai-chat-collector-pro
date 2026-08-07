/**
 * 平台对话导入入口：自动识别来源与格式并解析。
 *
 * 用法：
 * ```ts
 * const text = await file.text()
 * const preview = detectAndParse(text)  // 抛 ImportParseError 表示无法识别
 * ```
 *
 * 扩展新平台时：
 * 1. 在 ``./types.ts`` 的 ``ImportPlatform`` 联合类型追加平台标识；
 * 2. 实现 ``PlatformImporter``（detect + parse）；
 * 3. 在此处的 ``IMPORTERS`` 数组中注册。
 */

import { deepseekImporter } from './deepseek'
import { ImportParseError, type ImportPreview, type PlatformImporter } from './types'

/** 已注册的解析器列表（顺序即检测优先级）。 */
const IMPORTERS: PlatformImporter[] = [deepseekImporter]

/**
 * 解析 JSON 文本并自动识别平台格式。
 *
 * @param text 平台导出的原始文件文本（JSON）
 * @returns 解析后的预览结构
 * @throws {ImportParseError} 文件非合法 JSON 或无解析器能识别
 */
export function detectAndParse(text: string): ImportPreview {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new ImportParseError(
      `文件不是合法的 JSON：${(e as Error).message}`,
    )
  }

  for (const importer of IMPORTERS) {
    if (importer.detect(data)) {
      return importer.parse(data)
    }
  }

  throw new ImportParseError(
    '无法识别文件来源与格式（目前仅支持 DeepSeek 导出的 conversations.json）',
  )
}

export * from './types'

/**
 * 时间格式化工具。
 *
 * 背景：后端数据库存储 UTC 时间（datetime.now(UTC)），FastAPI 默认序列化为
 * ISO 8601 格式。对于带时区后缀的字符串（+00:00 / Z），JS 的 ``new Date()``
 * 能正确识别并转换为本地时间；但对于无时区后缀的 naive 字符串，JS 会按
 * **本地时区** 解析，导致 UTC 时间被错误加上/减去时区偏差（东八区快 8 小时）。
 *
 * 本模块提供安全的解析函数，确保所有来自后端的时间都被正确当作 UTC 处理。
 */

/**
 * 安全解析后端返回的时间值为 Date 对象。
 *
 * - number / numeric string：当作 Unix **秒** 时间戳（后端 ``time.time()``）
 * - ISO string：若末尾无时区标记（Z / +HH:MM / -HH:MM），追加 'Z' 当作 UTC
 * - Date：直接返回
 * - 其他 / 无效值：返回 null
 */
export function parseDate(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v
  }

  // 数字或纯数字字符串 → Unix 秒时间戳
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }

  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return null

    // 纯数字字符串 → Unix 秒时间戳
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      const ms = n > 1e12 ? n : n * 1000
      const d = new Date(ms)
      return Number.isNaN(d.getTime()) ? null : d
    }

    // ISO 8601：若无时区后缀，追加 Z 当作 UTC
    let iso = trimmed
    const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
    if (!hasZone) {
      iso = trimmed + 'Z'
    }
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d
  }

  return null
}

/**
 * 格式化为「YYYY-MM-DD HH:MM」本地时间（用于列表项、时间线等）。
 */
export function formatDateTime(v: unknown): string {
  const d = parseDate(v)
  if (!d) return ''
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

/**
 * 格式化为「MM-DD HH:MM」简短本地时间（用于消息、最近记录）。
 */
export function formatShortTime(v: unknown): string {
  const d = parseDate(v)
  if (!d) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/**
 * 格式化为「HH:MM」时分（用于当日时间线）。
 */
export function formatTime(v: unknown): string {
  const d = parseDate(v)
  if (!d) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

/**
 * 外观系统：主题定义。
 *
 * 主题驱动中性色板（bg / surface / border / text 等），与模式（mode）解耦——
 * mode 仅决定强调色（--accent），主题决定整体中性灰阶。新增主题只需在
 * ``THEMES`` 中追加一项，并在 app.css 中追加对应的
 * ``.app-shell[data-theme='<id>']`` 块。
 */

/** 主题 id 字面量类型。 */
export type Theme = 'simple-white' | 'simple-black' | 'angular-white'

/** 主题元信息：用于设置面板展示与校验。 */
export interface ThemeMeta {
  id: Theme
  label: string
  description: string
  isDark: boolean
}

/** 默认主题 id（localStorage 缺失或非法时回退到此值）。 */
export const DEFAULT_THEME: Theme = 'simple-white'

/** localStorage 中持久化主题用的键名。 */
export const THEME_STORAGE_KEY = 'kwa.theme'

/** 全部可选主题，按展示顺序排列。 */
export const THEMES: ThemeMeta[] = [
  {
    id: 'simple-white',
    label: '简单白',
    description: '明亮克制的日常工作台，强调清晰层级与舒适留白。',
    isDark: false,
  },
  {
    id: 'simple-black',
    label: '简单黑',
    description: '低眩光深灰工作台，适合长时间专注与图谱浏览。',
    isDark: true,
  },
  {
    id: 'angular-white',
    label: '棱角白',
    description: '锐角工业控制台，使用紧凑结构与明确状态标记。',
    isDark: false,
  },
]

/**
 * 判断未知值是否为合法主题 id。
 *
 * 用作 localStorage 读取后的类型守卫，避免把非法字符串直接当作 Theme 使用。
 */
export function isValidTheme(id: unknown): id is Theme {
  return (
    typeof id === 'string' && THEMES.some((t) => t.id === id)
  )
}

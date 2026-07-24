/**
 * 通用 SVG 图标组件（替换原 emoji 图标）。
 *
 * 设计目标：
 * - 不引入外部图标库，全部使用 inline SVG，零运行时依赖
 * - 统一 24×24 viewBox，``stroke="currentColor"``，``stroke-width=2``，
 *   线条风格与现有 UI 一致；颜色继承父元素 ``color``
 * - 支持 ``size`` 与 ``className`` 两个最常用 props，保持调用简洁
 * - 平台类图标（chatgpt / claude / gemini / kimi / deepseek / doubao）
 *   用首字母圆形徽标代替原 emoji，便于辨识且避免品牌素材问题
 *
 * 用法：
 *   <Icon name="check" size={16} />
 *   <Icon name="warning" className="toast__icon" />
 */

import type { CSSProperties, ReactNode, SVGProps } from 'react'

/** 全部受支持的图标名。 */
export type IconName =
  | 'check'
  | 'warning'
  | 'error'
  | 'edit'
  | 'inbox'
  | 'chat'
  | 'search'
  | 'plugin'
  | 'import'
  | 'note'
  | 'document'
  | 'close'
  | 'pencil'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'kimi'
  | 'deepseek'
  | 'doubao'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /** 图标名，见 ``IconName``。 */
  name: IconName
  /** 像素尺寸（同时设置 width / height）。默认 24。 */
  size?: number
  /** 额外 className。 */
  className?: string
  /** 额外 style。 */
  style?: CSSProperties
}

/** 线条类图标（统一 stroke 风格）的 path/shape 数据。 */
const LINE_ICONS: Record<string, ReactNode> = {
  // ✓ 对勾
  check: (
    <polyline points="20 6 9 17 4 12" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  // ⚠ 三角警告
  warning: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // × 错误
  error: (
    <>
      <circle cx="12" cy="12" r="10" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="15" y1="9" x2="9" y2="15" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="9" y1="9" x2="15" y2="15" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // ✎ 铅笔编辑（带下划线，表示编辑动作）
  edit: (
    <>
      <path d="M12 20h9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // pencil：与 edit 同形（保留两个别名便于语义化调用）
  pencil: (
    <>
      <path d="M12 20h9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // ✍️ 笔记 / 手写
  note: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="14 2 14 8 20 8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="13" x2="16" y2="13" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="17" x2="13" y2="17" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 📄 文档
  document: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="14 2 14 8 20 8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="13" x2="16" y2="13" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="17" x2="16" y2="17" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 📥 收件箱 / 下载
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // import：与 inbox 同形（语义别名）
  import: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 💬 对话气泡
  chat: (
    <path
      d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // 🔍 搜索（放大镜）
  search: (
    <>
      <circle cx="11" cy="11" r="8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 🧩 拼图（插件）
  plugin: (
    <path
      d="M14 4a2 2 0 0 1 4 0v2h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1a1 1 0 0 0-1 1v1a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-1a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2V4a2 2 0 0 1 4 0v2h2z"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // × 关闭
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="6" y1="6" x2="18" y2="18" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
}

/** 平台首字母徽标（chatgpt / claude / gemini / kimi / deepseek / doubao）。 */
const PLATFORM_LETTER: Record<string, string> = {
  chatgpt: 'G',
  claude: 'C',
  gemini: 'G',
  kimi: 'K',
  deepseek: 'D',
  doubao: '豆',
}

/**
 * 平台图标：圆形 + 首字母（避开品牌素材，颜色继承父元素）。
 * 调用方可在父元素上设置 color / background-color 来调整风格。
 */
function PlatformGlyph({ letter }: { letter: string }) {
  return (
    <>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <text
        x="12"
        y="12"
        fontSize={letter.length > 1 ? 10 : 11}
        fontWeight={700}
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="none"
      >
        {letter}
      </text>
    </>
  )
}

/**
 * 渲染单个图标。线条类用统一 stroke；平台类用首字母圆形徽标。
 */
export function Icon({ name, size = 24, className, style, ...rest }: IconProps) {
  const isPlatform = name in PLATFORM_LETTER
  const content = isPlatform ? (
    <PlatformGlyph letter={PLATFORM_LETTER[name]} />
  ) : (
    LINE_ICONS[name]
  )

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {content}
    </svg>
  )
}

export default Icon

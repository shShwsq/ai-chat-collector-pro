/// <reference types="vite/client" />

/**
 * Vite 环境变量类型补充。
 *
 * VITE_LOCAL_API_TOKEN 由 vite.config.ts 读取 backend/.env 的 LOCAL_API_TOKEN
 * 后经 define 注入（仅纯浏览器 dev 场景生效）。Electron 场景走 preload 桥，
 * 不依赖此变量；若 backend/.env 未配置则该值为 undefined，由 api.ts 兜底。
 */
interface ImportMetaEnv {
  readonly VITE_LOCAL_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

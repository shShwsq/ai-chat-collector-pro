import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// backend 目录（相对 vite.config.ts 定位，与 cwd 无关，保证 vitest / 任意启动目录都正确）
const BACKEND_DIR = fileURLToPath(new URL('../backend', import.meta.url))

// Vite 配置：base 使用相对路径，便于 Electron 通过 file:// 加载打包产物；
// 开发服务器将 /api 与 /ws 代理至本地 FastAPI 后端（端口 8788，避免和步影 8787 冲突）。
// 前端 dev server 监听 5174（避免和步影 5173 冲突）。
//
// 本地鉴权 token 统一来源：读取 backend/.env 的 LOCAL_API_TOKEN，经 define 注入
// 渲染进程的 import.meta.env.VITE_LOCAL_API_TOKEN（纯浏览器 dev 场景使用；
// Electron 场景走 preload 桥，不依赖此 define）。
export default defineConfig(({ mode }) => {
  // prefixes='' 表示读取全部变量（不限于 VITE_ 前缀）
  const env = loadEnv(mode, BACKEND_DIR, '')
  const localApiToken = env.LOCAL_API_TOKEN

  return {
    base: './',
    plugins: [react()],
    define: {
      // 仅当 backend/.env 真正配置了 token 时才注入；否则保持 undefined，
      // 由 api.ts 的 DEV_LOCAL_API_TOKEN 兜底，避免 define 传入 undefined。
      ...(localApiToken
        ? { 'import.meta.env.VITE_LOCAL_API_TOKEN': JSON.stringify(localApiToken) }
        : {}),
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8788',
          changeOrigin: true,
          ws: true,
          timeout: 300000,
          proxyTimeout: 300000,
        },
        '/ws': {
          target: 'ws://127.0.0.1:8788',
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('react-force-graph') || id.includes('force-graph') || id.includes('d3-')) {
              return 'graph-vendor'
            }
            if (id.includes('react-markdown') || id.includes('remark-') || id.includes('micromark') || id.includes('mdast') || id.includes('hast')) {
              return 'markdown-vendor'
            }
            if (id.includes('/motion/') || id.includes('framer-motion')) {
              return 'motion-vendor'
            }
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'react-vendor'
            }
            return 'vendor'
          },
        },
      },
    },
  }
})

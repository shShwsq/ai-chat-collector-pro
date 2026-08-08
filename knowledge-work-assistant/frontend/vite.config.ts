import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 配置：base 使用相对路径，便于 Electron 通过 file:// 加载打包产物；
// 开发服务器将 /api 与 /ws 代理至本地 FastAPI 后端（端口 8788，避免和步影 8787 冲突）。
// 前端 dev server 监听 5174（避免和步影 5173 冲突）。
export default defineConfig({
  base: './',
  plugins: [react()],
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
})

/**
 * 前端入口文件。
 *
 * 知识工作助手（双模式 Study/Work 知识图谱软件）的渲染进程入口。
 * 当前为联调骨架，仅挂载根组件 App；后续随业务模块（图谱视图、
 * 节点详情卡、模式切换开关等）落地，在此注入全局状态、路由、主题等。
 *
 * 通信层：
 *   - lib/api.ts    — HTTP 请求（/api/* 前缀，dev 环境经 Vite 代理）
 *   - lib/ws.ts     — WebSocket（/ws 测试通道；后续扩展为流式对话等业务 WS）
 *   - lib/types.ts  — 与后端 schemas.py 对齐的类型契约
 *   - lib/electron.d.ts — Electron preload 桥的全局类型声明
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/animations.css'
import './styles/app.css'
import './styles/responsive.css'
import App from './App'
import { resolveStoredTheme } from './lib/themes'
import { MotionProvider } from './lib/motion'

const initialTheme = resolveStoredTheme(typeof window === 'undefined' ? null : window.localStorage)
document.documentElement.dataset.theme = initialTheme
document.documentElement.style.colorScheme = initialTheme === 'simple-black' ? 'dark' : 'light'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MotionProvider>
      <App />
    </MotionProvider>
  </React.StrictMode>,
)

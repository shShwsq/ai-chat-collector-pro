/**
 * 前端入口文件。
 *
 * 对话回声（双模式 Study/Work 知识图谱软件）的渲染进程入口。
 * 挂载根组件 App，注入主题与 Motion Provider（图谱视图、节点详情卡、
 * 模式切换开关等业务模块已在 App 中装配）。
 *
 * 通信层：
 *   - lib/api.ts    — HTTP 请求（/api/* 前缀，dev 环境经 Vite 代理）
 *   - lib/ws.ts     — WebSocket（/ws：业务事件与 Agent 流式输出）
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

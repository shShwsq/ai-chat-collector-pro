import { contextBridge, ipcRenderer } from 'electron'

/**
 * 预加载脚本：在 contextIsolation 开启的前提下，通过 contextBridge 暴露
 * 受限且类型安全的 Electron API 给渲染进程。
 *
 * 渲染进程统一通过 window.electronAPI 访问，所有 IPC 通信均在此收敛。
 *
 * 暴露后端基地址查询、本地 API token 等接口（生产环境 file:// 加载时
 * 渲染进程需要直连后端 127.0.0.1:8788，而非走 Vite 代理）；业务模块
 * （模式切换 / 图谱操作 / 文件上传等）所需 IPC 接口按需在此补充。
 */
contextBridge.exposeInMainWorld('electronAPI', {
  backend: {
    /**
     * 获取后端 HTTP 基地址。
     * - 开发环境：优先用 BACKEND_URL 环境变量，默认 http://127.0.0.1:8788。
     *   （dev 下渲染进程走 Vite 代理，不直接调用此值。）
     * - 生产环境：始终为 http://127.0.0.1:8788。
     */
    getUrl(): string {
      return ipcRenderer.sendSync('backend:get-url') as string
    },
    /** 获取后端 WebSocket 基地址（生产环境为 ws://127.0.0.1:8788）。 */
    getWsUrl(): string {
      return ipcRenderer.sendSync('backend:get-ws-url') as string
    },
    getApiToken(): string {
      return ipcRenderer.sendSync('backend:get-api-token') as string
    },
  },
})

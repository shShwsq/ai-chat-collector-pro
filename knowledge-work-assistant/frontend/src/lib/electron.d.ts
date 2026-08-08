/**
 * 全局类型声明：window.electronAPI
 *
 * 与 electron/preload.ts 中 contextBridge.exposeInMainWorld('electronAPI', ...)
 * 暴露的 API 一一对应，为渲染进程提供类型安全的 Electron 访问能力。
 *
 * 在非 Electron 环境（纯浏览器 dev 模式）下 window.electronAPI 为 undefined，
 * 调用方需通过可选链（window.electronAPI?.xxx）进行防御。
 *
 * 当前为联调骨架，仅暴露后端基地址查询接口；后续随业务扩展
 * （模式切换 / 图谱操作 / 文件上传等）在此补充对应 API。
 */

export {}

declare global {
  /** 后端基地址查询接口（用于 file:// 加载场景直连后端）。 */
  interface BackendApi {
    /** 获取后端 HTTP 基地址（生产环境为 http://127.0.0.1:8788）。 */
    getUrl: () => string
    /** 获取后端 WebSocket 基地址（生产环境为 ws://127.0.0.1:8788）。 */
    getWsUrl: () => string
    getApiToken: () => string
  }

  /** 渲染进程可用的 Electron API 集合。 */
  interface ElectronAPI {
    backend: BackendApi
  }

  interface Window {
    /** 由 preload 脚本注入；非 Electron 环境下为 undefined。 */
    electronAPI?: ElectronAPI
  }
}

import { app, BrowserWindow, shell, ipcMain } from 'electron'
import * as path from 'path'

// 后端进程启动器：生产环境 spawn 后端并健康检查；开发环境跳过（开发者手动启动）
import { startBackendAndWait, stopBackend, getBackendBaseUrl, getBackendWsUrl } from './launcher'

// 开发环境由 Vite 提供 dev server；生产环境加载打包后的 dist/index.html。
const isDev = !app.isPackaged

// ===== 窗口尺寸常量 =====
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 820

let mainWindow: BrowserWindow | null = null

/**
 * 创建主窗口。
 *
 * 当前为骨架联调版：一个标准桌面窗口，加载 Vite dev server（开发）或
 * 打包后的 dist/index.html（生产）。后续随业务模块（模式切换开关、图谱视图等）
 * 落地，可在此扩展窗口属性（最小尺寸、自定义标题栏等）。
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    title: '知识工作助手',
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接交给系统浏览器，避免在 Electron 内新开窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

/**
 * 注册 IPC 处理器。
 *
 * 当前仅提供后端基地址查询（同步返回，供 preload.sendSync 使用）：
 * 渲染进程通过 window.electronAPI.backend.getUrl() 获取后端 HTTP 基地址，
 * window.electronAPI.backend.getWsUrl() 获取 WebSocket 基地址。
 *
 * 后续随业务模块落地（模式切换 / 图谱操作 / 文件上传等）在此扩展对应 handler。
 */
function registerIpcHandlers(): void {
  ipcMain.on('backend:get-url', (event) => {
    event.returnValue = getBackendBaseUrl()
  })
  ipcMain.on('backend:get-ws-url', (event) => {
    event.returnValue = getBackendWsUrl()
  })
}

// ===== 应用生命周期 =====

app.whenReady().then(async () => {
  registerIpcHandlers()

  // 启动后端进程（生产环境 spawn uvicorn 子进程 + 健康检查；开发环境跳过）。
  // 异步执行不阻塞窗口创建：窗口立即显示，后端就绪后前端自动连接。
  startBackendAndWait()
    .then((ready) => {
      if (!ready) {
        console.error('[main] 后端未就绪，部分功能可能不可用')
      }
    })
    .catch((err) => {
      console.error('[main] 后端启动异常:', err)
    })

  createWindow()

  // macOS 下点击 dock 图标且无窗口时重新创建。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前停止后端子进程（Windows 下 taskkill /T /F 终止进程树）。
app.on('before-quit', () => {
  stopBackend()
})

app.on('window-all-closed', () => {
  // 非 macOS 平台关闭所有窗口后退出应用。
  if (process.platform !== 'darwin') app.quit()
})

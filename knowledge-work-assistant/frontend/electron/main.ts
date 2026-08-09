import { app, BrowserWindow, shell, ipcMain, Menu, dialog } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// 帮助文档 / 问题反馈 / 版本更新对应的在线地址。
const HELP_DOC_URL = 'https://github.com/shShwsq/ai-chat-collector-pro/blob/main/knowledge-work-assistant/README.md'
const REPORT_ISSUE_URL = 'https://github.com/shShwsq/ai-chat-collector-pro/issues'
const RELEASES_URL = 'https://github.com/shShwsq/ai-chat-collector-pro/releases'

// 后端进程启动器：生产环境 spawn 后端并健康检查；开发环境跳过（开发者手动启动）
import { startBackendAndWait, stopBackend, getBackendBaseUrl, getBackendWsUrl, getBackendApiToken } from './launcher'

// 开发环境由 Vite 提供 dev server；生产环境加载打包后的 dist/index.html。
const isDev = !app.isPackaged

// ===== 窗口尺寸常量 =====
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 820

let mainWindow: BrowserWindow | null = null

/**
 * 构建极简中文应用菜单。
 *
 * 仅保留「文件 / 帮助」两个顶层菜单：
 * - 文件：退出
 * - 帮助：帮助文档（在线 README）、报告问题、检查更新、关于 对话回声
 *
 * 不再暴露 Reload / Force Reload / Toggle Developer Tools / New Window 等
 * 开发者向选项，避免最终用户误触并降低安全暴露面。开发环境仍可使用快捷键
 * 打开 DevTools（见 blockDevShortcuts 中的 isDev 分支）。
 */
function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        isMac
          ? { role: 'close', label: '关闭窗口' }
          : { role: 'quit', label: '退出', accelerator: 'Ctrl+Q' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '帮助文档',
          click: () => shell.openExternal(HELP_DOC_URL),
        },
        {
          label: '报告问题',
          click: () => shell.openExternal(REPORT_ISSUE_URL),
        },
        {
          label: '检查更新',
          click: () => shell.openExternal(RELEASES_URL),
        },
        { type: 'separator' },
        {
          label: `关于 ${app.getName()}`,
          click: () => showAboutDialog(),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 弹出原生「关于」对话框，显示应用名 / 版本 / 简介 / 仓库链接。
 */
function showAboutDialog(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: `关于 ${app.getName()}`,
    message: app.getName(),
    detail: [
      `版本：${app.getVersion()}`,
      '',
      '双模式（Study / Work）知识图谱桌面软件。',
      '接收浏览器插件采集的 AI 对话，由 Agent 自动抽取知识点并沉淀为可问答、可测验、可辅助工作的知识图谱。',
      '',
      `仓库：${RELEASES_URL.replace('/releases', '')}`,
    ].join('\n'),
    buttons: ['确定'],
    noLink: true,
  })
}

/**
 * 屏蔽渲染进程中的开发者向快捷键（生产环境）。
 *
 * 通过 webContents 的 before-input-event 拦截：F12、Ctrl+Shift+I/J/C、
 * Ctrl+R / Ctrl+Shift+R（刷新 / 强制刷新）。开发环境保留全部快捷键以便调试。
 */
function blockDevShortcuts(window: BrowserWindow): void {
  if (isDev) return

  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const { key, control, shift, alt } = input

    // F12：切换 DevTools
    if (key === 'F12') {
      _event.preventDefault()
      return
    }

    // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C：DevTools / 控制台 / 检查元素
    if (control && shift && ['I', 'J', 'C'].includes(key.toUpperCase())) {
      _event.preventDefault()
      return
    }

    // Ctrl+R / Ctrl+Shift+R：刷新 / 强制刷新（避免误触清空会话状态）
    if (control && !alt && (key === 'r' || key === 'R')) {
      _event.preventDefault()
      return
    }
  })
}

/**
 * 创建主窗口。
 *
 * 标准桌面窗口，加载 Vite dev server（开发）或打包后的 dist/index.html（生产）。
 * 业务模块（模式切换开关、图谱视图等）已在渲染进程落地；如需扩展窗口属性
 * （自定义标题栏等）可在此调整。
 */
function createWindow(): void {
  const preloadPath = path.join(__dirname, 'preload.js')
  console.log(`[main] __dirname: ${__dirname}`)
  console.log(`[main] resourcesPath: ${process.resourcesPath}`)
  console.log(`[main] preload path: ${preloadPath} exists=${fs.existsSync(preloadPath)}`)

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    title: '对话回声',
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 诊断：监听渲染进程加载失败
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] 页面加载失败: url=${validatedURL}, code=${errorCode}, desc=${errorDescription}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] 页面加载完成')
  })

  // 生产环境屏蔽开发者向快捷键（F12 / Ctrl+Shift+I / Ctrl+R 等）。
  blockDevShortcuts(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接交给系统浏览器，避免在 Electron 内新开窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    console.log(`[main] 开发模式，加载: ${process.env.VITE_DEV_SERVER_URL}`)
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // __dirname 在打包后为 resources/app/electron/dist（asar:false 时）。
    // index.html 由 vite 构建到 resources/app/dist，需从 electron/dist 回退两级到 app/ 再进 dist/。
    const indexPath = path.join(__dirname, '../../dist/index.html')
    console.log(`[main] 生产模式，加载: ${indexPath} exists=${fs.existsSync(indexPath)}`)
    mainWindow.loadFile(indexPath)
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
  ipcMain.on('backend:get-api-token', (event) => {
    event.returnValue = getBackendApiToken()
  })
}

// ===== 应用生命周期 =====

app.whenReady().then(async () => {
  registerIpcHandlers()

  // 设置极简中文应用菜单（文件 / 帮助），覆盖 Electron 默认菜单。
  buildApplicationMenu()

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

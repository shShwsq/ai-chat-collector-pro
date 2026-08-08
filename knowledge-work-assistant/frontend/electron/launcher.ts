/**
 * 后端进程启动器。
 *
 * 职责：
 * 1. 在生产环境下定位并 spawn 后端可执行文件或 uvicorn 命令。
 * 2. 设置后端运行所需的环境变量（数据目录、数据库路径），
 *    使后端将数据写入 Electron userData 目录而非只读的 resources 目录。
 * 3. 轮询 GET /api/health 健康检查，等待后端就绪（超时 30s）。
 * 4. 应用退出时终止后端子进程。
 *
 * 开发环境跳过后端启动（后端由开发者手动运行 ``uv run uvicorn``）。
 *
 * 本项目从步影 frontend/electron/launcher.ts 适配拷贝而来，
 * 端口从 8787 改为 8788，移除 ChromaDB 相关环境变量（本项目不依赖向量库）。
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

/** 后端默认监听端口（与 backend 开发端口一致，避免和步影 8787 冲突）。 */
const DEFAULT_BACKEND_PORT = 8788

/** 健康检查轮询间隔（毫秒）。 */
const HEALTH_CHECK_INTERVAL_MS = 500

/** 健康检查总超时（毫秒）。 */
const HEALTH_CHECK_TIMEOUT_MS = 30_000

/** 后端进程引用（null 表示未启动 / 已停止）。 */
let backendProcess: ChildProcess | null = null
const backendApiToken = process.env.LOCAL_API_TOKEN ?? randomBytes(32).toString('base64url')

/**
 * 判断是否为开发环境。
 *
 * 开发环境下（app.isPackaged === false）后端由开发者手动启动，
 * launcher 不负责拉起后端进程。
 */
export function isDev(): boolean {
  return !app.isPackaged
}

/**
 * 获取后端 HTTP 基地址。
 *
 * - 开发环境：优先使用 BACKEND_URL 环境变量，默认 http://127.0.0.1:8788。
 *   （vite dev server 通过 proxy 转发 /api，前端使用相对路径，不直接调用此值。）
 * - 生产环境：始终为 http://127.0.0.1:{DEFAULT_BACKEND_PORT}。
 */
export function getBackendBaseUrl(): string {
  if (isDev()) {
    return process.env.BACKEND_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`
  }
  return `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`
}

/**
 * 获取后端 WebSocket 基地址（用于 /ws 与后续 /api/ws/* 连接）。
 */
export function getBackendWsUrl(): string {
  const http = getBackendBaseUrl()
  return http.replace(/^http/, 'ws')
}

/**
 * 定位后端入口（仅生产环境）。
 *
 * 当前实现：尝试两种方式（按优先级）：
 *   1. 打包产物 backend 子目录下的 ``python`` 可执行文件 + ``app`` 包
 *      （PyInstaller onedir 产物，结构 resources/backend/...）
 *   2. 兜底：调用系统 ``python -m uvicorn app.main:app``（要求目标机器已装 Python + 依赖）
 *
 * 由于本项目当前未配置 PyInstaller 打包，生产环境下默认走 uvicorn 方式。
 * 后续若引入 PyInstaller，可在此扩展可执行文件探测逻辑。
 */
interface ResolvedBackend {
  command: string
  args: string[]
  cwd: string
}

function resolveBackend(): ResolvedBackend | null {
  // 兜底方案：调用系统 python + uvicorn 启动后端
  // 要求目标机器已安装 Python 3.12+ 与项目依赖（uv sync 安装）
  // 生产打包时建议改用 PyInstaller 单文件，避免依赖系统 Python
  const backendDir = path.join(
    process.resourcesPath,
    'backend',
  )
  const cwd = fs.existsSync(backendDir) ? backendDir : process.cwd()
  return {
    command: 'python',
    args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(DEFAULT_BACKEND_PORT)],
    cwd,
  }
}

/**
 * 计算后端数据目录（位于 Electron userData 下，确保可写）。
 *
 * 后端将 SQLite 数据库、上传文件、加密密钥等存放在此目录。
 */
function resolveBackendDataDir(): string {
  const dataDir = path.join(app.getPath('userData'), 'backend-data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

/**
 * 启动后端进程（仅生产环境调用）。
 *
 * 设置以下环境变量：
 * - DATA_DIR：数据目录（userData/backend-data）
 * - DATABASE_URL：SQLite 数据库连接字符串
 * - APP_ENV：生产环境标记
 *
 * @returns 启动成功返回 true，失败返回 false。
 */
export function startBackend(): boolean {
  if (isDev()) {
    console.log('[launcher] 开发环境，跳过后端启动（请手动运行 uvicorn）')
    return true
  }

  const resolved = resolveBackend()
  if (!resolved) {
    console.error('[launcher] 无法定位后端入口')
    return false
  }

  const dataDir = resolveBackendDataDir()
  const dbPath = path.join(dataDir, 'app.db')

  console.log(`[launcher] 启动后端: ${resolved.command} ${resolved.args.join(' ')}`)
  console.log(`[launcher] 工作目录: ${resolved.cwd}`)
  console.log(`[launcher] 数据目录: ${dataDir}`)

  try {
    const proc = spawn(resolved.command, resolved.args, {
      cwd: resolved.cwd,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        DATABASE_URL: `sqlite+aiosqlite:///${dbPath.replace(/\\/g, '/')}`,
        APP_ENV: 'production',
        BACKEND_PORT: String(DEFAULT_BACKEND_PORT),
      },
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    backendProcess = proc

    // 转发后端 stdout / stderr 到主进程控制台（便于调试）
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) console.log(`[backend] ${text}`)
    })
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) console.error(`[backend] ${text}`)
    })

    proc.on('error', (err: Error) => {
      console.error('[launcher] 后端进程启动失败:', err.message)
    })

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(`[launcher] 后端进程退出: code=${code} signal=${signal}`)
      backendProcess = null
    })

    return true
  } catch (err) {
    console.error('[launcher] 启动后端异常:', err)
    return false
  }
}

/**
 * 健康检查：轮询 GET /api/health 直到返回 200 或超时。
 *
 * @returns 就绪返回 true，超时或失败返回 false。
 */
export async function waitForBackend(): Promise<boolean> {
  const baseUrl = getBackendBaseUrl()
  const healthUrl = `${baseUrl}/api/health`
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS

  console.log(`[launcher] 等待后端就绪: ${healthUrl}（超时 ${HEALTH_CHECK_TIMEOUT_MS / 1000}s）`)

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(healthUrl, {
        signal: controller.signal,
        method: 'GET',
        headers: { 'X-Local-API-Token': backendApiToken },
      })
      clearTimeout(timer)

      if (res.ok) {
        console.log('[launcher] 后端已就绪')
        return true
      }
    } catch {
      // 后端尚未启动或端口未监听，继续轮询
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS)
  }

  console.error('[launcher] 等待后端就绪超时')
  return false
}

/**
 * 启动后端并等待健康检查通过。
 *
 * 生产环境下的完整启动流程：
 * 1. spawn 后端可执行文件 / uvicorn 命令
 * 2. 轮询健康检查
 *
 * @returns 后端就绪返回 true，否则 false。
 */
export async function startBackendAndWait(): Promise<boolean> {
  if (isDev()) {
    // 开发环境：假设后端已由开发者手动启动
    // 尝试健康检查，失败也不阻塞（开发者可能稍后启动）
    const ready = await waitForBackend()
    if (!ready) {
      console.warn('[launcher] 开发环境：后端未就绪，前端将尝试连接（可能需要手动启动后端）')
    }
    return true
  }

  const started = startBackend()
  if (!started) {
    return false
  }

  return waitForBackend()
}

/**
 * 停止后端进程。
 *
 * 在 app.before-quit 中调用，确保后端子进程不残留。
 * Windows 下使用 taskkill /T /F 确保子进程树被终止。
 */
export function stopBackend(): void {
  if (!backendProcess || backendProcess.killed) {
    backendProcess = null
    return
  }

  const pid = backendProcess.pid
  console.log(`[launcher] 停止后端进程: pid=${pid}`)

  try {
    // Windows 下 uvicorn 可能 fork 子进程，
    // 仅 kill 主进程可能导致子进程残留。使用 taskkill /T 终止整棵进程树。
    if (process.platform === 'win32' && pid) {
      try {
        // taskkill /T:终止进程树 /F:强制
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        // taskkill 不可用时回退到 process.kill
        backendProcess.kill('SIGTERM')
      }
    } else {
      backendProcess.kill('SIGTERM')
    }
  } catch (err) {
    console.error('[launcher] 停止后端进程失败:', err)
  }

  backendProcess = null
}

/** Promise 化的 sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

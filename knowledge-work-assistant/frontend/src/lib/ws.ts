/**
 * 统一 WebSocket 客户端封装。
 *
 * 与 backend/app/routers/ws.py 的协议对齐：
 * - 连接建立 → 后端推送 ``{ type: "welcome", message: "...", session_id: "..." }``
 * - 客户端发送 ``{ type: "ping" }`` → 后端回复 ``{ type: "pong" }``
 * - 客户端发送其他 JSON → 后端回复 ``{ type: "echo", data: <原消息> }``
 * - 客户端发送非 JSON 文本 → 后端回复 ``{ type: "echo", data: "<原文本>" }``
 *
 * **session_id 注册**：连接时可通过 ``connect(sessionId)`` 传入前端生成的
 * 唯一会话 ID，后端会把此连接注册到该 session_id 下，使后台流式 LLM 任务
 * （如节点详情卡 / 问答 / 报告生成）能通过 ``notify_session`` 精确推送
 * token 到本连接。未传入时注册到 ``"default"`` 会话，仅接收全局广播
 * （如插件对话已接收事件）。
 *
 * 流式事件（由后端 GraphAgent._stream_llm 推送）：
 * - ``graph_agent_token``：每个 token（含 op / graph_id / node_id / content / seq）
 * - ``graph_agent_done``：流式完成（含 op / graph_id / node_id / full_text）
 * - ``graph_agent_cancelled``：被外部取消（含 full_text）
 * - ``graph_agent_error``：失败（含 message）
 */

import { api } from './api'
import type { WsEvent, WsOutgoing } from './types'

/** 解析 WebSocket 基地址。 */
function wsBase(): string {
  // 兜底地址：非浏览器环境或 preload 桥不可用时使用。
  const FALLBACK = 'ws://127.0.0.1:8788'
  if (typeof window === 'undefined') return FALLBACK
  const loc = window.location
  if (loc.protocol === 'file:') {
    // 生产环境（file://）：优先通过 preload 桥获取后端 WS 地址
    return window.electronAPI?.backend?.getWsUrl() ?? FALLBACK
  }
  // dev 环境通过 Vite 代理（vite.config.ts 已为 /ws 开启 ws 代理）
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`
}

type Unsubscribe = () => void

export function getReconnectDelay(attempt: number): number {
  const cappedAttempt = Math.max(0, Math.min(attempt, 6))
  return Math.min(30_000, 500 * 2 ** cappedAttempt)
}

function safeParse(raw: unknown): unknown | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 全局 WebSocket 客户端：连接根路径 ``/ws``，支持按 session_id 注册。
 *
 * 用法：
 *   const socket = new TestSocket()
 *   await socket.connect(mySessionId)  // 传入 session_id 启用流式推送
 *   const off = socket.onEvent((event) => console.log(event))
 *   socket.send({ type: 'ping' })
 *   // ...
 *   socket.close()
 */
export class TestSocket {
  private socket: WebSocket | null = null
  private readonly handlers = new Set<(event: WsEvent) => void>()
  /** 当前连接注册到的 session_id（连接成功后由后端 welcome 事件回填）。 */
  private currentSessionId: string | null = null
  private requestedSessionId: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private connectingPromise: Promise<void> | null = null

  /**
   * 建立连接，resolve 后即可发送消息。
   *
   * **鉴权流程**：连接前先调用 ``GET /api/auth/ws-token`` 获取短期 token,
   * 拼接到 ``/ws?token=xxx`` 查询参数。后端握手时校验 token,失败则以
   * code 4401 关闭连接。token 获取失败时 reject(不降级到无 token 连接)。
   *
   * @param sessionId 可选。前端生成的唯一会话 ID（如 UUID），用于接收
   *   后端流式 LLM token 推送。未传入时后端注册到 "default" 会话，
   *   仅接收全局广播（如插件对话已接收事件）。
   */
  async connect(sessionId?: string): Promise<void> {
    this.requestedSessionId = sessionId ?? this.requestedSessionId
    this.intentionallyClosed = false
    if (this.isOpen) return
    if (this.connectingPromise) return this.connectingPromise

    this.connectingPromise = this.openSocket().finally(() => {
      this.connectingPromise = null
    })
    return this.connectingPromise
  }

  private async openSocket(): Promise<void> {
    let token: string
    try {
      if (!this.requestedSessionId) throw new Error('缺少 WebSocket session_id')
      const resp = await api.getWsToken(this.requestedSessionId)
      token = resp.token
    } catch (e) {
      this.scheduleReconnect()
      throw new Error(`WebSocket 鉴权 token 获取失败: ${(e as Error).message}`)
    }

    const params = new URLSearchParams()
    params.set('token', token)
    if (this.requestedSessionId) params.set('session_id', this.requestedSessionId)
    const url = `${wsBase()}/ws?${params.toString()}`

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket

      let settled = false
      socket.onopen = () => {
        this.reconnectAttempt = 0
        if (!settled) {
          settled = true
          resolve()
        }
      }
      socket.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('WebSocket 连接失败，正在后台重试'))
        }
      }
      socket.onmessage = (ev: MessageEvent) => {
        const data = safeParse(ev.data)
        if (data === null) return
        const maybeWelcome = data as { type?: string; session_id?: string }
        if (maybeWelcome.type === 'welcome' && maybeWelcome.session_id) {
          this.currentSessionId = maybeWelcome.session_id
        }
        for (const handler of this.handlers) {
          handler(data as WsEvent)
        }
      }
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null
        this.currentSessionId = null
        if (!settled) {
          settled = true
          reject(new Error('WebSocket 连接已关闭，正在后台重试'))
        }
        this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.reconnectTimer) return
    const delay = getReconnectDelay(this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.scheduleReconnect()
        return
      }
      void this.connect().catch(() => undefined)
    }, delay)
  }

  /** 订阅任意事件，返回取消订阅函数。 */
  onEvent(handler: (event: WsEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 发送消息（自动 JSON 序列化）。 */
  send(message: WsOutgoing): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  /** 发送 ping 心跳（后端回复 pong）。 */
  ping(): void {
    this.send({ type: 'ping' })
  }

  /** 发送文本作为 echo 测试。后端会回 ``{ type: "echo", data: <原文> }``。 */
  sendText(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(text)
  }

  /** 关闭连接并清理订阅。 */
  close(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.handlers.clear()
    this.socket?.close()
    this.socket = null
    this.currentSessionId = null
    this.requestedSessionId = null
    this.reconnectAttempt = 0
    this.connectingPromise = null
  }

  /** 当前是否处于连接打开状态。 */
  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** 后端回填的 session_id（连接成功后有效，未传入时为 "default"）。 */
  get sessionId(): string | null {
    return this.currentSessionId
  }

  /** 连接时请求的 session_id（即传入 connect() 的值）。 */
  get requestedSession(): string | null {
    return this.requestedSessionId
  }
}

/**
 * 生成一个唯一的 session_id（用于 WebSocket 连接标识）。
 *
 * 优先使用 ``crypto.randomUUID()``（现代浏览器原生支持），
 * 回退到时间戳 + 随机数拼接。
 */
export function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 回退方案：时间戳 + 随机数
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

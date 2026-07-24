/**
 * 统一 WebSocket 客户端封装。
 *
 * 当前为联调骨架：连接根路径 ``/ws``（由 backend/app/routers/ws.py 提供），
 * 接收后端推送的 ``welcome`` / ``pong`` / ``echo`` 事件，并允许发送 ping
 * 与自定义测试消息。后续业务 WebSocket（如流式对话 /api/ws/chat/{session_id}）
 * 会在本模块或独立模块扩展。
 *
 * 与 backend/app/routers/ws.py 的协议对齐：
 * - 连接建立 → 后端推送 ``{ type: "welcome", message: "..." }``
 * - 客户端发送 ``{ type: "ping" }`` → 后端回复 ``{ type: "pong" }``
 * - 客户端发送其他 JSON → 后端回复 ``{ type: "echo", data: <原消息> }``
 * - 客户端发送非 JSON 文本 → 后端回复 ``{ type: "echo", data: "<原文本>" }``
 */

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

function safeParse(raw: unknown): unknown | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 测试用 WebSocket 客户端：连接根路径 ``/ws``。
 *
 * 用法：
 *   const socket = new TestSocket()
 *   await socket.connect()
 *   const off = socket.onEvent((event) => console.log(event))
 *   socket.send({ type: 'ping' })
 *   // ...
 *   socket.close()
 */
export class TestSocket {
  private socket: WebSocket | null = null
  private readonly handlers = new Set<(event: WsEvent) => void>()

  /** 建立连接，resolve 后即可发送消息。 */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${wsBase()}/ws`
      const socket = new WebSocket(url)
      this.socket = socket

      let settled = false
      socket.onopen = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      socket.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error(`WebSocket 连接失败: ${url}`))
        }
      }
      socket.onmessage = (ev: MessageEvent) => {
        const data = safeParse(ev.data)
        if (data === null) return
        for (const handler of this.handlers) {
          handler(data as WsEvent)
        }
      }
      socket.onclose = () => {
        this.socket = null
      }
    })
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
    this.handlers.clear()
    this.socket?.close()
    this.socket = null
  }

  /** 当前是否处于连接打开状态。 */
  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }
}

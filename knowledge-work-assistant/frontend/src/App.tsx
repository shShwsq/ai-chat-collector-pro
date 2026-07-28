import { useCallback, useEffect, useRef, useState } from 'react'

import { api, ApiError } from './lib/api'
import { GraphList } from './components/GraphList'
import { ModeSwitch } from './components/ModeSwitch'
import { ContentToolbar } from './components/ContentToolbar'
import { SideNav } from './components/SideNav'
import { ChatPanel } from './components/ChatPanel'
import { ChatExpandedOverlay } from './components/ChatExpandedOverlay'
import { SettingsPanel } from './components/SettingsPanel'
import { CardView } from './components/graph/CardView'
import { GraphView, type GraphViewHandle } from './components/graph/GraphView'
import { PendingNodes } from './components/graph/PendingNodes'
import { QuizPanel } from './components/graph/QuizPanel'
import { WorkInput } from './components/graph/WorkInput'
import { TrendsSidebar } from './components/graph/TrendsSidebar'
import { ReportPanel } from './components/graph/ReportPanel'
import { QAPanel } from './components/graph/QAPanel'
import { Toast } from './components/Toast'
import { useAppStore } from './store/useAppStore'
import { generateSessionId, TestSocket } from './lib/ws'
import type { HealthResponse } from './lib/types'

/**
 * 知识工作助手根组件（Task 5 / Task 6 / Task 8 / Task 11 / Task 12 落地版）。
 *
 * 布局（重构后）：
 *   ┌─────────────────────────────────────────────────────┐
 *   │ header：标题 + 副标题 ｜ 健康指示 ｜ ModeSwitch      │
 *   ├──┬──────────────┬──────────────────────────────────┤
 *   │S│ GraphList    │ content-area                     │
 *   │i│ (左侧栏)     │   ├ ContentToolbar（视图切换+重新布局+撤销延伸+开始测验）│
 *   │d│   ├ 图谱列表 │   ├ GraphView / CardView（双视图切换）│
 *   │e│   └ 待抽取   │   ├ PendingNodes（浮层，Task 11）│
 *   │N│              │   └ QuizPanel（浮层，Task 12）   │
 *   │a│  （仅图谱视图显示）                              │
 *   │v│                                              │
 *   ├──┴──────────────┴──────────────────────────────────┤
 *   │ footer                                              │
 *   └─────────────────────────────────────────────────────┘
 *
 * - 最左侧 SideNav 为固定窄栏（56px）：从上到下「对话 / 图谱 / 设置」三个图标
 *   按钮，由 store.activeNav 管理（默认 'graph'）。
 * - 主内容区按 activeNav 切换：
 *   - 'graph'    → 显示原 GraphList + content-area（保持现有所有功能不变）
 *   - 'chat'     → 显示 ChatPanel（Work 模式内嵌对话，Study 模式提示）
 *   - 'settings' → 显示 SettingsPanel（LLM API 配置 + 请求队列管理）
 * - 右上 ModeSwitch 切换 study/work（数据模式隔离）
 * - header 健康指示轻量轮询 /api/health（每 5s）
 * - 全局 Toast（store.toast）由 ``<Toast />`` 组件消费
 */
export default function App() {
  const mode = useAppStore((s) => s.mode)
  const view = useAppStore((s) => s.view)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const fullGraph = useAppStore((s) => s.fullGraph)
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)
  const loadGraphs = useAppStore((s) => s.loadGraphs)
  const activeNav = useAppStore((s) => s.activeNav)

  const graphViewRef = useRef<GraphViewHandle>(null)
  // 持有 WebSocket 实例，避免重渲染时重建连接
  const socketRef = useRef<TestSocket | null>(null)

  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string>('')

  const checkHealth = useCallback(async () => {
    try {
      const resp = await api.getHealth()
      setHealth(resp)
      setHealthError('')
    } catch (e) {
      setHealth(null)
      setHealthError(
        e instanceof ApiError ? e.message : (e as Error).message || '未知错误',
      )
    }
  }, [])

  // 启动时：首次加载当前模式图谱列表 + 健康检查轮询
  useEffect(() => {
    void loadGraphs()
    void checkHealth()
    const timer = setInterval(() => void checkHealth(), 5000)
    return () => clearInterval(timer)
  }, [loadGraphs, checkHealth])

  // WebSocket：连接 /ws?session_id=<uuid>，订阅「插件对话已接收」与流式事件。
  //
  // 流式输出（WebSocket 推送）：
  // - session_id 在前端启动时生成并设置到 store.streamingSessionId，
  //   后端会把此连接注册到该 session_id 下，使流式 LLM 任务能精确推送
  //   token / done / cancelled / error 事件到本连接。
  // - 各组件（QAPanel / ReportPanel / NodeDetailCard）触发 ask-stream /
  //   report-stream / detail-stream 时携带 sessionId，后端按 op 类型推送：
  //     · graph_agent_token：逐 token 累积，store 实时更新对应流式文本
  //       （qaStreamingText / reportStreamingText / nodeDetailStreamingText），
  //       组件订阅实现打字机效果。
  //     · graph_agent_done：流式完成，写入最终结果（消息 / 报告 / 详情）。
  //     · graph_agent_cancelled：用户取消，保留已生成部分并弹 Toast。
  //     · graph_agent_error：失败，标记降级并弹错误 Toast。
  //
  // 插件对话已接收：后端在 POST /api/plugin/conversations 推送成功后广播，
  // 收到后弹 Toast 并在图谱视图（study 模式）下刷新待抽取列表。
  //
  // 连接失败时静默降级，流式动作会自动回退到非流式接口（store 内已处理）。
  useEffect(() => {
    const sessionId = generateSessionId()
    useAppStore.getState().setStreamingSessionId(sessionId)

    const socket = new TestSocket()
    socketRef.current = socket
    let off: (() => void) | undefined
    socket
      .connect(sessionId)
      .then(() => {
        off = socket.onEvent((event) => {
          const store = useAppStore.getState()
          switch (event.type) {
            case 'plugin.conversation_received':
              store.handlePluginConversationReceived(event.payload)
              break
            case 'graph_agent_token':
              // 按 op 区分：op="chat" 走多轮对话流式；其他走 graph_agent 流式
              if (event.op === 'chat') {
                store.handleChatToken(event)
              } else {
                store.handleGraphAgentToken(event)
              }
              break
            case 'graph_agent_done':
              if (event.op === 'chat') {
                store.handleChatDone(event)
              } else {
                store.handleGraphAgentDone(event)
              }
              break
            case 'graph_agent_cancelled':
              if (event.op === 'chat') {
                store.handleChatCancelled(event)
              } else {
                store.handleGraphAgentCancelled(event)
              }
              break
            case 'graph_agent_error':
              if (event.op === 'chat') {
                store.handleChatError(event)
              } else {
                store.handleGraphAgentError(event)
              }
              break
            case 'chat_tool_call':
              store.handleChatToolCall(event)
              break
            case 'chat_tool_result':
              store.handleChatToolResult(event)
              break
            case 'chat_tool_call_confirmation':
              store.handleChatToolConfirmation(event)
              break
            default:
              // welcome / pong / echo 等不处理
              break
          }
        })
      })
      .catch(() => {
        // 连接失败：静默处理（后端可能未启用 WS 或网络不可达）
        // 流式动作会自动回退到非流式接口（store 内已判断 sessionId）
      })
    return () => {
      off?.()
      socket.close()
      socketRef.current = null
      useAppStore.getState().setStreamingSessionId(null)
    }
  }, [])

  const isHealthy = health !== null && healthError === ''
  const modeLabel = mode === 'study' ? '学习' : '工作'
  const hasGraph = !!currentGraphId
  const handleRelayout = useCallback(() => {
    graphViewRef.current?.relayout()
  }, [])

  return (
    <div className="app-shell" data-mode={mode}>
      <header className="app-header">
        <div className="app-header__left">
          <h1 className="app-header__title">知识工作助手</h1>
          <span className="app-header__subtitle">
            双模式知识图谱 · {modeLabel}模式
          </span>
        </div>
        <div className="app-header__right">
          <span
            className={`health-badge${
              isHealthy ? ' health-badge--ok' : ' health-badge--error'
            }`}
            title={
              isHealthy
                ? `后端正常（${health!.version}）`
                : `后端未连接：${healthError}`
            }
          >
            <span className="health-badge__dot" />
            {isHealthy ? `后端 ${health!.version}` : '后端未连接'}
          </span>
          <ModeSwitch />
        </div>
      </header>

      <div className="app-body">
        {/* 最左侧竖排导航条：对话 / 图谱 / 设置 */}
        <SideNav />

        {/* 模式滑动容器：用 View Transitions API 实现横向"推出"过渡。
            .mode-slide-wrap 上挂 view-transition-name=mode-slide，
            ModeSwitch 中 startViewTransition 捕获新旧快照，
            CSS ::view-transition-old/new 分别播放滑出/滑入动画。
            SideNav 不在此容器内，保持固定不参与滑动。 */}
        <div className="mode-slide-wrap">
          {/* 主内容区：按 activeNav 切换 */}
          {activeNav === 'chat' ? (
            <main className="content-area content-area--chat">
              <ChatPanel />
            </main>
          ) : activeNav === 'settings' ? (
            <main className="content-area content-area--settings">
              <SettingsPanel />
            </main>
          ) : (
            <>
              <GraphList />
              <main className="content-area">
              {error && (
                <div className="error-bar">
                  <span>{error}</span>
                  <button
                    type="button"
                    className="error-bar__close"
                    onClick={clearError}
                    aria-label="关闭错误提示"
                  >
                    ×
                  </button>
                </div>
              )}
              {hasGraph ? (
                <>
                  <ContentToolbar
                    graphName={fullGraph?.graph.name}
                    onRelayout={handleRelayout}
                  />
                  <div className="content-stage">
                    {view === 'graph' ? (
                      <GraphView ref={graphViewRef} />
                    ) : (
                      <CardView />
                    )}
                  </div>
                </>
              ) : (
                <EmptyContentHint modeLabel={modeLabel} />
              )}

              {/* Task 11：待抽取对话与候选节点浮层面板 */}
              <PendingNodes />

              {/* Task 12：Study 测验浮层面板（仅 study 模式入口可见） */}
              <QuizPanel />

              {/* Task 13/14/15/16：Work 模式业务浮层面板（仅 work 模式入口可见） */}
              <WorkInput />
              <TrendsSidebar />
              <ReportPanel />
              <QAPanel />
            </main>
          </>
          )}
        </div>
      </div>

      {/* 全局 Toast（成功 / 警告 / 错误提示） */}
      <Toast />

      {/* 对话首页"点击卡片展开为大卡"的顶层浮层。
          放在 App 顶层是为了让大卡浮层在 activeNav 从 'chat' 切到 'graph'
          （无缝衔接图谱）时仍能存活——ChatHome 会随 ChatPanel 卸载而消失。 */}
      <ChatExpandedOverlay graphViewRef={graphViewRef} />

      <footer className="app-footer">
        知识工作助手 · 后端端口 8788 · 前端端口 5174
      </footer>
    </div>
  )
}

/**
 * 无选中图谱时的内容区空状态引导。
 */
function EmptyContentHint({ modeLabel }: { modeLabel: string }) {
  return (
    <div className="content-placeholder">
      <h2 className="content-placeholder__title">
        {modeLabel}模式 · 图谱视图
      </h2>
      <p className="content-placeholder__desc">
        请从左侧选择一个图谱，或点击「新建」创建一个{modeLabel}图谱。
        选中后这里会展示该图谱的完整可视化。
      </p>
      <p className="content-placeholder__desc" style={{ marginTop: 4 }}>
        内容区顶部可在「图谱视图」与「卡片视图」间切换，两视图数据同步、切换不丢失。
      </p>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'

import { api, ApiError } from './lib/api'
import { GraphList } from './components/GraphList'
import { ModeSwitch } from './components/ModeSwitch'
import { ContentToolbar } from './components/ContentToolbar'
import { SideNav } from './components/SideNav'
import { ChatPanel } from './components/ChatPanel'
import { ChatExpandedOverlay } from './components/ChatExpandedOverlay'
import { ImportConversationsModal } from './components/ImportConversationsModal'
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
import { OnboardingWizard, isOnboardingDone } from './components/OnboardingWizard'
import { useAppStore } from './store/useAppStore'
import { generateSessionId, TestSocket } from './lib/ws'
import type { HealthResponse } from './lib/types'
import { isValidTheme, THEME_STORAGE_KEY } from './lib/themes'

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
  const theme = useAppStore((s) => s.theme)
  const view = useAppStore((s) => s.view)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const fullGraph = useAppStore((s) => s.fullGraph)
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)
  const loadGraphs = useAppStore((s) => s.loadGraphs)
  const activeNav = useAppStore((s) => s.activeNav)
  const navDirection = useAppStore((s) => s.navDirection)
  // 后台导入任务：运行中在 header 显示可点击的进度入口
  const importJob = useAppStore((s) => s.importJob)
  // LLM 配置（启动时加载，用于判断是否显示「未配置」警告条）
  const llmConfig = useAppStore((s) => s.llmConfig)
  const loadLlmConfig = useAppStore((s) => s.loadLlmConfig)
  const setActiveNav = useAppStore((s) => s.setActiveNav)
  // 首次启动引导：localStorage 标记未完成时显示全屏向导
  const onboardingVisible = useAppStore((s) => s.onboardingVisible)
  const setOnboardingVisible = useAppStore((s) => s.setOnboardingVisible)

  const graphViewRef = useRef<GraphViewHandle>(null)
  // 持有 WebSocket 实例，避免重渲染时重建连接
  const socketRef = useRef<TestSocket | null>(null)

  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string>('')
  const [importModalOpen, setImportModalOpen] = useState(false)

  // 启动时根据 localStorage 标记决定是否显示引导向导
  useEffect(() => {
    if (!isOnboardingDone()) setOnboardingVisible(true)
  }, [setOnboardingVisible])

  // LLM 未配置时显示警告条：llmConfig 已加载但 ready 为 false
  const llmNotReady = llmConfig !== null && llmConfig.ready === false

  useEffect(() => {
    const dark = theme === 'simple-black'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = theme
    const themeColor = dark ? '#121212' : '#f6f6f2'
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor)
  }, [theme])

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY || !isValidTheme(event.newValue)) return
      useAppStore.setState({ theme: event.newValue })
    }
    window.addEventListener('storage', syncTheme)
    return () => window.removeEventListener('storage', syncTheme)
  }, [])

  // 追踪上一次健康状态，仅在「健康↔断开」翻转时弹 Toast，避免轮询刷屏
  const prevHealthyRef = useRef<boolean | null>(null)
  const checkHealth = useCallback(async () => {
    try {
      const resp = await api.getHealth()
      setHealth(resp)
      setHealthError('')
      if (prevHealthyRef.current === false) {
        useAppStore.getState().pushToast('后端已重新连接', 'success')
      }
      prevHealthyRef.current = true
    } catch (e) {
      setHealth(null)
      setHealthError(
        e instanceof ApiError ? e.message : (e as Error).message || '未知错误',
      )
      if (prevHealthyRef.current === true) {
        useAppStore.getState().pushToast(
          '后端连接已断开，流式功能将降级',
          'warning',
        )
      }
      prevHealthyRef.current = false
    }
  }, [])

  // 启动时：首次加载当前模式图谱列表 + 健康检查轮询 + LLM 配置
  useEffect(() => {
    void loadGraphs()
    void checkHealth()
    void loadLlmConfig()
    const timer = setInterval(() => void checkHealth(), 5000)
    return () => clearInterval(timer)
  }, [loadGraphs, checkHealth, loadLlmConfig])

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
            case 'chat_thinking':
              store.handleChatThinking(event)
              break
            case 'chat_content_replace':
              store.handleChatContentReplace(event)
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
    <div className="app-shell" data-mode={mode} data-theme={theme}>
      {!onboardingVisible && <a className="skip-link" href="#main-content">跳到主要内容</a>}
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
            role="status"
            title={
              isHealthy
                ? `后端正常（${health!.version}）`
                : `后端未连接：${healthError}`
            }
          >
            <span className="health-badge__dot" />
            {isHealthy ? `后端 ${health!.version}` : '后端未连接'}
          </span>
          <button
            type="button"
            className="app-header__btn"
            onClick={() => setImportModalOpen(true)}
            title="手动导入平台导出的对话文件"
          >
            导入对话
          </button>
          {importJob?.status === 'running' && (
            <button
              type="button"
              className="app-header__import-progress"
              onClick={() => setImportModalOpen(true)}
              title="查看导入进度"
            >
              <span className="app-header__import-progress-spinner" />
              导入中 {importJob.done}/{importJob.total}
            </button>
          )}
          <ModeSwitch />
        </div>
      </header>

      {llmNotReady && (
        <div className="llm-warning-bar" role="status">
          <span className="llm-warning-bar__icon" aria-hidden="true">⚠</span>
          <span className="llm-warning-bar__text">
            LLM 未配置，AI 功能（节点抽取 / 延伸 / 报告 / 测验）将走降级路径或不可用。
          </span>
          <button
            type="button"
            className="llm-warning-bar__btn"
            onClick={() => setActiveNav('settings')}
          >
            前往配置 →
          </button>
        </div>
      )}

      <div className="app-body">
        {/* 最左侧竖排导航条：对话 / 图谱 / 设置 */}
        <SideNav />

        {/* 模式滑动容器：用 View Transitions API 实现横向"推出"过渡。
            .mode-slide-wrap 上挂 view-transition-name=mode-slide，
            ModeSwitch 中 startViewTransition 捕获新旧快照，
            CSS ::view-transition-old/new 分别播放滑出/滑入动画。
            SideNav 不在此容器内，保持固定不参与滑动。 */}
        <LayoutGroup>
        <div className="mode-slide-wrap" id="main-content" tabIndex={-1}>
          {/* 主内容区：按 activeNav 切换 */}
          <AnimatePresence mode="wait" initial={false} custom={navDirection}>
          {activeNav === 'chat' ? (
            <motion.main
              key="chat"
              custom={navDirection}
              className="content-area content-area--chat nav-view"
              initial={{ opacity: 0, x: navDirection * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: navDirection * -12 }}
            >
              <ChatPanel />
            </motion.main>
          ) : activeNav === 'settings' ? (
            <motion.main
              key="settings"
              custom={navDirection}
              className="content-area content-area--settings nav-view"
              initial={{ opacity: 0, x: navDirection * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: navDirection * -12 }}
            >
              <SettingsPanel />
            </motion.main>
          ) : (
            <motion.div
              key="graph"
              custom={navDirection}
              className="nav-view nav-view--graph"
              initial={{ opacity: 0, x: navDirection * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: navDirection * -12 }}
            >
              <GraphList />
              <main className="content-area">
              {error && (
                <div className="error-bar" role="alert">
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
                  <div className="content-stage" data-active-view={view}>
                    <div
                      className={`content-stage__view${view === 'graph' ? ' is-active' : ''}`}
                      aria-hidden={view !== 'graph'}
                    >
                      <GraphView ref={graphViewRef} />
                    </div>
                    <div
                      className={`content-stage__view${view === 'card' ? ' is-active' : ''}`}
                      aria-hidden={view !== 'card'}
                    >
                      <CardView />
                    </div>
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
          </motion.div>
          )}
          </AnimatePresence>
        </div>
        <ChatExpandedOverlay graphViewRef={graphViewRef} />
        </LayoutGroup>
      </div>

      {/* 全局 Toast（成功 / 警告 / 错误提示） */}
      <Toast />

      {/* 首次启动全屏引导向导 */}
      {onboardingVisible && (
        <OnboardingWizard onFinish={() => setOnboardingVisible(false)} />
      )}

      {/* 手动导入对话弹窗 */}
      {importModalOpen && (
        <ImportConversationsModal onClose={() => setImportModalOpen(false)} />
      )}
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

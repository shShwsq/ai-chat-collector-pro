/**
 * 对话面板（Task 9 / Task 10 重构：多轮对话版）。
 *
 * 设计要点：
 * - **统一多轮对话**：Study / Work 模式都调用 ``store.sendMessage`` 触发后端
 *   ``POST /api/chat/sessions/{id}/stream``，复用同一份 ``chatMessages`` 状态。
 *   区别仅在于：Work 模式在 header 提供 Plan/Build 切换按钮；Study 模式无。
 * - **首页瀑布流占位**：无消息时渲染 ``<ChatHome mode={mode} onAsk={handleAsk} />``
 *   作为视觉占位；首条消息发出后切换到对话视图。Study 模式同样支持多轮
 *   （之前只有瀑布流首页，Task 10 新增对话能力）。
 * - **工具调用过程展示**：assistant 消息的 ``tool_calls`` 数组渲染为
 *   ``ChatToolCallItem`` 列表，pending 时显示「正在查询图谱节点…」状态，
 *   done 后折叠为简短结果摘要。
 * - **Plan/Build 切换**：Work 模式 header 右侧的 ``PlanBuildToggle`` 按钮，
 *   调 ``store.setPlanMode`` 切换；Plan 模式下高风险工具会被后端直接拒绝。
 * - **高风险确认对话框**：当 ``store.pendingToolConfirmation`` 非 null 时
 *   渲染 ``ToolConfirmDialog`` 浮层，用户同意/拒绝后调对应 store 动作。
 * - **流式取消**：流式进行中显示「取消」按钮，调 ``store.cancelChat``。
 *
 * 旧版基于 ``qaMessages`` / ``askWorkQuestionStream`` 的逻辑已废弃，由
 * 新的 ``chatMessages`` / ``sendMessage`` 替代，但保留 ``qaMessages`` 用于
 * QAPanel 浮层（右侧抽屉式问答，Task 16）的旧路径，不删除以维持兼容。
 */

import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { ChatMessage, ToolCall } from '../lib/types'
import { ChatHome } from './ChatHome'
import { ToolConfirmDialog } from './ToolConfirmDialog'

export function ChatPanel() {
  const mode = useAppStore((s) => s.mode)
  const chatMessages = useAppStore((s) => s.chatMessages)
  const chatAsking = useAppStore((s) => s.chatAsking)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const pendingToolConfirmation = useAppStore((s) => s.pendingToolConfirmation)

  const handleAsk = (q: string) => {
    if (chatAsking) return
    if (!q.trim()) return
    void sendMessage(q)
  }

  return (
    <div className="chat-panel chat-panel--multi">
      {/* 高风险确认对话框：pendingToolConfirmation 非 null 时浮层显示 */}
      {pendingToolConfirmation && (
        <ToolConfirmDialog confirmation={pendingToolConfirmation} />
      )}

      {/* 无消息：渲染 ChatHome 首页瀑布流作为占位 */}
      {chatMessages.length === 0 ? (
        <ChatHome mode={mode} onAsk={handleAsk} />
      ) : (
        <ChatConversationView />
      )}
    </div>
  )
}

// ============================================================================
// 对话视图（消息列表 + 底部输入框 + header 工具栏）
// ============================================================================

function ChatConversationView() {
  const mode = useAppStore((s) => s.mode)
  const chatMessages = useAppStore((s) => s.chatMessages)
  const chatAsking = useAppStore((s) => s.chatAsking)
  const chatStreamingActive = useAppStore((s) => s.chatStreamingActive)
  const currentChatSession = useAppStore((s) => s.currentChatSession)
  const clearChat = useAppStore((s) => s.clearChat)
  const cancelChat = useAppStore((s) => s.cancelChat)
  const planMode = useAppStore((s) => s.planMode)
  const setPlanMode = useAppStore((s) => s.setPlanMode)
  const sendMessage = useAppStore((s) => s.sendMessage)

  const [input, setInput] = useState('')
  // 消息列表底部锚点，用于自动滚动
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 新消息或流式 token 累积时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages, chatAsking, chatStreamingActive])

  const handleSend = async () => {
    if (chatAsking) return
    const q = input.trim()
    if (!q) return
    setInput('')
    await sendMessage(q)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const modeLabel = mode === 'study' ? '学习' : '工作'
  const sessionTitle = currentChatSession?.title ?? `${modeLabel}对话`

  return (
    <div className="chat-panel__conv">
      <header className="chat-panel__header">
        <div className="chat-panel__title-row">
          <h2 className="chat-panel__title">{sessionTitle}</h2>
          <div className="chat-panel__actions">
            {/* Work 模式独有：Plan/Build 切换按钮 */}
            {mode === 'work' && (
              <PlanBuildToggle
                planMode={planMode}
                onToggle={() => setPlanMode(!planMode)}
                disabled={chatAsking}
              />
            )}
            {/* 流式进行中：显示取消按钮 */}
            {chatStreamingActive ? (
              <button
                type="button"
                className="chat-panel__cancel-btn"
                onClick={cancelChat}
                title="取消当前流式生成"
              >
                取消
              </button>
            ) : null}
            {/* 返回首页：清空当前会话选择回到瀑布流首页 */}
            <button
              type="button"
              className="chat-panel__back-btn"
              onClick={clearChat}
              disabled={chatAsking}
              title="清空当前选择并返回首页"
            >
              返回首页
            </button>
          </div>
        </div>
        <p className="chat-panel__subtitle">
          {mode === 'study'
            ? '与学习助手多轮对话，可触发测验 / 节点查询 / 抽取等能力。'
            : planMode
              ? 'Plan 模式：只读分析，高风险操作将被拒绝。'
              : 'Build 模式：可与图谱交互，高风险操作需确认。'}
        </p>
      </header>

      {/* 消息区（可滚动） */}
      <div className="chat-panel__messages">
        <ul className="chat-panel__message-list">
          {chatMessages.map((m, i) => (
            <ChatMessageItem
              key={m.id ?? i}
              message={m}
              streaming={
                chatStreamingActive &&
                i === chatMessages.length - 1 &&
                m.role === 'assistant'
              }
            />
          ))}
        </ul>
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入区 */}
      <footer className="chat-panel__input-footer">
        <textarea
          className="chat-panel__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入你的问题，回车发送，Shift+Enter 换行…"
          rows={2}
          disabled={chatAsking}
        />
        <button
          type="button"
          className="chat-panel__send-btn"
          onClick={handleSend}
          disabled={chatAsking || !input.trim()}
          title={
            !input.trim() ? '请输入问题' : '发送提问（Enter）'
          }
        >
          {chatAsking ? '回答中…' : '提问'}
        </button>
      </footer>
    </div>
  )
}

// ============================================================================
// Plan / Build 模式切换按钮（Work 模式独有）
// ============================================================================

interface PlanBuildToggleProps {
  planMode: boolean
  onToggle: () => void
  disabled?: boolean
}

function PlanBuildToggle({ planMode, onToggle, disabled }: PlanBuildToggleProps) {
  return (
    <button
      type="button"
      className={`plan-build-toggle${
        planMode ? ' plan-build-toggle--plan' : ' plan-build-toggle--build'
      }`}
      onClick={onToggle}
      disabled={disabled}
      title={
        planMode
          ? '当前 Plan 模式（只读），点击切到 Build（可写）'
          : '当前 Build 模式（可写），点击切到 Plan（只读）'
      }
      aria-pressed={planMode}
    >
      <span className="plan-build-toggle__label plan-build-toggle__label--build">
        Build
      </span>
      <span className="plan-build-toggle__label plan-build-toggle__label--plan">
        Plan
      </span>
    </button>
  )
}

// ============================================================================
// 单条消息子组件
// ============================================================================

interface ChatMessageItemProps {
  message: ChatMessage
  /** 是否为流式进行中的最后一条 assistant 占位消息。 */
  streaming?: boolean
}

function ChatMessageItem({ message, streaming }: ChatMessageItemProps) {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <li className="chat-msg chat-msg--user">
        <div className="chat-msg__bubble chat-msg__bubble--user">
          {message.content}
        </div>
      </li>
    )
  }

  // assistant 消息
  // 流式占位态：content 为空且处于流式中，显示三点打字动画
  const isStreamingPlaceholder = streaming && !message.content
  const toolCalls = message.tool_calls ?? []

  return (
    <li className="chat-msg chat-msg--assistant">
      <div
        className={`chat-msg__bubble chat-msg__bubble--assistant${
          isStreamingPlaceholder ? ' chat-msg__bubble--loading' : ''
        }`}
      >
        {/* 工具调用过程展示（先于正文渲染，让用户感知 agent 在做什么） */}
        {toolCalls.length > 0 && (
          <div className="chat-msg__tool-calls">
            {toolCalls.map((tc, i) => (
              <ChatToolCallItem key={tc.id ?? i} toolCall={tc} />
            ))}
          </div>
        )}

        {/* 回答正文（流式 token 实时累积） */}
        {isStreamingPlaceholder ? (
          <span className="chat-typing" aria-label="Agent 正在生成回答">
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
          </span>
        ) : (
          <p className="chat-msg__text">
            {message.content}
            {streaming && message.content && (
              <span className="chat-streaming-cursor" aria-hidden="true">
                ▋
              </span>
            )}
          </p>
        )}
      </div>
    </li>
  )
}

// ============================================================================
// 工具调用过程展示子组件
// ============================================================================

/** 工具名 → 中文友好动作描述。 */
const TOOL_ACTION_LABEL: Record<string, string> = {
  graph_query_nodes: '查询图谱节点',
  graph_get_node_detail: '获取节点详情',
  graph_get_context: '获取图谱上下文',
  graph_extract_from_observation: '从观察抽取节点',
  graph_generate_quiz: '生成测验题',
  graph_generate_trends: '生成风口推荐',
  graph_generate_report: '生成工作报告',
}

/** 工具结果简短摘要（取关键字段，避免长 JSON 干扰对话流）。 */
function summarizeToolResult(
  tool: string,
  result: Record<string, unknown> | undefined,
): string {
  if (!result) return ''
  // 各工具 result 字段不同，提取关键字段
  if (tool === 'graph_query_nodes') {
    const nodes = (result as { nodes?: unknown[] }).nodes
    if (Array.isArray(nodes)) return `命中 ${nodes.length} 个节点`
  }
  if (tool === 'graph_get_node_detail') {
    const title = (result as { title?: string }).title
    if (title) return `「${title}」`
  }
  if (tool === 'graph_get_context') {
    const nodeCount = (result as { node_count?: number }).node_count
    if (typeof nodeCount === 'number') return `共 ${nodeCount} 个节点`
  }
  if (tool === 'graph_extract_from_observation') {
    const created = (result as { created?: unknown[] }).created
    if (Array.isArray(created)) return `新建 ${created.length} 个节点`
  }
  if (tool === 'graph_generate_quiz') {
    const type = (result as { type?: string }).type
    if (type) return `已生成 ${type} 题`
  }
  if (tool === 'graph_generate_trends') {
    const trends = (result as { trends?: unknown[] }).trends
    if (Array.isArray(trends)) return `生成 ${trends.length} 条风口`
  }
  if (tool === 'graph_generate_report') {
    const period = (result as { period?: string }).period
    if (period) return `${period} 报告已生成`
  }
  // 兜底：取前 80 字符
  const s = JSON.stringify(result)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

interface ChatToolCallItemProps {
  toolCall: ToolCall
}

function ChatToolCallItem({ toolCall }: ChatToolCallItemProps) {
  const { tool, status, result } = toolCall
  const label = TOOL_ACTION_LABEL[tool] ?? tool
  const resultSummary = summarizeToolResult(tool, result)

  return (
    <div
      className={`chat-tool-call chat-tool-call--${status}`}
      title={`工具：${tool}\n状态：${status}`}
    >
      <span className="chat-tool-call__icon" aria-hidden="true">
        {status === 'pending' ? '⏳' : status === 'error' ? '⚠' : '✓'}
      </span>
      <span className="chat-tool-call__label">{label}</span>
      {status === 'pending' && (
        <span className="chat-tool-call__status chat-tool-call__status--pending">
          正在执行…
        </span>
      )}
      {status === 'done' && resultSummary && (
        <span className="chat-tool-call__status chat-tool-call__status--done">
          {resultSummary}
        </span>
      )}
      {status === 'error' && (
        <span className="chat-tool-call__status chat-tool-call__status--error">
          失败
        </span>
      )}
    </div>
  )
}

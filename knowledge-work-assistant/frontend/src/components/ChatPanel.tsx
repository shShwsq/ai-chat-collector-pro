/**
 * 对话面板（左侧导航「对话」激活时显示，流式输出版）。
 *
 * 按当前模式分支：
 * - **Work 模式**：
 *   - 无消息时渲染 ``<ChatHome mode="work" onAsk={handleAsk} />`` 首页瀑布流；
 *   - 有消息时切换到对话视图（消息列表 + 底部输入框），header 提供「返回首页」
 *     按钮，点击 ``clearQaMessages()`` 清空消息回到首页瀑布流。
 *   - ``handleAsk`` 调用 ``store.askWorkQuestionStream(q)``：立即把 user 消息
 *     + 空 assistant 占位消息追加到 qaMessages，后端通过 WebSocket 流式推送
 *     token，store.handleGraphAgentToken 实时更新占位消息 content，本组件
 *     订阅 qaMessages / qaStreamingText 即可获得打字机效果。
 *     无 sessionId 时 store 内部自动回退到非流式 askWorkQuestion。
 * - **Study 模式**：渲染 ``<ChatHome mode="study" />``，输入框用作标题过滤
 *   （ChatHome 内部实现，无需传 onAsk）。
 *
 * 设计要点：
 * - 复用 store 中已有的 qaMessages / askWorkQuestionStream / clearQaMessages，
 *   不引入新状态；右侧 QAPanel 浮层与本面板共享同一份对话历史，
 *   任意一处的输入与回答都会同步显示。
 * - 消息列表自动滚动到底部（新消息 / token 累积时）。
 * - 提问进行中（qaAsking=true）禁用输入框与按钮；流式占位消息显示三点动画。
 */

import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { QaMessage } from '../store/useAppStore'
import type { AskSource } from '../lib/types'
import { ChatHome } from './ChatHome'

/** 置信度对应等级与颜色类名。 */
function confidenceMeta(c: number): { label: string; cls: string } {
  if (c >= 0.7) return { label: '高置信', cls: 'is-high' }
  if (c >= 0.4) return { label: '中置信', cls: 'is-mid' }
  return { label: '低置信', cls: 'is-low' }
}

/** 来源相关度对应文案。 */
function sourceRelevanceLabel(r: AskSource['relevance']): string {
  if (r === 'high') return '高相关'
  if (r === 'medium') return '中相关'
  return '低相关'
}

export function ChatPanel() {
  const mode = useAppStore((s) => s.mode)

  // Study 模式：渲染 ChatHome 首页瀑布流，输入框用作标题过滤（ChatHome 内部实现）
  if (mode === 'study') {
    return <ChatHome mode="study" />
  }

  // Work 模式：无消息时显示首页瀑布流，有消息时切换到对话视图
  return <WorkChatInner />
}

/** Work 模式对话内嵌实现：复用 store 的 qaMessages / askWorkQuestionStream。 */
function WorkChatInner() {
  const qaMessages = useAppStore((s) => s.qaMessages)
  const qaAsking = useAppStore((s) => s.qaAsking)
  const qaStreamingActive = useAppStore((s) => s.qaStreamingActive)
  const qaStreamingText = useAppStore((s) => s.qaStreamingText)
  const askWorkQuestionStream = useAppStore((s) => s.askWorkQuestionStream)
  const clearQaMessages = useAppStore((s) => s.clearQaMessages)
  const currentGraphId = useAppStore((s) => s.currentGraphId)

  const [input, setInput] = useState('')
  // 消息列表底部锚点，用于自动滚动
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 新消息或流式 token 累积时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [qaMessages, qaAsking, qaStreamingActive, qaStreamingText])

  // 首页瀑布流输入框回车提交：ChatHome 内部回车后回调
  // askWorkQuestionStream 会立即追加 user + assistant 占位消息，
  // qaMessages 长度变化触发重渲染切到对话视图
  const handleAsk = (q: string) => {
    if (qaAsking) return
    if (!q.trim()) return
    void askWorkQuestionStream(q)
  }

  // 对话视图底部输入框提交
  const handleSend = async () => {
    if (qaAsking) return
    const q = input.trim()
    if (!q) return
    setInput('')
    await askWorkQuestionStream(q)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 提交，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // 无消息：渲染 ChatHome 首页瀑布流（ChatHome 自带 padding，不再包裹 chat-panel--work）
  if (qaMessages.length === 0) {
    return <ChatHome mode="work" onAsk={handleAsk} />
  }

  // 有消息：渲染对话视图（消息列表 + 底部输入框）
  return (
    <div className="chat-panel chat-panel--work">
      <header className="chat-panel__header">
        <div className="chat-panel__title-row">
          <h2 className="chat-panel__title">工作对话</h2>
          <div className="chat-panel__actions">
            {/* 返回首页：清空消息回到瀑布流首页 */}
            <button
              type="button"
              className="chat-panel__back-btn"
              onClick={clearQaMessages}
              disabled={qaAsking}
              title="清空对话并返回首页"
            >
              返回首页
            </button>
            {/* 清空：仅清空对话历史，仍停留在对话视图（无消息后自动回到首页） */}
            <button
              type="button"
              className="chat-panel__clear-btn"
              onClick={clearQaMessages}
              disabled={qaAsking}
              title="清空对话历史"
            >
              清空
            </button>
          </div>
        </div>
        <p className="chat-panel__subtitle">
          基于当前 work 图谱上下文流式回答你的问题，标注信息来源与置信度。
        </p>
      </header>

      {/* 消息区（可滚动） */}
      <div className="chat-panel__messages">
        <ul className="chat-panel__message-list">
          {qaMessages.map((m, i) => (
            <ChatMessageItem
              key={i}
              message={m}
              // 标记最后一条 assistant 消息是否处于流式占位态
              streaming={
                qaStreamingActive &&
                i === qaMessages.length - 1 &&
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
          placeholder={
            currentGraphId
              ? '输入你的问题，回车发送，Shift+Enter 换行…'
              : '请先在「图谱」视图选中一个 work 图谱'
          }
          rows={2}
          disabled={qaAsking || !currentGraphId}
        />
        <button
          type="button"
          className="chat-panel__send-btn"
          onClick={handleSend}
          disabled={qaAsking || !input.trim() || !currentGraphId}
          title={
            !currentGraphId
              ? '请先在「图谱」视图选中一个 work 图谱'
              : !input.trim()
                ? '请输入问题'
                : '发送提问（Enter）'
          }
        >
          {qaAsking ? '回答中…' : '提问'}
        </button>
      </footer>
    </div>
  )
}

// ============================================================================
// 单条消息子组件
// ============================================================================

interface ChatMessageItemProps {
  message: QaMessage
  /** 是否为流式进行中的最后一条 assistant 占位消息（content 为空时显示打字机）。 */
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
  const confidence = message.confidence ?? 0
  const meta = confidenceMeta(confidence)
  // 流式占位态：content 为空且处于流式中，显示三点打字动画
  const isStreamingPlaceholder = streaming && !message.content

  return (
    <li className="chat-msg chat-msg--assistant">
      <div
        className={`chat-msg__bubble chat-msg__bubble--assistant${
          isStreamingPlaceholder ? ' chat-msg__bubble--loading' : ''
        }`}
      >
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
            {/* 流式进行中且已有内容：末尾闪烁光标 */}
            {streaming && message.content && (
              <span className="chat-streaming-cursor" aria-hidden="true">▋</span>
            )}
          </p>
        )}

        {/* 降级提示 */}
        {message.degraded && (
          <div className="chat-msg__degraded" role="status">
            <strong>降级提示：</strong>
            {message.degradeReason || 'AI 服务不可用，已返回兜底回答。'}
          </div>
        )}

        {/* 置信度 + 来源（流式完成后再展示，避免占位阶段闪烁） */}
        {!streaming && (message.sources?.length || !message.degraded) && (
          <div className="chat-msg__meta">
            {!message.degraded && (
              <span
                className={`chat-confidence ${meta.cls}`}
                title={`置信度 ${Math.round(confidence * 100)}%`}
              >
                {meta.label} · {Math.round(confidence * 100)}%
              </span>
            )}
            {message.sources && message.sources.length > 0 && (
              <div className="chat-sources">
                <span className="chat-sources__label">来源：</span>
                <ul className="chat-sources__list">
                  {message.sources.map((s, si) => (
                    <li key={si} className="chat-source" title={s.node_title}>
                      <span className="chat-source__title">{s.node_title}</span>
                      <span className="chat-source__relevance">
                        {sourceRelevanceLabel(s.relevance)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

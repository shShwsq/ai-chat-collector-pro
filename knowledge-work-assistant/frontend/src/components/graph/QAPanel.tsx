/**
 * Work 用户提问面板（Task 16）。
 *
 * 从内容区右侧滑入的浮层，承载对话式提问与上下文回答：
 *
 *   ① **对话式提问**：用户在底部输入框输入问题，点「提问」或回车
 *      调 ``store.askWorkQuestion(question)`` → Agent 基于当前 work 图谱
 *      上下文回答，返回 ``{answer, sources, confidence, degraded}``。
 *
 *   ② **回答展示**：每条回答以气泡形式展示，附带：
 *      - 置信度徽标（高/中/低，色阶区分）
 *      - 来源引用列表（标注答案基于哪些图谱节点）
 *      - 降级提示（AI 服务不可用时显示橙色提示条）
 *
 *   ③ **会话历史**：qaMessages 按时间正序累积，支持多轮对话上下文
 *      （当前实现每次提问独立调用后端，历史仅前端展示）。
 *
 * 数据流：
 * - 用户提问后立即把 user 消息追加到 qaMessages，避免等待感；
 *   Agent 返回后追加 assistant 消息。
 * - 失败时追加一条带 degraded 标记的占位 assistant 消息，便于用户感知。
 *
 * 交互：
 * - 面板由 ``store.workActivePanel === 'qa'`` 控制显隐。
 * - 提问进行中显示加载态并禁用输入框与按钮。
 * - 消息列表自动滚动到底部（新消息出现时）。
 * - 可清空对话历史重新开始。
 */

import { useEffect, useRef, useState } from 'react'

import { Icon } from '../Icon'
import { useAppStore } from '../../store/useAppStore'
import type { QaMessage } from '../../store/useAppStore'
import type { AskSource } from '../../lib/types'

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

export function QAPanel() {
  const open = useAppStore((s) => s.workActivePanel === 'qa')
  const setWorkPanel = useAppStore((s) => s.setWorkPanel)
  const qaMessages = useAppStore((s) => s.qaMessages)
  const qaAsking = useAppStore((s) => s.qaAsking)
  const askWorkQuestion = useAppStore((s) => s.askWorkQuestion)
  const clearQaMessages = useAppStore((s) => s.clearQaMessages)
  const currentGraphId = useAppStore((s) => s.currentGraphId)

  const [input, setInput] = useState('')
  // 消息列表底部锚点，用于自动滚动
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 新消息出现时自动滚动到底部
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [qaMessages, open, qaAsking])

  if (!open) return null

  const handleClose = () => setWorkPanel('none')

  const handleAsk = async () => {
    if (qaAsking) return
    const q = input.trim()
    if (!q) return
    setInput('')
    await askWorkQuestion(q)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 提交，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleAsk()
    }
  }

  const handleClear = () => {
    clearQaMessages()
  }

  return (
    <>
      {/* 遮罩：点击关闭面板 */}
      <div
        className="work-panel-overlay"
        onClick={handleClose}
        aria-hidden="true"
      />

      <aside
        className="work-panel qa-panel"
        role="dialog"
        aria-label="Work 用户提问"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="work-panel__header">
          <div className="work-panel__title-row">
            <h2 className="work-panel__title">工作提问</h2>
            <div className="qa-header__actions">
              {qaMessages.length > 0 && (
                <button
                  type="button"
                  className="qa-clear-btn"
                  onClick={handleClear}
                  disabled={qaAsking}
                  title="清空对话历史"
                >
                  清空
                </button>
              )}
              <button
                type="button"
                className="work-panel__close"
                onClick={handleClose}
                aria-label="关闭面板"
                title="关闭"
              >
                ×
              </button>
            </div>
          </div>
          <p className="work-panel__subtitle">
            基于当前 work 图谱上下文回答你的问题，标注信息来源与置信度。
          </p>
        </header>

        {/* 消息区（可滚动） */}
        <div className="qa-messages">
          {qaMessages.length === 0 ? (
            <div className="work-empty qa-empty">
              {currentGraphId
                ? '暂无对话。在下方输入框提问，Agent 会基于图谱上下文回答。'
                : (<><Icon name="warning" size={16} /> 请先在左侧选中一个 work 图谱</>)}
            </div>
          ) : (
            <ul className="qa-message-list">
              {qaMessages.map((m, i) => (
                <QaMessageItem key={i} message={m} />
              ))}
              {/* 提问中加载态 */}
              {qaAsking && (
                <li className="qa-message qa-message--assistant">
                  <div className="qa-message__bubble qa-message__bubble--assistant qa-message__bubble--loading">
                    <span className="qa-typing">
                      <span className="qa-typing__dot" />
                      <span className="qa-typing__dot" />
                      <span className="qa-typing__dot" />
                    </span>
                    Agent 正在思考…
                  </div>
                </li>
              )}
            </ul>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 底部输入区 */}
        <footer className="qa-input-footer">
          <textarea
            className="qa-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              currentGraphId
                ? '输入你的问题，回车发送，Shift+Enter 换行…'
                : '请先选中一个 work 图谱'
            }
            rows={2}
            disabled={qaAsking || !currentGraphId}
          />
          <button
            type="button"
            className="work-actions__btn work-actions__btn--primary qa-send-btn"
            onClick={handleAsk}
            disabled={qaAsking || !input.trim() || !currentGraphId}
            title={
              !currentGraphId
                ? '请先选中一个 work 图谱'
                : !input.trim()
                  ? '请输入问题'
                  : '发送提问（Enter）'
            }
          >
            {qaAsking ? '回答中…' : '提问'}
          </button>
        </footer>
      </aside>
    </>
  )
}

// ============================================================================
// 单条消息子组件
// ============================================================================

function QaMessageItem({ message }: { message: QaMessage }) {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <li className="qa-message qa-message--user">
        <div className="qa-message__bubble qa-message__bubble--user">
          {message.content}
        </div>
      </li>
    )
  }

  // assistant 消息
  const confidence = message.confidence ?? 0
  const meta = confidenceMeta(confidence)
  return (
    <li className="qa-message qa-message--assistant">
      <div className="qa-message__bubble qa-message__bubble--assistant">
        {/* 回答正文 */}
        <p className="qa-answer-text">{message.content}</p>

        {/* 降级提示 */}
        {message.degraded && (
          <div className="qa-degraded-tip" role="status">
            <strong>降级提示：</strong>
            {message.degradeReason || 'AI 服务不可用，已返回兜底回答。'}
          </div>
        )}

        {/* 置信度 + 来源 */}
        {(message.sources?.length || !message.degraded) && (
          <div className="qa-answer-meta">
            {!message.degraded && (
              <span
                className={`qa-confidence ${meta.cls}`}
                title={`置信度 ${Math.round(confidence * 100)}%`}
              >
                {meta.label} · {Math.round(confidence * 100)}%
              </span>
            )}
            {message.sources && message.sources.length > 0 && (
              <div className="qa-sources">
                <span className="qa-sources__label">来源：</span>
                <ul className="qa-sources__list">
                  {message.sources.map((s, si) => (
                    <li key={si} className="qa-source" title={s.node_title}>
                      <span className="qa-source__title">{s.node_title}</span>
                      <span className="qa-source__relevance">
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

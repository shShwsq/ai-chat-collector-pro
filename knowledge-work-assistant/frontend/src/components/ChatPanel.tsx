/**
 * 对话面板（Task 9 / Task 10 重构 + 本土化适配）。
 *
 * 设计要点：
 * - **三栏布局**：左侧会话列表（240px，常驻）/ 中间消息区 / 底部输入区。
 *   会话列表常驻显示，无消息时（ChatHome 瀑布流）也能看到并切换历史会话，
 *   解决「必须进入对话才能看到历史列表」的路径过深问题。
 * - **统一多轮对话**：Study / Work 模式都调用 ``store.sendMessage`` 触发后端
 *   ``POST /api/chat/sessions/{id}/stream``，复用同一份 ``chatMessages`` 状态。
 * - **首页瀑布流占位**：无消息时主区渲染 ``<ChatHome mode={mode} onAsk={handleAsk} />``，
 *   与左侧历史栏并排展示。
 * - **工具调用过程展示**：assistant 消息的 ``tool_calls`` 渲染为
 *   ``ChatToolCallItem`` 列表，pending 时显示「正在查询…」状态，
 *   done 后折叠为简短结果摘要。
 * - **思维链独立折叠**：assistant 消息的 ``thinking`` 字段在气泡上方折叠展示，
 *   不混入正文；点击「思考过程」展开/收起。
 * - **Plan/Go 切换**：底部输入框右下角发送按钮旁的 ``PlanGoToggle`` 按钮，
 *   Work 模式下显示；Build 前端改名为「Go」（更友好）。
 * - **高风险确认对话框**：当 ``store.pendingToolConfirmation`` 非 null 时
 *   渲染 ``ToolConfirmDialog`` 浮层。
 * - **流式取消**：流式进行中显示「取消」按钮，调 ``store.cancelChat``。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useAppStore } from '../store/useAppStore'
import { useAutoGrowTextarea } from '../hooks/useAutoGrowTextarea'
import { formatShortTime } from '../lib/date'
import { renderMarkdown } from '../lib/markdown'
import type {
  ChatMessage,
  ChatSearchHit,
  ChatSession,
  ToolCall,
} from '../lib/types'
import { ChatHome } from './ChatHome'
import { ConfirmDialog } from './graph/ConfirmDialog'
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
      {pendingToolConfirmation && (
        <ToolConfirmDialog confirmation={pendingToolConfirmation} />
      )}

      <div className="chat-panel__conv">
        {/* 左侧会话列表侧边栏（常驻：无消息时也可见，便于切换历史会话） */}
        <ChatSessionSidebar />

        {/* 右侧主区：无消息时渲染瀑布流首页，有消息时渲染对话视图 */}
        <div className="chat-panel__main">
          {chatMessages.length === 0 ? (
            <ChatHome mode={mode} onAsk={handleAsk} />
          ) : (
            <ChatConversationView />
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// 对话视图：消息列表 + 底部输入区（会话列表已上移到 ChatPanel 顶层常驻）
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
  const highlightedMessageId = useAppStore((s) => s.highlightedMessageId)
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId)

  const [input, setInput] = useState('')
  const [showLatest, setShowLatest] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  /** textarea 自适应撑高（与首页输入框行为一致） */
  const textareaRef = useAutoGrowTextarea<HTMLTextAreaElement>(input, {
    maxHeight: 120,
  })

  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 96
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      setShowLatest(false)
    } else {
      setShowLatest(true)
    }
  }, [chatMessages, chatAsking, chatStreamingActive])

  /**
   * 搜索结果点击后的高亮定位：当 highlightedMessageId 设置且消息已渲染时，
   * 滚动到该消息并触发 CSS 高亮动画，约 2s 后清除状态。
   * 依赖 chatMessages 是因为切换会话后消息需先加载完成才能定位。
   */
  useEffect(() => {
    if (!highlightedMessageId) return
    if (chatMessages.length === 0) return
    // 等下一帧确保 DOM 已渲染
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(highlightedMessageId)}"]`,
      )
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // 触发动画：通过添加再移除 class 实现重播
        el.classList.remove('chat-msg--search-highlight')
        // 强制 reflow 让重播生效
        void el.offsetWidth
        el.classList.add('chat-msg--search-highlight')
      }
      // 清除状态，避免后续重复滚动
      setHighlightedMessageId(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [highlightedMessageId, chatMessages, setHighlightedMessageId])

  const handleMessagesScroll = () => {
    const container = messagesRef.current
    if (!container) return
    setShowLatest(container.scrollHeight - container.scrollTop - container.clientHeight >= 96)
  }

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
    <>
      <header className="chat-panel__header">
        <div className="chat-panel__title-row">
          <h2 className="chat-panel__title">{sessionTitle}</h2>
          <div className="chat-panel__actions">
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
              : 'Go 模式：可与图谱交互，高风险操作需确认。'}
        </p>
      </header>

      <div
        className="chat-panel__messages"
        ref={messagesRef}
        onScroll={handleMessagesScroll}
        aria-label="对话消息"
      >
        <ul className="chat-panel__message-list">
          <AnimatePresence initial={false}>
            {chatMessages
              // 过滤掉测验作答指令消息：作答交互与反馈已由 QuizCard 承载，
              // [quiz_answer] 是前端与智能体的内部协议，无需在对话流中展示
              .filter((m) => !isQuizAnswerMessage(m.content))
              .map((m, i) => (
              <ChatMessageItem
                key={m.id ?? `${m.role}-${i}`}
                message={m}
                streaming={
                  chatStreamingActive &&
                  i === chatMessages.length - 1 &&
                  m.role === 'assistant'
                }
              />
            ))}
          </AnimatePresence>
        </ul>
        <div ref={messagesEndRef} />
        {showLatest && (
          <button
            type="button"
            className="chat-panel__latest-btn"
            onClick={() => {
              messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
              setShowLatest(false)
            }}
          >
            回到最新消息
          </button>
        )}
      </div>

      {/* 底部输入区：长方形输入框 + 左下角+按钮 + 右下角发送 + Plan/Go 切换 */}
      <footer className="chat-input-bar">
        <div className="chat-input-bar__inner">
          <textarea
            ref={textareaRef}
            className="chat-input-bar__textarea"
            value={input}
            name="chat-question"
            aria-label="输入对话问题"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === 'study'
                ? '向学习助手提问，回车发送，Shift+Enter 换行…'
                : '向工作助手提问，回车发送，Shift+Enter 换行…'
            }
            rows={1}
            disabled={chatAsking}
          />
          <div className="chat-input-bar__toolbar">
            <div className="chat-input-bar__left-actions">
              {mode === 'work' && (
                <PlanGoToggle
                  planMode={planMode}
                  onToggle={() => setPlanMode(!planMode)}
                  disabled={chatAsking}
                />
              )}
            </div>
          </div>
          {/* 右下角发送按钮（悬浮在输入框内） */}
          <button
            type="button"
            className="chat-input-bar__send-btn"
            onClick={handleSend}
            disabled={chatAsking || !input.trim()}
            title={
              !input.trim()
                ? '请输入问题'
                : '发送提问（Enter）'
            }
            aria-label="发送"
          >
            {chatAsking ? (
              <span className="chat-input-bar__send-spinner" />
            ) : (
              <SendIcon />
            )}
          </button>
        </div>
      </footer>
    </>
  )
}

// ============================================================================
// 左侧会话列表侧边栏
// ============================================================================

function ChatSessionSidebar() {
  const chatSessions = useAppStore((s) => s.chatSessions)
  const currentChatSession = useAppStore((s) => s.currentChatSession)
  const selectChatSession = useAppStore((s) => s.selectChatSession)
  const createChatSession = useAppStore((s) => s.createChatSession)
  const renameChatSession = useAppStore((s) => s.renameChatSession)
  const deleteChatSession = useAppStore((s) => s.deleteChatSession)
  const loadChatSessions = useAppStore((s) => s.loadChatSessions)
  const chatAsking = useAppStore((s) => s.chatAsking)

  // ===== 全文搜索相关状态与 store 动作 =====
  const chatSearchQuery = useAppStore((s) => s.chatSearchQuery)
  const chatSearchResults = useAppStore((s) => s.chatSearchResults)
  const chatSearching = useAppStore((s) => s.chatSearching)
  const chatSearchError = useAppStore((s) => s.chatSearchError)
  const searchChatMessages = useAppStore((s) => s.searchChatMessages)
  const clearChatSearch = useAppStore((s) => s.clearChatSearch)
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId)

  // 搜索输入框展开态；输入框内文本（独立于 chatSearchQuery，便于防抖）
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // 防抖 timer 句柄
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 重命名态（与 GraphList 模式一致：内联 input + Enter 确认 / Esc 取消）
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement | null>(null)

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null)

  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

  // 展开搜索框时自动聚焦；收起时清空输入与结果
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    } else {
      setSearchInput('')
      // 收起时清理待执行的防抖 timer，避免 350ms 后触发无效搜索
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      if (chatSearchQuery) clearChatSearch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen])

  // 卸载时清掉防抖 timer
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [])

  /**
   * 输入防抖：停止输入 350ms 后触发搜索；输入变化时取消上一次 timer。
   * 直接 Enter 时立即触发并取消 timer。
   */
  const scheduleSearch = (raw: string) => {
    setSearchInput(raw)
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }
    searchDebounceRef.current = setTimeout(() => {
      void searchChatMessages(raw)
    }, 350)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      void searchChatMessages(searchInput)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setSearchOpen(false)
    }
  }

  const handleClearSearch = () => {
    setSearchInput('')
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }
    clearChatSearch()
    searchInputRef.current?.focus()
  }

  const handleNewSession = async () => {
    if (chatAsking) return
    await createChatSession()
  }

  const handleSelect = (sessionId: string) => {
    if (chatAsking) return
    if (renamingId === sessionId) return // 重命名中点击同项不触发切换
    const target = chatSessions.find((s) => s.id === sessionId)
    if (target) void selectChatSession(target)
  }

  /**
   * 点击搜索结果项：切换到对应会话，并设置需要高亮的消息 ID。
   * ChatConversationView 在消息渲染后滚动定位并短暂高亮，完成后清除。
   */
  const handleSelectFromSearch = (hit: ChatSearchHit, msgId: string) => {
    if (chatAsking) return
    setHighlightedMessageId(msgId)
    void selectChatSession(hit.session)
  }

  const startRename = (s: ChatSession) => {
    setRenamingId(s.id)
    setRenameValue(s.title)
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenameValue('')
  }

  const confirmRename = async () => {
    const id = renamingId
    if (!id) return
    const title = renameValue.trim()
    if (!title) {
      cancelRename()
      return
    }
    // 标题未变直接退出编辑态
    if (title === chatSessions.find((s) => s.id === id)?.title) {
      setRenamingId(null)
      setRenameValue('')
      return
    }
    const ok = await renameChatSession(id, title)
    if (ok) {
      setRenamingId(null)
      setRenameValue('')
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    setDeleteTarget(null)
    await deleteChatSession(id)
  }

  // 刷新：重载会话列表 + 当前会话消息 + 强制重置流式状态（解决 UI 卡死）
  const handleRefresh = async () => {
    await loadChatSessions()
    if (currentChatSession) {
      await selectChatSession(currentChatSession)
    }
  }

  // 搜索态：搜索框展开且有查询关键词时，列表区改为渲染搜索结果
  const isSearchMode = searchOpen && chatSearchQuery.length > 0

  return (
    <aside className="chat-sidebar" aria-label="对话记录列表">
      <header className="chat-sidebar__header">
        <span className="chat-sidebar__title">对话记录</span>
        <div className="chat-sidebar__header-actions">
          <button
            type="button"
            className={`chat-sidebar__icon-square-btn${
              searchOpen ? ' is-active' : ''
            }`}
            onClick={() => setSearchOpen((v) => !v)}
            disabled={chatAsking}
            title={searchOpen ? '关闭搜索' : '搜索对话内容'}
            aria-label={searchOpen ? '关闭搜索' : '搜索对话内容'}
            aria-expanded={searchOpen}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className="chat-sidebar__new-btn"
            onClick={handleNewSession}
            disabled={chatAsking}
            title="新建对话"
            aria-label="新建对话"
          >
            +
          </button>
        </div>
      </header>

      {/* 搜索输入框（展开态时渲染；输入即触发防抖搜索） */}
      {searchOpen && (
        <div className="chat-sidebar__search">
          <div className="chat-sidebar__search-input-wrap">
            <span className="chat-sidebar__search-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              ref={searchInputRef}
              type="text"
              className="chat-sidebar__search-input"
              placeholder="搜索对话内容…"
              value={searchInput}
              onChange={(e) => scheduleSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="搜索对话内容"
              autoComplete="off"
              spellCheck={false}
            />
            {searchInput && (
              <button
                type="button"
                className="chat-sidebar__search-clear"
                onClick={handleClearSearch}
                aria-label="清空搜索"
                title="清空搜索"
              >
                ×
              </button>
            )}
          </div>
          {chatSearching && (
            <div className="chat-sidebar__search-status">搜索中…</div>
          )}
          {!chatSearching && chatSearchError && (
            <div className="chat-sidebar__search-status chat-sidebar__search-status--error">
              搜索失败：{chatSearchError}
            </div>
          )}
        </div>
      )}

      <div className="chat-sidebar__list">
        {isSearchMode ? (
          chatSearchResults.length === 0 ? (
            <div className="chat-sidebar__empty">
              {chatSearching ? '搜索中…' : `未找到包含「${chatSearchQuery}」的对话`}
            </div>
          ) : (
            chatSearchResults.map((hit) => (
              <SearchResultItem
                key={hit.session.id}
                hit={hit}
                isActive={currentChatSession?.id === hit.session.id}
                query={chatSearchQuery}
                onSelect={(msgId) => handleSelectFromSearch(hit, msgId)}
              />
            ))
          )
        ) : chatSessions.length === 0 ? (
          <div className="chat-sidebar__empty">暂无对话记录</div>
        ) : (
          chatSessions.map((s) => {
            const isActive = currentChatSession?.id === s.id
            const isRenaming = renamingId === s.id
            return (
              <div
                key={s.id}
                className={`chat-sidebar__item${
                  isActive ? ' chat-sidebar__item--active' : ''
                }${isRenaming ? ' chat-sidebar__item--renaming' : ''}`}
              >
                {isRenaming ? (
                  <input
                    ref={renameRef}
                    className="chat-sidebar__rename-input"
                    name={`chat-title-${s.id}`}
                    aria-label={`重命名对话：${s.title}`}
                    autoComplete="off"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmRename()
                      if (e.key === 'Escape') cancelRename()
                    }}
                    onBlur={() => void confirmRename()}
                    disabled={chatAsking}
                  />
                ) : (
                  <button
                    type="button"
                    className="chat-sidebar__select-btn"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => handleSelect(s.id)}
                    disabled={chatAsking}
                    title={s.title}
                  >
                    <span className="chat-sidebar__item-title">{s.title}</span>
                    <span className="chat-sidebar__item-time" aria-hidden="true">
                      {formatShortTime(s.updated_at)}
                    </span>
                  </button>
                )}
                {!isRenaming && (
                  <div className="chat-sidebar__item-actions">
                    <button
                      type="button"
                      className="chat-sidebar__icon-btn"
                      aria-label={`重命名对话：${s.title}`}
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(s)
                      }}
                      disabled={chatAsking}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="chat-sidebar__icon-btn chat-sidebar__icon-btn--danger"
                      aria-label={`删除对话：${s.title}`}
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(s)
                      }}
                      disabled={chatAsking}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
      <footer className="chat-sidebar__footer">
        <button
          type="button"
          className="chat-sidebar__refresh-btn"
          onClick={() => void handleRefresh()}
          title="刷新列表与当前对话"
        >
          刷新
        </button>
      </footer>

      {/* 删除对话确认弹窗 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除对话"
        message={
          deleteTarget
            ? `确定删除对话「${deleteTarget.title}」？该操作会级联清理其下所有消息与 checkpoint，且不可恢复。`
            : ''
        }
        confirmText="确认删除"
        cancelText="取消"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  )
}

// ============================================================================
// 全文搜索：搜索图标 + 搜索结果项
// ============================================================================

/** 搜索图标：放大镜。 */
function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  )
}

interface SearchResultItemProps {
  hit: ChatSearchHit
  isActive: boolean
  query: string
  onSelect: (messageId: string) => void
}

/**
 * 搜索结果项：展示会话标题 + 命中消息片段（高亮关键词）。
 * 点击任意片段切换到对应会话并定位高亮该消息。
 */
function SearchResultItem({ hit, isActive, query, onSelect }: SearchResultItemProps) {
  return (
    <div
      className={`chat-sidebar__search-result${
        isActive ? ' chat-sidebar__search-result--active' : ''
      }`}
    >
      <div className="chat-sidebar__search-result-header">
        <span className="chat-sidebar__search-result-title" title={hit.session.title}>
          {hit.session.title}
        </span>
        <span className="chat-sidebar__search-result-count">
          共 {hit.total_hits} 处
        </span>
      </div>
      <ul className="chat-sidebar__search-hits">
        {hit.hits.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              className={`chat-sidebar__search-hit${
                h.role === 'user'
                  ? ' chat-sidebar__search-hit--user'
                  : ' chat-sidebar__search-hit--assistant'
              }`}
              onClick={() => onSelect(h.id)}
              title="点击跳转到该消息"
            >
              <span className="chat-sidebar__search-hit-role">
                {h.role === 'user' ? '我' : 'AI'}
              </span>
              <span className="chat-sidebar__search-hit-snippet">
                <HighlightedText text={h.snippet} query={query} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 将文本中匹配 query 的子串高亮（大小写不敏感）。
 * query 为空时直接返回原文。
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    if (!query) return [text]
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    const result: React.ReactNode[] = []
    let cursor = 0
    let idx = lowerText.indexOf(lowerQuery, cursor)
    let key = 0
    while (idx >= 0) {
      if (idx > cursor) result.push(text.slice(cursor, idx))
      result.push(
        <mark key={`hl-${key++}`} className="chat-sidebar__search-hit-mark">
          {text.slice(idx, idx + query.length)}
        </mark>,
      )
      cursor = idx + query.length
      idx = lowerText.indexOf(lowerQuery, cursor)
    }
    if (cursor < text.length) result.push(text.slice(cursor))
    return result
  }, [text, query])
  return <>{parts}</>
}

// ============================================================================
// 单条消息子组件（含思维链折叠 + 工具调用 + 正文）
// ============================================================================

interface ChatMessageItemProps {
  message: ChatMessage
  streaming?: boolean
}

/** 判断消息内容是否为测验作答指令（[quiz_answer] 前缀的内部协议文本）。 */
function isQuizAnswerMessage(content: string): boolean {
  return content.startsWith('[quiz_answer]')
}

function ChatMessageItem({ message, streaming }: ChatMessageItemProps) {
  const isUser = message.role === 'user'
  if (isUser) {
    return (
      <motion.li
        className="chat-msg chat-msg--user"
        data-message-id={message.id}
        layout="position"
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4 }}
      >
        <div className="chat-msg__bubble chat-msg__bubble--user">
          {message.content}
        </div>
      </motion.li>
    )
  }

  const isStreamingPlaceholder = streaming && !message.content
  const toolCalls = message.tool_calls ?? []
  const thinking = message.thinking?.trim() ?? ''

  // 提取测验卡数据：若 graph_generate_quiz 已完成，渲染交互式测验卡
  const quizCardProps = extractQuizFromToolCalls(toolCalls)

  // 仅当气泡内只有三点加载动画（无思维链、无工具调用、无测验卡）时，
  // 才使用 --loading 的 inline-flex 居中布局；否则保持 block 布局，
  // 让动画自然位于已流式输出的内容下方，而不是被横向 flex 挤到右侧。
  const isPureLoadingBubble =
    isStreamingPlaceholder &&
    !thinking &&
    toolCalls.length === 0 &&
    !quizCardProps

  return (
    <motion.li
      className="chat-msg chat-msg--assistant"
      data-message-id={message.id}
      layout="position"
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4 }}
    >
      <div
        className={`chat-msg__bubble chat-msg__bubble--assistant${
          isPureLoadingBubble ? ' chat-msg__bubble--loading' : ''
        }`}
      >
        {/* 思维链折叠区（在工具调用与正文之上，独立展示） */}
        {thinking && <ThinkingBlock thinking={thinking} streaming={streaming} />}

        {/* 工具调用过程展示 */}
        {toolCalls.length > 0 && (
          <div className="chat-msg__tool-calls">
            {toolCalls.map((tc, i) => (
              <ChatToolCallItem key={tc.id ?? i} toolCall={tc} />
            ))}
          </div>
        )}

        {/* 交互式测验卡（替代把题目当 markdown 文本输出） */}
        {quizCardProps && (
          <QuizCard
            quizId={quizCardProps.quizId}
            quizType={quizCardProps.quizType}
            payload={quizCardProps.payload}
            answered={quizCardProps.answered}
            result={quizCardProps.result}
          />
        )}

        {/* 回答正文（测验卡已展示题目时，正文仅保留 agent 的引导语） */}
        {isStreamingPlaceholder ? (
          <span className="chat-typing" aria-label="Agent 正在生成回答">
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
          </span>
        ) : (
          message.content && (
            <div
              className="chat-msg__text"
              dangerouslySetInnerHTML={{
                __html:
                  renderMarkdown(message.content) +
                  (streaming ? '<span class="chat-streaming-cursor" aria-hidden="true">▋</span>' : ''),
              }}
            />
          )
        )}
      </div>
    </motion.li>
  )
}

// ============================================================================
// 思维链折叠块
// ============================================================================

interface ThinkingBlockProps {
  thinking: string
  streaming?: boolean
}

function ThinkingBlock({ thinking, streaming }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)
  // 流式中默认展开（让用户看到思考过程），完成后默认折叠
  const [userToggled, setUserToggled] = useState(false)
  const isOpen = userToggled ? expanded : streaming

  const handleClick = () => {
    setUserToggled(true)
    setExpanded((v) => !v)
  }

  const preview = thinking.length > 80 ? `${thinking.slice(0, 80)}…` : thinking

  return (
    <div className={`chat-thinking${isOpen ? ' chat-thinking--open' : ''}`}>
      <button
        type="button"
        className="chat-thinking__toggle"
        onClick={handleClick}
        aria-expanded={isOpen}
        title={isOpen ? '点击折叠思考过程' : '点击展开思考过程'}
      >
        <span className="chat-thinking__icon" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="chat-thinking__label">
          {streaming ? '思考中…' : '思考过程'}
        </span>
        {!isOpen && (
          <span className="chat-thinking__preview">{preview}</span>
        )}
      </button>
      {isOpen && (
        <pre className="chat-thinking__content">{thinking}</pre>
      )}
    </div>
  )
}

// ============================================================================
// 工具调用过程展示子组件
// ============================================================================

const TOOL_ACTION_LABEL: Record<string, string> = {
  // 基础图谱工具（7 个）
  graph_query_nodes: '查询图谱节点',
  graph_get_node_detail: '获取节点详情',
  graph_get_context: '获取图谱上下文',
  graph_extract_from_observation: '从观察抽取节点',
  graph_generate_quiz: '生成测验题',
  graph_generate_trends: '生成风口推荐',
  graph_generate_report: '生成工作报告',
  // 节点行为工具（6 个）
  graph_extend_node: '延伸节点',
  graph_touch_node: '标记复习',
  graph_star_node: '星标节点',
  graph_unstar_node: '取消星标',
  graph_set_reminder: '设置提醒',
  graph_clear_reminder: '清除提醒',
  // 学习闭环工具（4 个）
  graph_answer_quiz: '作答测验',
  graph_list_quiz_history: '测验历史',
  graph_get_quiz_detail: '测验详情',
  graph_add_user_fill: '追加留白',
  // 智能推荐工具（1 个）
  graph_get_recommendations: '智能推荐',
  // 工作对象工具（2 个）
  graph_extract_work_objects: '抽取工作对象',
  graph_confirm_work_objects: '确认入图',
  // 观察记录工具（1 个）
  graph_list_observations: '观察记录',
}

function summarizeToolResult(
  tool: string,
  result: Record<string, unknown> | undefined,
): string {
  if (!result) return ''
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
    // 新结构：result = {status, quiz_id, quiz: {type, payload: {question, options, ...}}}
    const quiz = (result as { quiz?: { type?: string } }).quiz
    const qtype = quiz?.type
    if (qtype) return `已生成 ${qtype} 题`
    // 兼容旧结构（无 quiz_id）
    const oldType = (result as { type?: string }).type
    if (oldType) return `已生成 ${oldType} 题`
  }
  if (tool === 'graph_generate_trends') {
    const trends = (result as { trends?: unknown[] }).trends
    if (Array.isArray(trends)) return `生成 ${trends.length} 条风口`
  }
  if (tool === 'graph_generate_report') {
    const period = (result as { period?: string }).period
    if (period) return `${period} 报告已生成`
  }
  if (tool === 'graph_extend_node') {
    const count = (result as { count?: number }).count
    const existingHit = (result as { existing_hit?: unknown[] }).existing_hit
    const parts: string[] = []
    if (typeof count === 'number' && count > 0) parts.push(`新建 ${count} 个节点`)
    if (Array.isArray(existingHit) && existingHit.length > 0)
      parts.push(`命中已存在 ${existingHit.length} 个`)
    if (parts.length) return parts.join('，')
  }
  if (tool === 'graph_touch_node') {
    const reviewCount = (
      result as { node?: { review_count?: number } }
    ).node?.review_count
    if (typeof reviewCount === 'number') return `已标记复习（累计 ${reviewCount} 次）`
    return '已标记复习'
  }
  if (tool === 'graph_star_node') return '已星标'
  if (tool === 'graph_unstar_node') return '已取消星标'
  if (tool === 'graph_set_reminder') {
    const remindAt = (
      result as { node?: { remind_at?: string } }
    ).node?.remind_at
    if (remindAt) return `提醒已设置（${remindAt.slice(0, 16)}）`
    return '提醒已设置'
  }
  if (tool === 'graph_clear_reminder') return '提醒已清除'
  if (tool === 'graph_answer_quiz') {
    const correct = (result as { correct?: boolean }).correct
    const score = (result as { score?: number }).score
    if (typeof score === 'number') return `得分 ${score}`
    if (typeof correct === 'boolean') return correct ? '回答正确' : '回答错误'
  }
  if (tool === 'graph_list_quiz_history') {
    const count = (result as { count?: number }).count
    if (typeof count === 'number') return `共 ${count} 条历史`
  }
  if (tool === 'graph_get_quiz_detail') {
    const qtype = (
      result as { quiz?: { type?: string } }
    ).quiz?.type
    if (qtype) return `${qtype} 题详情`
  }
  if (tool === 'graph_add_user_fill') {
    const fillType = (result as { fill_type?: string }).fill_type
    if (fillType) return `已追加 ${fillType}`
    return '已追加留白'
  }
  if (tool === 'graph_get_recommendations') {
    const count = (result as { count?: number }).count
    if (typeof count === 'number') return `推荐 ${count} 个节点`
  }
  if (tool === 'graph_extract_work_objects') {
    const count = (result as { count?: number }).count
    if (typeof count === 'number') return `候选 ${count} 个`
  }
  if (tool === 'graph_confirm_work_objects') {
    const createdCount = (result as { created_count?: number }).created_count
    const edgeCount = (result as { edge_count?: number }).edge_count
    const parts: string[] = []
    if (typeof createdCount === 'number') parts.push(`入图 ${createdCount} 个节点`)
    if (typeof edgeCount === 'number' && edgeCount > 0)
      parts.push(`${edgeCount} 条边`)
    if (parts.length) return parts.join('，')
  }
  if (tool === 'graph_list_observations') {
    const count = (result as { count?: number }).count
    if (typeof count === 'number') return `${count} 条记录`
  }
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
    <motion.div
      className={`chat-tool-call chat-tool-call--${status}`}
      layout
      animate={{ opacity: 1, scale: status === 'pending' ? 0.99 : 1 }}
      transition={{ duration: 0.18 }}
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
    </motion.div>
  )
}

// ============================================================================
// 交互式测验卡（graph_generate_quiz 工具调用结果渲染为可点击选项）
// ============================================================================

interface QuizOption {
  id: string
  text: string
}

interface QuizCardProps {
  quizId: string
  quizType: string
  payload: {
    question?: string
    prompt?: string
    options?: QuizOption[]
    degraded?: boolean
    degrade_reason?: string
  }
  answered?: boolean
  result?: Record<string, unknown>
}

function QuizCard({ quizId, quizType, payload, answered, result }: QuizCardProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [feynmanText, setFeynmanText] = useState('')
  const [submitted, setSubmitted] = useState(answered ?? false)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const chatAsking = useAppStore((s) => s.chatAsking)

  // 从 store 中查找针对本题的 graph_answer_quiz 工具结果。
  // 作答消息与生成题消息不是同一条，generate 的 toolCalls 不会更新 quiz.result，
  // 因此必须从 answer_quiz 工具结果中取判分，否则界面永远显示"回答错误"，
  // 与智能体基于同一工具结果的文本判断不一致。
  const answerGrade = useAppStore((s) => {
    for (let i = s.chatMessages.length - 1; i >= 0; i--) {
      const tcs = s.chatMessages[i].tool_calls
      if (!tcs) continue
      for (let j = tcs.length - 1; j >= 0; j--) {
        const tc = tcs[j]
        if (tc.tool !== 'graph_answer_quiz' || tc.status !== 'done' || !tc.result) continue
        const r = tc.result as { quiz_id?: string; status?: string }
        if (r.quiz_id === quizId && r.status === 'ok') {
          return r as Record<string, unknown>
        }
      }
    }
    return null
  })

  // 历史回显：generate_quiz 工具结果中的 quiz.answered 不会随作答更新，
  // 刷新后仍为 false。若 store 中存在匹配的 answer_quiz 工具结果，
  // 说明已作答，需把 submitted 同步为 true，否则 QuizCard 会显示成未答状态。
  useEffect(() => {
    if (answerGrade && !submitted) {
      setSubmitted(true)
      // 同步本地选中态，便于已答单选题把用户选项标灰
      const ua = (answerGrade as { user_answer?: string[] | string }).user_answer
      if (Array.isArray(ua)) {
        setSelected(ua.map(String))
      } else if (typeof ua === 'string') {
        setSelected([ua])
      }
    }
  }, [answerGrade, submitted])

  // 优先用 answer_quiz 的实时判分；历史回显（已答题目）退回到 props.result
  const effectiveResult = (answerGrade ?? result) as
    | (Record<string, unknown> & {
        correct?: boolean
        score?: number
        correct_answers?: string[]
        explanation?: string
        feedback?: string
      })
    | undefined
  const graded = answerGrade !== null
  const correct = effectiveResult?.correct
  const score = effectiveResult?.score
  const correctAnswers = effectiveResult?.correct_answers ?? []
  const explanation = effectiveResult?.explanation
  const feedback = effectiveResult?.feedback

  const isChoice = quizType === 'single_choice' || quizType === 'multi_choice'
  const isFeynman = quizType === 'feynman'
  const isMulti = quizType === 'multi_choice'
  const degraded = payload.degraded

  const handleOptionClick = (optionId: string) => {
    if (submitted || chatAsking) return
    if (isMulti) {
      setSelected((prev) =>
        prev.includes(optionId)
          ? prev.filter((id) => id !== optionId)
          : [...prev, optionId],
      )
    } else {
      // 单选题：直接提交
      setSelected([optionId])
      void submitAnswer([optionId])
    }
  }

  const handleMultiSubmit = () => {
    if (selected.length === 0 || chatAsking) return
    void submitAnswer(selected)
  }

  const handleFeynmanSubmit = () => {
    const text = feynmanText.trim()
    if (!text || chatAsking) return
    void submitAnswer(text)
  }

  const submitAnswer = async (answer: string[] | string) => {
    if (submitted) return
    setSubmitted(true)
    // 发送结构化消息，让 agent 调用 graph_answer_quiz
    const answerStr = Array.isArray(answer) ? answer.join(',') : answer
    const msg = `[quiz_answer] quiz_id=${quizId} answer=${answerStr}`
    await sendMessage(msg)
  }

  if (degraded) {
    return (
      <div className="quiz-card quiz-card--degraded">
        <div className="quiz-card__header">
          <span className="quiz-card__badge">测验</span>
          <span className="quiz-card__type">
            {quizType === 'single_choice' ? '单选题' : quizType === 'multi_choice' ? '多选题' : '费曼题'}
          </span>
        </div>
        <p className="quiz-card__degraded">
          题目生成服务暂不可用（降级模式）。{payload.degrade_reason ?? ''}
        </p>
      </div>
    )
  }

  return (
    <div className={`quiz-card${submitted ? ' quiz-card--answered' : ''}`}>
      <div className="quiz-card__header">
        <span className="quiz-card__badge">测验</span>
        <span className="quiz-card__type">
          {isChoice
            ? isMulti
              ? '多选题（点击勾选，再点提交）'
              : '单选题（点击选项即作答）'
            : '费曼解释题'}
        </span>
      </div>

      {isChoice && (
        <>
          <p className="quiz-card__question">{payload.question ?? ''}</p>
          <div className="quiz-card__options">
            {(payload.options ?? []).map((opt) => {
              const isSelected = selected.includes(opt.id)
              // 仅在拿到判分结果后才标色，避免判分未返回时误标红
              const isCorrect = submitted && graded && correctAnswers.includes(opt.id)
              const isWrong =
                submitted &&
                graded &&
                isSelected &&
                !correctAnswers.includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`quiz-card__option${
                    isSelected ? ' quiz-card__option--selected' : ''
                  }${isCorrect ? ' quiz-card__option--correct' : ''}${
                    isWrong ? ' quiz-card__option--wrong' : ''
                  }`}
                  onClick={() => handleOptionClick(opt.id)}
                  disabled={submitted || chatAsking}
                >
                  <span className="quiz-card__option-id">{opt.id}</span>
                  <span className="quiz-card__option-text">{opt.text}</span>
                  {isCorrect && <span className="quiz-card__option-mark">✓</span>}
                  {isWrong && <span className="quiz-card__option-mark">✗</span>}
                </button>
              )
            })}
          </div>
          {isMulti && !submitted && (
            <button
              type="button"
              className="quiz-card__submit-btn"
              onClick={handleMultiSubmit}
              disabled={selected.length === 0 || chatAsking}
            >
              提交答案（已选 {selected.length} 项）
            </button>
          )}
          {submitted && (
            <div
              className={`quiz-card__result${
                graded
                  ? correct
                    ? ' quiz-card__result--correct'
                    : ' quiz-card__result--wrong'
                  : ''
              }`}
            >
              <span className="quiz-card__result-icon">
                {graded
                  ? correct
                    ? '✓ 回答正确'
                    : '✗ 回答错误'
                  : '判分中…'}
              </span>
              {graded && explanation && (
                <p className="quiz-card__explanation">{explanation}</p>
              )}
            </div>
          )}
        </>
      )}

      {isFeynman && (
        <>
          <p className="quiz-card__question">{payload.prompt ?? '请用自己的话解释该知识点'}</p>
          {!submitted ? (
            <div className="quiz-card__feynman">
              <textarea
                className="quiz-card__feynman-input"
                value={feynmanText}
                onChange={(e) => setFeynmanText(e.target.value)}
                placeholder="在此输入你的解释…"
                rows={4}
                disabled={chatAsking}
              />
              <button
                type="button"
                className="quiz-card__submit-btn"
                onClick={handleFeynmanSubmit}
                disabled={!feynmanText.trim() || chatAsking}
              >
                提交解释
              </button>
            </div>
          ) : (
            <div className="quiz-card__result quiz-card__result--feynman">
              <span className="quiz-card__result-icon">
                {graded ? `得分 ${score ?? '-'}/100` : '判分中…'}
              </span>
              {graded && feedback && (
                <p className="quiz-card__explanation">{feedback}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 从 tool_calls 中提取 graph_generate_quiz 的结果，渲染交互式测验卡。 */
function extractQuizFromToolCalls(
  toolCalls: ToolCall[],
): QuizCardProps | null {
  for (const tc of toolCalls) {
    if (tc.tool !== 'graph_generate_quiz') continue
    if (tc.status !== 'done' || !tc.result) continue
    const r = tc.result as {
      status?: string
      quiz_id?: string
      quiz?: {
        id?: string
        type?: string
        payload?: Record<string, unknown>
        answered?: boolean
        result?: Record<string, unknown>
      }
    }
    if (r.status !== 'ok') continue
    const quizId = r.quiz_id ?? r.quiz?.id ?? ''
    if (!quizId) continue
    const quiz = r.quiz
    if (!quiz) continue
    return {
      quizId,
      quizType: quiz.type ?? 'single_choice',
      payload: (quiz.payload ?? {}) as QuizCardProps['payload'],
      answered: quiz.answered,
      result: quiz.result as Record<string, unknown> | undefined,
    }
  }
  return null
}

// ============================================================================
// Plan / Go 模式切换按钮（Work 模式独有；Build 前端改名为 Go）
// ============================================================================

interface PlanGoToggleProps {
  planMode: boolean
  onToggle: () => void
  disabled?: boolean
}

function PlanGoToggle({ planMode, onToggle, disabled }: PlanGoToggleProps) {
  // planMode=true 显示「Plan」（只读）；planMode=false 显示「Go」（可执行）
  // 点击切换到对面状态
  return (
    <button
      type="button"
      className={`plan-go-toggle${
        planMode ? ' plan-go-toggle--plan' : ' plan-go-toggle--go'
      }`}
      onClick={onToggle}
      disabled={disabled}
      title={
        planMode
          ? '当前 Plan 模式（只读），点击切到 Go（可写）'
          : '当前 Go 模式（可写），点击切到 Plan（只读）'
      }
      aria-pressed={planMode}
    >
      {planMode ? 'Plan' : 'Go'}
    </button>
  )
}

// ============================================================================
// 发送按钮 SVG 图标
// ============================================================================

function SendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

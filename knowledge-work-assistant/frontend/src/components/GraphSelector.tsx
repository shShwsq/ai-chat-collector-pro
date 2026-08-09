/**
 * 图谱选择 combobox（ChatHome / ChatConversationView 输入框正上方共享组件）。
 *
 * 背景：``activeNav === 'chat'`` 时主区只渲染 ``ChatPanel``，``GraphList``
 * 侧栏不显示，用户在对话视图无法切换当前图谱。本组件补上这一入口。
 *
 * 形态：**自定义 combobox**（非原生 ``<select>``），支持在输入框输入文本筛选图谱。
 * - 关闭态：输入框显示当前选中图谱名
 * - 展开态：输入框聚焦/点击下拉箭头展开列表，输入即筛选（按 name 包含匹配，大小写不敏感）
 * - 键盘：ArrowDown/Up 导航高亮项，Enter 选中，Esc 关闭并回退到当前图谱名
 * - 鼠标：hover 设置高亮，click 选中；点击组件外部关闭
 *
 * 职责：**仅切换已有图谱**；新建仍需去图谱视图（``GraphList`` 顶部「+ 新建」）。
 * 数据：``store.graphs`` / ``currentGraphId`` / ``mode``；切换调 ``selectGraph``。
 *
 * 安全：
 * - ``chatAsking``（对话流式进行中）时禁用 combobox，避免切换清空流式状态丢失请求。
 * - ``selectGraph`` 已处理切换后清理（清空 ``currentChatSession`` / ``chatMessages`` /
 *   流式状态，并按新 ``graph_id`` 重新 ``loadChatSessions``），这里无需重复。
 * - 若 ``currentGraphId`` 不在当前 ``graphs`` 列表内（例如模式切换过渡期），
 *   输入框回退到空占位，避免显示与实际状态不一致。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import type { Graph } from '../lib/types'

export function GraphSelector() {
  const graphs = useAppStore((s) => s.graphs)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const loading = useAppStore((s) => s.loading)
  const chatAsking = useAppStore((s) => s.chatAsking)
  const selectGraph = useAppStore((s) => s.selectGraph)
  const loadGraphs = useAppStore((s) => s.loadGraphs)
  const setActiveNav = useAppStore((s) => s.setActiveNav)

  // 保险：进入对话视图时若 graphs 为空（例如启动后直接停在 chat 视图未触发
  // GraphList 加载），主动拉取一次当前模式图谱列表。
  useEffect(() => {
    if (graphs.length === 0 && !loading) {
      void loadGraphs()
    }
  }, [graphs.length, loading, loadGraphs])

  // 当前选中图谱对象（若 currentGraphId 不在列表内则为 undefined）
  const currentGraph = useMemo(
    () => graphs.find((g) => g.id === currentGraphId),
    [graphs, currentGraphId],
  )

  // 输入框文本：关闭态显示当前图谱名，展开态显示用户输入的筛选词
  const [query, setQuery] = useState(currentGraph?.name ?? '')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  // currentGraphId 变化且下拉关闭时，同步输入框文本为新图谱名
  // （切换图谱后输入框要显示新选中项，而不是旧输入）
  useEffect(() => {
    if (!open) setQuery(currentGraph?.name ?? '')
  }, [currentGraphId, currentGraph?.name, open])

  // 筛选：按 name 包含匹配，大小写不敏感
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return graphs
    return graphs.filter((g) => g.name.toLowerCase().includes(q))
  }, [graphs, query])

  // query 变化时重置高亮项并 clamp（防止越界）
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0)
    }
  }, [filtered.length, activeIndex])

  // 展开时滚动高亮项进入可视区
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  // 点击组件外部关闭下拉
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: PointerEvent) => {
      const container = containerRef.current
      if (container && !container.contains(e.target as Node)) {
        closeAndReset()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentGraph?.name])

  const closeAndReset = () => {
    setOpen(false)
    setQuery(currentGraph?.name ?? '')
  }

  const handleSelect = (g: Graph) => {
    setOpen(false)
    setQuery(g.name)
    if (g.id !== currentGraphId) selectGraph(g.id)
    inputRef.current?.blur()
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    if (!open) setOpen(true)
  }

  const handleInputFocus = () => {
    if (!chatAsking) setOpen(true)
  }

  const handleToggleClick = () => {
    if (chatAsking) return
    if (open) {
      closeAndReset()
    } else {
      setOpen(true)
      // 展开时聚焦输入框并全选文本，便于直接覆盖输入筛选
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (chatAsking) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (filtered.length === 0) return
      setActiveIndex((i) => (i + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (filtered.length === 0) return
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      const target = filtered[activeIndex]
      if (target) handleSelect(target)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      closeAndReset()
      inputRef.current?.blur()
    }
  }

  const handleGoToGraphView = () => {
    setActiveNav('graph')
  }

  // ===== 无图谱态：引导去图谱视图创建 =====
  if (graphs.length === 0) {
    return (
      <div className="graph-selector graph-selector--empty">
        <span className="graph-selector__label">
          {loading ? '正在加载图谱列表…' : '当前模式暂无图谱'}
        </span>
        {!loading && (
          <button
            type="button"
            className="graph-selector__goto"
            onClick={handleGoToGraphView}
          >
            去图谱视图创建 →
          </button>
        )}
      </div>
    )
  }

  const placeholder = currentGraph ? '' : '请选择图谱'

  return (
    <div
      className={`graph-selector${open ? ' graph-selector--open' : ''}`}
      ref={containerRef}
    >
      <span className="graph-selector__label" aria-hidden="true">
        图谱
      </span>
      <div className="graph-selector__combobox">
        <input
          ref={inputRef}
          type="text"
          className="graph-selector__input"
          value={query}
          placeholder={placeholder}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          disabled={chatAsking}
          aria-label="选择当前图谱，可输入名称筛选"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="graph-selector__listbox"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="graph-selector__toggle"
          onClick={handleToggleClick}
          disabled={chatAsking}
          aria-label={open ? '关闭图谱选择列表' : '展开图谱选择列表'}
          aria-expanded={open}
          tabIndex={-1}
        >
          <span className={`graph-selector__toggle-icon${open ? ' is-open' : ''}`} aria-hidden="true">
            ▾
          </span>
        </button>

        {open && (
          <ul
            id="graph-selector__listbox"
            ref={listRef}
            className="graph-selector__list"
            role="listbox"
          >
            {filtered.length === 0 ? (
              <li className="graph-selector__empty-item">
                无匹配「{query}」的图谱
              </li>
            ) : (
              filtered.map((g, i) => {
                const isActive = i === activeIndex
                const isSelected = g.id === currentGraphId
                return (
                  <li
                    key={g.id}
                    data-option-index={i}
                    className={`graph-selector__option${
                      isActive ? ' is-active' : ''
                    }${isSelected ? ' is-selected' : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(g)}
                    onMouseEnter={() => setActiveIndex(i)}
                    title={g.name}
                  >
                    <span className="graph-selector__option-name">{g.name}</span>
                    {isSelected && (
                      <span className="graph-selector__option-mark" aria-hidden="true">✓</span>
                    )}
                  </li>
                )
              })
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * 图谱列表侧栏（Task 4 / Task 11）。
 *
 * 左侧固定宽度侧栏，展示当前模式下的图谱列表，支持：
 * - 新建：点击「新建」展开内联输入框，绑定当前模式类型（``createGraph``）
 * - 选中：点击列表项切换 ``currentGraphId``，store 自动加载完整图谱
 * - 重命名：点击「编辑」切换为内联输入框，Enter 确认 / Esc 取消 / blur 确认
 * - 删除：点击「删除」弹出原生确认框，确认后级联删除
 *
 * 列表项 hover 显示操作按钮，选中态左侧强调色色条 + 浅色背景。
 * 新建 / 选中 / 重命名 / 删除均调用 ``useAppStore`` 的 action，
 * 不直接调 api，便于统一错误处理与状态同步。
 *
 * Task 11 待抽取入口：
 * - 底部「待抽取」按钮显示未处理对话数量，点击展开 PendingNodes 浮层面板。
 * - 当前模式为 work 时不显示该入口（work 模式暂不接入对话抽取）。
 * - 选中图谱变化时刷新待抽取数量。
 */

import { useEffect, useRef, useState } from 'react'

import { Icon } from './Icon'
import { useAppStore } from '../store/useAppStore'
import type { Graph, Mode } from '../lib/types'

const MODE_LABEL: Record<Mode, string> = {
  study: '学习模式',
  work: '工作模式',
}

/** 格式化 ISO 时间为简短的本地展示（月/日 时:分）。 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return ''
  }
}

export function GraphList() {
  const mode = useAppStore((s) => s.mode)
  const graphs = useAppStore((s) => s.graphs)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const loading = useAppStore((s) => s.loading)
  const selectGraph = useAppStore((s) => s.selectGraph)
  const createGraph = useAppStore((s) => s.createGraph)
  const renameGraph = useAppStore((s) => s.renameGraph)
  const deleteGraph = useAppStore((s) => s.deleteGraph)
  // Task 11：待抽取入口
  const pendingObservations = useAppStore((s) => s.pendingObservations)
  const pendingPanelOpen = useAppStore((s) => s.pendingPanelOpen)
  const togglePendingPanel = useAppStore((s) => s.togglePendingPanel)
  const loadPendingObservations = useAppStore((s) => s.loadPendingObservations)

  // 新建态
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // 重命名态
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement | null>(null)

  // 新建输入框使用 autoFocus 在挂载阶段同步聚焦，
  // 不再依赖 useEffect([creating]) 手动 focus —— 后者只在 creating 变化时触发，
  // 当列表刷新导致 input 在 creating=true 期间重建时会漏聚焦。
  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

  // Task 11：选中图谱或切换模式时刷新待抽取列表
  // （切换模式由 setMode 触发清空，这里只需在 currentGraphId 变化时刷新）
  useEffect(() => {
    if (mode === 'study') {
      void loadPendingObservations()
    }
  }, [mode, currentGraphId, loadPendingObservations])

  const startCreate = () => {
    setNewName('')
    setCreating(true)
  }

  const cancelCreate = () => {
    setCreating(false)
    setNewName('')
  }

  const confirmCreate = async () => {
    const name = newName.trim()
    if (!name) {
      setCreating(false)
      return
    }
    const g = await createGraph(name)
    if (g) {
      setCreating(false)
      setNewName('')
    }
  }

  const startRename = (g: Graph) => {
    setRenamingId(g.id)
    setRenameValue(g.name)
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenameValue('')
  }

  const confirmRename = async () => {
    const id = renamingId
    if (!id) return
    const name = renameValue.trim()
    if (!name) {
      cancelRename()
      return
    }
    const ok = await renameGraph(id, name)
    if (ok) {
      setRenamingId(null)
      setRenameValue('')
    }
  }

  const handleDelete = async (g: Graph) => {
    const yes = window.confirm(
      `确定删除图谱「${g.name}」？\n该操作会级联清理其下所有节点、边与测验，且不可恢复。`,
    )
    if (!yes) return
    await deleteGraph(g.id)
  }

  const handleTogglePending = () => {
    togglePendingPanel()
    // 打开时强制刷新一次，确保最新
    if (!pendingPanelOpen) void loadPendingObservations()
  }

  const pendingCount = pendingObservations.length

  return (
    <aside className="graph-list">
      <div className="graph-list__header">
        <span className="graph-list__title">
          图谱
          <span className="graph-list__title-tag">{MODE_LABEL[mode]}</span>
        </span>
        <button
          type="button"
          className="graph-list__new-btn"
          onClick={startCreate}
          disabled={creating}
        >
          + 新建
        </button>
      </div>

      <div className="graph-list__items">
        {graphs.length === 0 ? (
          <div className="graph-list__empty">
            {loading ? '正在加载图谱列表…' : '当前模式下还没有图谱'}
            {!loading && (
              <div className="graph-list__empty-hint">
                点击右上「新建」创建第一个图谱
              </div>
            )}
          </div>
        ) : (
          graphs.map((g) => {
            const active = g.id === currentGraphId
            const isRenaming = renamingId === g.id
            return (
              <div
                key={g.id}
                className={`graph-list__item${active ? ' is-active' : ''}`}
              >
                <div className="graph-list__item-row">
                  {isRenaming ? (
                    <input
                      ref={renameRef}
                      className="graph-list__rename-input"
                      name={`graph-name-${g.id}`}
                      aria-label={`重命名图谱：${g.name}`}
                      autoComplete="off"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void confirmRename()
                        if (e.key === 'Escape') cancelRename()
                      }}
                      onBlur={() => void confirmRename()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="graph-list__select-btn"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => selectGraph(g.id)}
                    >
                      <span className="graph-list__item-name" title={g.name}>
                        {g.name}
                      </span>
                      <span className="graph-list__item-meta">
                        更新于 {formatTime(g.updated_at)}
                      </span>
                    </button>
                  )}
                  {!isRenaming && (
                    <div className="graph-list__item-actions">
                      <button
                        type="button"
                        className="graph-list__icon-btn"
                        aria-label={`重命名图谱：${g.name}`}
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(g)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="graph-list__icon-btn graph-list__icon-btn--danger"
                        aria-label={`删除图谱：${g.name}`}
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDelete(g)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}

        {creating && (
          <div className="graph-list__create">
            <input
              autoFocus
              className="graph-list__create-input"
              name="new-graph-name"
              aria-label={`新建${MODE_LABEL[mode]}图谱名称`}
              autoComplete="off"
              placeholder={`输入${MODE_LABEL[mode]}图谱名称…`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmCreate()
                if (e.key === 'Escape') cancelCreate()
              }}
            />
            <div className="graph-list__create-actions">
              <button
                type="button"
                className="graph-list__mini-btn graph-list__mini-btn--ghost"
                onClick={cancelCreate}
              >
                取消
              </button>
              <button
                type="button"
                className="graph-list__mini-btn graph-list__mini-btn--primary"
                onClick={() => void confirmCreate()}
                disabled={!newName.trim()}
              >
                创建
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Task 11：待抽取入口（仅 study 模式显示，work 暂不接入对话抽取） */}
      {mode === 'study' && (
        <div className="graph-list__pending-entry">
          <button
            type="button"
            className={`graph-list__pending-btn${
              pendingPanelOpen ? ' is-active' : ''
            }`}
            onClick={handleTogglePending}
            title="从浏览器插件采集的 AI 对话中抽取知识点"
          >
            <span className="graph-list__pending-icon">
              <Icon name="inbox" size={16} />
            </span>
            <span className="graph-list__pending-label">待抽取对话</span>
            {pendingCount > 0 && (
              <span className="graph-list__pending-badge">{pendingCount}</span>
            )}
          </button>
        </div>
      )}
    </aside>
  )
}

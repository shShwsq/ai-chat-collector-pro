/**
 * 手动导入对话弹窗。
 *
 * 流程（四阶段状态机）：
 *   drop       拖拽 / 点击上传平台导出的 JSON 文件
 *      ↓ detectAndParse 自动识别来源与格式
 *   preview    展示会话数 / 时间范围 / 消息数，列表勾选要导入的会话
 *      ↓ 调用 store.importConversations（复用插件推送接口落库为 Observation）
 *   importing  进度条（done/total）
 *      ↓
 *   done       汇总结果（已导入 / 去重跳过 / 失败）
 *
 * 设计要点：
 * 1. **格式自适应**：调用 ``detectAndParse`` 自动识别平台，目前仅支持 DeepSeek，
 *    无法识别时在 drop 阶段内联提示，不切阶段。
 * 2. **选择保留**：勾选以会话 id 记录，过滤搜索不丢失已选；提供全选 / 反选。
 * 3. **导入期间不可关闭**：importing 阶段禁用 backdrop / ESC / 关闭按钮，避免半途中断。
 * 4. **结果可追溯**：done 阶段展示失败错误（最多 5 条），便于排查。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore, type ImportConversationsResult } from '../store/useAppStore'
import { formatDateTime } from '../lib/date'
import {
  detectAndParse,
  ImportParseError,
  type ImportPreview,
} from '../lib/importers'

type Stage = 'drop' | 'preview' | 'importing' | 'done'

interface ImportConversationsModalProps {
  onClose: () => void
}

export function ImportConversationsModal({ onClose }: ImportConversationsModalProps) {
  const importConversations = useAppStore((s) => s.importConversations)
  const [stage, setStage] = useState<Stage>('drop')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [result, setResult] = useState<ImportConversationsResult | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const conversations = useMemo(
    () => preview?.conversations ?? [],
    [preview],
  )

  // 过滤后的列表（标题包含搜索词，大小写不敏感）
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, filter])

  // ===== 文件读取与解析 =====
  const handleFile = useCallback(async (file: File) => {
    setError('')
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
      setError('请选择 .json 格式的平台导出文件')
      return
    }
    try {
      const text = await file.text()
      const parsed = detectAndParse(text)
      setPreview(parsed)
      // 默认全选
      setSelectedIds(new Set(parsed.conversations.map((c) => c.id)))
      setFilter('')
      setStage('preview')
    } catch (e) {
      setError(
        e instanceof ImportParseError
          ? e.message
          : `解析失败：${(e as Error).message}`,
      )
    }
  }, [])

  // ===== 拖拽事件 =====
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  // ===== 选择操作 =====
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAllFiltered = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const c of filtered) {
          if (checked) next.add(c.id)
          else next.delete(c.id)
        }
        return next
      })
    },
    [filtered],
  )

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(conversations.map((c) => c.id)))
  }, [conversations])

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  // 当前过滤视图是否全选
  const filteredAllSelected =
    filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id))

  // ===== 执行导入 =====
  const handleImport = useCallback(async () => {
    if (!preview) return
    const selected = conversations.filter((c) => selectedIds.has(c.id))
    if (selected.length === 0) return
    setStage('importing')
    setProgress({ done: 0, total: selected.length })
    try {
      const res = await importConversations(
        preview.platform,
        selected,
        (done, total) => setProgress({ done, total }),
      )
      setResult(res)
      setStage('done')
    } catch (e) {
      // importConversations 内部已捕获逐条错误，此处兜底
      setResult({
        total: selected.length,
        imported: 0,
        deduplicated: 0,
        failed: selected.length,
        errors: [(e as Error).message],
      })
      setStage('done')
    }
  }, [preview, conversations, selectedIds, importConversations])

  // ===== 重新选择文件 =====
  const resetToDrop = useCallback(() => {
    setStage('drop')
    setPreview(null)
    setError('')
    setFilter('')
    setSelectedIds(new Set())
    setProgress({ done: 0, total: 0 })
    setResult(null)
  }, [])

  // ===== ESC 关闭（导入期间禁用）=====
  useEffect(() => {
    if (stage === 'importing') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage, onClose])

  const busy = stage === 'importing'

  return (
    <div
      className="import-modal"
      role="dialog"
      aria-modal="true"
      aria-label="导入对话"
      onClick={() => !busy && onClose()}
    >
      <div
        className="import-modal__box"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="import-modal__header">
          <h3 className="import-modal__title">导入对话</h3>
          {!busy && (
            <button
              type="button"
              className="import-modal__close"
              onClick={onClose}
              aria-label="关闭"
            >
              ×
            </button>
          )}
        </div>

        {/* 内容区 */}
        <div className="import-modal__body">
          {stage === 'drop' && (
            <div
              className={`import-dropzone${isDragging ? ' is-dragging' : ''}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="import-dropzone__input"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleFile(f)
                  // 清空 value 允许重复选同一文件
                  e.target.value = ''
                }}
              />
              <div className="import-dropzone__icon" aria-hidden="true">⬆</div>
              <div className="import-dropzone__hint">
                拖入平台导出的文件，或点击选择
              </div>
              <div className="import-dropzone__sub">
                目前支持 DeepSeek（conversations.json）
              </div>
            </div>
          )}

          {stage === 'drop' && error && (
            <div className="import-modal__error">{error}</div>
          )}

          {(stage === 'preview' || stage === 'importing') && preview && (
            <>
              {/* 统计概览 */}
              <div className="import-stats">
                <span className="import-stats__chip">
                  {preview.platform.toUpperCase()}
                </span>
                <div className="import-stats__item">
                  <span className="import-stats__label">会话数</span>
                  <span className="import-stats__value">
                    {conversations.length}
                  </span>
                </div>
                <div className="import-stats__item">
                  <span className="import-stats__label">消息数</span>
                  <span className="import-stats__value">
                    {preview.totalMessages}
                  </span>
                </div>
                <div className="import-stats__item import-stats__item--wide">
                  <span className="import-stats__label">时间范围</span>
                  <span className="import-stats__value import-stats__value--time">
                    {preview.timeRange
                      ? `${formatDateTime(preview.timeRange.start)} → ${formatDateTime(preview.timeRange.end)}`
                      : '—'}
                  </span>
                </div>
              </div>

              {/* 工具条：搜索 + 全选 */}
              <div className="import-toolbar">
                <input
                  type="text"
                  className="import-toolbar__search"
                  placeholder="搜索会话标题…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  disabled={busy}
                />
                <div className="import-toolbar__select">
                  <label className="import-toolbar__check">
                    <input
                      type="checkbox"
                      checked={filteredAllSelected}
                      onChange={(e) => selectAllFiltered(e.target.checked)}
                      disabled={busy}
                    />
                    选中本页全部
                  </label>
                  <button
                    type="button"
                    className="import-toolbar__btn"
                    onClick={selectAll}
                    disabled={busy}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="import-toolbar__btn"
                    onClick={deselectAll}
                    disabled={busy}
                  >
                    清空
                  </button>
                </div>
              </div>

              {/* 已选计数 */}
              <div className="import-list__count">
                已选 {selectedIds.size} / {conversations.length} 条
                {filter.trim() && `（当前过滤 ${filtered.length} 条）`}
              </div>

              {/* 会话列表 */}
              <ul className="import-list">
                {filtered.map((c) => {
                  const checked = selectedIds.has(c.id)
                  return (
                    <li
                      key={c.id}
                      className={`import-list__item${checked ? ' is-selected' : ''}`}
                    >
                      <label className="import-list__row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(c.id)}
                          disabled={busy}
                        />
                        <span className="import-list__title" title={c.title}>
                          {c.title || '(无标题)'}
                        </span>
                        <span className="import-list__meta">
                          <span className="import-list__msgs">
                            {c.messageCount} 条消息
                          </span>
                          <span className="import-list__time">
                            {formatDateTime(c.occurredAt) || '—'}
                          </span>
                        </span>
                      </label>
                    </li>
                  )
                })}
                {filtered.length === 0 && (
                  <li className="import-list__empty">没有匹配的会话</li>
                )}
              </ul>
            </>
          )}

          {stage === 'importing' && (
            <div className="import-progress">
              <div className="import-progress__text">
                正在导入 {progress.done} / {progress.total} …
              </div>
              <div className="import-progress__bar">
                <div
                  className="import-progress__fill"
                  style={{
                    width: `${
                      progress.total > 0
                        ? (progress.done / progress.total) * 100
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="import-progress__hint">
                导入的对话会进入「待抽取」列表，可在图谱视图抽取知识点入图
              </div>
            </div>
          )}

          {stage === 'done' && result && (
            <div className="import-result">
              <div className="import-result__summary">
                <div className="import-result__item import-result__item--ok">
                  <span className="import-result__num">{result.imported}</span>
                  <span className="import-result__label">已导入</span>
                </div>
                <div className="import-result__item">
                  <span className="import-result__num">
                    {result.deduplicated}
                  </span>
                  <span className="import-result__label">已存在跳过</span>
                </div>
                <div className="import-result__item import-result__item--fail">
                  <span className="import-result__num">{result.failed}</span>
                  <span className="import-result__label">失败</span>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="import-result__errors">
                  <div className="import-result__errors-title">失败原因：</div>
                  <ul>
                    {result.errors.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="import-modal__footer">
          {stage === 'drop' && (
            <button
              type="button"
              className="settings-section__ghost-btn"
              onClick={onClose}
            >
              取消
            </button>
          )}
          {stage === 'preview' && (
            <>
              <button
                type="button"
                className="settings-section__ghost-btn"
                onClick={resetToDrop}
              >
                重新选择文件
              </button>
              <button
                type="button"
                className="import-modal__primary"
                onClick={handleImport}
                disabled={selectedIds.size === 0}
              >
                导入选中 {selectedIds.size} 条
              </button>
            </>
          )}
          {stage === 'importing' && (
            <button
              type="button"
              className="settings-section__ghost-btn"
              disabled
            >
              导入中…
            </button>
          )}
          {stage === 'done' && (
            <>
              <button
                type="button"
                className="settings-section__ghost-btn"
                onClick={resetToDrop}
              >
                导入另一个文件
              </button>
              <button
                type="button"
                className="import-modal__primary"
                onClick={onClose}
              >
                完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

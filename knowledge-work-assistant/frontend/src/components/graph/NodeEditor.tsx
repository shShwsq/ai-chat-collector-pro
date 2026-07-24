/**
 * 节点编辑器（Task 9.1）。
 *
 * 模态弹窗，可编辑：
 * - 标题（title）
 * - 概括（summary）
 * - 类型（type 下拉，按当前图谱模式给出对应枚举）
 * - 详情字段（detail_payload 各模板字段，按当前类型模板渲染多行文本框）
 *
 * 保存时调用 ``store.updateNode``，PATCH 仅更新非 undefined 字段；
 * 切换类型后模板字段会跟随变化，原模板中不存在的字段值会被保留在 detail_payload
 * 中（后端 merge），但编辑器只展示当前模板字段。
 *
 * 交互：
 * - 模态遮罩 + 居中卡片，点击遮罩 / Esc / 取消按钮关闭
 * - 保存成功后触发 ``onSaved`` 并关闭
 * - 表单受控，未保存直接关闭丢弃改动（无二次确认，保持轻量）
 */

import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '../../store/useAppStore'
import type { Mode, Node } from '../../lib/types'
import {
  getTemplate,
  getTypeOptions,
  stripMetaKeys,
} from '../../lib/nodeTemplates'

export interface NodeEditorProps {
  /** 是否显示。 */
  open: boolean
  /** 待编辑节点（为 null 时不渲染内容）。 */
  node: Node | null
  /** 当前图谱模式（决定类型枚举与模板）。 */
  graphType: Mode
  /** 关闭回调（取消 / 遮罩 / Esc）。 */
  onClose: () => void
  /** 保存成功后回调（父组件可据此刷新或关闭）。 */
  onSaved?: () => void
}

export function NodeEditor({
  open,
  node,
  graphType,
  onClose,
  onSaved,
}: NodeEditorProps) {
  const updateNode = useAppStore((s) => s.updateNode)

  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [type, setType] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // 节点变化时同步表单初值
  useEffect(() => {
    if (!open || !node) return
    setTitle(node.title || '')
    setSummary(node.summary || '')
    setType(node.type || '')
    const pure = stripMetaKeys(node.detail_payload || {})
    const strFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(pure)) {
      strFields[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
    }
    setFields(strFields)
  }, [open, node])

  // 类型切换时模板变化：保留旧字段值，新模板字段若无值则置空
  const template = useMemo(() => getTemplate(graphType, type), [graphType, type])
  const typeOptions = useMemo(() => getTypeOptions(graphType), [graphType])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !node) return null

  const handleFieldChange = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    if (!node) return
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setSaving(true)
    // 组装 detail_payload：仅当前模板字段 + 保留原下划线元数据键
    const detailPayload: Record<string, unknown> = {}
    // 保留原 detail_payload 中的元数据键（_important_points 等），避免丢失已生成内容
    for (const [k, v] of Object.entries(node.detail_payload || {})) {
      if (k.startsWith('_')) detailPayload[k] = v
    }
    for (const f of template) {
      detailPayload[f.key] = fields[f.key] ?? ''
    }
    const ok = await updateNode(node.id, {
      title: trimmedTitle,
      summary,
      type,
      detail_payload: detailPayload,
    })
    setSaving(false)
    if (ok) {
      onSaved?.()
      onClose()
    }
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-editor-title"
      onClick={onClose}
    >
      <div
        className="node-editor"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="node-editor__header">
          <h3 id="node-editor-title" className="node-editor__title">
            编辑节点
          </h3>
          <button
            type="button"
            className="node-editor__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="node-editor__body">
          <div className="node-editor__row">
            <label className="node-editor__label" htmlFor="ne-title">
              标题
            </label>
            <input
              id="ne-title"
              className="node-editor__input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="节点标题"
              maxLength={255}
            />
          </div>

          <div className="node-editor__row">
            <label className="node-editor__label" htmlFor="ne-type">
              类型
            </label>
            <select
              id="ne-type"
              className="node-editor__select"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {typeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="node-editor__row">
            <label className="node-editor__label" htmlFor="ne-summary">
              概括
            </label>
            <textarea
              id="ne-summary"
              className="node-editor__textarea"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="一句话概括"
              rows={2}
            />
          </div>

          <div className="node-editor__section-title">详情字段</div>
          {template.map((f) => (
            <div className="node-editor__row" key={f.key}>
              <label className="node-editor__label" htmlFor={`ne-${f.key}`}>
                {f.label}
              </label>
              <textarea
                id={`ne-${f.key}`}
                className="node-editor__textarea"
                value={fields[f.key] ?? ''}
                onChange={(e) => handleFieldChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                rows={2}
              />
            </div>
          ))}
        </div>

        <div className="node-editor__footer">
          <button
            type="button"
            className="node-editor__btn node-editor__btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="node-editor__btn node-editor__btn--primary"
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

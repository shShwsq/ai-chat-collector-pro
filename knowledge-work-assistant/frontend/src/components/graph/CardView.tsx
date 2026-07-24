/**
 * 卡片视图（Task 6）。
 *
 * 节点卡片网格：每个节点一张 HTML 卡片，展示标题 / 一句话概括 / 类型标签。
 * - Study 模式：节点卡片网格
 * - Work 模式：当前为简化版，同样以节点卡片网格呈现；
 *   后续 Task 13/14 再细化为今日上下文 / 承诺追踪 / 人物上下文等分组视图
 * - 点击卡片高亮选中，与图谱视图通过 ``store.selectedNodeId`` 双向同步
 * - 灰色节点（``is_gray``）用浅灰背景 + 虚线边框区分
 * - 空状态：图谱无节点时显示引导文案
 *
 * 数据来源：``store.fullGraph``，与 GraphView 共享，切换视图不丢失数据。
 */

import { useAppStore } from '../../store/useAppStore'
import type { Node } from '../../lib/types'

export function CardView() {
  const fullGraph = useAppStore((s) => s.fullGraph)
  const selectedNodeId = useAppStore((s) => s.selectedNodeId)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)

  const nodes = fullGraph?.nodes ?? []

  if (nodes.length === 0) {
    return (
      <div className="cv-empty">
        <div className="cv-empty__title">该图谱还没有节点</div>
        <div className="cv-empty__desc">
          创建节点后，这里会以卡片网格形式展示。Work 模式后续将细化为今日上下文 / 承诺追踪 /
          人物上下文等分组视图。
        </div>
      </div>
    )
  }

  const handleCardClick = (n: Node) => {
    setSelectedNode(selectedNodeId === n.id ? null : n.id)
    // eslint-disable-next-line no-console
    console.log('[CardView] node click', n.id, n.title)
  }

  return (
    <div className="cv-grid">
      {nodes.map((n) => {
        const isSelected = selectedNodeId === n.id
        const isGray = n.is_gray
        return (
          <div
            key={n.id}
            className={[
              'cv-card',
              isGray ? 'is-gray' : '',
              isSelected ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => handleCardClick(n)}
          >
            <div className="cv-card__header">
              <span className="cv-card__title" title={n.title}>
                {n.title || '（无标题）'}
              </span>
            </div>
            {n.summary && <p className="cv-card__summary">{n.summary}</p>}
            <div className="cv-card__footer">
              <span className="cv-card__chip">{n.type || '未分类'}</span>
              {isGray && <span className="cv-card__gray-tag">灰色</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

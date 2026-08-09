/**
 * 图谱选择下拉框（ChatHome / ChatConversationView 输入框正上方共享组件）。
 *
 * 背景：``activeNav === 'chat'`` 时主区只渲染 ``ChatPanel``，``GraphList``
 * 侧栏不显示，用户在对话视图无法切换当前图谱。本组件补上这一入口。
 *
 * 职责：**仅切换已有图谱**；新建仍需去图谱视图（``GraphList`` 顶部「+ 新建」）。
 * 数据：``store.graphs`` / ``currentGraphId`` / ``mode``；切换调 ``selectGraph``。
 *
 * 安全：
 * - ``chatAsking``（对话流式进行中）时禁用下拉框，避免切换清空流式状态丢失请求。
 * - ``selectGraph`` 已处理切换后清理（清空 ``currentChatSession`` / ``chatMessages`` /
 *   流式状态，并按新 ``graph_id`` 重新 ``loadChatSessions``），这里无需重复。
 * - 若 ``currentGraphId`` 不在当前 ``graphs`` 列表内（例如模式切换过渡期），
 *   下拉框回退到占位项，避免显示与实际状态不一致。
 */

import { useEffect } from 'react'

import { useAppStore } from '../store/useAppStore'

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

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value
    if (!id || id === currentGraphId) return
    selectGraph(id)
  }

  const handleGoToGraphView = () => {
    setActiveNav('graph')
  }

  // currentGraphId 不在当前 graphs 列表内时，下拉框回退到空占位
  const selectedValue =
    currentGraphId && graphs.some((g) => g.id === currentGraphId)
      ? currentGraphId
      : ''

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

  return (
    <div className="graph-selector">
      <span className="graph-selector__label" aria-hidden="true">
        图谱
      </span>
      <select
        className="graph-selector__select"
        value={selectedValue}
        onChange={handleChange}
        disabled={chatAsking}
        aria-label="选择当前图谱"
        title={chatAsking ? '对话进行中，暂不可切换图谱' : '切换当前图谱'}
      >
        {!selectedValue && (
          <option value="" disabled>
            请选择图谱
          </option>
        )}
        {graphs.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </div>
  )
}

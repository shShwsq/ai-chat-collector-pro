/**
 * 内容区工具栏（Task 6 / Task 8 / Task 12）。
 *
 * 位于内容区顶部，包含：
 * - 当前图谱名（左侧）
 * - 视图切换 toggle：「图谱视图 / 卡片视图」（中间或右侧）
 * - 「重新布局」按钮（仅图谱视图时显示，调用 GraphView 暴露的 relayout）
 * - 「撤销延伸」按钮（Task 8，仅 ``extensionBatchId`` 存在时显示）
 * - 「开始测验」按钮（Task 12，仅 study 模式可见，打开 QuizPanel 浮层）
 *
 * 视图切换 toggle 与右上角 ModeSwitch（study/work 模式）职责不同：
 * - ModeSwitch 切换的是数据模式（图谱隔离）
 * - 本 toggle 切换的是同一图谱的呈现方式（图谱 / 卡片），数据共享不丢失
 *
 * 样式上采用与 ModeSwitch 一致的胶囊式分段控件，但更轻量（无副标题），
 * 强调色随当前模式（``--accent``）联动。
 */

import { useAppStore } from '../store/useAppStore'
import type { ViewType } from '../lib/types'
import type { WorkPanel } from '../store/useAppStore'
import { Icon } from './Icon'

const VIEWS: { value: ViewType; label: string }[] = [
  { value: 'graph', label: '图谱视图' },
  { value: 'card', label: '卡片视图' },
]

/** Work 模式工具按钮配置（Task 13/14/15/16）。 */
const WORK_TOOLS: {
  panel: WorkPanel
  label: string
  activeLabel: string
  title: string
  icon: string
}[] = [
  {
    panel: 'input',
    label: '工作对象',
    activeLabel: '关闭抽取',
    title: '从文本抽取工作对象并加入图谱',
    icon: '＋',
  },
  {
    panel: 'trends',
    label: '风口推荐',
    activeLabel: '关闭风口',
    title: '生成行业风口推荐并加入图谱',
    icon: '◎',
  },
  {
    panel: 'report',
    label: '工作报告',
    activeLabel: '关闭报告',
    title: '生成工作报告并导出 / 打印',
    icon: '▤',
  },
  {
    panel: 'qa',
    label: '提问',
    activeLabel: '关闭提问',
    title: '基于图谱上下文对话式提问',
    icon: '？',
  },
]

export interface ContentToolbarProps {
  /** 当前图谱名（无选中时为空）。 */
  graphName?: string
  /** 「重新布局」按钮回调（仅图谱视图显示）。 */
  onRelayout?: () => void
}

export function ContentToolbar({ graphName, onRelayout }: ContentToolbarProps) {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const mode = useAppStore((s) => s.mode)
  // Task 8：撤销延伸
  const extensionBatchId = useAppStore((s) => s.extensionBatchId)
  const extending = useAppStore((s) => s.extending)
  const revokeExtend = useAppStore((s) => s.revokeExtend)
  // Task 12：测验面板
  const quizPanelOpen = useAppStore((s) => s.quizPanelOpen)
  const setQuizPanelOpen = useAppStore((s) => s.setQuizPanelOpen)
  // Task 13/14/15/16：Work 模式业务面板
  const workActivePanel = useAppStore((s) => s.workActivePanel)
  const setWorkPanel = useAppStore((s) => s.setWorkPanel)

  const handleRevoke = () => {
    if (extending) return
    void revokeExtend()
  }

  const handleToggleQuiz = () => {
    setQuizPanelOpen(!quizPanelOpen)
  }

  const handleToggleWorkPanel = (panel: WorkPanel) => {
    // 再次点击当前激活面板则关闭，否则切换
    setWorkPanel(workActivePanel === panel ? 'none' : panel)
  }

  return (
    <div className="content-toolbar">
      <div className="content-toolbar__left">
        <span className="content-toolbar__graph-name" title={graphName}>
          {graphName ?? '未选择图谱'}
        </span>
      </div>
      <div className="content-toolbar__right">
        {view === 'graph' && onRelayout && (
          <button
            type="button"
            className="content-toolbar__btn"
            onClick={onRelayout}
            title="重新进行力导向布局"
          >
            重新布局
          </button>
        )}
        {/* Task 8：撤销延伸（仅 extensionBatchId 存在时显示） */}
        {extensionBatchId && (
          <button
            type="button"
            className="content-toolbar__btn content-toolbar__btn--revoke"
            onClick={handleRevoke}
            disabled={extending}
            title="撤销上一次全部延伸（删除该批灰色节点与边）"
          >
            {extending ? '撤销中…' : '↶ 撤销延伸'}
          </button>
        )}
        {/* Task 12：开始测验（仅 study 模式可见） */}
        {mode === 'study' && (
          <button
            type="button"
            className={`content-toolbar__btn content-toolbar__btn--quiz${quizPanelOpen ? ' is-active' : ''}`}
            onClick={handleToggleQuiz}
            title={quizPanelOpen ? '关闭测验面板' : '打开测验面板，基于图谱节点出题'}
            aria-pressed={quizPanelOpen}
          >
            {quizPanelOpen ? '关闭测验' : (<><Icon name="edit" size={14} /> 开始测验</>)}
          </button>
        )}
        {/* Task 13/14/15/16：Work 模式工具按钮（仅 work 模式可见） */}
        {mode === 'work' &&
          WORK_TOOLS.map((tool) => {
            const active = workActivePanel === tool.panel
            return (
              <button
                key={tool.panel}
                type="button"
                className={`content-toolbar__btn content-toolbar__btn--work${active ? ' is-active' : ''}`}
                onClick={() => handleToggleWorkPanel(tool.panel)}
                title={active ? tool.activeLabel : tool.title}
                aria-pressed={active}
              >
                <span className="content-toolbar__btn-icon">{tool.icon}</span>
                {active ? tool.activeLabel : tool.label}
              </button>
            )
          })}
        <div className="view-switch" role="tablist" aria-label="视图切换：图谱 / 卡片">
          {VIEWS.map((v) => {
            const active = view === v.value
            return (
              <button
                key={v.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={`view-switch__btn${active ? ' is-active' : ''}`}
                onClick={() => setView(v.value)}
              >
                {v.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

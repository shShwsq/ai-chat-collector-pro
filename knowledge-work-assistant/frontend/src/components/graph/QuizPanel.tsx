/**
 * Study 测验面板（Task 12）。
 *
 * 从内容区右侧滑入的浮层，承载三段式测验流程 + 历史复盘：
 *
 *   ① **配置阶段（config）**：选择题型（单选 / 多选 / 费曼解释）+
 *      可选限定节点范围（默认全图随机），点「生成题目」调
 *      ``store.generateQuiz`` → Agent 生成并落库，进入作答阶段。
 *
 *   ② **作答阶段（answering）**：
 *      - 选择题：渲染 question + options（单选 radio / 多选 checkbox），
 *        「提交答案」调 ``store.answerQuiz``，本地判分后进入结果阶段。
 *      - 费曼题：渲染 prompt + textarea，「提交解释」调
 *        ``store.answerQuiz``，Agent 语义判分后进入结果阶段。
 *      - 降级题目（``payload.degraded``）显示橙色提示条。
 *
 *   ③ **结果阶段（result）**：
 *      - 选择题：选项回显（正确绿、用户错选红、未选正确答案加边），
 *        展示正确答案、解析、对错徽标。
 *      - 费曼题：展示评分、理解度等级徽标、反馈文本、
 *        未覆盖要点、参考要点（作答后回显）。
 *      - 「再来一题」回到配置阶段。
 *
 *   ④ **历史复盘**：底部折叠区列出该图谱全部测验历史（按创建时间倒序），
 *      点击单条调 ``store.reviewQuiz`` 重新进入对应阶段。
 *
 * 数据流：
 * - 题目 payload 在服务端已剥离 ``correct_answers`` / ``reference_points``，
 *   作答前不可见；作答后由 answer 接口返回。
 * - 选择题判分在后端本地完成（严格集合相等），不调用 LLM；
 *   费曼题判分转交 ``graph_agent.grade_feynman``，LLM 不可用时降级为关键词覆盖率。
 *
 * 交互：
 * - 面板由 ``store.quizPanelOpen`` 控制显隐，关闭时滑出右侧并卸载内部状态。
 * - 生成 / 作答进行中显示加载态并禁用按钮，避免并发触发。
 * - 仅 study 模式可见入口（ContentToolbar「开始测验」按钮），work 模式不展示。
 * - 面板打开时自动加载当前图谱测验历史。
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon } from '../Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useAppStore } from '../../store/useAppStore'
import type {
  ChoiceGradeResult,
  FeynmanGradeResult,
  Node,
  Quiz,
  QuizOption,
  QuizType,
} from '../../lib/types'
import { formatShortTime } from '../../lib/date'

/** 题型显示名映射。 */
const QUIZ_TYPE_LABEL: Record<QuizType, string> = {
  single_choice: '单选题',
  multi_choice: '多选题',
  feynman: '费曼解释题',
}

/** 题型简短描述（用于配置阶段说明）。 */
const QUIZ_TYPE_DESC: Record<QuizType, string> = {
  single_choice: '从若干选项中选出一个正确答案，本地即时判分。',
  multi_choice: '从若干选项中选出全部正确答案，严格集合相等判分。',
  feynman: '用自己的话解释知识点，Agent 语义判分并给理解度评分。',
}

/** 理解度等级对应徽标文案与样式类名。 */
function understandingLevelMeta(
  level: 'good' | 'partial' | 'poor',
): { label: string; cls: string } {
  if (level === 'good') return { label: '理解到位', cls: 'is-good' }
  if (level === 'partial') return { label: '部分掌握', cls: 'is-partial' }
  return { label: '需加强', cls: 'is-poor' }
}

/** 从 quiz.payload 中安全读取字符串字段。 */
function payloadStr(
  payload: Record<string, unknown> | undefined,
  key: string,
): string {
  if (!payload) return ''
  const v = payload[key]
  return typeof v === 'string' ? v : ''
}

/** 从 quiz.payload 中安全读取 options 数组。 */
function payloadOptions(
  payload: Record<string, unknown> | undefined,
): QuizOption[] {
  if (!payload) return []
  const v = payload.options
  return Array.isArray(v) ? (v as QuizOption[]) : []
}

/** 从 quiz.payload 中读取 degraded 标记。 */
function payloadDegraded(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false
  return Boolean(payload.degraded)
}

/** 从 quiz.payload 中读取降级原因。 */
function payloadDegradeReason(
  payload: Record<string, unknown> | undefined,
): string {
  if (!payload) return ''
  const v = payload.degrade_reason
  return typeof v === 'string' ? v : ''
}

export function QuizPanel() {
  const open = useAppStore((s) => s.quizPanelOpen)
  const setQuizPanelOpen = useAppStore((s) => s.setQuizPanelOpen)
  const stage = useAppStore((s) => s.quizStage)
  const quizType = useAppStore((s) => s.quizType)
  const setQuizType = useAppStore((s) => s.setQuizType)
  const quizNodeIds = useAppStore((s) => s.quizNodeIds)
  const setQuizNodeIds = useAppStore((s) => s.setQuizNodeIds)
  const currentQuiz = useAppStore((s) => s.currentQuiz)
  const quizHistory = useAppStore((s) => s.quizHistory)
  const generatingQuiz = useAppStore((s) => s.generatingQuiz)
  const answeringQuiz = useAppStore((s) => s.answeringQuiz)
  const loadingQuizHistory = useAppStore((s) => s.loadingQuizHistory)
  const generateQuiz = useAppStore((s) => s.generateQuiz)
  const answerQuiz = useAppStore((s) => s.answerQuiz)
  const loadQuizHistory = useAppStore((s) => s.loadQuizHistory)
  const clearQuiz = useAppStore((s) => s.clearQuiz)
  const reviewQuiz = useAppStore((s) => s.reviewQuiz)
  const currentGraphId = useAppStore((s) => s.currentGraphId)
  const fullGraph = useAppStore((s) => s.fullGraph)

  // 用户作答本地态：选择题为选项 id 集合，费曼题为文本
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [feynmanText, setFeynmanText] = useState('')
  // 节点范围筛选：true = 全图随机；false = 限定节点
  const [scopeAll, setScopeAll] = useState(true)
  // 主题关键词（可选，输入后从标题/摘要匹配节点）
  const [topic, setTopic] = useState('')
  // 历史折叠
  const [historyCollapsed, setHistoryCollapsed] = useState(false)

  // 题目切换时重置作答本地态
  useEffect(() => {
    setSelectedIds(new Set())
    setFeynmanText('')
  }, [currentQuiz?.id])

  // 面板打开时自动拉取历史
  useEffect(() => {
    if (open) void loadQuizHistory()
  }, [open, loadQuizHistory, currentGraphId])

  const graphNodes: Node[] = useMemo(() => fullGraph?.nodes ?? [], [fullGraph])

  const handleClose = () => setQuizPanelOpen(false)
  const dialogRef = useDialogFocus<HTMLElement>({
    active: open,
    initialFocus: '.quiz-panel__close',
    resetKey: stage,
    onEscape: handleClose,
  })

  if (!open) return null

  const handleGenerate = async () => {
    if (generatingQuiz) return
    // 如果填写了主题关键词，从全图节点中筛选标题/摘要包含关键词的节点
    const topicKw = topic.trim()
    if (topicKw) {
      const kw = topicKw.toLowerCase()
      const matched = graphNodes.filter(
        (n) =>
          n.title.toLowerCase().includes(kw) ||
          (n.summary && n.summary.toLowerCase().includes(kw)),
      )
      if (matched.length > 0) {
        setQuizNodeIds(matched.map((n) => n.id))
        setScopeAll(false)
      } else {
        // 无匹配节点，回退到全图
        setQuizNodeIds(null)
        setScopeAll(true)
      }
    } else if (scopeAll) {
      setQuizNodeIds(null)
    }
    await generateQuiz()
  }

  const handleToggleOption = (id: string) => {
    if (answeringQuiz) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (quizType === 'single_choice') {
        // 单选：仅保留当前
        next.clear()
        next.add(id)
      } else {
        // 多选：切换
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const handleSubmitAnswer = async () => {
    if (answeringQuiz) return
    if (quizType === 'feynman') {
      if (!feynmanText.trim()) return
      await answerQuiz(feynmanText)
    } else {
      if (selectedIds.size === 0) return
      await answerQuiz(Array.from(selectedIds))
    }
  }

  const handleAnother = () => {
    clearQuiz()
  }

  const handleReview = (quizId: string) => {
    if (loadingQuizHistory) return
    void reviewQuiz(quizId)
  }

  return (
    <>
      {/* 遮罩：点击关闭面板 */}
      <div className="quiz-overlay" onClick={handleClose} aria-hidden="true" />

      <aside
        ref={dialogRef}
        className="quiz-panel"
        role="dialog"
        aria-label="Study 测验"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="quiz-panel__header">
          <div className="quiz-panel__title-row">
            <h2 className="quiz-panel__title">Study 测验</h2>
            <button
              type="button"
              className="quiz-panel__close"
              onClick={handleClose}
              aria-label="关闭面板"
              title="关闭"
            >
              ×
            </button>
          </div>
          <p className="quiz-panel__subtitle">
            基于当前图谱节点生成测验题，作答后即时判分并给解析。
          </p>
        </header>

        {/* 主体（可滚动） */}
        <div className="quiz-panel__body">
          {/* 阶段切换条 */}
          <div className="quiz-stage-bar" role="tablist" aria-label="测验阶段">
            {(['config', 'answering', 'result'] as const).map((s, i) => {
              const labels = ['配置', '作答', '结果']
              const active = stage === s
              const reached =
                // 当前阶段或之后的阶段都视为"已到达"
                ['config', 'answering', 'result'].indexOf(stage) >= i
              return (
                <div
                  key={s}
                  className={`quiz-stage-bar__item${active ? ' is-active' : ''}${reached ? ' is-reached' : ''}`}
                  role="tab"
                  aria-selected={active}
                >
                  <span className="quiz-stage-bar__dot">{i + 1}</span>
                  <span className="quiz-stage-bar__label">{labels[i]}</span>
                </div>
              )
            })}
          </div>

          {/* 阶段内容 */}
          {stage === 'config' && (
            <ConfigStage
              quizType={quizType}
              onTypeChange={setQuizType}
              scopeAll={scopeAll}
              onScopeChange={setScopeAll}
              selectedNodeIds={quizNodeIds ?? []}
              onSelectNodeIds={setQuizNodeIds}
              graphNodes={graphNodes}
              topic={topic}
              onTopicChange={setTopic}
              generating={generatingQuiz}
              onGenerate={handleGenerate}
              hasGraph={!!currentGraphId}
            />
          )}

          {stage === 'answering' && currentQuiz && (
            <AnsweringStage
              quiz={currentQuiz}
              selectedIds={selectedIds}
              feynmanText={feynmanText}
              onToggleOption={handleToggleOption}
              onFeynmanChange={setFeynmanText}
              answering={answeringQuiz}
              onSubmit={handleSubmitAnswer}
              onBack={handleAnother}
            />
          )}

          {stage === 'result' && currentQuiz && (
            <ResultStage
              quiz={currentQuiz}
              onAnother={handleAnother}
            />
          )}

          {/* 历史复盘区 */}
          <section className="quiz-history">
            <div className="quiz-history__head">
              <h3 className="quiz-history__title">
                测验历史
                <span className="quiz-history__count">
                  {quizHistory.length}
                </span>
              </h3>
              <button
                type="button"
                className="quiz-history__toggle"
                onClick={() => setHistoryCollapsed((v) => !v)}
                title={historyCollapsed ? '展开' : '折叠'}
              >
                {historyCollapsed ? '展开' : '折叠'}
              </button>
            </div>
            {!historyCollapsed && (
              <>
                {loadingQuizHistory && quizHistory.length === 0 ? (
                  <div className="quiz-empty">正在加载测验历史…</div>
                ) : quizHistory.length === 0 ? (
                  <div className="quiz-empty">
                    {currentGraphId
                      ? '暂无测验记录。生成第一道题目后这里会显示历史。'
                      : '请先选中一个图谱。'}
                  </div>
                ) : (
                  <ul className="quiz-history__list">
                    {quizHistory.map((q) => (
                      <HistoryItem
                        key={q.id}
                        quiz={q}
                        isActive={currentQuiz?.id === q.id}
                        onReview={() => handleReview(q.id)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </div>

        {/* 底部状态条 */}
        <footer className="quiz-panel__footer">
          <span className="quiz-panel__footer-text">
            {currentGraphId
              ? '测验将关联到当前图谱节点，便于复盘'
              : (<><Icon name="warning" size={14} /> 未选中图谱，请先在左侧选择一个图谱</>)}
          </span>
        </footer>
      </aside>
    </>
  )
}

// ============================================================================
// 配置阶段
// ============================================================================

interface ConfigStageProps {
  quizType: QuizType
  onTypeChange: (t: QuizType) => void
  scopeAll: boolean
  onScopeChange: (all: boolean) => void
  selectedNodeIds: string[]
  onSelectNodeIds: (ids: string[] | null) => void
  graphNodes: Node[]
  topic: string
  onTopicChange: (t: string) => void
  generating: boolean
  onGenerate: () => void
  hasGraph: boolean
}

function ConfigStage({
  quizType,
  onTypeChange,
  scopeAll,
  onScopeChange,
  selectedNodeIds,
  onSelectNodeIds,
  graphNodes,
  topic,
  onTopicChange,
  generating,
  onGenerate,
  hasGraph,
}: ConfigStageProps) {
  const types: QuizType[] = ['single_choice', 'multi_choice', 'feynman']
  const toggleNode = (id: string) => {
    if (scopeAll) onScopeChange(false)
    const set = new Set(selectedNodeIds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    onSelectNodeIds(Array.from(set))
  }
  return (
    <section className="quiz-stage">
      <h3 className="quiz-stage__title">题目配置</h3>

      {/* 题型选择 */}
      <div className="quiz-field">
        <label className="quiz-field__label">题型</label>
        <div className="quiz-type-options" role="radiogroup">
          {types.map((t) => {
            const active = quizType === t
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={active}
                className={`quiz-type-option${active ? ' is-active' : ''}`}
                onClick={() => onTypeChange(t)}
              >
                <span className="quiz-type-option__label">
                  {QUIZ_TYPE_LABEL[t]}
                </span>
                <span className="quiz-type-option__desc">
                  {QUIZ_TYPE_DESC[t]}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 节点范围 */}
      <div className="quiz-field">
        <label className="quiz-field__label">题目涉及节点</label>
        <div className="quiz-scope-toggle" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={scopeAll}
            className={`quiz-scope-toggle__btn${scopeAll ? ' is-active' : ''}`}
            onClick={() => onScopeChange(true)}
          >
            全图随机
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!scopeAll}
            className={`quiz-scope-toggle__btn${!scopeAll ? ' is-active' : ''}`}
            onClick={() => onScopeChange(false)}
            disabled={graphNodes.length === 0}
          >
            指定节点（{selectedNodeIds.length}）
          </button>
        </div>
        {!scopeAll && (
          <div className="quiz-node-picker">
            {graphNodes.length === 0 ? (
              <p className="quiz-node-picker__empty">
                当前图谱下暂无节点。可先添加或抽取节点后再来生成测验。
              </p>
            ) : (
              <ul className="quiz-node-picker__list">
                {graphNodes.map((n) => {
                  const checked = selectedNodeIds.includes(n.id)
                  return (
                    <li
                      key={n.id}
                      className={`quiz-node-picker__item${checked ? ' is-checked' : ''}`}
                    >
                      <label className="quiz-node-picker__label">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleNode(n.id)}
                        />
                        <span className="quiz-node-picker__title" title={n.title}>
                          {n.title}
                        </span>
                        <span className="quiz-node-picker__chip">{n.type}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
            {!scopeAll && selectedNodeIds.length === 0 && graphNodes.length > 0 && (
              <p className="quiz-node-picker__hint">
                未勾选任何节点时将退回全图随机。
              </p>
            )}
          </div>
        )}
      </div>

      {/* 主题关键词 */}
      <div className="quiz-field">
        <label className="quiz-field__label" htmlFor="quiz-topic">
          主题关键词
          <span className="quiz-field__hint">（可选）输入后将只围绕相关节点出题</span>
        </label>
        <input
          id="quiz-topic"
          type="text"
          className="quiz-topic-input"
          value={topic}
          onChange={(e) => onTopicChange(e.target.value)}
          placeholder="如：Python 基础、HTTP 协议…"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* 生成按钮 */}
      <div className="quiz-actions">
        <button
          type="button"
          className="quiz-actions__btn quiz-actions__btn--primary"
          onClick={onGenerate}
          disabled={generating || !hasGraph}
          title={
            !hasGraph
              ? '请先选中一个图谱'
              : generating
                ? '正在生成题目…'
                : '生成一道测验题'
          }
        >
          {generating ? '生成中…' : '生成题目'}
        </button>
      </div>
    </section>
  )
}

// ============================================================================
// 作答阶段
// ============================================================================

interface AnsweringStageProps {
  quiz: Quiz
  selectedIds: Set<string>
  feynmanText: string
  onToggleOption: (id: string) => void
  onFeynmanChange: (text: string) => void
  answering: boolean
  onSubmit: () => void
  onBack: () => void
}

function AnsweringStage({
  quiz,
  selectedIds,
  feynmanText,
  onToggleOption,
  onFeynmanChange,
  answering,
  onSubmit,
  onBack,
}: AnsweringStageProps) {
  const payload = (quiz.payload ?? {}) as Record<string, unknown>
  const isFeynman = quiz.type === 'feynman'
  const question = payloadStr(payload, 'question')
  const prompt = payloadStr(payload, 'prompt')
  const options = payloadOptions(payload)
  const degraded = payloadDegraded(payload)
  const degradeReason = payloadDegradeReason(payload)

  return (
    <section className="quiz-stage">
      <div className="quiz-stage__head">
        <span className="quiz-stage__chip">{QUIZ_TYPE_LABEL[quiz.type]}</span>
        <span className="quiz-stage__time">
          生成于 {formatShortTime(quiz.created_at)}
        </span>
      </div>

      {degraded && (
        <div className="quiz-degraded-tip" role="status">
          <strong>降级提示：</strong>
          {degradeReason || '题目生成服务暂不可用，已生成占位题，可继续作答。'}
        </div>
      )}

      {isFeynman ? (
        <>
          <div className="quiz-question">
            <h4 className="quiz-question__title">请用自己的话解释以下知识点</h4>
            <p className="quiz-question__prompt">{prompt || '（题目未提供提示）'}</p>
          </div>
          <div className="quiz-field">
            <label className="quiz-field__label" htmlFor="quiz-feynman-text">
              你的解释
            </label>
            <textarea
              id="quiz-feynman-text"
              className="quiz-textarea"
              value={feynmanText}
              onChange={(e) => onFeynmanChange(e.target.value)}
              placeholder="尝试像在向别人讲解一样，把你知道的写出来…"
              rows={8}
              disabled={answering}
              autoFocus
            />
            <p className="quiz-field__hint">
              越具体越好；Agent 将从要点覆盖率与语义完整度两方面评分。
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="quiz-question">
            <h4 className="quiz-question__title">
              {question || '（题目未提供文本）'}
            </h4>
          </div>
          <ul className="quiz-options">
            {options.map((opt) => {
              const checked = selectedIds.has(opt.id)
              const inputType = quiz.type === 'single_choice' ? 'radio' : 'checkbox'
              const name = `quiz-${quiz.id}`
              return (
                <li
                  key={opt.id}
                  className={`quiz-option${checked ? ' is-checked' : ''}`}
                >
                  <label className="quiz-option__label">
                    <input
                      type={inputType}
                      name={name}
                      checked={checked}
                      onChange={() => onToggleOption(opt.id)}
                      disabled={answering}
                    />
                    <span className="quiz-option__id">{opt.id}</span>
                    <span className="quiz-option__text">{opt.text}</span>
                  </label>
                </li>
              )
            })}
            {options.length === 0 && (
              <li className="quiz-empty">本题未提供选项。</li>
            )}
          </ul>
          <p className="quiz-field__hint">
            {quiz.type === 'single_choice'
              ? '单选题：选择一个最合适的答案。'
              : '多选题：选择全部正确答案（部分对算错）。'}
          </p>
        </>
      )}

      <div className="quiz-actions">
        <button
          type="button"
          className="quiz-actions__btn quiz-actions__btn--ghost"
          onClick={onBack}
          disabled={answering}
        >
          返回配置
        </button>
        <button
          type="button"
          className="quiz-actions__btn quiz-actions__btn--primary"
          onClick={onSubmit}
          disabled={
            answering ||
            (isFeynman ? !feynmanText.trim() : selectedIds.size === 0)
          }
          title={
            isFeynman
              ? !feynmanText.trim()
                ? '请输入解释'
                : '提交解释并判分'
              : selectedIds.size === 0
                ? '请至少选择一个选项'
                : '提交答案并判分'
          }
        >
          {answering ? '判分中…' : '提交答案'}
        </button>
      </div>
    </section>
  )
}

// ============================================================================
// 结果阶段
// ============================================================================

interface ResultStageProps {
  quiz: Quiz
  onAnother: () => void
}

function ResultStage({ quiz, onAnother }: ResultStageProps) {
  const grade = useAppStore((s) => s.quizGradeResult)
  if (!grade) {
    // 已作答但 grade 缺失：尝试从 quiz.result 重建显示（仅显示原始 result）
    return (
      <section className="quiz-stage">
        <div className="quiz-empty">
          暂无判分结果。可点击「再来一题」开始新测验。
        </div>
        <div className="quiz-actions">
          <button
            type="button"
            className="quiz-actions__btn quiz-actions__btn--primary"
            onClick={onAnother}
          >
            再来一题
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="quiz-stage">
      <ResultContent quiz={quiz} grade={grade} />
      <div className="quiz-actions">
        <button
          type="button"
          className="quiz-actions__btn quiz-actions__btn--primary"
          onClick={onAnother}
        >
          再来一题
        </button>
      </div>
    </section>
  )
}

function ResultContent({
  quiz,
  grade,
}: {
  quiz: Quiz
  grade: ChoiceGradeResult | FeynmanGradeResult
}) {
  if (grade.type === 'feynman') {
    const meta = understandingLevelMeta(grade.understanding_level)
    return (
      <>
        <div className="quiz-result-head">
          <span className="quiz-stage__chip">{QUIZ_TYPE_LABEL[quiz.type]}</span>
          <span className={`quiz-score-badge ${meta.cls}`}>
            {grade.score} 分 · {meta.label}
          </span>
        </div>

        {grade.degraded && (
          <div className="quiz-degraded-tip" role="status">
            <strong>降级提示：</strong>
            {grade.degrade_reason || 'LLM 不可用，已基于关键词覆盖率判分。'}
          </div>
        )}

        <div className="quiz-question">
          <h4 className="quiz-question__title">题目提示</h4>
          <p className="quiz-question__prompt">{grade.prompt || '—'}</p>
        </div>

        <div className="quiz-result-block">
          <h5 className="quiz-result-block__title">你的解释</h5>
          <p className="quiz-result-block__text">
            {String(
              (quiz.result as Record<string, unknown> | undefined)?.user_answer ??
                '—',
            )}
          </p>
        </div>

        <div className="quiz-result-block">
          <h5 className="quiz-result-block__title">Agent 反馈</h5>
          <p className="quiz-result-block__text">
            {grade.feedback || '（无反馈）'}
          </p>
        </div>

        {grade.missed_points.length > 0 && (
          <div className="quiz-result-block">
            <h5 className="quiz-result-block__title">未覆盖的要点</h5>
            <ul className="quiz-points-list">
              {grade.missed_points.map((p, i) => (
                <li key={i} className="quiz-points-list__item">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}

        {grade.reference_points.length > 0 && (
          <div className="quiz-result-block">
            <h5 className="quiz-result-block__title">参考要点</h5>
            <ul className="quiz-points-list">
              {grade.reference_points.map((p, i) => (
                <li key={i} className="quiz-points-list__item quiz-points-list__item--ref">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    )
  }

  // 选择题结果
  const userSet = new Set(grade.user_answer)
  const correctSet = new Set(grade.correct_answers)
  return (
    <>
      <div className="quiz-result-head">
        <span className="quiz-stage__chip">{QUIZ_TYPE_LABEL[quiz.type]}</span>
        <span
          className={`quiz-score-badge ${grade.correct ? 'is-correct' : 'is-wrong'}`}
        >
          {grade.correct
            ? (<><Icon name="check" size={14} /> 回答正确</>)
            : (<><Icon name="error" size={14} /> 回答错误</>)}
        </span>
      </div>

      {grade.degraded && (
        <div className="quiz-degraded-tip" role="status">
          <strong>降级提示：</strong>
          本题为降级占位题，判分仅供形式参考。
        </div>
      )}

      <div className="quiz-question">
        <h4 className="quiz-question__title">
          {payloadStr(quiz.payload, 'question') || '（题目未提供文本）'}
        </h4>
      </div>

      <ul className="quiz-options quiz-options--result">
        {grade.options.map((opt) => {
          const isUser = userSet.has(opt.id)
          const isCorrect = correctSet.has(opt.id)
          // 用户选错：红；正确答案（无论用户是否选对）：绿；其它：默认
          let cls = ''
          if (isCorrect) cls = ' is-correct'
          if (isUser && !isCorrect) cls = ' is-wrong'
          return (
            <li key={opt.id} className={`quiz-option${cls}`}>
              <span className="quiz-option__id">{opt.id}</span>
              <span className="quiz-option__text">{opt.text}</span>
              <span className="quiz-option__tag">
                {isCorrect ? '正确答案' : isUser ? '你的选择' : ''}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="quiz-result-block">
        <h5 className="quiz-result-block__title">解析</h5>
        <p className="quiz-result-block__text">
          {grade.explanation || '（无解析）'}
        </p>
      </div>

      <div className="quiz-result-block">
        <h5 className="quiz-result-block__title">你的答案</h5>
        <p className="quiz-result-block__text">
          {grade.user_answer.length > 0 ? grade.user_answer.join('、') : '（未作答）'}
        </p>
      </div>
    </>
  )
}

// ============================================================================
// 历史项
// ============================================================================

function HistoryItem({
  quiz,
  isActive,
  onReview,
}: {
  quiz: Quiz
  isActive: boolean
  onReview: () => void
}) {
  const payload = (quiz.payload ?? {}) as Record<string, unknown>
  const title =
    quiz.type === 'feynman'
      ? payloadStr(payload, 'prompt')
      : payloadStr(payload, 'question')
  const preview = title.length > 60 ? title.slice(0, 60) + '…' : title || '（无题目文本）'
  const result = (quiz.result ?? {}) as Record<string, unknown>
  // 选择题：取 correct；费曼题：取 score / understanding_level
  let badge: { text: string; cls: string } | null = null
  if (quiz.answered) {
    if (quiz.type === 'feynman') {
      const level = (result.understanding_level as 'good' | 'partial' | 'poor') ?? 'poor'
      const meta = understandingLevelMeta(level)
      badge = {
        text: `${Number(result.score ?? 0)}分·${meta.label}`,
        cls: meta.cls,
      }
    } else {
      badge = {
        text: result.correct ? '正确' : '错误',
        cls: result.correct ? 'is-good' : 'is-poor',
      }
    }
  } else {
    badge = { text: '未答', cls: 'is-pending' }
  }
  return (
    <li
      className={`quiz-history__item${isActive ? ' is-active' : ''}`}
    >
      <button
        type="button"
        className="quiz-history__btn"
        onClick={onReview}
        title="点击复盘这道题"
      >
        <div className="quiz-history__row">
          <span className="quiz-history__type">
            {QUIZ_TYPE_LABEL[quiz.type]}
          </span>
          <span className={`quiz-history__badge ${badge.cls}`}>
            {badge.text}
          </span>
        </div>
        <p className="quiz-history__preview">{preview}</p>
        <div className="quiz-history__meta">
          <span>{formatShortTime(quiz.created_at)}</span>
          {quiz.answered_at && (
            <span className="quiz-history__answered">作答 {formatShortTime(quiz.answered_at)}</span>
          )}
        </div>
      </button>
    </li>
  )
}

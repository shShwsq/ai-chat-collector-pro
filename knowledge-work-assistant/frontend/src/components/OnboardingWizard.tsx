/**
 * 全屏引导向导（Windows 安装风格）。
 *
 * 设计目标：
 * - 应用首次启动时全屏覆盖，逐步引导用户了解核心概念与操作入口
 * - 视觉风格参考 Windows OOBE / 安装向导：深色背景 + 玻璃质感卡片 +
 *   顶部进度条 + 步骤点指示器 + 底部「上一步 / 下一步 / 跳过 / 开始使用」按钮
 * - 通过 ``localStorage[kwa_onboarding_done]`` 标记完成，下次启动不再显示
 * - 设置页可重置标记，重新触发引导
 *
 * 步骤（共 6 步）：
 *   1. 欢迎：介绍知识工作助手定位
 *   2. 双模式：Study 学习 / Work 工作模式切换
 *   3. 知识图谱：创建图谱、节点延伸与撤销
 *   4. AI 抽取：浏览器插件采集对话 → Agent 抽取候选节点
 *   5. 测验与报告：Study 模式测验 / Work 模式报告
 *   6. LLM 配置：提示前往设置页配置 AI 凭据（已配置则显示「已就绪」）
 *
 * 交互：
 * - 顶部进度条 + 步骤点指示当前进度
 * - 每步左侧图示（SVG 简笔）+ 右侧标题与说明
 * - 底部按钮：跳过 / 上一步 / 下一步 / 开始使用
 * - ESC 键跳过引导；Enter / Space 进入下一步
 * - 完成时写入 localStorage 标记并触发 onFinish 回调
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { useAppStore } from '../store/useAppStore'

/** localStorage 键：标记引导是否已完成。 */
export const ONBOARDING_STORAGE_KEY = 'kwa_onboarding_done'

/** 读取引导是否已完成（启动时调用）。 */
export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
  } catch {
    // localStorage 不可用（隐私模式 / file:// 受限）时默认未完成
    return false
  }
}

/** 标记引导完成。 */
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
  } catch {
    // 静默忽略写入失败
  }
}

/** 重置引导标记（设置页「重新查看引导」入口调用）。 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch {
    // 静默忽略
  }
}

/** 单个步骤的元数据定义。 */
interface StepDef {
  id: string
  navLabel: string
  title: string
  subtitle: string
  description: string
  points: Array<{ title: string; detail: string }>
  outcome: string
  graphic: 'welcome' | 'modes' | 'graph' | 'extract' | 'quiz-report' | 'llm'
  primaryLabel?: string
}

/** 6 步引导内容定义。 */
const STEPS: StepDef[] = [
  {
    id: 'welcome',
    navLabel: '开始',
    title: '把聊过的内容，变成以后用得上的知识',
    subtitle: '欢迎使用知识工作助手',
    description:
      '你不需要先学会一套复杂方法。只要把已有对话交给它，再确认哪些内容值得保留，就能逐步建立自己的知识与工作脉络。',
    points: [
      { title: '对话不再沉底', detail: '把零散聊天整理为可查找、可继续补充的节点。' },
      { title: '知识看得见', detail: '用图谱看清主题之间的联系，而不是翻找长聊天记录。' },
      { title: '结果能继续用', detail: '基于图谱复习、提问、延伸思路或生成工作报告。' },
    ],
    outcome: '完成这段引导后，你会知道第一份图谱该从哪里开始。',
    graphic: 'welcome',
  },
  {
    id: 'modes',
    navLabel: '选模式',
    title: '先选一个最符合你当下目标的模式',
    subtitle: '学习与工作互不混杂，随时可以切换',
    description:
      '不用纠结选错。两个模式只是帮你整理不同类型的内容，数据会分别保存，之后可以随时从右上角切换。',
    points: [
      { title: '学习模式', detail: '适合课程、论文、技术学习和长期知识积累。' },
      { title: '工作模式', detail: '适合项目线索、任务承诺、风险和阶段性报告。' },
      { title: '切换不丢进度', detail: '回到原模式时，图谱和当前上下文仍会保留。' },
    ],
    outcome: '建议第一次先选与你今天最想整理的内容一致的模式。',
    graphic: 'modes',
  },
  {
    id: 'graph',
    navLabel: '建图谱',
    title: '你的第一份图谱，只需要一个主题',
    subtitle: '先建立中心，再慢慢补全关系',
    description:
      '创建图谱时，用一个具体主题命名，例如“React 性能优化”或“复赛产品方案”。进入图谱后，从中心节点开始整理即可。',
    points: [
      { title: '单击节点', detail: '查看详情，并补充自己的疑问、联想和结论。' },
      { title: '双击节点', detail: '让 Agent 给出多个可继续探索的方向。' },
      { title: '不满意可撤销', detail: 'AI 延伸不会强迫你保留，始终由你决定图谱结构。' },
    ],
    outcome: '记住最短路径：新建图谱 → 选中节点 → 查看或延伸。',
    graphic: 'graph',
  },
  {
    id: 'extract',
    navLabel: '导对话',
    title: '已有 AI 对话，不需要重新整理一遍',
    subtitle: '让 Agent 先提炼，你只负责确认',
    description:
      '浏览器插件会把支持平台的对话送到“待抽取”。你可以先从一条对话开始，让 Agent 给出候选节点，再决定哪些内容值得进入图谱。',
    points: [
      { title: '先试单条抽取', detail: '确认提炼效果符合预期后，再使用批量抽取。' },
      { title: '候选不会自动入图', detail: '单条抽取需要你勾选确认，避免图谱被无关内容污染。' },
      { title: '等待可以停止', detail: '超过 30 秒会停止等待；服务端请求仍可能继续完成。' },
    ],
    outcome: '推荐第一次选择一段主题明确、长度适中的对话进行尝试。',
    graphic: 'extract',
  },
  {
    id: 'quiz-report',
    navLabel: '用起来',
    title: '图谱的价值，在于帮助你继续行动',
    subtitle: '学习用来巩固，工作用来推进',
    description:
      '当图谱里已经有一些节点后，再使用测验、提问或报告。内容越完整，AI 得到的上下文越清楚，结果也会更有用。',
    points: [
      { title: '学习：开始测验', detail: '用选择题或费曼题检查自己是否真的理解。' },
      { title: '工作：生成报告', detail: '把节点整理为周报或月报，并导出为 Word。' },
      { title: '随时基于图谱提问', detail: '回答会附带来源，方便回到对应节点核对。' },
    ],
    outcome: '先积累 5～10 个有效节点，再体验这些功能会更直观。',
    graphic: 'quiz-report',
  },
  {
    id: 'llm',
    navLabel: '准备完成',
    title: '最后一步：确认 AI 能力是否已就绪',
    subtitle: '未配置也能浏览和手工整理图谱',
    description:
      '节点延伸、对话抽取、测验和报告需要连接兼容 OpenAI 接口的模型服务。密钥只保存在本地设置中，不会在页面中明文回显。',
    points: [
      { title: '需要填写三项', detail: 'Base URL、Model 和 API Key，缺一项都无法调用模型。' },
      { title: '先测试连接', detail: '保存前可以验证地址、模型和密钥是否可用。' },
      { title: '暂时没有也没关系', detail: '可以先创建图谱、手工添加内容，之后再配置。' },
    ],
    outcome: '准备好了就进入应用；你也可以直接前往设置完成配置。',
    graphic: 'llm',
    primaryLabel: '进入应用',
  },
]

interface OnboardingWizardProps {
  /** 引导完成（用户点击「开始使用」或「跳过」）时触发。 */
  onFinish: () => void
}

export function OnboardingWizard({ onFinish }: OnboardingWizardProps) {
  const [step, setStep] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const total = STEPS.length
  const current = STEPS[step]
  const isLast = step === total - 1

  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const llmReady = useAppStore((s) => s.llmConfig?.ready === true)
  const setActiveNav = useAppStore((s) => s.setActiveNav)

  // LLM 步骤根据实际配置状态切换文案
  const llmDisplay = useMemo(() => {
    if (!llmReady) {
      return {
        subtitle: '未配置也能浏览和手工整理图谱',
        description:
          '节点延伸、对话抽取、测验和报告需要连接兼容 OpenAI 接口的模型服务。密钥只保存在本地设置中，不会在页面中明文回显。',
        points: [
          { title: '需要填写三项', detail: 'Base URL、Model 和 API Key，缺一项都无法调用模型。' },
          { title: '先测试连接', detail: '保存前可以验证地址、模型和密钥是否可用。' },
          { title: '暂时没有也没关系', detail: '可以先创建图谱、手工添加内容，之后再配置。' },
        ],
        outcome: '准备好了就进入应用；你也可以直接前往设置完成配置。',
      }
    }
    return {
      subtitle: 'AI 能力已就绪，可以直接使用',
      description:
        '节点延伸、对话抽取、测验和报告都可以直接使用，密钥仅保存在本地，不会在页面中明文回显。',
      points: [
        { title: '模型服务已连接', detail: '可以直接使用抽取、延伸、测验和报告等 AI 功能。' },
        { title: '密钥安全存储', detail: 'API Key 仅保存在本地设置中，页面不会回显完整密钥。' },
        { title: '随时可调整', detail: '如需更换模型或修改配置，可随时前往设置页。' },
      ],
      outcome: 'AI 已准备好，进入应用即可开始使用。',
    }
  }, [llmReady])

  const goNext = useCallback(() => {
    if (isLast) {
      markOnboardingDone()
      onFinish()
    } else {
      setStep((s) => Math.min(s + 1, total - 1))
    }
  }, [isLast, onFinish, total])

  const goPrev = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0))
  }, [])

  const handleSkip = useCallback(() => {
    markOnboardingDone()
    onFinish()
  }, [onFinish])

  /** LLM 配置步骤：点「前往配置」直接完成引导并跳到设置页。 */
  const handleGoSettings = useCallback(() => {
    markOnboardingDone()
    onFinish()
    setActiveNav('settings')
  }, [onFinish, setActiveNav])

  // 步骤切换后将焦点移回标题，方便屏幕阅读器感知内容变化
  useEffect(() => {
    titleRef.current?.focus()
  }, [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleSkip()
        return
      }

      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }

      if ((e.target as HTMLElement | null)?.closest('button, input, textarea, select, a')) {
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, handleSkip])

  // 进度百分比（顶部进度条）
  const progress = useMemo(() => ((step + 1) / total) * 100, [step, total])

  return (
    <div
      ref={dialogRef}
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-label="首次使用引导"
    >
      {/* 顶部进度条 */}
      <div
        className="onboarding__progress-bar"
        role="progressbar"
        aria-label="引导完成进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={step + 1}
        aria-valuetext={`第 ${step + 1} 步，共 ${total} 步`}
      >
        <div className="onboarding__progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* 步骤点指示器 */}
      <div className="onboarding__steps" role="tablist" aria-label="引导步骤">
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'upcoming'
          return (
            <button
              key={s.id}
              id={`onboarding-tab-${s.id}`}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-controls={`onboarding-panel-${s.id}`}
              tabIndex={i === step ? 0 : -1}
              aria-label={`步骤 ${i + 1}：${s.title}`}
              className={`onboarding__step${state === 'current' ? ' is-current' : ''}${
                state === 'done' ? ' is-done' : ''
              }`}
              onClick={() => setStep(i)}
              title={s.title}
            >
              <span className="onboarding__step-dot" aria-hidden="true">
                <span className="onboarding__step-num">{i + 1}</span>
              </span>
              <span className="onboarding__step-label">{s.navLabel}</span>
            </button>
          )
        })}
      </div>

      {/* 主内容区：左侧图示 + 右侧说明 */}
      <div className="onboarding__body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            id={`onboarding-panel-${current.id}`}
            role="tabpanel"
            aria-labelledby={`onboarding-tab-${current.id}`}
            className="onboarding__slide"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="onboarding__graphic">
              <OnboardingGraphic kind={current.graphic} mode={mode} />
            </div>
            <div className="onboarding__text">
              <p className="onboarding__eyebrow">
                第 {step + 1} 步，共 {total} 步
              </p>
              <p className="onboarding__subtitle">
                {current.id === 'llm' ? llmDisplay.subtitle : current.subtitle}
              </p>
              <h2 ref={titleRef} className="onboarding__title" tabIndex={-1}>
                {current.title}
              </h2>
              <p className="onboarding__desc">
                {current.id === 'llm' ? llmDisplay.description : current.description}
              </p>
              {current.id === 'modes' && (
                <div className="onboarding__mode-picker" aria-label="选择开始使用的模式">
                  <button
                    type="button"
                    className={`onboarding__mode-option${mode === 'study' ? ' is-selected' : ''}`}
                    onClick={() => setMode('study')}
                    aria-pressed={mode === 'study'}
                  >
                    <span className="onboarding__mode-name">学习模式</span>
                    <span>整理知识、复习与测验</span>
                  </button>
                  <button
                    type="button"
                    className={`onboarding__mode-option${mode === 'work' ? ' is-selected' : ''}`}
                    onClick={() => setMode('work')}
                    aria-pressed={mode === 'work'}
                  >
                    <span className="onboarding__mode-name">工作模式</span>
                    <span>跟进事项、风险与报告</span>
                  </button>
                </div>
              )}
              {current.id === 'llm' && (
                <div className={`onboarding__readiness${llmReady ? ' is-ready' : ''}`} role="status">
                  <span className="onboarding__readiness-dot" aria-hidden="true" />
                  <span>
                    <strong>{llmReady ? 'AI 能力已就绪' : 'AI 能力尚未配置完整'}</strong>
                    <span>
                      {llmReady
                        ? '可以直接使用抽取、延伸、测验和报告。'
                        : '可先进入应用手工整理，或现在前往设置完成配置。'}
                    </span>
                  </span>
                </div>
              )}
              <div className="onboarding__points">
                {(current.id === 'llm' ? llmDisplay.points : current.points).map((point, index) => (
                  <div key={point.title} className="onboarding__point">
                    <span className="onboarding__point-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="onboarding__point-copy">
                      <strong>{point.title}</strong>
                      <span>{point.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="onboarding__outcome">
                <span className="onboarding__outcome-label">记住这一点</span>
                <span>{current.id === 'llm' ? llmDisplay.outcome : current.outcome}</span>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* 底部操作栏 */}
      <div className="onboarding__footer">
        <button
          type="button"
          className="onboarding__btn onboarding__btn--ghost"
          onClick={handleSkip}
          title="跳过引导（随时可在设置页重新查看）"
        >
          跳过引导
        </button>
        <div className="onboarding__footer-right">
          {step > 0 && (
            <button
              type="button"
              className="onboarding__btn onboarding__btn--ghost"
              onClick={goPrev}
              title="返回上一步（←）"
            >
              上一步
            </button>
          )}
          {current.graphic === 'llm' && (
            <button
              type="button"
              className="onboarding__btn onboarding__btn--secondary"
              onClick={handleGoSettings}
              title="前往设置页配置 LLM"
            >
              前往配置 →
            </button>
          )}
          <button
            type="button"
            className="onboarding__btn onboarding__btn--primary"
            onClick={goNext}
            title={isLast ? '开始使用（Enter）' : '下一步（Enter / →）'}
          >
            {current.primaryLabel ?? (isLast ? '开始使用' : '下一步')}
          </button>
        </div>
      </div>

      {/* 步骤计数（右下角小字） */}
      <div className="onboarding__counter" aria-hidden="true">
        {step + 1} / {total}
      </div>
    </div>
  )
}

// ============================================================================
// 图示：用 SVG 简笔绘制，避免依赖外部图片资源
// ============================================================================

type GraphicKind = StepDef['graphic']

function OnboardingGraphic({ kind, mode }: { kind: GraphicKind; mode: 'study' | 'work' }) {
  switch (kind) {
    case 'welcome':
      return <WelcomeGraphic />
    case 'modes':
      return <ModesGraphic mode={mode} />
    case 'graph':
      return <GraphGraphic />
    case 'extract':
      return <ExtractGraphic />
    case 'quiz-report':
      return <QuizReportGraphic />
    case 'llm':
      return <LlmGraphic />
    default:
      return null
  }
}

/** 通用圆形徽标底（带光晕）。 */
function BadgeBase({ children }: { children: ReactNode }) {
  return (
    <div className="ob-graphic">
      <div className="ob-graphic__halo" aria-hidden="true" />
      <div className="ob-graphic__circle">{children}</div>
    </div>
  )
}

function WelcomeGraphic() {
  return (
    <BadgeBase>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
        {/* 节点 + 边的极简知识图谱 */}
        <line x1="30" y1="35" x2="60" y2="60" stroke="var(--kwa-amber-400)" strokeWidth="2" />
        <line x1="60" y1="60" x2="90" y2="40" stroke="var(--kwa-amber-400)" strokeWidth="2" />
        <line x1="60" y1="60" x2="80" y2="90" stroke="var(--kwa-amber-400)" strokeWidth="2" />
        <line x1="60" y1="60" x2="35" y2="85" stroke="var(--kwa-amber-400)" strokeWidth="2" />
        <circle cx="30" cy="35" r="8" fill="var(--kwa-amber-500)" />
        <circle cx="90" cy="40" r="6" fill="var(--kwa-cyan-500)" />
        <circle cx="80" cy="90" r="7" fill="var(--kwa-amber-400)" />
        <circle cx="35" cy="85" r="6" fill="var(--kwa-cyan-400)" />
        <circle cx="60" cy="60" r="12" fill="var(--kwa-amber-600)" stroke="#fff" strokeWidth="2" />
      </svg>
    </BadgeBase>
  )
}

function ModesGraphic({ mode }: { mode: 'study' | 'work' }) {
  const isStudy = mode === 'study'
  return (
    <BadgeBase>
      <svg width="140" height="80" viewBox="0 0 140 80" fill="none" aria-hidden="true">
        {/* 胶囊开关背景 */}
        <rect x="10" y="20" width="120" height="40" rx="20" fill="var(--kwa-paper-200)" stroke="var(--kwa-border-200)" />
        {/* 指示器滑块：先绘制，文字与圆点在其上方 */}
        <rect
          className={`ob-mode-slider${isStudy ? ' is-study' : ' is-work'}`}
          x="18"
          y="24"
          width="48"
          height="32"
          rx="16"
          fill="var(--kwa-paper-50)"
          stroke="var(--kwa-border-300)"
          strokeWidth="1.5"
        />
        {/* 学习侧 */}
        <circle cx="30" cy="40" r="6" fill={isStudy ? 'var(--kwa-cyan-500)' : 'var(--kwa-text-400)'} />
        <text x="44" y="44" fontSize="11" fill={isStudy ? 'var(--kwa-ink-700)' : 'var(--kwa-text-400)'} fontFamily="var(--font-mono)">学习</text>
        {/* 工作侧 */}
        <text x="78" y="44" fontSize="11" fill={isStudy ? 'var(--kwa-text-400)' : 'var(--kwa-ink-700)'} fontFamily="var(--font-mono)">工作</text>
        <circle cx="115" cy="40" r="6" fill={isStudy ? 'var(--kwa-text-400)' : 'var(--kwa-amber-500)'} />
      </svg>
    </BadgeBase>
  )
}

function GraphGraphic() {
  return (
    <BadgeBase>
      <svg width="140" height="120" viewBox="0 0 140 120" fill="none" aria-hidden="true">
        {/* 中心节点 + 双击延伸 */}
        <line x1="70" y1="60" x2="30" y2="30" stroke="var(--kwa-border-300)" strokeWidth="2" strokeDasharray="4 3" />
        <line x1="70" y1="60" x2="110" y2="30" stroke="var(--kwa-border-300)" strokeWidth="2" strokeDasharray="4 3" />
        <line x1="70" y1="60" x2="30" y2="95" stroke="var(--kwa-border-300)" strokeWidth="2" strokeDasharray="4 3" />
        <line x1="70" y1="60" x2="110" y2="95" stroke="var(--kwa-border-300)" strokeWidth="2" strokeDasharray="4 3" />
        {/* 中心节点（实心） */}
        <circle cx="70" cy="60" r="14" fill="var(--kwa-amber-600)" stroke="#fff" strokeWidth="2" />
        <text x="70" y="64" fontSize="11" fill="#fff" textAnchor="middle" fontFamily="var(--font-mono)" fontWeight="700">主</text>
        {/* 灰色新延伸节点 */}
        <circle cx="30" cy="30" r="8" fill="var(--kwa-paper-300)" stroke="var(--kwa-border-300)" strokeDasharray="2 2" />
        <circle cx="110" cy="30" r="8" fill="var(--kwa-paper-300)" stroke="var(--kwa-border-300)" strokeDasharray="2 2" />
        <circle cx="30" cy="95" r="8" fill="var(--kwa-paper-300)" stroke="var(--kwa-border-300)" strokeDasharray="2 2" />
        <circle cx="110" cy="95" r="8" fill="var(--kwa-paper-300)" stroke="var(--kwa-border-300)" strokeDasharray="2 2" />
      </svg>
    </BadgeBase>
  )
}

function ExtractGraphic() {
  return (
    <BadgeBase>
      <svg width="160" height="100" viewBox="0 0 160 100" fill="none" aria-hidden="true">
        {/* 左：对话气泡 → 中：齿轮(Agent) → 右：候选节点 */}
        <path d="M10 30 Q10 15 25 15 L55 15 Q70 15 70 30 L70 50 Q70 65 55 65 L40 65 L30 75 L32 65 L25 65 Q10 65 10 50 Z"
          fill="var(--kwa-cyan-100)" stroke="var(--kwa-cyan-500)" strokeWidth="1.5" />
        <text x="40" y="42" fontSize="9" fill="var(--kwa-cyan-800)" textAnchor="middle" fontFamily="var(--font-mono)">对话</text>
        {/* 箭头 */}
        <path d="M75 40 L95 40" stroke="var(--kwa-amber-500)" strokeWidth="2" markerEnd="url(#arrow)" />
        {/* Agent 齿轮 */}
        <g transform="translate(110 40)">
          <circle r="14" fill="var(--kwa-amber-100)" stroke="var(--kwa-amber-600)" strokeWidth="1.5" />
          <path d="M0 -10 L0 -14 M7 -7 L10 -10 M10 0 L14 0 M7 7 L10 10 M0 7 L0 11 M-7 7 L-10 10 M-10 0 L-14 0 M-7 -7 L-10 -10"
            stroke="var(--kwa-amber-700)" strokeWidth="1.5" />
          <circle r="5" fill="var(--kwa-amber-600)" />
        </g>
        {/* 箭头 */}
        <path d="M125 40 L140 40" stroke="var(--kwa-amber-500)" strokeWidth="2" markerEnd="url(#arrow)" />
        {/* 候选节点卡片 */}
        <rect x="140" y="25" width="18" height="30" rx="3" fill="var(--kwa-paper-50)" stroke="var(--kwa-amber-400)" strokeWidth="1.5" />
        <line x1="143" y1="32" x2="155" y2="32" stroke="var(--kwa-amber-400)" strokeWidth="1" />
        <line x1="143" y1="37" x2="155" y2="37" stroke="var(--kwa-border-200)" strokeWidth="1" />
        <line x1="143" y1="42" x2="155" y2="42" stroke="var(--kwa-border-200)" strokeWidth="1" />
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 Z" fill="var(--kwa-amber-500)" />
          </marker>
        </defs>
      </svg>
    </BadgeBase>
  )
}

function QuizReportGraphic() {
  return (
    <BadgeBase>
      <svg width="140" height="110" viewBox="0 0 140 110" fill="none" aria-hidden="true">
        {/* 左：测验题（选项） */}
        <rect x="5" y="20" width="55" height="70" rx="4" fill="var(--kwa-paper-50)" stroke="var(--kwa-cyan-500)" strokeWidth="1.5" />
        <line x1="10" y1="30" x2="55" y2="30" stroke="var(--kwa-cyan-500)" strokeWidth="1.5" />
        <text x="32" y="28" fontSize="8" fill="var(--kwa-cyan-700)" textAnchor="middle" fontFamily="var(--font-mono)">测验</text>
        <circle cx="14" cy="42" r="3" fill="var(--kwa-cyan-500)" />
        <line x1="20" y1="42" x2="55" y2="42" stroke="var(--kwa-border-300)" strokeWidth="1" />
        <circle cx="14" cy="52" r="3" fill="none" stroke="var(--kwa-border-400)" strokeWidth="1" />
        <line x1="20" y1="52" x2="55" y2="52" stroke="var(--kwa-border-300)" strokeWidth="1" />
        <circle cx="14" cy="62" r="3" fill="none" stroke="var(--kwa-border-400)" strokeWidth="1" />
        <line x1="20" y1="62" x2="55" y2="62" stroke="var(--kwa-border-300)" strokeWidth="1" />
        <text x="32" y="82" fontSize="9" fill="var(--kwa-cyan-700)" textAnchor="middle" fontFamily="var(--font-mono)" fontWeight="700">✓ 正确</text>

        {/* 右：报告 */}
        <rect x="75" y="20" width="60" height="70" rx="4" fill="var(--kwa-paper-50)" stroke="var(--kwa-amber-500)" strokeWidth="1.5" />
        <text x="105" y="28" fontSize="8" fill="var(--kwa-amber-700)" textAnchor="middle" fontFamily="var(--font-mono)">报告</text>
        <line x1="82" y1="35" x2="128" y2="35" stroke="var(--kwa-amber-500)" strokeWidth="2" />
        <line x1="82" y1="44" x2="120" y2="44" stroke="var(--kwa-border-300)" strokeWidth="1" />
        <line x1="82" y1="50" x2="125" y2="50" stroke="var(--kwa-border-300)" strokeWidth="1" />
        <line x1="82" y1="56" x2="118" y2="56" stroke="var(--kwa-border-300)" strokeWidth="1" />
        {/* 小柱状图 */}
        <rect x="84" y="68" width="6" height="14" fill="var(--kwa-amber-400)" />
        <rect x="93" y="72" width="6" height="10" fill="var(--kwa-amber-500)" />
        <rect x="102" y="65" width="6" height="17" fill="var(--kwa-amber-600)" />
        <rect x="111" y="70" width="6" height="12" fill="var(--kwa-amber-400)" />
      </svg>
    </BadgeBase>
  )
}

function LlmGraphic() {
  return (
    <BadgeBase>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
        {/* 齿轮 + 钥匙（API Key） */}
        <g transform="translate(60 55)">
          <circle r="28" fill="var(--kwa-amber-50)" stroke="var(--kwa-amber-400)" strokeWidth="2" />
          {/* 齿轮齿 */}
          {Array.from({ length: 8 }).map((_, i) => {
            const angle = (i * 45 * Math.PI) / 180
            const x1 = Math.cos(angle) * 28
            const y1 = Math.sin(angle) * 28
            const x2 = Math.cos(angle) * 36
            const y2 = Math.sin(angle) * 36
            return (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--kwa-amber-600)" strokeWidth="4" strokeLinecap="round" />
            )
          })}
          <circle r="10" fill="var(--kwa-amber-600)" />
          <text y="4" fontSize="10" fill="#fff" textAnchor="middle" fontFamily="var(--font-mono)" fontWeight="700">AI</text>
        </g>
        {/* 钥匙 */}
        <g transform="translate(85 95)">
          <circle r="6" fill="none" stroke="var(--kwa-cyan-600)" strokeWidth="2" />
          <line x1="6" y1="0" x2="20" y2="0" stroke="var(--kwa-cyan-600)" strokeWidth="2" />
          <line x1="16" y1="0" x2="16" y2="5" stroke="var(--kwa-cyan-600)" strokeWidth="2" />
          <line x1="20" y1="0" x2="20" y2="5" stroke="var(--kwa-cyan-600)" strokeWidth="2" />
        </g>
      </svg>
    </BadgeBase>
  )
}

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

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  /** 步骤标识（用于 key 与调试）。 */
  id: string
  /** 步骤主标题。 */
  title: string
  /** 步骤副标题（一句话概括）。 */
  subtitle: string
  /** 详细说明文本（支持换行）。 */
  description: string
  /** 图示类型，对应 OnboardingGraphic 的枚举。 */
  graphic: 'welcome' | 'modes' | 'graph' | 'extract' | 'quiz-report' | 'llm'
  /** 主操作按钮文本（最后一步显示「开始使用」，其他步骤显示「下一步」）。 */
  primaryLabel?: string
}

/** 6 步引导内容定义。 */
const STEPS: StepDef[] = [
  {
    id: 'welcome',
    title: '欢迎使用知识工作助手',
    subtitle: '双模式知识图谱 · 让学习与工作并轨',
    description:
      '这是一个把「散落的对话」沉淀为「结构化知识」的本地工具。\n\n学习模式帮你把 AI 对话整理成可复习的学科图谱；\n工作模式帮你把零散线索沉淀为可跟进的工作对象图谱，并自动生成报告。',
    graphic: 'welcome',
  },
  {
    id: 'modes',
    title: '双模式切换',
    subtitle: '右上角胶囊开关：学习 / 工作',
    description:
      '点击右上角「学习 / 工作」胶囊切换器，可一键切换数据模式。\n\n两个模式的数据完全隔离：学习模式聚焦学科知识点与测验；\n工作模式聚焦工作对象（线索 / 承诺 / 风险）与报告。\n\n切换时会保留各自状态，往返不丢失上下文。',
    graphic: 'modes',
  },
  {
    id: 'graph',
    title: '知识图谱与节点延伸',
    subtitle: '双击节点一键延伸，单击方向单点延伸',
    description:
      '在左侧选中或新建一个图谱后，内容区会展示可视化图谱。\n\n• 双击节点：Agent 一键生成多个延伸方向（灰色新节点），可撤销\n• 单击延伸方向：仅生成指定方向的单个节点\n• 选中节点：右侧浮出详情卡，可补充疑问 / 联想 / 考点等留白\n\n图谱视图与卡片视图可在顶部切换，数据双向同步。',
    graphic: 'graph',
  },
  {
    id: 'extract',
    title: 'AI 抽取候选节点',
    subtitle: '浏览器插件采集 → Agent 抽取 → 你确认入图',
    description:
      '安装浏览器插件后，AI 对话（豆包 / ChatGPT / Claude 等）会自动推送到本工具。\n\n点击侧栏「待抽取」入口：\n• 单条抽取：Agent 分析对话，返回候选节点卡片\n• 批量抽取：自动依次抽取并全部入图\n\n抽取过程支持 30s 超时自动取消，亦可手动取消。Agent 给出的候选节点需你勾选确认才会真正入图，保留对 AI 结果的掌控。',
    graphic: 'extract',
  },
  {
    id: 'quiz-report',
    title: '测验与工作报告',
    subtitle: '学习模式测验 · 工作模式报告',
    description:
      '学习模式：点「开始测验」生成单选 / 多选 / 费曼题，作答后给出解析与得分。\n\n工作模式：\n• 风口推荐：基于图谱推荐可加入的风口\n• 工作报告：流式生成周报 / 月报，可导出 Word 或打印为 PDF\n• 提问：基于图谱节点回答你的问题，附引用来源\n\n所有 AI 操作均可取消，LLM 不可用时走降级路径。',
    graphic: 'quiz-report',
  },
  {
    id: 'llm',
    title: '配置 LLM 凭据',
    subtitle: '前往设置页填入 API Key 即可启用全部 AI 功能',
    description:
      '本工具的 AI 能力（节点延伸 / 抽取 / 测验 / 报告）依赖外部 LLM 服务。\n\n若顶部出现黄色提示条，表示 LLM 未配置，AI 功能将走降级路径或不可用。\n\n点击「前往配置」按钮进入设置页，填入 base_url / model / api_key 即可。\n支持 OpenAI 兼容接口（如豆包 / DeepSeek / 智谱 / OpenAI 官方等）。',
    graphic: 'llm',
    primaryLabel: '开始使用',
  },
]

interface OnboardingWizardProps {
  /** 引导完成（用户点击「开始使用」或「跳过」）时触发。 */
  onFinish: () => void
}

export function OnboardingWizard({ onFinish }: OnboardingWizardProps) {
  const [step, setStep] = useState(0)
  const total = STEPS.length
  const current = STEPS[step]
  const isLast = step === total - 1

  const setActiveNav = useAppStore((s) => s.setActiveNav)

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

  // 键盘快捷键：ESC 跳过，Enter/Space 下一步，← 上一步
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleSkip()
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        goNext()
      } else if (e.key === 'ArrowLeft') {
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
    <div className="onboarding" role="dialog" aria-modal="true" aria-label="首次使用引导">
      {/* 顶部进度条 */}
      <div className="onboarding__progress-bar" aria-hidden="true">
        <div className="onboarding__progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* 步骤点指示器 */}
      <div className="onboarding__steps" role="tablist" aria-label="引导步骤">
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'upcoming'
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-label={`步骤 ${i + 1}：${s.title}`}
              className={`onboarding__step-dot${state === 'current' ? ' is-current' : ''}${
                state === 'done' ? ' is-done' : ''
              }`}
              onClick={() => setStep(i)}
              disabled={i > step + 1}
              title={s.title}
            >
              <span className="onboarding__step-num">{i + 1}</span>
            </button>
          )
        })}
      </div>

      {/* 主内容区：左侧图示 + 右侧说明 */}
      <div className="onboarding__body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            className="onboarding__slide"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 280, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="onboarding__graphic">
              <OnboardingGraphic kind={current.graphic} />
            </div>
            <div className="onboarding__text">
              <p className="onboarding__subtitle">{current.subtitle}</p>
              <h2 className="onboarding__title">{current.title}</h2>
              <p className="onboarding__desc">
                {current.description.split('\n').map((line, i) => (
                  <span key={i} className="onboarding__desc-line">
                    {line || '\u00A0'}
                  </span>
                ))}
              </p>
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
            autoFocus
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

function OnboardingGraphic({ kind }: { kind: GraphicKind }) {
  switch (kind) {
    case 'welcome':
      return <WelcomeGraphic />
    case 'modes':
      return <ModesGraphic />
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

function ModesGraphic() {
  return (
    <BadgeBase>
      <svg width="140" height="80" viewBox="0 0 140 80" fill="none" aria-hidden="true">
        {/* 胶囊开关 */}
        <rect x="10" y="20" width="120" height="40" rx="20" fill="var(--kwa-paper-200)" stroke="var(--kwa-border-200)" />
        {/* 学习侧 */}
        <circle cx="30" cy="40" r="6" fill="var(--kwa-cyan-500)" />
        <text x="44" y="44" fontSize="11" fill="var(--kwa-ink-700)" fontFamily="var(--font-mono)">学习</text>
        {/* 工作侧 */}
        <text x="78" y="44" fontSize="11" fill="var(--kwa-text-400)" fontFamily="var(--font-mono)">工作</text>
        <circle cx="115" cy="40" r="6" fill="var(--kwa-amber-500)" />
        {/* 指示器滑块 */}
        <rect x="18" y="24" width="48" height="32" rx="16" fill="var(--kwa-paper-50)" stroke="var(--kwa-border-300)" strokeWidth="1.5" />
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

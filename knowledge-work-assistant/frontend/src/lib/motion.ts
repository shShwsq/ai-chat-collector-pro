import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { MotionConfig, useReducedMotion } from 'motion/react'

export type MotionQuality = 'high' | 'standard' | 'reduced'

export const MOTION = {
  fast: 0.16,
  panel: 0.22,
  expand: 0.34,
  handoff: 0.26,
  ease: [0.2, 0, 0, 1] as [number, number, number, number],
  springEase: [0.22, 1, 0.36, 1] as [number, number, number, number],
} as const

interface MotionRuntime {
  quality: MotionQuality
  reduceMotion: boolean
  allowBlur: boolean
  duration: (seconds: number) => number
}

const MotionRuntimeContext = createContext<MotionRuntime>({
  quality: 'high',
  reduceMotion: false,
  allowBlur: true,
  duration: (seconds) => seconds,
})

function initialQuality(): MotionQuality {
  if (typeof navigator === 'undefined') return 'high'
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4)
    ? 'standard'
    : 'high'
}

/**
 * 统一动效入口，并根据真实渲染帧耗时自动降档。
 * 降档只影响装饰性模糊、位移动画和时长，不影响交互完成回调。
 */
export function MotionProvider({ children }: PropsWithChildren) {
  const userPrefersReduced = useReducedMotion() ?? false
  const [quality, setQuality] = useState<MotionQuality>(initialQuality)
  const qualityRef = useRef(quality)

  useEffect(() => {
    qualityRef.current = quality
    document.documentElement.dataset.motionQuality = quality
    return () => {
      delete document.documentElement.dataset.motionQuality
    }
  }, [quality])

  useEffect(() => {
    if (userPrefersReduced) {
      setQuality('reduced')
      return
    }

    let frame = 0
    let previous = performance.now()
    let sampleCount = 0
    let elapsed = 0
    let longFrames = 0

    const sample = (now: number) => {
      const delta = Math.min(now - previous, 250)
      previous = now
      if (!document.hidden) {
        sampleCount += 1
        elapsed += delta
        if (delta > 34) longFrames += 1

        if (sampleCount >= 120) {
          const fps = elapsed > 0 ? (sampleCount * 1000) / elapsed : 60
          const longFrameRatio = longFrames / sampleCount
          const current = qualityRef.current
          if (fps < 30 || longFrameRatio > 0.35) {
            setQuality('reduced')
          } else if ((fps < 48 || longFrameRatio > 0.16) && current === 'high') {
            setQuality('standard')
          }
          sampleCount = 0
          elapsed = 0
          longFrames = 0
        }
      }
      frame = requestAnimationFrame(sample)
    }

    frame = requestAnimationFrame(sample)
    return () => cancelAnimationFrame(frame)
  }, [userPrefersReduced])

  const runtime = useMemo<MotionRuntime>(() => {
    const reduceMotion = userPrefersReduced || quality === 'reduced'
    return {
      quality,
      reduceMotion,
      allowBlur: quality !== 'reduced' && !userPrefersReduced,
      duration: (seconds) => reduceMotion ? 0 : quality === 'standard' ? seconds * 0.65 : seconds,
    }
  }, [quality, userPrefersReduced])

  return createElement(
    MotionRuntimeContext.Provider,
    { value: runtime },
    createElement(
      MotionConfig,
      {
        reducedMotion: runtime.reduceMotion ? 'always' : 'never',
        transition: { duration: runtime.duration(MOTION.panel), ease: MOTION.ease },
      },
      children,
    ),
  )
}

export function useMotionRuntime(): MotionRuntime {
  return useContext(MotionRuntimeContext)
}

export type HandoffPhase = 'closed' | 'opening' | 'open' | 'handoff' | 'closing'
export type HandoffEvent =
  | { type: 'OPEN' }
  | { type: 'OPENED' }
  | { type: 'START_HANDOFF' }
  | { type: 'START_CLOSE' }
  | { type: 'RESET' }

/** 大卡生命周期的显式有限状态机；非法/重复事件保持当前状态。 */
export function handoffReducer(phase: HandoffPhase, event: HandoffEvent): HandoffPhase {
  switch (phase) {
    case 'closed':
      return event.type === 'OPEN' ? 'opening' : phase
    case 'opening':
      if (event.type === 'OPENED') return 'open'
      if (event.type === 'RESET') return 'closed'
      return phase
    case 'open':
      if (event.type === 'START_HANDOFF') return 'handoff'
      if (event.type === 'START_CLOSE') return 'closing'
      if (event.type === 'RESET') return 'closed'
      return phase
    case 'handoff':
    case 'closing':
      return event.type === 'RESET' ? 'closed' : phase
  }
}

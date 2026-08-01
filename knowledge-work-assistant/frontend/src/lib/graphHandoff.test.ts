import { describe, expect, it, vi } from 'vitest'

import {
  prepareGraphHandoffTarget,
  waitForGraphHandoffView,
  type GraphHandoffView,
} from './graphHandoff'

function createView(overrides: Partial<GraphHandoffView> = {}) {
  const calls: string[] = []
  const view: GraphHandoffView = {
    waitForNodeReady: vi.fn(async () => {
      calls.push('ready')
      return true
    }),
    focusNodeAtCenter: vi.fn(async () => {
      calls.push('focus')
      return true
    }),
    getNodeScreenRect: vi.fn(() => {
      calls.push('measure')
      return { left: 10, top: 20, width: 180, height: 72 } as DOMRect
    }),
    ...overrides,
  }
  return { calls, view }
}

describe('prepareGraphHandoffTarget', () => {
  it('严格等待节点就绪和平移完成后才测量落点', async () => {
    const { calls, view } = createView()

    await expect(prepareGraphHandoffTarget(view, 'node-1')).resolves.toEqual({
      left: 10,
      top: 20,
      width: 180,
      height: 72,
    })
    expect(calls).toEqual(['ready', 'focus', 'measure'])
  })

  it('节点未就绪时不聚焦也不测量', async () => {
    const { calls, view } = createView({
      waitForNodeReady: vi.fn(async () => {
        calls.push('ready')
        return false
      }),
    })

    await expect(prepareGraphHandoffTarget(view, 'node-1')).resolves.toBeNull()
    expect(calls).toEqual(['ready'])
  })

  it('程序平移被交互取消时不测量飞行落点', async () => {
    const { calls, view } = createView({
      focusNodeAtCenter: vi.fn(async () => {
        calls.push('focus')
        return false
      }),
    })

    await expect(prepareGraphHandoffTarget(view, 'node-1')).resolves.toBeNull()
    expect(calls).toEqual(['ready', 'focus'])
  })
})

describe('waitForGraphHandoffView', () => {
  it('等待条件渲染完成后返回新挂载的图谱 ref', async () => {
    vi.useFakeTimers()
    const { view } = createView()
    let mountedView: GraphHandoffView | null = null
    const waiting = waitForGraphHandoffView(() => mountedView)

    setTimeout(() => {
      mountedView = view
    }, 20)
    await vi.advanceTimersByTimeAsync(32)

    await expect(waiting).resolves.toBe(view)
    vi.useRealTimers()
  })

  it('超过等待窗口后平稳返回 null', async () => {
    vi.useFakeTimers()
    const waiting = waitForGraphHandoffView(() => null, 20)
    await vi.advanceTimersByTimeAsync(32)

    await expect(waiting).resolves.toBeNull()
    vi.useRealTimers()
  })
})

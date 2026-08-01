import { describe, expect, it, vi } from 'vitest'

import { createPostHandoffExtensionRunner } from './postHandoffExtension'

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('createPostHandoffExtensionRunner', () => {
  it('正常落地仅触发一次 all 延伸', async () => {
    const extendNode = vi.fn(async () => ({ batch_id: 'batch-1' }))
    const runner = createPostHandoffExtensionRunner(extendNode)

    expect(runner.trigger('node-1')).toBe(true)
    expect(runner.trigger('node-1')).toBe(false)
    await flushPromises()

    expect(extendNode).toHaveBeenCalledTimes(1)
    expect(extendNode).toHaveBeenCalledWith('node-1', 'all')
  })

  it('超时兜底与随后到达的动画回调竞争时仍仅触发一次', async () => {
    const extendNode = vi.fn(async () => ({ batch_id: 'batch-timeout' }))
    const runner = createPostHandoffExtensionRunner(extendNode)

    expect(runner.trigger('node-timeout')).toBe(true)
    expect(runner.trigger('node-timeout')).toBe(false)
    await flushPromises()

    expect(extendNode).toHaveBeenCalledTimes(1)
    expect(extendNode).toHaveBeenCalledWith('node-timeout', 'all')
  })

  it('extendNode 抛错时不产生未处理拒绝', async () => {
    const runner = createPostHandoffExtensionRunner(
      vi.fn(async () => {
        throw new Error('network unavailable')
      }),
    )

    runner.trigger('node-3')
    await flushPromises()
  })

  it('新一轮接力 reset 后允许同一节点再次延伸', async () => {
    const extendNode = vi.fn(async () => ({ batch_id: 'batch-next' }))
    const runner = createPostHandoffExtensionRunner(extendNode)

    runner.trigger('node-1')
    runner.reset()
    runner.trigger('node-1')
    await flushPromises()

    expect(extendNode).toHaveBeenCalledTimes(2)
  })
})

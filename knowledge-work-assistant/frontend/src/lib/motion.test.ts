import { describe, expect, it } from 'vitest'

import { handoffReducer, type HandoffPhase } from './motion'

describe('handoffReducer', () => {
  it('按 opening → open → handoff → closed 完成接力', () => {
    let phase: HandoffPhase = 'closed'
    phase = handoffReducer(phase, { type: 'OPEN' })
    phase = handoffReducer(phase, { type: 'OPENED' })
    phase = handoffReducer(phase, { type: 'START_HANDOFF' })
    expect(phase).toBe('handoff')
    expect(handoffReducer(phase, { type: 'RESET' })).toBe('closed')
  })

  it('忽略非法或重复事件，不产生组合状态', () => {
    expect(handoffReducer('closed', { type: 'START_HANDOFF' })).toBe('closed')
    expect(handoffReducer('opening', { type: 'START_CLOSE' })).toBe('opening')
    expect(handoffReducer('closing', { type: 'OPENED' })).toBe('closing')
  })

  it('从 open 状态进入 closing 并可重置', () => {
    const closing = handoffReducer('open', { type: 'START_CLOSE' })
    expect(closing).toBe('closing')
    expect(handoffReducer(closing, { type: 'RESET' })).toBe('closed')
  })
})

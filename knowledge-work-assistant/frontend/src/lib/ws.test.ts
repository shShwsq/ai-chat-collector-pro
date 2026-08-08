import { describe, expect, it } from 'vitest'

import { getReconnectDelay } from './ws'

describe('getReconnectDelay', () => {
  it('uses capped exponential backoff', () => {
    expect(getReconnectDelay(0)).toBe(500)
    expect(getReconnectDelay(1)).toBe(1000)
    expect(getReconnectDelay(4)).toBe(8000)
    expect(getReconnectDelay(6)).toBe(30000)
    expect(getReconnectDelay(20)).toBe(30000)
  })

  it('normalizes negative attempts', () => {
    expect(getReconnectDelay(-2)).toBe(500)
  })
})

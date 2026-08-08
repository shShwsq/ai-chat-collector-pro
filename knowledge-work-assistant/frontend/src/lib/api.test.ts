import { describe, expect, it } from 'vitest'

import { shouldRetryRequest } from './api'

describe('shouldRetryRequest', () => {
  it('retries idempotent requests for network failures within the limit', () => {
    expect(shouldRetryRequest('GET', 0)).toBe(true)
    expect(shouldRetryRequest('GET', 1)).toBe(true)
    expect(shouldRetryRequest('GET', 2)).toBe(false)
  })

  it('retries only selected transient status codes', () => {
    expect(shouldRetryRequest('GET', 0, 503)).toBe(true)
    expect(shouldRetryRequest('GET', 0, 429)).toBe(true)
    expect(shouldRetryRequest('GET', 0, 404)).toBe(false)
  })

  it('does not retry mutating requests', () => {
    expect(shouldRetryRequest('POST', 0)).toBe(false)
    expect(shouldRetryRequest('PATCH', 0, 503)).toBe(false)
    expect(shouldRetryRequest('DELETE', 0, 503)).toBe(false)
  })
})

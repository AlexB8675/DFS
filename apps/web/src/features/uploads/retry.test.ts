import { describe, expect, it } from 'vitest'
import { ApiError, parseRetryAfter } from '@/lib/api/client'
import { isRetryable, retryDelayMs } from './retry'

describe('isRetryable', () => {
  it.each([
    [new TypeError('Failed to fetch'), true],
    [new ApiError(503, 'staging_full', 'Busy'), true],
    [new ApiError(429, 'rate_limited', 'Slow down'), true],
    [new ApiError(400, 'hash_mismatch', 'Corrupted'), true],
    [new ApiError(400, 'invalid_name', 'Bad name'), false],
    [new ApiError(507, 'quota_exceeded', 'Full'), false],
    [new ApiError(404, 'upload_not_found', 'Gone'), false],
    [new DOMException('Aborted', 'AbortError'), false],
  ])('%s → %s', (error, expected) => {
    expect(isRetryable(error)).toBe(expected)
  })
})

describe('retryDelayMs', () => {
  it('backs off exponentially up to 30 s, with jitter', () => {
    const middle = () => 0.5
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt, null, middle))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ])
    expect(retryDelayMs(1, null, () => 0)).toBe(800)
    expect(retryDelayMs(1, null, () => 1)).toBe(1200)
  })

  it('waits as long as the server asks', () => {
    expect(retryDelayMs(1, new ApiError(503, 'staging_full', 'Busy', 7000))).toBe(7000)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-04T12:00:00Z')

  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('5', now)).toBe(5000)
    expect(parseRetryAfter('Sun, 04 Oct 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('ignores missing or garbled values, and never goes negative', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter('Sun, 04 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })
})

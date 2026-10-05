import { describe, expect, it, vi } from 'vitest'
import { RateLimiter } from './rate-limit.ts'

describe('RateLimiter', () => {
  it('counts failures independently and resets a window at its expiry', () => {
    const limiter = new RateLimiter(2, 1000)
    limiter.hit('first', 100)
    expect(limiter.waitMs('first', 200)).toBe(0)
    limiter.hit('first', 200)
    expect(limiter.waitMs('first', 300)).toBe(800)
    expect(limiter.waitMs('second', 300)).toBe(0)
    expect(limiter.waitMs('first', 1100)).toBe(0)
    limiter.hit('first', 1100)
    expect(limiter.waitMs('first', 1100)).toBe(0)
  })

  it('does not rescan every active key for each new failure above the cleanup threshold', () => {
    const limiter = new RateLimiter(1, 60_000)
    const scans = vi.spyOn(Map.prototype, Symbol.iterator)
    let scanCount: number
    try {
      for (let index = 0; index < 10_020; index += 1) limiter.hit(String(index), 1000)
      scanCount = scans.mock.calls.length
    } finally {
      scans.mockRestore()
    }
    expect(scanCount).toBeLessThanOrEqual(1)
    expect(limiter.waitMs('0', 1000)).toBe(60_000)
    expect(limiter.waitMs('10019', 1000)).toBe(60_000)
    // A later cleanup must leave a renewed window in force.
    limiter.hit('0', 61_000)
    limiter.hit('new', 61_000)
    expect(limiter.waitMs('0', 61_000)).toBe(60_000)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { addressKey, RateLimiter } from './rate-limit.ts'

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

describe('addressKey', () => {
  it('counts IPv4 by address, and an IPv4-mapped one as its IPv4', () => {
    expect(addressKey('127.0.0.1')).toBe('address:127.0.0.1')
    expect(addressKey('::ffff:192.0.2.7')).toBe('address:192.0.2.7')
  })

  it('counts IPv6 by its /64', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('address:2001:db8:1:2::/64')
    expect(addressKey('2001:0DB8:0001:0002:ffff::1')).toBe('address:2001:db8:1:2::/64')
    expect(addressKey('2001:db8::1')).toBe('address:2001:db8:0:0::/64')
    expect(addressKey('::1')).toBe('address:0:0:0:0::/64')
  })

  it('reads an IPv4-mapped address written in hex, and leaves what is no address as it came', () => {
    expect(addressKey('::ffff:c000:207')).toBe('address:192.0.2.7')
    expect(addressKey('not-an-address')).toBe('address:not-an-address')
  })
})

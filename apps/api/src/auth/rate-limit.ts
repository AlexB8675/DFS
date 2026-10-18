import { isIPv4, isIPv6 } from 'node:net'

/**
 * A fixed-window counter per key, in memory. With several API instances each
 * counts on its own, which is acceptable for the few instances DFS runs; the
 * per-account sign-in lock lives in the database (DESIGN.md §7.1).
 */
export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #windows = new Map<string, { count: number; resetAt: number }>()
  #nextSweepAt = 0

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** How long `key` must wait, or 0 if it is under its limit. Counts nothing. */
  waitMs(key: string, now = Date.now()): number {
    const window = this.#windows.get(key)
    if (!window || window.resetAt <= now || window.count < this.#limit) return 0
    return window.resetAt - now
  }

  /** Counts one hit against `key`, such as a failed attempt. */
  hit(key: string, now = Date.now()): void {
    let window = this.#windows.get(key)
    if (!window || window.resetAt <= now) {
      if (this.#windows.size > 10_000 && now >= this.#nextSweepAt) {
        this.#sweep(now)
        // Most windows are still active during a burst. Bound full scans to
        // once per window instead of doing one for every new key.
        this.#nextSweepAt = now + this.#windowMs
      }
      window = { count: 0, resetAt: now + this.#windowMs }
      this.#windows.set(key, window)
    }
    window.count += 1
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key)
    }
  }
}

/**
 * The eight 16-bit groups of an IPv6 address, written out in full: `::` filled
 * with zeros, and a trailing dotted IPv4 (as in `::ffff:192.0.2.7`) read as
 * its last two groups. A zone (`%eth0`) is dropped.
 */
function ipv6Groups(ip: string): number[] {
  let text = ip.split('%')[0] ?? ip
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number)
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const before = head === '' ? [] : head.split(':')
  const after = rest === undefined || rest === '' ? [] : rest.split(':')
  const fill = rest === undefined ? 0 : 8 - before.length - after.length
  return [...before, ...Array.from({ length: fill }, () => '0'), ...after].map((group) =>
    Number.parseInt(group, 16),
  )
}

/**
 * What a request's address is counted under: `address:<IPv4>`, an IPv4-mapped
 * IPv6 address (`::ffff:a.b.c.d`) as its IPv4; and for IPv6 the first four
 * groups, as `address:2001:db8:1:2::/64`. One home or server holds a whole /64,
 * so counting single IPv6 addresses would let it take a fresh one for every
 * guess (DESIGN.md §7.5, D46).
 */
export function addressKey(ip: string): string {
  // Fastify always gives an address; anything else is counted as it came.
  if (isIPv4(ip) || !isIPv6(ip)) return `address:${ip}`
  const groups = ipv6Groups(ip)
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return `address:${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }
  return `address:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

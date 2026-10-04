/**
 * A fixed-window counter per key, in memory. With several API instances each
 * counts on its own, which is acceptable for the few instances DFS runs; the
 * per-account sign-in lock lives in the database (DESIGN.md §7.1).
 */
export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #windows = new Map<string, { count: number; resetAt: number }>()

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Counts a hit; says how long to wait if the key is over its limit. */
  hit(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    let window = this.#windows.get(key)
    if (!window || window.resetAt <= now) {
      if (this.#windows.size > 10_000) this.#sweep(now)
      window = { count: 0, resetAt: now + this.#windowMs }
      this.#windows.set(key, window)
    }
    window.count += 1
    return window.count <= this.#limit
      ? { allowed: true }
      : { allowed: false, retryAfterMs: window.resetAt - now }
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key)
    }
  }
}

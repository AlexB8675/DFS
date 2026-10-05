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

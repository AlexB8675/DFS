import { afterEach, describe, expect, it, vi } from 'vitest'
import { onTheClock } from './leader-work.ts'

// The leader samples the system once in each half-minute bucket (DESIGN §16):
// on the clock, so a slow run never pushes a sample into the next bucket.

describe('onTheClock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a little past each mark, once in each bucket, however long runs take', async () => {
    const start = Date.UTC(2026, 9, 6, 12)
    vi.useFakeTimers({ now: start + 7_000 })
    const runs: number[] = []
    const ticking = onTheClock(30_000, 2_000, { warn: vi.fn() }, 'sampling', async () => {
      runs.push(Date.now())
      // Each run takes 4 s, which `repeat` would add to every interval.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await ticking.stop()
    expect(runs.map((at) => (at - start) / 1000)).toEqual(
      Array.from({ length: 10 }, (_, index) => 32 + 30 * index),
    )
  })

  it('keeps to the clock after a run fails, and says so', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12) })
    const log = { warn: vi.fn() }
    let calls = 0
    const ticking = onTheClock(30_000, 2_000, log, 'sampling', () => {
      calls += 1
      return Promise.reject(new Error('down'))
    })
    await vi.advanceTimersByTimeAsync(61_000)
    await ticking.stop()
    expect(calls).toBe(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

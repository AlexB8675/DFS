import { describe, expect, it } from 'vitest'
import { Deliveries } from './deliveries.ts'
import type { SendStats } from './send.ts'

function stats(bytes: number, sourceMs: number, clientMs: number): SendStats {
  return { startedAt: 0, bytes, firstPieceMs: 0, sourceMs, clientMs }
}

describe('how fast a user’s reads of a version go (§10.4)', () => {
  it('sums running and finished reads, and never goes back when one ends', () => {
    const deliveries = new Deliveries()
    const first = stats(1000, 10, 300)
    const end = deliveries.follow('user', 'version', first)
    deliveries.follow('user', 'version', stats(500, 5, 0))
    deliveries.follow('other', 'version', stats(9999, 0, 0))
    expect(deliveries.totals('user', 'version')).toEqual({
      bytes: 1500,
      waitedForSourceMs: 15,
      waitedForClientMs: 300,
      running: 2,
    })

    first.bytes = 4000
    end()
    // Ended twice: counted once.
    end()
    expect(deliveries.totals('user', 'version')).toEqual({
      bytes: 4500,
      waitedForSourceMs: 15,
      waitedForClientMs: 300,
      running: 1,
    })
    expect(deliveries.totals('user', 'unknown').bytes).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { silentFreezes } from './freeze.ts'
import type { Stamped } from './freeze.ts'

// The no-silent-freeze check of the plays suite (DESIGN.md §10.4): a wait is cut at the events that tell it (a
// `watchdog` of any action but `quota`, an `error` of the engine's); every piece of it that no hold and no seek's own
// wait covers may be no longer than the limit, which the suite sets as `STUCK_MS + WATCH_EVERY_MS` (the watchdog's
// first act can come that long after the clock stops). The tests below use a limit of 2_000 ms.

const STUCK = 2_000

const watchdog = (at: number): Stamped => ({
  at,
  event: { type: 'watchdog', action: 'stuck', at: 1, detail: 'the clock stood' },
})
const hold = (at: number, on: boolean): Stamped => ({
  at,
  event: { type: 'hold', on, reason: 'slow', aheadS: 0, targetS: 2 },
})

describe('silentFreezes', () => {
  it('passes a wait that is no longer than the stuck time, which is not stuck yet', () => {
    expect(silentFreezes([{ from: 1_000, to: 3_000 }], [], 10_000, STUCK)).toEqual([])
  })

  it('fails a wait one millisecond past the stuck time with no watchdog event', () => {
    const wait = { from: 1_000, to: 3_001 }
    expect(silentFreezes([wait], [], 10_000, STUCK)).toEqual([wait])
  })

  it('passes a wait whose silent pieces are within the limit on both sides of a watchdog event, the ends included', () => {
    const wait = { from: 1_000, to: 3_000 }
    expect(silentFreezes([wait], [watchdog(1_000)], 10_000, STUCK)).toEqual([])
    expect(silentFreezes([wait], [watchdog(3_000)], 10_000, STUCK)).toEqual([])
    const longer = { from: 1_000, to: 4_000 }
    expect(silentFreezes([longer], [watchdog(2_500)], 10_000, STUCK)).toEqual([])
  })

  it('does not take a watchdog event before or after the wait', () => {
    const wait = { from: 4_000, to: 9_000 }
    expect(silentFreezes([wait], [watchdog(3_999), watchdog(9_001)], 10_000, STUCK)).toEqual([wait])
  })

  it('excuses a wait that a hold covers all through', () => {
    const wait = { from: 2_000, to: 9_000 }
    expect(silentFreezes([wait], [hold(1_000, true), hold(9_500, false)], 10_000, STUCK)).toEqual(
      [],
    )
  })

  it('excuses a wait inside a hold that is still on at the end of the play', () => {
    const wait = { from: 2_000, to: 9_000 }
    expect(silentFreezes([wait], [hold(1_000, true)], 10_000, STUCK)).toEqual([])
  })

  it('counts only what the hold does not cover: a hold that explains less than the stuck time is no excuse', () => {
    // The hold covers 1.5 s of 6 s; the other 4.5 s are the engine's silence.
    const wait = { from: 2_000, to: 8_000 }
    expect(silentFreezes([wait], [hold(2_000, true), hold(3_500, false)], 10_000, STUCK)).toEqual([
      wait,
    ])
  })

  it('excuses a wait whose uncovered time is within the stuck time, and no more', () => {
    const wait = { from: 2_000, to: 8_000 }
    // Covered 4_000 ms of 6_000: 2_000 uncovered, not past the stuck time.
    expect(silentFreezes([wait], [hold(4_000, true), hold(8_000, false)], 10_000, STUCK)).toEqual(
      [],
    )
  })

  it('takes a wait that is still open as ending with the play', () => {
    const open = { from: 5_000, to: null }
    expect(silentFreezes([open], [], 8_000, STUCK)).toEqual([open])
    expect(silentFreezes([open], [], 6_000, STUCK)).toEqual([])
  })

  it('judges each wait on its own', () => {
    const ok = { from: 1_000, to: 3_500 }
    const bad = { from: 6_000, to: 9_000 }
    expect(silentFreezes([ok, bad], [watchdog(2_000)], 10_000, STUCK)).toEqual([bad])
  })
})

// R41 item 1: a seek's own wait is excused while the seek has no picture yet and is younger than its deadline.
describe("silentFreezes: a seek's own wait", () => {
  const DEADLINE = 10_000
  const seek = (at: number, ms: number | null): Stamped => ({
    at,
    event: { type: 'seek', to: 5, inWindow: false, ms },
  })
  const error = (at: number): Stamped => ({
    at,
    event: { type: 'error', from: 'engine', code: null, message: 'The seek showed no picture.' },
  })

  it("excuses a wait from the seek's start to its picture", () => {
    const wait = { from: 1_000, to: 4_000 }
    expect(
      silentFreezes([wait], [seek(1_000, null), seek(4_000, 3_000)], 10_000, STUCK, DEADLINE),
    ).toEqual([])
  })

  it('counts only what the seek does not cover: a wait that began before the seek keeps its own silence', () => {
    const wait = { from: 0, to: 4_500 }
    // The seek covers 3_000 ms of the 4_500; 1_500 are uncovered, within the stuck time.
    expect(
      silentFreezes([wait], [seek(1_500, null), seek(4_500, 3_000)], 10_000, STUCK, DEADLINE),
    ).toEqual([])
    const long = { from: 0, to: 6_000 }
    expect(
      silentFreezes([long], [seek(3_500, null), seek(6_000, 2_500)], 10_000, STUCK, DEADLINE),
    ).toEqual([long])
  })

  it("stops excusing at the deadline, and an error of the engine's after it tells the wait", () => {
    const wait = { from: 1_000, to: 20_000 }
    expect(silentFreezes([wait], [seek(1_000, null)], 30_000, STUCK, DEADLINE)).toEqual([wait])
    const short = { from: 1_000, to: 12_000 }
    expect(
      silentFreezes([short], [seek(1_000, null), error(11_000)], 30_000, STUCK, DEADLINE),
    ).toEqual([])
  })

  it('takes a seek with no picture at the end of the play as lasting to the deadline or the end, whichever is first', () => {
    const wait = { from: 1_000, to: null }
    expect(silentFreezes([wait], [seek(1_000, null)], 8_000, STUCK, DEADLINE)).toEqual([])
  })

  it('does not excuse a wait with no seek, as before', () => {
    const wait = { from: 1_000, to: 9_000 }
    expect(
      silentFreezes([wait], [seek(100, null), seek(500, 400)], 10_000, STUCK, DEADLINE),
    ).toEqual([wait])
  })
})

// R44 item 3: what is told, and the pieces between the told events.
describe('silentFreezes: what is told, and the pieces between', () => {
  const quota = (at: number): Stamped => ({
    at,
    event: { type: 'watchdog', action: 'quota', at: 1, detail: 'the window shrank to 48 MiB' },
  })
  const elementError = (at: number): Stamped => ({
    at,
    event: { type: 'error', from: 'element', code: 3, message: 'The element failed.' },
  })

  it('does not take a quota event as telling a wait: an early one and then a 20 s silent wait fails', () => {
    const wait = { from: 1_000, to: 21_000 }
    expect(silentFreezes([wait], [quota(1_500)], 30_000, STUCK)).toEqual([wait])
  })

  it('does not take an error of the element as telling a wait', () => {
    const wait = { from: 1_000, to: 9_000 }
    expect(silentFreezes([wait], [elementError(2_000)], 30_000, STUCK)).toEqual([wait])
  })

  it('passes a long wait that is told at least every limit', () => {
    const wait = { from: 0, to: 20_000 }
    const told = Array.from({ length: 10 }, (_, i) => watchdog(2_000 * (i + 1)))
    expect(silentFreezes([wait], told, 30_000, STUCK)).toEqual([])
  })

  it('fails a wait with a silent tail longer than the limit after the last told event', () => {
    const wait = { from: 0, to: 9_000 }
    const told = [watchdog(2_000), watchdog(4_000), watchdog(6_000)]
    expect(silentFreezes([wait], told, 30_000, STUCK)).toEqual([wait])
    expect(silentFreezes([wait], [...told, watchdog(8_000)], 30_000, STUCK)).toEqual([])
  })

  it('fails a wait with a silent piece between two told events', () => {
    const wait = { from: 0, to: 9_000 }
    expect(silentFreezes([wait], [watchdog(1_000), watchdog(4_001)], 30_000, STUCK)).toEqual([wait])
  })

  it('cuts at a hold: only the silent piece beyond the covered stretch counts', () => {
    const wait = { from: 0, to: 9_000 }
    const holds = [hold(3_000, true), hold(6_000, false)]
    // Silent pieces: 0-3000 (3000, too long).
    expect(silentFreezes([wait], holds, 30_000, STUCK)).toEqual([wait])
    expect(
      silentFreezes([wait], [watchdog(1_500), watchdog(7_500), ...holds], 30_000, STUCK),
    ).toEqual([])
  })
})

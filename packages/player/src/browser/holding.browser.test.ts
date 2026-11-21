// The hold for the network (DESIGN.md §10.4), on a fake element, downloader and feeder: which plays it holds,
// when it plays, and what it tells.

import type { TimelineEventInput } from '@dfs/shared'
import { describe, expect, test } from 'vitest'
import { Holding } from '../page/holding.ts'
import { RangeSet } from '../ranges.ts'

const FILE_BYTES = 10_000_000
const SECONDS = 10

interface Setup {
  holding: Holding
  events: TimelineEventInput[]
  video: { paused: boolean; ended: boolean; seeking: boolean; currentTime: number }
  held: RangeSet
  calls: string[]
  link: { state: string; rate: number | null }
  want: { autoplay: boolean }
  stats: { holding: boolean; holds: number; holdMs: number }
}

/** A play of a 10 MB file of 10 s (1 MB a second) on a link of 100 KB a second, with nothing stored. */
function setup(
  options: { autoplay?: boolean | null; at?: number; offset?: number | null } = {},
): Setup {
  const events: TimelineEventInput[] = []
  const calls: string[] = []
  const held = new RangeSet()
  const video = { paused: true, ended: false, seeking: false, currentTime: options.at ?? 0 }
  const link = { state: 'reading', rate: 100_000 as number | null }
  const want = { autoplay: options.autoplay ?? true }
  const stats = { holding: false, holds: 0, holdMs: 0 }
  const element = Object.assign(video, {
    buffered: { length: 0, start: () => 0, end: () => 0 },
    play: () => {
      calls.push('play')
      video.paused = false
      return Promise.resolve()
    },
    pause: () => {
      calls.push('pause')
      video.paused = true
    },
  })
  const downloader = {
    fileSize: FILE_BYTES,
    state: () => link.state,
    rate: () => link.rate,
    store: { capBytes: 1_000_000_000, held: () => held },
  }
  const offset = options.offset === undefined ? 0 : options.offset
  const feeder = { durationSeconds: SECONDS, positions: { offsetAt: () => offset } }
  const holding = new Holding({
    video: element as unknown as HTMLVideoElement,
    autoplay: options.autoplay === null ? undefined : () => want.autoplay,
    downloader: () => downloader as never,
    feeder: () => feeder as never,
    feedDone: () => false,
    say: (event) => events.push(event),
    stats,
    changed: () => undefined,
    now: () => 0,
  })
  return { holding, events, video, held, calls, link, want, stats }
}

function holds(events: TimelineEventInput[]): Extract<TimelineEventInput, { type: 'hold' }>[] {
  return events.filter((event): event is Extract<TimelineEventInput, { type: 'hold' }> => {
    return event.type === 'hold'
  })
}

describe('Holding', () => {
  test('a seek made while paused never holds and never plays', () => {
    const play = setup()
    play.holding.begin('seek', false)
    expect(holds(play.events)).toEqual([])
    expect(play.calls).toEqual([])
  })

  test('a start with an autoplay that says no neither holds nor plays', () => {
    const play = setup({ autoplay: false })
    play.holding.begin('start')
    expect(holds(play.events)).toEqual([])
    expect(play.calls).toEqual([])
  })

  test('a play with no autoplay is never held or played', () => {
    const play = setup({ autoplay: null })
    play.holding.begin('start')
    play.video.paused = false
    play.video.currentTime = 3
    play.holding.stalled()
    expect(holds(play.events)).toEqual([])
    expect(play.calls).toEqual([])
  })

  test('a stall holds a playing element, and its hold ends in a play', () => {
    const play = setup()
    play.video.paused = false
    play.video.currentTime = 3
    play.holding.stalled()
    expect(play.calls).toEqual(['pause'])
    expect(play.holding.wantsPlay).toBe(true)
    expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'stall' })
    // The store comes to hold what the stall asks for.
    play.held.add({ start: 0, end: 9_000_000 })
    play.holding.check()
    expect(play.calls).toEqual(['pause', 'play'])
    expect(play.holding.wantsPlay).toBe(false)
    expect(holds(play.events)[1]).toMatchObject({ on: false, reason: null })
    expect(play.stats.holds).toBe(1)
  })

  test('a start that is wanted holds on a slow link, then plays; an autoplay that turns to no in the hold vetoes the play', () => {
    const play = setup()
    play.holding.begin('start')
    expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'start' })
    expect(play.calls).toEqual([])
    play.want.autoplay = false
    play.held.add({ start: 0, end: 9_000_000 })
    play.holding.check()
    expect(holds(play.events)[1]).toMatchObject({ on: false })
    expect(play.calls).toEqual([])
  })

  test('a seek of a play that was playing holds, and plays when the download is done', () => {
    const play = setup({ at: 4 })
    play.holding.begin('seek', true)
    expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
    play.link.state = 'done'
    play.holding.check()
    expect(play.calls).toEqual(['play'])
  })

  test('a download that is done, or a store that holds everything to the end of the file, has nothing to wait for', () => {
    const done = setup()
    done.link.state = 'done'
    done.holding.begin('start')
    expect(holds(done.events)).toEqual([])
    expect(done.calls).toEqual(['play'])

    // A tail of a file at a place of the picture: the bytes from the playhead's offset to the end are all held.
    const tail = setup({ at: 8, offset: 6_000_000 })
    tail.held.add({ start: 6_000_000, end: FILE_BYTES })
    tail.holding.begin('start')
    expect(holds(tail.events)).toEqual([])
    expect(tail.calls).toEqual(['play'])
  })

  test("its events tell what the rule used: the store's seconds ahead, and the goal", () => {
    const play = setup()
    play.held.add({ start: 0, end: 1_000_000 })
    play.holding.begin('start')
    const [on] = holds(play.events)
    // 1 MB of a file of 1 MB a second is 1 s ahead; the goal is what the rule asked for, over that.
    expect(on?.aheadS).toBeCloseTo(1, 3)
    expect(on?.targetS).toBeGreaterThan(1)
    expect(on?.targetS).not.toBe(30)
    play.video.paused = false
    play.holding.played()
    const off = holds(play.events)[1]
    expect(off).toMatchObject({ on: false, reason: null })
    expect(off?.aheadS).toBeCloseTo(1, 3)
    expect(off?.targetS).toBe(on?.targetS)
  })

  // R41 item 5: while a hold is on it is checked every HOLD_CHECK_MS, so release does not wait for the tick.
  test('a hold lets go within 100 ms of the rate becoming fast enough, with no tick', async () => {
    const play = setup()
    // Half a second of the video is stored, on a link slower than the video: held.
    play.held.add({ start: 0, end: 500_000 })
    play.holding.begin('start')
    expect(play.holding.holding).toBe(true)
    // The link turns out fast: the first frames are enough, and the hold lets go on its own check.
    play.link.rate = 5_000_000
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(play.holding.holding).toBe(false)
    expect(play.calls).toContain('play')
    expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
  })

  test('the check stops with the hold, and when the play is disposed during one', async () => {
    const play = setup()
    play.held.add({ start: 0, end: 500_000 })
    play.holding.begin('start')
    play.holding.dispose()
    play.link.rate = 5_000_000
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Nothing checked it: it is still on, and nothing played.
    expect(play.holding.holding).toBe(true)
    expect(play.calls).not.toContain('play')
  })
})

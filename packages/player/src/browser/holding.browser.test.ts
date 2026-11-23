// The hold for the network (DESIGN.md §10.4), on a fake element, downloader and feeder: which plays it holds,
// when it plays, and what it tells.

import type { TimelineEventInput } from '@dfs/shared'
import { describe, expect, test } from 'vitest'
import { STALL_GOAL_SECONDS } from '../limits.ts'
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
  /** What the engine answers to `canCheck`. */
  engine: { canCheck: boolean }
  /** What the hold reads as the time. */
  clock: { now: number }
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
  const engine = { canCheck: true }
  const clock = { now: 0 }
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
    windowLimitBytes: () => 64 * 1024 * 1024,
    canCheck: () => engine.canCheck,
    say: (event) => events.push(event),
    stats,
    changed: () => undefined,
    now: () => clock.now,
  })
  return { holding, events, video, held, calls, link, want, engine, clock, stats }
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
    // The slow goal keeps a read of margin and is capped by what remains, so the whole clip is what lets go.
    play.held.add({ start: 0, end: 10_000_000 })
    play.holding.check()
    expect(holds(play.events)[1]).toMatchObject({ on: false })
    expect(play.calls).toEqual([])
  })

  // The viewer's pause during a hold is a no-op on the element the hold already paused, so no `pause` event says it: `autoplay()` does.
  test('a hold ends with no play when autoplay() turns to no, and stops counting there', () => {
    const play = setup()
    play.holding.begin('start')
    expect(play.holding.holding).toBe(true)
    play.clock.now = 300
    play.want.autoplay = false
    play.holding.check()
    expect(play.holding.holding).toBe(false)
    expect(play.stats.holding).toBe(false)
    expect(play.stats.holds).toBe(1)
    expect(play.stats.holdMs).toBe(300)
    expect(holds(play.events)[1]).toMatchObject({ on: false, reason: null })
    // Time passing after the hold has ended adds nothing.
    play.clock.now = 900
    play.holding.check()
    expect(play.stats.holdMs).toBe(300)
    expect(play.calls).toEqual([])
  })

  test('a seek made while autoplay() says no begins no hold', () => {
    const play = setup({ at: 4 })
    play.want.autoplay = false
    play.holding.begin('seek', true)
    expect(holds(play.events)).toEqual([])
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

  // B2: the downloader that waits (its reads end and open again) still has a rate, and the hold goes by it as for `reading` (R47). A slow start waits the 2 s goal and no more (the user's decision of 2026-11-23); a slow stall waits for the rest.
  test('a hold decided while the downloader waits on a slow link is the 2 s goal at a start, and the long goal at a stall', () => {
    const play = setup()
    play.link.state = 'waiting'
    // 2.5 s of the video is stored: over the 2 s start goal, under what a link of a tenth of the bit rate needs after a stall.
    play.held.add({ start: 0, end: 2_500_000 })
    play.holding.begin('start')
    expect(play.holding.holding).toBe(false)
    play.video.paused = false
    play.video.currentTime = 1
    play.held.add({ start: 0, end: 3_500_000 })
    play.holding.stalled()
    expect(play.holding.holding).toBe(true)
    const on = holds(play.events)[0]
    expect(on).toMatchObject({ on: true, reason: 'stall' })
    // The slow goal (about 9 s here) is over the 4 s floor an unknown rate would give, and the store holds 3.5 s: under both.
    expect(on?.targetS).toBeGreaterThan(STALL_GOAL_SECONDS + 1)
  })

  // F5: the rate meter keeps a fast rate a few seconds after the link drops, so in a retry pause only a slow rate is trusted.
  test('a hold decided while the downloader waits, with a fast rate, keeps the 2 s goal, not a release', () => {
    const play = setup()
    play.link.state = 'waiting'
    play.link.rate = 5_000_000
    // 1 s of the video is stored: a fast rate would play at once, into an outage; the 2 s goal of an unknown rate holds.
    play.held.add({ start: 0, end: 1_000_000 })
    play.holding.begin('start')
    expect(play.holding.holding).toBe(true)
    expect(holds(play.events)[0]?.targetS).toBe(2)
  })

  test('a hold decided while the downloader reads, with a fast rate, plays at once', () => {
    const play = setup()
    play.link.rate = 5_000_000
    play.held.add({ start: 0, end: 1_000_000 })
    play.holding.begin('start')
    expect(play.holding.holding).toBe(false)
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

  // R44 item 1: the timer's check obeys the engine (busy, stopped, failed), and does not run after dispose.
  test('the timer does not release a hold while the engine says it cannot check', async () => {
    const play = setup()
    play.held.add({ start: 0, end: 500_000 })
    play.holding.begin('start')
    play.engine.canCheck = false
    play.link.rate = 5_000_000
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(true)
    expect(play.calls).not.toContain('play')
    // The engine can check again: the next check lets go.
    play.engine.canCheck = true
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(play.holding.holding).toBe(false)
  })

  // I1: a wanted seek outside the window holds at the seek on a slow link, before anything plays.
  describe('seekStarted', () => {
    test("on a slow link a playing seek holds at once with reason seek, and its own pause is not the viewer's", () => {
      const play = setup({ at: 4 })
      play.video.paused = false
      play.holding.seekStarted(true)
      expect(play.calls).toEqual(['pause'])
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      // The pause event the hold caused is the hold's, not the viewer's.
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      expect(play.stats.holds).toBe(0)
    })

    test('a link that keeps up holds nothing and does not pause', () => {
      const play = setup({ at: 4 })
      play.link.rate = 5_000_000
      play.video.paused = false
      play.holding.seekStarted(true)
      expect(play.holding.holding).toBe(false)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('a seek that is not playing, or whose autoplay() says no, holds nothing', () => {
      const idle = setup({ at: 4 })
      idle.holding.seekStarted(false)
      expect(holds(idle.events)).toEqual([])
      const vetoed = setup({ at: 4 })
      vetoed.video.paused = false
      vetoed.want.autoplay = false
      vetoed.holding.seekStarted(true)
      expect(holds(vetoed.events)).toEqual([])
      expect(vetoed.calls).toEqual([])
    })

    // The positions still hold the old runs at a seek's start: the offset the feeder gives is what the rule reads.
    test('the rule reads the offset the seek gives, not the positions of the old runs', () => {
      const play = setup({ at: 4, offset: 0 })
      // 2.5 s are stored at the old runs' offset, none at the target's.
      play.held.add({ start: 0, end: 2_500_000 })
      play.video.paused = false
      play.holding.seekStarted(true, 8_000_000)
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek', aheadS: 0 })
      // A seek whose target the store holds 2 s of at once does not pause.
      const held = setup({ at: 4 })
      held.held.add({ start: 8_000_000, end: 10_000_000 })
      held.video.paused = false
      held.holding.seekStarted(true, 8_000_000)
      expect(held.holding.holding).toBe(false)
      expect(held.calls).toEqual([])
    })

    test('a full store with nothing held at the target still holds; one that holds the target does not', () => {
      const play = setup({ at: 4 })
      play.link.state = 'full'
      play.video.paused = false
      play.holding.seekStarted(true, 8_000_000)
      expect(play.holding.holding).toBe(true)
      const held = setup({ at: 4 })
      held.link.state = 'full'
      held.held.add({ start: 8_000_000, end: 9_000_000 })
      held.video.paused = false
      held.holding.seekStarted(true, 8_000_000)
      expect(held.holding.holding).toBe(false)
    })

    test('with no autoplay it does nothing', () => {
      const play = setup({ at: 4, autoplay: null })
      play.video.paused = false
      play.holding.seekStarted(true)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('nothing to wait for (the download is done) holds nothing', () => {
      const play = setup({ at: 4 })
      play.link.state = 'done'
      play.video.paused = false
      play.holding.seekStarted(true)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('a stall hold that is on stays, its reason becomes seek, and the serve end keeps or releases it by the 2 s goal', () => {
      const play = setup({ at: 4 })
      play.video.paused = false
      play.video.currentTime = 4.5
      play.holding.stalled()
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'stall' })
      play.video.currentTime = 4
      play.holding.seekStarted(true)
      expect(play.holding.holding).toBe(true)
      expect(play.calls).toEqual(['pause'])
      expect(holds(play.events)).toHaveLength(1)
      // The serve's end: 1 s stored is under the 2 s goal, so the hold is kept (and says seek on its end).
      play.held.add({ start: 0, end: 1_000_000 })
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(true)
      expect(play.calls).toEqual(['pause'])
      // 2.5 s is over it: the hold ends, once, in a play.
      play.held.add({ start: 0, end: 2_500_000 })
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(false)
      expect(play.calls).toEqual(['pause', 'play'])
      expect(play.stats.holds).toBe(1)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    })

    test("the viewer's play ends the pre-hold, and a viewer's pause is caught by the check", () => {
      const played = setup({ at: 4 })
      played.video.paused = false
      played.holding.seekStarted(true)
      played.video.paused = false
      played.holding.played()
      expect(played.holding.holding).toBe(false)
      const paused = setup({ at: 4 })
      paused.video.paused = false
      paused.holding.seekStarted(true)
      paused.want.autoplay = false
      paused.holding.check()
      expect(paused.holding.holding).toBe(false)
      expect(paused.calls).toEqual(['pause'])
      expect(paused.stats.holds).toBe(1)
    })
  })
})

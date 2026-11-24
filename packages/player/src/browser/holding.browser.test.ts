// The hold for the network (DESIGN.md §10.4), on a fake element, downloader and feeder: which plays it holds,
// when it plays, and what it tells.

import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, describe, expect, test } from 'vitest'
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
  /** The element's buffered ranges, in seconds. */
  buffer: [number, number][]
  calls: string[]
  link: { state: string; rate: number | null }
  want: { autoplay: boolean }
  /** What the engine answers to `canCheck`. */
  engine: { canCheck: boolean; alive: boolean }
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
  const buffer: [number, number][] = []
  const video = { paused: true, ended: false, seeking: false, currentTime: options.at ?? 0 }
  const link = { state: 'reading', rate: 100_000 as number | null }
  const want = { autoplay: options.autoplay ?? true }
  const engine = { canCheck: true, alive: true }
  const clock = { now: 0 }
  const stats = { holding: false, holds: 0, holdMs: 0 }
  const element = Object.assign(video, {
    buffered: {
      get length() {
        return buffer.length
      },
      start: (i: number) => buffer[i]?.[0] ?? 0,
      end: (i: number) => buffer[i]?.[1] ?? 0,
    },
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
    alive: () => engine.alive,
    say: (event) => events.push(event),
    stats,
    changed: () => undefined,
    now: () => clock.now,
  })
  made.push(holding)
  return { holding, events, video, held, buffer, calls, link, want, engine, clock, stats }
}

/** Every hold a test made: each is disposed after the test, whether or not an `expect` threw. */
const made: Holding[] = []

afterEach(() => {
  for (const holding of made.splice(0)) holding.dispose()
})

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

  // The user's choice of 2026-11-23: a slow stall waits at most STALL_MAX_WAIT_SECONDS for its play-through goal, once the floor is stored.
  test('a slow stall with the floor stored holds until 10 s of waiting, then lets go', () => {
    const play = setup()
    // The clock starts well past 0: the wait is measured from the hold's own start.
    const origin = 50_000
    play.clock.now = origin
    play.video.paused = false
    play.video.currentTime = 3
    // 5 s stored: over the 4 s floor, under the long goal of a link at a tenth of the bit rate.
    play.held.add({ start: 0, end: 5_000_000 })
    play.holding.stalled()
    expect(play.holding.holding).toBe(true)
    expect(holds(play.events)[0]?.targetS).toBeGreaterThan(STALL_GOAL_SECONDS + 1)
    play.clock.now = origin + 9_900
    play.holding.check()
    expect(play.holding.holding).toBe(true)
    expect(play.calls).toEqual(['pause'])
    play.clock.now = origin + 10_000
    play.holding.check()
    expect(play.holding.holding).toBe(false)
    expect(play.calls).toEqual(['pause', 'play'])
    expect(holds(play.events)[1]).toMatchObject({
      on: false,
      reason: null,
      targetS: STALL_GOAL_SECONDS,
    })
  })

  test('a second stall after a first hold was left waits its own 10 s, from its own start', () => {
    const play = setup()
    play.clock.now = 50_000
    play.video.paused = false
    play.video.currentTime = 3
    play.held.add({ start: 0, end: 5_000_000 })
    play.holding.stalled()
    play.clock.now = 60_000
    play.holding.check()
    expect(play.holding.holding).toBe(false)
    // The element plays on and stalls again, 10 s later by the clock.
    play.video.currentTime = 4
    play.clock.now = 70_000
    play.holding.stalled()
    expect(play.holding.holding).toBe(true)
    play.clock.now = 79_900
    play.holding.check()
    expect(play.holding.holding).toBe(true)
    play.clock.now = 80_000
    play.holding.check()
    expect(play.holding.holding).toBe(false)
    expect(holds(play.events).map((event) => event.on)).toEqual([true, false, true, false])
  })

  test('a slow stall with less than the floor stored still holds at 10 s, and lets go when the floor is stored', () => {
    const play = setup()
    play.clock.now = 50_000
    play.video.paused = false
    play.video.currentTime = 3
    play.held.add({ start: 0, end: 3_000_000 })
    play.holding.stalled()
    expect(play.holding.holding).toBe(true)
    play.clock.now = 62_000
    play.holding.check()
    expect(play.holding.holding).toBe(true)
    play.held.add({ start: 0, end: 4_000_000 })
    play.holding.check()
    expect(play.holding.holding).toBe(false)
    expect(play.calls).toEqual(['pause', 'play'])
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

  // A: the viewer's "no" ends a hold at once, busy or not, while the play is alive; nothing plays.
  test('a busy engine: a seek hold whose autoplay() turns to no lets go within a tick, with no play, counted once', async () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    expect(play.holding.holding).toBe(true)
    play.engine.canCheck = false
    play.want.autoplay = false
    expect(play.holding.wantsPlay).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(false)
    expect(play.stats.holding).toBe(false)
    expect(play.calls).toEqual(['pause'])
    expect(play.stats.holds).toBe(1)
    expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    // The viewer plays again before the serve ends: no hold is on, and the serve's end (`begin`) holds it anew by the rule.
    play.want.autoplay = true
    play.held.add({ start: 0, end: 1_000_000 })
    play.holding.begin('seek', true)
    expect(play.holding.holding).toBe(true)
    expect(play.calls).toEqual(['pause'])
    expect(play.stats.holds).toBe(1)
  })

  test('a busy engine: a stall hold whose autoplay() turns to no lets go within a tick, with no play, counted once', async () => {
    const play = setup()
    play.video.paused = false
    play.video.currentTime = 0.5
    play.holding.stalled()
    expect(play.holding.holding).toBe(true)
    play.engine.canCheck = false
    play.want.autoplay = false
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(false)
    expect(play.stats.holds).toBe(1)
    expect(play.calls).toEqual(['pause'])
    expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
  })

  test('a play that is not alive (stopped or failed) does nothing at a tick, whatever autoplay() says', async () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    play.engine.alive = false
    play.engine.canCheck = false
    play.want.autoplay = false
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(true)
    expect(play.stats.holds).toBe(0)
    expect(holds(play.events).map((event) => event.on)).toEqual([true])
  })

  // A non-seek serve (a refeed, a reopen) ends with no `begin`: the timer's check decides once the engine can check.
  test("a stall hold kept by a busy serve is decided by the timer's check when the serve ends with no begin", async () => {
    const play = setup()
    play.video.paused = false
    play.video.currentTime = 3
    play.holding.stalled()
    play.engine.canCheck = false
    play.held.add({ start: 0, end: 9_000_000 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(true)
    play.engine.canCheck = true
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(play.holding.holding).toBe(false)
    expect(play.calls).toEqual(['pause', 'play'])
    expect(play.stats.holds).toBe(1)
  })

  test('a busy engine with autoplay() still yes leaves a seek hold on', async () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    play.engine.canCheck = false
    play.link.rate = 5_000_000
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(play.holding.holding).toBe(true)
    expect(play.calls).toEqual(['pause'])
  })

  test("a seek hold whose autoplay() turns to no ends at the serve's end, before any timer tick, with no play", () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    play.want.autoplay = false
    play.holding.begin('seek', true)
    expect(play.holding.holding).toBe(false)
    expect(play.calls).toEqual(['pause'])
    expect(play.stats.holds).toBe(1)
    expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
  })

  test('seekStarted with a hold on and the element playing (a play from outside) pauses it back, one hold', () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    expect(play.calls).toEqual(['pause'])
    // A play from outside (Picture-in-Picture's button) before the serve ends.
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    expect(play.calls).toEqual(['pause', 'pause'])
    expect(play.video.paused).toBe(true)
    expect(holds(play.events).map((event) => event.on)).toEqual([true])
    expect(play.stats.holds).toBe(0)
    // The pause event of that pause is the hold's, not the viewer's.
    play.holding.paused()
    expect(play.holding.holding).toBe(true)
  })

  test('played() with the element paused at dispatch is a stale event: it ends nothing', () => {
    const play = setup({ at: 4 })
    play.video.paused = false
    play.holding.seekStarted(true, 4, 4_000_000)
    expect(play.video.paused).toBe(true)
    play.holding.played()
    expect(play.holding.holding).toBe(true)
    expect(play.stats.holds).toBe(0)
    // With the element playing it ends the hold, as the viewer's play does.
    play.video.paused = false
    play.holding.played()
    expect(play.holding.holding).toBe(false)
    expect(play.stats.holds).toBe(1)
  })

  // I1: a wanted seek outside the window holds at the seek on a slow link, before anything plays. The seek's target is 4 s, its feed starts at the offset 4 MB (1 MB a second).
  // Task 5: a viewer's "no" leaves a standing goal, and a Play at the same place waits for it (final review I-1).
  describe('the standing goal', () => {
    /** A viewer's play: the element plays, then its event. */
    function viewerPlays(play: Setup): void {
      play.video.paused = false
      play.holding.played()
    }

    test('a hold left by autoplay() turning to no: a Play at the same place on a slow link holds again, the element paused back', () => {
      const play = setup({ at: 4 })
      play.holding.begin('seek', true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      play.want.autoplay = false
      play.holding.check()
      expect(play.holding.holding).toBe(false)
      play.want.autoplay = true
      viewerPlays(play)
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false, true])
      expect(holds(play.events)[2]).toMatchObject({ on: true, reason: 'seek' })
      expect(play.video.paused).toBe(true)
      expect(play.calls).toEqual(['pause'])
      // The pause event of that pause is the hold's own.
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
    })

    test("a hold the viewer's pause ended (a pause event that is not the hold's): a Play at the same place holds again", () => {
      const play = setup({ at: 4 })
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(true)
      // The element was paused already, so the hold made no pause: this event is the viewer's.
      play.holding.paused()
      expect(play.holding.holding).toBe(false)
      viewerPlays(play)
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false, true])
      expect(holds(play.events).at(-1)).toMatchObject({ on: true, reason: 'seek' })
      expect(play.video.paused).toBe(true)
    })

    test('on a link that keeps up, or with the goal already stored, a Play at the place is not held', () => {
      const fast = setup({ at: 4, offset: 4_000_000 })
      fast.holding.begin('seek', false)
      fast.link.rate = 5_000_000
      // Something is stored ahead (a fast link is never held with data at the target).
      fast.held.add({ start: 4_000_000, end: 4_500_000 })
      viewerPlays(fast)
      expect(fast.holding.holding).toBe(false)
      expect(fast.calls).toEqual([])

      const stored = setup({ at: 4, offset: 4_000_000 })
      stored.holding.begin('seek', false)
      stored.held.add({ start: 4_000_000, end: 10_000_000 })
      viewerPlays(stored)
      expect(stored.holding.holding).toBe(false)
      expect(holds(stored.events)).toEqual([])
    })

    test('a seek of the viewer (moved) ends the goal; the engine own seek keeps it', () => {
      const own = setup({ at: 4 })
      own.holding.begin('seek', false)
      own.holding.moved(true)
      viewerPlays(own)
      expect(holds(own.events)[0]).toMatchObject({ on: true, reason: 'seek' })

      const viewer = setup({ at: 4 })
      viewer.holding.begin('seek', false)
      viewer.holding.moved()
      viewerPlays(viewer)
      expect(holds(viewer.events)).toEqual([])
    })

    test('an engine own seek that moves the clock far keeps the goal, and a Play holds at the playhead it finds', () => {
      const play = setup({ at: 4 })
      play.holding.begin('seek', false)
      play.video.currentTime = 5
      play.holding.moved(true)
      viewerPlays(play)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
    })

    test('resumeHolds(): with a goal on a slow link it holds with no pause made; on a link that keeps up it plays on and the goal is gone; with no goal it does nothing', () => {
      const slow = setup({ at: 4 })
      slow.holding.begin('seek', false)
      expect(slow.holding.resumeHolds()).toBe(true)
      expect(holds(slow.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      expect(slow.calls).toEqual([])

      const fast = setup({ at: 4, offset: 4_000_000 })
      fast.holding.begin('seek', false)
      fast.link.rate = 5_000_000
      fast.held.add({ start: 4_000_000, end: 4_500_000 })
      expect(fast.holding.resumeHolds()).toBe(false)
      expect(holds(fast.events)).toEqual([])
      fast.video.paused = false
      fast.holding.played()
      expect(holds(fast.events)).toEqual([])

      const none = setup({ at: 4 })
      expect(none.holding.resumeHolds()).toBe(false)
      expect(holds(none.events)).toEqual([])
    })

    test("mediaLoaded() forgets the hold's queued pause: a viewer's pause after it ends the hold", () => {
      const play = setup({ at: 4 })
      play.video.paused = false
      play.holding.seekStarted(true, 4, 4_000_000)
      expect(play.calls).toEqual(['pause'])
      // A media load cancelled the pause event: none is delivered.
      play.holding.mediaLoaded()
      play.holding.paused()
      expect(play.holding.holding).toBe(false)
    })

    test('a seek not wanted, then a Play at the place on a slow link: a seek hold; the goal is used once', () => {
      const play = setup({ at: 4 })
      play.holding.begin('seek', false)
      expect(holds(play.events)).toEqual([])
      viewerPlays(play)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      // Used up: the viewer's next play (the hold ended by it) is not re-held.
      viewerPlays(play)
      expect(play.holding.holding).toBe(false)
      viewerPlays(play)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    })

    test('a start that is not wanted leaves a start goal', () => {
      const play = setup({ autoplay: false })
      play.holding.begin('start')
      play.want.autoplay = true
      viewerPlays(play)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'start' })
    })

    test('a Play while the engine cannot check holds at once with the goal reason; the check lets go when it can on a link that keeps up', () => {
      const play = setup({ at: 4, offset: 4_000_000 })
      play.holding.begin('seek', false)
      play.engine.canCheck = false
      viewerPlays(play)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      expect(play.video.paused).toBe(true)
      // The pause event of that pause is the hold's own.
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      // The serve is over and the link keeps up (something stored ahead): the check lets go and plays.
      play.engine.canCheck = true
      play.link.rate = 5_000_000
      play.held.add({ start: 4_000_000, end: 4_500_000 })
      play.holding.check()
      expect(play.holding.holding).toBe(false)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
      expect(play.calls).toEqual(['pause', 'play'])
    })

    test('a hold taken while the engine cannot check stays on a slow link until the goal is stored', () => {
      const play = setup({ at: 4, offset: 4_000_000 })
      play.holding.begin('seek', false)
      play.engine.canCheck = false
      viewerPlays(play)
      play.engine.canCheck = true
      play.holding.check()
      expect(play.holding.holding).toBe(true)
      play.held.add({ start: 4_000_000, end: 7_000_000 })
      play.holding.check()
      expect(play.holding.holding).toBe(false)
      expect(play.calls).toEqual(['pause', 'play'])
    })

    test('a Play while autoplay() is not true uses the goal up: a later Play holds nothing; a play that is not alive holds nothing', () => {
      const no = setup({ at: 4 })
      no.holding.begin('seek', false)
      no.engine.canCheck = false
      no.want.autoplay = false
      viewerPlays(no)
      expect(holds(no.events)).toEqual([])
      no.want.autoplay = true
      no.video.paused = true
      viewerPlays(no)
      expect(holds(no.events)).toEqual([])

      const dead = setup({ at: 4 })
      dead.holding.begin('seek', false)
      dead.engine.canCheck = false
      dead.engine.alive = false
      viewerPlays(dead)
      expect(holds(dead.events)).toEqual([])
    })

    test('a Play while autoplay() says no, or after dropGoal(), is not held', () => {
      const no = setup({ at: 4 })
      no.holding.begin('seek', false)
      no.want.autoplay = false
      viewerPlays(no)
      expect(holds(no.events)).toEqual([])

      const dropped = setup({ at: 4 })
      dropped.holding.begin('seek', false)
      dropped.holding.dropGoal()
      viewerPlays(dropped)
      expect(holds(dropped.events)).toEqual([])
    })

    test("the engine's own play never uses the goal", () => {
      const play = setup({ at: 4 })
      play.holding.begin('seek', false)
      // A wanted begin on a download that is done plays by itself: its play event finds no goal left.
      play.link.state = 'done'
      play.holding.begin('seek', true)
      expect(play.calls).toEqual(['play'])
      play.link.state = 'reading'
      play.holding.played()
      expect(holds(play.events)).toEqual([])
    })
  })

  describe('seekStarted', () => {
    const TO = 4
    const AT = 4_000_000

    test("on a slow link a playing seek holds at once with reason seek, and its own pause is not the viewer's", () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(play.calls).toEqual(['pause'])
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek' })
      // The pause event the hold caused is the hold's, not the viewer's.
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      expect(play.stats.holds).toBe(0)
    })

    // F1: a hold always means a paused element. A viewer's play (the engine's C path) with nothing left to wait for leaves the hold; the element already plays.
    test('seekStarted with a hold on, the element playing and nothing to wait for leaves the hold, with no play, counted once', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(play.holding.holding).toBe(true)
      // A link that keeps up now: goal 0. The viewer's play is the element playing.
      play.link.rate = 5_000_000
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(play.holding.holding).toBe(false)
      expect(play.stats.holding).toBe(false)
      expect(play.video.paused).toBe(false)
      expect(play.calls).toEqual(['pause'])
      expect(play.stats.holds).toBe(1)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    })

    test('begin(seek) holding with a hold on and the element playing pauses it back, still one hold', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      play.video.paused = false
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(true)
      expect(play.video.paused).toBe(true)
      expect(play.calls).toEqual(['pause', 'pause'])
      expect(play.stats.holds).toBe(0)
      expect(holds(play.events).map((event) => event.on)).toEqual([true])
      // One `pause` event for each pause the hold made.
      play.holding.paused()
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
    })

    // G1: the hold's own pauses are counted, one per `video.pause()` it made, however many `pause` events are queued before the first dispatches.
    test("two pauses the hold made, both events queued after both: neither is the viewer's", () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(play.calls).toEqual(['pause', 'pause'])
      play.holding.paused()
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      expect(play.stats.holds).toBe(0)
      // A third `pause` event is the viewer's (the element is paused): it ends the hold.
      play.holding.paused()
      expect(play.holding.holding).toBe(false)
      expect(play.stats.holds).toBe(1)
    })

    test('a stale pause (the element plays at dispatch) ends nothing, and does not hide the hold-made pause count', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      // The viewer plays (the hold ends it by played()), the stale pause of the hold's own arrives with the element playing.
      play.video.paused = false
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      // A pause event with no hold-made pause outstanding, the element playing: stale.
      play.holding.paused()
      expect(play.holding.holding).toBe(true)
      expect(play.stats.holds).toBe(0)
    })

    test('a link that keeps up holds nothing and does not pause', () => {
      const play = setup({ at: TO })
      play.link.rate = 5_000_000
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(play.holding.holding).toBe(false)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('a seek that is not playing, or whose autoplay() says no, holds nothing', () => {
      const idle = setup({ at: TO })
      idle.holding.seekStarted(false, TO, AT)
      expect(holds(idle.events)).toEqual([])
      const vetoed = setup({ at: TO })
      vetoed.video.paused = false
      vetoed.want.autoplay = false
      vetoed.holding.seekStarted(true, TO, AT)
      expect(holds(vetoed.events)).toEqual([])
      expect(vetoed.calls).toEqual([])
    })

    test('with no autoplay it does nothing', () => {
      const play = setup({ at: TO, autoplay: null })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('nothing to wait for (the download is done) holds nothing', () => {
      const play = setup({ at: TO })
      play.link.state = 'done'
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('a null offset with a hold on and the element playing leaves the hold: nothing to wait for', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      play.video.paused = false
      play.holding.seekStarted(true, TO, null)
      expect(play.holding.holding).toBe(false)
      expect(play.stats.holds).toBe(1)
    })

    test('a null offset (the feed has no next read) holds nothing', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.holding.seekStarted(true, TO, null)
      expect(holds(play.events)).toEqual([])
      expect(play.calls).toEqual([])
    })

    test('a store that holds to the end of the file from the offset has nothing to wait for', () => {
      const play = setup({ at: TO })
      play.held.add({ start: AT, end: FILE_BYTES })
      play.video.paused = false
      play.holding.seekStarted(true, TO, AT)
      expect(holds(play.events)).toEqual([])
    })

    // The positions still hold the old runs at a seek's start, and the store's state is the old position's: neither is read.
    test('the pre-hold ignores the store: a stale full state with some bytes ahead, or 2 s held, still holds', () => {
      const full = setup({ at: TO, offset: 0 })
      full.link.state = 'full'
      full.held.add({ start: AT, end: AT + 1_000_000 })
      full.video.paused = false
      full.holding.seekStarted(true, TO, AT)
      expect(full.holding.holding).toBe(true)
      expect(holds(full.events)[0]).toMatchObject({ on: true, reason: 'seek', aheadS: 1 })

      // 2.5 s are held from the offset: the pre-hold pauses, and the serve's end lets go at once and plays.
      // (The fed positions at the serve's end are at the offset.)
      const held = setup({ at: TO, offset: AT })
      held.held.add({ start: AT, end: AT + 2_500_000 })
      held.video.paused = false
      held.holding.seekStarted(true, TO, AT)
      expect(held.holding.holding).toBe(true)
      expect(held.calls).toEqual(['pause'])
      held.holding.begin('seek', true)
      expect(held.holding.holding).toBe(false)
      expect(held.calls).toEqual(['pause', 'play'])
      expect(held.stats.holds).toBe(1)
    })

    test("the goal is the target's remaining time near the end", () => {
      const play = setup({ at: 0 })
      play.video.paused = false
      // The clock is not at the target yet; 1 s remains of the target's 10 s.
      play.holding.seekStarted(true, 9, 9_000_000)
      expect(holds(play.events)[0]?.targetS).toBeCloseTo(1, 3)
    })

    test('a stall hold that is on stays, its reason becomes seek, and the serve end keeps or releases it by the 2 s goal', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.video.currentTime = 4.5
      play.holding.stalled()
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'stall' })
      play.video.currentTime = TO
      play.holding.seekStarted(true, TO, AT)
      expect(play.holding.holding).toBe(true)
      expect(play.calls).toEqual(['pause'])
      expect(holds(play.events)).toHaveLength(1)
      // The serve's end: 1 s stored is under the 2 s goal, so the hold is kept.
      play.held.add({ start: 0, end: 1_000_000 })
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(true)
      // 2.5 s is over it: the hold ends, once, in a play.
      play.held.add({ start: 0, end: 2_500_000 })
      play.holding.begin('seek', true)
      expect(play.holding.holding).toBe(false)
      expect(play.calls).toEqual(['pause', 'play'])
      expect(play.stats.holds).toBe(1)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    })

    test('a seek that is not wanted ends a hold that is on, with no play, counted once', () => {
      const play = setup({ at: TO })
      play.video.paused = false
      play.video.currentTime = 4.5
      play.holding.stalled()
      expect(play.holding.holding).toBe(true)
      play.video.currentTime = TO
      play.want.autoplay = false
      play.holding.seekStarted(false, TO, AT)
      expect(play.holding.holding).toBe(false)
      expect(play.video.paused).toBe(true)
      expect(play.calls).toEqual(['pause'])
      expect(play.stats.holds).toBe(1)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
    })

    test("the viewer's play ends the pre-hold, and a viewer's pause is caught by a check made after the serve", () => {
      const played = setup({ at: TO })
      played.video.paused = false
      played.holding.seekStarted(true, TO, AT)
      played.video.paused = false
      played.holding.played()
      expect(played.holding.holding).toBe(false)
      const paused = setup({ at: TO })
      paused.video.paused = false
      paused.holding.seekStarted(true, TO, AT)
      paused.want.autoplay = false
      paused.holding.check()
      expect(paused.holding.holding).toBe(false)
      expect(paused.calls).toEqual(['pause'])
      expect(paused.stats.holds).toBe(1)
    })
  })

  // F1 (Gemini, task 2): the rule's ahead is the larger of the store's and the element's, so a seek the decoder window covers is not held for want of stored bytes (blocks evicted behind the position, a fresh memory store).
  describe("the element's buffer counts toward what is ahead", () => {
    test('a seek the element covers by the goal is not held, with nothing stored: slow link and fast link', () => {
      for (const rate of [100_000, 2_000_000]) {
        const play = setup({ at: 3 })
        play.link.rate = rate
        play.video.paused = false
        play.buffer.push([0, 6])
        play.holding.begin('seek', true)
        expect(holds(play.events)).toEqual([])
        expect(play.holding.holding).toBe(false)
        expect(play.calls).toEqual([])
      }
    })

    test("a seek the element covers by 1 s holds on a slow link, and the event's aheadS is that 1 s", () => {
      const play = setup({ at: 3 })
      play.video.paused = false
      play.buffer.push([0, 4])
      play.holding.begin('seek', true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek', aheadS: 1 })
    })

    test("the store ahead wins when it is larger than the element's smaller non-zero buffer", () => {
      const play = setup({ at: 3, offset: 3_000_000 })
      play.video.paused = false
      play.held.add({ start: 3_000_000, end: 4_000_000 })
      play.buffer.push([0, 3.5])
      play.holding.begin('seek', true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'seek', aheadS: 1 })
    })

    // A slow stall's goal is a byte budget from the file's average bit rate: decoded seconds of a thin stretch must not release it early.
    test("a stall's hold is released by the store, not by the element's buffer (a buffer past the goal does not let it go)", () => {
      const play = setup({ at: 3, offset: 3_000_000 })
      // A link at half the bit rate: the goal is about 4.7 s, under the 7 s left, so the rule (not the end of the file) decides.
      play.link.rate = 500_000
      play.video.paused = false
      play.held.add({ start: 3_000_000, end: 4_000_000 })
      // The element is dry: the stall holds, at the store's 1 s.
      play.holding.stalled()
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'stall', aheadS: 1 })
      expect(holds(play.events)[0]?.targetS).toBeGreaterThan(STALL_GOAL_SECONDS)
      expect(holds(play.events)[0]?.targetS).toBeLessThan(7)
      // The element then holds well past the goal, and the store is still short: the hold stays.
      play.buffer.push([0, 20])
      play.holding.check()
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events)).toHaveLength(1)
      // The store grows past the goal, short of the end of the file: the rule lets go, and plays.
      play.held.add({ start: 4_000_000, end: 8_000_000 })
      play.holding.check()
      expect(play.holding.holding).toBe(false)
      expect(holds(play.events).map((event) => event.on)).toEqual([true, false])
      expect(holds(play.events)[1]).toMatchObject({ on: false, aheadS: 5 })
      expect(play.calls.at(-1)).toBe('play')
    })

    test('a stall entered with the element already buffered past the goal still holds on a short store', () => {
      const play = setup({ at: 3, offset: 3_000_000 })
      play.link.rate = 500_000
      play.video.paused = false
      play.held.add({ start: 3_000_000, end: 4_000_000 })
      play.buffer.push([0, 20])
      play.holding.stalled()
      expect(play.holding.holding).toBe(true)
      expect(holds(play.events)[0]).toMatchObject({ on: true, reason: 'stall', aheadS: 1 })
    })
  })
})

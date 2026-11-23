// The engine's controls in a real browser (DESIGN.md §10.4): seeks (in the window, outside it, during the
// opening, and back after the end), the hold for the network, and the watchdog. The synthetic corpus, served by
// the play server, goes through `playStreamed` into a `video` element; the server's log says which requests the
// engine made, and its control channel slows the link or breaks a read. The plays of the first part are in
// engine.browser.test.ts. A file that is not served (no `corpus:make`) skips its tests, with the reason.

import { afterEach, expect, test, vi } from 'vitest'
import { Feeder } from '../engine/feeder.ts'
import { MediaSourceSink } from '../page/index.ts'
import { Seeks } from '../page/seeks.ts'
import {
  SEEK_DEADLINE_MS,
  STALL_GOAL_SECONDS,
  START_GOAL_SECONDS,
  STUCK_MS,
  WATCH_EVERY_MS,
  WINDOW_AHEAD_SECONDS,
  WINDOW_BYTES,
} from '../limits.ts'
import { begin, endPlays, frames, ofType, served, suite, until } from './play-harness.ts'
import type { Play } from './play-harness.ts'
import { clearLog, control, log } from './server.ts'

const NAME = 'h264-aac-faststart.mp4'

// Slow links make these plays take a while.
vi.setConfig({ testTimeout: 90_000 })

afterEach(async () => {
  vi.restoreAllMocks()
  await endPlays()
})

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The end of the element's last buffered range, 0 when it has none. */
function bufferedEnd(video: HTMLVideoElement): number {
  const { buffered } = video
  return buffered.length === 0 ? 0 : buffered.end(buffered.length - 1)
}

/** Whether the element has data at `at`. */
function holds(video: HTMLVideoElement, at: number): boolean {
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= at && at <= video.buffered.end(i)) return true
  }
  return false
}

/** The seeks that have shown their picture. */
function shown(play: Play): { to: number; inWindow: boolean; ms: number | null }[] {
  return ofType(play.events, 'seek').filter((event) => event.ms !== null)
}

async function firstPicture(play: Play): Promise<void> {
  await until(play, 'the first picture', 40_000, () => play.video.readyState >= 2)
}

suite(NAME)('playStreamed: seeks', () => {
  test('a seek inside the window sends no request, and tells its start and its picture', async () => {
    // A slow link keeps a read open and the window short of the end of the file.
    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(NAME)
    await firstPicture(play)
    await until(play, '4 s buffered', 40_000, () => bufferedEnd(play.video) > 4)
    await clearLog()
    play.video.currentTime = 2
    await until(play, 'the seek to show its picture', 20_000, () => shown(play).length > 0)
    const seeks = ofType(play.events, 'seek')
    expect(seeks).toHaveLength(2)
    expect(seeks[0]?.to).toBeCloseTo(2, 2)
    expect(seeks[0]).toMatchObject({ inWindow: true, ms: null })
    expect(seeks[1]).toMatchObject({ inWindow: true })
    expect(seeks[1]?.ms).toBeGreaterThanOrEqual(0)
    expect(play.video.currentTime).toBeCloseTo(2, 1)
    expect(await log()).toEqual([])
    await until(play, 'the numbers', 5_000, () => play.stats.length > 0)
    expect(play.stats.at(-1)?.seeks).toBe(0)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('a seek outside the window reads the store when it holds the place: no request', async () => {
    // A window of 2 MiB holds about 5 s of this file, and the store the whole of it.
    const size = served(NAME)?.size ?? 0
    const play = begin(NAME, { windowBytes: 2 * 1024 * 1024 })
    await firstPicture(play)
    await until(
      play,
      'the file stored',
      30_000,
      () => (play.stats.at(-1)?.storedBytes ?? 0) >= size,
    )
    expect(holds(play.video, 10)).toBe(false)
    await clearLog()
    play.video.currentTime = 10
    await until(play, 'the seek to show its picture', 20_000, () => shown(play).length > 0)
    const seeks = ofType(play.events, 'seek')
    expect(seeks[0]).toMatchObject({ inWindow: false, ms: null })
    expect(seeks.at(-1)).toMatchObject({ inWindow: false })
    expect(play.video.currentTime).toBeGreaterThanOrEqual(9.9)
    expect(holds(play.video, play.video.currentTime)).toBe(true)
    expect(await log()).toEqual([])
    await until(play, 'the count', 5_000, () => play.stats.at(-1)?.seeks === 1)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('a seek outside what the store holds fetches from the place, keeping what is stored', async () => {
    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(NAME)
    await firstPicture(play)
    await clearLog()
    play.video.currentTime = 8
    await until(play, 'the seek to show its picture', 60_000, () => shown(play).length > 0)
    expect(play.video.currentTime).toBeGreaterThanOrEqual(7.9)
    const requests = await log()
    const starts = requests.flatMap((entry) => {
      const match = /bytes=(\d+)-/.exec(entry.range ?? '')
      return match?.[1] === undefined ? [] : [Number(match[1])]
    })
    // The picture of 8 s lies about two thirds into the file.
    expect(starts.some((start) => start > 2_500_000)).toBe(true)
    expect(ofType(play.events, 'seek')[0]).toMatchObject({ inWindow: false, ms: null })
    expect(shown(play)[0]?.ms).toBeGreaterThan(0)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('a seek made while a seek outside the window is served is served too, and lands at its own target (F3)', async () => {
    // The first feed after the serve's seek ends late: the serve stays busy, with data from its target already in the buffer.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the originals are called on the feeder they were taken from, below.
    const { seek: realSeek, feed: realFeed } = Feeder.prototype
    const watch = { on: false, delayNext: false }
    vi.spyOn(Feeder.prototype, 'seek').mockImplementation(async function (
      this: Feeder,
      ...args: Parameters<Feeder['seek']>
    ) {
      await realSeek.apply(this, args)
      if (watch.on) watch.delayNext = true
    })
    vi.spyOn(Feeder.prototype, 'feed').mockImplementation(async function (
      this: Feeder,
      ...args: Parameters<Feeder['feed']>
    ) {
      const result = await realFeed.apply(this, args)
      if (watch.delayNext) {
        watch.delayNext = false
        await pause(3_000)
      }
      return result
    })
    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(NAME)
    await firstPicture(play)
    watch.on = true
    play.video.currentTime = 8
    await until(play, 'data from the first target', 30_000, () => bufferedEnd(play.video) > 8.8)
    const before = ofType(play.events, 'seek').length
    play.video.currentTime = 8.3
    await until(play, "the second seek's picture", 20_000, () =>
      shown(play).some((seek) => Math.abs(seek.to - 8.3) < 0.1),
    )
    expect(play.video.currentTime).toBeGreaterThanOrEqual(8.25)
    expect(play.video.currentTime).toBeLessThan(8.8)
    // The second seek was posted as a request, not taken as inside the window.
    expect(ofType(play.events, 'seek')[before]).toMatchObject({ inWindow: false, ms: null })
    await pause(SEEK_DEADLINE_MS + 1_000)
    expect(ofType(play.events, 'error')).toEqual([])
  }, 60_000)

  test('a seek made during the opening is kept, and lands at its target', async () => {
    let sought = false
    const play = begin(NAME, {
      onEvent: (event, started) => {
        if (event.type === 'append' && !sought) {
          sought = true
          started.video.currentTime = 6
        }
      },
    })
    await until(
      play,
      'the clock at 6 s with a picture',
      30_000,
      () => play.video.readyState >= 2 && play.video.currentTime >= 5.9,
    )
    expect(play.video.currentTime).toBeLessThan(7)
    expect(holds(play.video, play.video.currentTime)).toBe(true)
    await play.video.play()
    await until(play, '6.5 s', 15_000, () => play.video.currentTime > 6.5)
    expect(frames(play.video)).toBeGreaterThan(0)
    const seeks = ofType(play.events, 'seek')
    expect(seeks[0]?.to).toBeCloseTo(6, 1)
    await until(play, 'its picture', 10_000, () => shown(play).length > 0)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('a seek made before the sink has its tracks is kept too, and does not fail the play', async () => {
    let sought = false
    const play = begin(NAME, {
      onEvent: (event, started) => {
        // The phase `buffering` comes before the first feed, which is what gives the sink its tracks.
        if (event.type === 'phase' && event.phase === 'buffering' && !sought) {
          sought = true
          started.video.currentTime = 6
        }
      },
    })
    await until(
      play,
      'the clock at 6 s with a picture',
      30_000,
      () => play.video.readyState >= 2 && play.video.currentTime >= 5.9,
    )
    expect(play.video.currentTime).toBeLessThan(7)
    expect(ofType(play.events, 'error')).toEqual([])
    expect(ofType(play.events, 'phase').some((event) => event.phase === 'failed')).toBe(false)
  })

  test('a seek that shows no picture by its deadline sends an error, refeeds, and still sends its time to picture', async () => {
    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(NAME)
    await firstPicture(play)
    // The seek makes two reads of its place (the download's onward read and the feed's own); both stall for good, and the ones after them go through.
    await control({
      bandwidthBytesPerSecond: 300_000,
      faults: [
        { kind: 'stall', afterBytes: 0, ms: null },
        { kind: 'stall', afterBytes: 0, ms: null },
      ],
    })
    await clearLog()
    play.video.currentTime = 8
    await until(play, 'the deadline error', SEEK_DEADLINE_MS + 20_000, () =>
      ofType(play.events, 'error').some((event) => event.from === 'engine'),
    )
    const error = ofType(play.events, 'error').find((event) => event.from === 'engine')
    expect(error?.message).toContain('8')
    expect(error?.message).toContain(String(SEEK_DEADLINE_MS / 1000))
    await until(play, 'the picture', 60_000, () => shown(play).length > 0)
    expect(shown(play)[0]?.ms).toBeGreaterThanOrEqual(SEEK_DEADLINE_MS)
    // The serve of the seek is already feeding at its target: the deadline posts no refeed on top of it.
    expect(ofType(play.events, 'watchdog').filter((event) => event.action === 'refeed')).toEqual([])
    // The error comes before the seek that tells its time, and the seek is told once.
    const order = play.events.map((event) => event.type)
    expect(order.indexOf('error')).toBeLessThan(
      play.events.findIndex((event) => event.type === 'seek' && event.ms !== null),
    )
    expect(ofType(play.events, 'seek').filter((event) => event.ms !== null)).toHaveLength(1)
    expect(play.video.currentTime).toBeGreaterThanOrEqual(7.9)
  }, 120_000)

  test('a seek served from the store that shows no picture by its deadline sends an error and refeeds, once, and still sends its time to picture (A5)', async () => {
    const size = served(NAME)?.size ?? 0
    const play = begin(NAME)
    await firstPicture(play)
    await until(play, '4 s buffered', 40_000, () => bufferedEnd(play.video) > 4)
    // The whole file stored first: an onward read still under way would be a request that is not the seek's.
    await until(
      play,
      'the file stored',
      30_000,
      () => (play.stats.at(-1)?.storedBytes ?? 0) >= size,
    )
    // The picture is late: the seek's check finds none, as if the decoder held it back. Nothing is requested or served, so the engine is not busy.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is called on the seeks it was taken from, below.
    const real = Seeks.prototype.check
    let late = true
    vi.spyOn(Seeks.prototype, 'check').mockImplementation(function (this: Seeks) {
      if (!late) real.call(this)
    })
    await clearLog()
    play.video.currentTime = 2
    await until(play, 'the deadline error', SEEK_DEADLINE_MS + 5_000, () =>
      ofType(play.events, 'error').some((event) => event.from === 'engine'),
    )
    const error = ofType(play.events, 'error').find((event) => event.from === 'engine')
    expect(error?.message).toContain('2.0')
    expect(error?.message).toContain(String(SEEK_DEADLINE_MS / 1000))
    // The refeed follows at once, from the store: no request is made.
    const refeeds = ofType(play.events, 'watchdog').filter((event) => event.action === 'refeed')
    expect(refeeds).toHaveLength(1)
    expect(refeeds[0]?.detail).toContain('deadline')
    late = false
    await until(play, "the seek's picture", 20_000, () => shown(play).length > 0)
    expect(shown(play).at(-1)?.ms).toBeGreaterThanOrEqual(SEEK_DEADLINE_MS)
    expect(await log()).toEqual([])
    expect(play.video.currentTime).toBeGreaterThanOrEqual(1.9)
  }, 60_000)

  test('a seek back after the end reopens the stream, stays paused as it was, and plays on when the viewer plays', async () => {
    const reopen = vi.spyOn(MediaSourceSink.prototype, 'reopen')
    const play = begin(NAME, { windowBytes: 2 * 1024 * 1024, autoplay: () => true })
    play.video.playbackRate = 4
    await until(play, 'the end', 60_000, () => play.video.ended)
    await until(
      play,
      'the phase',
      5_000,
      () => ofType(play.events, 'phase').at(-1)?.phase === 'ended',
    )
    // What was played has been removed from the window: 1 s is outside it.
    expect(holds(play.video, 1)).toBe(false)
    play.video.currentTime = 1
    await until(play, 'the seek to show its picture', 30_000, () => shown(play).length > 0)
    // A seek made while paused after the end stays paused, as in a native player; the viewer plays on.
    expect(play.video.paused).toBe(true)
    expect(play.video.currentTime).toBeCloseTo(1, 0)
    await play.video.play()
    await until(
      play,
      'the play to go on from 1 s',
      30_000,
      () => !play.video.ended && play.video.currentTime > 2.5,
    )
    expect(reopen).toHaveBeenCalledTimes(1)
    const last = ofType(play.events, 'seek').at(-1)
    expect(last).toMatchObject({ inWindow: false })
    // The seek tells its time to picture, though the count of frames restarted with the new Media Source.
    expect(shown(play).at(-1)?.ms).not.toBeNull()
    expect(ofType(play.events, 'phase').map((event) => event.phase)).toContain('ended')
    expect(ofType(play.events, 'error')).toEqual([])
  })
})

// The sound of `late-sound.mp4` is shown from 0.4787 s, the picture from 0: a seek to 0.35 s lies in the band that
// the window's edge tolerance counts as inside the window, though the element has no data there (A4).
suite('late-sound.mp4')('playStreamed: a seek just before a range starts', () => {
  const LATE = 'late-sound.mp4'

  for (const playing of [false, true]) {
    test(`${playing ? 'a playing' : 'a paused'} seek to just before the tracks' common start moves to it, with no refeed, gap or deadline`, async () => {
      const play = begin(LATE)
      await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
      await until(play, '2 s buffered', 15_000, () => bufferedEnd(play.video) > 2)
      if (playing) await play.video.play()
      await until(play, 'the clock past 1 s', 15_000, () => !playing || play.video.currentTime > 1)
      const start = play.video.buffered.start(0)
      expect(start).toBeGreaterThan(0.4)
      const target = 0.35
      expect(start - target).toBeGreaterThan(0.1)
      const before = play.events.length
      const seeked = shown(play).length
      const from = performance.now()
      play.video.currentTime = target
      await until(play, "the seek's picture", 3_000, () => shown(play).length > seeked)
      expect(performance.now() - from).toBeLessThan(2_000)
      const seeks = ofType(play.events, 'seek')
      expect(seeks.at(-1)).toMatchObject({ inWindow: true, to: expect.closeTo(start, 2) as number })
      expect(play.video.currentTime).toBeGreaterThanOrEqual(start - 0.01)
      // The engine says where it moved the clock to, as the common start says it, and the watchdog does nothing.
      const after = play.events.slice(before)
      const gaps = ofType(after, 'watchdog').filter((event) => event.action === 'gap')
      expect(gaps).toHaveLength(1)
      expect(gaps[0]?.detail).toContain('play starts there')
      await pause(WATCH_EVERY_MS * 2)
      const later = play.events.slice(before)
      expect(ofType(later, 'watchdog').filter((event) => event.action === 'refeed')).toEqual([])
      expect(
        ofType(later, 'watchdog').filter((event) => event.detail.includes('stood still')),
      ).toEqual([])
      expect(ofType(later, 'error')).toEqual([])
    })
  }
})

suite(NAME)('playStreamed: a seek just past the last frame', () => {
  test('after the end, a seek within the window to just past the last frame tells its picture, with no deadline error or reopen (A4)', async () => {
    const reopen = vi.spyOn(MediaSourceSink.prototype, 'reopen')
    const play = begin(NAME, { autoplay: () => true })
    play.video.playbackRate = 4
    await until(play, 'the end', 60_000, () => play.video.ended)
    await until(
      play,
      'the phase',
      5_000,
      () => ofType(play.events, 'phase').at(-1)?.phase === 'ended',
    )
    const end = bufferedEnd(play.video)
    expect(holds(play.video, end - 0.1)).toBe(true)
    const before = ofType(play.events, 'seek').length
    const seeked = shown(play).length
    play.video.currentTime = end + 0.1
    await until(play, "the seek's picture", 3_000, () => shown(play).length > seeked)
    expect(ofType(play.events, 'seek').length).toBeGreaterThan(before)
    expect(shown(play).at(-1)?.ms).not.toBeNull()
    await pause(SEEK_DEADLINE_MS + 1_000)
    expect(ofType(play.events, 'error')).toEqual([])
    expect(reopen).not.toHaveBeenCalled()
  }, 30_000)
})

suite(NAME)('playStreamed: holding', () => {
  test('with autoplay on a slow link the play is held, and then plays by itself', async () => {
    await control({ bandwidthBytesPerSecond: 200_000 })
    const play = begin(NAME, { autoplay: () => true })
    await until(play, 'the hold to begin', 40_000, () =>
      ofType(play.events, 'hold').some((event) => event.on),
    )
    const first = ofType(play.events, 'hold')[0]
    // A start finds START_GOAL_SECONDS already held when the first whole read covers it at this file's bit rate, so the first hold may be a stall.
    expect(first?.on).toBe(true)
    expect(['start', 'stall']).toContain(first?.reason)
    expect(play.video.paused).toBe(true)
    const at = play.video.currentTime
    await until(play, 'the hold to end', 90_000, () =>
      ofType(play.events, 'hold').some((event) => !event.on),
    )
    await until(
      play,
      'the clock to move on from the hold',
      30_000,
      () => play.video.currentTime > at + 0.5 && !play.video.paused,
    )
    expect(frames(play.video)).toBeGreaterThan(0)
    await until(play, 'the numbers', 5_000, () => (play.stats.at(-1)?.holds ?? 0) >= 1)
    expect(play.stats.at(-1)?.holdMs).toBeGreaterThan(0)
    // The first hold met its rule, whichever it was, so this runs once and cannot pass by not running.
    const bitrate = (served(NAME)?.size ?? 0) / play.video.duration
    expect(Number.isFinite(bitrate) && bitrate > 0, 'a bit rate to judge the goal by').toBe(true)
    if (first?.reason === 'start') {
      expect(first.targetS).toBeLessThanOrEqual(START_GOAL_SECONDS + 1e-6)
    } else {
      expect(first?.targetS).toBeGreaterThanOrEqual(STALL_GOAL_SECONDS - 1e-6)
      expect(first?.targetS).toBeLessThanOrEqual(
        Math.max(STALL_GOAL_SECONDS, 0.9 * Math.min(WINDOW_AHEAD_SECONDS, WINDOW_BYTES / bitrate)) +
          1e-6,
      )
    }
    for (const event of ofType(play.events, 'hold')) {
      if (event.on && event.reason === 'start') {
        expect(event.targetS).toBeLessThanOrEqual(START_GOAL_SECONDS + 1e-6)
      }
    }
    expect(ofType(play.events, 'error')).toEqual([])
  }, 150_000)

  test('without autoplay the engine never plays and never holds', async () => {
    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(NAME)
    await firstPicture(play)
    await pause(1_500)
    expect(play.video.paused).toBe(true)
    expect(play.video.currentTime).toBeLessThan(0.1)
    expect(ofType(play.events, 'hold')).toEqual([])
    expect(play.stats.at(-1)?.holding).toBe(false)
  })

  test('a stall after the play began holds it for the network, and plays on when it has enough', async () => {
    await control({ bandwidthBytesPerSecond: 600_000 })
    const play = begin(NAME, { autoplay: () => true })
    await until(play, 'the play', 60_000, () => !play.video.paused && play.video.currentTime > 0.3)
    // The link all but stops: the playhead soon reaches the end of what the store holds.
    await control({ bandwidthBytesPerSecond: 15_000 })
    await until(play, 'a hold for the stall', 60_000, () =>
      ofType(play.events, 'hold').some((event) => event.on && event.reason === 'stall'),
    )
    expect(play.video.paused).toBe(true)
    await control({ bandwidthBytesPerSecond: 3_000_000 })
    await until(play, 'the hold to end', 60_000, () =>
      ofType(play.events, 'hold').some((event) => !event.on && event.reason === null),
    )
    const at = play.video.currentTime
    await until(play, 'the play to go on', 30_000, () => play.video.currentTime > at + 1)
    expect(play.video.paused).toBe(false)
    expect(ofType(play.events, 'error')).toEqual([])
  }, 200_000)
})

/** The SourceBuffers that the engine makes, with a way to cut the same time out of all of them. */
function captureBuffers(): { cutAll: (from: number, to: number) => Promise<void> } {
  const made: SourceBuffer[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is called on the Media Source it was taken from, below.
  const real = MediaSource.prototype.addSourceBuffer
  vi.spyOn(MediaSource.prototype, 'addSourceBuffer').mockImplementation(function (
    this: MediaSource,
    type: string,
  ) {
    const buffer = real.call(this, type)
    made.push(buffer)
    return buffer
  })
  // The clock follows the sound when only the picture has a hole, so a hole that stops it is in both.
  return {
    cutAll: async (from, to) => {
      // One after the other: a removal on one buffer must not meet an append on the other.
      for (const buffer of made) await cut(buffer, from, to, made)
    },
  }
}

/** Whether any of the SourceBuffers is busy. */
function busy(buffers: readonly SourceBuffer[]): boolean {
  return buffers.some((buffer) => buffer.updating)
}

/** Removes the time from `from` to `to` of a SourceBuffer, once none of the engine's buffers is busy, and waits for the removal to end; once more if the browser says it was busy after all. */
async function cut(
  buffer: SourceBuffer,
  from: number,
  to: number,
  all: readonly SourceBuffer[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    while (busy(all)) await pause(10)
    const ended = new Promise<void>((resolve) => {
      buffer.addEventListener(
        'updateend',
        () => {
          resolve()
        },
        { once: true },
      )
    })
    try {
      buffer.remove(from, to)
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === 'InvalidStateError') {
        await pause(20)
        continue
      }
      throw error
    }
    await ended
    return
  }
}

suite(NAME)('playStreamed: the watchdog', () => {
  test('steps over a small hole that stops the clock, and logs the gap', async () => {
    const buffers = captureBuffers()
    const play = begin(NAME)
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 15_000, () => play.video.currentTime > 0.5)
    // A hole in both tracks a little ahead of the playhead (the browser takes the frames that need the removed ones with it).
    await buffers.cutAll(3, 3.2)
    const hole = (() => {
      const { buffered } = play.video
      return buffered.length >= 2 ? [buffered.end(0), buffered.start(1)] : null
    })()
    expect(hole).not.toBeNull()
    const [from, to] = hole as [number, number]
    expect(to - from).toBeLessThan(2)
    await until(play, 'the clock at the hole', 15_000, () => play.video.currentTime >= from - 0.3)
    const stoodFrom = performance.now()
    await until(play, 'the gap to be stepped over', 30_000, () =>
      ofType(play.events, 'watchdog').some((event) => event.action === 'gap'),
    )
    // The clock stood for the time the watchdog waits, so it was not the browser that stepped over.
    expect(performance.now() - stoodFrom).toBeGreaterThan(STUCK_MS * 0.5)
    const gap = ofType(play.events, 'watchdog').find((event) => event.action === 'gap')
    expect(gap?.at).toBeGreaterThan(from - 0.5)
    await until(play, 'the clock past the hole', 20_000, () => play.video.currentTime > to + 0.5)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('refeeds the window from the store when a hole is too big to step over', async () => {
    const reopen = vi.spyOn(MediaSourceSink.prototype, 'reopen')
    const buffers = captureBuffers()
    const play = begin(NAME)
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 15_000, () => play.video.currentTime > 0.5)
    await buffers.cutAll(3, 9)
    await until(play, 'the clock at the hole', 15_000, () => play.video.currentTime >= 2.5)
    await until(play, 'a refeed', 30_000, () =>
      ofType(play.events, 'watchdog').some((event) => event.action === 'refeed'),
    )
    const refeed = ofType(play.events, 'watchdog').find((event) => event.action === 'refeed')
    expect(refeed?.at).toBeGreaterThan(2)
    expect(refeed?.at).toBeLessThan(4)
    await until(play, 'the clock past the hole', 30_000, () => play.video.currentTime > 9.5)
    // The file had ended: the refeed opens Media Source again (as a seek does), and is no reopen of the watchdog's.
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(play.stats.at(-1)?.reopens).toBe(0)
    expect(ofType(play.events, 'watchdog').some((event) => event.action === 'gap')).toBe(false)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('does not refeed a play that waits for the network: a feed that waits for bytes is not a stuck play', async () => {
    await control({ bandwidthBytesPerSecond: 600_000 })
    const play = begin(NAME)
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 30_000, () => play.video.currentTime > 0.3)
    // The link all but stops: the clock reaches the end of what is buffered and waits there for bytes.
    await control({ bandwidthBytesPerSecond: 5_000 })
    await until(play, 'the clock to starve', 60_000, () => play.video.readyState < 3)
    await pause(STUCK_MS * 3)
    expect(ofType(play.events, 'watchdog').filter((event) => event.action !== 'quota')).toEqual([])
    await control({ bandwidthBytesPerSecond: 3_000_000 })
    const at = play.video.currentTime
    await until(play, 'the play to go on', 40_000, () => play.video.currentTime > at + 1)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('reopens the decoder when a refeed does not move a stopped clock, and plays on', async () => {
    const reopen = vi.spyOn(MediaSourceSink.prototype, 'reopen')
    // A small window keeps the feed from the end of the file: a refeed after the end opens Media Source again itself, which this test is not about.
    const play = begin(NAME, { windowBytes: 2 * 1024 * 1024 })
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 15_000, () => play.video.currentTime > 1)
    // A clock that does not move while the element plays and holds its data. A new Media Source gives the element its default rate again.
    play.video.playbackRate = 0
    await until(play, 'a reopen', 40_000, () =>
      ofType(play.events, 'watchdog').some((event) => event.action === 'reopen'),
    )
    const actions = ofType(play.events, 'watchdog').map((event) => event.action)
    expect(actions.indexOf('refeed')).toBeGreaterThanOrEqual(0)
    expect(actions.indexOf('refeed')).toBeLessThan(actions.indexOf('reopen'))
    const at = play.video.currentTime
    await until(play, 'the clock to move again', 30_000, () => play.video.currentTime > at + 1)
    expect(play.video.paused).toBe(false)
    expect(reopen).toHaveBeenCalledTimes(1)
    await until(play, 'the numbers', 5_000, () => play.stats.at(-1)?.reopens === 1)
    expect(ofType(play.events, 'error')).toEqual([])
  }, 90_000)

  test('a reopen does not play a play whose autoplay() now says no', async () => {
    let wanted = true
    const reopen = vi.spyOn(MediaSourceSink.prototype, 'reopen')
    const play = begin(NAME, { windowBytes: 2 * 1024 * 1024, autoplay: () => wanted })
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 15_000, () => play.video.currentTime > 1)
    // The viewer pauses: the element stays as it is, and the clock is then held still, so the watchdog reopens.
    wanted = false
    play.video.playbackRate = 0
    await until(play, 'a reopen', 40_000, () =>
      ofType(play.events, 'watchdog').some((event) => event.action === 'reopen'),
    )
    await until(play, 'the reopen to finish', 15_000, () => reopen.mock.settledResults.length > 0)
    await pause(2_000)
    expect(play.video.paused).toBe(true)
    expect(ofType(play.events, 'error')).toEqual([])
  }, 90_000)

  test('fails the play with the watchdog reason when nothing moves it, after the reopens it may make', async () => {
    const play = begin(NAME)
    await firstPicture(play)
    await play.video.play()
    await until(play, 'the clock', 15_000, () => play.video.currentTime > 1)
    // The element's clock and its frame count are made to stand still, whatever it does.
    const frozen = play.video.currentTime
    const clock = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    Object.defineProperty(play.video, 'currentTime', {
      configurable: true,
      get: () => frozen,
      set: (value: number) => {
        clock?.set?.call(play.video, value)
      },
    })
    play.video.getVideoPlaybackQuality = () =>
      ({
        totalVideoFrames: 7,
        droppedVideoFrames: 0,
        corruptedVideoFrames: 0,
      }) as VideoPlaybackQuality
    await until(play, 'the play to fail', 60_000, () =>
      ofType(play.events, 'phase').some((event) => event.phase === 'failed'),
    )
    const actions = ofType(play.events, 'watchdog').map((event) => event.action)
    expect(actions.filter((action) => action === 'reopen')).toHaveLength(3)
    expect(actions.at(-1)).toBe('stuck')
    const errors = ofType(play.events, 'error')
    expect(errors).toHaveLength(1)
    const stuck = ofType(play.events, 'watchdog').at(-1)
    expect(errors[0]?.message).toBe(stuck?.detail)
    expect(play.stats.at(-1)?.reopens).toBe(3)
  }, 120_000)
})

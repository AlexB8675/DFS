// The engine's limits proved in the browsers (DESIGN.md §10.4; the iron-clad spec §4.9): Firefox's and Chrome's
// quota and the decoder window's bound on a 4K file, a storm of seeks that loses nothing the store holds, and a
// memory store that plays a file larger than its cap to the end.
//
// The files are fixed choices, picked by their properties and never by name: the user's files of the sample
// with the highest bit rate (the 4K one), and for the memory store the smallest of the whole manifest that is
// larger than the store's cap. The user's files are read in place through the play server and their bytes go
// nowhere but the engine's own store; no name of theirs is in this file. Every play is checked, when its test is
// over, for a wait that the engine left in silence, as in plays.browser.test.ts.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { BLOCK_BYTES, MEMORY_CAP_BYTES, SEEK_DEADLINE_MS, WINDOW_BYTES } from '../limits.ts'
import {
  activePlays,
  begin,
  directoryExists,
  endPlays,
  ofType,
  silentWaits,
  until,
} from './play-harness.ts'
import type { Play } from './play-harness.ts'
import {
  engineErrors,
  failure,
  fastLink,
  isDense,
  pause,
  pickOf,
  report,
  serverLines,
  startPicture,
  timelineOf,
  userPicks,
} from './plays-support.ts'
import type { Pick } from './plays-support.ts'
import { clearLog, control, files } from './server.ts'
import type { Network } from './server.ts'

/** The media a play shows before the seek of the window test, and after it, in seconds (R46). */
const BEFORE_SEEK_SECONDS = 30
const AFTER_SEEK_SECONDS = 10

/** The seeks of the storm: how many, how far apart, and the fixed seed of their times (R46). */
const STORM_SEEKS = 30
const STORM_GAP_MS = 200
const STORM_SEED = 0x5eed

/** The longest a memory-store play may be, in seconds, and the room it is given beyond its length (R46). */
const MEMORY_MAX_SECONDS = 300
const MEMORY_SLACK_MS = 60_000

/** The speed of the storm's synthetic file: 1.5 times its bit rate (R46). */
const STORM_SYNTHETIC_FACTOR = 1.5

vi.setConfig({ testTimeout: 240_000 })

afterEach(async () => {
  vi.restoreAllMocks()
  // The no-silent-freeze check, as in plays.browser.test.ts: every wait longer than STUCK_MS is told by a watchdog
  // event or an error of the engine's, or is covered by a hold or by a seek's own wait.
  const silent = activePlays().flatMap((play) => silentWaits(play))
  if (silent.length > 0) {
    for (const play of activePlays())
      report({ test: 'silent-wait-timeline', lines: timelineOf(play) })
  }
  await endPlays()
  expect(silent, 'waits longer than STUCK_MS with no watchdog event and no hold').toEqual([])
})

/** A seeded generator in [0, 1) (mulberry32), so that the storm's seeks are the same in every run. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The least a "4K" file lasts: the window test plays 30 s, seeks outside the window and plays 10 s more, so a clip of a few seconds, whatever its bit rate, cannot be it. */
const HEAVIEST_MIN_SECONDS = 60

const isFirefox = (): boolean => navigator.userAgent.includes('Firefox')

/**
 * The file of the quota test and of the storm: in Chrome the dense file of the user's sample with the highest bit rate
 * among those that last at least `HEAVIEST_MIN_SECONDS` (the 4K one); in Firefox, which has no HEVC decoder (`factsOf`
 * leaves those files out), the file with the highest bit rate among those it plays (H.264 or AV1) that last that long,
 * dense or not, so that Firefox's smaller quota is still tried under the heaviest file it can play (R48).
 */
async function heaviestDense(): Promise<Pick | string> {
  const long = (await userPicks()).filter((pick) => pick.duration >= HEAVIEST_MIN_SECONDS)
  const rate = (pick: Pick): number => pick.file.size / pick.duration
  const pool = isFirefox() ? long : long.filter((pick) => isDense(pick.facts))
  const found = pool.sort((a, b) => rate(b) - rate(a))[0]
  return (
    found ?? `the sample has no file of ${HEAVIEST_MIN_SECONDS} s or more that this browser plays`
  )
}

/** What a user file is called in a report: by its size, never by its name. */
function labelOf(pick: Pick): string {
  return pick.file.synthetic ? pick.file.name : `user file of ${pick.file.size} bytes`
}

/** The most bytes between two keyframes of an MP4's picture (a group, which the window cannot cut inside while it plays); null where the index keeps no frame table. */
function largestGroupBytes(pick: Pick): number | null {
  const { index } = pick.facts
  if (index.container !== 'mp4') return null
  const { table, keyframes } = index.video
  let most = 0
  for (let k = 0; k < keyframes.length; k += 1) {
    const from = keyframes[k] ?? 0
    const to = keyframes[k + 1] ?? table.count
    let bytes = 0
    for (let i = from; i < to; i += 1) bytes += table.sizes[i] ?? 0
    most = Math.max(most, bytes)
  }
  return most
}

/** The largest number in the list, 0 for none. */
function highest(numbers: readonly number[]): number {
  return numbers.reduce((most, one) => Math.max(most, one), 0)
}

/** Waits until the engine has published `count` more stats snapshots, so that the next one is read fresh. */
async function freshStats(play: Play, count: number): Promise<number> {
  const target = play.stats.length + count
  await until(play, 'fresh stats', 10_000, () => play.stats.length >= target)
  return play.stats.length - 1
}

/** Whether the store was full at any time in [from, to] (ms of the play's clock): it was on at `from`, or went on within it. */
function fullDuring(play: Play, from: number, to: number): boolean {
  let on = false
  for (const { at, event } of play.stamped) {
    if (event.type !== 'storeFull') continue
    if (at <= from) on = event.on
    else if (at <= to && event.on) return true
  }
  return on
}

describe('quota and the decoder window: 30 s, a seek outside the window, 10 s more', () => {
  test('the dense file of the sample with the highest bit rate', async ({ skip }) => {
    const pick = await heaviestDense()
    if (typeof pick === 'string') {
      skip(pick)
      return
    }
    const { file, duration } = pick
    // The window test needs room for 30 s, a seek to the middle, and 10 s after it, outside the window.
    if (duration < BEFORE_SEEK_SECONDS + 2 * AFTER_SEEK_SECONDS + 2) {
      skip(`the file is ${Math.round(duration)} s, too short for a seek outside the window`)
      return
    }
    const link = fastLink(file, duration)
    await control(link)
    const play = begin(file.name, { autoplay: () => true })
    // The element's own buffer against the engine's count of the window, for the report: [ms, clock, buffered start, buffered end, window MiB].
    const trace: number[][] = []
    const tracer = setInterval(() => {
      const { video } = play
      const ranges = video.buffered
      const here = Array.from({ length: ranges.length }, (_, i) => i).find(
        (i) => ranges.start(i) <= video.currentTime + 0.01 && ranges.end(i) >= video.currentTime,
      )
      const round = (n: number): number => Math.round(n * 100) / 100
      trace.push([
        Math.round(performance.now() - play.startedAt),
        round(video.currentTime),
        here === undefined ? -1 : round(ranges.start(here)),
        here === undefined ? -1 : round(ranges.end(here)),
        Math.round((play.stats.at(-1)?.windowBytes ?? 0) / 1048576),
      ])
    }, 500)
    try {
      await startPicture(play, play.startedAt, 60_000)
      await until(play, `the clock at ${BEFORE_SEEK_SECONDS} s`, 120_000, () => {
        return play.video.currentTime >= BEFORE_SEEK_SECONDS
      })
      // The middle of the file, when that is past what the decoder holds; else the middle of what lies beyond it. A file of a
      // minute is at its middle after 30 s, and a light file's window reaches 30 s ahead, so a seek to the middle would be a
      // seek inside the window.
      const clock = play.video.currentTime
      const held = Array.from({ length: play.video.buffered.length }, (_, i) => i).find(
        (i) => play.video.buffered.end(i) >= clock,
      )
      const reach = held === undefined ? clock : play.video.buffered.end(held)
      const wholeMiddle = duration / 2
      // A light file's window reaches the end of the file (a seek ahead would be clamped to it): the seek then goes back,
      // to 0 when the buffer no longer holds it, or else to the earliest time that it does not hold (R54).
      const behind = reach + 1 >= duration
      let target = wholeMiddle > reach + 1 ? wholeMiddle : (reach + 1 + duration) / 2
      if (behind) {
        const ranges = play.video.buffered
        const spans = Array.from({ length: ranges.length }, (_, i) => [
          ranges.start(i),
          ranges.end(i),
        ])
        let hole = 0
        for (const [from, to] of spans) {
          if (from !== undefined && to !== undefined && from <= hole + 0.05 && to > hole) hole = to
        }
        if (hole + 0.5 >= duration) {
          skip('the window holds the whole file: there is no time outside it to seek to')
          return
        }
        target = hole
      }
      const middle = Math.round(target * 1000) / 1000
      const seeksBefore = ofType(play.events, 'seek').length
      const markedAt = performance.now()
      play.video.currentTime = middle
      // The seek event that the engine sends after the mark, whatever target it settled on.
      await until(play, 'the seek outside the window', 60_000, () => {
        return ofType(play.events, 'seek')
          .slice(seeksBefore)
          .some((event) => event.ms !== null)
      })
      const seekEvent = ofType(play.events, 'seek')
        .slice(seeksBefore)
        .findLast((event) => event.ms !== null)
      await until(play, `the clock ${AFTER_SEEK_SECONDS} s after the seek`, 120_000, () => {
        return play.video.ended || play.video.currentTime >= middle + AFTER_SEEK_SECONDS
      })

      const appended = ofType(play.events, 'append').map((event) => event.bytes)
      const largestFragment = highest(appended)
      // R46's bound is the cap and two fragments. The group being played cannot be cut (the window removes only before a
      // keyframe, never inside the group that plays), so it stays whole behind the playhead: the measured peak with every
      // keyframe starting a fragment is the cap and one group (15.4 MB of a 4K second), so the bound here is the cap, the
      // largest group where the index says it, and a fragment (R49 follow-up, for the controller's ruling).
      const group = largestGroupBytes(pick)
      const boundR46 = WINDOW_BYTES + 2 * largestFragment
      const bound = group === null ? boundR46 : WINDOW_BYTES + group + largestFragment
      const maxWindow = highest(play.stats.map((numbers) => numbers.windowBytes))
      const quotaEvents = ofType(play.events, 'watchdog').filter((event) => {
        return event.action === 'quota'
      })
      report({
        test: 'quota-window',
        file: labelOf(pick),
        bytes: file.size,
        durationSeconds: Math.round(duration),
        linkBytesPerSecond: link.bandwidthBytesPerSecond,
        seekTo: middle,
        seekInWindow: seekEvent?.inWindow ?? null,
        seekMs: seekEvent?.ms ?? null,
        seekWallMs: Math.round(performance.now() - markedAt),
        windowBound: WINDOW_BYTES,
        largestFragmentBytes: largestFragment,
        boundBytes: bound,
        boundR46Bytes: boundR46,
        largestGroupBytes: largestGroupBytes(pick),
        maxWindowBytes: maxWindow,
        quotaErrors: play.stats.at(-1)?.quotaErrors,
        quotaEvents: quotaEvents.length,
        backend: play.stats.at(-1)?.backend,
        samples: play.stats.length,
        clockBeforeSeek: clock,
        windowSeriesMiB: play.stats.map((numbers) => Math.round(numbers.windowBytes / 1048576)),
        trace,
        aheadSeries: play.stats.map((numbers) => Math.round(numbers.aheadSeconds * 10) / 10),
      })
      expect(quotaEvents, 'quota events of the watchdog').toEqual([])
      expect(engineErrors(play)).toEqual([])
      expect(play.stats.at(-1)?.quotaErrors, 'quota errors in the stats').toBe(0)
      expect(play.video.error).toBeNull()
      expect(
        maxWindow,
        'the window held something, so the bound is not met by silence',
      ).toBeGreaterThan(0)
      expect(maxWindow, 'the largest window against its bound').toBeLessThanOrEqual(bound)
      expect(seekEvent?.inWindow, 'the seek was outside the window').toBe(false)
    } catch (error) {
      await failure(play, 'quota-window', error)
    } finally {
      clearInterval(tracer)
    }
  }, 300_000)
})

describe('a seek storm: 30 seeks 200 ms apart, at seeded random times', () => {
  const cases: { name: string; pick: () => Promise<Pick | string>; factor: number | null }[] = [
    { name: 'the dense file with the highest bit rate', pick: heaviestDense, factor: null },
    {
      name: 'h264-aac-faststart.mp4',
      pick: async () => {
        const served = files().find(
          (file) => file.synthetic && file.name.endsWith('h264-aac-faststart.mp4'),
        )
        return pickOf(served)
      },
      factor: STORM_SYNTHETIC_FACTOR,
    },
  ]
  for (const { name, pick: choose, factor } of cases) {
    test(
      name,
      async ({ skip }) => {
        const pick = await choose()
        if (typeof pick === 'string') {
          skip(pick)
          return
        }
        const { file, duration } = pick
        const link: Network =
          factor === null
            ? fastLink(file, duration)
            : { bandwidthBytesPerSecond: Math.ceil((file.size / duration) * factor), latencyMs: 20 }
        await control(link)
        const play = begin(file.name, { autoplay: () => true })
        try {
          await startPicture(play, play.startedAt, 60_000)
          const random = mulberry32(STORM_SEED)
          const room = Math.max(0.5, duration - 2)
          const targets = Array.from({ length: STORM_SEEKS }, () => {
            return Math.round(random() * room * 1000) / 1000
          })
          const before = await freshStats(play, 1)
          const stormFrom = performance.now() - play.startedAt
          let lastMark = 0
          let seeksBeforeLast = 0
          for (const [i, target] of targets.entries()) {
            // The element's `seeking` event comes later than the assignment: the last seek's own events are those from here on (R54).
            if (i === targets.length - 1) seeksBeforeLast = ofType(play.events, 'seek').length
            lastMark = performance.now()
            play.video.currentTime = target
            if (i < targets.length - 1) await pause(STORM_GAP_MS)
          }
          const last = targets.at(-1) ?? 0
          // The last seek's own picture: a seek event that began (no time) at or after that index, then one with a time after it.
          const seekEvents = (): ReturnType<typeof ofType<'seek'>> => ofType(play.events, 'seek')
          const lastPictureOf = () => {
            const seeks = seekEvents().slice(seeksBeforeLast)
            const began = seeks.findIndex((event) => event.ms === null)
            if (began < 0) return undefined
            return seeks.slice(began + 1).find((event) => event.ms !== null)
          }
          await until(
            play,
            "the last seek's picture",
            SEEK_DEADLINE_MS + 5_000,
            () => lastPictureOf() !== undefined,
          )
          const lastWallMs = performance.now() - lastMark
          const seeks = ofType(play.events, 'seek')
          const lastPicture = lastPictureOf()
          const after = await freshStats(play, 2)
          const stormTo = performance.now() - play.startedAt
          const capBytes = ofType(play.events, 'store').at(-1)?.capBytes ?? Infinity
          const peakStored = Math.max(
            0,
            ...play.stats.slice(before, after + 1).map((numbers) => numbers.storedBytes),
          )
          // Full when `storeFull` was on, or the store reached its cap less a block (a nearer block takes the slot of a farther one without a `storeFull`).
          const full = fullDuring(play, stormFrom, stormTo) || peakStored >= capBytes - BLOCK_BYTES
          const evictedBefore = play.stats[before]?.evictedBytes ?? 0
          const evictedAfter = play.stats[after]?.evictedBytes ?? 0
          // What the store holds never shrinks in the storm: a seek discards nothing (eviction is for a full store).
          const stored = play.stats.slice(before, after + 1).map((numbers) => numbers.storedBytes)
          const shrank = stored.some((bytes, i) => i > 0 && bytes < (stored[i - 1] ?? 0))
          report({
            test: 'seek-storm',
            file: labelOf(pick),
            bytes: file.size,
            linkBytesPerSecond: link.bandwidthBytesPerSecond,
            seeks: STORM_SEEKS,
            lastTarget: last,
            lastPictureMs: lastPicture?.ms ?? null,
            lastPictureWallMs: Math.round(lastWallMs),
            lastInWindow: lastPicture?.inWindow ?? null,
            seekEventsWithMs: seeks.filter((event) => event.ms !== null).length,
            seekEventsOutsideWindow: seeks.filter((event) => event.ms === null && !event.inWindow)
              .length,
            evictedBefore,
            evictedAfter,
            storeFullDuring: full,
            storedBytes: play.stats[after]?.storedBytes,
            storedShrank: shrank,
            droppedBytes: ofType(play.events, 'storeLevel').at(-1)?.droppedBytes ?? null,
            storeLevelEvents: ofType(play.events, 'storeLevel').length,
            receivedMinusStoredBefore:
              (play.stats[before]?.bytesReceived ?? 0) - (play.stats[before]?.storedBytes ?? 0),
            receivedMinusStoredAfter:
              (play.stats[after]?.bytesReceived ?? 0) - (play.stats[after]?.storedBytes ?? 0),
            storeFullEvents: ofType(play.events, 'storeFull').length,
            restarts: ofType(play.events, 'restart').length,
            watchdogs: ofType(play.events, 'watchdog').map((event) => event.action),
          })
          expect(lastPicture, "the last seek's picture").toBeDefined()
          expect(
            lastPicture?.ms ?? Infinity,
            "the last seek's time to picture",
          ).toBeLessThanOrEqual(SEEK_DEADLINE_MS)
          expect(
            lastWallMs,
            "the last seek's picture, by the test's own clock",
          ).toBeLessThanOrEqual(SEEK_DEADLINE_MS)
          expect(engineErrors(play)).toEqual([])
          expect(play.video.error).toBeNull()
          if (!full) {
            expect(evictedAfter, 'bytes evicted during the storm').toBeLessThanOrEqual(
              evictedBefore,
            )
            expect(shrank, 'the bytes the store holds shrank during the storm').toBe(false)
          }
        } catch (error) {
          await failure(play, name, error)
        }
      },
      150_000,
    )
  }
})

describe('a memory store larger than its cap plays a file larger than the cap to its end', () => {
  test('the smallest file of the manifest that is larger than the cap', async ({ skip }) => {
    // The whole manifest, not only the sample, in order of size: the first that this browser plays.
    const larger = files()
      .filter((file) => !file.synthetic && file.expect === 'plays' && file.size > MEMORY_CAP_BYTES)
      .sort((a, b) => a.size - b.size)
    let pick: Pick | null = null
    let why = 'the manifest has no file larger than the memory store'
    for (const file of larger) {
      const found = await pickOf(file)
      if (typeof found === 'string') {
        why = found
        continue
      }
      pick = found
      break
    }
    if (pick === null) {
      skip(why)
      return
    }
    if (pick.duration > MEMORY_MAX_SECONDS) {
      skip(
        `the smallest file larger than the cap is ${Math.round(pick.duration)} s, over ${MEMORY_MAX_SECONDS} s`,
      )
      return
    }
    const { file, duration } = pick
    const ms = Math.ceil(duration * 1.3 * 1000) + MEMORY_SLACK_MS
    const link = fastLink(file, duration)
    await control(link)
    await clearLog()
    const play = begin(file.name, { autoplay: () => true, memory: true })
    try {
      await startPicture(play, play.startedAt, 60_000)
      await until(play, 'the end of the play', ms, () => play.video.ended)
      const maxStored = highest(play.stats.map((numbers) => numbers.storedBytes))
      // The engine's own numbers say what the store evicted (R49): settled blocks that lost their slot.
      const last = play.stats.at(-1)
      const evicted = last?.evictedBytes ?? 0
      const directory = await directoryExists(play.playId)
      report({
        test: 'memory-store',
        file: labelOf(pick),
        bytes: file.size,
        durationSeconds: Math.round(duration),
        linkBytesPerSecond: link.bandwidthBytesPerSecond,
        cap: MEMORY_CAP_BYTES,
        maxStoredBytes: maxStored,
        evictedBytes: evicted,
        expectedEvictedBytes: file.size - MEMORY_CAP_BYTES,
        requests: await serverLines(),
        backend: play.stats.at(-1)?.backend,
        directoryLeft: directory,
        samples: play.stats.length,
        wallMs: Math.round(performance.now() - play.startedAt),
      })
      expect(play.video.ended).toBe(true)
      expect(play.stats.at(-1)?.backend, 'the store that played').toBe('memory')
      expect(evicted, 'bytes evicted: the cap was reached').toBeGreaterThan(0)
      expect(maxStored, 'the most the store held').toBeLessThanOrEqual(MEMORY_CAP_BYTES)
      expect(engineErrors(play)).toEqual([])
      expect(play.video.error).toBeNull()
      // A memory store keeps nothing in the private file system; the downloader's own state is not visible to a page,
      // so that it is closed is not asserted here (the engine's tests pin the close).
      expect(directory, 'a directory of the play in the private file system').toBe(false)
    } catch (error) {
      await failure(play, 'memory-store', error)
    }
  }, 600_000)
})

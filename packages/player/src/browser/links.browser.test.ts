// The engine proved over links of different speeds (DESIGN.md §10.4; the iron-clad spec §4.9): a link faster than
// the video's bit rate, one slower than it, drops of the connection in the middle of a play, and a network switch.
// What each play must show: no stall after the picture moves (above), a start hold that says `slow` and then a
// play with no stall (below), a recovery with the same picture and no error of the engine's (drops, switch).
//
// The files are fixed choices, not the corpus's whole sample (`DFS_CORPUS_ALL` does not widen this file, as a full
// real-time play of every file over every link would take many hours): named synthetic files, and files of the
// user's sample picked by their properties (the largest dense one, the largest sparse MP4, the shortest). The
// user's files are read in place through the play server and their bytes go nowhere but the engine's own store;
// no name of theirs is in this file. A user file plays a stretch of STRETCH_SECONDS from its start, a synthetic
// one to its end. Every play of the file is checked, when its test is over, for a wait that the engine left in
// silence, as in plays.browser.test.ts.

import { filesToPlay } from '@dfs/mp4/testing'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { STUCK_MS } from '../limits.ts'
import { activePlays, begin, endPlays, ofType, served, silentWaits, until } from './play-harness.ts'
import type { Play } from './play-harness.ts'
import {
  factsOf,
  fastLink,
  isDense,
  pause,
  report,
  startPicture,
  timelineOf,
} from './plays-support.ts'
import type { Facts } from './plays-support.ts'
import { clearLog, control, files, log, playAll, switchNetwork } from './server.ts'
import type { Fault, Network, PlayFile } from './server.ts'

/** The media a user file plays, in seconds from its start (R43): a constant of this file, not of the engine. */
const STRETCH_SECONDS = 20

/** The longest a single test may take; a file that would take more is skipped with the reason (R43). */
const TEST_LIMIT_MS = 240_000

/** The wait after the picture moves that is a stall: longer than this is a failure of the above-the-bit-rate and below-the-bit-rate plays (R43). */
const WAIT_LIMIT_MS = 250

/** How much of the file's bit rate each link has (R43): above, and below it. */
const ABOVE = 1.5
const BELOW = 0.7

/** The latency of the above and below links: 20 ms to the first byte (as the fast link's). */
const LINK_LATENCY_MS = 20

/** How long after the picture moves the switch happens, how long it refuses, and how far the clock must then go. */
const SWITCH_AFTER_MS = 5_000
/** A synthetic file is down early on its link, so its switch comes sooner, while a read is still open (R45). */
const SYNTHETIC_SWITCH_AFTER_MS = 1_500
const SWITCH_REFUSES_MS = 3_000
const SWITCH_PLAYS_SECONDS = 5

vi.setConfig({ testTimeout: TEST_LIMIT_MS })

afterEach(async () => {
  vi.restoreAllMocks()
  // The no-silent-freeze check, as in plays.browser.test.ts: every wait longer than STUCK_MS is told by a watchdog
  // event or an error of the engine's, or is covered by a hold.
  const silent = activePlays().flatMap((play) => silentWaits(play))
  if (silent.length > 0) {
    for (const play of activePlays())
      report({ test: 'silent-wait-timeline', lines: timelineOf(play) })
  }
  await endPlays()
  expect(silent, 'waits longer than STUCK_MS with no watchdog event and no hold').toEqual([])
})

/** A file of the plays with what the suite knows of it. */
interface Pick {
  file: PlayFile
  facts: Facts
  duration: number
}

async function pickOf(file: PlayFile | undefined): Promise<Pick | string> {
  if (file === undefined) return 'the file is not served'
  const facts = await factsOf(file)
  if (facts.unplayable !== null) {
    return `this browser's Media Source takes none of its codecs: ${facts.unplayable}`
  }
  if (facts.durationSeconds === null || !(facts.durationSeconds > 0)) {
    return 'the file has no duration'
  }
  return { file, facts, duration: facts.durationSeconds }
}

let userSample: Promise<Pick[]> | null = null

/** The user's files of the sample (never all of them) that this browser plays, with their index read over HTTP ranges only. */
function userPicks(): Promise<Pick[]> {
  userSample ??= (async () => {
    const out: Pick[] = []
    for (const file of filesToPlay(files(), false).filter((candidate) => !candidate.synthetic)) {
      const pick = await pickOf(file)
      if (typeof pick !== 'string') out.push(pick)
    }
    return out
  })()
  return userSample
}

const bySize = (a: Pick, b: Pick): number => b.file.size - a.file.size

async function largestDense(): Promise<Pick | string> {
  const found = (await userPicks()).filter((pick) => isDense(pick.facts)).sort(bySize)[0]
  return found ?? 'the sample has no dense file this browser plays'
}

async function largestSparseMp4(): Promise<Pick | string> {
  const found = (await userPicks())
    .filter((pick) => pick.facts.index.container === 'mp4' && !isDense(pick.facts))
    .sort(bySize)[0]
  return found ?? 'the sample has no sparse MP4 this browser plays'
}

const SHORTEST_MAX_SECONDS = 90

async function shortest(): Promise<Pick | string> {
  const found = (await userPicks()).sort((a, b) => a.duration - b.duration)[0]
  if (found === undefined) return 'the sample has no file this browser plays'
  if (found.duration > SHORTEST_MAX_SECONDS) {
    return `the shortest file of the sample is longer than ${SHORTEST_MAX_SECONDS} s`
  }
  return found
}

const synthetic = (name: string) => async (): Promise<Pick | string> => pickOf(served(name))

/** The seconds of media a play shows before it counts as played through: all of a synthetic file, a stretch of a user's. */
function playedSeconds(pick: Pick): number {
  return pick.file.synthetic ? pick.duration : Math.min(STRETCH_SECONDS, pick.duration)
}

function bitrateOf(pick: Pick): number {
  return pick.file.size / pick.duration
}

/** One frame of the picture, in seconds: from an MP4's table, else a 30 fps frame. */
function frameSecondsOf(facts: Facts): number {
  const { index } = facts
  if (index.container === 'mp4') {
    const { table } = index.video
    const first = table.durations[0] ?? 0
    if (table.count > 0 && table.timescale > 0 && first > 0) return first / table.timescale
  }
  return 1 / 30
}

/** The requests of the server's log as a report line: no file id, the range, the status, the bytes sent and what became of it. */
async function serverLines(): Promise<string[]> {
  return (await log()).map(
    (entry) => `${entry.range ?? 'no range'} ${entry.status} ${entry.bytesSent} ${entry.outcome}`,
  )
}

/** Waits until the play has played through (see `playedSeconds`): a synthetic file ends, a user file's clock reaches the stretch. */
async function playThrough(play: Play, pick: Pick, ms: number): Promise<void> {
  if (pick.file.synthetic) {
    await until(play, 'the end', ms, () => play.video.ended)
    return
  }
  const target = playedSeconds(pick)
  await until(play, `the clock to reach ${target} s`, ms, () => play.video.currentTime >= target)
}

/** The longest the clock is seen to go back, in seconds, from a sampler that runs while the play does. */
function watchClock(play: Play): { backSeconds: () => number; stop: () => void } {
  let highest = 0
  let back = 0
  const timer = setInterval(() => {
    const at = play.video.currentTime
    highest = Math.max(highest, at)
    back = Math.max(back, highest - at)
  }, 20)
  return {
    backSeconds: () => back,
    stop: () => {
      clearInterval(timer)
    },
  }
}

/** The engine's own errors on a play's timeline. */
function engineErrors(play: Play): string[] {
  return ofType(play.events, 'error')
    .filter((event) => event.from === 'engine')
    .map((event) => event.message)
}

/** The waits that begin after the picture moved and last longer than `WAIT_LIMIT_MS`, and the stall holds after it. */
function stallsAfter(play: Play, movedAt: number): { longWaits: string[]; stallHolds: string[] } {
  const now = performance.now() - play.startedAt
  const longWaits = play.waits
    .filter((wait) => wait.from >= movedAt && (wait.to ?? now) - wait.from > WAIT_LIMIT_MS)
    .map((wait) => `${Math.round(wait.from)} to ${wait.to === null ? 'open' : Math.round(wait.to)}`)
  const stallHolds = play.stamped
    .filter(
      ({ at, event }) =>
        at >= movedAt && event.type === 'hold' && event.on && event.reason === 'stall',
    )
    .map(({ at }) => `stall hold on at ${Math.round(at)}`)
  return { longWaits, stallHolds }
}

/** What a failed play leaves in the report: its timeline, and the requests the server saw. */
async function failure(play: Play, name: string, error: unknown): Promise<never> {
  report({ test: 'timeline', name, lines: timelineOf(play) })
  try {
    report({ test: 'server-log', name, lines: await serverLines() })
  } catch {
    // The log is for the report only.
  }
  throw error instanceof Error ? error : new Error(String(error))
}

/** The expected length of a play, in ms, over a link at `factor` of the bit rate (the download takes as long as the clock needs at worst). */
function expectedMs(pick: Pick, factor: number): number {
  const seconds = playedSeconds(pick)
  return Math.ceil((seconds / Math.min(1, factor) + 10) * 1000)
}

interface Case {
  name: string
  pick: () => Promise<Pick | string>
}

const SYNTHETIC: Case[] = [
  'h264-aac-faststart.mp4',
  'h264-aac-end.mp4',
  'hevc10-hvc1-aac.mp4',
  'av1-opus.mp4',
  'h264-aac.mkv',
  'late-sound.mp4',
].map((name) => ({ name, pick: synthetic(name) }))

const DENSE: Case = { name: 'the largest dense file of the sample', pick: largestDense }
const SPARSE: Case = { name: 'the largest sparse MP4 of the sample', pick: largestSparseMp4 }

/** The link of a case: `factor` times the file's bit rate, with the latency of the fast link. */
function linkOf(pick: Pick, factor: number): Network {
  return {
    bandwidthBytesPerSecond: Math.ceil(bitrateOf(pick) * factor),
    latencyMs: LINK_LATENCY_MS,
  }
}

describe('above the bit rate: no stall after the picture moves', () => {
  for (const { name, pick: choose } of [...SYNTHETIC, DENSE, SPARSE]) {
    test(
      name,
      async ({ skip }) => {
        const pick = await choose()
        if (typeof pick === 'string') {
          skip(pick)
          return
        }
        const ms = expectedMs(pick, ABOVE)
        if (ms > TEST_LIMIT_MS) skip(`the play would take ${Math.round(ms / 1000)} s`)
        const link = linkOf(pick, ABOVE)
        await control(link)
        const play = begin(pick.file.name, { autoplay: () => true })
        const clock = watchClock(play)
        try {
          const { movingMs } = await startPicture(play, play.startedAt, ms)
          await playThrough(play, pick, ms)
          const { longWaits, stallHolds } = stallsAfter(play, movingMs)
          report({
            test: 'above',
            file: pick.file.synthetic ? pick.file.name : name,
            bytes: pick.file.size,
            bitrateBytesPerSecond: Math.round(bitrateOf(pick)),
            linkBytesPerSecond: link.bandwidthBytesPerSecond,
            startMs: Math.round(movingMs),
            holds: play.stats.at(-1)?.holds,
            longWaits,
            stallHolds,
          })
          expect(stallHolds, 'stall holds after the picture moved').toEqual([])
          expect(longWaits, `waits over ${WAIT_LIMIT_MS} ms after the picture moved`).toEqual([])
          expect(engineErrors(play)).toEqual([])
          expect(play.video.error).toBeNull()
        } catch (error) {
          await failure(play, name, error)
        } finally {
          clock.stop()
        }
      },
      TEST_LIMIT_MS,
    )
  }
})

describe('below the bit rate: a start hold that says slow, then a play with no stall', () => {
  const cases: Case[] = [
    {
      name: 'h264-aac-faststart.mp4',
      pick: synthetic('h264-aac-faststart.mp4'),
    },
    { name: 'h264-aac.mkv', pick: synthetic('h264-aac.mkv') },
    { name: 'the shortest file of the sample', pick: shortest },
  ]
  for (const { name, pick: choose } of cases) {
    test(
      name,
      async ({ skip }) => {
        const pick = await choose()
        if (typeof pick === 'string') {
          skip(pick)
          return
        }
        const ms = expectedMs(pick, BELOW) + 30_000
        if (ms > TEST_LIMIT_MS) skip(`the play would take ${Math.round(ms / 1000)} s`)
        const link = linkOf(pick, BELOW)
        await control(link)
        const play = begin(pick.file.name, { autoplay: () => true })
        try {
          const { movingMs } = await startPicture(play, play.startedAt, ms)
          await playThrough(play, pick, ms)
          const holdEvents = ofType(play.events, 'hold')
          const stamps = play.stamped.filter(({ event }) => event.type === 'hold')
          const { longWaits, stallHolds } = stallsAfter(play, movingMs)
          // The stats' numbers are what the timeline says: every hold that ended, and the time it was on.
          const last = play.stats.at(-1)
          let heldMs = 0
          let ended = 0
          let since: number | null = null
          for (const { at, event } of stamps) {
            if (event.type !== 'hold') continue
            if (event.on) since = at
            else if (since !== null) {
              heldMs += at - since
              ended += 1
              since = null
            }
          }
          report({
            test: 'below',
            file: pick.file.synthetic ? pick.file.name : name,
            bytes: pick.file.size,
            bitrateBytesPerSecond: Math.round(bitrateOf(pick)),
            linkBytesPerSecond: link.bandwidthBytesPerSecond,
            startMs: Math.round(movingMs),
            holds: last?.holds,
            holdMs: last?.holdMs,
            timelineHolds: ended,
            timelineHoldMs: Math.round(heldMs),
            firstHold: holdEvents[0],
            longWaits,
            stallHolds,
          })
          expect(holdEvents[0], 'the first hold').toMatchObject({ on: true, reason: 'start' })
          expect(
            play.stats.some((numbers) => numbers.holding && numbers.slow),
            'a stats snapshot that holds and says slow',
          ).toBe(true)
          expect(last?.holds, "the stats' holds").toBe(ended)
          expect(Math.abs((last?.holdMs ?? 0) - heldMs), "the stats' holdMs").toBeLessThan(
            5 * Math.max(1, ended),
          )
          expect(stallHolds, 'stall holds after the start hold let go').toEqual([])
          expect(longWaits, `waits over ${WAIT_LIMIT_MS} ms after the picture moved`).toEqual([])
          expect(engineErrors(play)).toEqual([])
        } catch (error) {
          await failure(play, name, error)
        }
      },
      TEST_LIMIT_MS,
    )
  }
})

/** Three drops, each after 64 KiB of the body: the engine's new reads after a switch are small, and a drop must bite each of them (R45). */
const DROPS: Fault[] = Array.from({ length: 3 }, () => ({ kind: 'drop', afterBytes: 65_536 }))

/** The files of the drops and the switch: a synthetic one, and the largest dense file of the sample. */
const DISRUPTED: Case[] = [
  { name: 'h264-aac-faststart.mp4', pick: synthetic('h264-aac-faststart.mp4') },
  DENSE,
]

/** The link of the drops and the switch: the fast link of the plays for a user's file; a synthetic file is small enough to be downloaded in under half a second on it, so it gets the above-the-bit-rate link, which keeps a read open for most of its play. */
function disruptedLink(pick: Pick): Network {
  return pick.file.synthetic ? linkOf(pick, ABOVE) : fastLink(pick.file, pick.duration)
}

describe('drops mid-play: the play recovers with the same picture', () => {
  for (const { name, pick: choose } of DISRUPTED) {
    test(
      name,
      async ({ skip }) => {
        const pick = await choose()
        if (typeof pick === 'string') {
          skip(pick)
          return
        }
        const ms = expectedMs(pick, 1) + 30_000
        if (ms > TEST_LIMIT_MS) skip(`the play would take ${Math.round(ms / 1000)} s`)
        const link = disruptedLink(pick)
        await control(link)
        const play = begin(pick.file.name, { autoplay: () => true })
        const clock = watchClock(play)
        try {
          await startPicture(play, play.startedAt, ms)
          // The next three requests after the picture moves are dropped.
          await clearLog()
          await control({ ...link, faults: DROPS })
          // The open read is one request to the end of the file, so nothing new would be asked for: a break of the
          // connection makes the engine ask again, and each of its asks meets the next drop.
          await switchNetwork(300)
          await playThrough(play, pick, ms)
          const entries = await log()
          const dropped = entries.filter((entry) => entry.outcome === 'dropped')
          report({
            test: 'drops',
            file: pick.file.synthetic ? pick.file.name : name,
            requestsAfter: entries.length,
            dropped: dropped.length,
            backSeconds: clock.backSeconds(),
          })
          expect(dropped, 'requests the server dropped').toHaveLength(3)
          expect(engineErrors(play)).toEqual([])
          expect(clock.backSeconds(), 'the clock going back').toBeLessThanOrEqual(
            frameSecondsOf(pick.facts),
          )
        } catch (error) {
          await failure(play, name, error)
        } finally {
          clock.stop()
        }
      },
      TEST_LIMIT_MS,
    )
  }
})

describe('a network switch mid-play: the play recovers', () => {
  for (const { name, pick: choose } of DISRUPTED) {
    test(
      name,
      async ({ skip }) => {
        const pick = await choose()
        if (typeof pick === 'string') {
          skip(pick)
          return
        }
        const switchAfterMs = pick.file.synthetic ? SYNTHETIC_SWITCH_AFTER_MS : SWITCH_AFTER_MS
        const ms = expectedMs(pick, 1) + (switchAfterMs + SWITCH_REFUSES_MS) / 1000 + 30_000
        if (ms > TEST_LIMIT_MS) skip(`the play would take ${Math.round(ms / 1000)} s`)
        const link = disruptedLink(pick)
        await control(link)
        const play = begin(pick.file.name, { autoplay: () => true })
        const clock = watchClock(play)
        try {
          await startPicture(play, play.startedAt, ms)
          await pause(switchAfterMs)
          const playhead = play.video.currentTime
          await clearLog()
          await switchNetwork(SWITCH_REFUSES_MS)
          const target = Math.min(playhead + SWITCH_PLAYS_SECONDS, pick.duration - 0.2)
          await until(play, `the clock to pass ${target.toFixed(1)} s`, ms, () => {
            return play.video.ended || play.video.currentTime >= target
          })
          const entries = await log()
          report({
            test: 'switch',
            file: pick.file.synthetic ? pick.file.name : name,
            cut: entries.filter((entry) =>
              ['dropped', 'aborted', 'refused'].includes(entry.outcome),
            ).length,
            playhead,
            refused: entries.filter((entry) => entry.outcome === 'refused').length,
            aborted: entries.filter((entry) => entry.outcome === 'aborted').length,
            backSeconds: clock.backSeconds(),
            stuckMs: STUCK_MS,
          })
          // The switch must have cut or refused something, or it proved nothing.
          expect(
            entries.some((entry) => ['dropped', 'aborted', 'refused'].includes(entry.outcome)),
            'a connection cut or refused at the switch',
          ).toBe(true)
          expect(engineErrors(play)).toEqual([])
          expect(clock.backSeconds(), 'the clock going back').toBeLessThanOrEqual(
            frameSecondsOf(pick.facts),
          )
        } catch (error) {
          await failure(play, name, error)
        } finally {
          clock.stop()
        }
      },
      TEST_LIMIT_MS,
    )
  }
})

// Which of the user's files the plays chose is told in the report, by their manifest name, and never in this file.
describe('the sample', () => {
  test('tells the report which user files the links used', async ({ skip }) => {
    const chosen = [
      ['largest dense', await largestDense()],
      ['largest sparse MP4', await largestSparseMp4()],
      ['shortest', await shortest()],
    ] as const
    report({
      test: 'links-sample',
      all: playAll(),
      chosen: chosen.map(([label, pick]) => [
        label,
        typeof pick === 'string' ? pick : { file: pick.file.name, seconds: pick.duration },
      ]),
    })
    if (chosen.every(([, pick]) => typeof pick === 'string')) skip('the corpus has no user files')
  })
})

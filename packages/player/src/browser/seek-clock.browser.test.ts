// A playing seek outside the decoder window on a slow link holds at the seek before anything plays (DESIGN.md §10.4;
// the final review's I1): the serve pauses the element when the feeder's seek has emptied the sink, so the clock stays
// at the target until the seek's hold lets go, and no write of the engine's puts it back. The element's `currentTime`
// setter is wrapped here to tell the engine's writes from the viewer's.
//
// The synthetic files cannot show it: the serve's feed asks for a second of media past the target (FEED_STEP_SECONDS),
// which one chunk of 1 MiB covers for any file below about 1 MiB/s, and then the clock has no time to play on. A dense
// file of the user's sample, with a high bit rate, needs many chunks for that second, so the first fragments are appended
// while the feed goes on, and an element that was not held would play (the burst). It is picked by its properties, read in
// place through the play server, and no name of it is in this file; a sample with no such file skips the test.
// The forward-only common start (a clock that played on is never put back) is unit-tested in src/engine/start-move.test.ts:
// with the pre-hold nothing plays on during a serve with an autoplay, and a synthetic file cannot make an element with no
// autoplay play on during one (the old backward move was tried on two synthetic files and the test did not fail).

import { afterEach, expect, test, vi } from 'vitest'
import { begin, endPlays, ofType, until } from './play-harness.ts'
import { isDense, userPicks } from './plays-support.ts'
import type { Facts, Pick } from './plays-support.ts'
import { control } from './server.ts'

/** One frame of the picture, in seconds: from an MP4's table, else a 30 fps frame (as in links.browser.test.ts). */
function frameSecondsOf(facts: Facts): number {
  const { index } = facts
  if (index.container === 'mp4') {
    const { table } = index.video
    const first = table.durations[0] ?? 0
    if (table.count > 0 && table.timescale > 0 && first > 0) return first / table.timescale
  }
  return 1 / 30
}

/** How far past the target the clock must play before the test judges it. */
const PLAYED_PAST_SECONDS = 1.5

/** How far from the clock the seek goes: outside what the decoder holds. */
const SEEK_AHEAD_SECONDS = 40

/** The link, as a fraction of the file's bit rate, and its latency. */
const LINK_FACTOR = 0.5
const LINK_LATENCY_MS = 20

vi.setConfig({ testTimeout: 180_000 })

afterEach(async () => {
  vi.restoreAllMocks()
  await endPlays()
})

interface Write {
  value: number
  before: number
  viewer: boolean
}

/** Records every write to the element's `currentTime`, and passes it on to the prototype's own accessor. */
function recordWrites(video: HTMLVideoElement, mine: { viewer: boolean }): Write[] {
  const writes: Write[] = []
  const own = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
  if (own?.get === undefined || own.set === undefined) throw new Error('no currentTime accessor')
  // eslint-disable-next-line @typescript-eslint/unbound-method -- both are called on the element, below.
  const { get, set } = own
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => get.call(video) as number,
    set: (value: number) => {
      writes.push({ value, before: get.call(video) as number, viewer: mine.viewer })
      set.call(video, value)
    },
  })
  return writes
}

/** The densest-keyframe file of the sample with the highest bit rate (and enough length for the seek). */
async function fastestDense(): Promise<Pick | undefined> {
  return (await userPicks())
    .filter((pick) => isDense(pick.facts) && pick.duration > SEEK_AHEAD_SECONDS + 20)
    .sort((a, b) => b.file.size / b.duration - a.file.size / a.duration)[0]
}

test('a playing seek outside the window on a slow link holds at the seek: no motion before its hold lets go, and no back step', async ({
  skip,
}) => {
  const pick = await fastestDense()
  if (pick === undefined) {
    skip('the sample has no long dense file')
    return
  }
  await control({
    bandwidthBytesPerSecond: Math.ceil((pick.file.size / pick.duration) * LINK_FACTOR),
    latencyMs: LINK_LATENCY_MS,
  })
  // The seek's hold lets go only once the serve has ended (its common start applied, then `Holding.begin('seek')`): while a serve runs the engine is busy and the hold's own check is not made. The first `hold` event with `on: false` after the seek is therefore strictly after the common start.
  const play = begin(pick.file.name, { autoplay: () => true })
  const mine = { viewer: false }
  const writes = recordWrites(play.video, mine)
  await until(play, 'the clock past 1 s', 120_000, () => play.video.currentTime > 1)
  const target = play.video.currentTime + SEEK_AHEAD_SECONDS
  const mark = writes.length
  const eventsBefore = play.events.length
  mine.viewer = true
  play.video.currentTime = target
  mine.viewer = false
  let highest = target
  let back = 0
  // I1: from the seek until the seek's hold lets go, nothing plays: the clock stays within a frame of the target.
  let burst = 0
  const timer = setInterval(() => {
    const at = play.video.currentTime
    const holdEvents = ofType(play.events.slice(eventsBefore), 'hold')
    if (!holdEvents.some((event) => !event.on)) burst = Math.max(burst, at - target)
    if (at < target - 1e-3) return
    highest = Math.max(highest, at)
    back = Math.max(back, highest - at)
  }, 10)
  try {
    await until(
      play,
      `the clock ${PLAYED_PAST_SECONDS} s past the target`,
      60_000,
      () => play.video.currentTime >= target + PLAYED_PAST_SECONDS,
    )
    // The serve's common start has run once the seek's hold has let go; fail without it.
    await until(play, "the seek's hold letting go", 60_000, () =>
      ofType(play.events.slice(eventsBefore), 'hold').some((event) => !event.on),
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    clearInterval(timer)
  }
  expect(ofType(play.events, 'seek')[0]).toMatchObject({ inWindow: false })
  const engine = writes.slice(mark).filter((write) => !write.viewer)
  const putBack = engine.filter((write) => write.value < write.before - 1e-3)
  expect(putBack, "the engine's writes that put the clock back").toEqual([])
  expect(back, 'the clock going back').toBeLessThanOrEqual(frameSecondsOf(pick.facts))
  // The seek's hold is the first the viewer sees after the seek, and nothing plays before it lets go.
  const afterSeek = ofType(play.events.slice(eventsBefore), 'hold')
  expect(afterSeek[0], "the seek's first hold").toMatchObject({ on: true, reason: 'seek' })
  expect(afterSeek.some((event) => !event.on)).toBe(true)
  expect(burst, 'the clock moving past the target before the hold let go').toBeLessThanOrEqual(
    frameSecondsOf(pick.facts),
  )
})

// A seek outside the decoder window on a slow link must not pull the playing clock back (DESIGN.md §10.4): the
// element starts playing on its own once the first fragments from the target are appended, while the serve still
// feeds, so by the time the common start is applied the clock has moved on from the target. The engine must
// leave it there and not move it back to the target. The element's `currentTime` setter is wrapped here to tell
// the engine's writes from the viewer's.
//
// The synthetic files cannot show it: the serve's feed asks for a second of media past the target (FEED_STEP_SECONDS),
// which one chunk of 1 MiB covers for any file below about 1 MiB/s, and then the clock has no time to play on before
// the common start. A dense file of the user's sample, with a high bit rate, needs many chunks for that second, so the
// first fragments are appended and the element plays while the feed goes on. It is picked by its properties, read in
// place through the play server, and no name of it is in this file; a sample with no such file skips the test.
// The rule itself, in every case, is unit-tested in src/engine/start-move.test.ts; this test shows it in a real element.

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

test('a playing seek outside the window on a slow link never puts the clock back once it has played on from the target', async ({
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
  // The engine asks `autoplay()` for the seek's hold (`Holding.begin('seek')`) strictly after `#applyCommonStart`, and not before in a serve: while one runs the engine is busy and the hold's check is not made.
  let autoplayCalls = 0
  const play = begin(pick.file.name, {
    autoplay: () => {
      autoplayCalls += 1
      return true
    },
  })
  const mine = { viewer: false }
  const writes = recordWrites(play.video, mine)
  await until(play, 'the clock past 1 s', 120_000, () => play.video.currentTime > 1)
  const target = play.video.currentTime + SEEK_AHEAD_SECONDS
  const mark = writes.length
  const seeksBefore = ofType(play.events, 'seek').length
  // The calls of `autoplay()` once the engine has taken the seek up (its `seek` event): the first one after is the end of the serve.
  let callsAtSeek: number | null = null
  mine.viewer = true
  play.video.currentTime = target
  mine.viewer = false
  let highest = target
  let back = 0
  const timer = setInterval(() => {
    if (callsAtSeek === null && ofType(play.events, 'seek').length > seeksBefore) {
      callsAtSeek = autoplayCalls
    }
    const at = play.video.currentTime
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
    // The serve's common start has run once the seek's hold has begun (`autoplay()` asked after the engine took the seek up); fail without it.
    await until(
      play,
      "the serve's end (the seek's hold)",
      60_000,
      () => callsAtSeek !== null && autoplayCalls > callsAtSeek,
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
})

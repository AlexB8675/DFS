// What the engine asks of the server, in what order (DESIGN.md §10.4; R41 items 6 and 7): the index comes first,
// and a seek outside the window opens one read, at the group's offset.

import { mp4Next, mp4Seek } from '@dfs/mp4'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { begin, endPlays, ofType, served, suite, until } from './play-harness.ts'
import { factsOf } from './plays-support.ts'
import { control, files } from './server.ts'

vi.setConfig({ testTimeout: 90_000 })

afterEach(async () => {
  await endPlays()
})

const SEEKED = 'h264-aac-faststart.mp4'

suite(SEEKED)('a seek outside the window', () => {
  test('opens one onward read, at the group of the target, with no restart before it', async () => {
    const file = served(SEEKED)
    if (file === undefined) return
    const facts = await factsOf(file)
    if (facts.index.container !== 'mp4') throw new Error('this test wants an MP4')
    const target = 8
    const cursor = mp4Seek(facts.index, target, facts.index.sound?.header.id ?? null)
    const expected = mp4Next(facts.index, cursor)
    expect(expected).not.toBeNull()

    await control({ bandwidthBytesPerSecond: 300_000 })
    const play = begin(SEEKED, { windowBytes: 2 * 1024 * 1024 })
    await until(play, 'the first picture', 40_000, () => play.video.readyState >= 2)
    play.video.currentTime = target
    await until(play, 'the seek to show its picture', 60_000, () => {
      return ofType(play.events, 'seek').some((event) => event.ms !== null)
    })
    const at = play.events.findIndex((event) => event.type === 'seek' && event.ms === null)
    const after = play.events.slice(at)
    const restarts = ofType(after, 'restart')
    expect(restarts).toHaveLength(1)
    expect(restarts[0]?.offset).toBe(expected)
    const firstRequest = ofType(after, 'request')[0]
    expect(firstRequest?.from).toBe(expected)
  })
})

// The user's own file that showed the two restarts (a 4K clip whose audio and picture lie far apart), when it is in the corpus.
const FAR = 'a-user-file.mp4'
const far = files().find((file) => file.name === FAR)

describe.skipIf(far === undefined)(
  'a seek outside the window, in a file whose tracks lie far apart',
  () => {
    test('opens one onward read, at the least offset of the group, with no restart at another before it', async () => {
      if (far === undefined) return
      const facts = await factsOf(far)
      if (facts.index.container !== 'mp4') throw new Error('this test wants an MP4')
      const target = 4.673
      const cursor = mp4Seek(facts.index, target, facts.index.sound?.header.id ?? null)
      const expected = mp4Next(facts.index, cursor)

      await control({ bandwidthBytesPerSecond: 30_000_000, latencyMs: 20 })
      const play = begin(FAR, { autoplay: () => true })
      await until(play, 'the first picture', 40_000, () => play.video.readyState >= 2)
      await until(play, 'the clock to move', 20_000, () => play.video.currentTime > 0.3)
      play.video.currentTime = target
      await until(play, 'the seek to show its picture', 60_000, () => {
        return ofType(play.events, 'seek').some((event) => event.ms !== null)
      })
      const at = play.events.findIndex((event) => event.type === 'seek' && event.ms === null)
      const restarts = ofType(play.events.slice(at), 'restart')
      // At most one restart, and if the store held the group's place there is none; never one at another offset first.
      for (const restart of restarts) expect(restart.offset).toBe(expected)
      expect(restarts.length).toBeLessThanOrEqual(1)
    })
  },
)

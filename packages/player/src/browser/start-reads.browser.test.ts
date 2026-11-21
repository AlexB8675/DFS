// What the engine asks of the server, in what order (DESIGN.md §10.4; R41 items 6 and 7): the index comes first,
// and a seek outside the window opens one read, at the group's offset.

import { mp4Nexts, mp4Seek } from '@dfs/mp4'
import { afterEach, expect, test, vi } from 'vitest'
import { BLOCK_BYTES, TAIL_BYTES } from '../limits.ts'
import { begin, endPlays, ofType, served, suite, until } from './play-harness.ts'
import { factsOf } from './plays-support.ts'
import { control } from './server.ts'

vi.setConfig({ testTimeout: 90_000 })

afterEach(async () => {
  await endPlays()
})

const HEAD = 1024 * 1024

const END = 'h264-aac-end.mp4'

suite(END)('the index comes first', () => {
  test('before the feeder has opened, no read is made but the head, the tail and the index', async () => {
    const file = served(END)
    if (file === undefined) return
    const play = begin(END)
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    const opened = play.events.findIndex(
      (event) => event.type === 'phase' && event.phase === 'buffering',
    )
    expect(opened).toBeGreaterThan(0)
    const before = ofType(play.events.slice(0, opened), 'request')
    expect(before.length).toBeGreaterThan(0)
    for (const request of before) {
      const isHead = request.from === 0 && request.to === HEAD - 1
      const isTail = request.from >= file.size - 2 * TAIL_BYTES
      expect(
        isHead || isTail,
        `the request from ${request.from} to ${request.to} before the feeder opened`,
      ).toBe(true)
    }
    // The onward reading begins after: it goes on from the head's end.
    await until(play, 'the onward read', 10_000, () => {
      return ofType(play.events, 'request').some((request) => request.from === HEAD)
    })
  })
})

const SEEKED = 'h264-aac-faststart.mp4'

suite(SEEKED)('a seek outside the window', () => {
  test('opens one onward read, at the picture place (or the sound just before it), with no restart before it', async () => {
    const file = served(SEEKED)
    if (file === undefined) return
    const facts = await factsOf(file)
    if (facts.index.container !== 'mp4') throw new Error('this test wants an MP4')
    const target = 8
    const cursor = mp4Seek(facts.index, target, facts.index.sound?.header.id ?? null)
    // The position is the picture's keyframe, or the sound's next read when that lies within a block before it (R44).
    const { video, audio } = mp4Nexts(facts.index, cursor)
    const expected =
      video !== null && audio !== null && audio < video && video - audio <= BLOCK_BYTES
        ? audio
        : video
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

// The seeks' tell (DESIGN.md §10.4), on a fake element: when a seek has shown its picture, and what moves its target.

import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, describe, expect, test } from 'vitest'
import { Seeks } from '../page/seeks.ts'

interface Fake {
  seeking: boolean
  readyState: number
  currentTime: number
  paused: boolean
  frames: number
  getVideoPlaybackQuality: () => { totalVideoFrames: number }
}

function fake(partial: Partial<Fake> = {}): Fake {
  const video: Fake = {
    seeking: false,
    readyState: 4,
    currentTime: 5,
    paused: false,
    frames: 100,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: video.frames }),
    ...partial,
  }
  return video
}

function make(video: Fake): { seeks: Seeks; events: TimelineEventInput[]; at: { now: number } } {
  const events: TimelineEventInput[] = []
  const at = { now: 1000 }
  const seeks = new Seeks(
    video as unknown as HTMLVideoElement,
    (event) => events.push(event),
    () => at.now,
  )
  return { seeks, events, at }
}

afterEach(() => {
  // The page's own `hidden` is a getter on the prototype: the fake sits on the document itself.
  Reflect.deleteProperty(document, 'hidden')
})

describe('Seeks', () => {
  test('a playing element shows its picture once a frame has come since the seek', () => {
    const video = fake()
    const { seeks, events, at } = make(video)
    seeks.begin(5, true)
    seeks.check()
    expect(events).toHaveLength(1)
    video.frames = 101
    at.now = 1250
    seeks.check()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'seek', to: 5, inWindow: true, ms: 250 })
  })

  test("a count of frames under the seek's is a new element (a reopen): it is the new baseline, and the next frame is the picture", () => {
    const video = fake()
    const { seeks, events } = make(video)
    seeks.begin(5, false)
    // A new Media Source restarts the count, below what it was.
    video.frames = 3
    seeks.check()
    expect(events).toHaveLength(1)
    video.frames = 4
    seeks.check()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'seek', ms: expect.any(Number) as unknown })
  })

  test('a hidden page shows no new frames, so the frame gate is skipped', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    const video = fake()
    const { seeks, events } = make(video)
    seeks.begin(5, true)
    seeks.check()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'seek', ms: expect.any(Number) as unknown })
  })

  test('retarget moves the target of a seek whose start was put earlier (near the end), so it completes', () => {
    const video = fake({ currentTime: 11.5, paused: true })
    const { seeks, events } = make(video)
    seeks.begin(20, false)
    seeks.check()
    // The clock is before the target (the file ends at 11.5): no picture yet.
    expect(events).toHaveLength(1)
    seeks.retarget(11.5)
    seeks.check()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'seek', to: 11.5 })
  })
})

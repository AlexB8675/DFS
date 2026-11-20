import { describe, expect, it } from 'vitest'
import {
  QUOTA_SHRINK,
  WINDOW_AHEAD_SECONDS,
  WINDOW_BEHIND_SECONDS,
  WINDOW_BYTES,
  WINDOW_FLOOR_BYTES,
  WINDOW_MIN_AHEAD_SECONDS,
  FEED_STEP_SECONDS,
  GAP_STEP_SECONDS,
} from '../limits.ts'
import { DecoderWindow } from './window.ts'
import type { FedRun } from './window.ts'

// The decoder window's bookkeeping (DESIGN.md §10.4): when to feed, and what to
// cut. A 4K file of 120 Mbit/s is about 15 MB/s, with a keyframe a second.

const MIB = 1024 * 1024
const FOUR_K_BYTES_PER_SECOND = 15_000_000

function run(
  kind: 'video' | 'audio',
  start: number,
  end: number,
  bytes: number,
  keyframe = true,
): FedRun {
  return { kind, start, end, bytes, keyframe }
}

/** Feeds the picture a second at a time, as the engine does, until `wants` says stop; answers the seconds fed. */
function feedVideo(window: DecoderWindow, playhead: number, bytesPerSecond: number): number {
  let fed = 0
  for (let guard = 0; guard < 1000; guard++) {
    const want = window.wants('video', playhead)
    if (want === null) break
    window.fed(run('video', playhead + fed, playhead + fed + 1, bytesPerSecond))
    fed++
  }
  return fed
}

describe('the decoder window', () => {
  it('keeps the constants of the window', () => {
    expect(WINDOW_MIN_AHEAD_SECONDS).toBe(1)
  })

  it('stops feeding 4K-like runs at the byte limit, before 30 s', () => {
    const window = new DecoderWindow()
    const seconds = feedVideo(window, 0, FOUR_K_BYTES_PER_SECOND)
    expect(seconds).toBe(5)
    expect(window.bytes()).toBeGreaterThanOrEqual(WINDOW_BYTES)
    expect(window.aheadSeconds('video', 0)).toBeLessThan(WINDOW_AHEAD_SECONDS)
    expect(window.wants('video', 0)).toBeNull()
  })

  it('stops feeding small runs at 30 s', () => {
    const window = new DecoderWindow()
    expect(feedVideo(window, 0, 100_000)).toBe(WINDOW_AHEAD_SECONDS)
    expect(window.aheadSeconds('video', 0)).toBe(WINDOW_AHEAD_SECONDS)
    expect(window.wants('video', 0)).toBeNull()
  })

  it('wants the track fed a step past what it holds, with nothing held a step past the playhead', () => {
    const window = new DecoderWindow()
    expect(window.wants('video', 12)).toEqual({ until: 12 + FEED_STEP_SECONDS })
    window.fed(run('video', 12, 15, 1000))
    expect(window.wants('video', 12)).toEqual({ until: 16 })
  })

  it('wants more again when the playhead moves on', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 30, 1000))
    expect(window.wants('video', 0)).toBeNull()
    expect(window.wants('video', 2)).toEqual({ until: 31 })
  })

  it('shares the byte limit between the tracks', () => {
    const window = new DecoderWindow(10 * MIB)
    window.fed(run('video', 0, 5, 6 * MIB))
    expect(window.wants('audio', 0)).toEqual({ until: 1 })
    window.fed(run('audio', 0, 5, 5 * MIB))
    expect(window.bytes()).toBe(11 * MIB)
    // At the limit, both have 5 s ahead, over the minimum, so neither is fed.
    expect(window.wants('video', 0)).toBeNull()
    expect(window.wants('audio', 0)).toBeNull()
  })

  it('still feeds a track with under a second ahead when the window is full', () => {
    const window = new DecoderWindow(10 * MIB)
    window.fed(run('video', 0, 0.5, 11 * MIB))
    expect(window.bytes()).toBeGreaterThanOrEqual(10 * MIB)
    expect(window.aheadSeconds('video', 0)).toBeLessThan(WINDOW_MIN_AHEAD_SECONDS)
    expect(window.wants('video', 0)).toEqual({ until: 1.5 })
    expect(window.wants('audio', 0)).toEqual({ until: 1 })
    window.fed(run('video', 0.5, 1.5, 1))
    expect(window.wants('video', 0)).toBeNull()
  })

  it('follows the fed runs from the playhead without a gap, and a gap stops it', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 2, 1))
    window.fed(run('video', 2, 4, 1))
    window.fed(run('video', 7, 9, 1))
    expect(window.aheadSeconds('video', 0)).toBe(4)
    expect(window.aheadSeconds('video', 1)).toBe(3)
    expect(window.aheadSeconds('video', 4.5)).toBe(0)
    expect(window.aheadSeconds('video', 6.5)).toBeCloseTo(2.5)
    expect(window.aheadSeconds('video', 9)).toBe(0)
    expect(window.aheadSeconds('audio', 0)).toBe(0)
  })

  it('joins runs fed out of order', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 2, 4, 1))
    window.fed(run('video', 0, 2, 1))
    expect(window.aheadSeconds('video', 0)).toBe(4)
  })

  it('has nothing to remove when nothing fed is older than 5 s behind the playhead', () => {
    const window = new DecoderWindow()
    for (let s = 0; s < 10; s++) window.fed(run('video', s, s + 1, 1000))
    expect(window.toRemove('video', 5)).toBeNull()
    expect(window.toRemove('video', 4.9)).toBeNull()
  })

  it('removes under the limit only behind the playhead by 5 s, at a keyframe time', () => {
    const window = new DecoderWindow()
    // Keyframes at 0, 2, 4, 6, 8; each of 2 s.
    for (let s = 0; s < 10; s += 2) window.fed(run('video', s, s + 2, 1000))
    // Playhead 9.5: 5 s behind is 4.5, so the latest keyframe at or before it is 4.
    expect(window.toRemove('video', 9.5)).toBe(4)
    // The playhead 6.9 gives 1.9: the latest keyframe is the first run's, with nothing before it.
    expect(window.toRemove('video', 6.9)).toBeNull()
    // Exactly on a keyframe.
    expect(window.toRemove('video', 11)).toBe(6)
    expect(WINDOW_BEHIND_SECONDS).toBe(5)
  })

  it('never cuts into the group being played, and a run that is not a keyframe is no place to cut', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 2, 1000, true))
    window.fed(run('video', 2, 4, 1000, false))
    window.fed(run('video', 4, 6, 1000, false))
    window.fed(run('video', 6, 8, 1000, true))
    // 5 s behind 11 is 6: the keyframe at 6.
    expect(window.toRemove('video', 11)).toBe(6)
    // 5 s behind 9 is 4: the latest keyframe is 0, with nothing before it.
    expect(window.toRemove('video', 9)).toBeNull()
  })

  it('removes the sound at any of its runs, as each is a keyframe', () => {
    const window = new DecoderWindow()
    for (let s = 0; s < 10; s++) window.fed(run('audio', s, s + 1, 1000))
    expect(window.toRemove('audio', 8.5)).toBe(3)
  })

  it('gives way to the time ahead when the window is full (the deadlock case)', () => {
    const window = new DecoderWindow()
    // Six seconds of 4K, a keyframe a second: 90 MB, over the 64 MiB limit.
    for (let s = 0; s < 6; s++) window.fed(run('video', s, s + 1, FOUR_K_BYTES_PER_SECOND))
    const playhead = 4.4
    expect(window.bytes()).toBeGreaterThanOrEqual(WINDOW_BYTES)
    expect(window.aheadSeconds('video', playhead)).toBeGreaterThanOrEqual(WINDOW_MIN_AHEAD_SECONDS)
    // Full, with a second ahead: not fed.
    expect(window.wants('video', playhead)).toBeNull()
    // Less than 5 s is behind, yet the keyframe at or before the playhead goes.
    expect(window.toRemove('video', playhead)).toBe(4)
    window.removed('video', 4)
    expect(window.bytes()).toBe(2 * FOUR_K_BYTES_PER_SECOND)
    expect(window.wants('video', playhead)).toEqual({ until: 7 })
  })

  it('has nothing to remove at the limit when only the group being played is behind', () => {
    const window = new DecoderWindow(1000)
    window.fed(run('video', 0, 1, 600, true))
    window.fed(run('video', 1, 2, 600, false))
    expect(window.bytes()).toBeGreaterThanOrEqual(1000)
    expect(window.toRemove('video', 1.5)).toBeNull()
  })

  it('does not remove ahead of a keyframe after the playhead', () => {
    const window = new DecoderWindow(1000)
    window.fed(run('video', 0, 1, 600, true))
    window.fed(run('video', 1, 2, 600, true))
    window.fed(run('video', 2, 3, 600, true))
    expect(window.toRemove('video', 1.5)).toBe(1)
  })

  it('drops the runs that start before the time, and trims one that straddles it', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 2, 100))
    window.fed(run('video', 2, 4, 200))
    window.fed(run('video', 4, 6, 400))
    window.fed(run('audio', 0, 8, 80))
    window.removed('video', 4)
    expect(window.bytes()).toBe(400 + 80)
    window.removed('audio', 4)
    // The sound run is cut in half, and its bytes with it.
    expect(window.bytes()).toBe(400 + 40)
    expect(window.aheadSeconds('audio', 4)).toBe(4)
    expect(window.aheadSeconds('audio', 1.5)).toBe(0)
  })

  it('drops an earlier run whose end is a rounding past the next keyframe, so the cut frees', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 1 + 1e-9, 100))
    window.fed(run('video', 1, 2, 100))
    window.fed(run('video', 2, 3, 100))
    expect(window.toRemove('video', 7.5)).toBe(2)
    window.removed('video', 2)
    expect(window.bytes()).toBe(100)
    expect(window.toRemove('video', 7.5)).toBeNull()
  })

  it('cuts at the end of a fully played last group', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 1, 100))
    window.fed(run('video', 1, 2, 100, false))
    expect(window.toRemove('video', 7)).toBe(2)
    window.removed('video', 2)
    expect(window.bytes()).toBe(0)
    // Followed by a gap.
    window.fed(run('video', 10, 12, 100))
    window.fed(run('video', 14, 16, 100))
    expect(window.toRemove('video', 22)).toBe(16)
  })

  it('counts a track that starts late, and keeps the cap before its first frame', () => {
    const window = new DecoderWindow(10 * MIB)
    expect(window.aheadSeconds('video', 0)).toBe(0)
    window.fed(run('video', 0.033, 1.033, 6 * MIB))
    expect(window.aheadSeconds('video', 0)).toBeCloseTo(1.033)
    window.fed(run('video', 1.033, 2.033, 6 * MIB))
    expect(window.bytes()).toBeGreaterThanOrEqual(10 * MIB)
    expect(window.wants('video', 0)).toBeNull()
    // Starting past a gap step there is no coverage.
    expect(GAP_STEP_SECONDS).toBe(2)
    expect(window.aheadSeconds('video', -3)).toBe(0)
  })

  it('does not count a refeed twice', () => {
    const window = new DecoderWindow()
    const runs = [run('video', 0, 2, 100), run('video', 2, 4, 200), run('audio', 0, 4, 50)]
    for (const r of runs) window.fed(r)
    expect(window.bytes()).toBe(350)
    for (const r of runs) window.fed(r)
    expect(window.bytes()).toBe(350)
    // A run over part of two others trims them.
    window.fed(run('video', 1, 3, 100))
    expect(window.bytes()).toBe(50 + 50 + 100 + 100)
    expect(window.aheadSeconds('video', 0)).toBe(4)
  })

  it('drops what the browser no longer holds, and keeps what a rounding at an edge leaves', () => {
    const window = new DecoderWindow()
    for (let s = 0; s < 6; s++) window.fed(run('video', s, s + 1, 100))
    window.sync('video', [
      [0, 2],
      [4, 6],
    ])
    expect(window.bytes()).toBe(400)
    expect(window.aheadSeconds('video', 0)).toBe(2)
    expect(window.aheadSeconds('video', 4)).toBe(2)
    window.sync('video', [
      [0.0000005, 1.9999995],
      [4, 6],
    ])
    expect(window.bytes()).toBe(400)
    // A range that cuts a run in half keeps half of its bytes.
    window.sync('video', [[0, 0.5]])
    expect(window.bytes()).toBe(50)
    window.sync('video', [])
    expect(window.bytes()).toBe(0)
  })

  it('shrinks by a quarter per quota error to 48 MiB, 36 MiB, and never below 16 MiB', () => {
    const window = new DecoderWindow()
    expect(window.quota()).toBe(48 * MIB)
    expect(window.quota()).toBe(36 * MIB)
    expect(window.quota()).toBe(27 * MIB)
    let last = 0
    for (let i = 0; i < 10; i++) last = window.quota()
    expect(last).toBe(WINDOW_FLOOR_BYTES)
    expect(window.quota()).toBe(WINDOW_FLOOR_BYTES)
    expect(QUOTA_SHRINK).toBe(0.75)
  })

  it('shrinks from a full window by a quarter, and from what is held when that is less', () => {
    const full = new DecoderWindow()
    full.fed(run('video', 0, 5, WINDOW_BYTES))
    expect(full.quota()).toBe(48 * MIB)
    expect(full.quota()).toBe(36 * MIB)
    const part = new DecoderWindow()
    part.fed(run('video', 0, 5, 22 * MIB))
    expect(part.quota()).toBe(16.5 * MIB)
    expect(part.quota()).toBe(WINDOW_FLOOR_BYTES)
  })

  it('applies the shrunk limit to what it wants', () => {
    const window = new DecoderWindow()
    window.fed(run('video', 0, 0.5, 40 * MIB))
    expect(window.wants('video', 0)).toEqual({ until: 1.5 })
    window.fed(run('video', 0.5, 5, 1))
    // 40 MiB is under 64 MiB, so the picture is fed on a step.
    expect(window.wants('video', 0)).toEqual({ until: 6 })
    window.quota()
    window.quota()
    expect(window.wants('video', 0)).toBeNull()
  })

  it('empties on reset and keeps the limit as the quota errors shrank it', () => {
    const window = new DecoderWindow()
    window.quota()
    window.fed(run('video', 0, 5, 1000))
    window.fed(run('audio', 0, 5, 1000))
    window.reset()
    expect(window.bytes()).toBe(0)
    expect(window.aheadSeconds('video', 0)).toBe(0)
    expect(window.quota()).toBe(36 * MIB)
  })
})

import { describe, expect, it } from 'vitest'
import { fragmentRuns } from './index.ts'
import type { FrameTable } from './index.ts'

// How a stretch of frames is cut into fragments (DESIGN.md §10.4, D45), taken from
// the package's entry point as the player takes it.

/** A table of frames that last the given ticks each, in a track of the given timescale; the keyframes are the indexes listed. */
function table(
  durations: readonly number[],
  keyframes: readonly number[],
  timescale = 1000,
): FrameTable {
  const count = durations.length
  const dts = new Float64Array(count)
  for (let i = 1; i < count; i += 1) dts[i] = (dts[i - 1] ?? 0) + (durations[i - 1] ?? 0)
  const sync = new Uint8Array(count)
  for (const at of keyframes) sync[at] = 1
  return {
    count,
    timescale,
    offsets: new Float64Array(count),
    sizes: new Uint32Array(count),
    dts,
    durations: Uint32Array.from(durations),
    cts: new Int32Array(count),
    sync,
  }
}

/** `count` frames of `ticks` each. */
const frames = (count: number, ticks = 100): number[] => Array.from({ length: count }, () => ticks)

describe('fragmentRuns', () => {
  it('splits frames into runs of up to a second, in order and without a gap', () => {
    // Thirty-three frames of 0.1 s (100 ticks of 1000 a second).
    expect(fragmentRuns(table(frames(33), [0]), 0, 33, false)).toEqual([
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 33],
    ])
  })

  it('covers just the frames asked for', () => {
    expect(fragmentRuns(table(frames(40), [0]), 5, 17, false)).toEqual([
      [5, 15],
      [15, 17],
    ])
  })

  it('starts a run at every keyframe after the first frame of the stretch, and cuts at a second', () => {
    // A keyframe at 4 comes after 0.4 s and starts a run (R49: no half-second condition); the keyframe at 16 does too.
    expect(fragmentRuns(table(frames(30), [0, 4, 16]), 0, 30, true)).toEqual([
      [0, 4],
      [4, 14],
      [14, 16],
      [16, 26],
      [26, 30],
    ])
    // A keyframe at 6 comes after 0.6 s: a run starts there.
    expect(fragmentRuns(table(frames(20), [0, 6]), 0, 20, true)).toEqual([
      [0, 6],
      [6, 16],
      [16, 20],
    ])
  })

  it('cuts at a keyframe inside a stretch shorter than half a second', () => {
    // Frames of 30 fps read a chunk at a time (two of them) hold 0.067 s, with a keyframe inside: it begins a run.
    expect(fragmentRuns(table(frames(4, 33), [0, 1]), 0, 4, true)).toEqual([
      [0, 1],
      [1, 4],
    ])
    // The first frame of the stretch is never cut before, keyframe or not.
    expect(fragmentRuns(table(frames(3, 33), [0]), 0, 3, true)).toEqual([[0, 3]])
    expect(fragmentRuns(table(frames(3, 33), [2]), 0, 3, true)).toEqual([
      [0, 2],
      [2, 3],
    ])
  })

  it('leaves keyframes out of it for a track whose every frame is one', () => {
    const every = Array.from({ length: 25 }, (_, at) => at)
    expect(fragmentRuns(table(frames(25), every), 0, 25, false)).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
  })

  it('gives a frame that lasts longer than a second a run of its own, and an empty range none', () => {
    expect(fragmentRuns(table([2500, 100, 100], [0]), 0, 3, false)).toEqual([
      [0, 1],
      [1, 3],
    ])
    expect(fragmentRuns(table([100, 100], [0]), 1, 1, false)).toEqual([])
  })

  it("counts in the track's own timescale", () => {
    // 48 000 ticks a second and 1024 a frame: 46 frames cover 0.981 s, and a 47th would pass the second.
    const runs = fragmentRuns(table(frames(100, 1024), [], 48000), 0, 100, false)
    expect(runs.map(([from, to]) => to - from)).toEqual([46, 46, 8])
  })
})

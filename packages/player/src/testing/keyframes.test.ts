import type { PlayTrack } from '@dfs/mp4'
import { describe, expect, it } from 'vitest'
import { keyframeGapSeconds } from './keyframes.ts'

// The plays suite asks how far apart a file's keyframes are, from the index alone (DESIGN.md §10.4).

/** A track of frames that are 1 s long (timescale 1, no reordering), with keyframes at these frames. */
function track(count: number, keyframes: number[], offsetSeconds = 0): PlayTrack {
  const sync = new Uint8Array(count)
  for (const frame of keyframes) sync[frame] = 1
  const dts = Uint32Array.from({ length: count }, (_, i) => i)
  return {
    table: {
      count,
      timescale: 1,
      dts,
      cts: new Int32Array(count),
      durations: new Uint32Array(count).fill(1),
      sync,
    },
    timing: { offsetSeconds, endSeconds: null },
    keyframes: Uint32Array.from(keyframes),
  } as unknown as PlayTrack
}

describe('keyframeGapSeconds', () => {
  it('is the longest stretch between two keyframes, and the stretch from the last one to the end', () => {
    expect(keyframeGapSeconds(track(10, [0, 2, 3]), 10)).toBe(7)
    expect(keyframeGapSeconds(track(10, [0, 4, 6]), 10)).toBe(4)
  })

  it('counts from the first keyframe, and from the file start when the first is late', () => {
    expect(keyframeGapSeconds(track(10, [3, 5]), 10)).toBe(5)
  })

  it('is the whole duration for a file with one keyframe', () => {
    expect(keyframeGapSeconds(track(6, [0]), 6)).toBe(6)
  })

  it('takes the track offset into account', () => {
    expect(keyframeGapSeconds(track(10, [0, 5], 1), 11)).toBe(5)
  })
})

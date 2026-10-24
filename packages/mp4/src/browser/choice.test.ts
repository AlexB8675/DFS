import { describe, expect, it } from 'vitest'
import type { FrameTable } from '../frames.ts'
import { filesToPlay, fragmentRuns, pictureEnd } from './choice.ts'
import type { Candidate } from './choice.ts'

// Which files the browser suites play, and how a stretch of frames is split into
// fragments (DESIGN.md §10.4, D45): both are chosen from names, sizes and
// durations alone, so they are checked here, in Node, with invented ones.

function synthetic(name: string): Candidate {
  return { name, size: 1000, synthetic: true, expect: 'plays' }
}

function theirs(name: string, size: number): Candidate {
  return { name, size, synthetic: false, expect: 'plays' }
}

/** Twenty files of the user's kind, the larger the earlier in the name's order, so that neither order is the other's reverse by accident. */
function twenty(): Candidate[] {
  return Array.from({ length: 20 }, (_, at) =>
    theirs(`clip-${String(at).padStart(2, '0')}.mp4`, 100 - at * 3),
  )
}

const names = (files: readonly Candidate[]): string[] => files.map((file) => file.name)

describe('filesToPlay', () => {
  it('plays every synthetic file expected to play, and none that is expected to be refused', () => {
    const files: Candidate[] = [
      synthetic('b.mp4'),
      synthetic('a.mov'),
      { name: 'fragmented.mp4', size: 5, synthetic: true, expect: { refused: 'fragmented' } },
      { name: 'refused-theirs.mp4', size: 5, synthetic: false, expect: { refused: 'damaged' } },
    ]
    expect(names(filesToPlay(files, false))).toEqual(['a.mov', 'b.mp4'])
    expect(names(filesToPlay(files, true))).toEqual(['a.mov', 'b.mp4'])
  })

  it('takes the three largest of the user files, then nine evenly spaced through the rest, by name', () => {
    // clip-00 is the largest, then clip-01 and clip-02. The other 17 are clip-03 to clip-19, and
    // nine of them are at round(i * 16 / 8) = 0, 2, 4, ... 16: every other one, from the first to the last.
    expect(names(filesToPlay(twenty(), false))).toEqual([
      'clip-00.mp4',
      'clip-01.mp4',
      'clip-02.mp4',
      'clip-03.mp4',
      'clip-05.mp4',
      'clip-07.mp4',
      'clip-09.mp4',
      'clip-11.mp4',
      'clip-13.mp4',
      'clip-15.mp4',
      'clip-17.mp4',
      'clip-19.mp4',
    ])
  })

  it('chooses by name and size alone: the order the files come in makes no difference', () => {
    const forward = twenty()
    const backward = [...forward].reverse()
    const shuffled = [...forward].sort((a, b) => (a.size % 7) - (b.size % 7) || a.size - b.size)
    expect(names(filesToPlay(backward, false))).toEqual(names(filesToPlay(forward, false)))
    expect(names(filesToPlay(shuffled, false))).toEqual(names(filesToPlay(forward, false)))
  })

  it('puts the synthetic files before the user files, each group by name', () => {
    const picked = names(filesToPlay([...twenty(), synthetic('z.mp4'), synthetic('a.mp4')], false))
    expect(picked.slice(0, 2)).toEqual(['a.mp4', 'z.mp4'])
    expect(picked).toHaveLength(2 + 12)
    expect(picked.slice(2)).toEqual([...picked.slice(2)].sort())
  })

  it('breaks a tie in size by name, so that the three largest are the same on every run', () => {
    // Five files tie for the largest: the first three by name are the three largest.
    const tied = ['d', 'a', 'c', 'b', 'e'].map((letter) => theirs(`${letter}.mp4`, 50))
    const small = Array.from({ length: 12 }, (_, at) =>
      theirs(`small-${String(at).padStart(2, '0')}.mp4`, 1),
    )
    const picked = names(filesToPlay([...tied, ...small], false))
    expect(picked).toHaveLength(12)
    expect(picked.slice(0, 3)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    // The rest are chosen from the others by name: d and e come before the small ones, and may be among them.
    expect(picked).toEqual([...picked].sort())
  })

  it('takes every user file when there are twelve or fewer, and none when there are none', () => {
    const twelve = twenty().slice(0, 12)
    expect(names(filesToPlay(twelve, false))).toEqual(names(twelve))
    expect(filesToPlay(twenty().slice(0, 5), false)).toHaveLength(5)
    expect(filesToPlay([], false)).toEqual([])
    expect(filesToPlay([synthetic('only.mp4')], false)).toHaveLength(1)
  })

  it('takes twelve different files of thirteen', () => {
    const picked = names(filesToPlay(twenty().slice(0, 13), false))
    expect(picked).toHaveLength(12)
    expect(new Set(picked).size).toBe(12)
  })

  it('plays every user file expected to play when all are asked for', () => {
    const all = filesToPlay([...twenty(), synthetic('s.mp4')], true)
    expect(all).toHaveLength(21)
    expect(names(all)[0]).toBe('s.mp4')
  })
})

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

  it('starts a run at a keyframe once the one before has covered half a second, and not sooner', () => {
    // A keyframe at 4 comes after 0.4 s: too soon. The limit cuts at 10, and the keyframe at 16 comes 0.6 s after that.
    expect(fragmentRuns(table(frames(30), [0, 4, 16]), 0, 30, true)).toEqual([
      [0, 10],
      [10, 16],
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

describe('pictureEnd', () => {
  it('is where the last frame to be shown ends, with the offset applied', () => {
    // Ten frames of 0.1 s (100 ticks of 1000 a second), the offset -0.2 s: shown from -0.2 s to 0.8 s.
    const track = {
      table: table(frames(10), [0]),
      timing: { offsetSeconds: -0.2, endSeconds: null },
    }
    expect(pictureEnd(track)).toBeCloseTo(0.8, 9)
  })

  it('goes by the frame shown last, which is not the last one decoded when frames are reordered', () => {
    // The third frame is decoded last but shown at 0.1 s; the second is shown last, at 0.3 s (a composition offset of 200 ticks).
    const reordered = table(frames(3), [0])
    reordered.cts[1] = 200
    reordered.cts[2] = -100
    const track = { table: reordered, timing: { offsetSeconds: 0, endSeconds: null } }
    expect(pictureEnd(track)).toBeCloseTo(0.4, 9)
  })

  it("stops at the edit's end when the track has one, so that a trimmed recording is not sought past it", () => {
    // Ten frames shown until 1 s, but the media edit ends at 0.6 s: the footage after it is cut by the append window.
    const track = { table: table(frames(10), [0]), timing: { offsetSeconds: 0, endSeconds: 0.6 } }
    expect(pictureEnd(track)).toBeCloseTo(0.6, 9)
    // An edit that ends after the frames do changes nothing.
    expect(pictureEnd({ ...track, timing: { offsetSeconds: 0, endSeconds: 5 } })).toBeCloseTo(1, 9)
  })
})

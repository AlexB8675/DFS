import { describe, expect, it } from 'vitest'
import { chooseTracks } from './choose.ts'
import { sliceTable } from './frames.ts'
import type { FrameTable } from './frames.ts'
import { readMovie } from './movie.ts'
import { mp4Index, mp4Seek } from './mp4source.ts'
import { displayTimed } from './retime.ts'
import { avcC, ctts, movie, stco, stsc, stss, stsz, stts, visualEntry } from './testing/build.ts'
import { keyframeAtOrBefore, pictureEnd, presentationSeconds } from './timing.ts'
import { fragmentHead } from './write.ts'

// Re-timing a play track's frames so that each lasts until the next is shown
// (DESIGN.md §10.4): Chrome's Media Source seeks a frame early when the durations
// of reordered frames are the decode deltas and not the display gaps.

/** A table of frames, in decode order, from what a test says of each (the rest is filled in). */
function table(parts: {
  durations: number[]
  cts?: number[]
  sync?: number[]
  dts?: number[]
}): FrameTable {
  const count = parts.durations.length
  const dts = new Float64Array(count)
  let time = 0
  for (let i = 0; i < count; i += 1) {
    dts[i] = parts.dts?.[i] ?? time
    time += parts.durations[i] ?? 0
  }
  return {
    count,
    timescale: 30000,
    offsets: Float64Array.from({ length: count }, (_, i) => 1000 + i * 100),
    sizes: new Uint32Array(count).fill(100),
    dts,
    durations: Uint32Array.from(parts.durations),
    cts: Int32Array.from(parts.cts ?? new Array<number>(count).fill(0)),
    sync: Uint8Array.from(parts.sync ?? new Array<number>(count).fill(1)),
  }
}

/** Two groups of pictures, decoded as I P B B, shown as I B B P, with irregular durations (the decode deltas, and so the sum of them is not what the display gaps are). */
function irregular(): FrameTable {
  // Presentation times in decode order; the decode times are the running sum of the durations.
  const durations = [1001, 1002, 999, 1000, 1003, 997, 1001, 1000]
  const shown = [2000, 5000, 3100, 4000, 8000, 11000, 9100, 10050]
  const dts: number[] = []
  let time = 0
  for (const duration of durations) {
    dts.push(time)
    time += duration
  }
  return table({
    durations,
    cts: shown.map((at, i) => at - (dts[i] ?? 0)),
    sync: [1, 0, 0, 0, 1, 0, 0, 0],
  })
}

/** What each frame of a table is shown at, in ticks. */
function shownAt(t: FrameTable): number[] {
  return Array.from({ length: t.count }, (_, i) => (t.dts[i] ?? 0) + (t.cts[i] ?? 0))
}

/** The `tfdt` time and each frame's duration and offset in a fragment's head, read back as a player's demuxer reads them. */
function decoded(t: FrameTable, from: number, to: number) {
  const { head } = fragmentHead({ header: { id: 1 }, table: t }, from, to, 1)
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const find = (type: string): number => {
    for (let at = 0; at + 8 <= head.length; at += 1) {
      if (String.fromCharCode(...head.subarray(at + 4, at + 8)) === type) return at
    }
    throw new Error(`no ${type}`)
  }
  const tfdt = find('tfdt')
  const time = view.getUint32(tfdt + 12) * 2 ** 32 + view.getUint32(tfdt + 16)
  const trun = find('trun')
  const count = view.getUint32(trun + 12)
  const frames: { duration: number; offset: number }[] = []
  for (let i = 0, at = trun + 20; i < count; i += 1, at += 16) {
    frames.push({ duration: view.getUint32(at), offset: view.getInt32(at + 12) })
  }
  return { time, frames }
}

/** The presentation times that a fragment's `tfdt` and `trun` give its frames. */
function presentedBy(fragment: ReturnType<typeof decoded>): number[] {
  let time = fragment.time
  return fragment.frames.map(({ duration, offset }) => {
    const at = time + offset
    time += duration
    return at
  })
}

describe('displayTimed', () => {
  it("keeps every frame's presentation time and gives it the gap to the frame shown next as its duration", () => {
    const original = irregular()
    const timed = displayTimed(original)
    expect(shownAt(timed)).toEqual(shownAt(original))
    // The frame shown last (the 6th decoded, at 11000) keeps its own duration.
    expect(Array.from(timed.durations)).toEqual([1100, 3000, 900, 1000, 1100, 997, 950, 950])
    expect(Array.from(timed.dts)).toEqual([0, 1100, 4100, 5000, 6000, 7100, 8097, 9047])
    // Everything else about a frame is the same.
    expect(timed.offsets).toEqual(original.offsets)
    expect(timed.sizes).toEqual(original.sizes)
    expect(timed.sync).toEqual(original.sync)
    expect(timed.count).toBe(original.count)
  })

  it('does not change the table it is given', () => {
    const original = irregular()
    const before = { dts: Array.from(original.dts), cts: Array.from(original.cts) }
    displayTimed(original)
    expect(Array.from(original.dts)).toEqual(before.dts)
    expect(Array.from(original.cts)).toEqual(before.cts)
  })

  it('writes each fragment so that a decoder is given the presentation times of the table', () => {
    const original = irregular()
    const timed = displayTimed(original)
    expect(presentedBy(decoded(timed, 0, 8))).toEqual(shownAt(original))
    const second = decoded(timed, 4, 8)
    expect(presentedBy(second)).toEqual(shownAt(original).slice(4))
    // Each duration is the display gap.
    expect(second.frames.map((frame) => frame.duration)).toEqual([1100, 997, 950, 950])
  })

  it('keeps decode times rising inside a fragment, with the first as the table has it', () => {
    const timed = displayTimed(irregular())
    for (const [from, to] of [
      [0, 8],
      [0, 3],
      [3, 8],
    ] as const) {
      const fragment = decoded(timed, from, to)
      expect(fragment.time).toBe(timed.dts[from])
      let time = fragment.time
      for (const { duration } of fragment.frames) {
        expect(duration).toBeGreaterThan(0)
        time += duration
      }
      expect(time).toBeGreaterThan(fragment.time)
    }
  })

  it("joins the fragments of two slices cut in the middle of a group on one timeline: the second's tfdt is the first's plus its durations", () => {
    const timed = displayTimed(irregular())
    const first = decoded(sliceTable(timed, 0, 6), 0, 6)
    const second = decoded(sliceTable(timed, 6, 8), 0, 2)
    const sum = first.frames.reduce((total, frame) => total + frame.duration, 0)
    expect(second.time).toBe(first.time + sum)
  })

  it('writes a fragment from a keyframe alone with the tfdt it has after the frames before it', () => {
    const timed = displayTimed(irregular())
    const after = decoded(timed, 0, 8)
    const alone = decoded(sliceTable(timed, 4, 8), 0, 4)
    expect(alone.time).toBe(timed.dts[4])
    const before = after.frames.slice(0, 4).reduce((total, frame) => total + frame.duration, 0)
    expect(alone.time).toBe(after.time + before)
  })

  it('leaves a sound, and a picture shown in the order it is decoded, as it is', () => {
    const sound = table({ durations: [1024, 1024, 1024, 1024] })
    expect(displayTimed(sound)).toEqual(sound)
    const plain = table({ durations: [1001, 1002, 999, 1000], sync: [1, 0, 0, 0] })
    expect(displayTimed(plain)).toEqual(plain)
    // A table with no frames is as it is.
    expect(displayTimed(table({ durations: [] })).count).toBe(0)
  })

  it('gives frames shown at the same time a duration of 1 tick, and keeps decode times rising', () => {
    // The 2nd and 3rd decoded are shown together, at 1500.
    const original = table({ durations: [100, 100, 100, 100], cts: [0, 1400, 1300, 400] })
    const timed = displayTimed(original)
    expect(shownAt(timed)).toEqual(shownAt(original))
    for (let i = 1; i < timed.count; i += 1) {
      expect(timed.dts[i]).toBeGreaterThan(timed.dts[i - 1] ?? 0)
    }
    expect(Array.from(timed.durations).every((duration) => duration >= 1)).toBe(true)
    // Shown in the order 0, 700 (the 4th decoded), then 1500 for both of the others: the first of those lasts 1 tick.
    expect(timed.durations[1]).toBe(1)
  })

  it('refuses frames shown further from where they are decoded than an offset of 32 bits holds', () => {
    // Shown at 2^31 - 1, 4 and -10: the last decoded is left 2^31 ticks behind the picture shown first.
    const original = table({ durations: [1, 1, 1], cts: [2 ** 31 - 1, 3, -12] })
    expect(() => displayTimed(original)).toThrow(/32 bits/)
  })
})

describe('what reads presentation times, on the re-timed table', () => {
  it('gives the same keyframe to seek from, the same end of the picture and the same shown times', () => {
    const original = irregular()
    const timing = { offsetSeconds: 0, endSeconds: null }
    const timed = displayTimed(original)
    const keyframes = Uint32Array.from([0, 4])
    for (let i = 0; i < original.count; i += 1) {
      expect(presentationSeconds(timed, timing, i)).toBe(presentationSeconds(original, timing, i))
    }
    for (const seconds of [0, 0.07, 0.1, 0.2, 0.3, 0.27, 0.5, 1]) {
      expect(keyframeAtOrBefore(timed, timing, keyframes, seconds)).toBe(
        keyframeAtOrBefore(original, timing, keyframes, seconds),
      )
    }
    // The end is where the frame shown last ends: 11000 + 997 ticks.
    expect(pictureEnd({ table: timed, timing })).toBeCloseTo((11000 + 997) / 30000, 9)
  })
})

describe('the play tracks of an MP4', () => {
  const FILE_SIZE = 2 ** 20
  function irregularMovie(): ReturnType<typeof readMovie> {
    return readMovie(
      movie({
        timescale: 1000,
        tracks: [
          {
            id: 1,
            handler: 'vide',
            timescale: 30000,
            language: 'und',
            width: 64,
            height: 48,
            entries: [visualEntry('avc1', {}, avcC())],
            tables: [
              stts([
                [1, 1001],
                [1, 1002],
                [1, 999],
                [1, 1000],
              ]),
              // Shown at 2000, 5000, 3100, 4000 (offsets from the decode times 0, 1001, 2003, 3002).
              ctts(1, [
                [1, 2000],
                [1, 3999],
                [1, 1097],
                [1, 998],
              ]),
              stsz([10, 20, 30, 40]),
              stsc([[1, 4]]),
              stco([1000]),
              stss([1]),
            ],
          },
        ],
      }),
    )
  }

  it('are re-timed by chooseTracks and mp4Index alike, with the presentation times the table gives', () => {
    const movieRead = irregularMovie()
    const chosen = chooseTracks(movieRead, FILE_SIZE).video
    const indexed = mp4Index(movieRead, FILE_SIZE).video
    for (const track of [chosen, indexed]) {
      expect(shownAt(track.table)).toEqual([2000, 5000, 3100, 4000])
      expect(Array.from(track.table.durations)).toEqual([1100, 1002, 900, 1000])
      expect(Array.from(track.table.dts)).toEqual([0, 1100, 2102, 3002])
    }
    // The seek lands on the keyframe, and the picture ends where the last frame shown ends.
    const index = mp4Index(movieRead, FILE_SIZE)
    expect(mp4Seek(index, 0, null).videoFrame).toBe(0)
    expect(index.durationSeconds).toBeCloseTo((5000 + 1002) / 30000, 9)
  })
})

import { describe, expect, it } from 'vitest'
import { Mp4Error } from './errors.ts'
import { frameTable } from './frames.ts'
import type { FrameTable } from './frames.ts'
import { readMovie } from './movie.ts'
import type { TrackHeader } from './movie.ts'
import {
  byteSpan,
  frameAtOrAfter,
  keyframeAtOrBefore,
  keyframeIndexes,
  presentationSeconds,
  trackTiming,
} from './timing.ts'
import { ctts, movie, stco, stsc, stss, stsz, stts } from './testing/build.ts'
import type { EditSpec, Run } from './testing/build.ts'

/** What `run` throws, which must be an `Mp4Error`. */
function refusal(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

interface Built {
  track: TrackHeader
  table: FrameTable
  movieTimescale: number
}

/**
 * The first track of a movie built from these tables and edits, read back by
 * `readMovie` and expanded by `frameTable`, as the repackager reads a file.
 */
function built(spec: {
  movieTimescale?: number
  timescale?: number
  handler?: string
  edits?: readonly EditSpec[]
  tables: readonly Uint8Array[]
}): Built {
  const { movieTimescale = 1000, timescale = 1000, handler, edits, tables } = spec
  const read = readMovie(
    movie({
      timescale: movieTimescale,
      tracks: [{ timescale, handler, edits: edits ? { version: 0, edits } : undefined, tables }],
    }),
  )
  const track = read.tracks[0]
  if (!track) throw new Error('expected a track')
  expect(track.problem).toBeNull()
  return { track, table: frameTable(track), movieTimescale: read.timescale }
}

/** Runs of equal values, as `stts` and `ctts` hold them. */
function runsOf(values: readonly number[]): Run[] {
  const runs: [number, number][] = []
  for (const value of values) {
    const last = runs[runs.length - 1]
    if (last?.[1] === value) last[0] += 1
    else runs.push([1, value])
  }
  return runs
}

const FRAME = 1001
const VIDEO_TIMESCALE = 30000
/** A media edit that starts 2 frames in: what a stream whose first picture is shown 2 frames after it is decoded gives. */
const TWO_FRAMES_IN: EditSpec = { duration: 5000, mediaTime: 2 * FRAME }

/**
 * Two groups of 7 pictures in decode order, I P B B P B B, with the offsets a
 * `ctts` of version 0 holds when the first picture is shown 2 frames after it
 * is decoded: the pictures of a group are shown, in frames, at 2 5 3 4 8 6 7,
 * then 9 12 10 11 15 13 14. The keyframes are samples 1 and 8 (frames 0 and 7).
 */
function withBFrames(edits: readonly EditSpec[] | undefined, keyframes = [1, 8]): Built {
  const group = [2, 4, 1, 1, 4, 1, 1].map((frames) => frames * FRAME)
  return built({
    movieTimescale: 1000,
    timescale: VIDEO_TIMESCALE,
    edits,
    tables: [
      stts([[14, FRAME]]),
      ctts(0, runsOf([...group, ...group])),
      stss(keyframes),
      stsz(Array.from({ length: 14 }, (_, i) => (i + 1) * 10)),
      stsc([[1, 14]]),
      stco([1000]),
    ],
  })
}

/** 10 frames of AAC at 48 kHz, 1024 samples each, in one chunk. */
function aac(edits: readonly EditSpec[] | undefined): Built {
  return built({
    timescale: 48000,
    handler: 'soun',
    edits,
    tables: [stts([[10, 1024]]), stsz({ size: 100, count: 10 }), stsc([[1, 10]]), stco([1000])],
  })
}

function presentations({ table, track, movieTimescale }: Built): number[] {
  const timing = trackTiming(track, movieTimescale)
  return Array.from({ length: table.count }, (_, i) => presentationSeconds(table, timing, i))
}

describe("a track's timing (§10.4)", () => {
  it("gives the offset that puts the first presented frame at the edit's start", () => {
    const pictures = withBFrames([TWO_FRAMES_IN])

    const timing = trackTiming(pictures.track, pictures.movieTimescale)

    expect(timing.offsetSeconds).toBeCloseTo(-(2 * FRAME) / VIDEO_TIMESCALE, 12)
    const times = presentations(pictures)
    // The first picture shown, whichever the decoder reaches first: 0, and the rest after it, a frame apart.
    expect(Math.min(...times)).toBe(0)
    const shown = [...times].sort((a, b) => a - b)
    shown.forEach((seconds, frame) => {
      expect(seconds).toBeCloseTo((frame * FRAME) / VIDEO_TIMESCALE, 9)
    })

    // A pause of half a second, in the movie's timescale of 1000, before the media starts.
    const paused = withBFrames([{ duration: 500, mediaTime: -1 }, TWO_FRAMES_IN])
    const pausedTiming = trackTiming(paused.track, paused.movieTimescale)
    expect(pausedTiming.offsetSeconds).toBeCloseTo(0.5 - (2 * FRAME) / VIDEO_TIMESCALE, 12)
    expect(Math.min(...presentations(paused))).toBeCloseTo(0.5, 12)
  })

  it("gives AAC priming's negative start", () => {
    const sound = aac([{ duration: 9000, mediaTime: 1024 }])

    const timing = trackTiming(sound.track, sound.movieTimescale)

    expect(timing.offsetSeconds).toBeCloseTo(-1024 / 48000, 12)
    const times = presentations(sound)
    // The first frame is the priming, shown before 0; the second is where the sound begins.
    expect(times[0]).toBeCloseTo(-1024 / 48000, 12)
    expect(times[1]).toBe(0)
    expect(times[2]).toBeCloseTo(1024 / 48000, 12)
  })

  it('gives no offset to a track without an edit list, with an empty one, or that starts at 0', () => {
    for (const edits of [undefined, [], [{ duration: 5000, mediaTime: 0 }]]) {
      const { track, movieTimescale } = aac(edits)
      expect(trackTiming(track, movieTimescale).offsetSeconds, JSON.stringify(edits)).toBe(0)
    }
    expect(aac(undefined).track.edits).toBeNull()
    expect(aac([]).track.edits).toEqual([])
  })

  it("doesn't use how long the media edit lasts: a trim at the end is not applied", () => {
    // 10 frames of 1024 are 0.21 s, and the edit says 1 s, or 1 ms: the start is all that is read.
    for (const duration of [1000, 1]) {
      const { track, movieTimescale } = aac([{ duration, mediaTime: 1024 }])
      expect(trackTiming(track, movieTimescale).offsetSeconds).toBeCloseTo(-1024 / 48000, 12)
    }
  })

  it("ignores an empty edit's rate, which has nothing to play at", () => {
    const { track, movieTimescale } = aac([
      { duration: 500, mediaTime: -1, rate: 0 },
      { duration: 9000, mediaTime: 1024 },
    ])
    expect(trackTiming(track, movieTimescale).offsetSeconds).toBeCloseTo(0.5 - 1024 / 48000, 12)
  })

  it('refuses two media edits, a rate other than 1, or an empty edit after a media one', () => {
    const cases: { name: string; edits: EditSpec[]; says: RegExp }[] = [
      {
        name: 'two media edits',
        edits: [
          { duration: 4000, mediaTime: 0 },
          { duration: 4000, mediaTime: 4096 },
        ],
        says: /two media edits/,
      },
      {
        name: 'a media edit at double the rate',
        edits: [{ duration: 4000, mediaTime: 0, rate: 0x20000 }],
        says: /rate of 2/,
      },
      {
        name: 'a media edit at half the rate, after an empty one',
        edits: [
          { duration: 500, mediaTime: -1 },
          { duration: 4000, mediaTime: 0, rate: 0x8000 },
        ],
        says: /rate of 0\.5/,
      },
      {
        name: 'a media edit at rate 0, which holds a frame',
        edits: [{ duration: 4000, mediaTime: 0, rate: 0 }],
        says: /rate of 0/,
      },
      {
        name: 'an empty edit after a media one',
        edits: [
          { duration: 4000, mediaTime: 0 },
          { duration: 500, mediaTime: -1 },
        ],
        says: /empty edit after a media edit/,
      },
    ]
    for (const { name, edits, says } of cases) {
      const { track, movieTimescale } = aac(edits)
      const error = refusal(() => trackTiming(track, movieTimescale))
      expect(error.reason, name).toBe('edit-list')
      expect(error.message, name).toMatch(says)
    }
  })

  it('refuses an empty edit with no media after it, more than two edits, or a start before -1', () => {
    const cases: { name: string; edits: EditSpec[]; says: RegExp }[] = [
      { name: 'one empty edit', edits: [{ duration: 500, mediaTime: -1 }], says: /no media edit/ },
      {
        name: 'two empty edits',
        edits: [
          { duration: 500, mediaTime: -1 },
          { duration: 500, mediaTime: -1 },
        ],
        says: /two empty edits/,
      },
      {
        name: 'an empty edit and two media edits',
        edits: [
          { duration: 500, mediaTime: -1 },
          { duration: 4000, mediaTime: 0 },
          { duration: 4000, mediaTime: 4096 },
        ],
        says: /3 edits/,
      },
      {
        name: 'a start before -1',
        edits: [{ duration: 4000, mediaTime: -2 }],
        says: /media time of -2/,
      },
    ]
    for (const { name, edits, says } of cases) {
      const { track, movieTimescale } = aac(edits)
      const error = refusal(() => trackTiming(track, movieTimescale))
      expect(error.reason, name).toBe('edit-list')
      expect(error.message, name).toMatch(says)
    }
  })

  it('refuses a timescale of 0 where it would be divided by, and only there', () => {
    // readMovie makes a track of timescale 0 a track with a problem, which is the form it reaches here in.
    const read = readMovie(movie({ tracks: [{ timescale: 0 }] }))
    const broken = read.tracks[0]
    expect(broken?.timescale).toBe(0)
    if (!broken) throw new Error('expected a track')
    expect(refusal(() => trackTiming(broken, 1000)).reason).toBe('damaged')

    // The movie's timescale is only needed for an empty edit.
    const pause = { duration: 500, mediaTime: -1 }
    const media = { duration: 9000, mediaTime: 1024 }
    const withPause = aac([pause, media])
    expect(refusal(() => trackTiming(withPause.track, 0)).reason).toBe('damaged')
    const withoutPause = aac([media])
    expect(trackTiming(withoutPause.track, 0).offsetSeconds).toBeCloseTo(-1024 / 48000, 12)
    expect(trackTiming(aac(undefined).track, 0).offsetSeconds).toBe(0)
  })

  it('refuses a presentation time of a frame the table does not have', () => {
    const { table } = aac(undefined)
    const timing = { offsetSeconds: 0 }
    expect(() => presentationSeconds(table, timing, 10)).toThrow(RangeError)
    expect(() => presentationSeconds(table, timing, -1)).toThrow(RangeError)
    expect(() => presentationSeconds(table, timing, 1.5)).toThrow(RangeError)
    expect(presentationSeconds(table, timing, 9)).toBeCloseTo((9 * 1024) / 48000, 12)
  })
})

describe('where a time is in a track (§10.4)', () => {
  it("lists a table's keyframes, in decode order", () => {
    const keyed = withBFrames(undefined)
    const found = keyframeIndexes(keyed.table)
    expect(found).toBeInstanceOf(Uint32Array)
    expect(Array.from(found)).toEqual([0, 7])

    // Without an stss every frame is a keyframe.
    expect(Array.from(keyframeIndexes(aac(undefined).table))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])

    // With an stss that lists none there are none.
    const none = withBFrames(undefined, [])
    expect(keyframeIndexes(none.table)).toHaveLength(0)
  })

  it('finds the keyframe at or before a time, by presentation', () => {
    const pictures = withBFrames([TWO_FRAMES_IN])
    const timing = trackTiming(pictures.track, pictures.movieTimescale)
    const { table } = pictures
    const keyframes = keyframeIndexes(table)
    const at = (seconds: number): number => keyframeAtOrBefore(table, timing, keyframes, seconds)
    const second = presentationSeconds(table, timing, 7)

    // Where it is a frame index, not a place in the list of keyframes: the second keyframe is frame 7.
    expect(at(second)).toBe(7)
    expect(at(second + 0.001)).toBe(7)
    expect(at(100)).toBe(7)
    expect(at(presentationSeconds(table, timing, 0))).toBe(0)
    expect(at(second - 0.0001)).toBe(0)
    expect(at(0.1)).toBe(0)
    // Before the first frame, the first keyframe.
    expect(at(-1)).toBe(0)
    // Frame 7 is decoded 5 frames in, but not shown before 7: by presentation 6 frames is still in the first group.
    expect(at((6 * FRAME) / VIDEO_TIMESCALE)).toBe(0)
  })

  it('gives the first keyframe, by frame index, for a time before it', () => {
    // The first frame isn't one a decoder could start from: the first keyframe is sample 3, frame 2.
    const pictures = withBFrames([TWO_FRAMES_IN], [3, 8])
    const timing = trackTiming(pictures.track, pictures.movieTimescale)
    const keyframes = keyframeIndexes(pictures.table)
    expect(Array.from(keyframes)).toEqual([2, 7])
    expect(keyframeAtOrBefore(pictures.table, timing, keyframes, -5)).toBe(2)
    expect(keyframeAtOrBefore(pictures.table, timing, keyframes, 0)).toBe(2)
  })

  it('refuses to look for a keyframe in a table that has none', () => {
    const none = withBFrames([TWO_FRAMES_IN], [])
    const timing = trackTiming(none.track, none.movieTimescale)
    const error = refusal(() =>
      keyframeAtOrBefore(none.table, timing, keyframeIndexes(none.table), 1),
    )
    expect(error.reason).toBe('damaged')
  })

  it('finds the first frame decoded at or after a time, the offset applied', () => {
    const sound = aac([{ duration: 9000, mediaTime: 1024 }])
    const timing = trackTiming(sound.track, sound.movieTimescale)
    const { table } = sound
    const at = (seconds: number): number => frameAtOrAfter(table, timing, seconds)
    const fifth = presentationSeconds(table, timing, 5)

    expect(at(-1)).toBe(0)
    // Frame 0 is decoded at -1024/48000 once the offset is applied, frame 1 at 0.
    expect(at(0)).toBe(1)
    expect(at(fifth)).toBe(5)
    expect(at(fifth - 0.0001)).toBe(5)
    expect(at(fifth + 0.0001)).toBe(6)
    expect(at(presentationSeconds(table, timing, 9))).toBe(9)
    // Past the last frame: none, which is the table's count.
    expect(at(presentationSeconds(table, timing, 9) + 0.0001)).toBe(table.count)
    expect(at(100)).toBe(10)
  })

  it('finds a frame by decode time, not by when it is shown', () => {
    const pictures = withBFrames([TWO_FRAMES_IN])
    const timing = trackTiming(pictures.track, pictures.movieTimescale)
    const { table } = pictures
    // Frame 3 is decoded 3 frames in (1 frame after the offset), and shown 4 frames in (2 after it).
    const decoded = (3 * FRAME) / VIDEO_TIMESCALE + timing.offsetSeconds
    expect(frameAtOrAfter(table, timing, decoded)).toBe(3)
    expect(frameAtOrAfter(table, timing, decoded + 0.0001)).toBe(4)
    expect(presentationSeconds(table, timing, 3)).toBeGreaterThan(decoded + 0.03)
  })
})

describe('the bytes of a run of frames (§10.4)', () => {
  // Video: frames of 100, 200, 300 and 400 bytes in 2 chunks at 1000 and 2000.
  // Sound: 6 frames of 10 bytes in 2 chunks of 3, at 1500 and 2600.
  const video = built({
    tables: [stts([[4, 1000]]), stsz([100, 200, 300, 400]), stsc([[1, 2]]), stco([1000, 2000])],
  }).table
  const sound = built({
    tables: [stts([[6, 1000]]), stsz({ size: 10, count: 6 }), stsc([[1, 3]]), stco([1500, 2600])],
  }).table

  it('gives the span of interleaved frames of two tracks', () => {
    // Video frames 1 and 2 are at 1100 to 1300 and 2000 to 2300; sound frames 0 to 3 are at 1500 to 1530 and 2600 to 2610.
    expect(
      byteSpan([
        { table: video, from: 1, to: 3 },
        { table: sound, from: 0, to: 4 },
      ]),
    ).toEqual({
      start: 1100,
      end: 2610,
    })
    // Each alone.
    expect(byteSpan([{ table: video, from: 1, to: 3 }])).toEqual({ start: 1100, end: 2300 })
    expect(byteSpan([{ table: sound, from: 3, to: 6 }])).toEqual({ start: 2600, end: 2630 })
    // One frame: its own bytes.
    expect(byteSpan([{ table: video, from: 3, to: 4 }])).toEqual({ start: 2300, end: 2700 })
  })

  it("doesn't take the frames of a track for ascending in the file", () => {
    // The second chunk is before the first: frames 0 and 1 at 2000 and 2100, frames 2 and 3 at 1000 and 1300.
    const reversed = built({
      tables: [stts([[4, 1000]]), stsz([100, 200, 300, 400]), stsc([[1, 2]]), stco([2000, 1000])],
    }).table
    expect(byteSpan([{ table: reversed, from: 0, to: 4 }])).toEqual({ start: 1000, end: 2300 })
    expect(byteSpan([{ table: reversed, from: 1, to: 3 }])).toEqual({ start: 1000, end: 2300 })
    // Frame 3 is 400 bytes at 1300: it ends at 1700, before frame 1 starts.
    expect(byteSpan([{ table: reversed, from: 3, to: 4 }])).toEqual({ start: 1300, end: 1700 })
  })

  it('gives nothing to read as 0 to 0, and leaves an empty range out of the span', () => {
    expect(byteSpan([])).toEqual({ start: 0, end: 0 })
    expect(byteSpan([{ table: video, from: 2, to: 2 }])).toEqual({ start: 0, end: 0 })
    expect(
      byteSpan([
        { table: video, from: 4, to: 4 },
        { table: sound, from: 1, to: 1 },
      ]),
    ).toEqual({ start: 0, end: 0 })
    // An empty range doesn't reach down to 1000 or up to 2700.
    expect(
      byteSpan([
        { table: video, from: 4, to: 4 },
        { table: sound, from: 0, to: 1 },
      ]),
    ).toEqual({
      start: 1500,
      end: 1510,
    })
  })

  it('refuses a range outside the frames of its table', () => {
    expect(() => byteSpan([{ table: video, from: 0, to: 5 }])).toThrow(RangeError)
    expect(() => byteSpan([{ table: video, from: -1, to: 2 }])).toThrow(RangeError)
    expect(() => byteSpan([{ table: video, from: 0.5, to: 2 }])).toThrow(RangeError)
  })
})

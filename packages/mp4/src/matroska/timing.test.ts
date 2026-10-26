import { describe, expect, it } from 'vitest'
import type { RawFrame } from './clusters.ts'
import {
  decodeTimes,
  startDecode,
  toTrackTicks,
  trackOffsetSeconds,
  trackTimescale,
} from './timing.ts'
import type { DecodeState, TimedFrame } from './timing.ts'

// The decode times and decode durations of a track's frames, as ffmpeg derives
// them from the presentation times Matroska stores (DESIGN.md §10.4, D45). The
// evidence is a file ffmpeg made of generated pictures (2026-10-25): x264's
// B-frames, depth 2, at 30 fps, whose frames in decode order are presented at
// 0, 100, 33, 67, 233, 167, 133 and 200 ms. ffprobe gives no dts for the first
// two and then the presentation times in rising order (0, 33, 67, 100, 133, 167);
// ffmpeg's remux to MP4 gives the first two as -0.067 and -0.034 s, 2 and 1
// frames back from the first presentation time. The expected values below are
// written out from that and from the rule of the brief, not computed by the
// module.

/** The evidence's presentation times, in decode order, in ms. */
const EVIDENCE_PTS = [0, 100, 33, 67, 233, 167, 133, 200]

/** DefaultDuration 33 333 333 ns, in the ticks of a 1 ms scale. */
const FRAME_TICKS = 33.333333

/** What the rule gives for the evidence: the remux's dts in ms (the first two rounded, once), and the distance to the next. */
const EVIDENCE_DTS = [-67, -33, 0, 33, 67, 100, 133, 167]
const EVIDENCE_DURATIONS = [34, 33, 33, 34, 33, 33, 34, 33]

/** The remux's decode times in seconds (ffprobe's, and for the first two ffmpeg's own), which every dts must be within 1 ms of. */
const REMUX_SECONDS = [-0.067, -0.034, 0, 0.033, 0.067, 0.1, 0.133, 0.167]

/** A frame of a track as the clusters give it: its offset and size are not what timing looks at, but differ so that a mix-up of frames shows. */
function frame(pts: number, index: number, duration: number | null = FRAME_TICKS): RawFrame {
  return {
    track: 1,
    offset: 1000 + index * 100,
    size: 50 + index,
    pts,
    keyframe: index === 0,
    duration,
    body: 990 + index * 100,
  }
}

function framesOf(pts: readonly number[], duration: number | null = FRAME_TICKS): RawFrame[] {
  return pts.map((time, index) => frame(time, index, duration))
}

/** All the frames in one call that ends the stream: the timed frames. */
function allAtOnce(
  depth: number,
  frameTicks: number,
  frames: readonly RawFrame[],
): { timed: TimedFrame[]; state: DecodeState } {
  return decodeTimes(startDecode(depth, frameTicks), frames, true)
}

function dtsOf(timed: readonly TimedFrame[]): number[] {
  return timed.map((one) => one.dts)
}

function durationsOf(timed: readonly TimedFrame[]): number[] {
  return timed.map((one) => one.decodeDuration)
}

describe('decodeTimes: the evidence file', () => {
  const frames = framesOf(EVIDENCE_PTS)

  it('gives the remux its decode times and the distances between them', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, frames)
    expect(dtsOf(timed)).toEqual(EVIDENCE_DTS)
    expect(durationsOf(timed)).toEqual(EVIDENCE_DURATIONS)
  })

  it('is within a millisecond of the remux for each frame', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, frames)
    expect(timed).toHaveLength(REMUX_SECONDS.length)
    for (const [index, one] of timed.entries()) {
      expect(Math.abs(one.dts / 1000 - (REMUX_SECONDS[index] ?? NaN))).toBeLessThanOrEqual(
        0.001 + 1e-9,
      )
    }
  })

  it('keeps each frame as it was, with its two times', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, frames)
    for (const [index, one] of timed.entries()) {
      expect(one).toEqual({
        ...frames[index],
        dts: EVIDENCE_DTS[index],
        decodeDuration: EVIDENCE_DURATIONS[index],
      })
    }
  })

  it('gives whole ticks only, though the frame duration is not whole', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, frames)
    for (const one of timed) {
      expect(Number.isInteger(one.dts)).toBe(true)
      expect(Number.isInteger(one.decodeDuration)).toBe(true)
    }
  })

  it('holds the last frame until the stream ends, for its duration is not yet known', () => {
    const { timed, state } = decodeTimes(startDecode(2, FRAME_TICKS), frames, false)
    expect(dtsOf(timed)).toEqual(EVIDENCE_DTS.slice(0, 7))
    expect(durationsOf(timed)).toEqual(EVIDENCE_DURATIONS.slice(0, 7))
    expect(state.held).toEqual([frames[7]])
    expect(state.lastDts).toBe(167)
  })

  it('gives the first frames as soon as depth + 1 frames have been seen, and not before', () => {
    const fewer = decodeTimes(startDecode(2, FRAME_TICKS), frames.slice(0, 2), false)
    expect(fewer.timed).toEqual([])
    expect(fewer.state.held).toEqual(frames.slice(0, 2))
    expect(fewer.state.lastDts).toBeNull()

    // Task 12 takes a picture's shift from the first of these.
    const enough = decodeTimes(startDecode(2, FRAME_TICKS), frames.slice(0, 3), false)
    expect(dtsOf(enough.timed)).toEqual([-67, -33])
    expect(durationsOf(enough.timed)).toEqual([34, 33])
    expect(enough.state.held).toEqual([frames[2]])
    expect(enough.state.lastDts).toBe(0)
  })

  it('gives the same frames when they come in two calls, cut at each place', () => {
    const whole = allAtOnce(2, FRAME_TICKS, frames).timed
    for (let cut = 0; cut <= frames.length; cut += 1) {
      const first = decodeTimes(startDecode(2, FRAME_TICKS), frames.slice(0, cut), false)
      const second = decodeTimes(first.state, frames.slice(cut), true)
      expect([...first.timed, ...second.timed], `cut at ${cut}`).toEqual(whole)
    }
  })

  it('gives the same frames when they come one at a time, and the end alone is a call', () => {
    const whole = allAtOnce(2, FRAME_TICKS, frames).timed
    let state = startDecode(2, FRAME_TICKS)
    const timed: TimedFrame[] = []
    for (const one of frames) {
      const step = decodeTimes(state, [one], false)
      timed.push(...step.timed)
      state = step.state
    }
    const last = decodeTimes(state, [], true)
    timed.push(...last.timed)
    expect(timed).toEqual(whole)
    expect(last.timed).toHaveLength(1)
  })

  it('does not change the state it is given, so that one state serves two calls', () => {
    const first = decodeTimes(startDecode(2, FRAME_TICKS), frames.slice(0, 4), false)
    const before = structuredClone(first.state)
    const one = decodeTimes(first.state, frames.slice(4), true)
    expect(first.state).toEqual(before)
    const again = decodeTimes(first.state, frames.slice(4), true)
    expect(again).toEqual(one)
    expect(first.state).toEqual(before)
  })

  it('does not change the frames it is given', () => {
    const before = structuredClone(frames)
    allAtOnce(2, FRAME_TICKS, frames)
    expect(frames).toEqual(before)
  })

  it('starts afresh after the end, so that a second end gives nothing', () => {
    const { state } = allAtOnce(2, FRAME_TICKS, frames)
    expect(state).toEqual(startDecode(2, FRAME_TICKS))
    expect(decodeTimes(state, [], true).timed).toEqual([])
  })
})

describe('decodeTimes: a start', () => {
  it('extrapolates the first depth decode times back from the first presentation time', () => {
    // A keyframe of pts 1000, as after a seek, with the evidence's order and spacing.
    const pts = EVIDENCE_PTS.map((time) => time + 1000)
    const { timed } = allAtOnce(2, FRAME_TICKS, framesOf(pts))
    expect(dtsOf(timed)).toEqual(EVIDENCE_DTS.map((time) => time + 1000))
    expect(dtsOf(timed).slice(0, 2)).toEqual([933, 967])
    expect(durationsOf(timed)).toEqual(EVIDENCE_DURATIONS)
  })

  it('takes the least presentation time of the first depth + 1 frames as the base, wherever it is', () => {
    // The least comes last of the three, as it does when a start is at a frame that is not a keyframe of the file.
    const { timed } = allAtOnce(2, FRAME_TICKS, framesOf([100, 133, 67, 200, 167]))
    expect(dtsOf(timed)).toEqual([0, 34, 67, 100, 133])
  })

  it('rounds the base less each distance once, and not each distance on its own', () => {
    // 3 x 33.333333 is 99.999999, which is 100 once; each of 33.333333 rounded and added would be 99.
    const { timed } = allAtOnce(3, FRAME_TICKS, framesOf([0, 133, 67, 33, 200, 167]))
    expect(dtsOf(timed).slice(0, 3)).toEqual([-100, -67, -33])
    expect(dtsOf(timed)[3]).toBe(0)
  })

  it('refuses a depth or a frame length that is not a number of frames and ticks', () => {
    expect(() => startDecode(-1, 33)).toThrow(RangeError)
    expect(() => startDecode(1.5, 33)).toThrow(RangeError)
    expect(() => startDecode(2, 0)).toThrow(RangeError)
    expect(() => startDecode(2, -33)).toThrow(RangeError)
    expect(() => startDecode(2, NaN)).toThrow(RangeError)
    expect(() => startDecode(2, Infinity)).toThrow(RangeError)
  })

  it('makes a state of no frames waiting', () => {
    expect(startDecode(2, FRAME_TICKS)).toEqual({
      depth: 2,
      frameTicks: FRAME_TICKS,
      pending: [],
      held: [],
      lastDts: null,
    })
  })
})

describe('decodeTimes: a stream that ends before depth + 1 frames', () => {
  // Frame i of k seen gets the least presentation time less (k - 1 - i) frames, so
  // the last of them gets the least, as it would as frame `depth` of a longer
  // stream, and they rise.
  it('gives two frames of a depth of 2 the second the least', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, framesOf([0, 100]))
    expect(dtsOf(timed)).toEqual([-33, 0])
    expect(durationsOf(timed)).toEqual([33, 33])
  })

  it('gives one frame its own presentation time', () => {
    const { timed } = allAtOnce(2, FRAME_TICKS, framesOf([500]))
    expect(dtsOf(timed)).toEqual([500])
    expect(durationsOf(timed)).toEqual([33])
  })

  it('takes the least of those seen when it is not the first', () => {
    const { timed } = allAtOnce(3, FRAME_TICKS, framesOf([100, 0]))
    expect(dtsOf(timed)).toEqual([-33, 0])
  })

  it('gives nothing for no frame', () => {
    const { timed, state } = allAtOnce(2, FRAME_TICKS, [])
    expect(timed).toEqual([])
    expect(state).toEqual(startDecode(2, FRAME_TICKS))
  })
})

describe('decodeTimes: the last frame', () => {
  it('lasts its own duration, rounded', () => {
    const { timed } = allAtOnce(0, 20, framesOf([0, 20, 40], 20.4))
    expect(durationsOf(timed)).toEqual([20, 20, 20])
    const longer = allAtOnce(0, 20, [frame(0, 0, 25), frame(20, 1, 25.6)]).timed
    expect(durationsOf(longer)).toEqual([20, 26])
  })

  it('lasts the length of a frame of its track when it has no duration of its own', () => {
    const { timed } = allAtOnce(0, 33.333333, framesOf([0, 33, 67], null))
    expect(durationsOf(timed)).toEqual([33, 34, 33])
  })

  it('lasts at least a tick, however short its duration is', () => {
    expect(durationsOf(allAtOnce(0, 0.2, framesOf([0], null)).timed)).toEqual([1])
    expect(durationsOf(allAtOnce(0, 20, framesOf([0], 0.1)).timed)).toEqual([1])
  })
})

describe('decodeTimes: a sound', () => {
  it('has decode times equal to its presentation times, with depth 0', () => {
    const { timed } = allAtOnce(0, 20, framesOf([0, 20, 40], 20))
    expect(dtsOf(timed)).toEqual([0, 20, 40])
    expect(durationsOf(timed)).toEqual([20, 20, 20])
  })

  it('lasts, for the frames but the last, the distance to the next, whatever the frames say', () => {
    const { timed } = allAtOnce(0, 20, framesOf([0, 21, 40], 20))
    expect(durationsOf(timed)).toEqual([21, 19, 20])
  })

  it('gives each frame as soon as the next is seen', () => {
    const state = startDecode(0, 20)
    const one = decodeTimes(state, framesOf([-21]), false)
    expect(one.timed).toEqual([])
    const two = decodeTimes(one.state, [frame(0, 1)], false)
    expect(dtsOf(two.timed)).toEqual([-21])
    expect(durationsOf(two.timed)).toEqual([21])
  })
})

describe('decodeTimes: a stream that reorders deeper than the depth given', () => {
  it('never lets the decode times fall, nor a duration be 0 (the brief)', () => {
    const { timed } = allAtOnce(1, FRAME_TICKS, framesOf([0, 66, 33, 100, 200, 133, 166]))
    const dts = dtsOf(timed)
    expect(dts).toHaveLength(7)
    for (let index = 1; index < dts.length; index += 1) {
      expect(dts[index]).toBeGreaterThan(dts[index - 1] ?? Infinity)
    }
    for (const one of timed) expect(one.decodeDuration).toBeGreaterThanOrEqual(1)
  })

  it('raises a decode time to one tick past the one before, and its composition offset goes negative', () => {
    // 10 comes after 50 was decoded: with a depth of 1 it would be decoded at 10, before 50.
    const { timed } = allAtOnce(1, 33, framesOf([0, 100, 50, 10], null))
    expect(dtsOf(timed)).toEqual([-33, 0, 50, 51])
    expect(durationsOf(timed)).toEqual([33, 50, 1, 33])
    expect(timed.map((one) => one.pts - one.dts)).toEqual([33, 100, 0, -41])
  })

  it('holds for a deeper stream from any cut of the calls', () => {
    const frames = framesOf([0, 100, 133, 66, 166, 200, 150, 250], null)
    const whole = allAtOnce(1, 33, frames).timed
    for (let cut = 0; cut <= frames.length; cut += 1) {
      const first = decodeTimes(startDecode(1, 33), frames.slice(0, cut), false)
      const second = decodeTimes(first.state, frames.slice(cut), true)
      expect([...first.timed, ...second.timed], `cut at ${cut}`).toEqual(whole)
    }
    for (let index = 1; index < whole.length; index += 1) {
      expect(whole[index]?.dts).toBeGreaterThan(whole[index - 1]?.dts ?? Infinity)
    }
    for (const one of whole) expect(one.decodeDuration).toBeGreaterThanOrEqual(1)
  })

  it('keeps the extrapolated decode times apart when a frame is shorter than a tick', () => {
    // 0.4 rounds to 0, so the second extrapolated time would equal the least, which the third takes: they are kept a tick apart.
    const { timed } = allAtOnce(2, 0.4, framesOf([0, 3, 1, 2, 5, 4], null))
    const dts = dtsOf(timed)
    for (let index = 1; index < dts.length; index += 1) {
      expect(dts[index]).toBeGreaterThan(dts[index - 1] ?? Infinity)
    }
    for (const one of timed) expect(one.decodeDuration).toBeGreaterThanOrEqual(1)
  })
})

describe('trackOffsetSeconds', () => {
  it('takes the codec delay and the shift off, in seconds', () => {
    expect(trackOffsetSeconds(6_500_000, 0, 1000)).toBe(-0.0065)
    expect(trackOffsetSeconds(0, 67, 1000)).toBe(-0.067)
    expect(trackOffsetSeconds(6_500_000, 67, 1000)).toBeCloseTo(-0.0735, 12)
  })

  it('is 0, and not -0, when there is neither', () => {
    expect(trackOffsetSeconds(0, 0, 1000)).toBe(0)
  })
})

describe('trackTimescale and toTrackTicks', () => {
  it('counts in the scale itself when a second holds it a whole number of times', () => {
    expect(trackTimescale(1_000_000)).toBe(1000)
    expect(trackTimescale(100_000)).toBe(10_000)
    expect(trackTimescale(1_000_000_000)).toBe(1)
    expect(toTrackTicks(1234, 1_000_000)).toBe(1234)
    expect(toTrackTicks(-67, 100_000)).toBe(-67)
  })

  it('counts in nanoseconds when it does not', () => {
    expect(trackTimescale(333_333)).toBe(1e9)
    expect(trackTimescale(3_000_000_000)).toBe(1e9)
    expect(toTrackTicks(3, 333_333)).toBe(999_999)
    expect(toTrackTicks(-2, 333_333)).toBe(-666_666)
  })

  it('counts in nanoseconds for a scale that is no scale at all, which a head never gives', () => {
    expect(trackTimescale(0)).toBe(1e9)
  })
})

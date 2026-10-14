import { describe, expect, it } from 'vitest'
import {
  BEHIND_BYTES,
  TOTAL_BYTES,
  aheadSeconds,
  bufferTargets,
  keyframeAtOrBefore,
  keyframeTimes,
  longestKeyframeGap,
  mimeOf,
  samplesPerSegment,
  type RangesShape,
  type SampleShape,
  type TrackShape,
} from './tracks'

/** The proof file's video track: 3601 samples over 60.0 s. */
const proofVideo: TrackShape = {
  codec: 'hvc1.2.4.L153.B0',
  type: 'video',
  nb_samples: 3601,
  duration: 3_600_000,
  timescale: 60_000,
}

/** The proof file's audio track: 2813 samples over 60.0 s. */
const proofAudio: TrackShape = {
  codec: 'mp4a.40.2',
  type: 'audio',
  nb_samples: 2813,
  duration: 2_880_000,
  timescale: 48_000,
}

/** A TimeRanges as the helpers see it, built from [start, end] pairs. */
function ranges(pairs: [number, number][]): RangesShape {
  const at = (index: number): [number, number] => {
    const pair = pairs[index]
    if (!pair) throw new Error(`no range ${index}`)
    return pair
  }
  return {
    length: pairs.length,
    start: (index) => at(index)[0],
    end: (index) => at(index)[1],
  }
}

describe('mimeOf (§10.4)', () => {
  it('names a video track as video/mp4 with its codec', () => {
    expect(mimeOf(proofVideo)).toBe('video/mp4; codecs="hvc1.2.4.L153.B0"')
  })

  it('names an audio track as audio/mp4 with its codec', () => {
    expect(mimeOf(proofAudio)).toBe('audio/mp4; codecs="mp4a.40.2"')
  })

  it('treats a track with no type as video', () => {
    const { type: _type, ...untyped } = proofVideo
    expect(mimeOf(untyped)).toBe('video/mp4; codecs="hvc1.2.4.L153.B0"')
  })
})

describe('samplesPerSegment (§10.4)', () => {
  it('gives 30 samples for half a second of the proof file video', () => {
    expect(samplesPerSegment(proofVideo, 0.5)).toBe(30)
  })

  it('gives 23 samples for half a second of the proof file audio', () => {
    expect(samplesPerSegment(proofAudio, 0.5)).toBe(23)
  })

  it('is at least 1 sample, however short the segment', () => {
    expect(samplesPerSegment(proofVideo, 0.001)).toBe(1)
  })

  it('is 1 for a track with no duration and no samples', () => {
    expect(samplesPerSegment({ ...proofVideo, nb_samples: 0, duration: 0 }, 0.5)).toBe(1)
  })

  it('is every sample for a track with samples but no duration', () => {
    expect(samplesPerSegment({ ...proofVideo, nb_samples: 12, duration: 0 }, 0.5)).toBe(12)
  })
})

describe('aheadSeconds (§10.4)', () => {
  const buffered = ranges([
    [0, 5],
    [6, 9],
  ])

  it('counts to the end of the range the time is inside', () => {
    expect(aheadSeconds(buffered, 2)).toBe(3)
  })

  it('counts in a later range', () => {
    expect(aheadSeconds(buffered, 6.5)).toBe(2.5)
  })

  it('is 0 in a gap between ranges', () => {
    expect(aheadSeconds(buffered, 5.5)).toBe(0)
  })

  it('is 0 at the end of a range', () => {
    expect(aheadSeconds(buffered, 5)).toBe(0)
  })

  it('forgives a first frame that starts a little after the time', () => {
    expect(aheadSeconds(ranges([[0.05, 4]]), 0)).toBeCloseTo(4, 5)
  })

  it('does not forgive a first frame that starts well after the time', () => {
    expect(aheadSeconds(ranges([[0.5, 4]]), 0)).toBe(0)
  })

  it('is 0 with nothing buffered', () => {
    expect(aheadSeconds(ranges([]), 0)).toBe(0)
  })
})

/** A sample of a video track with timescale 30, for the keyframe helpers. */
function sample(cts: number, isSync: boolean): SampleShape {
  return { is_sync: isSync, cts, timescale: 30 }
}

describe('keyframeTimes (§10.4)', () => {
  it('keeps only the sync samples, in seconds and in order, however the samples are ordered', () => {
    const samples = [
      sample(0, true),
      sample(30, false),
      sample(60, false),
      sample(300, true),
      sample(90, true),
      sample(150, true),
    ]
    expect(keyframeTimes(samples)).toEqual([0, 3, 5, 10])
  })

  it('is empty when no sample is a keyframe', () => {
    expect(keyframeTimes([sample(0, false), sample(30, false)])).toEqual([])
  })

  it('is empty for no samples', () => {
    expect(keyframeTimes([])).toEqual([])
  })
})

describe('keyframeAtOrBefore (§10.4)', () => {
  it('finds the last keyframe before the time', () => {
    expect(keyframeAtOrBefore([0, 5, 10], 7)).toBe(5)
  })

  it('finds a keyframe at exactly the time', () => {
    expect(keyframeAtOrBefore([0, 5, 10], 10)).toBe(10)
    expect(keyframeAtOrBefore([0, 5, 10], 5)).toBe(5)
  })

  it('finds the last keyframe for a time after it', () => {
    expect(keyframeAtOrBefore([0, 5, 10], 99)).toBe(10)
  })

  it('is 0 for a time before the first keyframe', () => {
    expect(keyframeAtOrBefore([0, 5, 10], -1)).toBe(0)
    expect(keyframeAtOrBefore([2, 5], 1)).toBe(0)
  })

  it('is 0 when there are no keyframes', () => {
    expect(keyframeAtOrBefore([], 3)).toBe(0)
  })
})

describe('longestKeyframeGap (§10.4)', () => {
  it('is the longest gap between keyframes, counting to the end', () => {
    expect(longestKeyframeGap([0, 5, 10], 12)).toBe(5)
  })

  it('counts from 0 to the first keyframe and from the last to the end', () => {
    expect(longestKeyframeGap([1, 2], 10)).toBe(8)
    expect(longestKeyframeGap([4, 5], 6)).toBe(4)
  })

  it('is the whole duration when there are no keyframes', () => {
    expect(longestKeyframeGap([], 7)).toBe(7)
  })
})

describe('bufferTargets (§10.4)', () => {
  it('keeps the limits it is built on', () => {
    expect(TOTAL_BYTES).toBe(120 * 1024 * 1024)
    expect(BEHIND_BYTES).toBe(16 * 1024 * 1024)
  })

  it('buffers about 6 seconds ahead and keeps about 1 behind for the proof file, 1 s keyframes', () => {
    const targets = bufferTargets(119_790_738 / 8, 1)
    expect(targets.aheadSeconds).toBeCloseTo(6.28, 2)
    expect(targets.behindSeconds).toBeCloseTo(1.12, 2)
  })

  it('buffers only the 2 seconds minimum ahead of the proof file when keyframes are 5.6 s apart', () => {
    expect(bufferTargets(119_790_738 / 8, 5.6).aheadSeconds).toBe(2)
  })

  it('leaves room for a 5 s keyframe gap on the local test file', () => {
    const targets = bufferTargets(185_877_994 / 40, 5)
    expect(targets.aheadSeconds).toBeCloseTo(18.47, 2)
    expect(targets.behindSeconds).toBeCloseTo(3.61, 2)
  })

  it('caps a slow file at 60 seconds ahead and 10 behind', () => {
    expect(bufferTargets(1_000_000, 1)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
  })

  it('buffers at least 2 seconds ahead and keeps at least 1 behind, however fast the file', () => {
    expect(bufferTargets(100_000_000, 1)).toEqual({ aheadSeconds: 2, behindSeconds: 1 })
  })

  it('falls back to the slow-file targets when the rate is 0 or less', () => {
    expect(bufferTargets(0, 1)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
    expect(bufferTargets(-5, 1)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
  })
})

import { describe, expect, it } from 'vitest'
import {
  AHEAD_BYTES,
  BEHIND_BYTES,
  aheadSeconds,
  bufferTargets,
  mimeOf,
  samplesPerSegment,
  type RangesShape,
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

describe('bufferTargets (§10.4)', () => {
  it('keeps the limits it is built on', () => {
    expect(AHEAD_BYTES).toBe(100 * 1024 * 1024)
    expect(BEHIND_BYTES).toBe(16 * 1024 * 1024)
  })

  it('buffers about 7 seconds ahead and keeps about 1 behind for the proof file', () => {
    const targets = bufferTargets(119_790_738 / 8)
    expect(targets.aheadSeconds).toBeCloseTo(7.0, 1)
    expect(targets.behindSeconds).toBeCloseTo(1.12, 1)
  })

  it('caps a slow file at 60 seconds ahead and 10 behind', () => {
    expect(bufferTargets(1_000_000)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
  })

  it('buffers at least 4 seconds ahead and keeps at least 1 behind, however fast the file', () => {
    expect(bufferTargets(100_000_000)).toEqual({ aheadSeconds: 4, behindSeconds: 1 })
  })

  it('falls back to the slow-file targets when the rate is 0 or less', () => {
    expect(bufferTargets(0)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
    expect(bufferTargets(-5)).toEqual({ aheadSeconds: 60, behindSeconds: 10 })
  })
})

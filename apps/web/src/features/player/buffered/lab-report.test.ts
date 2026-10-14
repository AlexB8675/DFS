import { playbackReportSchema } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import type { BufferedStats } from './buffered-player'
import {
  buildLabReport,
  downloadMbit,
  markFirstFrame,
  markPlaying,
  markWaiting,
  newTrace,
  stallTotals,
  type LabReportInput,
} from './lab-report'

const VERSION_ID = '0b9b3e0e-7a0d-4b1e-9d3a-0f5b0d9c1a11'

function stats(overrides: Partial<BufferedStats> = {}): BufferedStats {
  return {
    phase: 'buffering',
    codecs: ['hvc1.2.4.L153.B0', 'mp4a.40.2'],
    supported: {
      'video/mp4; codecs="hvc1.2.4.L153.B0"': true,
      'audio/mp4; codecs="mp4a.40.2"': true,
    },
    bytesReceived: 15_000_000,
    readingMs: 1000,
    heldMs: 2500,
    aheadSeconds: 20,
    targetAheadSeconds: 40,
    keyframeGapSeconds: 5.6,
    quotaErrors: 0,
    reopens: 1,
    segments: 120,
    error: null,
    ...overrides,
  }
}

/** A trace of a play started at 1000 ms, with its first frame at 1400 and playing at 1500. */
function playedTrace() {
  const trace = newTrace()
  trace.startedAt = 1000
  markFirstFrame(trace, 1400)
  markPlaying(trace, 1500)
  return trace
}

function input(overrides: Partial<LabReportInput> = {}): LabReportInput {
  return {
    versionId: VERSION_ID,
    reason: 'button',
    stats: stats(),
    trace: playedTrace(),
    video: { playedSeconds: 12.34, durationSeconds: 60, frames: 700, droppedFrames: 3 },
    now: 5000,
    ...overrides,
  }
}

describe('downloadMbit', () => {
  it('is bits over reading time, in Mbit/s', () => {
    // 15 MB in a second is 120 Mbit/s.
    expect(downloadMbit({ bytesReceived: 15_000_000, readingMs: 1000 })).toBe(120)
  })

  it('is null before any reading time', () => {
    expect(downloadMbit({ bytesReceived: 0, readingMs: 0 })).toBeNull()
  })
})

describe('stalls', () => {
  it('counts a wait after the first frame, until the next playing', () => {
    const trace = playedTrace()
    markWaiting(trace, 2000, false)
    markWaiting(trace, 2100, false)
    expect(stallTotals(trace, 2300)).toEqual({ stalls: 1, stallMs: 300 })
    markPlaying(trace, 2500)
    markWaiting(trace, 3000, false)
    markPlaying(trace, 3200)
    expect(stallTotals(trace, 4000)).toEqual({ stalls: 2, stallMs: 700 })
  })

  it('ignores a wait before the first frame', () => {
    const trace = newTrace()
    trace.startedAt = 1000
    markWaiting(trace, 1100, false)
    markFirstFrame(trace, 1400)
    markPlaying(trace, 1500)
    expect(stallTotals(trace, 2000)).toEqual({ stalls: 0, stallMs: 0 })
  })

  it('ignores a wait while paused', () => {
    const trace = playedTrace()
    markWaiting(trace, 2000, true)
    expect(stallTotals(trace, 3000)).toEqual({ stalls: 0, stallMs: 0 })
  })

  it('keeps the first playing and the first frame', () => {
    const trace = playedTrace()
    markFirstFrame(trace, 9000)
    markPlaying(trace, 9500)
    expect(trace.firstFrameAt).toBe(1400)
    expect(trace.playingAt).toBe(1500)
  })
})

describe('buildLabReport', () => {
  it('reports a play that showed a frame', () => {
    const report = buildLabReport(input())
    expect(playbackReportSchema.parse(report)).toEqual(report)
    expect(report).toMatchObject({
      versionId: VERSION_ID,
      outcome: 'played',
      firstFrameMs: 400,
      startMs: 500,
      openMs: 4000,
      stalls: 0,
      stallMs: 0,
      seeks: 0,
      seekWaitMs: 0,
      frames: 700,
      droppedFrames: 3,
      arrivalBitsPerSecond: 120_000_000,
      decoding: null,
      problem: null,
      problemKind: null,
    })
  })

  it('counts a stall still going up to now', () => {
    const trace = playedTrace()
    markWaiting(trace, 4000, false)
    expect(buildLabReport(input({ trace })).stalls).toBe(1)
    expect(buildLabReport(input({ trace })).stallMs).toBe(1000)
  })

  it('reports a failure before any frame', () => {
    const trace = newTrace()
    trace.startedAt = 1000
    const report = buildLabReport(
      input({
        trace,
        stats: stats({ phase: 'failed', error: 'x'.repeat(400), bytesReceived: 0, readingMs: 0 }),
      }),
    )
    expect(playbackReportSchema.parse(report)).toEqual(report)
    expect(report).toMatchObject({
      outcome: 'failed',
      firstFrameMs: null,
      startMs: null,
      arrivalBitsPerSecond: null,
      problemKind: 'other',
    })
    expect(report.problem).toHaveLength(300)
  })

  it('reports leaving before any frame as left', () => {
    const trace = newTrace()
    trace.startedAt = 1000
    expect(buildLabReport(input({ trace })).outcome).toBe('left')
  })

  it('says why it was sent in the lab line, a page left inside the app among them', () => {
    for (const reason of ['button', 'auto', 'hidden', 'left'] as const) {
      const lab = JSON.parse(buildLabReport(input({ reason })).lab ?? '{}') as {
        sentReason: string
      }
      expect(lab.sentReason).toBe(reason)
    }
  })

  it('puts the trial’s numbers and why it was sent in the lab line', () => {
    const report = buildLabReport(input({ reason: 'auto' }))
    const lab = JSON.parse(report.lab ?? '{}') as Record<string, unknown>
    expect(lab).toMatchObject({
      player: 'buffered',
      sentReason: 'auto',
      phase: 'buffering',
      bytesReceived: 15_000_000,
      readingMs: 1000,
      heldMs: 2500,
      targetAheadSeconds: 40,
      keyframeGapSeconds: 5.6,
      quotaErrors: 0,
      reopens: 1,
      segments: 120,
      playedSeconds: 12.3,
      durationSeconds: 60,
    })
  })

  it('keeps the lab line within what the API takes', () => {
    const supported = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`video/mp4; codecs="long.codec.${index}"`, true]),
    )
    const report = buildLabReport(input({ stats: stats({ supported }) }))
    expect(report.lab).toHaveLength(2000)
    expect(playbackReportSchema.parse(report)).toEqual(report)
  })

  it('has a duration not known yet as null in the lab line', () => {
    const report = buildLabReport(
      input({
        video: { playedSeconds: 0, durationSeconds: Number.NaN, frames: 0, droppedFrames: 0 },
      }),
    )
    expect(
      (JSON.parse(report.lab ?? '{}') as { durationSeconds: unknown }).durationSeconds,
    ).toBeNull()
  })
})

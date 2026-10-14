import type { PlaybackReport } from '@dfs/shared'
import type { BufferedStats } from './buffered-player'

// What the buffered-play trial page counts and reports (DESIGN.md §10.4). The
// page has no say in how the regular player counts: these are the same numbers,
// worked out from the stats `playBuffered` gives and the video element's events,
// as plain functions so they can be tested without a browser.

/** What made a report go, kept in its `lab` line so the log tells them apart. */
export type SentReason = 'button' | 'auto' | 'hidden' | 'left'

/** When things happened to the video, in `performance.now()` milliseconds, and its stalls so far. */
export interface LabTrace {
  /** When Start was pressed; `null` before. */
  startedAt: number | null
  /** The first frame showing (`loadeddata`). */
  firstFrameAt: number | null
  /** The first `playing`: the first frame may come long before. */
  playingAt: number | null
  /** Stalls that have ended, and their time. */
  stalls: number
  stallMs: number
  /** Since when it waits now, after the first frame; `null` while it doesn't. */
  stallSince: number | null
}

export function newTrace(): LabTrace {
  return {
    startedAt: null,
    firstFrameAt: null,
    playingAt: null,
    stalls: 0,
    stallMs: 0,
    stallSince: null,
  }
}

export function markFirstFrame(trace: LabTrace, now: number): void {
  trace.firstFrameAt ??= now
}

/** A `playing` ends the stall the last `waiting` began. */
export function markPlaying(trace: LabTrace, now: number): void {
  trace.playingAt ??= now
  if (trace.stallSince === null) return
  trace.stalls += 1
  trace.stallMs += now - trace.stallSince
  trace.stallSince = null
}

/** Only a wait after the first frame, while playing, is a stall. */
export function markWaiting(trace: LabTrace, now: number, paused: boolean): void {
  if (trace.firstFrameAt !== null && !paused) trace.stallSince ??= now
}

/** The stalls and their time as of `now`, with one still going counted to its end. */
export function stallTotals(trace: LabTrace, now: number): { stalls: number; stallMs: number } {
  if (trace.stallSince === null) return { stalls: trace.stalls, stallMs: trace.stallMs }
  return { stalls: trace.stalls + 1, stallMs: trace.stallMs + (now - trace.stallSince) }
}

/** How fast the file came in while it was being read, in Mbit/s; `null` before any bytes. */
export function downloadMbit(
  stats: Pick<BufferedStats, 'bytesReceived' | 'readingMs'>,
): number | null {
  if (stats.readingMs <= 0) return null
  return (stats.bytesReceived * 8) / stats.readingMs / 1000
}

/** What the video element says, at the moment of a report. */
export interface VideoReading {
  playedSeconds: number
  /** `NaN` before the browser knows it. */
  durationSeconds: number
  frames: number
  droppedFrames: number
}

/** The video element’s numbers, as `VideoReading` has them. */
export function readVideo(video: HTMLVideoElement): VideoReading {
  const quality = video.getVideoPlaybackQuality()
  return {
    playedSeconds: video.currentTime,
    durationSeconds: video.duration,
    frames: quality.totalVideoFrames,
    droppedFrames: quality.droppedVideoFrames,
  }
}

/** What the page shows of the video, read twice a second: its numbers and its stalls. */
export interface VideoNumbers extends VideoReading {
  /** Buffered ahead of the playhead, read from the element: the stats stop when the stream ends. */
  aheadSeconds: number
  stalls: number
  stallMs: number
}

export const NO_NUMBERS: VideoNumbers = {
  playedSeconds: 0,
  durationSeconds: Number.NaN,
  frames: 0,
  droppedFrames: 0,
  aheadSeconds: 0,
  stalls: 0,
  stallMs: 0,
}

/** What the page shows until the play has said anything. */
export const OPENING_STATS: BufferedStats = {
  phase: 'opening',
  codecs: [],
  supported: {},
  bytesReceived: 0,
  readingMs: 0,
  heldMs: 0,
  aheadSeconds: 0,
  targetAheadSeconds: 0,
  keyframeGapSeconds: 0,
  quotaErrors: 0,
  reopens: 0,
  segments: 0,
  error: null,
}

export interface LabReportInput {
  versionId: string
  reason: SentReason
  stats: BufferedStats
  trace: LabTrace
  video: VideoReading
  now: number
}

/** The most a report's `lab` line holds. */
const MAX_LAB_CHARS = 2000

/** The most a report's `problem` holds. */
const MAX_PROBLEM_CHARS = 300

/** A time in the report: whole milliseconds, within what the API takes. */
function bounded(ms: number): number {
  return Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(ms)))
}

/** One decimal, for a line a person reads in a log. */
function tenths(value: number): number {
  return Math.round(value * 10) / 10
}

/** The report for the API (`POST …/playback-report`), with the trial's own numbers in `lab`. */
export function buildLabReport(input: LabReportInput): PlaybackReport {
  const { versionId, reason, stats, trace, video, now } = input
  const began = trace.startedAt ?? now
  const { stalls, stallMs } = stallTotals(trace, now)
  const rate = downloadMbit(stats)
  const failed = stats.phase === 'failed'
  const lab = JSON.stringify({
    player: 'buffered',
    sentReason: reason,
    phase: stats.phase,
    codecs: stats.codecs,
    supported: stats.supported,
    bytesReceived: stats.bytesReceived,
    readingMs: Math.round(stats.readingMs),
    heldMs: Math.round(stats.heldMs),
    targetAheadSeconds: tenths(stats.targetAheadSeconds),
    keyframeGapSeconds: tenths(stats.keyframeGapSeconds),
    quotaErrors: stats.quotaErrors,
    reopens: stats.reopens,
    segments: stats.segments,
    playedSeconds: tenths(video.playedSeconds),
    durationSeconds: tenths(video.durationSeconds),
  }).slice(0, MAX_LAB_CHARS)
  return {
    versionId,
    outcome: trace.firstFrameAt !== null ? 'played' : failed ? 'failed' : 'left',
    firstFrameMs: trace.firstFrameAt === null ? null : bounded(trace.firstFrameAt - began),
    startMs: trace.playingAt === null ? null : bounded(trace.playingAt - began),
    openMs: bounded(now - began),
    stalls,
    stallMs: bounded(stallMs),
    seeks: 0,
    seekWaitMs: 0,
    frames: video.frames,
    droppedFrames: video.droppedFrames,
    arrivalBitsPerSecond: rate === null ? null : Math.round(rate * 1e6),
    decoding: null,
    problem: stats.error?.slice(0, MAX_PROBLEM_CHARS) ?? null,
    problemKind: failed ? 'other' : null,
    lab,
  }
}

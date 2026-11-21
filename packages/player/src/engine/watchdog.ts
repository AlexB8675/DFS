// The watchdog (DESIGN.md §10.4): it reads samples of the video element and says
// how to unstick a play that froze. It only decides; applying an action and
// logging it belong to the engine. It uses no DOM type and no timer: the clock is
// injected and the samples carry the element's state.

import { GAP_EDGE_SECONDS, GAP_STEP_SECONDS, REOPENS_MAX, STUCK_MS } from '../limits.ts'

/** What the engine reads from the video element each WATCH_EVERY_MS. */
export interface WatchSample {
  /** The element's clock, `currentTime`, in seconds. */
  at: number
  /** Frames shown so far, from `getVideoPlaybackQuality()`. */
  frames: number
  readyState: number
  paused: boolean
  seeking: boolean
  ended: boolean
  /** The element's buffered ranges, in seconds. */
  buffered: [number, number][]
  /** True while the hold rule is holding the play. */
  holding: boolean
}

export type WatchAction =
  | { action: 'gap'; to: number }
  | { action: 'refeed' }
  | { action: 'reopen' }
  | { action: 'stuck'; detail: string }

/** One decimal, for a sentence. */
function seconds(value: number): string {
  return value.toFixed(1)
}

/**
 * A play is stuck when its clock and its frames have both stood for STUCK_MS, or
 * (with the longest frame known) when its clock has moved more than a frame plus
 * STUCK_MS of media with no new frame. Frames moving while the clock stands is a
 * decoder catching up. Once stuck, one rung of the ladder is given each STUCK_MS:
 * a step over a small gap, a refeed, a reopen (data at the playhead, at most
 * REOPENS_MAX per play), then `stuck`. When the play moves, the ladder starts
 * again; the reopens used are never given back.
 */
export class Watchdog {
  private readonly now: () => number
  private readonly maxFrameSeconds: number | null
  private reopens = 0

  private lastSampleAt: number | null = null
  private clock = 0
  private clockSince = 0
  private frames = 0
  private framesSince = 0
  /** The clock when the frame count last changed. */
  private frameClock = 0

  private gapTried = false
  private refed = false
  private lastStepAt: number | null = null

  constructor(now: () => number, maxFrameSeconds: number | null) {
    this.now = now
    this.maxFrameSeconds = maxFrameSeconds
  }

  observe(sample: WatchSample): WatchAction | null {
    const t = this.now()
    const playing = !sample.paused && !sample.seeking && !sample.holding && !sample.ended
    const slept = this.lastSampleAt !== null && t - this.lastSampleAt > STUCK_MS * 2
    const first = this.lastSampleAt === null
    this.lastSampleAt = t

    if (!playing || slept || first) {
      this.restart(sample, t)
      return null
    }

    if (sample.at !== this.clock) {
      this.clock = sample.at
      this.clockSince = t
    }
    if (sample.frames !== this.frames) {
      this.frames = sample.frames
      this.framesSince = t
      this.frameClock = sample.at
    }

    const clockFrozen = t - this.clockSince >= STUCK_MS && t - this.framesSince >= STUCK_MS
    const pictureFrozen =
      this.maxFrameSeconds !== null &&
      sample.at - this.frameClock > this.maxFrameSeconds + STUCK_MS / 1000
    if (!clockFrozen && !pictureFrozen) {
      this.gapTried = false
      this.refed = false
      this.lastStepAt = null
      return null
    }

    if (this.lastStepAt !== null && t - this.lastStepAt < STUCK_MS) return null
    this.lastStepAt = t

    const next = this.nextRung(sample)
    if (next !== null) return next
    const what = clockFrozen
      ? `The clock and the picture stood still at ${seconds(sample.at)} s for ${seconds((t - this.clockSince) / 1000)} s`
      : `The picture stood still for ${seconds(sample.at - this.frameClock)} s of the video while the clock moved, up to ${seconds(sample.at)} s`
    return {
      action: 'stuck',
      detail: `${what}, after ${this.reopens} reopens of the decoder.`,
    }
  }

  /** The next rung of the ladder, or null when the ladder is spent. */
  private nextRung(sample: WatchSample): WatchAction | null {
    if (!this.gapTried) {
      this.gapTried = true
      const to = gapTarget(sample)
      if (to !== null) return { action: 'gap', to }
    }
    if (!holdsData(sample) || !this.refed) {
      this.refed = holdsData(sample)
      return { action: 'refeed' }
    }
    if (this.reopens < REOPENS_MAX) {
      this.reopens += 1
      return { action: 'reopen' }
    }
    return null
  }

  /** Starts counting afresh from this sample: the play is not playing, or slept. */
  private restart(sample: WatchSample, t: number): void {
    this.clock = sample.at
    this.clockSince = t
    this.frames = sample.frames
    this.framesSince = t
    this.frameClock = sample.at
    this.gapTried = false
    this.refed = false
    this.lastStepAt = null
  }
}

/** True when a buffered range holds the playhead with data after it. */
function holdsData(sample: WatchSample): boolean {
  return sample.buffered.some(([start, end]) => start <= sample.at && sample.at < end)
}

/**
 * Where to step to when the playhead sits at a range's end, or in no range, and
 * the next range starts within GAP_STEP_SECONDS after it; else null.
 */
function gapTarget(sample: WatchSample): number | null {
  const { at, buffered } = sample
  const inside = buffered.find(([start, end]) => start <= at && at <= end)
  if (inside !== undefined && inside[1] - at > GAP_EDGE_SECONDS) return null
  const from = inside === undefined ? at : inside[1]
  let next: number | null = null
  for (const [start] of buffered) {
    if (start > at && start >= from && (next === null || start < next)) next = start
  }
  return next !== null && next - from <= GAP_STEP_SECONDS ? next : null
}

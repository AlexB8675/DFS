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
  /** True while the element seeks, or when a seek began since the previous sample (the engine sets it). */
  seeking: boolean
  /** True once after a seek of the viewer's (not the engine's own): the watchdog gives the play a new ladder (F1). */
  seeked: boolean
  ended: boolean
  /** The element's buffered ranges, in seconds. */
  buffered: [number, number][]
  /** True while the hold rule is holding the play. */
  holding: boolean
  /** The page's `document.hidden`: a hidden tab's picture stops while its sound plays on. */
  hidden: boolean
  /** True while a feed is under way, so possibly waiting for bytes (the engine skips a refeed then, R39). */
  feeding: boolean
  /** Where each playing track's buffer ends at or before the playhead, in seconds; null when it has none there. */
  trackEnds: { name: string; end: number | null }[]
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
 * REOPENS_MAX per play), then `stuck`. A refeed that ends with no data at the
 * playhead, while no feed waits for bytes, is futile (a track that ends or has a
 * hole there): the next rung is `stuck`, naming that track (A1). When the play moves, the ladder starts
 * again, and so does a seek of the viewer's (F1); the reopens used are never given back.
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

  /** `now` must be monotonic, as `performance.now`. */
  constructor(now: () => number, maxFrameSeconds: number | null) {
    this.now = now
    this.maxFrameSeconds = maxFrameSeconds
  }

  observe(sample: WatchSample): WatchAction | null {
    const t = this.now()
    if (sample.seeked) {
      this.gapTried = false
      this.refed = false
      this.lastStepAt = null
    }
    const playing = !sample.paused && !sample.seeking && !sample.holding && !sample.ended
    const last = this.lastSampleAt
    const first = last === null
    // A sleep, or a clock that went back, or a clock jumped back by a seek
    // missed between samples: the count starts afresh.
    const discontinuity = !first && (t < last || t - last > STUCK_MS * 2 || sample.at < this.clock)
    this.lastSampleAt = t

    if (!playing || first || discontinuity) {
      this.restart(sample, t)
      return null
    }

    const pictureRuleOn = this.maxFrameSeconds !== null && !sample.hidden
    let moved = false
    if (sample.at !== this.clock) {
      moved = !pictureRuleOn
      this.clock = sample.at
      this.clockSince = t
    }
    if (sample.frames !== this.frames) {
      // A lower count is a new element (a reopen): a new baseline, not movement.
      moved = moved || sample.frames > this.frames
      this.frames = sample.frames
      this.framesSince = t
      this.frameClock = sample.at
    }
    if (sample.hidden) this.frameClock = sample.at

    if (moved) {
      this.gapTried = false
      this.refed = false
      this.lastStepAt = null
      return null
    }

    const clockFrozen = t - this.clockSince >= STUCK_MS && t - this.framesSince >= STUCK_MS
    const pictureFrozen =
      pictureRuleOn &&
      t - this.framesSince >= STUCK_MS &&
      sample.at - this.frameClock > this.maxFrameSeconds + STUCK_MS / 1000
    if (!clockFrozen && !pictureFrozen) return null

    if (this.lastStepAt !== null && t - this.lastStepAt < STUCK_MS) return null
    this.lastStepAt = t

    const next = this.nextRung(sample)
    if (next !== null) return next
    if (!holdsData(sample)) return { action: 'stuck', detail: endedDetail(sample) }
    const what = clockFrozen
      ? `The clock and the picture stood still at ${seconds(sample.at)} s for ${seconds((t - this.clockSince) / 1000)} s`
      : `The picture stood still for ${seconds(sample.at - this.frameClock)} s of the video while the clock moved, up to ${seconds(sample.at)} s`
    return {
      action: 'stuck',
      detail: `${what}, with the element at ready state ${sample.readyState}, after ${this.reopens} reopens of the decoder.`,
    }
  }

  /** The next rung of the ladder, or null when the ladder is spent. */
  private nextRung(sample: WatchSample): WatchAction | null {
    if (!this.gapTried) {
      const to = gapTarget(sample)
      if (to !== null) {
        this.gapTried = true
        this.refed = false
        return { action: 'gap', to }
      }
    }
    if (!holdsData(sample)) {
      // A feed that waits for bytes has no data yet: the engine skips the refeed, and the wait is not futile.
      if (sample.feeding) return { action: 'refeed' }
      // One refeed has been tried and there is still none: no further refeed can help.
      if (this.refed) return null
      this.refed = true
      return { action: 'refeed' }
    }
    if (!this.refed) {
      this.refed = true
      return { action: 'refeed' }
    }
    if (this.reopens < REOPENS_MAX) {
      this.reopens += 1
      return { action: 'reopen' }
    }
    return null
  }

  /**
   * Starts counting the clocks afresh from this sample: the play is not playing,
   * or slept, or jumped. The ladder stays where it is: the engine's own actions
   * make such samples, and only a play that moves goes back to the first rung.
   */
  private restart(sample: WatchSample, t: number): void {
    this.clock = sample.at
    this.clockSince = t
    this.frames = sample.frames
    this.framesSince = t
    this.frameClock = sample.at
    this.lastStepAt = null
  }
}

/** The sentence of a play whose buffers hold no data at the playhead after a refeed: it names the track whose buffer ends there. */
function endedDetail(sample: WatchSample): string {
  const ended = sample.trackEnds
    .filter(({ end }) => end === null || end <= sample.at + GAP_EDGE_SECONDS)
    .sort((a, b) => (a.end ?? -Infinity) - (b.end ?? -Infinity))[0]
  const where =
    ended === undefined
      ? 'No track has data at the playhead'
      : ended.end === null
        ? `The ${ended.name} has no data at the playhead`
        : `The ${ended.name}'s buffer ends at ${seconds(ended.end)} s`
  return `${where}, the clock stood still at ${seconds(sample.at)} s, and a refeed did not bring more, with the element at ready state ${sample.readyState}.`
}

/** True when a buffered range holds the playhead with more than GAP_EDGE_SECONDS of data after it. */
function holdsData(sample: WatchSample): boolean {
  return sample.buffered.some(
    ([start, end]) => start <= sample.at && end - sample.at > GAP_EDGE_SECONDS,
  )
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

// The hold rule (DESIGN.md §10.4): when a play may start, or start again after a
// seek or a stall, and when the slow-video warning shows. It measures what the
// store holds, never the decoder window, so a window shrunk by quota errors can't
// hold a play forever. The old engine's `bufferingGoal` is its model. It uses no
// DOM type and no timer.

import { CHUNK_BYTES, START_GOAL_SECONDS, STALL_GOAL_SECONDS } from '../limits.ts'

/** A link at this multiple of the bit rate keeps up, with room to spare. */
const KEEPS_UP = 1.1

/** The share of the store's cap a hold may ask for, so the store keeps room to take more. */
const CAP_SHARE = 0.9

/** Why a play waits: a first start, a seek, or a stall during the play. */
export type HoldReason = 'start' | 'seek' | 'stall'

export interface HoldInput {
  reason: HoldReason
  /** Seconds of the video the store holds from the playhead to the first byte it doesn't hold. */
  heldAheadSeconds: number
  /** The downloader's measured rate, or null before one is known. */
  rateBytesPerSecond: number | null
  bitrateBytesPerSecond: number
  /** Seconds from the playhead to the end of the video. */
  remainingSeconds: number
  /** What the store can hold ahead of the playhead, in seconds of the video. The engine works it out. */
  storeAheadCapSeconds: number
  /** True when the downloader's state is `full`: the store can hold no more ahead, whatever the cap arithmetic says (�10.4). */
  storeFull: boolean
}

export interface HoldDecision {
  /** True while the play should wait. */
  hold: boolean
  /** Seconds the store should hold ahead before the play goes; 0 means as soon as anything is held. */
  goalSeconds: number
  /** True for a known rate under the bit rate: the slow-video warning. */
  slow: boolean
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** Whether a link is slower than the video: a known rate under the bit rate. A rate of 0 is the downloader gone quiet, and a bit rate that can't be compared makes the rate unknown, so neither is slow. */
export function isSlow(rate: number | null, bitrate: number): boolean {
  const bitrateOk = Number.isFinite(bitrate) && bitrate > 0
  return bitrateOk && rate !== null && Number.isFinite(rate) && rate > 0 && rate < bitrate
}

/**
 * A start or a seek on a link that keeps up plays at the first frames; on an
 * unknown link it holds for the start goal. A stall holds for the stall goal. On
 * a link slower than the video the goal is what the rest of the video will take
 * from it, as far as the store allows.
 */
export function holdDecision(input: HoldInput): HoldDecision {
  const { reason, heldAheadSeconds, bitrateBytesPerSecond } = input
  const remaining = input.remainingSeconds
  const cap = Math.max(0, input.storeAheadCapSeconds)
  // A rate of 0 is the downloader gone quiet (a full store, a finished file), not a slow link; a
  // bit rate that can't be compared makes the rate unknown too.
  const rate = input.rateBytesPerSecond
  const bitrateOk = Number.isFinite(bitrateBytesPerSecond) && bitrateBytesPerSecond > 0
  const known = bitrateOk && rate !== null && Number.isFinite(rate) && rate > 0
  const fast = known && rate >= bitrateBytesPerSecond * KEEPS_UP
  const slow = isSlow(rate, bitrateBytesPerSecond)
  const floor = reason === 'stall' ? STALL_GOAL_SECONDS : START_GOAL_SECONDS

  // At the end there is nothing to wait for.
  if (!(remaining > 0)) return { hold: false, goalSeconds: 0, slow }

  let goalSeconds: number
  if (fast && reason !== 'stall') {
    // The first frames are enough; a full store has none to give, and the play goes on.
    return { hold: !input.storeFull && heldAheadSeconds <= 0, goalSeconds: 0, slow }
  } else if (!slow) {
    goalSeconds = Math.min(floor, remaining, cap)
    // Between the bit rate and its multiple the floor applies, with the cap's share.
    if (known && !fast) goalSeconds = Math.min(remaining, clamp(0, floor, cap * CAP_SHARE))
  } else {
    const needed = remaining * (1 - (rate ?? 0) / bitrateBytesPerSecond)
    // The feeder takes whole reads of CHUNK_BYTES, so the read in progress is store-ahead it cannot use yet: one read's margin keeps the release off the exact break-even point.
    const margin = CHUNK_BYTES / bitrateBytesPerSecond
    goalSeconds = Math.min(remaining, clamp(needed + margin, floor, cap * CAP_SHARE))
  }
  goalSeconds = Math.max(0, goalSeconds)
  return { hold: !input.storeFull && heldAheadSeconds < goalSeconds, goalSeconds, slow }
}

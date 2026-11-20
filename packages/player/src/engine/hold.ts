// The hold rule (DESIGN.md §10.4): when a play may start, or start again after a
// seek or a stall, and when the slow-video warning shows. It measures what the
// store holds, never the decoder window, so a window shrunk by quota errors can't
// hold a play forever. The old engine's `bufferingGoal` is its model. It uses no
// DOM type and no timer.

import { START_GOAL_SECONDS, STALL_GOAL_SECONDS } from '../limits.ts'

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
  /** The store's cap in seconds of the video (its cap in bytes over the bit rate). */
  storeCapSeconds: number
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

/**
 * A start or a seek on a link that keeps up plays at the first frames; on an
 * unknown link it holds for the start goal. A stall holds for the stall goal. On
 * a link slower than the video the goal is what the rest of the video will take
 * from it, as far as the store allows.
 */
export function holdDecision(input: HoldInput): HoldDecision {
  const { reason, heldAheadSeconds, rateBytesPerSecond, bitrateBytesPerSecond } = input
  const remaining = Math.max(0, input.remainingSeconds)
  const cap = Math.max(0, input.storeCapSeconds)
  const known = rateBytesPerSecond !== null
  const fast = known && rateBytesPerSecond >= bitrateBytesPerSecond * KEEPS_UP
  const slow = known && rateBytesPerSecond < bitrateBytesPerSecond
  const floor = reason === 'stall' ? STALL_GOAL_SECONDS : START_GOAL_SECONDS

  let goalSeconds: number
  if (fast && reason !== 'stall') {
    return { hold: heldAheadSeconds <= 0, goalSeconds: 0, slow }
  } else if (fast || !known) {
    goalSeconds = Math.min(floor, remaining, cap)
  } else {
    // Between the bit rate and its multiple `needed` is 0 or less, so the floor applies.
    const needed = remaining * (1 - rateBytesPerSecond / bitrateBytesPerSecond)
    goalSeconds = Math.min(remaining, clamp(needed, floor, cap * CAP_SHARE))
  }
  goalSeconds = Math.max(0, goalSeconds)
  return { hold: heldAheadSeconds < goalSeconds, goalSeconds, slow }
}

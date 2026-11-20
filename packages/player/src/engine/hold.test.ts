import { describe, expect, it } from 'vitest'
import { START_GOAL_SECONDS, STALL_GOAL_SECONDS } from '../limits.ts'
import { holdDecision } from './hold.ts'
import type { HoldInput } from './hold.ts'

// The hold rule (DESIGN.md §10.4): when a play may start, or start again after a
// seek or a stall, measured on what the store holds.

const BITRATE = 1_000_000

function input(over: Partial<HoldInput>): HoldInput {
  return {
    reason: 'start',
    heldAheadSeconds: 0,
    rateBytesPerSecond: null,
    bitrateBytesPerSecond: BITRATE,
    remainingSeconds: 600,
    storeCapSeconds: 100,
    ...over,
  }
}

describe('holdDecision', () => {
  it('plays at once at a start on a link that keeps up, once anything is held', () => {
    const rate = BITRATE * 1.1
    expect(holdDecision(input({ rateBytesPerSecond: rate, heldAheadSeconds: 0 }))).toEqual({
      hold: true,
      goalSeconds: 0,
      slow: false,
    })
    expect(holdDecision(input({ rateBytesPerSecond: rate, heldAheadSeconds: 0.04 }))).toEqual({
      hold: false,
      goalSeconds: 0,
      slow: false,
    })
  })

  it('treats a seek like a start', () => {
    const d = holdDecision(
      input({ reason: 'seek', rateBytesPerSecond: BITRATE * 5, heldAheadSeconds: 0.1 }),
    )
    expect(d).toEqual({ hold: false, goalSeconds: 0, slow: false })
  })

  it('holds for the start goal when the rate is unknown', () => {
    const held = holdDecision(input({ heldAheadSeconds: START_GOAL_SECONDS - 0.5 }))
    expect(held).toEqual({ hold: true, goalSeconds: START_GOAL_SECONDS, slow: false })
    expect(holdDecision(input({ heldAheadSeconds: START_GOAL_SECONDS })).hold).toBe(false)
  })

  it('holds longer on a slow link and says so', () => {
    const d = holdDecision(input({ rateBytesPerSecond: BITRATE * 0.75, remainingSeconds: 60 }))
    expect(d.slow).toBe(true)
    expect(d.hold).toBe(true)
    expect(d.goalSeconds).toBeCloseTo(15)
    expect(d.goalSeconds).toBeGreaterThan(START_GOAL_SECONDS)
  })

  it('scales the goal by what the rest of the video takes, capped by 0.9 of the store', () => {
    const half = { rateBytesPerSecond: BITRATE / 2, remainingSeconds: 60, storeCapSeconds: 100 }
    expect(holdDecision(input(half)).goalSeconds).toBeCloseTo(30)
    expect(holdDecision(input({ ...half, storeCapSeconds: 20 })).goalSeconds).toBeCloseTo(18)
    expect(holdDecision(input({ ...half, reason: 'stall' })).goalSeconds).toBeCloseTo(30)
  })

  it('applies the floor when the need is under it', () => {
    const slowStart = holdDecision(
      input({ rateBytesPerSecond: BITRATE * 0.9, remainingSeconds: 10 }),
    )
    expect(slowStart.goalSeconds).toBe(START_GOAL_SECONDS)
    expect(slowStart.slow).toBe(true)
    const slowStall = holdDecision(
      input({ reason: 'stall', rateBytesPerSecond: BITRATE * 0.9, remainingSeconds: 10 }),
    )
    expect(slowStall.goalSeconds).toBe(STALL_GOAL_SECONDS)
  })

  it('holds a stall on a fast link, or an unknown one, for the stall goal', () => {
    const fast = holdDecision(input({ reason: 'stall', rateBytesPerSecond: BITRATE * 3 }))
    expect(fast).toEqual({ hold: true, goalSeconds: STALL_GOAL_SECONDS, slow: false })
    const unknown = holdDecision(input({ reason: 'stall', heldAheadSeconds: 4 }))
    expect(unknown).toEqual({ hold: false, goalSeconds: STALL_GOAL_SECONDS, slow: false })
  })

  it('caps the goal by what remains of the video', () => {
    expect(holdDecision(input({ remainingSeconds: 1 })).goalSeconds).toBe(1)
    expect(holdDecision(input({ reason: 'stall', remainingSeconds: 3 })).goalSeconds).toBe(3)
    expect(
      holdDecision(input({ rateBytesPerSecond: BITRATE / 2, remainingSeconds: 1.5 })).goalSeconds,
    ).toBe(1.5)
    const end = holdDecision(input({ remainingSeconds: 0 }))
    expect(end).toEqual({ hold: false, goalSeconds: 0, slow: false })
  })

  it('never asks for more than the store allows', () => {
    expect(holdDecision(input({ storeCapSeconds: 1 })).goalSeconds).toBe(1)
    expect(holdDecision(input({ reason: 'stall', storeCapSeconds: 2.5 })).goalSeconds).toBe(2.5)
    const slow = holdDecision(input({ rateBytesPerSecond: 1, storeCapSeconds: 1 }))
    expect(slow.goalSeconds).toBeCloseTo(0.9)
    expect(holdDecision(input({ storeCapSeconds: 0 })).goalSeconds).toBe(0)
  })

  it('is not slow, and not fast, between the bit rate and 1.1 times it', () => {
    const d = holdDecision(input({ rateBytesPerSecond: BITRATE * 1.05, heldAheadSeconds: 0.5 }))
    expect(d.slow).toBe(false)
    expect(d.goalSeconds).toBe(START_GOAL_SECONDS)
    expect(d.hold).toBe(true)
  })

  it('is slow only for a known rate under the bit rate', () => {
    expect(holdDecision(input({ rateBytesPerSecond: null })).slow).toBe(false)
    expect(holdDecision(input({ rateBytesPerSecond: BITRATE })).slow).toBe(false)
    expect(holdDecision(input({ rateBytesPerSecond: BITRATE - 1 })).slow).toBe(true)
  })
})

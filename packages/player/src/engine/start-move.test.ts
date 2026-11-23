import { describe, expect, it } from 'vitest'
import { commonStartMoves, startStaysPending, windowStartMoves } from './start-move.ts'

// The clock's move at a common start or a window start (DESIGN.md §10.4): forward only, so a playing
// element that has played on from the target while the feed went on is not pulled back to it.

describe('commonStartMoves', () => {
  it('leaves a clock that has played on past the start where it is', () => {
    expect(commonStartMoves(44.06, 43.52, false)).toBe(false)
  })

  it('moves a clock behind the start (a track that begins late, or 0 after a reopen)', () => {
    expect(commonStartMoves(0.35, 0.48, false)).toBe(true)
    expect(commonStartMoves(0, 12, false)).toBe(true)
  })

  it('leaves a clock exactly at the start, within 1e-6', () => {
    expect(commonStartMoves(5, 5, false)).toBe(false)
    expect(commonStartMoves(5 - 5e-7, 5, false)).toBe(false)
  })

  it('moves a target past the end to the start from either side', () => {
    expect(commonStartMoves(3, 9, true)).toBe(true)
    expect(commonStartMoves(12, 9, true)).toBe(true)
    expect(commonStartMoves(9, 9, true)).toBe(false)
  })
})

describe('windowStartMoves', () => {
  it('moves only a clock behind the start', () => {
    expect(windowStartMoves(0.35, 0.48)).toBe(true)
    expect(windowStartMoves(0.9, 0.48)).toBe(false)
    expect(windowStartMoves(0.48, 0.48)).toBe(false)
  })
})

describe('startStaysPending', () => {
  it('is pending only when a move was made and the clock is still not at the start (the sink deferred it)', () => {
    expect(startStaysPending(true, 3, 9)).toBe(true)
  })

  it('is cleared when the move landed', () => {
    expect(startStaysPending(true, 9, 9)).toBe(false)
  })

  it('is cleared when no move was made, whether the clock is at the start or has played on past it', () => {
    expect(startStaysPending(false, 9, 9)).toBe(false)
    expect(startStaysPending(false, 9.5, 9)).toBe(false)
  })
})

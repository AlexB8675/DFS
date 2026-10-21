import { describe, expect, it } from 'vitest'
import { seekBarTime } from './seek-position'
import type { MediaState } from './use-media-state'

function stateAt(currentTime: number): MediaState {
  return {
    paused: false,
    ended: false,
    waiting: false,
    currentTime,
    duration: 600,
    buffered: [],
    volume: 1,
    muted: false,
    rate: 1,
    pictureInPicture: false,
  }
}

describe('seekBarTime', () => {
  it('shows where the bar is dragged while dragging, whatever the video says', () => {
    const state = stateAt(10)
    expect(seekBarTime({ time: 300, letGoAt: null }, state)).toBe(300)
    // The video's time moving on under the thumb changes nothing.
    expect(seekBarTime({ time: 300, letGoAt: null }, stateAt(11))).toBe(300)
  })

  it("shows where it was let go until the video's state changes, then the video's time", () => {
    const old = stateAt(10)
    const drag = { time: 300, letGoAt: old }
    // Rendered again before the element has said anything: still the snapshot it was let go at.
    expect(seekBarTime(drag, old)).toBe(300)
    // The element's next event gives a new snapshot, which says where it is now.
    expect(seekBarTime(drag, stateAt(300))).toBe(300)
    expect(seekBarTime(drag, stateAt(298))).toBe(298)
    // Even one that says the same time as before it was let go: it is the video's say.
    expect(seekBarTime(drag, stateAt(10))).toBe(10)
  })

  it("shows the video's time with no drag", () => {
    expect(seekBarTime(null, stateAt(42))).toBe(42)
  })
})

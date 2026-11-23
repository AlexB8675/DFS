// The clock's move at a start (DESIGN.md §10.4). A seek outside the window is served while a playing element
// plays on by itself from the first fragments appended, so by the time the start is applied the clock may be
// past the start: that is the play's own progress, and the clock only ever goes forward there.

const EPSILON = 1e-6

/** Whether the common start puts the clock at `start`: when it is behind it; a target past the end (`past`) goes to the last frames from either side. */
export function commonStartMoves(clock: number, start: number, past: boolean): boolean {
  return past ? Math.abs(clock - start) > EPSILON : clock < start - EPSILON
}

/** Whether the start of a seek within the window puts the clock at `start`: only when it is behind it. */
export function windowStartMoves(clock: number, start: number): boolean {
  return clock < start - EPSILON
}

/** Whether the playhead is still the target after a start: only a move that the sink deferred (the clock is not at `start` yet) waits for it; anything else leaves no stale target for the window to read. */
export function startStaysPending(moved: boolean, clock: number, start: number): boolean {
  return moved && Math.abs(clock - start) > EPSILON
}

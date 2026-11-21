// The no-silent-freeze check of the plays suite (DESIGN.md §10.4): a `waiting` of the element that lasts
// longer than the stuck time must have a `watchdog` event of the engine's between its start and its end, so
// that the play's timeline says what the engine did about it. A wait that a hold explains is the engine's own
// pause, and is excused for the time the hold covers. A seek's own wait is excused too (R41): from the `seek`
// event that has no time yet (`ms` null) until its picture, and no longer than `SEEK_DEADLINE_MS`; past the
// deadline the engine sends an `error`, which tells the wait as a `watchdog` event does. A hold is not used to
// label a seek's wait, as that would falsify the hold numbers. Pure, so that it is pinned in Node.

import type { TimelineEventInput } from '@dfs/shared'
import { SEEK_DEADLINE_MS } from '../limits.ts'

/** A stretch of the element's `waiting`, in milliseconds of the play's own clock; `to` is null while it lasts. */
export interface WaitSpan {
  from: number
  to: number | null
}

/** An event of the engine and when it was seen, on the same clock. */
export interface Stamped {
  at: number
  event: TimelineEventInput
}

/** The stretches of the play that the engine held, from its `hold` events; one still on at `end` ends there. */
function holdSpans(events: readonly Stamped[], end: number): [number, number][] {
  const spans: [number, number][] = []
  let from: number | null = null
  for (const { at, event } of events) {
    if (event.type !== 'hold') continue
    if (event.on) {
      from ??= at
    } else if (from !== null) {
      spans.push([from, at])
      from = null
    }
  }
  if (from !== null) spans.push([from, end])
  return spans
}

/** The stretches of the play in which a seek waited for its picture: from its start to its picture, to the deadline at the latest, and to `end` at the latest. */
function seekSpans(
  events: readonly Stamped[],
  end: number,
  deadlineMs: number,
): [number, number][] {
  const spans: [number, number][] = []
  for (const [i, { at, event }] of events.entries()) {
    if (event.type !== 'seek' || event.ms !== null) continue
    const picture = events
      .slice(i + 1)
      .find((later) => later.event.type === 'seek' && later.event.ms !== null)
    spans.push([at, Math.min(picture?.at ?? end, at + deadlineMs, end)])
  }
  return spans
}

/** The time of `wait` that no span covers: the spans may overlap, and are counted once. */
function uncoveredMs(from: number, to: number, spans: readonly [number, number][]): number {
  const inside = spans
    .map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let reach = from
  for (const [a, b] of inside) {
    const start = Math.max(a, reach)
    if (b > start) covered += b - start
    reach = Math.max(reach, b)
  }
  return to - from - covered
}

/**
 * The waits that lasted longer than `stuckMs` (the time covered by neither a hold nor a seek's own wait) with
 * no `watchdog` or `error` event between their start and their end, both included. A wait still open (`to`
 * null) ends at `end`, the play's end. The result is those waits, as given.
 */
export function silentFreezes(
  waits: readonly WaitSpan[],
  events: readonly Stamped[],
  end: number,
  stuckMs: number,
  seekDeadlineMs: number = SEEK_DEADLINE_MS,
): WaitSpan[] {
  const covers = [...holdSpans(events, end), ...seekSpans(events, end, seekDeadlineMs)]
  const told = events
    .filter(({ event }) => event.type === 'watchdog' || event.type === 'error')
    .map(({ at }) => at)
  return waits.filter((wait) => {
    const to = wait.to ?? end
    if (uncoveredMs(wait.from, to, covers) <= stuckMs) return false
    return !told.some((at) => at >= wait.from && at <= to)
  })
}

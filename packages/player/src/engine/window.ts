// The decoder window (DESIGN.md §10.4; the iron-clad spec §4.8): the bookkeeping
// that keeps the browser's Media Source buffer small, in bytes and in seconds. It
// is told what was appended and what was removed, and says when to feed and what
// to cut. It uses no DOM type and no timer: the engine reads the sink's buffered
// ranges and gives them to `sync`, so a silent eviction by the browser is seen.
//
// Times are seconds on the playback timeline (after the SourceBuffer's timestamp
// offset), as the sink reports them. The cap is in bytes, across both tracks, and
// it gives way to the time ahead (R14): the played time kept behind is the first
// thing cut when the window is full, and a track is always fed until it has
// `WINDOW_MIN_AHEAD_SECONDS` ahead, so the cap never starves the playhead.

import {
  FEED_STEP_SECONDS,
  GAP_STEP_SECONDS,
  QUOTA_SHRINK,
  WINDOW_AHEAD_SECONDS,
  WINDOW_BEHIND_SECONDS,
  WINDOW_BYTES,
  WINDOW_FLOOR_BYTES,
  WINDOW_MIN_AHEAD_SECONDS,
} from '../limits.ts'

/** What the window is told of a fragment appended. */
export interface FedRun {
  kind: 'video' | 'audio'
  /** Seconds on the playback timeline. */
  start: number
  end: number
  bytes: number
  /** A picture's run that starts at a keyframe. Every sound run counts as one. */
  keyframe: boolean
}

/** Two times closer than this, in seconds, are the same: the rounding of the timescale is not a gap, and a sliver this short is nothing. */
const JOIN_SECONDS = 0.001

/**
 * The part of `run` from `start` to `end`, with its bytes prorated, or null when
 * it is no longer than rounding. A part that does not begin where the run does is
 * not a keyframe of a picture, as the frames before it are gone; a sound's is.
 */
function part(run: FedRun, start: number, end: number): FedRun | null {
  if (end - start <= JOIN_SECONDS) return null
  const whole = run.end - run.start
  const kept = start - run.start <= JOIN_SECONDS && run.end - end <= JOIN_SECONDS
  if (kept) return run
  return {
    ...run,
    start,
    end,
    bytes: whole > 0 ? (run.bytes * (end - start)) / whole : 0,
    keyframe: start - run.start <= JOIN_SECONDS ? run.keyframe : run.kind === 'audio',
  }
}

export class DecoderWindow {
  private bytesLimit: number
  /** Each track's runs, by start. */
  private readonly runs: Record<'video' | 'audio', FedRun[]> = { video: [], audio: [] }
  /** Each track's origin: the start of the earliest run fed since the window was made or last reset, or null before one. Where a track began, a playhead just before it is not a hole. */
  private readonly origins: Record<'video' | 'audio', number | null> = { video: null, audio: null }

  constructor(limitBytes = WINDOW_BYTES) {
    this.bytesLimit = limitBytes
  }

  /** The byte limit now: it starts at the constructor's and only a quota error shrinks it. */
  get limit(): number {
    return this.bytesLimit
  }

  /** A fragment was appended. It replaces the runs of its track that it overlaps, as Media Source overwrites the frames it holds at the same times: they are dropped, or trimmed with their bytes prorated. */
  fed(run: FedRun): void {
    const kept: FedRun[] = []
    for (const other of this.runs[run.kind]) {
      if (other.end <= run.start + JOIN_SECONDS || other.start >= run.end - JOIN_SECONDS) {
        kept.push(other)
        continue
      }
      const before = part(other, other.start, run.start)
      const after = part(other, run.end, other.end)
      if (before !== null) kept.push(before)
      if (after !== null) kept.push(after)
    }
    kept.push({ ...run })
    const origin = this.origins[run.kind]
    if (origin === null || run.start < origin) this.origins[run.kind] = run.start
    this.runs[run.kind] = kept.sort((a, b) => a.start - b.start)
  }

  /** The browser's buffer was cut before `before`: every run that starts before it goes, and one that straddles it is trimmed to start there, with its bytes prorated. No end is compared with another, so a rounding between them frees nothing less. */
  removed(kind: 'video' | 'audio', before: number): void {
    const kept: FedRun[] = []
    for (const run of this.runs[kind]) {
      if (run.start >= before) kept.push(run)
      else {
        const rest = part(run, before, run.end)
        if (rest !== null) kept.push(rest)
      }
    }
    this.runs[kind] = kept
  }

  /**
   * Makes the window agree with the browser: what lies outside the ranges the
   * sink reports (`buffered`, in seconds on the playback timeline) is dropped or
   * trimmed, with bytes prorated. The browser may evict on its own, and the
   * window must not count, or trust, what is gone. A rounding at a range's edge
   * drops nothing.
   */
  sync(kind: 'video' | 'audio', buffered: readonly (readonly [number, number])[]): void {
    const kept: FedRun[] = []
    for (const run of this.runs[kind]) {
      for (const [low, high] of buffered) {
        const piece = part(run, Math.max(run.start, low), Math.min(run.end, high))
        if (piece !== null) kept.push(piece)
      }
    }
    this.runs[kind] = kept.sort((a, b) => a.start - b.start)
  }

  /**
   * How far to feed the track, or null when it needs nothing now: its runs reach
   * `playhead + WINDOW_AHEAD_SECONDS` without a gap, or the window is full in
   * bytes and the track has `WINDOW_MIN_AHEAD_SECONDS` ahead. `until` is a step,
   * `FEED_STEP_SECONDS` past what the track holds (the playhead, when it holds
   * nothing there), as the engine feeds to it in one call.
   */
  wants(kind: 'video' | 'audio', playhead: number): { until: number } | null {
    const ahead = this.aheadSeconds(kind, playhead)
    if (ahead >= WINDOW_AHEAD_SECONDS) return null
    if (this.bytes() >= this.limit && ahead >= WINDOW_MIN_AHEAD_SECONDS) return null
    return {
      until: Math.min(playhead + WINDOW_AHEAD_SECONDS, playhead + ahead + FEED_STEP_SECONDS),
    }
  }

  /**
   * The time to cut the track before, or null when nothing is due. While the
   * bytes are under the limit the bound is `playhead − WINDOW_BEHIND_SECONDS`; at
   * or over it, the playhead. The answer is the latest of:
   * - a keyframe's time at or before the bound, with something fed before it, so
   *   the group being played is never cut;
   * - the end of the track's last run, when it ends at or before the bound, so
   *   the last group can be cut too. A gap inside a group (VFR, a chunk edge,
   *   rounding) is no place to cut: Media Source would remove its keyframe.
   */
  toRemove(kind: 'video' | 'audio', playhead: number): number | null {
    const runs = this.runs[kind]
    const first = runs[0]
    if (first === undefined) return null
    const bound = this.bytes() >= this.limit ? playhead : playhead - WINDOW_BEHIND_SECONDS
    let at: number | null = null
    for (const run of runs) {
      if (run.start <= bound && run.keyframe && run.start > first.start) {
        at = Math.max(at ?? run.start, run.start)
      }
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && last.end <= bound) at = Math.max(at ?? last.end, last.end)
    return at
  }

  /** A quota error: the limit shrinks by `QUOTA_SHRINK` of the less of the limit and what the window holds, to no less than `WINDOW_FLOOR_BYTES`, so a window that holds less than its limit is cut below what it holds. Answers the new limit. */
  quota(): number {
    const held = this.bytes()
    const from = held > 0 ? Math.min(this.limit, held) : this.limit
    const shrunk = Math.max(WINDOW_FLOOR_BYTES, Math.floor(from * QUOTA_SHRINK))
    this.bytesLimit = Math.min(this.bytesLimit, shrunk)
    return this.bytesLimit
  }

  /** The bytes the window holds, across both tracks. */
  bytes(): number {
    let total = 0
    for (const run of this.runs.video) total += run.bytes
    for (const run of this.runs.audio) total += run.bytes
    return total
  }

  /**
   * The seconds the track's runs reach from the playhead without a gap, with only
   * a rounding of tolerance: a hole at the playhead is nothing held. The one
   * allowance is for a track that has not started: when the playhead is before
   * the track's origin by no more than `GAP_STEP_SECONDS` (a picture's first frame
   * shows a little after 0, and a sound may start late), the time is counted from
   * the origin. 0 when no run is held there.
   */
  aheadSeconds(kind: 'video' | 'audio', playhead: number): number {
    const origin = this.origins[kind]
    const notStarted = origin !== null && playhead < origin && origin - playhead <= GAP_STEP_SECONDS
    let reach = notStarted ? origin : playhead
    let held = false
    for (const run of this.runs[kind]) {
      if (run.end <= playhead) continue
      if (run.start > reach + JOIN_SECONDS) break
      reach = Math.max(reach, run.end)
      held = true
    }
    return held ? reach - playhead : 0
  }

  /** Empties the window, for a seek outside it or a reopen. The limit stays as the quota errors have shrunk it. */
  reset(): void {
    this.runs.video = []
    this.runs.audio = []
    this.origins.video = null
    this.origins.audio = null
  }
}

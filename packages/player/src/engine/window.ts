// The decoder window (DESIGN.md §10.4; the iron-clad spec §4.8): the bookkeeping
// that keeps the browser's Media Source buffer small, in bytes and in seconds. It
// is told what was appended and what was removed, and says when to feed and what
// to cut. It uses no DOM type and no timer: the engine reads the sink's buffered
// ranges and calls it.
//
// Times are seconds on the playback timeline (after the SourceBuffer's timestamp
// offset), as the sink reports them. The cap is in bytes, across both tracks, and
// it gives way to the time ahead (R14): the played time kept behind is the first
// thing cut when the window is full, and a track is always fed until it has
// `WINDOW_MIN_AHEAD_SECONDS` ahead, so the cap never starves the playhead.

import {
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

/** Two runs closer than this, in seconds, are joined: the rounding of the timescale is not a gap. */
const JOIN_SECONDS = 0.001

export class DecoderWindow {
  private limit: number
  /** Each track's runs, by start. */
  private readonly runs: Record<'video' | 'audio', FedRun[]> = { video: [], audio: [] }

  constructor(limitBytes = WINDOW_BYTES) {
    this.limit = limitBytes
  }

  /** A fragment was appended. */
  fed(run: FedRun): void {
    const runs = this.runs[run.kind]
    let at = runs.findIndex((other) => other.start > run.start)
    if (at < 0) at = runs.length
    runs.splice(at, 0, { ...run })
  }

  /** The browser's buffer was cut before `before`: the runs that end at or before it go, and one that straddles it stays. */
  removed(kind: 'video' | 'audio', before: number): void {
    this.runs[kind] = this.runs[kind].filter((run) => run.end > before)
  }

  /**
   * How far ahead to feed the track, or null when it needs nothing now: its runs
   * reach `playhead + WINDOW_AHEAD_SECONDS` without a gap, or the window is full
   * in bytes and the track has `WINDOW_MIN_AHEAD_SECONDS` ahead.
   */
  wants(kind: 'video' | 'audio', playhead: number): { until: number } | null {
    const ahead = this.aheadSeconds(kind, playhead)
    if (ahead >= WINDOW_AHEAD_SECONDS) return null
    if (this.bytes() >= this.limit && ahead >= WINDOW_MIN_AHEAD_SECONDS) return null
    return { until: playhead + WINDOW_AHEAD_SECONDS }
  }

  /**
   * The keyframe time to cut the track before, or null when nothing is due. While
   * the bytes are under the limit it is the latest keyframe at or before
   * `playhead − WINDOW_BEHIND_SECONDS`; at or over the limit it is the latest at
   * or before the playhead. Never later than the playhead's own keyframe, so the
   * group being played is never cut, and null when nothing is fed before it.
   */
  toRemove(kind: 'video' | 'audio', playhead: number): number | null {
    const runs = this.runs[kind]
    const first = runs[0]
    if (first === undefined) return null
    const bound = this.bytes() >= this.limit ? playhead : playhead - WINDOW_BEHIND_SECONDS
    let at: number | null = null
    for (const run of runs) {
      if (run.start > bound) break
      if (run.keyframe) at = run.start
    }
    return at !== null && at > first.start ? at : null
  }

  /** A quota error: the limit shrinks by `QUOTA_SHRINK`, to no less than `WINDOW_FLOOR_BYTES`. Answers the new limit. */
  quota(): number {
    const shrunk = Math.max(WINDOW_FLOOR_BYTES, Math.floor(this.limit * QUOTA_SHRINK))
    this.limit = Math.min(this.limit, shrunk)
    return this.limit
  }

  /** The bytes the window holds, across both tracks. */
  bytes(): number {
    let total = 0
    for (const run of this.runs.video) total += run.bytes
    for (const run of this.runs.audio) total += run.bytes
    return total
  }

  /** The seconds the track's runs reach from the playhead without a gap. 0 when none covers the playhead. */
  aheadSeconds(kind: 'video' | 'audio', playhead: number): number {
    let reach = playhead
    for (const run of this.runs[kind]) {
      if (run.end <= reach) continue
      if (run.start > reach + JOIN_SECONDS) break
      reach = run.end
    }
    return reach - playhead
  }

  /** Empties the window, for a seek outside it or a reopen. The limit stays as the quota errors have shrunk it. */
  reset(): void {
    this.runs.video = []
    this.runs.audio = []
  }
}

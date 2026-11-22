// How a stretch of frames is cut into fragments (DESIGN.md §10.4, D45): a pure
// function of a frame table, promoted from the browser suites' choices so that the
// player cuts its fragments the way they do.

/** The least of a frame table that cutting frames into fragments needs. */
export interface RunTable {
  count: number
  timescale: number
  durations: Uint32Array
  sync: Uint8Array
}

/**
 * Frames [from, to) cut into runs for fragments, each [first, end) in order and
 * with no gap: no run covers more than a second of the track's time (a frame that
 * lasts longer is a run of its own), and with `atKeyframes` every keyframe after
 * the stretch's first frame begins a run, so that each keyframe starts a fragment
 * (R49). The player cuts the frames of one read at a time, and a 4K read holds a
 * fraction of a second, so a rule that waited for half a second of covered time
 * never fired there: keyframes sat inside runs, almost no run was flagged as
 * beginning at one, and the decoder window, which cuts only at such a run, could
 * not trim the picture behind the playhead. A file of very short groups gets
 * small fragments, which Media Source takes. A sound's frames all are keyframes,
 * and cut nothing: pass `atKeyframes` false.
 */
export function fragmentRuns(
  table: RunTable,
  from: number,
  to: number,
  atKeyframes: boolean,
): [number, number][] {
  const runs: [number, number][] = []
  const limit = table.timescale
  let start = from
  let covered = 0
  for (let i = from; i < to; i += 1) {
    const ticks = table.durations[i] ?? 0
    const cut = covered + ticks > limit || (atKeyframes && table.sync[i] === 1)
    if (i > start && cut) {
      runs.push([start, i])
      start = i
      covered = 0
    }
    covered += ticks
  }
  if (to > start) runs.push([start, to])
  return runs
}

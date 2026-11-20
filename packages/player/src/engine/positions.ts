// Where in the file each time that was fed lies (DESIGN.md §10.4): the feeder
// records each fragment it gives with the least file offset of its frames, and the
// engine asks, as the playhead moves, where the file is read around that time, so
// that the downloader's onward reads follow the playhead (`setPosition`; the picture's place, R22b). Times are
// seconds on the playback timeline, as `FedRun`'s are.
//
// The record is bounded, as a play's is not: at a fragment a second for each track
// it holds some hours of a play, and the oldest runs are the first to go.

import type { FedRun } from './window.ts'

/** The runs that `Positions` keeps, the oldest dropped first. */
export const POSITIONS_MAX = 20_000

/** A fragment that was fed, and the least offset of the file that its frames lie at. */
type PositionedRun = FedRun & { offset: number }

export class Positions {
  /** In the order they were fed. */
  #runs: PositionedRun[] = []

  /** Records a fragment that was fed; past `POSITIONS_MAX` runs the oldest is forgotten. */
  add(run: PositionedRun): void {
    this.#runs.push(run)
    if (this.#runs.length > POSITIONS_MAX) this.#runs.splice(0, this.#runs.length - POSITIONS_MAX)
  }

  /**
   * The source offset of the picture at `seconds`: the least offset of the picture's
   * runs that cover the time (from a run's start up to, and not including, its end).
   * When none does, the offset of the picture run that ends nearest at or before it
   * (the least of those that end together), and null when none does, as when nothing
   * was fed. The sound's runs are kept but never answered: the picture holds nearly
   * all the bytes of a file, so the download follows it, and the sound's offset would
   * put the position in the wrong place in a file that lays the sound first or apart.
   */
  offsetAt(seconds: number): number | null {
    let covering: number | null = null
    let before: { end: number; offset: number } | null = null
    for (const run of this.#runs) {
      if (run.kind !== 'video') continue
      if (run.start <= seconds && seconds < run.end) {
        if (covering === null || run.offset < covering) covering = run.offset
      } else if (run.end <= seconds) {
        if (
          before === null ||
          run.end > before.end ||
          (run.end === before.end && run.offset < before.offset)
        ) {
          before = { end: run.end, offset: run.offset }
        }
      }
    }
    return covering ?? before?.offset ?? null
  }

  /** Forgets every run. */
  clear(): void {
    this.#runs = []
  }
}

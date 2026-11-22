// The watchdog's eyes (DESIGN.md §10.4; the iron-clad spec §4.8): every `WATCH_EVERY_MS` the engine reads the
// element into a sample, and the pure `Watchdog` says what to do about a play that has frozen. This reads and
// asks; applying the action and logging it are the play's.

import { Watchdog } from '../engine/watchdog.ts'
import type { WatchAction } from '../engine/watchdog.ts'
import type { EngineTrack } from '../engine/tracks.ts'
import { framesShown, rangesOf } from './video.ts'

/** The picture's longest frame, in seconds, from an MP4 track's table; null for a Matroska file, whose table is not kept. */
export function longestFrameSeconds(track: EngineTrack): number | null {
  const { track: source } = track
  if (!('table' in source) || source.table.count === 0 || source.table.timescale <= 0) return null
  let longest = 0
  for (let i = 0; i < source.table.count; i += 1) {
    longest = Math.max(longest, source.table.durations[i] ?? 0)
  }
  return longest > 0 ? longest / source.table.timescale : null
}

export class Watching {
  readonly #video: HTMLVideoElement
  readonly #dog: Watchdog
  /** True when a seek began since the last sample: the element may already be done with it. */
  #seekSince = false

  constructor(video: HTMLVideoElement, picture: EngineTrack) {
    this.#video = video
    this.#dog = new Watchdog(() => performance.now(), longestFrameSeconds(picture))
  }

  /** A seek began (the viewer's, not the engine's own). */
  noteSeek(): void {
    this.#seekSince = true
  }

  /**
   * Reads the element and asks the watchdog; `holding` is whether the hold rule is holding the play, `feeding`
   * whether a feed is under way, and `trackEnds` where each playing track's buffer ends at the playhead.
   */
  sample(
    holding: boolean,
    feeding: boolean,
    trackEnds: { name: string; end: number | null }[],
  ): WatchAction | null {
    const video = this.#video
    const seeking = video.seeking || this.#seekSince
    this.#seekSince = false
    return this.#dog.observe({
      at: video.currentTime,
      frames: framesShown(video),
      readyState: video.readyState,
      paused: video.paused,
      seeking,
      ended: video.ended,
      buffered: rangesOf(video.buffered),
      holding,
      hidden: document.hidden,
      feeding,
      trackEnds,
    })
  }
}

/**
 * The last numbers of the current play, read at once (§10.4). What the view renders from lags a
 * commit behind the engine, so a failure's handler, a toggle and the play's report read these
 * instead. They stay when the play's own failure ends it, and the next play clears them.
 */
export class LastStats<T> {
  #current: T | null = null
  #play = 0

  /** A new play starts: its numbers are none yet. Returns the way that play sets them. */
  start(): (stats: T) => void {
    const play = ++this.#play
    this.#current = null
    return (stats) => {
      // A callback from a play that a newer one has replaced says nothing about the newer one.
      if (play === this.#play) this.#current = stats
    }
  }

  /** The play's latest numbers, or null before its first. */
  get(): T | null {
    return this.#current
  }
}

/**
 * Whether a wanted play is held, so the viewer's toggle reads the intent and the controls show
 * Pause (§10.4): the engine holds for the network, or a buffered play has not begun and is
 * opening (the element is paused then, though the play is on its way).
 */
export function holdsPlay(
  stats: { holding: boolean; begun: boolean } | null,
  bufferedPlay: boolean,
): boolean {
  if (stats?.holding === true) return true
  return bufferedPlay && stats?.begun !== true
}

/**
 * Whether the spinner turns for the engine's hold (§10.4): only while the play is wanted. A viewer's
 * pause during a hold that a serve keeps leaves the hold on until the serve ends, so a quick pause
 * and play still waits for the goal, but the page shows that hold as paused.
 */
export function holdSpinner(stats: { holding: boolean } | null, wanted: boolean): boolean {
  return stats?.holding === true && wanted
}

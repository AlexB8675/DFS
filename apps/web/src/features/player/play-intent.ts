/**
 * What the viewer means the play to do (§10.4). The engine pauses the element itself while it
 * holds for the network, so the element's `paused` says nothing then: a toggle, and the engine's
 * choice to play when a hold ends, read this instead. A pause sticks until the viewer plays.
 */
export class PlayIntent {
  /** Whether the viewer wants the video to play: true at first, false after a pause. */
  wanted = true

  /** The viewer plays. `'wait'` when the engine holds: it plays when the hold ends, as it is wanted. */
  play(holding: boolean): 'play' | 'wait' {
    this.wanted = true
    return holding ? 'wait' : 'play'
  }

  /** The viewer pauses: a hold that ends does not play. */
  pause(): void {
    this.wanted = false
  }

  /** A new start (another file, a retry) wants a play again. */
  restart(): void {
    this.wanted = true
  }

  /** The element played by itself, from outside the page's controls (Picture-in-Picture's button, a browser's own control): a play the viewer wants. */
  played(): void {
    this.wanted = true
  }

  /** The viewer toggles: during a hold by the intent, otherwise by what the element shows. */
  toggle(holding: boolean, paused: boolean): 'play' | 'pause' | 'wait' {
    if (holding) {
      if (this.wanted) {
        this.wanted = false
        return 'pause'
      }
      this.wanted = true
      return 'wait'
    }
    if (paused) {
      this.wanted = true
      return 'play'
    }
    this.wanted = false
    return 'pause'
  }
}

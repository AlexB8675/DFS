import type { KeyboardEvent } from 'react'

/** What the viewer's keys ask of the view showing a file; each does what it can. */
export interface ViewHandle {
  /** A key for the view itself (a video's); `true` if it took it. */
  handleKey?: (event: KeyboardEvent) => boolean
  zoomIn?: () => void
  zoomOut?: () => void
  /** Back to fitting the screen. */
  reset?: () => void
  /** Search the text (Ctrl+F). */
  find?: () => void
  /** Closes what the view has open, its search say, if anything: Esc does that before closing the viewer. */
  dismiss?: () => boolean
  /** Pauses it, as it goes on in another player (§6.7): a video's. */
  pause?: () => void
}

/** What the viewer's keys ask of the view showing a file; each does what it can. */
export interface ViewHandle {
  zoomIn?: () => void
  zoomOut?: () => void
  /** Back to fitting the screen. */
  reset?: () => void
  /** Search the text (Ctrl+F). */
  find?: () => void
  /** Closes what the view has open, its search say, if anything: Esc does that before closing the viewer. */
  dismiss?: () => boolean
}

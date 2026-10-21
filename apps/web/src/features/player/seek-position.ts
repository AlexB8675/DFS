import type { MediaState } from './use-media-state'

// Where the video's seek bar shows its thumb (DESIGN.md §10.4). The element's
// state is a snapshot, read again on the element's events, so right after a
// seek it still says the old time until the element has said `seeking`.
// Drawing from it would put the thumb back at the old place for a moment
// after it is let go; so a drag is held where it was let go until the snapshot
// changes, and the element's time takes over from there.

/** Where the seek bar is dragged to, and the element's state when it was let go. */
export interface SeekDrag {
  /** In seconds. */
  time: number
  /** The snapshot the element's state was when it was let go; `null` while still dragging. */
  letGoAt: MediaState | null
}

/** The time the seek bar shows, in seconds. */
export function seekBarTime(drag: SeekDrag | null, state: MediaState): number {
  // The store gives a new object on each update, so the same one is no update yet.
  if (drag && (drag.letGoAt === null || drag.letGoAt === state)) return drag.time
  return state.currentTime
}

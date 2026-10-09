// When a player keeps where a viewer stopped (DESIGN.md §10.4). Every video
// starts at the beginning, offering to resume where it stopped (the user's
// decision, 2026-10-09). The offer stands through the video's first 30 s,
// time enough to see it, and the position it offers is kept meanwhile: one
// who opens a video and leaves, or lets it play a little, finds the offer
// again next time. Past it, or without one, a position is kept from 10 s in.

/** Less than this in isn't worth coming back to: it is neither kept nor offered. */
export const RESUME_FROM_MS = 10_000
/** The offer to resume stands until the video has played this far, unless it ends sooner. */
export const RESUME_OFFER_MS = 30_000
/** Past this share of it, it is finished. */
export const FINISHED_AT = 0.95

/** What saving does with where a video is, `ms` into its `durationMs` (`NaN` until known). */
export function positionChange(
  ms: number,
  durationMs: number,
  ended: boolean,
): 'keep' | 'clear' | 'none' {
  const finished =
    ended || (Number.isFinite(durationMs) && durationMs > 0 && ms >= durationMs * FINISHED_AT)
  if (finished) return 'clear'
  return ms < RESUME_FROM_MS ? 'none' : 'keep'
}

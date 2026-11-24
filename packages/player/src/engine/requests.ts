// What the pump is asked to do (DESIGN.md §10.4): a refeed, a seek outside the window, or a reopen of Media
// Source. Requests are merged and never dropped: a seek's target outlives a refeed or a reopen that comes while
// it waits or is served. The play intent they carry is informational: the serve reads the live intent at each
// decision (the element playing now, a hold for a wanted play, the reopen's own pause), not the request's. It uses
// no DOM type and no timer.

export interface Request {
  kind: 'refeed' | 'seek' | 'reopen'
  /** Where the serve feeds from, in seconds. */
  to: number
  /** True when `to` and `playing` are the viewer's (a seek's); false when they are the playhead's when the request was posted. */
  told: boolean
  /** True when a viewer's seek is in it: the serve ends with the hold for a seek. */
  seek: boolean
  /** The play intent when the request was posted: the element was playing, or a hold for a wanted play was on. Informational (written by `#onSeeking` and `#own`, merged): the serve does not read it. */
  playing: boolean
}

const RANK: Record<Request['kind'], number> = { refeed: 1, seek: 2, reopen: 3 }

/**
 * The request that does what both ask. The kind is the stronger one. The place and the intent are the
 * later's when it is told, else the earlier's when that is told, else the later's. A seek in either stays.
 */
export function mergeRequests(earlier: Request | null, later: Request): Request {
  if (earlier === null) return later
  const source = later.told ? later : earlier.told ? earlier : later
  return {
    kind: RANK[earlier.kind] > RANK[later.kind] ? earlier.kind : later.kind,
    to: source.to,
    told: earlier.told || later.told,
    seek: earlier.seek || later.seek,
    playing: source.playing,
  }
}

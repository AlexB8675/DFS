import type { AudioTrack } from '@dfs/shared'

// The audio bar's queue (DESIGN.md §10.4), as plain values: the tracks in
// the order the user sees and arranges them, and the order they play in,
// which shuffling changes and turning it off restores. Each entry has a key
// of its own, so a file can be in the queue twice.

export interface QueuedTrack extends Omit<AudioTrack, 'versionId'> {
  /** This entry's own, unique in the queue. */
  key: string
  /** The link's token for a link's file; `null` for a drive's. */
  token: string | null
  /**
   * The version to play; `null` until the queue's answer names one, for a
   * file started at a click, before its folder's queue came.
   */
  versionId: string | null
}

export interface Queue {
  tracks: QueuedTrack[]
  /** The tracks' keys in the order they play. */
  order: string[]
  /** The place in `order` of the track playing. */
  at: number
}

export const EMPTY_QUEUE: Queue = { tracks: [], order: [], at: 0 }

/** For shuffling, as `Math.random`: a test passes its own. */
export type Random = () => number

/** The track playing, or about to. */
export function currentTrack(queue: Queue): QueuedTrack | null {
  const key = queue.order[queue.at]
  return queue.tracks.find((track) => track.key === key) ?? null
}

/** A queue of `tracks`, playing `first`; shuffled, it starts with `first` and the rest in any order. */
export function startQueue(
  tracks: QueuedTrack[],
  first: number,
  shuffle: boolean,
  random: Random = Math.random,
): Queue {
  const keys = tracks.map((track) => track.key)
  const firstKey = keys[first]
  if (firstKey === undefined) return EMPTY_QUEUE
  if (!shuffle) return { tracks, order: keys, at: first }
  return { tracks, order: [firstKey, ...shuffled(withoutKey(keys, firstKey), random)], at: 0 }
}

/** More tracks after the rest, to play once those queued have played. */
export function appendTracks(
  queue: Queue,
  tracks: QueuedTrack[],
  shuffle: boolean,
  random: Random = Math.random,
): Queue {
  const keys = tracks.map((track) => track.key)
  return {
    tracks: [...queue.tracks, ...tracks],
    order: [...queue.order, ...(shuffle ? shuffled(keys, random) : keys)],
    at: queue.at,
  }
}

/** The track `by` places on in play order; past the end, `null`, or round again with `wrap`. */
export function stepQueue(queue: Queue, by: 1 | -1, wrap: boolean): Queue | null {
  const at = queue.at + by
  if (at >= 0 && at < queue.order.length) return { ...queue, at }
  if (!wrap || queue.order.length === 0) return null
  return { ...queue, at: by > 0 ? 0 : queue.order.length - 1 }
}

/** Plays the entry with `key` next, where it is in play order. */
export function jumpTo(queue: Queue, key: string): Queue {
  const at = queue.order.indexOf(key)
  return at === -1 ? queue : { ...queue, at }
}

/** Without the entry with `key`; removing the one playing goes on with the next. */
export function removeTrack(queue: Queue, key: string): Queue {
  const place = queue.order.indexOf(key)
  if (place === -1) return queue
  const order = withoutKey(queue.order, key)
  const at = place < queue.at ? queue.at - 1 : Math.min(queue.at, Math.max(0, order.length - 1))
  return { tracks: queue.tracks.filter((track) => track.key !== key), order, at }
}

/**
 * The entry at `from` in the list moved to `to`. Unshuffled, play order is
 * the list's, so the track playing keeps playing where it now is.
 */
export function moveTrack(queue: Queue, from: number, to: number, shuffle: boolean): Queue {
  const tracks = [...queue.tracks]
  const [moved] = tracks.splice(from, 1)
  if (!moved) return queue
  tracks.splice(Math.min(Math.max(0, to), tracks.length), 0, moved)
  if (shuffle) return { ...queue, tracks }
  const playing = queue.order[queue.at]
  const order = tracks.map((track) => track.key)
  return { tracks, order, at: playing === undefined ? 0 : Math.max(0, order.indexOf(playing)) }
}

/**
 * Shuffled: the track playing, then the others in any order. Unshuffled:
 * the list's order again, on from the track playing.
 */
export function shuffleQueue(queue: Queue, on: boolean, random: Random = Math.random): Queue {
  const playing = queue.order[queue.at]
  const keys = queue.tracks.map((track) => track.key)
  if (playing === undefined) return { ...queue, order: keys, at: 0 }
  if (on)
    return { ...queue, order: [playing, ...shuffled(withoutKey(keys, playing), random)], at: 0 }
  return { ...queue, order: keys, at: keys.indexOf(playing) }
}

/** The entry with `key` changed by `change`, wherever it is. */
export function updateTrack(
  queue: Queue,
  key: string,
  change: Partial<Omit<QueuedTrack, 'key'>>,
): Queue {
  return {
    ...queue,
    tracks: queue.tracks.map((track) => (track.key === key ? { ...track, ...change } : track)),
  }
}

function withoutKey(keys: readonly string[], key: string): string[] {
  return keys.filter((other) => other !== key)
}

/** Fisher–Yates. */
function shuffled(keys: readonly string[], random: Random): string[] {
  const result = [...keys]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = result[i]
    result[i] = result[j] ?? ''
    result[j] = swap ?? ''
  }
  return result
}

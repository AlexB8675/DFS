import type { SendStats } from './send.ts'

// How fast each user's reads of a version are going, for their player
// (DESIGN.md §10.4): a player can't count the bytes its video element takes,
// and can't tell a slow connection from slow storage, but the API can. The
// figures are kept by reader and version, cumulative, while reads run and for
// a while after; the player asks for them now and then and works out the
// rates from the differences. A reader is a user, or a link's viewer.

/** A share link's viewer, who has no account: by the link and their address. */
export function linkReader(shareId: string, address: string): string {
  return `link:${shareId}:${address}`
}

/** A version nobody has read for this long is forgotten. */
const FORGET_AFTER_MS = 5 * 60_000

/** All reads of a version by a user so far, as one: cumulative, so a player takes differences. */
export interface DeliveryTotals {
  bytes: number
  /** Milliseconds the reads waited for the reader: the cache, staging or Discord. */
  waitedForSourceMs: number
  /** Milliseconds the reads waited for the client to take what was sent. */
  waitedForClientMs: number
  /** Reads running now. */
  running: number
}

interface Followed {
  running: Set<SendStats>
  /** What finished reads added, so the totals never go back. */
  finished: Omit<DeliveryTotals, 'running'>
  lastAt: number
}

export class Deliveries {
  readonly #byKey = new Map<string, Followed>()

  /** Follows a read; call what it returns when its response closes. */
  follow(userId: string, versionId: string, stats: SendStats): () => void {
    this.#forgetOld()
    const key = `${userId}:${versionId}`
    let followed = this.#byKey.get(key)
    if (!followed) {
      followed = {
        running: new Set(),
        finished: { bytes: 0, waitedForSourceMs: 0, waitedForClientMs: 0 },
        lastAt: performance.now(),
      }
      this.#byKey.set(key, followed)
    }
    const kept = followed
    const { running, finished } = kept
    running.add(stats)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      running.delete(stats)
      finished.bytes += stats.bytes
      finished.waitedForSourceMs += stats.sourceMs
      finished.waitedForClientMs += stats.clientMs
      kept.lastAt = performance.now()
    }
  }

  /** The user's reads of the version, finished and running, summed. */
  totals(userId: string, versionId: string): DeliveryTotals {
    const followed = this.#byKey.get(`${userId}:${versionId}`)
    const totals: DeliveryTotals = {
      bytes: followed?.finished.bytes ?? 0,
      waitedForSourceMs: followed?.finished.waitedForSourceMs ?? 0,
      waitedForClientMs: followed?.finished.waitedForClientMs ?? 0,
      running: followed?.running.size ?? 0,
    }
    for (const stats of followed?.running ?? []) {
      totals.bytes += stats.bytes
      totals.waitedForSourceMs += stats.sourceMs
      totals.waitedForClientMs += stats.clientMs
    }
    totals.waitedForSourceMs = Math.round(totals.waitedForSourceMs)
    totals.waitedForClientMs = Math.round(totals.waitedForClientMs)
    return totals
  }

  #forgetOld(): void {
    const now = performance.now()
    for (const [key, followed] of this.#byKey) {
      if (followed.running.size === 0 && now - followed.lastAt > FORGET_AFTER_MS) {
        this.#byKey.delete(key)
      }
    }
  }
}

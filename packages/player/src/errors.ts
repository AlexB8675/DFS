// Why the player's store fails (DESIGN.md §10.4; the iron-clad spec §4.7). Whatever
// goes wrong in sealing, writing or reading a block is thrown as one of these, so
// that the caller can tell a damaged block from a full disk and put the reason on
// the play's timeline.

/**
 * What went wrong in the store:
 * - `sealed`: a block failed to open (its tag, IV, index or key don't match).
 * - `disk`: the private file system failed a read or write.
 * - `quota`: the browser refused a write for lack of space.
 * - `closed`: the store was used after it closed.
 * - `refused`: the browser refused the private file system (a private window, a denied permission).
 * - `no-opfs`: the browser has no private file system, or no way to write it from a worker.
 */
export type StoreErrorKind = 'sealed' | 'disk' | 'quota' | 'closed' | 'refused' | 'no-opfs'

export class StoreError extends Error {
  readonly kind: StoreErrorKind

  constructor(kind: StoreErrorKind, message: string) {
    super(message)
    this.name = 'StoreError'
    this.kind = kind
  }
}

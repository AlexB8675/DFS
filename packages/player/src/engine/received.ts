// The bytes the engine has received, from what the store says of itself (DESIGN.md §10.4).

/** What a store lost of the bytes it took: settled blocks that lost a slot, and frontier blocks that were let go of. */
export interface LostBytes {
  evictedBytes: number
  droppedBytes: number
}

/** Every byte taken from the network: those held now, and those that the store let go of, evicted or dropped (R54). */
export function bytesReceivedOf(heldBytes: number, lost: LostBytes): number {
  return heldBytes + lost.evictedBytes + lost.droppedBytes
}

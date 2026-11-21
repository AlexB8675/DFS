// The chunks that opening a file and seeking in it needed (DESIGN.md §10.4): the head, the tail,
// the `moov` read on its own, the Cues and what a seek read. They are kept in memory for the play,
// up to `INDEX_CACHE_BYTES`, so that a seek holds them already and reads nothing for them. The
// reader (`openSource`, `seekCursor`) is given them all, the head first.

import type { Chunk } from '@dfs/mp4'
import { INDEX_CACHE_BYTES } from '../limits.ts'

export class IndexCache {
  #head: Chunk
  readonly #limit: number
  /** Oldest first. */
  #rest: Chunk[] = []

  constructor(head: Chunk, limit = INDEX_CACHE_BYTES) {
    this.#head = head
    this.#limit = limit
  }

  /**
   * Keeps a chunk. When the cache then holds more than its limit the oldest chunks go, never the
   * head and never the one just added, which the reader asks for again at once if it is gone.
   */
  add(chunk: Chunk): void {
    this.#rest.push(chunk)
    while (this.bytes > this.#limit && this.#rest.length > 1) this.#rest.shift()
  }

  /** Forgets everything, the head too: for a file whose seeks read no chunk. */
  clear(): void {
    this.#head = { start: 0, bytes: new Uint8Array(0) }
    this.#rest = []
  }

  /** The chunks held, the head first, then the others oldest first. */
  chunks(): Chunk[] {
    return [this.#head, ...this.#rest]
  }

  /** How many bytes the chunks hold. */
  get bytes(): number {
    let total = this.#head.bytes.length
    for (const chunk of this.#rest) total += chunk.bytes.length
    return total
  }
}

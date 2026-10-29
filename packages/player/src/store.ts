// The core of the player's store (DESIGN.md §10.4; the iron-clad spec §4.7): the
// slots that a play's blocks are kept in, the frontier of blocks that are still
// filling, and the writes and reads that join them. A slot holds one block, sealed
// in a private file or whole in memory. A write may land at any offset: its bytes
// go into a frontier block, and a block that has all its bytes goes to a free slot.
// A read joins the blocks in slots to the bytes in the frontier, so a block can be
// read from the moment its first byte is written. What the store holds is decided
// when a call is made and only the sealing is awaited, so that two writes cannot
// be given the same slot and a read cannot meet a change made after it started.
// Evicting the blocks that are furthest from the playhead is added to the core next.

import type { ByteRange } from '@dfs/mp4'
import { blockOf, blockSpan } from './blocks.ts'
import { StoreError } from './errors.ts'
import { BLOCK_BYTES, FRONTIER_BLOCKS } from './limits.ts'
import { RangeSet } from './ranges.ts'
import { SEAL_OVERHEAD, openBlock, sealBlock } from './seal.ts'
import type { PlayKey } from './seal.ts'

/**
 * The synchronous calls of a private file's access handle (`FileSystemSyncAccessHandle`)
 * that the store uses. Each can throw a `DOMException`, and the store tells a full disk
 * (`QuotaExceededError`) from any other failure.
 */
export interface SlotFile {
  read(buffer: Uint8Array, options: { at: number }): number
  write(buffer: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

/** Where a play's blocks are kept: sealed in the slots of a private file, under the play's key, or whole in memory. */
export type StoreBackend = { kind: 'disk'; file: SlotFile; key: PlayKey } | { kind: 'memory' }

/** What a write answers. */
export interface WriteOutcome {
  /** Whether a block that the write completed (or one that still waits) found no free slot, so that the downloader should stop. */
  full: boolean
  /** How many bytes the write evicted to make room. */
  evictedBytes: number
  /** The file ranges that the write evicted, in order. */
  evicted: readonly ByteRange[]
}

/** What the store reports of itself. */
export interface StoreStats {
  backend: 'disk' | 'memory'
  /** The most that the slots hold, in whole blocks. */
  capBytes: number
  /** The bytes of the file that are in slots. The frontier is kept outside the cap and is not counted. */
  storedBytes: number
  /** The bytes that eviction has let go of, in all. */
  evictedBytes: number
}

/** The store of one play, as every part of the player uses it. */
export interface PlayStore {
  readonly backend: 'disk' | 'memory'
  readonly capBytes: number
  readonly fileSize: number
  /** What is held, file ranges in order: answered at once, from what writes and evictions have said. */
  held(): RangeSet
  write(offset: number, bytes: Uint8Array): Promise<WriteOutcome>
  /** The bytes of [start, end), or null when any of them is not held. */
  read(start: number, end: number): Promise<Uint8Array | null>
  /** Where the engine reads: eviction measures from it, and never evicts its block. */
  setPosition(offset: number): void
  stats(): StoreStats
  /** Deletes everything; later calls reject with StoreError('closed'). */
  close(): Promise<void>
}

/** The size of a slot on disk: a whole block and what sealing adds to it. */
const SLOT_BYTES = BLOCK_BYTES + SEAL_OVERHEAD

/** A block that is still filling, or that is complete and has not yet found its slot. */
interface FrontierBlock {
  /** The block's bytes, as long as the block is: the last block of a file is shorter than the others. */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** The bytes of the block that are present, from 0 at its first byte. */
  readonly have: RangeSet
  /** Whether a slot is chosen for it and its write to that slot has not finished. */
  pending: boolean
  /** Whether it is complete and no slot was free for it. */
  waiting: boolean
}

/** Whether a block's bytes are all present. */
function isComplete(block: FrontierBlock): boolean {
  return block.have.heldFrom(0) === block.bytes.length
}

/** The failure of a call on the file, as a `StoreError`: a full disk is `quota`, anything else is `disk`. */
function fileError(action: string, error: unknown): StoreError {
  if (error instanceof StoreError) return error
  const reason = error instanceof Error ? error.message : 'it did not say why'
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new StoreError('quota', `the browser has no room left to ${action}: ${reason}`)
  }
  return new StoreError('disk', `the private file failed to ${action}: ${reason}`)
}

/** Makes a call on the file, and throws what it fails with as a `StoreError`. */
function onFile<T>(action: string, call: () => T): T {
  try {
    return call()
  } catch (error) {
    throw fileError(action, error)
  }
}

/** A block of the file that a read needs from a slot on disk, taken from the file when the read was made. */
interface SealedPart {
  index: number
  sealed: Uint8Array<ArrayBuffer>
  /** Where in the block the read begins and ends, and where in the result it lands. */
  from: number
  to: number
  at: number
}

export class CoreStore implements PlayStore {
  readonly backend: 'disk' | 'memory'
  readonly capBytes: number
  readonly fileSize: number

  /** The file and the key of the play, or null for the memory backend. */
  readonly #disk: { file: SlotFile; key: PlayKey } | null
  readonly #slotCount: number
  /** What is held: the bytes in slots and in the frontier. */
  #held = new RangeSet()
  /** The slot of each block that has one. */
  readonly #slotOf = new Map<number, number>()
  /** The blocks of the memory backend, by slot. */
  readonly #memory = new Map<number, Uint8Array<ArrayBuffer>>()
  /** The blocks that are filling or waiting, by index. */
  readonly #frontier = new Map<number, FrontierBlock>()
  /** The slots that were used and let go, which the next block takes first (a stack). */
  readonly #freed: number[] = []
  /** The first slot that was never used: the slots from here to the end are free. */
  #unused = 0
  #evictedBytes = 0
  #position = 0
  #closed = false

  constructor(options: { backend: StoreBackend; fileSize: number; capBytes: number }) {
    const { backend, fileSize, capBytes } = options
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new RangeError(`${fileSize} is not the size of a file`)
    }
    if (!Number.isFinite(capBytes) || capBytes < BLOCK_BYTES) {
      throw new RangeError(`a cap of ${capBytes} bytes is less than one block of ${BLOCK_BYTES}`)
    }
    this.backend = backend.kind
    this.fileSize = fileSize
    this.#slotCount = Math.floor(capBytes / BLOCK_BYTES)
    this.capBytes = this.#slotCount * BLOCK_BYTES
    this.#disk = backend.kind === 'disk' ? { file: backend.file, key: backend.key } : null
  }

  /** Where the engine last said that it reads. */
  get position(): number {
    return this.#position
  }

  /** Throws `closed` once the store is closed. */
  #assertOpen(): void {
    if (this.#closed) throw new StoreError('closed', 'the store is closed')
  }

  /** A free slot, taking the one that was let go last before any that was never used, or null when every slot is taken. */
  #takeSlot(): number | null {
    const freed = this.#freed.pop()
    if (freed !== undefined) return freed
    if (this.#unused < this.#slotCount) {
      this.#unused += 1
      return this.#unused - 1
    }
    return null
  }

  /** Whether a complete block is waiting in the frontier for a slot. */
  #isFull(): boolean {
    for (const block of this.#frontier.values()) if (block.waiting) return true
    return false
  }

  /** The block's place in its slot: it leaves the frontier, and the memory backend keeps its bytes as they are. */
  #settle(index: number, slot: number, kept: Uint8Array<ArrayBuffer> | null): void {
    this.#slotOf.set(index, slot)
    if (kept !== null) this.#memory.set(slot, kept)
    this.#frontier.delete(index)
  }

  held(): RangeSet {
    const copy = new RangeSet()
    for (const range of this.#held.ranges()) copy.add(range)
    return copy
  }

  /**
   * Takes the bytes into the frontier and gives each block that is complete a slot,
   * all at the call; then waits for the sealing and the slot writes of the blocks
   * on disk. A write that fails on the disk leaves its block in the frontier, held
   * and readable, with its slot given back, and rejects: the same bytes written
   * again complete the block.
   */
  async write(offset: number, bytes: Uint8Array): Promise<WriteOutcome> {
    this.#assertOpen()
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`the offset ${offset} is not a position in a file`)
    }
    const end = offset + bytes.length
    if (end > this.fileSize) {
      throw new RangeError(
        `a write of ${bytes.length} bytes at ${offset} ends at ${end}, past the end of a file of ${this.fileSize} bytes`,
      )
    }
    if (bytes.length === 0) return { full: this.#isFull(), evictedBytes: 0, evicted: [] }

    // The blocks that the bytes go to are those that are not in a slot already: a block in a slot has all its bytes.
    const touched: number[] = []
    let added = 0
    for (let index = blockOf(offset); index <= blockOf(end - 1); index += 1) {
      if (this.#slotOf.has(index)) continue
      touched.push(index)
      if (!this.#frontier.has(index)) added += 1
    }
    // The bound is checked before anything changes, so that a write that is refused leaves the store as it was.
    if (this.#frontier.size + added > FRONTIER_BLOCKS) {
      throw new RangeError(
        `a write of ${bytes.length} bytes at ${offset} would add ${added} blocks to the ${this.#frontier.size} that the frontier holds, past its ${FRONTIER_BLOCKS}`,
      )
    }

    for (const index of touched) {
      const span = blockSpan(index, this.fileSize)
      let block = this.#frontier.get(index)
      if (block === undefined) {
        block = {
          bytes: new Uint8Array(span.end - span.start),
          have: new RangeSet(),
          pending: false,
          waiting: false,
        }
        this.#frontier.set(index, block)
      }
      const from = Math.max(offset, span.start)
      const to = Math.min(end, span.end)
      block.bytes.set(bytes.subarray(from - offset, to - offset), from - span.start)
      block.have.add({ start: from - span.start, end: to - span.start })
      this.#held.add({ start: from, end: to })
    }

    // A block that is complete is given a slot now, one block at a time and in order, before anything is awaited. The blocks
    // that get one are those this write touched, and those that waited for one: a block that failed to reach its slot waits
    // for the same bytes to be written again.
    const reached = new Set(touched)
    const writes: Promise<{ error: unknown } | null>[] = []
    for (const index of [...this.#frontier.keys()].sort((a, b) => a - b)) {
      const block = this.#frontier.get(index)
      if (block === undefined || block.pending || !isComplete(block)) continue
      if (!reached.has(index) && !block.waiting) continue
      const slot = this.#takeSlot()
      if (slot === null) {
        block.waiting = true
        continue
      }
      block.waiting = false
      if (this.#disk === null) {
        this.#settle(index, slot, block.bytes)
      } else {
        block.pending = true
        writes.push(this.#sealToSlot(this.#disk, index, slot, block))
      }
    }

    // Each write of a slot answers for itself, so that when this call settles every block has either landed or gone back to the frontier.
    const failure = (await Promise.all(writes)).find(
      (result): result is { error: unknown } => result !== null,
    )
    if (failure !== undefined) throw failure.error
    return { full: this.#isFull(), evictedBytes: 0, evicted: [] }
  }

  /**
   * Seals a complete block and writes it to its slot, and answers what it failed
   * with (and gives its slot back, and lets the block be tried again) or null.
   */
  async #sealToSlot(
    disk: { file: SlotFile; key: PlayKey },
    index: number,
    slot: number,
    block: FrontierBlock,
  ): Promise<{ error: unknown } | null> {
    try {
      // The bytes are copied by the seal at this call, so a later write to the block cannot change what this one seals.
      const sealed = await sealBlock(disk.key, index, block.bytes)
      // The store may have closed while the block was sealing, and its file with it.
      this.#assertOpen()
      onFile('write a block', () => {
        const written = disk.file.write(sealed, { at: slot * SLOT_BYTES })
        if (written !== sealed.length) {
          throw new StoreError(
            'disk',
            `the private file took ${written} of the ${sealed.length} bytes of block ${index}`,
          )
        }
      })
    } catch (error) {
      if (!this.#closed) {
        block.pending = false
        this.#freed.push(slot)
      }
      return { error }
    }
    this.#settle(index, slot, null)
    return null
  }

  /**
   * Takes every byte it needs at the call (the frontier's, the memory's, and the
   * sealed blocks of the file), and then opens the sealed blocks. A write or an
   * eviction that happens while they open cannot change what the read returns.
   */
  async read(start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null> {
    this.#assertOpen()
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new RangeError(`${start} to ${end} is not a range of a file`)
    }
    if (end === start) return new Uint8Array(0)
    // What is held is within the file, so a range that goes past its end is not held.
    if (!this.#held.has({ start, end })) return null

    const disk = this.#disk
    const result = new Uint8Array(end - start)
    const sealedParts: SealedPart[] = []
    for (let index = blockOf(start); index <= blockOf(end - 1); index += 1) {
      const span = blockSpan(index, this.fileSize)
      const from = Math.max(start, span.start) - span.start
      const to = Math.min(end, span.end) - span.start
      const at = span.start + from - start
      const slot = this.#slotOf.get(index)
      if (slot === undefined) {
        const block = this.#frontier.get(index)
        if (block === undefined)
          throw new Error(`block ${index} is held but is in no slot and no frontier`)
        result.set(block.bytes.subarray(from, to), at)
      } else if (disk === null) {
        const kept = this.#memory.get(slot)
        if (kept === undefined)
          throw new Error(`block ${index} is held but its slot ${slot} is empty`)
        result.set(kept.subarray(from, to), at)
      } else {
        const sealed = new Uint8Array(span.end - span.start + SEAL_OVERHEAD)
        onFile('read a block', () => {
          const read = disk.file.read(sealed, { at: slot * SLOT_BYTES })
          if (read !== sealed.length) {
            throw new StoreError(
              'disk',
              `the private file gave ${read} of the ${sealed.length} bytes of block ${index}`,
            )
          }
        })
        sealedParts.push({ index, sealed, from, to, at })
      }
    }

    if (disk !== null) {
      await Promise.all(
        sealedParts.map(async (part) => {
          const plain = await openBlock(disk.key, part.index, part.sealed)
          result.set(plain.subarray(part.from, part.to), part.at)
        }),
      )
    }
    return result
  }

  setPosition(offset: number): void {
    this.#assertOpen()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.fileSize) {
      throw new RangeError(`${offset} is not a position in a file of ${this.fileSize} bytes`)
    }
    this.#position = offset
  }

  stats(): StoreStats {
    let storedBytes = 0
    for (const index of this.#slotOf.keys()) {
      const span = blockSpan(index, this.fileSize)
      storedBytes += span.end - span.start
    }
    return {
      backend: this.backend,
      capBytes: this.capBytes,
      storedBytes,
      evictedBytes: this.#evictedBytes,
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#held = new RangeSet()
    this.#slotOf.clear()
    this.#memory.clear()
    this.#frontier.clear()
    if (this.#disk !== null) {
      try {
        this.#disk.file.close()
      } catch {
        // The file is let go of whether or not it says so: the directory that holds it is deleted by the worker.
      }
    }
    return Promise.resolve()
  }
}

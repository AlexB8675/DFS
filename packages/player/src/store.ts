// The core of the player's store (DESIGN.md §10.4; the iron-clad spec §4.7): the
// slots that a play's blocks are kept in, the frontier of blocks that are still
// filling, and the writes and reads that join them. A slot holds one block, sealed
// in a private file or whole in memory. A write may land at any offset: its bytes
// go into a frontier block, and a block that has all its bytes goes to a free slot.
// A read joins the blocks in slots to the bytes in the frontier, so a block can be
// read from the moment its first byte is written. What the store holds is decided
// when a call is made and only the sealing is awaited, so that two writes cannot
// be given the same slot and a read cannot meet a change made after it started.
// When no slot is free, the settled block that is furthest from where the engine
// reads gives its slot to a block that is strictly nearer, and a frontier that is
// full of blocks still further lets go of them to take a write near the position.
// A block that waits for a slot answers `full` only while it is no further from the
// position than the first byte that is not held at or after it: a block beyond that
// gap is data the engine asked for ahead of the download (an index at the end of the
// file, say), it can only be placed once a settled block is further than it, and it
// must not stop the download from filling the gap nearer the position. It stays,
// held and readable, until it is placed or the frontier needs its place.
// All of this happens inside `write`, where the outcome can say what was let go of.

import type { ByteRange } from '@dfs/mp4'
import { blockOf, blockSpan } from './blocks.ts'
import { StoreError } from './errors.ts'
import { BLOCK_BYTES, FRONTIER_BLOCKS } from './limits.ts'
import { RangeSet } from './ranges.ts'
import { SEAL_OVERHEAD, openBlock, sealBlock } from './seal.ts'
import type { PlayKey } from './seal.ts'

/**
 * A write that the frontier refuses by its own rule: it holds blocks nearer the position than the write's, and has
 * no room for another. It is the store's rule and not a fault of the read, so the downloader ends that read quietly
 * (R48). A `RangeError`, as it was.
 */
export class FrontierFullError extends RangeError {}

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
  /** Whether a block that the write completed (or one that still waits) found no free slot and is no farther from the position than the first gap, so that the downloader should stop. */
  full: boolean
  /** How many bytes `evicted` covers (not those that were let go of and are held again: `stats()` counts those). */
  evictedBytes: number
  /**
   * The file ranges that were let go of and are still gone, in file order and joined
   * where they touch: those that earlier writes made and could not report because they
   * failed, and those that this write made to give a block a slot or to make room in
   * the frontier. Bytes that are held again when the write resolves are left out, and
   * so is a range that two writes let go of, which is in the list once.
   */
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
  /** Where the engine reads: only records it. Writes measure eviction from it, and never evict its block. */
  setPosition(offset: number): void
  stats(): StoreStats
  /** Deletes everything; later calls reject with StoreError('closed'). */
  close(): Promise<void>
}

/** The size of a slot on disk: a whole block and what sealing adds to it. */
const SLOT_BYTES = BLOCK_BYTES + SEAL_OVERHEAD

/** A block that is still filling, or that is complete and has no slot: none was free for it, or the write of its slot failed. */
interface FrontierBlock {
  /** The block's bytes, as long as the block is: the last block of a file is shorter than the others. */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** The bytes of the block that are present, from 0 at its first byte. */
  readonly have: RangeSet
  /** Whether a slot is chosen for it and its write to that slot has not finished. */
  pending: boolean
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

/** The answer of a block's write to its slot: null when it landed, or what it failed with. */
type SlotWrite = Promise<{ error: unknown } | null>

/** A frontier block that is to be given a slot, and the settled block whose slot it takes (null: a slot that is free). */
interface Placement {
  index: number
  victim: number | null
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
  readonly fileSize: number

  /** The file and the key of the play, or null for the memory backend. */
  readonly #disk: { file: SlotFile; key: PlayKey } | null
  /** How many slots the store has: its cap in blocks, which `shrinkToUsed` lowers. */
  #slotCount: number
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
  /** The first slot that was never used: the slots from here to the end are free (none, once the store has shrunk). */
  #unused = 0
  #evictedBytes = 0
  /** The ranges that eviction let go of in writes that then failed: a write that fails cannot say what it evicted, so the next one that succeeds does. */
  readonly #unreported: ByteRange[] = []
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
    this.#disk = backend.kind === 'disk' ? { file: backend.file, key: backend.key } : null
  }

  /** The most that the slots hold, in whole blocks. */
  get capBytes(): number {
    return this.#slotCount * BLOCK_BYTES
  }

  /** Where the engine last said that it reads. */
  get position(): number {
    return this.#position
  }

  /** Throws `closed` once the store is closed. */
  #assertOpen(): void {
    if (this.#closed) throw new StoreError('closed', 'the store is closed')
  }

  /** How many slots are free: those that were let go of and those that were never used. */
  #freeSlots(): number {
    return this.#freed.length + (this.#slotCount - this.#unused)
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

  /** Says how far a block is from the block that the engine reads, in blocks. The position may be the end of the file, where no block starts. */
  #distances(): (index: number) => number {
    const at = blockOf(this.#position)
    return (index) => Math.abs(index - at)
  }

  /** The blocks of the frontier that are complete and have no slot chosen: those that wait, and those that a write has just completed. */
  #complete(): number[] {
    const indexes: number[] = []
    for (const [index, block] of this.#frontier) {
      if (!block.pending && isComplete(block)) indexes.push(index)
    }
    return indexes
  }

  /**
   * Decides where the given complete blocks go, and changes nothing. A block takes a
   * free slot while there is one, nearest to the position first (and, among blocks
   * that are as near, the one ahead of the position, which is needed next). When
   * none is free it takes the slot of the settled block that is furthest from the
   * position, but only if that block is strictly further than it is (the one behind
   * the position first, among blocks as far as one another). The block of the position
   * is 0 away, which is never strictly further than another block, so it is never
   * evicted; and a block whose slot write is still in flight is not settled yet, so it
   * is never evicted either. Because the blocks come nearest first and the victims
   * furthest first, a block that finds no victim is followed by blocks that find none.
   */
  #plan(candidates: readonly number[]): Placement[] {
    const placements: Placement[] = []
    const away = this.#distances()
    const nearest = [...candidates].sort((a, b) => away(a) - away(b) || b - a)
    let free = this.#freeSlots()
    let settled: number[] | null = null
    let taken = 0
    for (const index of nearest) {
      if (free > 0) {
        free -= 1
        placements.push({ index, victim: null })
        continue
      }
      settled ??= [...this.#slotOf.keys()].sort((a, b) => away(b) - away(a) || a - b)
      const victim = settled[taken]
      if (victim !== undefined && away(victim) > away(index)) {
        taken += 1
        placements.push({ index, victim })
      } else {
        // This block and every one after it, which is no nearer, wait for the position to move or for a slot to be let go of.
        break
      }
    }
    return placements
  }

  /**
   * Which blocks the frontier lets go of to take a write that adds `added.length`
   * blocks to it, given that the plan for the blocks that wait is carried out first.
   * On disk a block that is given a slot stays in the frontier until its write lands,
   * and in memory it leaves at once. A block that can be let go of is not in flight,
   * is not one the write fills or the plan places, and is strictly further from the
   * position than every block the write adds: the furthest goes first, and the one
   * behind the position among blocks as far as one another. A write that cannot be
   * made to fit throws before anything is changed.
   */
  #planDrops(
    touched: readonly number[],
    added: readonly number[],
    placements: readonly Placement[],
    write: { offset: number; length: number },
  ): number[] {
    const leaving = this.#disk === null ? placements.length : 0
    const over = this.#frontier.size - leaving + added.length - FRONTIER_BLOCKS
    if (over <= 0) return []
    const away = this.#distances()
    const reach = Math.max(...added.map(away))
    const kept = new Set([...touched, ...placements.map((placement) => placement.index)])
    const droppable: number[] = []
    for (const [index, block] of this.#frontier) {
      if (!block.pending && !kept.has(index) && away(index) > reach) droppable.push(index)
    }
    if (droppable.length < over) {
      throw new FrontierFullError(
        `a write of ${write.length} bytes at ${write.offset} would add ${added.length} blocks to the ${this.#frontier.size} that the frontier holds, past its ${FRONTIER_BLOCKS}`,
      )
    }
    droppable.sort((a, b) => away(b) - away(a) || a - b)
    return droppable.slice(0, over)
  }

  /** Lets go of a settled block, in the store and in `held`, and answers the slot it had. */
  #evict(index: number, evicted: ByteRange[]): number {
    const slot = this.#slotOf.get(index)
    if (slot === undefined) throw new Error(`block ${index} is to be evicted and is in no slot`)
    const span = blockSpan(index, this.fileSize)
    this.#slotOf.delete(index)
    this.#memory.delete(slot)
    this.#held.remove(span)
    this.#evictedBytes += span.end - span.start
    evicted.push(span)
    return slot
  }

  /** Lets go of the bytes that a block of the frontier holds, in the store and in `held`. */
  #drop(index: number, evicted: ByteRange[]): void {
    const block = this.#frontier.get(index)
    if (block === undefined)
      throw new Error(`block ${index} is to be let go of and is not in the frontier`)
    const { start } = blockSpan(index, this.fileSize)
    for (const run of block.have.ranges()) {
      const range = { start: start + run.start, end: start + run.end }
      this.#held.remove(range)
      this.#evictedBytes += range.end - range.start
      evicted.push(range)
    }
    this.#frontier.delete(index)
  }

  /** Carries out a plan: each block that is placed gets its slot, and the settled block that had it is evicted. The others stay in the frontier. */
  #place(placements: readonly Placement[], evicted: ByteRange[], writes: SlotWrite[]): void {
    for (const { index, victim } of placements) {
      const block = this.#frontier.get(index)
      if (block === undefined)
        throw new Error(`block ${index} is to be placed and is not in the frontier`)
      const slot = victim === null ? this.#takeSlot() : this.#evict(victim, evicted)
      if (slot === null) throw new Error(`block ${index} was given a free slot and there is none`)
      if (this.#disk === null) {
        this.#settle(index, slot, block.bytes)
      } else {
        block.pending = true
        writes.push(this.#sealToSlot(this.#disk, index, slot, block))
      }
    }
  }

  /**
   * Whether a complete block waits in the frontier for a slot (one that found none, or one
   * whose slot write failed) and is no further from the position than the block of the
   * first byte, at or after the position, that is not held. A block beyond that gap does
   * not make the store full: it is data that was asked for ahead of the download, and the
   * download has the nearer gap to fill. When every byte from the position to the end of
   * the file is held there is no gap, and any waiting block makes the store full.
   */
  #isFull(): boolean {
    const waiting = this.#complete()
    if (waiting.length === 0) return false
    const gap = this.#held.firstGap(this.#position, this.fileSize)
    if (gap === null) return true
    const away = this.#distances()
    const nearest = away(blockOf(gap.start))
    return waiting.some((index) => away(index) <= nearest)
  }

  /** The block's place in its slot: it leaves the frontier, and the memory backend keeps its bytes as they are. */
  #settle(index: number, slot: number, kept: Uint8Array<ArrayBuffer> | null): void {
    this.#slotOf.set(index, slot)
    if (kept !== null) this.#memory.set(slot, kept)
    this.#frontier.delete(index)
  }

  /**
   * The parts of the given ranges that are not held now, in file order and joined where
   * they touch. The worker runs one request at a time, so at the moment a write resolves
   * the store stands as that write left it, and a range that is held then is not one that
   * the page should drop. A block that two failed writes let go of is in the list twice,
   * and is gone once.
   */
  #stillGone(ranges: readonly ByteRange[]): readonly ByteRange[] {
    const gone = new RangeSet()
    for (const range of ranges) {
      let from = range.start
      for (let gap = this.#held.firstGap(from, range.end); gap !== null;) {
        gone.add(gap)
        from = gap.end
        gap = this.#held.firstGap(from, range.end)
      }
    }
    return gone.ranges()
  }

  held(): RangeSet {
    const copy = new RangeSet()
    for (const range of this.#held.ranges()) copy.add(range)
    return copy
  }

  /**
   * Makes the store what the write and the position ask of it, all at the call, and
   * then waits for the sealing and the slot writes of the blocks on disk. First the
   * blocks that wait are given the slots that the position now allows, then the
   * bytes go into the frontier, then the blocks that are complete are given slots.
   * A block that finds no slot waits, and the answer is `full`. Everything is decided
   * before anything is changed, so that a write that is refused (`RangeError`) leaves
   * the store as it was. A write of no bytes, at any offset up to the end of the file,
   * only places the blocks that wait: it is how the downloader finds out, after the
   * position has moved, whether the store has room again. A write that fails on the
   * disk leaves its block in the frontier, held and readable and without a slot, which
   * is given back, and rejects: the next write places the block again, and reports
   * what this one evicted and could not report.
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

    // The blocks that the bytes go to are those that are not in a slot already: a block in a slot has all its bytes.
    const touched: number[] = []
    const added: number[] = []
    if (bytes.length > 0) {
      for (let index = blockOf(offset); index <= blockOf(end - 1); index += 1) {
        if (this.#slotOf.has(index)) continue
        touched.push(index)
        if (!this.#frontier.has(index)) added.push(index)
      }
    }
    const placements = this.#plan(this.#complete())
    const drops = this.#planDrops(touched, added, placements, { offset, length: bytes.length })

    const evicted: ByteRange[] = []
    const writes: SlotWrite[] = []
    this.#place(placements, evicted, writes)
    for (const index of drops) this.#drop(index, evicted)

    for (const index of touched) {
      // In memory, a block that was waiting has just settled in a slot, and has all its bytes.
      if (this.#slotOf.has(index)) continue
      const span = blockSpan(index, this.fileSize)
      let block = this.#frontier.get(index)
      if (block === undefined) {
        block = {
          bytes: new Uint8Array(span.end - span.start),
          have: new RangeSet(),
          pending: false,
        }
        this.#frontier.set(index, block)
      }
      const from = Math.max(offset, span.start)
      const to = Math.min(end, span.end)
      block.bytes.set(bytes.subarray(from - offset, to - offset), from - span.start)
      block.have.add({ start: from - span.start, end: to - span.start })
      this.#held.add({ start: from, end: to })
    }

    // Each block that the bytes completed is given a slot now, before anything is awaited, nearest to the position first.
    this.#place(this.#plan(this.#complete()), evicted, writes)

    // Each write of a slot answers for itself, so that when this call settles every block has either landed or gone back to the frontier.
    const failure = (await Promise.all(writes)).find(
      (result): result is { error: unknown } => result !== null,
    )
    if (failure !== undefined) {
      this.#unreported.push(...evicted)
      throw failure.error
    }
    // What a write that failed evicted is reported when this one resolves, and not when it began, so that a write that fails meanwhile is not lost.
    // What is held again by now (a block written anew after its eviction) is not reported: it is not gone.
    const reported = this.#stillGone([...this.#unreported.splice(0), ...evicted])
    return {
      full: this.#isFull(),
      evictedBytes: reported.reduce((sum, range) => sum + range.end - range.start, 0),
      evicted: reported,
    }
  }

  /**
   * Seals a complete block and writes it to its slot, and answers what it failed
   * with (and gives its slot back, and makes the block wait to be placed again) or null.
   */
  async #sealToSlot(
    disk: { file: SlotFile; key: PlayKey },
    index: number,
    slot: number,
    block: FrontierBlock,
  ): SlotWrite {
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
        // The block is complete and has no slot, so every later write tries to place it again, as it does for a block that found none.
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

  /**
   * Makes the slots that hold a block the store's cap, for a disk that has no room for
   * more (the iron-clad spec §4.7): the slots that are free are not taken again, and none
   * that was never used is, so a block that finds no slot waits, or takes the slot of a
   * block that is further from the position than it is, as it does in a full store. A slot
   * is in use when a settled block has it or when the write of a block to it is in flight,
   * and a slot that a write in flight then gives back is within the cap, so it is taken
   * again. Answers the new cap, which is nothing when no block holds a slot.
   */
  shrinkToUsed(): number {
    this.#assertOpen()
    let writing = 0
    for (const block of this.#frontier.values()) {
      if (block.pending) writing += 1
    }
    this.#slotCount = this.#slotOf.size + writing
    this.#unused = this.#slotCount
    this.#freed.length = 0
    return this.capBytes
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
    this.#unreported.length = 0
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

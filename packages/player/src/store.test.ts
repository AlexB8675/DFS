import { describe, expect, it } from 'vitest'
import { StoreError } from './errors.ts'
import type { StoreErrorKind } from './errors.ts'
import { BLOCK_BYTES, FRONTIER_BLOCKS } from './limits.ts'
import { SEAL_OVERHEAD, newPlayKey, openBlock } from './seal.ts'
import type { PlayKey } from './seal.ts'
import { CoreStore } from './store.ts'
import type { WriteOutcome } from './store.ts'
import { TestSlotFile } from './testing/slot-file.ts'

// The store keeps a play's blocks in slots, sealed in a private file or whole in
// memory, and the blocks that are still filling in a small frontier where they
// can already be read (DESIGN.md §10.4; the iron-clad spec §4.7). A write may land
// at any offset, a read joins slot blocks and frontier bytes, and a block that
// finds no slot takes the slot of the block that is furthest from the position,
// if that block is strictly further than it, and waits in the frontier otherwise.

const MIB = BLOCK_BYTES

/** The size of a slot on disk: a whole block and what sealing adds to it. */
const SLOT_BYTES = BLOCK_BYTES + SEAL_OVERHEAD

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same bytes on every run and every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** `length` bytes from a seed, the same on every run. */
function bytesOf(seed: number, length: number): Uint8Array<ArrayBuffer> {
  const next = generator(seed)
  const bytes = new Uint8Array(length)
  for (let at = 0; at < length; at += 1) bytes[at] = Math.floor(next() * 256)
  return bytes
}

/** The content of the files that the tests play: byte `n` of any of them is `CONTENT[n]`. It reaches block 31, so that a seek can go far. */
const CONTENT = bytesOf(7, 32 * MIB)

/** `length` bytes that are not those of `CONTENT`, for a write that must change nothing. */
function otherThan(length: number): Uint8Array<ArrayBuffer> {
  return bytesOf(99, length)
}

/** Block `index` of `CONTENT`, whole. */
function plainBlock(index: number): Uint8Array<ArrayBuffer> {
  return CONTENT.subarray(index * MIB, (index + 1) * MIB)
}

/** Expects `actual` to be bytes, equal to `expected` (compared whole, so that a failure doesn't print a megabyte). */
function expectSame(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull()
  if (actual === null) return
  expect(actual.length).toBe(expected.length)
  expect(Buffer.compare(actual, expected)).toBe(0)
}

/** The error that `attempt` fails with, or a failure of the test if it succeeds. */
async function failureOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt
  } catch (error) {
    return error
  }
  throw new Error('the attempt was expected to fail and did not')
}

/** Expects `attempt` to fail as a `StoreError` of the given kind. */
async function expectStoreError(attempt: Promise<unknown>, kind: StoreErrorKind): Promise<void> {
  const error = await failureOf(attempt)
  expect(error).toBeInstanceOf(StoreError)
  expect((error as StoreError).kind).toBe(kind)
}

/** Expects `attempt` to fail as a `RangeError`. */
async function expectRangeError(attempt: Promise<unknown>): Promise<void> {
  expect(await failureOf(attempt)).toBeInstanceOf(RangeError)
}

type Kind = 'disk' | 'memory'

interface DiskRig {
  store: CoreStore
  file: TestSlotFile
  key: PlayKey
}

/** A store on a test file, sealed under a new key, and what it was built from. */
async function diskRig(
  fileSize: number,
  capBytes: number,
  file: TestSlotFile = new TestSlotFile(),
): Promise<DiskRig> {
  const key = await newPlayKey()
  const store = new CoreStore({ backend: { kind: 'disk', file, key }, fileSize, capBytes })
  return { store, file, key }
}

/** The file range of blocks `from` up to, not including, `to`. */
function blocks(from: number, to: number): { start: number; end: number } {
  return { start: from * MIB, end: to * MIB }
}

/** Writes each of the given blocks of `CONTENT` whole, one write after another, and answers what each said. */
async function writeBlocks(store: CoreStore, ...indexes: number[]): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = []
  for (const index of indexes) outcomes.push(await store.write(index * MIB, plainBlock(index)))
  return outcomes
}

/** Writes the first 100 bytes of each of the given blocks of `CONTENT`, so that each is started and none is complete. */
async function startBlocks(store: CoreStore, ...indexes: number[]): Promise<void> {
  for (const index of indexes) {
    await store.write(index * MIB, CONTENT.subarray(index * MIB, index * MIB + 100))
  }
}

/** A write of no bytes, which only asks the store to place the blocks that wait. */
const NOTHING = new Uint8Array(0)

/** A store on the given backend. */
async function rigOf(
  kind: Kind,
  fileSize: number,
  capBytes: number,
): Promise<{ store: CoreStore }> {
  if (kind === 'memory') {
    return { store: new CoreStore({ backend: { kind: 'memory' }, fileSize, capBytes }) }
  }
  return diskRig(fileSize, capBytes)
}

describe.each(['disk', 'memory'] as const)('the store on the %s backend', (kind) => {
  describe('writes and reads', () => {
    it('reads back 3.5 MiB written in 64 KiB pieces, and holds it as one range', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 8 * MIB)
      const size = 3.5 * MIB
      for (let at = 0; at < size; at += 64 * 1024) {
        const outcome = await store.write(at, CONTENT.subarray(at, at + 64 * 1024))
        expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
      }
      expect(store.held().ranges()).toEqual([{ start: 0, end: size }])
      expectSame(await store.read(0, size), CONTENT.subarray(0, size))
      // Ranges inside a slot block, across slot blocks, across the last slot block and the frontier, and inside the frontier.
      const ranges = [
        [0, 1],
        [MIB - 5, MIB + 5],
        [1.25 * MIB, 3.25 * MIB],
        [2.5 * MIB, size],
        [3 * MIB, size],
        [size - 1, size],
      ] as const
      for (const [start, end] of ranges) {
        expectSame(await store.read(start, end), CONTENT.subarray(start, end))
      }
      // Three whole blocks have left the frontier for slots, and the half block still fills.
      expect(store.stats().storedBytes).toBe(3 * MIB)
    })

    it('reads the bytes of a block before the block is complete', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, CONTENT.subarray(0, 100))
      expectSame(await store.read(0, 100), CONTENT.subarray(0, 100))
      expectSame(await store.read(40, 60), CONTENT.subarray(40, 60))
      expect(await store.read(0, 101)).toBeNull()
      expect(store.held().ranges()).toEqual([{ start: 0, end: 100 }])
    })

    it('fills a block from pieces that come in any order', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(MIB / 2, CONTENT.subarray(MIB / 2, MIB))
      expect(store.held().ranges()).toEqual([{ start: MIB / 2, end: MIB }])
      expect(store.stats().storedBytes).toBe(0)
      await store.write(0, CONTENT.subarray(0, MIB / 2))
      expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
      expect(store.stats().storedBytes).toBe(MIB)
      expectSame(await store.read(0, MIB), plainBlock(0))
    })

    it('takes a write that crosses the edge of a block', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(MIB - 50, CONTENT.subarray(MIB - 50, MIB + 50))
      expect(store.held().ranges()).toEqual([{ start: MIB - 50, end: MIB + 50 }])
      expectSame(await store.read(MIB - 50, MIB + 50), CONTENT.subarray(MIB - 50, MIB + 50))
      expectSame(await store.read(MIB - 10, MIB + 10), CONTENT.subarray(MIB - 10, MIB + 10))
    })

    it('takes the same bytes again without changing anything', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, CONTENT.subarray(0, 100))
      await store.write(0, CONTENT.subarray(0, 100))
      await store.write(50, CONTENT.subarray(50, 150))
      expect(store.held().ranges()).toEqual([{ start: 0, end: 150 }])
      expectSame(await store.read(0, 150), CONTENT.subarray(0, 150))
    })

    it('skips the bytes of a block that is already in a slot', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, plainBlock(0))
      // A write that spans a block in a slot and a block that is new takes only the new one.
      await store.write(MIB - 100, otherThan(300))
      await store.write(0, otherThan(100))
      expectSame(await store.read(0, MIB), plainBlock(0))
      expect(store.held().ranges()).toEqual([{ start: 0, end: MIB + 200 }])
      expectSame(await store.read(MIB, MIB + 200), otherThan(300).subarray(100))
    })

    it('does nothing for a write of no bytes', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      expect(await store.write(10, new Uint8Array(0))).toEqual({
        full: false,
        evictedBytes: 0,
        evicted: [],
      })
      expect(await store.write(4 * MIB, new Uint8Array(0))).toEqual({
        full: false,
        evictedBytes: 0,
        evicted: [],
      })
      expect(store.held().ranges()).toEqual([])
    })

    it('copies the bytes it is given, so that the caller may use its buffer again', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      const buffer = CONTENT.slice(0, 100)
      await store.write(0, buffer)
      buffer.fill(0)
      expectSame(await store.read(0, 100), CONTENT.subarray(0, 100))
    })

    it('gives a read bytes of its own', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, plainBlock(0))
      const first = await store.read(0, 100)
      expect(first).not.toBeNull()
      first?.fill(0)
      expectSame(await store.read(0, 100), CONTENT.subarray(0, 100))
    })

    it('reads an empty range as no bytes', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      const empty = await store.read(5, 5)
      expect(empty).not.toBeNull()
      expect(empty?.length).toBe(0)
    })
  })

  describe('what is not held', () => {
    it('answers null for a range that is not wholly held', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      expect(await store.read(0, 1)).toBeNull()
      await store.write(100, CONTENT.subarray(100, 200))
      expect(await store.read(0, 200)).toBeNull()
      expect(await store.read(99, 200)).toBeNull()
      expect(await store.read(100, 201)).toBeNull()
      expect(await store.read(500, 600)).toBeNull()
      expectSame(await store.read(100, 200), CONTENT.subarray(100, 200))
    })

    it('answers null for a range that goes past the end of the file', async () => {
      const { store } = await rigOf(kind, 2 * MIB, 4 * MIB)
      await store.write(0, CONTENT.subarray(0, 2 * MIB))
      expect(await store.read(2 * MIB - 1, 2 * MIB + 1)).toBeNull()
      expect(await store.read(3 * MIB, 3 * MIB + 10)).toBeNull()
      expectSame(await store.read(2 * MIB - 1, 2 * MIB), CONTENT.subarray(2 * MIB - 1, 2 * MIB))
    })

    it('refuses a range that is not a range of a file', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await expectRangeError(store.read(-1, 10))
      await expectRangeError(store.read(0.5, 10))
      await expectRangeError(store.read(0, 10.5))
      await expectRangeError(store.read(10, 5))
      await expectRangeError(store.read(0, Number.NaN))
    })
  })

  describe('writes that are refused', () => {
    it('refuses a write past the end of the file, and takes none of it', async () => {
      const { store } = await rigOf(kind, 2 * MIB, 4 * MIB)
      // The first 10 bytes of this write are inside the file, and must not be kept.
      await expectRangeError(store.write(2 * MIB - 10, CONTENT.subarray(0, 20)))
      await expectRangeError(store.write(2 * MIB + 1, CONTENT.subarray(0, 1)))
      await expectRangeError(store.write(5 * MIB, CONTENT.subarray(0, 1)))
      expect(store.held().ranges()).toEqual([])
      expect(await store.read(2 * MIB - 10, 2 * MIB)).toBeNull()
      expect(store.stats().storedBytes).toBe(0)
    })

    it('refuses an offset that is negative or not a whole number', async () => {
      const { store } = await rigOf(kind, 2 * MIB, 4 * MIB)
      await expectRangeError(store.write(-1, CONTENT.subarray(0, 10)))
      await expectRangeError(store.write(1.5, CONTENT.subarray(0, 10)))
      await expectRangeError(store.write(Number.NaN, CONTENT.subarray(0, 10)))
      expect(store.held().ranges()).toEqual([])
    })
  })

  describe('the last block', () => {
    it('fills three blocks of a file of 2.5 MiB, the last of half a MiB, and reads them back', async () => {
      const size = 2.5 * MIB
      const { store } = await rigOf(kind, size, 4 * MIB)
      const outcome = await store.write(0, CONTENT.subarray(0, size))
      expect(outcome.full).toBe(false)
      expect(store.held().ranges()).toEqual([{ start: 0, end: size }])
      expect(store.stats().storedBytes).toBe(size)
      expectSame(await store.read(0, size), CONTENT.subarray(0, size))
      expectSame(await store.read(2 * MIB, size), CONTENT.subarray(2 * MIB, size))
      expectSame(await store.read(size - 1, size), CONTENT.subarray(size - 1, size))
    })

    it('fills the last block alone, with the file ending inside it', async () => {
      const size = 2.5 * MIB
      const { store } = await rigOf(kind, size, MIB)
      const outcome = await store.write(2 * MIB, CONTENT.subarray(2 * MIB, size))
      expect(outcome.full).toBe(false)
      expect(store.stats().storedBytes).toBe(MIB / 2)
      expectSame(await store.read(2 * MIB, size), CONTENT.subarray(2 * MIB, size))
    })
  })

  describe('a full store', () => {
    it('answers full when a completed block finds no slot, and still reads that block', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      expect((await store.write(0, plainBlock(0))).full).toBe(false)
      expect((await store.write(MIB, plainBlock(1))).full).toBe(false)
      const third = await store.write(2 * MIB, plainBlock(2))
      expect(third).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      // The third block waits in the frontier, held and readable, outside the cap.
      expect(store.held().ranges()).toEqual([{ start: 0, end: 3 * MIB }])
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expectSame(await store.read(2 * MIB, 3 * MIB), plainBlock(2))
      expectSame(await store.read(0, 3 * MIB), CONTENT.subarray(0, 3 * MIB))
    })

    it('goes on answering full while a completed block waits for a slot', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      await store.write(0, CONTENT.subarray(0, 3 * MIB))
      const next = await store.write(3 * MIB, CONTENT.subarray(3 * MIB, 3 * MIB + 100))
      expect(next.full).toBe(true)
      expectSame(await store.read(3 * MIB, 3 * MIB + 100), CONTENT.subarray(3 * MIB, 3 * MIB + 100))
    })

    it('answers full for a write of three whole blocks into a store of two', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      const outcome = await store.write(0, CONTENT.subarray(0, 3 * MIB))
      expect(outcome.full).toBe(true)
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expectSame(await store.read(0, 3 * MIB), CONTENT.subarray(0, 3 * MIB))
    })
  })

  describe('the frontier', () => {
    it('never holds more than the blocks the plan allows, and refuses a write that would add one', async () => {
      const last = (FRONTIER_BLOCKS - 1) * MIB
      const over = FRONTIER_BLOCKS * MIB
      // The file is longer than the frontier, so that a refusal is the frontier's and not the end of the file's.
      const { store } = await rigOf(kind, (FRONTIER_BLOCKS + 2) * MIB, (FRONTIER_BLOCKS + 2) * MIB)
      // As many blocks as the frontier holds, each started and none complete, fill it.
      for (let index = 0; index < FRONTIER_BLOCKS; index += 1) {
        await store.write(index * MIB, CONTENT.subarray(index * MIB, index * MIB + 100))
      }
      const before = store.held().ranges()
      expect(before).toHaveLength(FRONTIER_BLOCKS)

      // One block more is refused whole.
      await expectRangeError(store.write(over, CONTENT.subarray(over, over + 100)))
      expect(store.held().ranges()).toEqual(before)

      // A write that overlaps held bytes of the last block the frontier holds and reaches into the next is refused too, and does not change the last.
      const straddle = otherThan(MIB)
      await expectRangeError(store.write(last + 50, straddle))
      expect(store.held().ranges()).toEqual(before)
      expectSame(await store.read(last, last + 100), CONTENT.subarray(last, last + 100))
      expect(await store.read(over, over + 10)).toBeNull()

      // A block that completes leaves the frontier for its slot, and then there is room for another.
      await store.write(0, plainBlock(0))
      expect(store.stats().storedBytes).toBe(MIB)
      await store.write(over, CONTENT.subarray(over, over + 100))
      expectSame(await store.read(over, over + 100), CONTENT.subarray(over, over + 100))
    })

    it('takes a write of as many new blocks as the frontier holds, and refuses one more', async () => {
      // The file is longer than the write, so that the refusal is the frontier's.
      const { store } = await rigOf(kind, (FRONTIER_BLOCKS + 2) * MIB, (FRONTIER_BLOCKS + 2) * MIB)
      await expectRangeError(store.write(0, CONTENT.subarray(0, (FRONTIER_BLOCKS + 1) * MIB)))
      expect(store.held().ranges()).toEqual([])
      expect(store.stats().storedBytes).toBe(0)
      const outcome = await store.write(0, CONTENT.subarray(0, FRONTIER_BLOCKS * MIB))
      expect(outcome.full).toBe(false)
      expect(store.stats().storedBytes).toBe(FRONTIER_BLOCKS * MIB)
    })

    it('counts blocks that wait for a slot against the frontier', async () => {
      const { store } = await rigOf(kind, (FRONTIER_BLOCKS + 2) * MIB, MIB)
      const started = FRONTIER_BLOCKS * MIB
      // One slot: the first block takes it, and the next ones wait in the frontier. A block just started makes as many as the frontier holds.
      await store.write(0, CONTENT.subarray(0, started))
      await store.write(started, CONTENT.subarray(started, started + 100))
      await expectRangeError(
        store.write(started + MIB, CONTENT.subarray(started + MIB, started + MIB + 100)),
      )
      expect(store.held().ranges()).toEqual([{ start: 0, end: started + 100 }])
    })
  })

  describe('concurrent writes', () => {
    it('gives two writes that each complete a block different slots', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      const first = store.write(0, plainBlock(0))
      const second = store.write(MIB, plainBlock(1))
      const outcomes = await Promise.all([first, second])
      expect(outcomes.map((outcome) => outcome.full)).toEqual([false, false])
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expectSame(await store.read(0, MIB), plainBlock(0))
      expectSame(await store.read(MIB, 2 * MIB), plainBlock(1))
      expectSame(await store.read(0, 2 * MIB), CONTENT.subarray(0, 2 * MIB))
    })

    it('reads a block that is being written, from the frontier, while its write is in flight', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      const writing = store.write(0, plainBlock(0))
      const reading = store.read(0, 100)
      expectSame(await reading, CONTENT.subarray(0, 100))
      await writing
      expectSame(await store.read(0, 100), CONTENT.subarray(0, 100))
    })

    it('does not give a block a second slot when it is written again while its first write is in flight', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
      const first = store.write(0, plainBlock(0))
      const again = store.write(0, plainBlock(0))
      await Promise.all([first, again])
      expect(store.stats().storedBytes).toBe(MIB)
      // The slot that a second claim would have taken is still free for the next block.
      const next = await store.write(MIB, plainBlock(1))
      expect(next.full).toBe(false)
      const last = await store.write(2 * MIB, plainBlock(2))
      expect(last.full).toBe(true)
      expectSame(await store.read(0, 2 * MIB), CONTENT.subarray(0, 2 * MIB))
    })

    it('takes the bytes of a read in the call, so that a later write cannot change them', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, CONTENT.subarray(0, 100))
      const reading = store.read(0, 100)
      await store.write(0, otherThan(100))
      expectSame(await reading, CONTENT.subarray(0, 100))
    })
  })

  describe('position', () => {
    it('records the position the engine reads at', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      expect(store.position).toBe(0)
      store.setPosition(2 * MIB + 7)
      expect(store.position).toBe(2 * MIB + 7)
      store.setPosition(4 * MIB)
      expect(store.position).toBe(4 * MIB)
    })

    it('refuses a position that is not in the file', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      expect(() => {
        store.setPosition(-1)
      }).toThrow(RangeError)
      expect(() => {
        store.setPosition(1.5)
      }).toThrow(RangeError)
      expect(() => {
        store.setPosition(4 * MIB + 1)
      }).toThrow(RangeError)
      expect(() => {
        store.setPosition(Number.NaN)
      }).toThrow(RangeError)
      expect(store.position).toBe(0)
    })
  })

  describe('eviction', () => {
    it('evicts nothing when every block written is further than those held', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      const outcomes = await writeBlocks(store, 0, 1, 2, 3, 4, 5)
      expect(outcomes.map((outcome) => outcome.full)).toEqual([
        false,
        false,
        false,
        false,
        true,
        true,
      ])
      for (const outcome of outcomes) expect(outcome.evicted).toEqual([])
      expect(outcomes.map((outcome) => outcome.evictedBytes)).toEqual([0, 0, 0, 0, 0, 0])
      expect(store.held().ranges()).toEqual([blocks(0, 6)])
      expect(store.stats().storedBytes).toBe(4 * MIB)
      expect(store.stats().evictedBytes).toBe(0)
    })

    it('frees what was played when the position moves on, at the next write', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      const outcomes = await writeBlocks(store, 0, 1, 2, 3, 4)
      expect(outcomes[4]?.full).toBe(true)

      // The position only records itself: nothing is placed or evicted until a write is made.
      store.setPosition(3 * MIB)
      expect(store.held().ranges()).toEqual([blocks(0, 5)])
      expect(store.stats().evictedBytes).toBe(0)

      const outcome = await store.write(3 * MIB, NOTHING)
      expect(outcome).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.held().ranges()).toEqual([blocks(1, 5)])
      expect(await store.read(0, 1)).toBeNull()
      // Block 4 took the slot of block 0, and reads back.
      expectSame(await store.read(4 * MIB, 5 * MIB), plainBlock(4))
      expectSame(await store.read(MIB, 5 * MIB), CONTENT.subarray(MIB, 5 * MIB))
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 4 * MIB,
        storedBytes: 4 * MIB,
        evictedBytes: MIB,
        droppedBytes: 0,
      })
    })

    it('keeps a block that is as near as the one that waits, and one that is nearer', async () => {
      const { store } = await rigOf(kind, 16 * MIB, 4 * MIB)
      store.setPosition(10 * MIB)
      await writeBlocks(store, 8, 9, 10, 11)
      // Block 12 is 2 away, as block 8 is: block 8 is not strictly further, so it stays and block 12 waits.
      const twelve = await store.write(12 * MIB, plainBlock(12))
      expect(twelve).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      // Block 13 is 3 away, which is further than block 8.
      const thirteen = await store.write(13 * MIB, plainBlock(13))
      expect(thirteen).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.held().ranges()).toEqual([blocks(8, 14)])
      expectSame(await store.read(8 * MIB, 9 * MIB), plainBlock(8))
      expect(store.stats().evictedBytes).toBe(0)
    })

    it('never evicts the block the engine reads', async () => {
      // One slot, taken by the position's own block: a block 1 away is not nearer than a block 0 away.
      const { store } = await rigOf(kind, 16 * MIB, MIB)
      store.setPosition(5 * MIB + 100)
      await writeBlocks(store, 5)
      const outcome = await store.write(6 * MIB, plainBlock(6))
      expect(outcome).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.held().ranges()).toEqual([blocks(5, 7)])
      expectSame(await store.read(5 * MIB, 6 * MIB), plainBlock(5))
    })

    it('evicts the block behind the position first when two are as far as one another', async () => {
      const { store } = await rigOf(kind, 16 * MIB, 2 * MIB)
      store.setPosition(5 * MIB)
      await writeBlocks(store, 3, 7)
      // Blocks 3 and 7 are both 2 away, and block 4 is 1 away: block 3, behind the position, goes first.
      const outcome = await store.write(4 * MIB, plainBlock(4))
      expect(outcome).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(3, 4)] })
      expect(store.held().ranges()).toEqual([blocks(4, 5), blocks(7, 8)])
      expectSame(await store.read(7 * MIB, 8 * MIB), plainBlock(7))
    })

    it('frees the farthest first after a seek back, one block for each write', async () => {
      const { store } = await rigOf(kind, 24 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1, 2, 3)
      store.setPosition(20 * MIB)
      const outcomes = await writeBlocks(store, 20, 21, 22, 23)
      expect(outcomes.map((outcome) => outcome.full)).toEqual([false, false, false, false])
      expect(outcomes.map((outcome) => outcome.evicted)).toEqual([
        [blocks(0, 1)],
        [blocks(1, 2)],
        [blocks(2, 3)],
        [blocks(3, 4)],
      ])
      expect(store.held().ranges()).toEqual([blocks(20, 24)])
      expectSame(await store.read(20 * MIB, 24 * MIB), CONTENT.subarray(20 * MIB, 24 * MIB))
      const total = outcomes.reduce((sum, outcome) => sum + outcome.evictedBytes, 0)
      expect(total).toBe(4 * MIB)
      expect(store.stats().evictedBytes).toBe(total)
      expect(store.stats().storedBytes).toBe(4 * MIB)
    })

    it('frees the farthest first for a write of four blocks after a seek back', async () => {
      const { store } = await rigOf(kind, 24 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1, 2, 3)
      store.setPosition(20 * MIB)
      const outcome = await store.write(20 * MIB, CONTENT.subarray(20 * MIB, 24 * MIB))
      expect(outcome).toEqual({
        full: false,
        evictedBytes: 4 * MIB,
        // The four blocks touch, so they are one range (the order they were freed in is the one the test above checks).
        evicted: [blocks(0, 4)],
      })
      expectSame(await store.read(20 * MIB, 24 * MIB), CONTENT.subarray(20 * MIB, 24 * MIB))
      expect(store.stats().evictedBytes).toBe(4 * MIB)
    })

    it('gives two writes that are made together different blocks to evict', async () => {
      const { store } = await rigOf(kind, 24 * MIB, 2 * MIB)
      await writeBlocks(store, 0, 1)
      store.setPosition(20 * MIB)
      const outcomes = await Promise.all([
        store.write(20 * MIB, plainBlock(20)),
        store.write(21 * MIB, plainBlock(21)),
      ])
      expect(outcomes.map((outcome) => outcome.evicted)).toEqual([[blocks(0, 1)], [blocks(1, 2)]])
      expectSame(await store.read(20 * MIB, 22 * MIB), CONTENT.subarray(20 * MIB, 22 * MIB))
      expect(store.held().ranges()).toEqual([blocks(20, 22)])
    })

    it('reports a last block that is evicted at its own length', async () => {
      const size = 2.5 * MIB
      const { store } = await rigOf(kind, size, MIB)
      await store.write(2 * MIB, CONTENT.subarray(2 * MIB, size))
      expect(store.stats().storedBytes).toBe(MIB / 2)
      const outcome = await store.write(0, plainBlock(0))
      expect(outcome).toEqual({
        full: false,
        evictedBytes: MIB / 2,
        evicted: [{ start: 2 * MIB, end: size }],
      })
      expect(store.stats().evictedBytes).toBe(MIB / 2)
      expect(store.held().ranges()).toEqual([blocks(0, 1)])
    })

    it('lets a read that began finish with its bytes, though its block is evicted after', async () => {
      const { store } = await rigOf(kind, 4 * MIB, MIB)
      await writeBlocks(store, 0)
      const reading = store.read(0, 100)
      store.setPosition(3 * MIB)
      await writeBlocks(store, 3)
      expect(await store.read(0, 100)).toBeNull()
      expectSame(await reading, CONTENT.subarray(0, 100))
    })

    describe('placing the blocks that wait', () => {
      it('places the nearest first', async () => {
        const { store } = await rigOf(kind, 8 * MIB, MIB)
        // Block 0 holds the only slot, and blocks 1 to 3 wait for it.
        await writeBlocks(store, 0, 1, 2, 3)
        store.setPosition(3 * MIB)
        const first = await store.write(3 * MIB, NOTHING)
        expect(first).toEqual({ full: true, evictedBytes: MIB, evicted: [blocks(0, 1)] })
        // Block 3 took the slot, and not block 1 (the first by index): with the position on block 1,
        // block 1 takes the slot from block 3, which is 2 away.
        store.setPosition(MIB)
        const second = await store.write(MIB, NOTHING)
        expect(second).toEqual({ full: true, evictedBytes: MIB, evicted: [blocks(3, 4)] })
      })

      it('places the one ahead of the position before one behind it that is as near', async () => {
        const { store } = await rigOf(kind, 16 * MIB, MIB)
        await writeBlocks(store, 0, 7, 11)
        store.setPosition(9 * MIB)
        // Blocks 7 and 11 are both 2 away, and block 0 is 9 away: block 11, ahead, takes its slot.
        // Block 7 waits on, and it is farther than the first gap, at block 9 itself, so the store is not full.
        const first = await store.write(9 * MIB, NOTHING)
        expect(first).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
        // With the position on block 7, block 7 takes the slot from block 11, which is 4 away.
        store.setPosition(7 * MIB)
        const second = await store.write(7 * MIB, NOTHING)
        expect(second).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(11, 12)] })
      })

      it('places the waiting blocks when the position is at the end of the file', async () => {
        const { store } = await rigOf(kind, 4 * MIB, 2 * MIB)
        await writeBlocks(store, 0, 1, 2, 3)
        store.setPosition(4 * MIB)
        // No block starts at the end of the file, so the position has no block of its own: the distance still counts from 4.
        const outcome = await store.write(4 * MIB, NOTHING)
        expect(outcome).toEqual({
          full: false,
          evictedBytes: 2 * MIB,
          evicted: [blocks(0, 2)],
        })
        expect(store.held().ranges()).toEqual([blocks(2, 4)])
        expectSame(await store.read(2 * MIB, 4 * MIB), CONTENT.subarray(2 * MIB, 4 * MIB))
      })

      it('answers full again when a write of no bytes finds the waiting blocks still without a slot', async () => {
        const { store } = await rigOf(kind, 8 * MIB, 2 * MIB)
        await writeBlocks(store, 0, 1, 2)
        expect(await store.write(0, NOTHING)).toEqual({ full: true, evictedBytes: 0, evicted: [] })
        expect(store.held().ranges()).toEqual([blocks(0, 3)])
      })
    })

    describe('a seek out of a full store', () => {
      /**
       * A store of 8 blocks over a file of 32, as a download leaves it after a seek: it filled from the
       * start (blocks 0 to 7 in the slots, block 8 waiting), the position went to block 20, and the fill
       * went on there until block 28 found no slot again. The position is at block 20.
       */
      async function fullAtTwenty(): Promise<{ store: CoreStore }> {
        const { store } = await rigOf(kind, 32 * MIB, 8 * MIB)
        const filled = await writeBlocks(store, 0, 1, 2, 3, 4, 5, 6, 7, 8)
        expect(filled.map((outcome) => outcome.full)).toEqual([
          ...Array.from({ length: 8 }, () => false),
          true,
        ])
        // Block 8 is nearer to block 20 than block 0 is, so it takes that slot: the waiting block is placed before anything else.
        store.setPosition(20 * MIB)
        expect(await store.write(20 * MIB, NOTHING)).toEqual({
          full: false,
          evictedBytes: MIB,
          evicted: [blocks(0, 1)],
        })
        const fill = await writeBlocks(store, 20, 21, 22, 23, 24, 25, 26, 27, 28)
        expect(fill.map((outcome) => outcome.full)).toEqual([
          ...Array.from({ length: 8 }, () => false),
          true,
        ])
        // Each block of the fill took the slot of the block farthest from block 20, from block 1 to block 8.
        expect(fill.slice(0, 8).map((outcome) => outcome.evicted)).toEqual(
          Array.from({ length: 8 }, (_, index) => [blocks(1 + index, 2 + index)]),
        )
        expect(store.held().ranges()).toEqual([blocks(20, 29)])
        expect(store.stats().evictedBytes).toBe(9 * MIB)
        return { store }
      }

      it('keeps the waiting block that is farthest from a seek back, and does not count it as full', async () => {
        const { store } = await fullAtTwenty()
        // The gap at block 5 is nearer than block 28 is, and block 28 can only take a slot once a block is farther than it: none will be. It stays, held and readable, and the store is not full on its account, so that the download goes on at the seek.
        store.setPosition(5 * MIB)
        const check = await store.write(5 * MIB, NOTHING)
        expect(check).toEqual({ full: false, evictedBytes: 0, evicted: [] })
        expect(store.held().ranges()).toEqual([blocks(20, 29)])
        expectSame(await store.read(28 * MIB, 29 * MIB), plainBlock(28))
        expect(store.stats().evictedBytes).toBe(9 * MIB)

        // The fill goes on at the seek, and block 5 takes the slot of the block farthest from it; block 28 still waits.
        const next = await store.write(5 * MIB, plainBlock(5))
        expect(next).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(27, 28)] })
        expect(store.held().ranges()).toEqual([blocks(5, 6), blocks(20, 27), blocks(28, 29)])
        expectSame(await store.read(5 * MIB, 6 * MIB), plainBlock(5))
        expectSame(await store.read(28 * MIB, 29 * MIB), plainBlock(28))
      })

      it('does not count it for a write that brings bytes as well', async () => {
        const { store } = await fullAtTwenty()
        store.setPosition(5 * MIB)
        const piece = CONTENT.subarray(5 * MIB, 5 * MIB + 100)
        const outcome = await store.write(5 * MIB, piece)
        expect(outcome).toEqual({ full: false, evictedBytes: 0, evicted: [] })
        expect(store.held().ranges()).toEqual([
          { start: 5 * MIB, end: 5 * MIB + 100 },
          blocks(20, 29),
        ])
        expectSame(await store.read(5 * MIB, 5 * MIB + 100), piece)
      })

      it('lets go of the far waiting block when the frontier needs its place', async () => {
        const { store } = await fullAtTwenty()
        store.setPosition(5 * MIB)
        // Blocks 6 to 12 are started, and with block 28 they are as many as the frontier holds.
        await startBlocks(store, ...Array.from({ length: FRONTIER_BLOCKS - 1 }, (_, i) => 6 + i))
        expect(store.held().has(blocks(28, 29))).toBe(true)
        // Block 13 is started: the frontier has no place for it, and block 28 is the farthest block in it.
        const outcome = await store.write(13 * MIB, CONTENT.subarray(13 * MIB, 13 * MIB + 100))
        expect(outcome).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(28, 29)] })
        expect(store.held().has({ start: 28 * MIB, end: 28 * MIB + 1 })).toBe(false)
        // The block let go of from the frontier was never stored in a slot: it is dropped, not evicted (R49).
        expect(store.stats().evictedBytes).toBe(9 * MIB)
        expect(store.stats().droppedBytes).toBe(MIB)
      })

      it('answers full for a waiting block that is no farther than the first gap, and not for one that is', async () => {
        const { store } = await rigOf(kind, 16 * MIB, 2 * MIB)
        store.setPosition(10 * MIB)
        await writeBlocks(store, 10, 11)
        // The first gap is in block 12, 2 ahead of the position. Block 7 is 3 behind it: farther, and so the store is not full.
        const seven = await writeBlocks(store, 7)
        expect(seven[0]).toEqual({ full: false, evictedBytes: 0, evicted: [] })
        expect(await store.write(10 * MIB, NOTHING)).toEqual({
          full: false,
          evictedBytes: 0,
          evicted: [],
        })
        // Block 8 is 2 behind it, as far as the gap is: the store is full, and stays so while block 7 waits as well.
        const eight = await writeBlocks(store, 8)
        expect(eight[0]).toEqual({ full: true, evictedBytes: 0, evicted: [] })
        expect(await store.write(10 * MIB, NOTHING)).toEqual({
          full: true,
          evictedBytes: 0,
          evicted: [],
        })
        expect(store.held().ranges()).toEqual([blocks(7, 9), blocks(10, 12)])
        expectSame(await store.read(7 * MIB, 9 * MIB), CONTENT.subarray(7 * MIB, 9 * MIB))
      })

      it('answers full for any waiting block when no byte is missing from the position to the end of the file', async () => {
        const { store } = await rigOf(kind, 4 * MIB, MIB)
        // Block 0 holds the only slot and blocks 1 to 3 wait; the last of them is the farthest, and there is no gap nearer than it.
        const outcomes = await writeBlocks(store, 0, 1, 2, 3)
        expect(outcomes.map((outcome) => outcome.full)).toEqual([false, true, true, true])
        expect(await store.write(0, NOTHING)).toEqual({ full: true, evictedBytes: 0, evicted: [] })
        expect(store.stats().evictedBytes).toBe(0)
        expect(store.held().ranges()).toEqual([blocks(0, 4)])
      })

      it('keeps the blocks of a read that is far from the position, each beside the one before, whole', async () => {
        const { store } = await rigOf(kind, 32 * MIB, 8 * MIB)
        await writeBlocks(store, 0, 1, 2, 3, 4, 5, 6, 7, 8)
        // A read of blocks 20 to 22 while the store is full of what is nearer to the position: no block of it is let go of by the one that follows.
        const read = await writeBlocks(store, 20, 21, 22)
        expect(read.map((outcome) => outcome.evicted)).toEqual([[], [], []])
        expect(store.held().ranges()).toEqual([blocks(0, 9), blocks(20, 23)])
        expectSame(await store.read(20 * MIB, 23 * MIB), CONTENT.subarray(20 * MIB, 23 * MIB))
        expect(store.stats().evictedBytes).toBe(0)
      })
    })

    describe('a frontier that blocks far from the position have jammed', () => {
      it('lets go of the farthest waiting block to take a write at a seek', async () => {
        // The waiting blocks, from block 12 up, fill the frontier; the last of them is the farthest from block 0.
        const last = 12 + FRONTIER_BLOCKS - 1
        const { store } = await rigOf(kind, (last + 1) * MIB, 4 * MIB)
        store.setPosition(10 * MIB)
        await writeBlocks(store, 8, 9, 10, 11)
        const waiting = await writeBlocks(
          store,
          ...Array.from({ length: FRONTIER_BLOCKS }, (_, index) => 12 + index),
        )
        expect(waiting.map((outcome) => outcome.full)).toEqual(
          Array.from({ length: FRONTIER_BLOCKS }, () => true),
        )

        // The waiting blocks are all further from block 0 than the blocks held, and the frontier has no place for one more.
        // The blocks that wait are farther than the first gap, at block 0, so the store is not full on their account.
        store.setPosition(0)
        const piece = CONTENT.subarray(0, 64 * 1024)
        const outcome = await store.write(0, piece)
        expect(outcome).toEqual({
          full: false,
          evictedBytes: MIB,
          evicted: [blocks(last, last + 1)],
        })
        expect(store.held().ranges()).toEqual([{ start: 0, end: 64 * 1024 }, blocks(8, last)])
        expectSame(await store.read(0, 64 * 1024), piece)
        expect(await store.read(last * MIB, last * MIB + 1)).toBeNull()
        expectSame(await store.read((last - 1) * MIB, last * MIB), plainBlock(last - 1))
        // A frontier block let go of was never stored: it is dropped, not evicted (R49).
        expect(store.stats().evictedBytes).toBe(0)
        expect(store.stats().droppedBytes).toBe(MIB)
      })

      it('lets go of partly filled blocks too, the farthest first, and counts only the bytes they held', async () => {
        const { store } = await rigOf(kind, 16 * MIB, 4 * MIB)
        // As many blocks as the frontier holds, from block 4 up, each partly filled.
        const started = Array.from({ length: FRONTIER_BLOCKS }, (_, index) => 4 + index)
        await startBlocks(store, ...started)
        store.setPosition(15 * MIB)
        // The write adds blocks 14 and 15, so two blocks must go: the two furthest from the position.
        const piece = CONTENT.subarray(15 * MIB - 100, 15 * MIB + 100)
        const outcome = await store.write(15 * MIB - 100, piece)
        expect(outcome).toEqual({
          full: false,
          evictedBytes: 200,
          evicted: [
            { start: 4 * MIB, end: 4 * MIB + 100 },
            { start: 5 * MIB, end: 5 * MIB + 100 },
          ],
        })
        expect(store.held().ranges()).toEqual([
          ...started.slice(2).map((index) => ({ start: index * MIB, end: index * MIB + 100 })),
          { start: 15 * MIB - 100, end: 15 * MIB + 100 },
        ])
        expectSame(await store.read(15 * MIB - 100, 15 * MIB + 100), piece)
        expect(await store.read(4 * MIB, 4 * MIB + 100)).toBeNull()
        expect(store.stats().evictedBytes).toBe(0)
        expect(store.stats().droppedBytes).toBe(200)
      })

      it('lets go of the block behind the position first when two are as far as one another', async () => {
        const { store } = await rigOf(kind, 16 * MIB, 4 * MIB)
        store.setPosition(10 * MIB)
        // A block on each side of block 10 at every distance up to the farthest: as many blocks as the frontier holds.
        const reach = FRONTIER_BLOCKS / 2
        const started = Array.from({ length: reach }, (_, index) => [
          10 - (index + 1),
          10 + (index + 1),
        ])
          .flat()
          .sort((a, b) => a - b)
        expect(started).toHaveLength(FRONTIER_BLOCKS)
        await startBlocks(store, ...started)
        const outcome = await store.write(10 * MIB, CONTENT.subarray(10 * MIB, 10 * MIB + 100))
        // The block behind the position and the block ahead of it at the farthest distance are both that far away.
        expect(outcome.evicted).toEqual([
          { start: (10 - reach) * MIB, end: (10 - reach) * MIB + 100 },
        ])
        expect(store.held().ranges()).toEqual(
          [...started.filter((index) => index !== 10 - reach), 10]
            .sort((a, b) => a - b)
            .map((index) => ({ start: index * MIB, end: index * MIB + 100 })),
        )
      })

      it('refuses a write, and changes nothing, when too few blocks are further than what it adds', async () => {
        const { store } = await rigOf(kind, 16 * MIB, 4 * MIB)
        // The blocks from 0 up, and block 14: all but one place of the frontier is taken by blocks that are nearer than 12 and 13.
        await startBlocks(
          store,
          ...Array.from({ length: FRONTIER_BLOCKS - 1 }, (_, index) => index),
        )
        await startBlocks(store, 14)
        const before = store.held().ranges()
        // The write adds blocks 12 and 13, which needs two places, and only block 14 is further than they are.
        await expectRangeError(store.write(12 * MIB, CONTENT.subarray(12 * MIB, 13 * MIB + 100)))
        expect(store.held().ranges()).toEqual(before)
        expect(store.stats().evictedBytes).toBe(0)
        expectSame(
          await store.read(14 * MIB, 14 * MIB + 100),
          CONTENT.subarray(14 * MIB, 14 * MIB + 100),
        )
      })

      it('lets go of a partial block wholly behind the position for a write at or ahead of it, though that block is nearer', async () => {
        const { store } = await rigOf(kind, 20 * MIB, 4 * MIB)
        store.setPosition(10 * MIB)
        // Blocks 6 to 9 are leftovers of aborted reads behind the position, 11 to 13 are ahead of it, 10 is its own: all eight places.
        await startBlocks(store, 6, 7, 8, 9, 10, 11, 12, 13)
        // Block 14 is 4 away: every block is as near or nearer, so by distance alone nothing can go.
        const outcome = await store.write(14 * MIB, CONTENT.subarray(14 * MIB, 14 * MIB + 100))
        expect(outcome.evicted).toEqual([{ start: 6 * MIB, end: 6 * MIB + 100 }])
        expect(store.held().has({ start: 14 * MIB, end: 14 * MIB + 1 })).toBe(true)
        expect(store.stats().droppedBytes).toBe(100)
      })

      it('does not let go of a block behind the position for a write behind it, if that block is nearer', async () => {
        const { store } = await rigOf(kind, 20 * MIB, 4 * MIB)
        store.setPosition(10 * MIB)
        await startBlocks(store, 6, 7, 8, 9, 10, 11, 12, 13)
        // A write far behind (block 5, 5 away) is no read ahead: it is refused, as the rule was.
        await expectRangeError(store.write(5 * MIB, CONTENT.subarray(5 * MIB, 5 * MIB + 100)))
      })

      it('does not let go of a block that the write itself fills', async () => {
        const { store } = await rigOf(kind, 16 * MIB, 4 * MIB)
        await startBlocks(
          store,
          10,
          ...Array.from({ length: FRONTIER_BLOCKS - 1 }, (_, index) => index),
        )
        const before = store.held().ranges()
        // Block 10 is further than block 9, which the write adds, but the write fills it: letting it go would only make the write add it again.
        await expectRangeError(
          store.write(10 * MIB - 100, CONTENT.subarray(10 * MIB - 100, 10 * MIB + 200)),
        )
        expect(store.held().ranges()).toEqual(before)
        expect(store.stats().evictedBytes).toBe(0)
      })

      it('does not let go of a block that is nearer than any block the write adds', async () => {
        const { store } = await rigOf(kind, 24 * MIB, 4 * MIB)
        store.setPosition(5 * MIB)
        // Half the frontier is the blocks just ahead of the position, and half is far from it.
        const half = FRONTIER_BLOCKS / 2
        await startBlocks(
          store,
          ...Array.from({ length: half }, (_, index) => 6 + index),
          ...Array.from({ length: half }, (_, index) => 20 + index),
        )
        const before = store.held().ranges()
        // The write adds half + 1 blocks from block 10, which needs a place for each. The last of them is 9 away, and the near blocks are not further than that: they must stay, and the far half is one place short.
        await expectRangeError(
          store.write(10 * MIB, CONTENT.subarray(10 * MIB, (10 + half + 1) * MIB)),
        )
        expect(store.held().ranges()).toEqual(before)
        expect(store.stats().evictedBytes).toBe(0)
      })
    })
  })

  describe('shrinking to the slots in use', () => {
    it('takes the slots that hold a block as its cap, and reports it as its cap from then on', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1)
      expect(store.shrinkToUsed()).toBe(2 * MIB)
      expect(store.capBytes).toBe(2 * MIB)
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 2 * MIB,
        storedBytes: 2 * MIB,
        evictedBytes: 0,
        droppedBytes: 0,
      })
    })

    it('takes no slot that was never used: a block that comes after waits, and the answer is full', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1)
      store.shrinkToUsed()
      // Block 2 is further from the position than the blocks that are held, so it takes no slot.
      const outcome = await store.write(2 * MIB, plainBlock(2))
      expect(outcome).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expect(store.held().ranges()).toEqual([blocks(0, 3)])
      expectSame(await store.read(2 * MIB, 3 * MIB), plainBlock(2))
    })

    it('still gives a slot to a block that is nearer to the position than the block that has it', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1)
      store.shrinkToUsed()
      store.setPosition(7 * MIB)
      const outcome = await store.write(6 * MIB, plainBlock(6))
      expect(outcome).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.held().ranges()).toEqual([blocks(1, 2), blocks(6, 7)])
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 2 * MIB,
        storedBytes: 2 * MIB,
        evictedBytes: MIB,
        droppedBytes: 0,
      })
    })

    it('counts the slot of a block whose write is still in flight', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      const writing = store.write(0, plainBlock(0))
      expect(store.shrinkToUsed()).toBe(MIB)
      await writing
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: MIB,
        storedBytes: MIB,
        evictedBytes: 0,
        droppedBytes: 0,
      })
      expectSame(await store.read(0, MIB), plainBlock(0))
    })

    it('takes a cap of nothing from a store that holds no block, and keeps every block it is given in the frontier', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      expect(store.shrinkToUsed()).toBe(0)
      expect(store.capBytes).toBe(0)
      const outcome = await store.write(0, plainBlock(0))
      expect(outcome).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.stats().capBytes).toBe(0)
      expect(store.stats().storedBytes).toBe(0)
      expectSame(await store.read(0, MIB), plainBlock(0))
    })

    it('may be done again, and takes no more than the slots that hold a block', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 4 * MIB)
      await writeBlocks(store, 0)
      expect(store.shrinkToUsed()).toBe(MIB)
      expect(store.shrinkToUsed()).toBe(MIB)
      expect(store.capBytes).toBe(MIB)
    })

    it('fails as closed once the store is', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.close()
      expect(() => store.shrinkToUsed()).toThrow(StoreError)
    })
  })

  describe('held and stats', () => {
    it('gives a copy of what is held, so that a caller cannot change the store', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, CONTENT.subarray(0, 100))
      const copy = store.held()
      copy.add({ start: 5000, end: 6000 })
      copy.remove({ start: 0, end: 50 })
      expect(store.held().ranges()).toEqual([{ start: 0, end: 100 }])
      expect(await store.read(5000, 6000)).toBeNull()
    })

    it('says what the store is and how much it holds', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 3 * MIB)
      expect(store.backend).toBe(kind)
      expect(store.fileSize).toBe(4 * MIB)
      expect(store.capBytes).toBe(3 * MIB)
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 3 * MIB,
        storedBytes: 0,
        evictedBytes: 0,
        droppedBytes: 0,
      })
      await store.write(0, CONTENT.subarray(0, 2 * MIB + 100))
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 3 * MIB,
        storedBytes: 2 * MIB,
        evictedBytes: 0,
        droppedBytes: 0,
      })
    })

    it('rounds its cap down to whole blocks, and refuses a cap of less than one', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 2.5 * MIB)
      expect(store.capBytes).toBe(2 * MIB)
      expect(store.stats().capBytes).toBe(2 * MIB)
      expect((await rigOf(kind, 8 * MIB, MIB)).store.capBytes).toBe(MIB)
      await expect(rigOf(kind, 8 * MIB, MIB - 1)).rejects.toBeInstanceOf(RangeError)
      await expect(rigOf(kind, 8 * MIB, 0)).rejects.toBeInstanceOf(RangeError)
      await expect(rigOf(kind, 8 * MIB, Number.NaN)).rejects.toBeInstanceOf(RangeError)
    })

    it('refuses a file size that is not a size', async () => {
      await expect(rigOf(kind, -1, 2 * MIB)).rejects.toBeInstanceOf(RangeError)
      await expect(rigOf(kind, 1.5, 2 * MIB)).rejects.toBeInstanceOf(RangeError)
    })
  })

  describe('closing', () => {
    it('makes later calls fail as closed, and may be repeated', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, plainBlock(0))
      await store.close()
      await store.close()
      await expectStoreError(store.read(0, 10), 'closed')
      await expectStoreError(store.write(0, CONTENT.subarray(0, 10)), 'closed')
      let thrown: unknown
      try {
        store.setPosition(0)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(StoreError)
      expect((thrown as StoreError).kind).toBe('closed')
    })

    it('holds nothing after it closes, and still answers', async () => {
      const { store } = await rigOf(kind, 4 * MIB, 4 * MIB)
      await store.write(0, plainBlock(0))
      await store.write(MIB, CONTENT.subarray(MIB, MIB + 100))
      await store.close()
      expect(store.held().ranges()).toEqual([])
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 4 * MIB,
        storedBytes: 0,
        evictedBytes: 0,
        droppedBytes: 0,
      })
    })
  })
})

describe('the store on disk', () => {
  it('writes each block to its slot, at slot times the size of a sealed block', async () => {
    const { store, file, key } = await diskRig(4 * MIB, 4 * MIB)
    await store.write(0, CONTENT.subarray(0, 3 * MIB))
    const raw = file.raw()
    expect(raw.length).toBe(3 * SLOT_BYTES)
    for (let index = 0; index < 3; index += 1) {
      const sealed = raw.slice(index * SLOT_BYTES, (index + 1) * SLOT_BYTES)
      expectSame(await openBlock(key, index, sealed), plainBlock(index))
    }
  })

  it('seals the last block at its own length', async () => {
    const size = 2.5 * MIB
    const { store, file, key } = await diskRig(size, 4 * MIB)
    await store.write(0, CONTENT.subarray(0, size))
    const raw = file.raw()
    expect(raw.length).toBe(2 * SLOT_BYTES + MIB / 2 + SEAL_OVERHEAD)
    const sealed = raw.slice(2 * SLOT_BYTES)
    expectSame(await openBlock(key, 2, sealed), CONTENT.subarray(2 * MIB, size))
  })

  it('puts blocks in the slots that their writes were given, in the order the writes were made', async () => {
    const { store, file, key } = await diskRig(4 * MIB, 2 * MIB)
    // The second block is written first, so it has the first slot.
    const second = store.write(MIB, plainBlock(1))
    const first = store.write(0, plainBlock(0))
    await Promise.all([first, second])
    const raw = file.raw()
    expect(raw.length).toBe(2 * SLOT_BYTES)
    expectSame(await openBlock(key, 1, raw.slice(0, SLOT_BYTES)), plainBlock(1))
    expectSame(await openBlock(key, 0, raw.slice(SLOT_BYTES, 2 * SLOT_BYTES)), plainBlock(0))
  })

  it('leaves no byte of the video in the file', async () => {
    const { store, file } = await diskRig(4 * MIB, 4 * MIB)
    const marker = bytesOf(31, 64)
    const plain = CONTENT.slice(0, MIB)
    plain.set(marker, 1000)
    // The test would pass on an empty file, and on a marker that was never in the block, if these two did not hold.
    expect(Buffer.from(plain).includes(Buffer.from(marker))).toBe(true)
    await store.write(0, plain)
    expect(store.stats().storedBytes).toBe(MIB)
    const raw = file.raw()
    expect(raw.length).toBeGreaterThanOrEqual(SLOT_BYTES)
    expect(Buffer.from(raw).includes(Buffer.from(marker))).toBe(false)
    expectSame(await store.read(1000, 1064), marker)
  })

  it('does not write a block that waits for a slot', async () => {
    const { store, file } = await diskRig(4 * MIB, MIB)
    await store.write(0, CONTENT.subarray(0, 2 * MIB))
    expect(file.raw().length).toBe(SLOT_BYTES)
  })

  it('leaves the file alone when a write is for a block that is in a slot already', async () => {
    const { store, file } = await diskRig(4 * MIB, 4 * MIB)
    await store.write(0, plainBlock(0))
    const before = file.raw()
    await store.write(0, otherThan(MIB))
    expect(Buffer.compare(file.raw(), before)).toBe(0)
  })

  describe('eviction', () => {
    it('writes a block that takes the slot of an evicted block over it, in a file that is no longer', async () => {
      const { store, file, key } = await diskRig(4 * MIB, MIB)
      await store.write(0, plainBlock(0))
      store.setPosition(3 * MIB)
      await store.write(3 * MIB, plainBlock(3))
      const raw = file.raw()
      expect(raw.length).toBe(SLOT_BYTES)
      expectSame(await openBlock(key, 3, raw), plainBlock(3))
    })

    it('does not evict a block whose slot write is still in flight', async () => {
      const { store } = await diskRig(16 * MIB, 2 * MIB)
      await store.write(0, plainBlock(0))
      // Block 7 is far from the position, and has the other slot, but its write has not finished.
      const seven = store.write(7 * MIB, plainBlock(7))
      const one = await store.write(MIB, plainBlock(1))
      expect(one).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      await seven
      expect(store.held().ranges()).toEqual([blocks(0, 2), blocks(7, 8)])
      expect(store.stats().evictedBytes).toBe(0)
      expectSame(await store.read(7 * MIB, 8 * MIB), plainBlock(7))
    })

    it('does not let go of a frontier block whose slot write is still in flight', async () => {
      const { store } = await diskRig(24 * MIB, FRONTIER_BLOCKS * MIB)
      // As many blocks as the frontier holds, from block 1, are complete and have their slots, and stay in the frontier until the files take them.
      const filling = store.write(MIB, CONTENT.subarray(MIB, (FRONTIER_BLOCKS + 1) * MIB))
      store.setPosition(20 * MIB)
      await expectRangeError(store.write(20 * MIB, CONTENT.subarray(20 * MIB, 20 * MIB + 100)))
      await filling
      expect(store.held().ranges()).toEqual([blocks(1, FRONTIER_BLOCKS + 1)])
      expect(store.stats()).toEqual({
        backend: 'disk',
        capBytes: FRONTIER_BLOCKS * MIB,
        storedBytes: FRONTIER_BLOCKS * MIB,
        evictedBytes: 0,
        droppedBytes: 0,
      })
    })

    it('changes nothing when it refuses a write, even a block that the write would have let it place', async () => {
      const { store } = await diskRig(24 * MIB, MIB)
      await store.write(0, plainBlock(0))
      await store.write(5 * MIB, plainBlock(5))
      // Blocks ahead of block 5 start, so that with block 5 they fill the frontier.
      const started = [6, 7, 8, 9, 10, 11, 12, 13, 14].slice(0, FRONTIER_BLOCKS - 1)
      for (const index of started) {
        await store.write(index * MIB, CONTENT.subarray(index * MIB, index * MIB + 100))
      }
      const before = store.held().ranges()
      expect(before[0]).toEqual(blocks(0, 1))
      // At block 5, block 5 is nearer than block 0 and would take its slot, but the write at block 20 cannot be added.
      store.setPosition(5 * MIB)
      await expectRangeError(store.write(20 * MIB, CONTENT.subarray(20 * MIB, 20 * MIB + 100)))
      expect(store.held().ranges()).toEqual(before)
      expect(store.stats().storedBytes).toBe(MIB)
      expect(store.stats().evictedBytes).toBe(0)
      // The next write goes on as if the refused one had not been made.
      const next = await store.write(5 * MIB, NOTHING)
      expect(next).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
    })
  })

  describe('when the file fails', () => {
    it.each([
      ['QuotaExceededError', 'quota'],
      ['InvalidStateError', 'disk'],
    ] as const)(
      'rejects a slot write that fails with %s as %s, keeps the block, and places it with the next write of other bytes',
      async (name, kind) => {
        // A cap of one block: the next write can only place the block if the failed write gave its slot back.
        const { store, file, key } = await diskRig(2 * MIB, MIB)
        file.failNextWrite(name)
        await expectStoreError(store.write(0, plainBlock(0)), kind)

        expect(file.raw().length).toBe(0)
        expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
        expect(store.stats().storedBytes).toBe(0)
        expectSame(await store.read(0, MIB), plainBlock(0))
        expectSame(await store.read(MIB - 10, MIB), CONTENT.subarray(MIB - 10, MIB))

        // A write of bytes of another block: the block that failed is placed first, by the rule of the waiting blocks.
        const next = await store.write(MIB, CONTENT.subarray(MIB, MIB + 100))
        expect(next.full).toBe(false)
        expect(store.stats().storedBytes).toBe(MIB)
        expect(file.raw().length).toBe(SLOT_BYTES)
        expectSame(await openBlock(key, 0, file.raw()), plainBlock(0))
        expectSame(await store.read(0, MIB + 100), CONTENT.subarray(0, MIB + 100))
      },
    )

    it('places a block whose slot write failed with a write of no bytes', async () => {
      const { store, file, key } = await diskRig(2 * MIB, MIB)
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(0, plainBlock(0)), 'disk')
      // The block waits, so the store answers full until it is placed.
      const retry = await store.write(0, NOTHING)
      expect(retry).toEqual({ full: false, evictedBytes: 0, evicted: [] })
      expect(store.stats().storedBytes).toBe(MIB)
      expectSame(await openBlock(key, 0, file.raw()), plainBlock(0))
    })

    it('places a block whose slot write failed when the same bytes are written again', async () => {
      const { store, file, key } = await diskRig(2 * MIB, MIB)
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(0, plainBlock(0)), 'disk')

      const retry = await store.write(0, plainBlock(0))
      expect(retry.full).toBe(false)
      expect(store.stats().storedBytes).toBe(MIB)
      expect(file.raw().length).toBe(SLOT_BYTES)
      expectSame(await openBlock(key, 0, file.raw()), plainBlock(0))
      expectSame(await store.read(0, MIB), plainBlock(0))
    })

    it('keeps the eviction that came before a failed slot write, and reports it with the next write that resolves', async () => {
      const { store, file, key } = await diskRig(4 * MIB, MIB)
      await store.write(0, plainBlock(0))
      store.setPosition(3 * MIB)
      file.failNextWrite('InvalidStateError')
      // Block 3 takes the slot of block 0, which is 3 away, and the write to that slot fails.
      await expectStoreError(store.write(3 * MIB, plainBlock(3)), 'disk')

      // Block 0 stays gone and is counted at once, and block 3 is held and readable from the frontier.
      expect(store.held().ranges()).toEqual([blocks(3, 4)])
      expect(await store.read(0, 100)).toBeNull()
      expectSame(await store.read(3 * MIB, 4 * MIB), plainBlock(3))
      expect(store.stats()).toEqual({
        backend: 'disk',
        capBytes: MIB,
        storedBytes: 0,
        evictedBytes: MIB,
        droppedBytes: 0,
      })

      // The slot is free again: block 3 takes it without evicting, and the write reports the eviction that was lost.
      const next = await store.write(3 * MIB, NOTHING)
      expect(next).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.stats()).toEqual({
        backend: 'disk',
        capBytes: MIB,
        storedBytes: MIB,
        evictedBytes: MIB,
        droppedBytes: 0,
      })
      expect(file.raw().length).toBe(SLOT_BYTES)
      expectSame(await openBlock(key, 3, file.raw()), plainBlock(3))

      // It is reported once.
      expect(await store.write(3 * MIB, NOTHING)).toEqual({
        full: false,
        evictedBytes: 0,
        evicted: [],
      })
    })

    it('goes on keeping an eviction that it could not report through a second failed write', async () => {
      const { store, file } = await diskRig(4 * MIB, MIB)
      await store.write(0, plainBlock(0))
      store.setPosition(3 * MIB)
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(3 * MIB, plainBlock(3)), 'disk')
      // The write that places block 3 again fails as well, and says nothing of block 0 either.
      file.failNextWrite('QuotaExceededError')
      await expectStoreError(store.write(3 * MIB, NOTHING), 'quota')
      expect(store.stats().evictedBytes).toBe(MIB)

      const next = await store.write(3 * MIB, NOTHING)
      expect(next).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.stats().storedBytes).toBe(MIB)
    })

    /** A one-slot store in which a failed write has evicted block 0 and left block 3 in the frontier, with the position at block 3. */
    async function afterLostEviction(): Promise<DiskRig> {
      const rig = await diskRig(4 * MIB, MIB)
      await rig.store.write(0, plainBlock(0))
      rig.store.setPosition(3 * MIB)
      rig.file.failNextWrite('InvalidStateError')
      await expectStoreError(rig.store.write(3 * MIB, plainBlock(3)), 'disk')
      expect(rig.store.stats().evictedBytes).toBe(MIB)
      return rig
    }

    it('does not report an eviction whose bytes are held again when the write resolves', async () => {
      const { store } = await afterLostEviction()
      // Block 3 takes the only slot, so block 0 is held again in the frontier.
      const again = await store.write(0, plainBlock(0))
      expect(again).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.held().ranges()).toEqual([blocks(0, 1), blocks(3, 4)])
      // The bytes were let go of when they were, and that is not undone.
      expect(store.stats().evictedBytes).toBe(MIB)
    })

    it('reports only the part of an eviction that is still gone', async () => {
      const { store } = await afterLostEviction()
      const head = await store.write(0, CONTENT.subarray(0, 100))
      expect(head).toEqual({
        full: false,
        evictedBytes: MIB - 100,
        evicted: [{ start: 100, end: MIB }],
      })
      expect(store.held().ranges()).toEqual([{ start: 0, end: 100 }, blocks(3, 4)])
    })

    it('reports the two parts of an eviction that is held again in its middle', async () => {
      const { store } = await afterLostEviction()
      const middle = await store.write(500_000, CONTENT.subarray(500_000, 500_100))
      expect(middle).toEqual({
        full: false,
        evictedBytes: MIB - 100,
        evicted: [
          { start: 0, end: 500_000 },
          { start: 500_100, end: MIB },
        ],
      })
      expect(store.held().ranges()).toEqual([{ start: 500_000, end: 500_100 }, blocks(3, 4)])
    })

    it('reports a block that two failed writes let go of once, and counts it once', async () => {
      // The last block is the one that waits; the blocks before it fill the frontier with it, up to the one that does not fit.
      const waiting = FRONTIER_BLOCKS + 7
      const { store, file } = await diskRig((waiting + 1) * MIB, MIB)
      await store.write(0, plainBlock(0))
      store.setPosition(waiting * MIB)
      // The first failed write lets go of block 0, the one block with a slot, to place the last block.
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(waiting * MIB, plainBlock(waiting)), 'disk')
      // Blocks 0 up are held in the frontier, each by a write that fails to place the last block; with it they are as many as the frontier holds.
      for (let index = 0; index < FRONTIER_BLOCKS - 1; index += 1) {
        file.failNextWrite('InvalidStateError')
        await expectStoreError(store.write(index * MIB, plainBlock(index)), 'disk')
      }
      // The next block does not fit in the frontier, so the furthest block in it, block 0, is let go of a second time.
      file.failNextWrite('InvalidStateError')
      await expectStoreError(
        store.write((FRONTIER_BLOCKS - 1) * MIB, plainBlock(FRONTIER_BLOCKS - 1)),
        'disk',
      )
      expect(store.stats().droppedBytes + store.stats().evictedBytes).toBe(2 * MIB)

      const next = await store.write(waiting * MIB, NOTHING)
      // Block 0 is gone once, though two writes let go of it: it is reported once and counted once.
      expect(next).toEqual({ full: true, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.held().ranges()).toEqual([
        blocks(1, FRONTIER_BLOCKS),
        blocks(waiting, waiting + 1),
      ])
    })

    it('reports the parts that are still gone in file order, joined where they touch', async () => {
      const { store, file } = await diskRig(8 * MIB, 2 * MIB)
      await store.write(0, plainBlock(0))
      await store.write(MIB, plainBlock(1))
      store.setPosition(7 * MIB)
      // A write that fails after it let go of block 0 for block 7 says nothing of it.
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(7 * MIB, plainBlock(7)), 'disk')
      // The next write lets go of block 1 for block 6, and reports both blocks, which touch, as one range.
      const next = await store.write(6 * MIB, plainBlock(6))
      expect(next.evicted).toEqual([blocks(0, 2)])
      expect(next.evictedBytes).toBe(2 * MIB)
    })

    it('shrinks to the blocks that hold a slot after a full disk, and does not take the slot that the failed write gave back', async () => {
      const { store, file } = await diskRig(8 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1)
      file.failNextWrite('QuotaExceededError')
      await expectStoreError(store.write(2 * MIB, plainBlock(2)), 'quota')
      // The failed write took a slot that was never used, and gave it back: two blocks hold a slot, and the cap is two.
      expect(store.shrinkToUsed()).toBe(2 * MIB)
      expect(store.stats().capBytes).toBe(2 * MIB)
      // Block 2 is held and waits for a slot, and the slot that was given back is not one it can take.
      const retry = await store.write(2 * MIB, NOTHING)
      expect(retry).toEqual({ full: true, evictedBytes: 0, evicted: [] })
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expectSame(await store.read(2 * MIB, 3 * MIB), plainBlock(2))
    })

    it('takes again a slot that a write gives back after the shrink, though more slots were taken than are held', async () => {
      const { store, file } = await diskRig(8 * MIB, 4 * MIB)
      await writeBlocks(store, 0, 1)
      file.failNextWrite('QuotaExceededError')
      await expectStoreError(store.write(2 * MIB, plainBlock(2)), 'quota')
      // Three slots were taken in all, and two hold a block: the cap is two.
      expect(store.shrinkToUsed()).toBe(2 * MIB)
      store.setPosition(2 * MIB)
      // Block 2 takes the slot of block 0, which is the furthest, and the write of the slot fails: the slot is given back.
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(2 * MIB, NOTHING), 'disk')
      // The slot is within the cap, so block 2 takes it and block 1 is not let go of.
      const placed = await store.write(2 * MIB, NOTHING)
      expect(placed).toEqual({ full: false, evictedBytes: MIB, evicted: [blocks(0, 1)] })
      expect(store.held().ranges()).toEqual([blocks(1, 3)])
      expect(store.stats().storedBytes).toBe(2 * MIB)
    })

    it('lets a block take the slot of a write that was counted and then fails', async () => {
      const { store, file } = await diskRig(4 * MIB, 4 * MIB)
      file.failNextWrite('InvalidStateError')
      const writing = store.write(0, plainBlock(0))
      // The block has a slot chosen, which the cap counts, and its write is still sealing.
      expect(store.shrinkToUsed()).toBe(MIB)
      await expectStoreError(writing, 'disk')
      // The slot is given back, and is within the cap, so the block takes it.
      const retry = await store.write(0, NOTHING)
      expect(retry).toEqual({ full: false, evictedBytes: 0, evicted: [] })
      expect(store.stats()).toEqual({
        backend: 'disk',
        capBytes: MIB,
        storedBytes: MIB,
        evictedBytes: 0,
        droppedBytes: 0,
      })
    })

    it('rejects a write that completes two blocks when one of their slot writes fails, and keeps both readable', async () => {
      const { store, file } = await diskRig(4 * MIB, 4 * MIB)
      file.failNextWrite('InvalidStateError')
      await expectStoreError(store.write(0, CONTENT.subarray(0, 2 * MIB)), 'disk')
      // One of the two blocks landed, and the one that did not is still held.
      expect(store.stats().storedBytes).toBe(MIB)
      expectSame(await store.read(0, 2 * MIB), CONTENT.subarray(0, 2 * MIB))
      await store.write(0, CONTENT.subarray(0, 2 * MIB))
      expect(store.stats().storedBytes).toBe(2 * MIB)
      expect(file.raw().length).toBe(2 * SLOT_BYTES)
    })

    it('rejects a slot write that returns fewer bytes than it was given', async () => {
      class ShortFile extends TestSlotFile {
        override write(buffer: Uint8Array, options: { at: number }): number {
          return super.write(buffer, options) - 1
        }
      }
      const { store } = await diskRig(2 * MIB, MIB, new ShortFile())
      await expectStoreError(store.write(0, plainBlock(0)), 'disk')
      expectSame(await store.read(0, MIB), plainBlock(0))
    })

    it('rejects a read of a slot that fails, and reads again once the file works', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      await store.write(0, plainBlock(0))
      file.failNextRead('NotReadableError')
      await expectStoreError(store.read(0, 100), 'disk')
      expectSame(await store.read(0, 100), CONTENT.subarray(0, 100))
    })

    it('rejects a read of a slot that returns fewer bytes than the slot holds', async () => {
      class ShortReadFile extends TestSlotFile {
        short = false
        override read(buffer: Uint8Array, options: { at: number }): number {
          const read = super.read(buffer, options)
          return this.short ? read - 1 : read
        }
      }
      const file = new ShortReadFile()
      const { store } = await diskRig(2 * MIB, 2 * MIB, file)
      await store.write(0, plainBlock(0))
      file.short = true
      await expectStoreError(store.read(0, 100), 'disk')
    })

    it('rejects a read of a block that was changed in the file, as sealed', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      await store.write(0, plainBlock(0))
      const raw = file.raw()
      raw[100] = (raw[100] ?? 0) ^ 0xff
      file.write(raw, { at: 0 })
      await expectStoreError(store.read(0, 100), 'sealed')
    })

    it('takes the sealed bytes of a read in the call, so that a change to the file after it cannot reach it', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      await store.write(0, plainBlock(0))
      const reading = store.read(0, 100)
      file.write(new Uint8Array(SLOT_BYTES), { at: 0 })
      expectSame(await reading, CONTENT.subarray(0, 100))
      await expectStoreError(store.read(0, 100), 'sealed')
    })
  })

  describe('closing', () => {
    it('closes the file', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      expect(file.closed).toBe(false)
      await store.close()
      expect(file.closed).toBe(true)
    })

    it('closes even when the file fails to close', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      file.close = () => {
        throw new DOMException('the file did not close', 'InvalidStateError')
      }
      await store.close()
      await expectStoreError(store.read(0, 1), 'closed')
    })

    it('does not write to the file after it is closed, and rejects the write that was in flight', async () => {
      const { store, file } = await diskRig(2 * MIB, 2 * MIB)
      const writing = store.write(0, plainBlock(0))
      const closing = store.close()
      await expectStoreError(writing, 'closed')
      await closing
      expect(file.raw().length).toBe(0)
    })
  })
})

describe('the store in memory', () => {
  it('takes a write into the room that the placing of the waiting blocks makes in the frontier', async () => {
    const { store } = await rigOf('memory', 16 * MIB, MIB)
    const nearest = FRONTIER_BLOCKS - 1
    // Block 0 holds the only slot, and the blocks after it wait; the next block is started: the frontier is full.
    await writeBlocks(store, ...Array.from({ length: FRONTIER_BLOCKS }, (_, index) => index))
    await startBlocks(store, FRONTIER_BLOCKS)
    // The last block that waits takes the slot of block 0 and leaves the frontier, and then the block after the started one has a place.
    store.setPosition(nearest * MIB)
    const after = (FRONTIER_BLOCKS + 1) * MIB
    const piece = CONTENT.subarray(after, after + 100)
    const outcome = await store.write(after, piece)
    expect(outcome).toEqual({ full: true, evictedBytes: MIB, evicted: [blocks(0, 1)] })
    expectSame(await store.read(after, after + 100), piece)
    expectSame(await store.read(nearest * MIB, FRONTIER_BLOCKS * MIB), plainBlock(nearest))
  })
})

describe('the test file', () => {
  it('grows as it is written, and reads what it holds', () => {
    const file = new TestSlotFile()
    expect(file.getSize()).toBe(0)
    expect(file.write(Uint8Array.of(1, 2, 3), { at: 10 })).toBe(3)
    expect(file.getSize()).toBe(13)
    const read = new Uint8Array(5)
    expect(file.read(read, { at: 9 })).toBe(4)
    expect(Array.from(read)).toEqual([0, 1, 2, 3, 0])
    expect(file.read(new Uint8Array(4), { at: 50 })).toBe(0)
    file.truncate(11)
    expect(file.getSize()).toBe(11)
    expect(Array.from(file.raw())).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('fails the next write or the next read with the name it is told, once', () => {
    const file = new TestSlotFile()
    file.failNextWrite('QuotaExceededError')
    let thrown: unknown
    try {
      file.write(Uint8Array.of(1), { at: 0 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe('QuotaExceededError')
    expect(file.write(Uint8Array.of(1), { at: 0 })).toBe(1)

    file.failNextRead('NotReadableError')
    thrown = undefined
    try {
      file.read(new Uint8Array(1), { at: 0 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe('NotReadableError')
    expect(file.read(new Uint8Array(1), { at: 0 })).toBe(1)
  })

  it('gives a copy of its bytes, and fails every call once it is closed', () => {
    const file = new TestSlotFile()
    file.write(Uint8Array.of(1, 2, 3), { at: 0 })
    const raw = file.raw()
    raw.fill(9)
    expect(Array.from(file.raw())).toEqual([1, 2, 3])
    expect(file.closed).toBe(false)
    file.close()
    expect(file.closed).toBe(true)
    expect(() => file.write(Uint8Array.of(1), { at: 0 })).toThrow(DOMException)
    expect(() => file.read(new Uint8Array(1), { at: 0 })).toThrow(DOMException)
    expect(() => file.getSize()).toThrow(DOMException)
    file.close()
  })
})

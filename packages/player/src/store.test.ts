import { describe, expect, it } from 'vitest'
import { StoreError } from './errors.ts'
import type { StoreErrorKind } from './errors.ts'
import { BLOCK_BYTES, FRONTIER_BLOCKS } from './limits.ts'
import { SEAL_OVERHEAD, newPlayKey, openBlock } from './seal.ts'
import type { PlayKey } from './seal.ts'
import { CoreStore } from './store.ts'
import { TestSlotFile } from './testing/slot-file.ts'

// The store keeps a play's blocks in slots, sealed in a private file or whole in
// memory, and the blocks that are still filling in a small frontier where they
// can already be read (DESIGN.md §10.4; the iron-clad spec §4.7). A write may land
// at any offset, a read joins slot blocks and frontier bytes, and a block that
// finds no slot waits in the frontier. Eviction is not part of the core yet.

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

/** The content of the files that the tests play: byte `n` of any of them is `CONTENT[n]`. */
const CONTENT = bytesOf(7, 8 * MIB)

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
      expect(FRONTIER_BLOCKS).toBe(4)
      const { store } = await rigOf(kind, 8 * MIB, 8 * MIB)
      // Four blocks, each started and none complete, fill the frontier.
      for (let index = 0; index < FRONTIER_BLOCKS; index += 1) {
        await store.write(index * MIB, CONTENT.subarray(index * MIB, index * MIB + 100))
      }
      const before = store.held().ranges()
      expect(before).toHaveLength(FRONTIER_BLOCKS)

      // A fifth block is refused whole.
      await expectRangeError(
        store.write(
          FRONTIER_BLOCKS * MIB,
          CONTENT.subarray(FRONTIER_BLOCKS * MIB, FRONTIER_BLOCKS * MIB + 100),
        ),
      )
      expect(store.held().ranges()).toEqual(before)

      // A write that overlaps held bytes of the fourth block and reaches into the fifth is refused too, and does not change the fourth.
      const straddle = otherThan(MIB)
      await expectRangeError(store.write(3 * MIB + 50, straddle))
      expect(store.held().ranges()).toEqual(before)
      expectSame(await store.read(3 * MIB, 3 * MIB + 100), CONTENT.subarray(3 * MIB, 3 * MIB + 100))
      expect(await store.read(4 * MIB, 4 * MIB + 10)).toBeNull()

      // A block that completes leaves the frontier for its slot, and then there is room for another.
      await store.write(0, plainBlock(0))
      expect(store.stats().storedBytes).toBe(MIB)
      await store.write(
        FRONTIER_BLOCKS * MIB,
        CONTENT.subarray(FRONTIER_BLOCKS * MIB, FRONTIER_BLOCKS * MIB + 100),
      )
      expectSame(
        await store.read(FRONTIER_BLOCKS * MIB, FRONTIER_BLOCKS * MIB + 100),
        CONTENT.subarray(FRONTIER_BLOCKS * MIB, FRONTIER_BLOCKS * MIB + 100),
      )
    })

    it('takes a write of as many new blocks as the frontier holds, and refuses one more', async () => {
      const { store } = await rigOf(kind, 8 * MIB, 8 * MIB)
      await expectRangeError(store.write(0, CONTENT.subarray(0, (FRONTIER_BLOCKS + 1) * MIB)))
      expect(store.held().ranges()).toEqual([])
      expect(store.stats().storedBytes).toBe(0)
      const outcome = await store.write(0, CONTENT.subarray(0, FRONTIER_BLOCKS * MIB))
      expect(outcome.full).toBe(false)
      expect(store.stats().storedBytes).toBe(FRONTIER_BLOCKS * MIB)
    })

    it('counts blocks that wait for a slot against the frontier', async () => {
      const { store } = await rigOf(kind, 8 * MIB, MIB)
      // One slot: the first block takes it, and the next three wait in the frontier. A block just started makes four.
      await store.write(0, CONTENT.subarray(0, 4 * MIB))
      await store.write(4 * MIB, CONTENT.subarray(4 * MIB, 4 * MIB + 100))
      await expectRangeError(store.write(5 * MIB, CONTENT.subarray(5 * MIB, 5 * MIB + 100)))
      expect(store.held().ranges()).toEqual([{ start: 0, end: 4 * MIB + 100 }])
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
      })
      await store.write(0, CONTENT.subarray(0, 2 * MIB + 100))
      expect(store.stats()).toEqual({
        backend: kind,
        capBytes: 3 * MIB,
        storedBytes: 2 * MIB,
        evictedBytes: 0,
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

  describe('when the file fails', () => {
    it.each([
      ['QuotaExceededError', 'quota'],
      ['InvalidStateError', 'disk'],
    ] as const)(
      'rejects a slot write that fails with %s as %s, keeps the block, and lets the same bytes finish it',
      async (name, kind) => {
        // A cap of one block: the retry can only be given a slot if the failed write gave its slot back.
        const { store, file, key } = await diskRig(2 * MIB, MIB)
        file.failNextWrite(name)
        await expectStoreError(store.write(0, plainBlock(0)), kind)

        expect(file.raw().length).toBe(0)
        expect(store.held().ranges()).toEqual([{ start: 0, end: MIB }])
        expect(store.stats().storedBytes).toBe(0)
        expectSame(await store.read(0, MIB), plainBlock(0))
        expectSame(await store.read(MIB - 10, MIB), CONTENT.subarray(MIB - 10, MIB))

        const retry = await store.write(0, plainBlock(0))
        expect(retry.full).toBe(false)
        expect(store.stats().storedBytes).toBe(MIB)
        expect(file.raw().length).toBe(SLOT_BYTES)
        expectSame(await openBlock(key, 0, file.raw()), plainBlock(0))
        expectSame(await store.read(0, MIB), plainBlock(0))
      },
    )

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

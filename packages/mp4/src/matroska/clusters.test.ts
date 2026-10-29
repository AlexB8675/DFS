import { describe, expect, it } from 'vitest'
import type { ByteRange, Chunk } from '../source.ts'
import { concat } from '../testing/build.ts'
import {
  blockGroup,
  cluster,
  element,
  elementSized,
  simpleBlock,
  sizeBytes,
  uint,
} from '../testing/ebml.ts'
import { findCluster, readClusters } from './clusters.ts'
import type { ClusterPlace, ClusterRead, ClusterTrack, RawFrame } from './clusters.ts'
import { frameSamples, sampleRate } from './frameheaders.ts'
import { ID, TOP_LEVEL } from './ids.ts'
import { MAX_BLOCK } from './limits.ts'

// The clusters are read from the bytes the builder writes, with a file that starts
// at a nonzero offset so that no offset is right by luck, and every read that
// stops is read on from its `next` (DESIGN.md §10.4, D45): the frames of a file in
// pieces, cut anywhere, are the frames of the file in one.

/** Where the first byte of the file is: every offset in these tests is counted from the file's start and not from the bytes'. */
const BASE = 5000

interface Laid {
  /** The whole of what was laid out, as one chunk at BASE. */
  chunk: Chunk
  /** Where each part starts in the file. */
  at: number[]
  /** Where the Segment ends. */
  end: number
}

/** Parts one after the other from BASE: they are the Segment's children, so the Segment ends where the last does. */
function laid(...parts: Uint8Array[]): Laid {
  const at: number[] = []
  let offset = BASE
  for (const part of parts) {
    at.push(offset)
    offset += part.length
  }
  return { chunk: { start: BASE, bytes: concat(...parts) }, at, end: offset }
}

/** The part of the file from `from` up to `to`, as a chunk of its own (a copy: a read outside it finds nothing). */
function slice(file: Laid, from: number, to: number): Chunk {
  const end = Math.min(to, file.end)
  return { start: from, bytes: file.chunk.bytes.slice(from - BASE, end - BASE) }
}

/** Where the bytes of `part` start in the file, which must be there once. */
function where(file: Laid, part: Uint8Array): number {
  const hits: number[] = []
  const bytes = file.chunk.bytes
  for (let i = 0; i + part.length <= bytes.length; i += 1) {
    if (part.every((byte, index) => bytes[i + index] === byte)) hits.push(i)
  }
  if (hits.length !== 1)
    throw new Error(`Expected the bytes once in the file, found ${hits.length}.`)
  return BASE + (hits[0] ?? 0)
}

const NO_LACE = (): null => null
const picture: ClusterTrack = { number: 1, defaultDuration: null, lace: NO_LACE }
const sound: ClusterTrack = { number: 2, defaultDuration: null, lace: NO_LACE }
const BOTH = [picture, sound]

/** A SimpleBlock of one frame whose bytes are `payload`: a keyframe, or not. */
function key(track: number, timecode: number, ...payload: number[]): Uint8Array {
  return simpleBlock({ track, timecode, keyframe: true, frames: [payload] })
}
function delta(track: number, timecode: number, ...payload: number[]): Uint8Array {
  return simpleBlock({ track, timecode, frames: [payload] })
}

/** The bytes a frame points at, read from the whole file. */
function payload(file: Laid, frame: RawFrame): number[] {
  const at = frame.offset - BASE
  return Array.from(file.chunk.bytes.subarray(at, at + frame.size))
}

/** What a frame is of, in a form that a failure shows: track, pts, keyframe and its bytes. */
function seen(file: Laid, frames: RawFrame[]): [number, number, boolean, number[]][] {
  return frames.map((frame) => [frame.track, frame.pts, frame.keyframe, payload(file, frame)])
}

/** One read of the whole file, from its start. */
function readWhole(file: Laid, tracks: readonly ClusterTrack[] = BOTH): ClusterRead {
  return readClusters(file.chunk, BASE, null, false, file.end, tracks)
}

/** A Xiph-laced block of frames that begin with a given Opus TOC byte, for the sound track. */
const OPUS_20_MS = 0x98

/** A block that damages the file where it stands: Xiph lacing whose first size is more than the block holds. */
function overrun(track: number, ...inside: number[]): Uint8Array {
  return element(ID.SimpleBlock, [0x80 | track, 0, 0, 0x02, 1, 200, 5, ...inside])
}

describe('readClusters: frames (§10.4)', () => {
  it('gives the frames of the tracks asked for, in order, at the Timestamp plus the timecode', () => {
    const file = laid(
      cluster(1000, [key(1, 0, 10, 11), delta(2, 3, 20, 21, 22), delta(1, 40, 12), key(2, 43, 23)]),
      cluster(2000, [key(1, 0, 14)]),
    )
    const read = readWhole(file)
    expect(seen(file, read.frames)).toEqual([
      [1, 1000, true, [10, 11]],
      [2, 1003, false, [20, 21, 22]],
      [1, 1040, false, [12]],
      [2, 1043, true, [23]],
      [1, 2000, true, [14]],
    ])
    expect(read).toMatchObject({
      next: file.end,
      cluster: null,
      skipped: [],
      searching: false,
      ended: true,
    })
    // A SimpleBlock's body is its data: the track number, the timecode and the flags come before the frame.
    for (const frame of read.frames) expect(frame.offset - frame.body).toBe(4)
    for (const frame of read.frames) expect(frame.duration).toBeNull()
  })

  it('passes over a block of a track not asked for without reading it', () => {
    // Track 9's block is garbage: EBML lacing of 11 frames whose sizes aren't there.
    const garbage = element(ID.SimpleBlock, [0x89, 0, 0, 0x06, 10, 0xff])
    const file = laid(
      cluster(1000, [key(1, 0, 1), garbage, delta(1, 40, 2)]),
      cluster(2000, [key(1, 0, 3)]),
    )
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 1040, 2000])
    expect(read.skipped).toEqual([])

    // The same block is damage when its track is asked for: it is skipped to the next cluster.
    const asked = readWhole(file, [picture, { number: 9, defaultDuration: null, lace: NO_LACE }])
    expect(asked.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(asked.skipped).toEqual([{ start: where(file, garbage), end: file.at[1] }])
  })

  it('passes over the CRC-32 that starts a cluster, and Void and the rest of what is not a block', () => {
    const file = laid(
      cluster(
        1000,
        [
          key(1, 0, 1),
          element(ID.Void, [0, 0, 0, 0]),
          uint(0xa7, 4096),
          uint(0xab, 33),
          element(0xaf, [7, 7, 7]),
          element(0x5854, [1, 2]),
          delta(1, 40, 2),
          element(ID.CRC32, [0, 0, 0, 0]),
        ],
        { crc: true },
      ),
    )
    const read = readWhole(file)
    expect(seen(file, read.frames)).toEqual([
      [1, 1000, true, [1]],
      [1, 1040, false, [2]],
    ])
    expect(read.skipped).toEqual([])
    expect(read.ended).toBe(true)
  })

  it('passes over the elements between clusters by their size', () => {
    const cues = element(ID.Cues, element(ID.CuePoint, uint(ID.CueTime, 0)))
    // The Tags hold the bytes of a Cluster's ID, which are no cluster there.
    const tags = element(
      ID.Tags,
      [0x1f, 0x43, 0xb6, 0x75, 0x84, 0xe7, 0x81, 0x09],
      new Uint8Array(30),
    )
    const file = laid(cluster(1000, [key(1, 0, 1)]), tags, cues, cluster(2000, [key(1, 0, 2)]))
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([])
  })

  it('reads a BlockGroup: a keyframe without a ReferenceBlock, and its BlockDuration', () => {
    const file = laid(
      cluster(500, [
        blockGroup({ track: 1, timecode: 0, duration: 33, frames: [[1]] }),
        blockGroup({ track: 1, timecode: 33, duration: 33, reference: -33, frames: [[2]] }),
        blockGroup({ track: 2, timecode: 5, frames: [[3]] }),
      ]),
    )
    const read = readWhole(file)
    expect(seen(file, read.frames)).toEqual([
      [1, 500, true, [1]],
      [1, 533, false, [2]],
      [2, 505, true, [3]],
    ])
    expect(read.frames.map((frame) => frame.duration)).toEqual([33, 33, null])
    // The body of a BlockGroup is its Block's data.
    for (const frame of read.frames) expect(frame.offset - frame.body).toBe(4)
  })

  it('gives each frame the DefaultDuration of its track when the block has no BlockDuration', () => {
    const file = laid(
      cluster(0, [
        key(1, 0, 1),
        blockGroup({ track: 1, timecode: 33, duration: 30, frames: [[2]] }),
      ]),
    )
    const read = readWhole(file, [{ number: 1, defaultDuration: 33.5, lace: NO_LACE }])
    expect(read.frames.map((frame) => frame.duration)).toEqual([33.5, 30])
  })

  it('gives a timecode of -5 in the cluster at 0 a pts of -5', () => {
    const file = laid(cluster(0, [key(1, -5, 1), delta(1, 33, 2)]))
    expect(readWhole(file).frames.map((frame) => frame.pts)).toEqual([-5, 33])
  })

  it('reads a Segment that ends in the middle of a chunk, and nothing after it', () => {
    const file = laid(cluster(1000, [key(1, 0, 1)]), cluster(2000, [key(1, 0, 2)]))
    const first = file.at[1] ?? 0
    const read = readClusters(file.chunk, BASE, null, false, first, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read).toMatchObject({ next: first, cluster: null, ended: true })
  })

  it('refuses a position that is not in the chunk, and reads nothing at its end', () => {
    const file = laid(cluster(1000, [key(1, 0, 1)]))
    expect(() => readClusters(file.chunk, BASE - 1, null, false, file.end, BOTH)).toThrow(
      RangeError,
    )
    expect(() => readClusters(file.chunk, file.end + 1, null, false, file.end + 9, BOTH)).toThrow(
      RangeError,
    )
    expect(() => readClusters(file.chunk, 1.5 + BASE, null, false, file.end, BOTH)).toThrow(
      RangeError,
    )
    // Where the chunk ends there is nothing to read yet: it goes on from there.
    const none = readClusters(
      slice(file, file.end, file.end),
      file.end,
      null,
      false,
      file.end + 50,
      BOTH,
    )
    expect(none).toMatchObject({
      frames: [],
      next: file.end,
      cluster: null,
      searching: false,
      ended: false,
    })
  })
})

describe('readClusters: unknown-size clusters (§10.4)', () => {
  it('reads a cluster of unknown size to the next cluster, and the last to the end of the Segment', () => {
    const file = laid(
      cluster(1000, [key(1, 0, 1), delta(1, 40, 2)], { unknown: true }),
      cluster(2000, [key(1, 0, 3)], { unknown: true }),
    )
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 1040, 2000])
    expect(read).toMatchObject({ next: file.end, cluster: null, skipped: [], ended: true })
  })

  it('ends a cluster of unknown size at the first element of the Segment that follows, Cues for one', () => {
    const cues = element(ID.Cues, element(ID.CuePoint, uint(ID.CueTime, 0)))
    const file = laid(cluster(1000, [key(1, 0, 1)], { unknown: true }), cues)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read).toMatchObject({ next: file.end, cluster: null, skipped: [], ended: true })

    // And a cluster after the Cues is read.
    const more = laid(
      cluster(1000, [key(1, 0, 1)], { unknown: true }),
      cues,
      cluster(3000, [key(1, 0, 2)]),
    )
    expect(readWhole(more).frames.map((frame) => frame.pts)).toEqual([1000, 3000])
  })

  it('carries a cluster of unknown size to the next call as one that runs to the end of the Segment', () => {
    const file = laid(
      cluster(1000, [key(1, 0, 1), delta(1, 40, 2)], { unknown: true }),
      cluster(2000, [key(1, 0, 3)], { unknown: true }),
    )
    const second = where(file, delta(1, 40, 2))
    // The first block is taken once the ID of the element after it is held (its 1 byte): a block in a cluster of unknown size is taken only when what follows it is known to be able to.
    const first = readClusters(slice(file, BASE, second + 1), BASE, null, false, file.end, BOTH)
    expect(first.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(first.next).toBe(second)
    expect(first.cluster).toEqual({ timestamp: 1000, end: file.end, sized: false })
    expect(first.ended).toBe(false)
  })

  it('stops before the header of the next cluster when the chunk ends in it', () => {
    const file = laid(
      cluster(1000, [key(1, 0, 1)], { unknown: true }),
      cluster(2000, [key(1, 0, 3)], { unknown: true }),
    )
    const next = file.at[1] ?? 0
    // The cluster's ID is held (4 bytes) and its size is not: the block before it is taken, and the header is waited for.
    const read = readClusters(slice(file, BASE, next + 5), BASE, null, false, file.end, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.next).toBe(next)
    expect(read.cluster).toEqual({ timestamp: 1000, end: file.end, sized: false })
  })
})

describe('readClusters: what a cluster of unknown size bounds (§10.4)', () => {
  const cues = element(ID.Cues, element(ID.CuePoint, uint(ID.CueTime, 0)))
  /** The Segment ends far past what the tests hold, so that a claim is bounded by the cap and not by the Segment's end. */
  const FAR = 4 * MAX_BLOCK

  /** An element that claims `claim` bytes of data, of which only `inside` is there. */
  function claiming(id: number, claim: number, ...inside: number[]): Uint8Array {
    return elementSized(id, sizeBytes(claim, 8), inside)
  }

  /** Two clusters of unknown size, the first with `middle` after its first block, then Cues so that the last block has an element after it. */
  function around(middle: Uint8Array): Laid {
    return laid(
      cluster(1000, [key(1, 0, 1), middle], { unknown: true }),
      cluster(2000, [key(1, 0, 9)], { unknown: true }),
      cues,
    )
  }
  function readFar(file: Laid): ClusterRead {
    return readClusters(file.chunk, BASE, null, false, file.end + FAR, BOTH)
  }

  const claims: [string, (claim: number) => Uint8Array][] = [
    [
      'a block of a track asked for',
      (claim) => claiming(ID.SimpleBlock, claim, 0x81, 0, 0, 0x80, 7),
    ],
    [
      'a block of a track not asked for',
      (claim) => claiming(ID.SimpleBlock, claim, 0x83, 0, 0, 0x80, 7),
    ],
    ['a BlockGroup', (claim) => claiming(ID.BlockGroup, claim, 0xa1, 0x85, 0x81, 0, 0, 0x80, 7)],
    ['an element that is not a block', (claim) => claiming(ID.Void, claim, 1, 2, 3)],
  ]

  it.each(claims)(
    'takes %s that claims more than MAX_BLOCK as damage, skipped from the element',
    (_name, make) => {
      const bad = make(MAX_BLOCK + 1)
      const file = around(bad)
      const read = readFar(file)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      expect(read.skipped).toEqual([{ start: where(file, bad), end: file.at[1] }])
      expect(read).toMatchObject({ next: file.end, cluster: null, searching: false })
    },
  )

  it.each(claims)('takes %s that claims MAX_BLOCK as no damage yet', (_name, make) => {
    const file = around(make(MAX_BLOCK))
    const read = readFar(file)
    expect(read.skipped).toEqual([])
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
  })

  it('does not bound a block of a sized cluster, for the cluster does', () => {
    const big = simpleBlock({
      track: 1,
      timecode: 0,
      keyframe: true,
      frames: [new Uint8Array(MAX_BLOCK + 1)],
    })
    const sized = laid(cluster(1000, [big]))
    const read = readWhole(sized)
    expect(read.skipped).toEqual([])
    expect(read.frames.map((frame) => frame.size)).toEqual([MAX_BLOCK + 1])
    // The same block in a cluster of unknown size is a claim no real block makes.
    const unknown = laid(cluster(1000, [big], { unknown: true }))
    expect(readWhole(unknown).frames).toEqual([])
    // (The cluster's header is 12 bytes, and its Timestamp comes before the block.)
    const blockAt = (unknown.at[0] ?? 0) + 12 + uint(ID.Timestamp, 1000).length
    expect(readWhole(unknown).skipped).toEqual([{ start: blockAt, end: unknown.end }])
  })

  describe('what a block may be followed by', () => {
    const second = (): Uint8Array => cluster(2000, [key(1, 0, 9)], { unknown: true })
    const inCluster: [string, Uint8Array][] = [
      ['another SimpleBlock', key(1, 40, 2)],
      ['a BlockGroup', blockGroup({ track: 1, timecode: 40, frames: [[2]] })],
      ['a Timestamp', uint(ID.Timestamp, 5)],
      ['a Position', uint(ID.Position, 5)],
      ['a PrevSize', uint(ID.PrevSize, 5)],
      ['a Void', element(ID.Void, new Uint8Array(3))],
      ['a CRC-32', element(ID.CRC32, [1, 2, 3, 4])],
    ]

    it.each(inCluster)('takes a block that %s follows', (_name, follower) => {
      const file = laid(cluster(1000, [key(1, 0, 1), follower], { unknown: true }), second())
      const read = readWhole(file)
      expect(read.skipped).toEqual([])
      expect(read.frames.map((frame) => frame.pts)).toContain(1000)
      expect(read.frames.map((frame) => frame.pts)).toContain(2000)
      expect(read.ended).toBe(true)
    })

    it.each([...TOP_LEVEL].filter((id) => id !== ID.Cluster))(
      'takes a block that the top-level element %i follows',
      (id) => {
        const file = laid(
          cluster(1000, [key(1, 0, 1)], { unknown: true }),
          element(id, new Uint8Array(3)),
          second(),
        )
        const read = readWhole(file)
        expect(read.skipped).toEqual([])
        expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      },
    )

    const garbage: [string, Uint8Array][] = [
      ['zeros', new Uint8Array(8)],
      ['an element that no cluster holds', element(ID.TrackNumber, [1])],
      ['an ID that nothing starts with', Uint8Array.of(0x11, 0x81, 0x01)],
    ]

    it.each(garbage)(
      'skips a block of a track asked for that %s follow, from the block',
      (_name, bytes) => {
        const bad = key(1, 40, 2)
        const next = second()
        const file = laid(cluster(1000, [key(1, 0, 1), bad, bytes], { unknown: true }), next)
        const read = readWhole(file)
        expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
        expect(read.skipped).toEqual([{ start: where(file, bad), end: where(file, next) }])
      },
    )

    it.each(garbage)(
      'skips a block of a track not asked for that %s follow, from the block',
      (_name, bytes) => {
        const bad = delta(3, 40, 2)
        const next = second()
        const file = laid(cluster(1000, [key(1, 0, 1), bad, bytes], { unknown: true }), next)
        const read = readWhole(file)
        expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
        expect(read.skipped).toEqual([{ start: where(file, bad), end: where(file, next) }])
      },
    )

    it.each([
      ['asked for', 1],
      ['not asked for', 3],
    ])('waits for the bytes that tell what follows a block of a track %s', (_name, track) => {
      const block = delta(track, 0, 1)
      const file = laid(
        cluster(1000, [block], { unknown: true }),
        cluster(2000, [key(1, 0, 2)], { unknown: true }),
      )
      const next = file.at[1] ?? 0
      const start = where(file, block)
      const place = { timestamp: 1000, end: file.end, sized: false }
      // The ID of a Cluster is 4 bytes: with fewer the block is not taken, and nothing is skipped.
      for (const held of [0, 1, 3]) {
        const read = readClusters(slice(file, BASE, next + held), BASE, null, false, file.end, BOTH)
        expect(read.frames).toEqual([])
        expect(read).toMatchObject({ next: start, cluster: place, skipped: [], searching: false })
      }
      const whole = readClusters(slice(file, BASE, next + 4), BASE, null, false, file.end, BOTH)
      expect(whole.frames.map((frame) => frame.pts)).toEqual(track === 1 ? [1000] : [])
      expect(whole).toMatchObject({ next, cluster: place, skipped: [] })
    })

    it('waits for the bytes of a block at the end of a chunk that does not hold the Segment to its end', () => {
      const file = laid(cluster(1000, [key(1, 0, 1)], { unknown: true }))
      const read = readClusters(file.chunk, BASE, null, false, file.end + 100, BOTH)
      expect(read.frames).toEqual([])
      expect(read.next).toBe(where(file, key(1, 0, 1)))
    })

    it('needs nothing after a block that ends where the Segment does', () => {
      const file = laid(cluster(1000, [key(1, 0, 1), delta(3, 40, 2)], { unknown: true }))
      const read = readWhole(file)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
      expect(read).toMatchObject({ next: file.end, skipped: [], ended: true })
    })

    it('skips a block that a header cut by the Segment end follows: nothing tells what it is', () => {
      const block = key(1, 0, 1)
      const file = laid(cluster(1000, [block], { unknown: true }), Uint8Array.of(0x1f, 0x43))
      const read = readWhole(file)
      expect(read.frames).toEqual([])
      expect(read.skipped).toEqual([{ start: where(file, block), end: file.end }])
      expect(read).toMatchObject({ next: file.end, ended: true })
    })

    it('asks nothing of what follows a block of a sized cluster', () => {
      // The cluster bounds the block, so the bytes after it are another element or the cluster's end: the frame is given with only itself held, and damage after it is found where it starts.
      const block = key(1, 0, 1)
      const file = laid(cluster(1000, [block]))
      const cut = readClusters(slice(file, BASE, file.end), BASE, null, false, file.end + 100, BOTH)
      expect(cut.frames.map((frame) => frame.pts)).toEqual([1000])

      const junk = new Uint8Array(8)
      const withJunk = laid(cluster(1000, [block, junk]), cluster(2000, [key(1, 0, 3)]))
      const read = readWhole(withJunk)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      expect(read.skipped).toEqual([{ start: where(withJunk, junk), end: withJunk.at[1] }])
    })
  })

  describe('what stands between clusters', () => {
    it('takes an element that is not a Segment child as damage, whatever size it claims', () => {
      const stray = claiming(ID.Timestamp, 1 << 30, 1, 2, 3)
      const next = cluster(2000, [key(1, 0, 2)])
      const file = laid(cluster(1000, [key(1, 0, 1)]), stray, next)
      const read = readWhole(file)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      expect(read.skipped).toEqual([{ start: where(file, stray), end: where(file, next) }])
    })

    it('passes over a Void and a CRC-32 between clusters by their size', () => {
      const file = laid(
        cluster(1000, [key(1, 0, 1)]),
        element(ID.Void, new Uint8Array(30)),
        element(ID.CRC32, [1, 2, 3, 4]),
        cluster(2000, [key(1, 0, 2)]),
      )
      const read = readWhole(file)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      expect(read.skipped).toEqual([])
    })

    it('does the same after a cluster of unknown size that an element of the Segment ended', () => {
      const stray = claiming(ID.SimpleBlock, 1 << 30, 0x81, 0, 0, 0x80, 7)
      const next = cluster(2000, [key(1, 0, 2)], { unknown: true })
      const file = laid(cluster(1000, [key(1, 0, 1)], { unknown: true }), cues, stray, next)
      const read = readWhole(file)
      expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
      expect(read.skipped).toEqual([{ start: where(file, stray), end: where(file, next) }])
    })
  })
})

describe('readClusters: reading on from where it stopped (§10.4)', () => {
  const blocks = [key(1, 0, 1, 1, 1), delta(1, 40, 2, 2, 2), delta(1, 80, 3, 3, 3)]
  const file = laid(cluster(1000, blocks), cluster(2000, [key(1, 0, 4)]))

  it('stops at the start of a block that is cut by the chunk, with its cluster', () => {
    const second = where(file, blocks[1] ?? new Uint8Array())
    const read = readClusters(slice(file, BASE, second + 5), BASE, null, false, file.end, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.next).toBe(second)
    expect(read.cluster).toEqual({ timestamp: 1000, end: file.at[1], sized: true })
    expect(read).toMatchObject({ skipped: [], searching: false, ended: false })

    // Reading on from there, with a chunk that starts there, gives the rest.
    const rest = readClusters(
      slice(file, second, file.end),
      second,
      read.cluster,
      false,
      file.end,
      BOTH,
    )
    expect([...read.frames, ...rest.frames]).toEqual(readWhole(file).frames)
    expect(rest.ended).toBe(true)
  })

  it('stops at the start of a cluster whose Timestamp is not held', () => {
    const start = file.at[1] ?? 0
    for (const cut of [start + 1, start + 4, start + 5, start + 6, start + 7, start + 8]) {
      const read = readClusters(slice(file, start, cut), start, null, false, file.end, BOTH)
      expect(read, `cut ${cut - start}`).toMatchObject({
        frames: [],
        next: start,
        cluster: null,
        searching: false,
        ended: false,
      })
    }
    // With the Timestamp (the header takes 5 bytes and it 4) it is entered, and what follows is not held.
    const read = readClusters(slice(file, start, start + 9), start, null, false, file.end, BOTH)
    expect(read.cluster).toEqual({ timestamp: 2000, end: file.end, sized: true })
    expect(read.next).toBe(start + 9)
  })

  it('stops before a Void or a CRC-32 that is cut before the Timestamp', () => {
    const crc = laid(cluster(7, [key(1, 0, 1)], { crc: true }))
    const read = readClusters(slice(crc, BASE, BASE + 10), BASE, null, false, crc.end, BOTH)
    expect(read).toMatchObject({ frames: [], next: BASE, cluster: null })
    expect(readWhole(crc).frames.map((frame) => frame.pts)).toEqual([7])
  })

  it('gives the frames of a file in pieces as those of the file in one, cut anywhere', () => {
    const whole = readWhole(file)
    for (let cut = 0; cut <= file.chunk.bytes.length; cut += 1) {
      const pieces = drive(file, BOTH, cut, file.chunk.bytes.length)
      expect(pieces.frames, `cut at ${cut}`).toEqual(whole.frames)
      expect(pieces.skipped, `cut at ${cut}`).toEqual([])
    }
  })
})

describe('readClusters: unasked blocks need only their head (§10.4)', () => {
  const big = new Array<number>(100).fill(9)
  const unasked = delta(9, 0, ...big)
  const file = laid(cluster(1000, [key(1, 0, 1), unasked, key(1, 40, 2)]))

  it('passes over a block of a track not asked for with only its header and track number held, past the chunk', () => {
    const block = where(file, unasked)
    // The element's header is 2 bytes, then the track number.
    const read = readClusters(slice(file, BASE, block + 3), BASE, null, false, file.end, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.next).toBe(block + unasked.length)
    expect(read.next).toBeGreaterThan(block + 3)
    expect(read.cluster).toEqual({ timestamp: 1000, end: file.end, sized: true })

    // Without the track number it stops at the block.
    const short = readClusters(slice(file, BASE, block + 2), BASE, null, false, file.end, BOTH)
    expect(short.next).toBe(block)
    expect(short.frames.map((frame) => frame.pts)).toEqual([1000])
  })

  it('does the same for a BlockGroup, whose Block need not be its first child', () => {
    const group = element(
      ID.BlockGroup,
      uint(ID.BlockDuration, 33),
      element(ID.Block, [0x89, 0, 0, 0, ...big]),
    )
    const grouped = laid(cluster(1000, [key(1, 0, 1), group, key(1, 40, 2)]))
    const at = where(grouped, group)
    // The group's header (2 bytes), the BlockDuration (3), the Block's header (2) and its track number.
    const read = readClusters(slice(grouped, BASE, at + 8), BASE, null, false, grouped.end, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.next).toBe(at + group.length)

    // One byte short of the track number, it stops at the group.
    const short = readClusters(slice(grouped, BASE, at + 7), BASE, null, false, grouped.end, BOTH)
    expect(short.next).toBe(at)
  })

  it('needs a block of a track asked for whole, and a BlockGroup of it as well', () => {
    const group = blockGroup({ track: 1, timecode: 0, duration: 5, frames: [[1, 2, 3]] })
    const grouped = laid(cluster(1000, [group]))
    const at = where(grouped, group)
    const cut = readClusters(
      slice(grouped, BASE, at + group.length - 1),
      BASE,
      null,
      false,
      grouped.end,
      BOTH,
    )
    expect(cut).toMatchObject({ frames: [], next: at })
  })
})

describe('readClusters: laced blocks (§10.4)', () => {
  /** The ticks of a frame of Opus at a scale of a millisecond, by its own header, as the caller builds it. */
  const opus = { codecId: 'A_OPUS', codecPrivate: null, audio: null }
  const opusTrack: ClusterTrack = {
    number: 2,
    defaultDuration: null,
    lace: (frame) => {
      const samples = frameSamples(opus, frame)
      return samples === null ? null : (samples * 1000) / sampleRate(opus)
    },
  }

  it('times laced Opus frames of 20 ms one after the other: 0, 20, 40', () => {
    const frames = [1, 2, 3].map((n) => [OPUS_20_MS, n])
    const file = laid(
      cluster(0, [simpleBlock({ track: 2, timecode: 0, lacing: 'xiph', keyframe: true, frames })]),
    )
    const read = readWhole(file, [opusTrack])
    expect(seen(file, read.frames)).toEqual([
      [2, 0, true, [OPUS_20_MS, 1]],
      [2, 20, true, [OPUS_20_MS, 2]],
      [2, 40, true, [OPUS_20_MS, 3]],
    ])
    // Their duration is not put here: nothing but their headers says it.
    expect(read.frames.map((frame) => frame.duration)).toEqual([null, null, null])
    // The frames are those of one block.
    expect(new Set(read.frames.map((frame) => frame.body)).size).toBe(1)
  })

  it("adds the block's timecode and the cluster's Timestamp to each frame", () => {
    const frames = [1, 2].map((n) => [OPUS_20_MS, n])
    const file = laid(
      cluster(1000, [simpleBlock({ track: 2, timecode: 7, lacing: 'ebml', frames })]),
    )
    expect(readWhole(file, [opusTrack]).frames.map((frame) => frame.pts)).toEqual([1007, 1027])
  })

  it('times laced AAC by the DefaultDuration, summed as fractions and rounded once: 0, 21, 43', () => {
    const aac: ClusterTrack = { number: 2, defaultDuration: 21.333333, lace: NO_LACE }
    const frames = [1, 2, 3, 4].map((n) => [n, n])
    const file = laid(cluster(0, [simpleBlock({ track: 2, timecode: 0, lacing: 'fixed', frames })]))
    const read = readWhole(file, [aac])
    // 21.33, 42.67 and 64.0 (three times 21.333333 is a hair under 64).
    expect(read.frames.map((frame) => frame.pts)).toEqual([0, 21, 43, 64])
    expect(read.frames.map((frame) => frame.duration)).toEqual([
      21.333333, 21.333333, 21.333333, 21.333333,
    ])
  })

  it('divides a BlockDuration among the frames: 60 over 3 frames is 0, 20, 40', () => {
    const frames = [[1], [2], [3]]
    const file = laid(
      cluster(0, [blockGroup({ track: 2, timecode: 0, duration: 60, lacing: 'xiph', frames })]),
    )
    // The BlockDuration is used before the track's DefaultDuration.
    const read = readWhole(file, [{ number: 2, defaultDuration: 25, lace: NO_LACE }])
    expect(read.frames.map((frame) => frame.pts)).toEqual([0, 20, 40])
    expect(read.frames.map((frame) => frame.duration)).toEqual([20, 20, 20])
  })

  it('rounds the running sum and not each duration: 100 over 3 frames is 0, 33, 67', () => {
    const frames = [[1], [2], [3]]
    const file = laid(
      cluster(0, [blockGroup({ track: 2, timecode: 0, duration: 100, lacing: 'ebml', frames })]),
    )
    const read = readWhole(file, [sound])
    expect(read.frames.map((frame) => frame.pts)).toEqual([0, 33, 67])
    // Half a tick is rounded up, as Math.round does.
    const half = laid(
      cluster(0, [
        blockGroup({ track: 2, timecode: 0, duration: 5, lacing: 'xiph', frames: [[1], [2]] }),
      ]),
    )
    expect(readWhole(half, [sound]).frames.map((frame) => frame.pts)).toEqual([0, 3])
  })

  it('asks each frame its own bytes, and never the last one', () => {
    const asked: number[][] = []
    const byFirstByte: ClusterTrack = {
      number: 2,
      defaultDuration: null,
      lace: (frame) => {
        asked.push(Array.from(frame))
        return frame[0] ?? null
      },
    }
    const frames = [
      [20, 1],
      [30, 2, 2],
      [99, 3, 3, 3],
    ]
    const file = laid(cluster(0, [simpleBlock({ track: 2, timecode: 0, lacing: 'xiph', frames })]))
    expect(readWhole(file, [byFirstByte]).frames.map((frame) => frame.pts)).toEqual([0, 20, 50])
    expect(asked).toEqual([
      [20, 1],
      [30, 2, 2],
    ])

    // Nor for a block that isn't laced.
    asked.length = 0
    readWhole(laid(cluster(0, [key(2, 0, 1, 2)])), [byFirstByte])
    expect(asked).toEqual([])
  })

  it('does not need the last frame of a lace to say how long it is', () => {
    const lastUnknown: ClusterTrack = {
      number: 2,
      defaultDuration: null,
      lace: (frame) => (frame[0] === 7 ? null : 10),
    }
    const frames = [[1], [2], [7]]
    const file = laid(cluster(0, [simpleBlock({ track: 2, timecode: 0, lacing: 'xiph', frames })]))
    expect(readWhole(file, [lastUnknown]).frames.map((frame) => frame.pts)).toEqual([0, 10, 20])
  })

  it('takes a laced block with no duration to give, for a frame that has a frame after it, as damaged', () => {
    const second = cluster(2000, [key(2, 0, 5)])
    const lace = simpleBlock({ track: 2, timecode: 0, lacing: 'xiph', frames: [[1], [2], [3]] })
    const file = laid(cluster(1000, [key(2, 0, 4), lace]), second)
    const read = readWhole(file, [sound])
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: where(file, lace), end: where(file, second) }])
  })
})

describe('readClusters: damage (§10.4)', () => {
  it('skips a block whose lacing overruns to the next cluster, whose frames follow', () => {
    const bad = overrun(1)
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), bad, key(1, 40, 3)]), second)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: where(file, bad), end: where(file, second) }])
    expect(read).toMatchObject({ next: file.end, cluster: null, searching: false, ended: true })
  })

  it('skips damage in a cluster of unknown size the same way', () => {
    const bad = overrun(1)
    const second = cluster(2000, [key(1, 0, 4)], { unknown: true })
    const file = laid(cluster(1000, [key(1, 0, 1), bad, key(1, 40, 3)], { unknown: true }), second)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: where(file, bad), end: where(file, second) }])
  })

  it('does not take the bytes of a cluster ID in a payload for a cluster when it looks for one', () => {
    // `1F 43 B6 75 81 00` is a Cluster's ID, a size of 1 and a byte that isn't an element: no Timestamp.
    const bad = overrun(1, 0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00, 7, 7)
    // And one whose Timestamp comes after three other elements, which is too late.
    const late = overrun(
      1,
      ...[0x1f, 0x43, 0xb6, 0x75, 0x8c],
      ...[0xa7, 0x81, 1, 0xa7, 0x81, 1, 0xa7, 0x81, 1, 0xe7, 0x81, 0],
    )
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), bad, late, key(1, 40, 3)]), second)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: where(file, bad), end: where(file, second) }])
  })

  it('skips a cluster with no Timestamp as damaged', () => {
    const none = element(ID.Cluster, key(1, 0, 9), key(1, 40, 9))
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1)]), none, second)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: where(file, none), end: where(file, second) }])

    // A cluster of unknown size that is followed by a cluster before any Timestamp has none either.
    const empty = elementSized(ID.Cluster, [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    const after = laid(empty, second)
    const next = readWhole(after)
    expect(next.frames.map((frame) => frame.pts)).toEqual([2000])
    expect(next.skipped).toEqual([{ start: BASE, end: where(after, second) }])
  })

  it('counts the Timestamp among the first 3 children, the CRC-32 and Void not counted', () => {
    const position = uint(0xa7, 1)
    const third = element(
      ID.Cluster,
      element(ID.CRC32, [0, 0, 0, 0]),
      position,
      element(ID.Void, [0]),
      position,
      uint(ID.Timestamp, 77),
      key(1, 0, 1),
    )
    const fourth = element(
      ID.Cluster,
      position,
      position,
      position,
      uint(ID.Timestamp, 88),
      key(1, 0, 2),
    )
    const file = laid(third, fourth)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([77])
    expect(read.skipped).toEqual([{ start: where(file, fourth), end: file.end }])
  })

  it('skips a child that claims to run past its cluster, though its bytes are not held', () => {
    const big = elementSized(ID.SimpleBlock, sizeBytes(100000), [0x81, 0, 0, 0x80, 1])
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), big]), second)
    const read = readClusters(
      slice(file, BASE, where(file, big) + 8),
      BASE,
      null,
      false,
      file.end,
      BOTH,
    )
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.searching).toBe(true)
    expect(read.skipped[0]?.start).toBe(where(file, big))
    expect(readWhole(file).skipped).toEqual([{ start: where(file, big), end: where(file, second) }])
  })

  it('skips bytes that are no element between clusters', () => {
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1)]), new Uint8Array(37), second)
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 2000])
    expect(read.skipped).toEqual([{ start: file.at[1], end: where(file, second) }])
  })

  it('skips a header cut short by the end of the Segment, and ends', () => {
    const file = laid(cluster(1000, [key(1, 0, 1)]), new Uint8Array([0x1a, 0x45]))
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.skipped).toEqual([{ start: file.at[1], end: file.end }])
    expect(read).toMatchObject({ next: file.end, ended: true, searching: false })
  })

  it('reads the blocks of a sized cluster that a file cut short leaves, and skips the one cut', () => {
    const blocks = [key(1, 0, 1), key(1, 40, 2), key(1, 80, 3, 3, 3, 3)]
    const whole = laid(cluster(1000, blocks))
    // The Segment ends in the middle of the third block, and so does the file.
    const third = where(whole, blocks[2] ?? new Uint8Array())
    const cutAt = third + 5
    const read = readClusters(slice(whole, BASE, cutAt), BASE, null, false, cutAt, BOTH)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000, 1040])
    expect(read.skipped).toEqual([{ start: third, end: cutAt }])
    expect(read).toMatchObject({ next: cutAt, cluster: null, ended: true })
  })

  it('finds the cluster after damage in a later call, and carries the search between them', () => {
    const bad = overrun(1)
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), bad]), new Uint8Array(40), second)
    const damage = where(file, bad)
    const start = where(file, second)

    // The chunk ends after the damage and before the cluster: the search goes on 3 bytes before its end.
    const end = damage + bad.length + 20
    const first = readClusters(slice(file, BASE, end), BASE, null, false, file.end, BOTH)
    expect(first.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(first).toMatchObject({ next: end - 3, cluster: null, searching: true, ended: false })
    expect(first.skipped).toEqual([{ start: damage, end: end - 3 }])

    // A call that is searching starts by looking for a cluster, and adds what it passes over.
    const then = readClusters(slice(file, end - 3, file.end), end - 3, null, true, file.end, BOTH)
    expect(then.frames.map((frame) => frame.pts)).toEqual([2000])
    expect(then.skipped).toEqual([{ start: end - 3, end: start }])
    expect(then).toMatchObject({ searching: false, ended: true })
  })

  it('finds a cluster whose ID is cut by the end of the chunk in the next call', () => {
    const bad = overrun(1)
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), bad]), second)
    const start = where(file, second)
    for (const inside of [1, 2, 3]) {
      const first = readClusters(
        slice(file, BASE, start + inside),
        BASE,
        null,
        false,
        file.end,
        BOTH,
      )
      expect(first, `${inside} bytes of its ID`).toMatchObject({
        next: start + inside - 3,
        searching: true,
      })
      const then = readClusters(
        slice(file, first.next, file.end),
        first.next,
        null,
        true,
        file.end,
        BOTH,
      )
      expect(then.frames.map((frame) => frame.pts)).toEqual([2000])
      expect(merge([...first.skipped, ...then.skipped])).toEqual([
        { start: where(file, bad), end: start },
      ])
    }
  })

  it('does not pass a cluster whose ID is whole in the chunk but whose Timestamp is not', () => {
    const bad = overrun(1)
    const second = cluster(2000, [key(1, 0, 4)])
    const file = laid(cluster(1000, [key(1, 0, 1), bad]), second)
    const start = where(file, second)
    // The ID, the size and half of the Timestamp are held: 3 bytes before the end is past the cluster.
    const first = readClusters(slice(file, BASE, start + 6), BASE, null, false, file.end, BOTH)
    expect(first).toMatchObject({ next: start, searching: true })
    expect(first.skipped).toEqual([{ start: where(file, bad), end: start }])
    const then = readClusters(slice(file, start, file.end), start, null, true, file.end, BOTH)
    expect(then.frames.map((frame) => frame.pts)).toEqual([2000])
    expect(then.skipped).toEqual([])
  })

  it('does not wait for bytes that only look like a cluster and claim more than a header read', () => {
    // A cluster of unknown size whose first element, a Void, claims a megabyte: no cluster's first
    // elements reach so far, and a caller that read on to see them would read a file to its end.
    const claim = elementSized(ID.Void, sizeBytes(1 << 20), [0, 0, 0])
    const fake = elementSized(ID.Cluster, [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], claim)
    const real = cluster(2000, [key(1, 0, 4)])
    const file = laid(new Uint8Array(5), fake, new Uint8Array(30), real)
    const segmentEnd = file.end + (1 << 22)
    const start = where(file, fake)

    // A chunk that ends inside the claim is not waited for: the search goes past the candidate.
    const cut = start + 40
    const first = readClusters(slice(file, BASE, cut), BASE, null, true, segmentEnd, BOTH)
    expect(first).toMatchObject({ next: cut - 3, searching: true, frames: [] })
    expect(first.skipped).toEqual([{ start: BASE, end: cut - 3 }])
    expect(findCluster(slice(file, BASE, cut), BASE, segmentEnd)).toBeNull()

    // And the cluster after it is found, in the chunk that holds it.
    const then = readClusters(slice(file, BASE, file.end), BASE, null, true, segmentEnd, BOTH)
    expect(then.frames.map((frame) => frame.pts)).toEqual([2000])
    expect(then.skipped).toEqual([{ start: BASE, end: where(file, real) }])
  })

  it('takes a cluster whose first elements are large but within a header read', () => {
    const padded = element(
      ID.Cluster,
      element(ID.Void, new Uint8Array(60000)),
      uint(ID.Timestamp, 9),
      key(1, 0, 1),
    )
    const file = laid(padded)
    expect(findCluster(file.chunk, BASE, file.end)?.place.timestamp).toBe(9)
    expect(readWhole(file).frames.map((frame) => frame.pts)).toEqual([9])
  })

  it('ends a search when the chunk reaches the end of the Segment with no cluster in it', () => {
    const bad = overrun(1)
    const file = laid(cluster(1000, [key(1, 0, 1), bad]), new Uint8Array(30))
    const read = readWhole(file)
    expect(read.frames.map((frame) => frame.pts)).toEqual([1000])
    expect(read.skipped).toEqual([{ start: where(file, bad), end: file.end }])
    expect(read).toMatchObject({ next: file.end, searching: false, ended: true })

    // A search that is under way ends the same way.
    const then = readClusters(
      slice(file, file.end - 10, file.end),
      file.end - 10,
      null,
      true,
      file.end,
      BOTH,
    )
    expect(then).toMatchObject({ next: file.end, searching: false, ended: true })
    expect(then.skipped).toEqual([{ start: file.end - 10, end: file.end }])
  })

  it('makes progress when the chunk is too small to look in', () => {
    const file = laid(new Uint8Array(40))
    const read = readClusters(slice(file, BASE, BASE + 2), BASE, null, true, file.end, BOTH)
    expect(read.next).toBe(BASE)
    expect(read).toMatchObject({ searching: true, skipped: [], frames: [] })
  })
})

describe('findCluster (§10.4)', () => {
  it('finds the first cluster from a position, with its Timestamp, where it ends and whether it was sized', () => {
    const a = cluster(1000, [key(1, 0, 1)])
    const b = cluster(2000, [key(1, 0, 2)], { unknown: true })
    const file = laid(new Uint8Array(13), a, b)
    const first = findCluster(file.chunk, BASE, file.end)
    expect(first).toEqual({
      start: file.at[1],
      place: { timestamp: 1000, end: file.at[2], sized: true },
    })
    const again = findCluster(file.chunk, (file.at[1] ?? 0) + 1, file.end)
    expect(again).toEqual({
      start: file.at[2],
      place: { timestamp: 2000, end: file.end, sized: false },
    })
    expect(findCluster(file.chunk, (file.at[2] ?? 0) + 1, file.end)).toBeNull()
  })

  it('takes a cluster only when its Timestamp is among its first 3 children, the CRC-32 and Void not counted', () => {
    const position = uint(0xa7, 1)
    const accepted = element(
      ID.Cluster,
      element(ID.CRC32, [1, 2, 3, 4]),
      element(ID.Void, [0]),
      position,
      position,
      uint(ID.Timestamp, 5),
    )
    const rejected = element(ID.Cluster, position, position, position, uint(ID.Timestamp, 5))
    expect(findCluster(laid(accepted).chunk, BASE, BASE + accepted.length)?.place.timestamp).toBe(5)
    expect(findCluster(laid(rejected).chunk, BASE, BASE + rejected.length)).toBeNull()
    // A Timestamp that doesn't read (9 bytes wide) isn't one.
    const wide = element(ID.Cluster, element(ID.Timestamp, new Uint8Array(9)))
    expect(findCluster(laid(wide).chunk, BASE, BASE + wide.length)).toBeNull()
  })

  it('refuses a cluster that ends past the Segment, and one cut by the chunk', () => {
    const a = cluster(1000, [key(1, 0, 1)])
    const file = laid(a)
    expect(findCluster(file.chunk, BASE, file.end - 1)).toBeNull()
    expect(findCluster(file.chunk, BASE, file.end)).not.toBeNull()
    // Of unknown size it ends at the Segment's end, wherever that is.
    const unknown = laid(cluster(1000, [key(1, 0, 1)], { unknown: true }))
    expect(findCluster(unknown.chunk, BASE, unknown.end)).not.toBeNull()
    // The chunk ends in the Timestamp.
    expect(findCluster(slice(file, BASE, BASE + 8), BASE, file.end)).toBeNull()
    expect(findCluster(slice(file, BASE, BASE + 9), BASE, file.end)).not.toBeNull()
  })

  it('refuses a position that is not in the chunk', () => {
    const file = laid(cluster(1000, [key(1, 0, 1)]))
    expect(() => findCluster(file.chunk, BASE - 1, file.end)).toThrow(RangeError)
    expect(() => findCluster(file.chunk, file.end + 1, file.end)).toThrow(RangeError)
  })

  it("takes a sized cluster that the Segment's end cuts short only when asked, with its end at the Segment's", () => {
    // The Segment ends 3 bytes short of where the cluster's size says it does: a file that a writer's crash cut off.
    const file = laid(cluster(1000, [key(1, 0, 1), key(1, 33, 2)]))
    const cut = file.end - 3
    expect(findCluster(file.chunk, BASE, cut)).toBeNull()
    expect(findCluster(file.chunk, BASE, cut, false)).toBeNull()
    expect(findCluster(file.chunk, BASE, cut, true)).toEqual({
      start: BASE,
      place: { timestamp: 1000, end: cut, sized: true },
    })
    // A cluster that the Segment doesn't cut short is the same either way.
    expect(findCluster(file.chunk, BASE, file.end, true)).toEqual(
      findCluster(file.chunk, BASE, file.end),
    )
  })

  it('takes no cut-short cluster whose Timestamp the Segment cuts off', () => {
    // The Segment ends in the Timestamp, which is 2 bytes wide: the header and the first 3 bytes of it are all that remain.
    const file = laid(cluster(1000, [key(1, 0, 1)]))
    expect(findCluster(slice(file, BASE, BASE + 8), BASE, BASE + 8, true)).toBeNull()
    expect(findCluster(slice(file, BASE, BASE + 9), BASE, BASE + 9, true)).not.toBeNull()
  })
})

// Reading a file in pieces: each call is given a chunk of the file from where the
// last said to go on, and when a call goes no further the chunk grows, as a caller
// would read more.

/** Joins the ranges that touch, which a search in several calls skips in pieces. */
function merge(ranges: ByteRange[]): ByteRange[] {
  const out: ByteRange[] = []
  for (const range of ranges) {
    const last = out.at(-1)
    if (last?.end === range.start) last.end = range.end
    else out.push({ ...range })
  }
  return out
}

/**
 * Reads the file by chunks of `first` bytes and then of `later`, each from where the
 * call before said to go on, and a chunk that is `later` bytes longer than the last
 * when a call made no progress. Gives every frame and the ranges skipped (the
 * adjacent ones joined).
 */
function drive(
  file: Laid,
  tracks: readonly ClusterTrack[],
  first: number,
  later: number,
): { frames: RawFrame[]; skipped: ByteRange[] } {
  const frames: RawFrame[] = []
  const skipped: ByteRange[] = []
  let at = BASE
  let place: ClusterPlace | null = null
  let searching = false
  let size = first
  for (let calls = 0; calls < 100000; calls += 1) {
    const read = readClusters(slice(file, at, at + size), at, place, searching, file.end, tracks)
    expect(read.next).toBeGreaterThanOrEqual(at)
    frames.push(...read.frames)
    skipped.push(...read.skipped)
    if (read.ended) {
      expect(read.next).toBe(file.end)
      return { frames, skipped: merge(skipped) }
    }
    const progress = read.next > at || read.frames.length > 0 || read.skipped.length > 0
    size = progress ? later : size + later
    at = read.next
    place = read.cluster
    searching = read.searching
  }
  throw new Error('The reads never ended.')
}

describe('readClusters in pieces (§10.4)', () => {
  const opus = { codecId: 'A_OPUS', codecPrivate: null, audio: null }
  const tracks: ClusterTrack[] = [
    { number: 1, defaultDuration: 33, lace: NO_LACE },
    {
      number: 2,
      defaultDuration: null,
      lace: (frame) => {
        const samples = frameSamples(opus, frame)
        return samples === null ? null : (samples * 1000) / sampleRate(opus)
      },
    },
  ]
  const lace = (n: number) =>
    simpleBlock({
      track: 2,
      timecode: n,
      lacing: n % 2 === 0 ? 'xiph' : 'ebml',
      keyframe: true,
      frames: [
        [OPUS_20_MS, n, 1],
        [OPUS_20_MS, n, 2],
        [OPUS_20_MS, n, 3],
      ],
    })
  const cues = element(ID.Cues, element(ID.CuePoint, uint(ID.CueTime, 0)))
  const mixed = laid(
    cluster(
      0,
      [
        key(1, 0, 1, 1),
        lace(0),
        delta(9, 4, 9, 9, 9, 9, 9),
        blockGroup({ track: 1, timecode: 33, duration: 33, reference: -33, frames: [[2, 2]] }),
        element(ID.Void, new Uint8Array(20)),
        blockGroup({ track: 9, timecode: 33, duration: 33, frames: [[9, 9, 9]] }),
        lace(1),
      ],
      { crc: true },
    ),
    cues,
    cluster(
      1000,
      [
        key(1, 0, 3),
        blockGroup({
          track: 2,
          timecode: 0,
          duration: 60,
          lacing: 'xiph',
          frames: [[4], [5], [6]],
        }),
      ],
      {
        unknown: true,
      },
    ),
    cluster(2000, [key(1, 0, 5, 5), delta(1, 33, 6), lace(2)], { unknown: true }),
    element(ID.Tags, new Uint8Array(40)),
    cluster(3000, [key(1, 0, 7), delta(2, 3, 8, 8)]),
  )

  it('gives the frames a clean file is read as in one call, whatever the pieces', () => {
    const whole = drive(mixed, tracks, mixed.chunk.bytes.length, mixed.chunk.bytes.length)
    // The reference is itself right: every frame there is of the tracks asked for, in order.
    expect(whole.skipped).toEqual([])
    expect(whole.frames.map((frame) => [frame.track, frame.pts])).toEqual([
      [1, 0],
      [2, 0],
      [2, 20],
      [2, 40],
      [1, 33],
      [2, 1],
      [2, 21],
      [2, 41],
      [1, 1000],
      [2, 1000],
      [2, 1020],
      [2, 1040],
      [1, 2000],
      [1, 2033],
      [2, 2002],
      [2, 2022],
      [2, 2042],
      [1, 3000],
      [2, 3003],
    ])
    const length = mixed.chunk.bytes.length
    for (let size = 1; size <= length + 1; size += 1) {
      const pieces = drive(mixed, tracks, size, size)
      expect(pieces.frames, `pieces of ${size}`).toEqual(whole.frames)
      expect(pieces.skipped, `pieces of ${size}`).toEqual([])
    }
    for (let cut = 0; cut <= length; cut += 1) {
      const pieces = drive(mixed, tracks, cut, length)
      expect(pieces.frames, `a cut at ${cut}`).toEqual(whole.frames)
      expect(pieces.skipped, `a cut at ${cut}`).toEqual([])
    }
  })

  // A file with every kind of damage in it: a cluster ID in a payload, a block whose
  // lacing overruns, a cluster with no Timestamp, bytes that are no element, and a
  // tail that holds no cluster.
  const fake = overrun(1, 0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00, 7, 7)
  const noStamp = element(ID.Cluster, key(1, 0, 9))
  const afterFake = cluster(2000, [key(1, 0, 3)])
  const afterNoStamp = cluster(3000, [key(1, 0, 4), lace(0)], { unknown: true })
  const afterJunk = cluster(4000, [key(1, 0, 5), overrun(2)])
  const damaged = laid(
    cluster(1000, [key(1, 0, 1), fake, key(1, 33, 2)]),
    afterFake,
    noStamp,
    afterNoStamp,
    new Uint8Array(19),
    afterJunk,
    new Uint8Array(25).fill(0x1f),
  )

  it('skips damage the same way whatever the pieces', () => {
    const length = damaged.chunk.bytes.length
    const whole = drive(damaged, tracks, length, length)
    // The bytes that are no element follow the last block of a cluster of unknown size, which nothing then tells to be a block: the damage starts at that block, whose frames are not given.
    expect(whole.frames.map((frame) => [frame.track, frame.pts])).toEqual([
      [1, 1000],
      [1, 2000],
      [1, 3000],
      [1, 4000],
    ])
    expect(whole.skipped).toEqual([
      { start: where(damaged, fake), end: where(damaged, afterFake) },
      { start: where(damaged, noStamp), end: where(damaged, afterNoStamp) },
      { start: where(damaged, lace(0)), end: where(damaged, afterJunk) },
      { start: where(damaged, overrun(2)), end: damaged.end },
    ])
    for (let size = 1; size <= length + 1; size += 1) {
      const pieces = drive(damaged, tracks, size, size)
      expect(pieces.frames, `pieces of ${size}`).toEqual(whole.frames)
      expect(pieces.skipped, `pieces of ${size}`).toEqual(whole.skipped)
    }
    for (let cut = 0; cut <= length; cut += 1) {
      const pieces = drive(damaged, tracks, cut, length)
      expect(pieces.frames, `a cut at ${cut}`).toEqual(whole.frames)
      expect(pieces.skipped, `a cut at ${cut}`).toEqual(whole.skipped)
    }
  })

  it('reads a file that is cut short the same way whatever the pieces', () => {
    // The last block of the last cluster is cut in the middle, and the Segment ends there.
    const cut = mixed.chunk.bytes.length - 3
    const file: Laid = {
      chunk: { start: BASE, bytes: mixed.chunk.bytes.slice(0, cut) },
      at: [BASE],
      end: BASE + cut,
    }
    const whole = drive(file, tracks, cut, cut)
    expect(whole.frames.at(-1)).toMatchObject({ track: 1, pts: 3000 })
    expect(whole.skipped).toEqual([{ start: where(mixed, delta(2, 3, 8, 8)), end: BASE + cut }])
    for (let size = 1; size <= cut + 1; size += 1) {
      const pieces = drive(file, tracks, size, size)
      expect(pieces.frames, `pieces of ${size}`).toEqual(whole.frames)
      expect(pieces.skipped, `pieces of ${size}`).toEqual(whole.skipped)
    }
  })

  it('throws what is not a damaged file, which is a mistake of the caller', () => {
    const broken: ClusterTrack = {
      number: 2,
      defaultDuration: null,
      lace: () => {
        throw new TypeError('a mistake of the caller')
      },
    }
    const frames = [[1], [2]]
    const file = laid(cluster(0, [simpleBlock({ track: 2, timecode: 0, lacing: 'xiph', frames })]))
    expect(() => readWhole(file, [broken])).toThrow(TypeError)
  })
})

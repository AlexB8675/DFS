import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { heldBytes, heldFrom, heldPrefix } from '../source.ts'
import type { ByteRange, Chunk } from '../source.ts'
import { concat } from '../testing/build.ts'
import {
  binary,
  ebmlHeader,
  element,
  elementSized,
  float,
  info,
  matroskaFile,
  seekEntry,
  seekHead,
  sizeBytes,
  string,
  uint,
  unknownSize,
} from '../testing/ebml.ts'
import type { FilePart, MatroskaFile } from '../testing/ebml.ts'
import { covers, readHead, readHeadCovered } from './head.ts'
import type { MatroskaHead } from './head.ts'
import { ID } from './ids.ts'
import { HEADER_READ, MAX_INDEX_READS } from './limits.ts'

const MIB = 1024 * 1024

/** What a caller reads first, a megabyte (HEAD_BYTES, which a later task names). */
const HEAD = MIB

/** The most asks a test lets a walk make before it calls the walk lost: far above the cap. */
const TURNS = 40

/** What `run` throws, which must be an `Mp4Error` that calls the file damaged. */
function damaged(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe('damaged')
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error')
}

interface Opened {
  head: MatroskaHead
  /** The ranges the walk asked for, in order. */
  asks: ByteRange[]
  chunks: Chunk[]
}

/**
 * Reads a head the way a caller does: the first `head` bytes of the file, then
 * each range the walk asks for, until it is done. Every ask is held to the
 * rules on the way: it lies inside the file, it is never a range the walk
 * holds, and a walk that goes on asking is stopped. `asks` is filled even when
 * the walk is refused, so that a test can count them.
 */
function open(
  bytes: Uint8Array,
  { head = HEAD, asks = [] }: { head?: number; asks?: ByteRange[] } = {},
): Opened {
  const chunks: Chunk[] = [{ start: 0, bytes: bytes.subarray(0, Math.min(head, bytes.length)) }]
  for (let turn = 0; turn < TURNS; turn += 1) {
    const step = readHead(chunks, bytes.length)
    if ('done' in step) return { head: step.done, asks, chunks }
    const { start, end } = step.need
    expect(Number.isSafeInteger(start) && start >= 0 && start < end && end <= bytes.length).toBe(
      true,
    )
    expect(heldBytes(chunks, start, end)).toBeNull()
    asks.push(step.need)
    chunks.push({ start, bytes: bytes.subarray(start, end) })
  }
  throw new Error('the walk went on asking')
}

/** The offset of a part of a laid-out file, which must be there. */
function offset(file: MatroskaFile, index: number): number {
  const at = file.offsets[index]
  if (at === undefined) throw new Error(`There is no part ${index}.`)
  return at
}

/** Where a part of a laid-out file is, from its header to the next part or the file's end. */
function span(file: MatroskaFile, index: number): ByteRange {
  return { start: offset(file, index), end: file.offsets[index + 1] ?? file.bytes.length }
}

/** A SeekHead of entries that each name the part at an index of the file, a position the layout fills in. */
function seeking(...targets: [id: number, index: number][]): FilePart {
  return (at) => seekHead(targets.map(([id, index]) => [id, at[index] ?? 0]))
}

/** Cues that a SeekHead names and the head has not read: where they start in the file, and no end. */
function unread(file: MatroskaFile, index: number): { start: number; end: null } {
  return { start: offset(file, index), end: null }
}

const crc = (): Uint8Array => element(ID.CRC32, [0xde, 0xad, 0xbe, 0xef])
const padding = (size: number): Uint8Array => element(ID.Void, new Uint8Array(size))
const tags = (size: number): Uint8Array => element(ID.Tags, new Uint8Array(size))
const tracks = (): Uint8Array => element(ID.Tracks, element(ID.TrackEntry, uint(ID.TrackNumber, 1)))
const cues = (): Uint8Array => element(ID.Cues, element(ID.CuePoint, uint(ID.CueTime, 0)))
const cluster = (size = 200): Uint8Array =>
  element(ID.Cluster, uint(ID.Timestamp, 0), binary(ID.SimpleBlock, new Uint8Array(size)))

/** An EBML header with the elements given, as a test needs it to be wrong. */
const ebml = (...parts: Uint8Array[]): Uint8Array => element(ID.EBML, ...parts)

/** The smallest head that is good: a file of Info and Tracks and a Cluster. */
function small(header?: Uint8Array): MatroskaFile {
  return matroskaFile([info({ duration: 1 }), tracks(), cluster()], header ? { header } : {})
}

describe('the head of a Matroska file (§10.4)', () => {
  it('reads a WebM with everything in its head', () => {
    const file = matroskaFile(
      [
        seeking([ID.Info, 1], [ID.Tracks, 2], [ID.Cues, 4]),
        info({ scale: 1_000_000, duration: 4021 }),
        tracks(),
        cluster(),
        cues(),
      ],
      { header: ebmlHeader({ docType: 'webm' }) },
    )
    const { head, asks } = open(file.bytes)

    expect(asks).toEqual([])
    expect(head).toEqual({
      docType: 'webm',
      segment: { data: file.segmentData, end: file.bytes.length },
      timestampScale: 1_000_000,
      durationTicks: 4021,
      tracks: span(file, 2),
      // The Cues come after the first Cluster, so only the SeekHead says where they are: the head gives their position, unread, and no end.
      cues: unread(file, 4),
      firstCluster: offset(file, 3),
      reads: 0,
    })
  })

  it('stops at the first of many Clusters, and names a file matroska by its DocType', () => {
    const file = matroskaFile([info({}), tracks(), cluster(), cluster(), cluster()])
    const { head } = open(file.bytes)
    expect(head.docType).toBe('matroska')
    expect(head.firstCluster).toBe(offset(file, 2))
  })

  it('passes over the CRC-32 and the Void that ffmpeg writes in a SeekHead, Info and Tracks', () => {
    // ffmpeg's head: a SeekHead with a CRC-32 first, a Void after it, Info and Tracks with one each.
    const file = matroskaFile([
      (at) =>
        element(
          ID.SeekHead,
          crc(),
          seekEntry(ID.Cues, at[5] ?? 0),
          padding(30),
          seekEntry(ID.Tracks, at[3] ?? 0),
        ),
      padding(100),
      element(
        ID.Info,
        crc(),
        uint(ID.TimestampScale, 1_000),
        padding(4),
        float(ID.Duration, 7.5),
        padding(0),
      ),
      element(ID.Tracks, crc(), element(ID.TrackEntry, uint(ID.TrackNumber, 1))),
      cluster(),
      cues(),
    ])
    const { head, asks } = open(file.bytes)

    expect(asks).toEqual([])
    expect(head.timestampScale).toBe(1_000)
    expect(head.durationTicks).toBe(7.5)
    expect(head.tracks).toEqual(span(file, 3))
    expect(head.cues).toEqual(unread(file, 5))
    expect(head.firstCluster).toBe(offset(file, 4))
  })

  it('takes 1 000 000 ns for the timestamp scale when Info has none, and refuses 0', () => {
    const none = matroskaFile([info({ duration: 5 }), tracks(), cluster()])
    expect(open(none.bytes).head.timestampScale).toBe(1_000_000)

    const other = matroskaFile([info({ scale: 1_000 }), tracks(), cluster()])
    expect(open(other.bytes).head.timestampScale).toBe(1_000)

    const zero = matroskaFile([info({ scale: 0 }), tracks(), cluster()])
    expect(damaged(() => open(zero.bytes)).message).toMatch(/TimestampScale/)
  })

  it('has no duration when Info has none, or one that is not a time, and reads the head all the same', () => {
    expect(open(matroskaFile([info({}), tracks(), cluster()]).bytes).head.durationTicks).toBeNull()
    expect(
      open(matroskaFile([info({ duration: 0 }), tracks(), cluster()]).bytes).head.durationTicks,
    ).toBe(0)
    // Single and double floats alike.
    const single = element(ID.Info, float(ID.Duration, 12.5, 4))
    expect(open(matroskaFile([single, tracks(), cluster()]).bytes).head.durationTicks).toBe(12.5)
    // A Duration is advisory (the index finds the end by the last frame without one), so what is no time is none: below 0, NaN, infinite, or a float of no width a float has.
    const bad = [
      info({ scale: 5, duration: -1 }),
      info({ scale: 5, duration: Number.NaN }),
      info({ scale: 5, duration: Number.POSITIVE_INFINITY }),
      info({ scale: 5, duration: Number.NEGATIVE_INFINITY }),
      element(ID.Info, uint(ID.TimestampScale, 5), element(ID.Duration, [1, 2])),
      element(ID.Info, uint(ID.TimestampScale, 5), element(ID.Duration, [1, 2, 3])),
      element(ID.Info, uint(ID.TimestampScale, 5), element(ID.Duration, new Uint8Array(9))),
    ]
    for (const entry of bad) {
      const file = matroskaFile([entry, tracks(), cluster()])
      const { head } = open(file.bytes)
      expect(head.durationTicks).toBeNull()
      // The rest of Info, and of the head, is read as it is.
      expect(head.timestampScale).toBe(5)
      expect(head.tracks).toEqual(span(file, 1))
      expect(head.firstCluster).toBe(offset(file, 2))
    }
    // The first Duration is the one that counts: a good one after a bad one is not taken.
    const twice = element(ID.Info, element(ID.Duration, [1, 2]), float(ID.Duration, 9))
    expect(open(matroskaFile([twice, tracks(), cluster()]).bytes).head.durationTicks).toBeNull()
  })

  it('has defaults when Info is nowhere, since a file without one has the defaults of Matroska', () => {
    const file = matroskaFile([tracks(), cluster()])
    const { head } = open(file.bytes)
    expect(head.timestampScale).toBe(1_000_000)
    expect(head.durationTicks).toBeNull()
  })

  it('reads Info that comes after the first Cluster when the SeekHead says where it is', () => {
    const file = matroskaFile([
      seeking([ID.Info, 3]),
      tracks(),
      cluster(),
      info({ scale: 2_000_000, duration: 9 }),
    ])
    const { head } = open(file.bytes)
    expect(head.timestampScale).toBe(2_000_000)
    expect(head.durationTicks).toBe(9)
    expect(head.firstCluster).toBe(offset(file, 2))
  })
})

describe('the EBML header of a Matroska file (§10.4)', () => {
  it('refuses a DocTypeReadVersion above 4, and takes 4', () => {
    const refused = damaged(() => open(small(ebmlHeader({ readVersion: 5 })).bytes))
    expect(refused.message).toMatch(/version 5/)
    expect(open(small(ebmlHeader({ readVersion: 4 })).bytes).head.docType).toBe('matroska')
    expect(open(small(ebmlHeader({ readVersion: 1 })).bytes).head.docType).toBe('matroska')
  })

  it('refuses a DocType that is neither matroska nor webm', () => {
    expect(damaged(() => open(small(ebmlHeader({ docType: 'avi' })).bytes)).message).toMatch(/avi/)
    damaged(() => open(small(ebmlHeader({ docType: 'Matroska' })).bytes))
    damaged(() => open(small(ebmlHeader({ docType: '' })).bytes))
    // No DocType at all is not one either.
    damaged(() => open(small(ebml(uint(ID.EBMLReadVersion, 1))).bytes))
  })

  it('reads a DocType that a writer padded with 0 bytes', () => {
    const padded = ebml(element(ID.DocType, [...new TextEncoder().encode('webm'), 0, 0]))
    expect(open(small(padded).bytes).head.docType).toBe('webm')
  })

  it('refuses an EBMLReadVersion above 1, and an ID or a size wider than there are', () => {
    const header = (...parts: Uint8Array[]): Uint8Array =>
      small(ebml(string(ID.DocType, 'webm'), ...parts)).bytes
    expect(damaged(() => open(header(uint(ID.EBMLReadVersion, 2)))).message).toMatch(/version 2/)
    expect(damaged(() => open(header(uint(ID.EBMLMaxIDLength, 5)))).message).toMatch(/IDs of 5/)
    expect(damaged(() => open(header(uint(ID.EBMLMaxSizeLength, 9)))).message).toMatch(/sizes of 9/)
  })

  it('takes the defaults of the standard for what the header leaves out', () => {
    // Read version 1, an ID of 4 bytes and a size of 8, and read version 1 of the DocType.
    const bare = ebml(string(ID.DocType, 'webm'))
    expect(open(small(bare).bytes).head.docType).toBe('webm')
    const widest = ebml(
      string(ID.DocType, 'webm'),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
    )
    expect(open(small(widest).bytes).head.docType).toBe('webm')
    // Narrower ones are no problem.
    const narrow = ebml(
      string(ID.DocType, 'webm'),
      uint(ID.EBMLMaxIDLength, 3),
      uint(ID.EBMLMaxSizeLength, 4),
    )
    expect(open(small(narrow).bytes).head.docType).toBe('webm')
  })

  it('refuses a file that does not start with an EBML header, and an empty one', () => {
    const notEbml = matroskaFile([info({}), tracks(), cluster()], {
      header: element(ID.Void, [0, 0]),
    })
    damaged(() => open(notEbml.bytes))
    damaged(() => open(new Uint8Array(0)))
    damaged(() => open(new Uint8Array(3)))
    // An MP4's first bytes.
    damaged(() =>
      open(
        concat(
          [0, 0, 0, 0x18],
          new TextEncoder().encode('ftypisom'),
          new Array<number>(16).fill(0),
        ),
      ),
    )
  })

  it('refuses an EBML header that is cut short, of unknown size, or too big', () => {
    const file = small()
    damaged(() => open(file.bytes.subarray(0, 10)))
    damaged(() =>
      open(matroskaFile([cluster()], { header: elementSized(ID.EBML, unknownSize()) }).bytes),
    )
    const big = ebml(binary(ID.DocType, new Uint8Array(HEADER_READ + 1)))
    damaged(() => open(small(big).bytes))
  })
})

describe('the Segment of a Matroska file (§10.4)', () => {
  it('passes over a Void between the EBML header and the Segment', () => {
    const plain = small()
    const bytes = concat(
      plain.bytes.subarray(0, ebmlHeader().length),
      padding(10),
      plain.bytes.subarray(ebmlHeader().length),
    )
    const { head } = open(bytes)
    expect(head.segment.data).toBe(plain.segmentData + padding(10).length)
    expect(head.firstCluster).toBe(offset(plain, 2) + padding(10).length)
  })

  it('refuses a file whose second element is not a Segment, or that has none', () => {
    const header = ebmlHeader()
    damaged(() => open(concat(header, tracks())))
    damaged(() => open(header))
    damaged(() => open(concat(header, padding(5))))
  })

  it('ends a Segment of unknown size at the end of the file', () => {
    const file = matroskaFile([info({}), tracks(), cluster()], { unknown: true })
    const { head } = open(file.bytes)
    expect(head.segment).toEqual({ data: file.segmentData, end: file.bytes.length })
    expect(head.firstCluster).toBe(offset(file, 2))
  })

  it('ends a Segment that claims more than the file at the end of the file, as a recording cut off', () => {
    // The Cues are cut, and the Cluster too: the file ends 20 bytes into it.
    const file = matroskaFile([seeking([ID.Cues, 4]), info({}), tracks(), cluster(), cues()])
    const cut = file.bytes.subarray(0, offset(file, 3) + 20)
    const { head } = open(cut)
    expect(head.segment).toEqual({ data: file.segmentData, end: cut.length })
    expect(head.firstCluster).toBe(offset(file, 3))
    expect(head.tracks).toEqual(span(file, 2))
    // The SeekHead names Cues that the file no longer has.
    expect(head.cues).toBeNull()
  })

  it('ends a Segment of its own size when the file goes on past it', () => {
    const file = small()
    const bytes = concat(file.bytes, new Uint8Array(500))
    const { head } = open(bytes)
    expect(head.segment).toEqual({ data: file.segmentData, end: file.bytes.length })
  })

  it('refuses a Segment with no Cluster, and one whose elements overrun it', () => {
    expect(damaged(() => open(matroskaFile([info({}), tracks()]).bytes)).message).toMatch(
      /no Cluster/,
    )
    damaged(() => open(matroskaFile([]).bytes))
    // Tracks that claim more than the Segment holds.
    const long = elementSized(ID.Tracks, [0x90], [1, 2, 3])
    damaged(() => open(matroskaFile([info({}), long]).bytes))
    // Info that does.
    damaged(() => open(matroskaFile([elementSized(ID.Info, [0x90], [1, 2, 3])]).bytes))
  })

  it('refuses a header that is cut short by the end of the file or of the Segment', () => {
    const file = matroskaFile([info({}), tracks(), cluster()])
    // The file ends 2 bytes into the Cluster's header: its ID of 4 bytes is not whole.
    expect(damaged(() => open(file.bytes.subarray(0, offset(file, 2) + 2))).message).toMatch(
      /cut short/,
    )
    // The Segment ends there, with the file going on.
    const clipped = concat(
      ebmlHeader(),
      elementSized(
        ID.Segment,
        sizeBytes(offset(file, 2) + 2 - file.segmentData),
        file.bytes.subarray(file.segmentData),
      ),
    )
    expect(damaged(() => open(clipped)).message).toMatch(/cut short/)
  })

  it('refuses a child with an unknown size other than a Cluster', () => {
    const file = matroskaFile([info({}), elementSized(ID.Tracks, unknownSize(), [1, 2]), cluster()])
    damaged(() => open(file.bytes))
  })

  it('refuses an element of the Segment with an ID or a size that cannot be', () => {
    // An ID that starts with 0 is wider than 4 bytes.
    damaged(() => open(matroskaFile([info({}), Uint8Array.from([0x01, 0x80]), cluster()]).bytes))
    // A size that starts with 0 is wider than 8 bytes.
    damaged(() =>
      open(matroskaFile([info({}), Uint8Array.from([0xec, 0x00, 1, 2, 3]), cluster()]).bytes),
    )
  })

  it('stops at a Cluster of unknown size as at one that has its size', () => {
    const unknown = elementSized(ID.Cluster, unknownSize(), uint(ID.Timestamp, 0))
    const file = matroskaFile([info({}), tracks(), unknown], { unknown: true })
    const { head } = open(file.bytes)
    expect(head.firstCluster).toBe(offset(file, 2))
    expect(head.segment.end).toBe(file.bytes.length)
  })

  it('passes over the elements it does not read', () => {
    const file = matroskaFile([
      info({}),
      element(0x5abc, [1, 2, 3]),
      element(ID.Chapters, [1]),
      element(ID.Attachments, new Uint8Array(1000)),
      tracks(),
      padding(10),
      tags(5),
      cluster(),
    ])
    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(head.tracks).toEqual(span(file, 4))
    expect(head.firstCluster).toBe(offset(file, 7))
  })
})

describe('Tracks and Cues, which the head locates (§10.4)', () => {
  it('finds Cues that stand before the first Cluster by walking, with no SeekHead', () => {
    const file = matroskaFile([info({}), tracks(), cues(), cluster()])
    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(head.cues).toEqual(span(file, 2))
    expect(head.firstCluster).toBe(offset(file, 3))
  })

  it('has no Cues when nothing says where they are', () => {
    const { head } = open(matroskaFile([info({}), tracks(), cluster(), cues()]).bytes)
    expect(head.cues).toBeNull()
  })

  it('takes the Cues that it met over the ones a SeekHead names', () => {
    const file = matroskaFile([
      seeking([ID.Cues, 5]),
      info({}),
      tracks(),
      cues(),
      cluster(),
      cues(),
    ])
    expect(open(file.bytes).head.cues).toEqual(span(file, 3))
  })

  it('refuses a file with no Tracks before its first Cluster that the SeekHead does not name', () => {
    const message = damaged(() => open(matroskaFile([info({}), cluster(), tracks()]).bytes)).message
    expect(message).toMatch(/Tracks/)
    damaged(() => open(matroskaFile([seeking([ID.Cues, 3]), info({}), cluster(), cues()]).bytes))
  })

  it('finds Tracks that stand after the first Cluster when the SeekHead names them', () => {
    const file = matroskaFile([seeking([ID.Tracks, 3]), info({}), cluster(), tracks()])
    const { head } = open(file.bytes)
    expect(head.tracks).toEqual(span(file, 3))
    expect(head.firstCluster).toBe(offset(file, 2))
  })

  it('leaves out an entry of the SeekHead that points past the Segment', () => {
    const file = matroskaFile([
      (at) =>
        seekHead([
          [ID.Cues, (at[4] ?? 0) + 1000],
          [ID.Tracks, at[2] ?? 0],
        ]),
      info({}),
      tracks(),
      cluster(),
      cues(),
    ])
    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([])
    expect(head.cues).toBeNull()
    expect(head.tracks).toEqual(span(file, 2))
    // At the Segment's very end is past it as well: there is no element there.
    const atEnd = matroskaFile([
      (at) => seekHead([[ID.Cues, (at[4] ?? 0) + cues().length]]),
      info({}),
      tracks(),
      cluster(),
      cues(),
    ])
    expect(open(atEnd.bytes).head.cues).toBeNull()
  })

  it('gives the position that an entry names for the Cues as it is, unread, so a stale one is for the seek to find out', () => {
    // The Cues are said to be at the Cluster, or in the middle of a Void: the head does not look.
    const file = matroskaFile([seeking([ID.Cues, 3]), info({}), tracks(), cluster()])
    const { head, asks } = open(file.bytes)
    expect(head.cues).toEqual(unread(file, 3))
    expect(asks).toEqual([])
    const zero = matroskaFile([
      (at) => seekHead([[ID.Cues, (at[3] ?? 0) + 6]]),
      info({}),
      tracks(),
      element(ID.Void, new Uint8Array(40)),
      cluster(),
    ])
    expect(open(zero.bytes).head.cues).toEqual({ start: offset(zero, 3) + 6, end: null })
  })

  it('leaves out an entry for Tracks whose position holds another element, or none, as a stale one does', () => {
    // Tracks are said to be at the Info, and then where they are: the first entry is stale, the second is right.
    const stale = matroskaFile([
      seeking([ID.Tracks, 1], [ID.Tracks, 3]),
      info({}),
      cluster(),
      tracks(),
    ])
    expect(open(stale.bytes).head.tracks).toEqual(span(stale, 3))

    // An entry that points into the middle of an element is not a header either: here, into a zero.
    const zero = matroskaFile([
      (at) =>
        seekHead([
          [ID.Tracks, (at[3] ?? 0) + 6],
          [ID.Tracks, at[4] ?? 0],
        ]),
      info({}),
      cluster(),
      element(ID.Void, new Uint8Array(40)),
      tracks(),
    ])
    expect(open(zero.bytes).head.tracks).toEqual(span(zero, 4))
  })

  it('does not take Tracks from an entry that leads to another element, and so refuses the file', () => {
    const file = matroskaFile([seeking([ID.Tracks, 2]), info({}), cluster(), cues()])
    damaged(() => open(file.bytes))
  })

  it('leaves out an entry that is missing its ID or its position, or has an ID that cannot be', () => {
    // A position of 8 bytes, as the builder writes them, so that the SeekHead is as long whatever it says.
    const wide = (at: number): Uint8Array =>
      element(ID.SeekPosition, [0, 0, 0, 0, 0, 0, (at >> 8) & 0xff, at & 0xff])
    const entries = (at: number): Uint8Array[] => [
      // No position, no ID.
      element(ID.Seek, binary(ID.SeekID, [0x1c, 0x53, 0xbb, 0x6b])),
      element(ID.Seek, wide(at)),
      // An ID of 5 bytes that is Cues's with a 0 in front, and one of none.
      element(ID.Seek, binary(ID.SeekID, [0, 0x1c, 0x53, 0xbb, 0x6b]), wide(at)),
      element(ID.Seek, binary(ID.SeekID, []), wide(at)),
      // Something that is no Seek.
      element(ID.Void, [1]),
    ]
    const only = matroskaFile([
      (at) => element(ID.SeekHead, ...entries(at[4] ?? 0)),
      info({}),
      tracks(),
      cluster(),
      cues(),
    ])
    expect(open(only.bytes).head.cues).toBeNull()

    // With an entry that is whole among them, the Cues are found.
    const among = matroskaFile([
      (at) => element(ID.SeekHead, ...entries(at[4] ?? 0), seekEntry(ID.Cues, at[4] ?? 0)),
      info({}),
      tracks(),
      cluster(),
      cues(),
    ])
    expect(open(among.bytes).head.cues).toEqual(unread(among, 4))
  })

  it('refuses a SeekPosition that is not a number a file has', () => {
    const file = matroskaFile([
      element(
        ID.SeekHead,
        element(
          ID.Seek,
          binary(ID.SeekID, [0x1c, 0x53, 0xbb, 0x6b]),
          element(ID.SeekPosition, new Uint8Array(9)),
        ),
      ),
      info({}),
      tracks(),
      cluster(),
    ])
    damaged(() => open(file.bytes))
  })

  it('reads a second SeekHead that the first names, when Tracks are in it, and not otherwise', () => {
    // The first SeekHead knows only where the second is, after the Cluster, and the second where the Tracks and the Cues are.
    const file = matroskaFile([
      seeking([ID.SeekHead, 3]),
      info({}),
      cluster(),
      seeking([ID.Tracks, 4], [ID.Cues, 5]),
      tracks(),
      cues(),
    ])
    const { head } = open(file.bytes)
    expect(head.tracks).toEqual(span(file, 4))
    // Its entry for the Cues is read like the first's: unread.
    expect(head.cues).toEqual(unread(file, 5))

    // Info is another reason: the second SeekHead says where it is.
    const infoNamed = matroskaFile([
      seeking([ID.SeekHead, 3]),
      tracks(),
      cluster(),
      seeking([ID.Info, 4]),
      info({ scale: 7 }),
    ])
    expect(open(infoNamed.bytes).head.timestampScale).toBe(7)

    // The second names a third, which is not followed: one level deep.
    const deep = matroskaFile([
      seeking([ID.SeekHead, 3]),
      info({}),
      cluster(),
      seeking([ID.SeekHead, 4]),
      seeking([ID.Tracks, 5]),
      tracks(),
    ])
    expect(damaged(() => open(deep.bytes)).message).toMatch(/Tracks/)

    // A second SeekHead that stands before the Cluster is met by the walk like the first.
    const met = matroskaFile([
      seeking([ID.SeekHead, 1]),
      seeking([ID.Tracks, 5]),
      info({}),
      cluster(),
      cues(),
      tracks(),
    ])
    expect(open(met.bytes).head.tracks).toEqual(span(met, 5))

    // A SeekHead that names itself, or the first, is read once.
    const loop = matroskaFile([
      seeking([ID.SeekHead, 0], [ID.SeekHead, 3]),
      info({}),
      cluster(),
      seeking([ID.SeekHead, 3], [ID.SeekHead, 0], [ID.Tracks, 4]),
      tracks(),
    ])
    expect(open(loop.bytes).head.tracks).toEqual(span(loop, 4))
  })

  it('reads a second SeekHead from afar by asking for it, and no more than that', () => {
    // A Cluster of 2 MiB between: the second SeekHead is not in the head.
    const file = matroskaFile([
      seeking([ID.SeekHead, 3]),
      info({}),
      cluster(2 * MIB),
      seeking([ID.Tracks, 4]),
      tracks(),
    ])
    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: offset(file, 3), end: file.bytes.length }])
    expect(head.tracks).toEqual(span(file, 4))
    expect(head.reads).toBe(1)
  })

  it('reads no second SeekHead when Tracks and Info are found, which would be a read for nothing, nor for the Cues alone', () => {
    // The Cues are met by the walk.
    const met = matroskaFile([
      seeking([ID.SeekHead, 5]),
      info({}),
      tracks(),
      cues(),
      cluster(2 * MIB),
      seeking([ID.Cues, 3]),
    ])
    const found = open(met.bytes)
    expect(found.asks).toEqual([])
    expect(found.head.cues).toEqual(span(met, 3))
    expect(found.head.reads).toBe(0)

    // The Cues are in the second SeekHead alone, which nothing else asks for: the file has none that the head knows of.
    const alone = matroskaFile([
      seeking([ID.SeekHead, 4]),
      info({}),
      tracks(),
      cluster(2 * MIB),
      seeking([ID.Cues, 5]),
      cues(),
    ])
    const none = open(alone.bytes)
    expect(none.asks).toEqual([])
    expect(none.head.cues).toBeNull()
    expect(none.head.reads).toBe(0)
  })

  it('is done at once with a file that has its Cues after the last Cluster, as ffmpeg and OBS write it', () => {
    // A SeekHead that names the Cues, and 2 MiB of Clusters: the head of 1 MiB holds all up to the first Cluster.
    const file = matroskaFile([
      seeking([ID.Info, 1], [ID.Tracks, 2], [ID.Cues, 4]),
      info({ scale: 1_000_000, duration: 4021 }),
      tracks(),
      cluster(2 * MIB),
      cues(),
    ])
    const first = readHead([{ start: 0, bytes: file.bytes.subarray(0, HEAD) }], file.bytes.length)
    if (!('done' in first)) throw new Error('expected the head at the first call')
    // Where the SeekHead says, as an offset in the file, and not read: the head has no end to give.
    expect(first.done.cues).toEqual({ start: offset(file, 4), end: null })
    expect(first.done.cues?.start).toBeGreaterThan(HEAD)
    expect(first.done.reads).toBe(0)
    expect(first.done.firstCluster).toBe(offset(file, 3))
    expect(first.done.tracks).toEqual(span(file, 2))
    expect(first.done.durationTicks).toBe(4021)
    expect(open(file.bytes).asks).toEqual([])
  })

  it('refuses SeekHead and Info that are bigger than a read of a header, which no file has', () => {
    const big = (id: number): Uint8Array => element(id, padding(HEADER_READ))
    damaged(() => open(matroskaFile([big(ID.SeekHead), tracks(), cluster()]).bytes))
    damaged(() => open(matroskaFile([big(ID.Info), tracks(), cluster()]).bytes))
    // One of exactly that many bytes, header included, is read.
    const edge = element(ID.Info, float(ID.Duration, 3), padding(HEADER_READ - 7 - 11 - 4))
    expect(edge.length).toBe(HEADER_READ)
    expect(open(matroskaFile([edge, tracks(), cluster()]).bytes).head.durationTicks).toBe(3)
    const over = element(ID.Info, float(ID.Duration, 3), padding(HEADER_READ - 7 - 11 - 3))
    expect(over.length).toBe(HEADER_READ + 1)
    damaged(() => open(matroskaFile([over, tracks(), cluster()]).bytes))
  })
})

describe('what the walk asks for when the head is not enough (§10.4)', () => {
  it('asks for the header after 3 MiB of Tags, and is done with it', () => {
    const file = matroskaFile([info({ duration: 4021 }), tracks(), tags(3 * MIB), cluster(70_000)])
    const tagsEnd = offset(file, 3)
    const first = readHead([{ start: 0, bytes: file.bytes.subarray(0, HEAD) }], file.bytes.length)
    expect(first).toEqual({ need: { start: tagsEnd, end: tagsEnd + 65536 } })

    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: tagsEnd, end: tagsEnd + HEADER_READ }])
    expect(head.firstCluster).toBe(tagsEnd)
    expect(head.tracks).toEqual(span(file, 1))
    expect(head.durationTicks).toBe(4021)
    expect(head.reads).toBe(1)
  })

  it('cuts what it asks for at the end of the file', () => {
    const file = matroskaFile([info({}), tracks(), tags(2 * MIB), cluster(30)])
    const { head, asks } = open(file.bytes)
    expect(asks).toEqual([{ start: offset(file, 3), end: file.bytes.length }])
    expect(head.firstCluster).toBe(offset(file, 3))
  })

  it('asks for the whole of an Info that the head cuts, and of a SeekHead', () => {
    // A head of 40 bytes less than needed to hold the Info: its header is held, its end is not.
    const file = matroskaFile([
      seeking([ID.Tracks, 2]),
      info({ scale: 5, duration: 6 }),
      tracks(),
      cluster(),
    ])
    const infoStart = offset(file, 1)
    const infoEnd = offset(file, 2)
    const head = infoEnd - 6
    const { head: found, asks } = open(file.bytes, { head })
    // The Info is asked for from its header to its end, and then what follows it.
    expect(asks[0]).toEqual({ start: infoStart, end: infoEnd })
    expect(found.timestampScale).toBe(5)
    expect(found.durationTicks).toBe(6)
    expect(found.firstCluster).toBe(offset(file, 3))
    expect(found.reads).toBe(asks.length)

    // And a SeekHead, cut in the same way.
    const seekEnd = offset(file, 1)
    const cutSeek = open(file.bytes, { head: seekEnd - 3 })
    expect(cutSeek.asks[0]).toEqual({ start: offset(file, 0), end: seekEnd })
  })

  it('asks for a header that the head cuts, from where it starts', () => {
    const file = matroskaFile([info({}), tracks(), cluster()])
    // The head ends 2 bytes into the Tracks' header, which is 4 bytes of ID and 1 of size.
    const { head, asks } = open(file.bytes, { head: offset(file, 1) + 2 })
    expect(asks[0]).toEqual({
      start: offset(file, 1),
      end: Math.min(offset(file, 1) + HEADER_READ, file.bytes.length),
    })
    expect(head.tracks).toEqual(span(file, 1))
  })

  it('asks for the header of the Segment of a head too short to hold it', () => {
    const file = small()
    const { head, asks } = open(file.bytes, { head: ebmlHeader().length + 3 })
    expect(asks[0]).toEqual({
      start: ebmlHeader().length,
      end: Math.min(ebmlHeader().length + HEADER_READ, file.bytes.length),
    })
    expect(head.segment.data).toBe(file.segmentData)
  })

  it('asks for the EBML header whole when the head holds a part of it', () => {
    const file = small()
    // Its header is held, and not the rest of it.
    const cut = open(file.bytes, { head: 12 })
    expect(cut.asks[0]).toEqual({ start: 0, end: ebmlHeader().length })
    expect(cut.head.docType).toBe('matroska')
    // Not even that.
    const less = open(file.bytes, { head: 3 })
    expect(less.asks[0]).toEqual({ start: 0, end: Math.min(HEADER_READ, file.bytes.length) })
    // A head of nothing at all.
    expect(open(file.bytes, { head: 0 }).head.docType).toBe('matroska')
  })

  it('counts one read for the headers that one read holds', () => {
    // 2 MiB of Tags, then a Void and an Attachments of 10 bytes, then the Cluster: all within 64 KiB.
    const file = matroskaFile([
      info({}),
      tracks(),
      tags(2 * MIB),
      padding(20),
      element(ID.Chapters, [1, 2, 3]),
      cluster(),
    ])
    const { head, asks } = open(file.bytes)
    expect(asks).toHaveLength(1)
    expect(head.reads).toBe(1)
    expect(head.firstCluster).toBe(offset(file, 5))
  })

  it('never asks for a range it holds, however a head is cut', () => {
    const file = matroskaFile([
      seeking([ID.Tracks, 2], [ID.Cues, 4]),
      info({ scale: 3, duration: 8 }),
      tracks(),
      cluster(),
      cues(),
    ])
    // Every cut of the first bytes; `open` holds each ask to the rule.
    for (let cut = 0; cut <= file.bytes.length; cut += 1) {
      const { head } = open(file.bytes, { head: cut })
      expect(head.timestampScale).toBe(3)
      expect(head.cues).toEqual(unread(file, 4))
    }
  })

  it('does not ask for a range that two chunks hold between them', () => {
    const file = matroskaFile([
      seeking([ID.Tracks, 2]),
      info({ scale: 4, duration: 9 }),
      tracks(),
      cluster(),
    ])
    const middleOfInfo = offset(file, 1) + 6
    const chunks: Chunk[] = [
      { start: 0, bytes: file.bytes.subarray(0, middleOfInfo) },
      // They touch.
      { start: middleOfInfo, bytes: file.bytes.subarray(middleOfInfo) },
    ]
    const step = readHead(chunks, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the head')
    expect(step.done.timestampScale).toBe(4)
    expect(step.done.durationTicks).toBe(9)
    // The Info is a read beyond the head, and the Tracks' header after it another.
    expect(step.done.reads).toBe(2)

    // They overlap, and come in another order.
    const overlapping: Chunk[] = [
      { start: 0, bytes: file.bytes.subarray(0, middleOfInfo + 4) },
      { start: middleOfInfo + 20, bytes: file.bytes.subarray(middleOfInfo + 20) },
      { start: middleOfInfo, bytes: file.bytes.subarray(middleOfInfo, middleOfInfo + 30) },
    ]
    const again = readHead(overlapping, file.bytes.length)
    expect('done' in again && again.done.timestampScale).toBe(4)
  })

  it('does not ask for a header that two chunks hold between them', () => {
    const file = small()
    // The Tracks' header is cut in the middle of its ID by the first chunk.
    const cut = offset(file, 1) + 2
    const chunks: Chunk[] = [
      { start: 0, bytes: file.bytes.subarray(0, cut) },
      { start: cut, bytes: file.bytes.subarray(cut) },
    ]
    const step = readHead(chunks, file.bytes.length)
    expect('done' in step && step.done.tracks).toEqual(span(file, 1))
  })

  it('counts the reads that the walk needed after the head, whatever a caller read ahead', () => {
    // 12 Tags of 2 MiB: the 12th read finds the Cluster.
    const parts: FilePart[] = [info({}), tracks()]
    for (let index = 0; index < MAX_INDEX_READS; index += 1) parts.push(tags(2 * MIB))
    parts.push(cluster())
    const file = matroskaFile(parts)

    const exact = open(file.bytes)
    expect(exact.asks).toHaveLength(MAX_INDEX_READS)
    expect(exact.head.reads).toBe(MAX_INDEX_READS)

    // The caller has read the whole file in chunks of a megabyte, which touch.
    const ahead: Chunk[] = []
    for (let start = 0; start < file.bytes.length; start += MIB) {
      ahead.push({ start, bytes: file.bytes.subarray(start, start + MIB) })
    }
    const step = readHead(ahead, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the head')
    expect(step.done).toEqual(exact.head)
  })

  it('refuses a walk that needs more than 12 reads, with a sentence that says so', () => {
    // 20 Tags of 2 MiB before the first Cluster.
    const parts: FilePart[] = [info({}), tracks()]
    for (let index = 0; index < 20; index += 1) parts.push(tags(2 * MIB))
    parts.push(cluster())
    const file = matroskaFile(parts)

    const asks: ByteRange[] = []
    const error = damaged(() => open(file.bytes, { asks }))
    expect(asks).toHaveLength(MAX_INDEX_READS)
    expect(error.message).toContain(String(MAX_INDEX_READS))
    expect(error.message).toMatch(/reads/)

    // It is the walk's own need that is counted: a caller that has read all of it is refused as well.
    const ahead: Chunk[] = []
    for (let start = 0; start < file.bytes.length; start += MIB) {
      ahead.push({ start, bytes: file.bytes.subarray(start, start + MIB) })
    }
    damaged(() => readHead(ahead, file.bytes.length))
  })

  it('counts a read for each probe at a stale entry of a SeekHead, so that many entries cannot make a caller read many ranges', () => {
    // A SeekHead of 40 entries that name Tracks, each in a different place 70 000 bytes from the next (more than a read of a header), in a Void of zeros: a byte that starts no element. The real Tracks are nowhere.
    const entries = 40
    const file = matroskaFile([
      (at) =>
        seekHead(
          Array.from({ length: entries }, (_, index): [number, number] => [
            ID.Tracks,
            (at[2] ?? 0) + 100 + index * 70_000,
          ]),
        ),
      info({}),
      padding(3 * MIB),
      cluster(),
    ])
    const asks: ByteRange[] = []
    const error = damaged(() => open(file.bytes, { asks }))
    // Not a read for each entry: the cap, and the sentence that names it.
    expect(asks.length).toBeLessThanOrEqual(MAX_INDEX_READS)
    expect(error.message).toContain(String(MAX_INDEX_READS))
    expect(error.message).toMatch(/reads/)

    // The same through the steps of the protocol, counted by the calls: no more than the cap and one that is refused.
    const chunks: Chunk[] = [{ start: 0, bytes: file.bytes.subarray(0, HEAD) }]
    let calls = 0
    let refused: unknown
    while (refused === undefined && calls < TURNS) {
      calls += 1
      try {
        const step = readHead(chunks, file.bytes.length)
        if ('done' in step) throw new Error('expected a refusal')
        const { start, end } = step.need
        chunks.push({ start, bytes: file.bytes.subarray(start, end) })
      } catch (thrown) {
        refused = thrown
      }
    }
    expect(refused).toBeInstanceOf(Mp4Error)
    expect(calls).toBeLessThanOrEqual(MAX_INDEX_READS + 1)
  })

  it('counts a read for a probe that is malformed or cut short by the Segment, though the caller held it', () => {
    // Tracks are found, and Info is not: the SeekHead names it at 3 places far from each other, each a byte of 0 (a header that no element has).
    const probes = 3
    const malformed = matroskaFile([
      (at) =>
        seekHead(
          Array.from({ length: probes }, (_, index): [number, number] => [
            ID.Info,
            (at[2] ?? 0) + 100 + index * 70_000,
          ]),
        ),
      tracks(),
      padding(3 * MIB),
      cluster(),
    ])
    // The head is cut before the first of them, so that each is a read.
    const found = open(malformed.bytes, { head: 5000 })
    expect(found.asks.length).toBeGreaterThanOrEqual(probes)
    expect(found.head.reads).toBe(found.asks.length)
    expect(found.head.timestampScale).toBe(1_000_000)

    // A probe near the end of a Segment that is shorter than the file: the bytes are held, and the Segment ends in the middle of their header.
    const stuff = new Uint8Array(3 * MIB).fill(0x1a)
    const children = (n: number): Uint8Array[] => [
      seekHead([[ID.Info, n - 3]]),
      tracks(),
      element(ID.Cluster, binary(ID.SimpleBlock, stuff)),
    ]
    const n = seekHead([[ID.Info, 0]]).length + tracks().length + 2 * MIB
    const bytes = concat(ebmlHeader(), elementSized(ID.Segment, sizeBytes(n), ...children(n)))
    const cutShort = open(bytes, { head: 5000 })
    expect(cutShort.asks.length).toBeGreaterThanOrEqual(1)
    expect(cutShort.head.reads).toBe(cutShort.asks.length)
    expect(cutShort.head.segment.end - cutShort.head.segment.data).toBe(n)
  })

  it('opens a healthy file that a caller has read as 30 chunks of a megabyte, which touch', () => {
    // A Tags of 29.5 MiB: the file is 30 MiB or so, and the walk needs the one read to the Cluster.
    const file = matroskaFile([
      info({ duration: 12 }),
      tracks(),
      tags(29 * MIB + MIB / 2),
      cluster(50_000),
    ])
    const chunks: Chunk[] = []
    for (let start = 0; start < 30 * MIB; start += MIB) {
      chunks.push({ start, bytes: file.bytes.subarray(start, start + MIB) })
    }
    expect(chunks).toHaveLength(30)
    const step = readHead(chunks, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the head')
    expect(step.done.firstCluster).toBe(offset(file, 3))
    expect(step.done.reads).toBe(1)
    // The same as for a caller that reads what it is asked for.
    expect(step.done).toEqual(open(file.bytes).head)
  })

  it('is the same however the caller holds what the walk asks for, which it counts the same', () => {
    const files = [
      matroskaFile([info({}), tracks(), tags(3 * MIB), cluster(70_000)]),
      // Tracks that a SeekHead names, past a Cluster of 2 MiB.
      matroskaFile([seeking([ID.Tracks, 3]), info({}), cluster(2 * MIB), tracks()]),
      // A second SeekHead, past a Cluster of 1 MiB, that names them.
      matroskaFile([
        seeking([ID.SeekHead, 3]),
        info({}),
        cluster(MIB),
        seeking([ID.Tracks, 4], [ID.Cues, 5]),
        tracks(),
        cues(),
      ]),
    ]
    for (const file of files) {
      const exact = open(file.bytes)
      // Every ask is one read.
      expect(exact.head.reads).toBe(exact.asks.length)
      const ahead: Chunk[] = []
      for (let start = 0; start < file.bytes.length; start += 256 * 1024) {
        ahead.push({ start, bytes: file.bytes.subarray(start, start + 256 * 1024) })
      }
      const step = readHead(ahead, file.bytes.length)
      expect('done' in step && step.done).toEqual(exact.head)
    }
  })

  it('refuses a first chunk that does not start at 0, and a size that is not a size', () => {
    const file = small()
    expect(() =>
      readHead([{ start: 5, bytes: file.bytes.subarray(5) }], file.bytes.length),
    ).toThrow(RangeError)
    expect(() => readHead([], file.bytes.length)).toThrow(RangeError)
    const chunks = [{ start: 0, bytes: file.bytes }]
    expect(() => readHead(chunks, -1)).toThrow(RangeError)
    expect(() => readHead(chunks, 1.5)).toThrow(RangeError)
    expect(() => readHead(chunks, Number.NaN)).toThrow(RangeError)
    // A chunk after the first may start anywhere.
    expect(
      'done' in readHead([...chunks, { start: 3, bytes: new Uint8Array(0) }], file.bytes.length),
    ).toBe(true)
  })

  it('ignores what a caller holds beyond the end of the file', () => {
    const file = small()
    const longer = concat(file.bytes, new Uint8Array(100).fill(0x42))
    const step = readHead([{ start: 0, bytes: longer }], file.bytes.length)
    expect('done' in step && step.done.segment.end).toBe(file.bytes.length)
  })
})

describe('the bytes a caller holds (§10.4)', () => {
  const data = Uint8Array.from({ length: 100 }, (_, index) => index)
  const piece = (start: number, end: number): Chunk => ({ start, bytes: data.subarray(start, end) })

  it('gives a view of the chunk that holds the whole range', () => {
    const held = heldBytes([piece(0, 50), piece(40, 100)], 45, 60)
    expect(Array.from(held ?? [])).toEqual(Array.from(data.subarray(45, 60)))
    // The same memory, not a copy.
    expect(held?.buffer).toBe(data.buffer)
    expect(held?.byteOffset).toBe(45)
  })

  it('joins chunks that touch or overlap, in any order, into a copy of the range and no more', () => {
    const chunks = [piece(0, 30), piece(60, 100), piece(30, 61)]
    const held = heldBytes(chunks, 20, 80)
    expect(Array.from(held ?? [])).toEqual(Array.from(data.subarray(20, 80)))
    expect(held?.length).toBe(60)
    expect(held?.buffer).not.toBe(data.buffer)

    // Overlapping.
    const overlapping = heldBytes([piece(0, 60), piece(50, 100)], 10, 90)
    expect(Array.from(overlapping ?? [])).toEqual(Array.from(data.subarray(10, 90)))
    // Three chunks and a small one inside another.
    const small = heldBytes([piece(0, 20), piece(5, 8), piece(20, 40), piece(39, 45)], 2, 44)
    expect(Array.from(small ?? [])).toEqual(Array.from(data.subarray(2, 44)))
  })

  it('gives nothing for a range with a gap in it, or that no chunk holds', () => {
    expect(heldBytes([piece(0, 30), piece(31, 100)], 20, 40)).toBeNull()
    expect(heldBytes([piece(0, 30)], 20, 31)).toBeNull()
    expect(heldBytes([piece(10, 30)], 9, 20)).toBeNull()
    expect(heldBytes([], 0, 1)).toBeNull()
    // A chunk of no bytes holds nothing.
    expect(heldBytes([{ start: 5, bytes: new Uint8Array(0) }], 5, 6)).toBeNull()
  })

  it('gives the bytes of a range that ends where a chunk does, and of one of no length', () => {
    expect(Array.from(heldBytes([piece(0, 50)], 40, 50) ?? [])).toEqual(
      Array.from(data.subarray(40, 50)),
    )
    expect(heldBytes([piece(0, 50)], 50, 50)).toEqual(new Uint8Array(0))
    expect(heldBytes([], 7, 7)).toEqual(new Uint8Array(0))
  })

  it('refuses a range that is not one', () => {
    expect(() => heldBytes([piece(0, 50)], 10, 9)).toThrow(RangeError)
    expect(() => heldBytes([piece(0, 50)], -1, 9)).toThrow(RangeError)
    expect(() => heldBytes([piece(0, 50)], 0, 1.5)).toThrow(RangeError)
  })

  it('gives the chunk of those holding a byte that reaches furthest, not joined', () => {
    const near = piece(0, 40)
    const far = piece(10, 90)
    const apart = piece(95, 100)
    expect(heldFrom([near, far, apart], 20)).toBe(far)
    expect(heldFrom([far, near], 20)).toBe(far)
    expect(heldFrom([near, far], 5)).toBe(near)
    expect(heldFrom([near, far, apart], 95)).toBe(apart)
  })

  it('gives no chunk for a byte that none hold, as the byte after the last of a chunk is not', () => {
    expect(heldFrom([piece(0, 40)], 40)).toBeNull()
    expect(heldFrom([piece(10, 40)], 9)).toBeNull()
    expect(heldFrom([], 0)).toBeNull()
    expect(heldFrom([{ start: 5, bytes: new Uint8Array(0) }], 5)).toBeNull()
  })

  it('gives the bytes held from a start up to a limit, however far they go', () => {
    const chunks = [piece(0, 30), piece(30, 50), piece(60, 100)]
    expect(Array.from(heldPrefix(chunks, 10, 45))).toEqual(Array.from(data.subarray(10, 45)))
    // The gap stops it at 50.
    expect(Array.from(heldPrefix(chunks, 10, 90))).toEqual(Array.from(data.subarray(10, 50)))
    expect(heldPrefix(chunks, 55, 90)).toHaveLength(0)
    expect(heldPrefix(chunks, 60, 61)).toHaveLength(1)
    expect(heldPrefix(chunks, 20, 20)).toHaveLength(0)
  })
})

describe('the ranges the head has had (§10.4)', () => {
  /** A file with Tags of 2 MiB (the head's 1 MiB holds the start of the first) before its Cluster. */
  function tagged(): MatroskaFile {
    return matroskaFile([info({}), tracks(), tags(2 * MIB), cluster()])
  }

  it('gives the head that readHead gives, and the first chunk and the window of each ask as the ranges', () => {
    const file = tagged()
    const chunks: Chunk[] = [{ start: 0, bytes: file.bytes.subarray(0, HEAD) }]
    const first = readHeadCovered(chunks, file.bytes.length)
    // The header after the Tags is not held: it is asked for, and is a read.
    expect('need' in first).toBe(true)
    const ask = 'need' in first ? first.need : { start: 0, end: 0 }
    expect(ask).toEqual({ start: offset(file, 3), end: file.bytes.length })
    chunks.push({ start: ask.start, bytes: file.bytes.subarray(ask.start, ask.end) })

    const step = readHeadCovered(chunks, file.bytes.length)
    if (!('done' in step)) throw new Error('expected the head')
    expect(step.done.head).toEqual(open(file.bytes).head)
    expect(step.done.head.reads).toBe(1)
    expect(step.done.covered).toEqual([{ start: 0, end: HEAD }, ask])
    expect(covers(step.done.covered, 0, HEAD)).toBe(true)
    expect(covers(step.done.covered, ask.start, ask.end)).toBe(true)
    // The bytes between the two are none the walk has had.
    expect(covers(step.done.covered, HEAD - 1, HEAD + 1)).toBe(false)
  })

  it('gives the same ranges whatever a caller has read ahead', () => {
    const file = tagged()
    const exact = open(file.bytes)
    const step = readHeadCovered(
      [
        { start: 0, bytes: file.bytes.subarray(0, HEAD) },
        { start: HEAD, bytes: file.bytes.subarray(HEAD) },
      ],
      file.bytes.length,
    )
    if (!('done' in step)) throw new Error('expected the head')
    expect(step.done.head).toEqual(exact.head)
    expect(step.done.covered).toEqual([
      { start: 0, end: HEAD },
      { start: offset(file, 3), end: file.bytes.length },
    ])
  })
})

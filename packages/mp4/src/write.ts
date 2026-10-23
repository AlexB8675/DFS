import type { PlayTrack } from './choose.ts'
import type { FrameTable } from './frames.ts'

// What Media Source takes, written from the index and the bytes (DESIGN.md
// §10.4, D45): an init segment for each track, and fragments of a run of its
// frames. There is one SourceBuffer for each track, and the player gives it the
// track's `timestampOffset` (`timing.offsetSeconds`), so a fragment carries the
// frames' raw decode times and their signed composition offsets, and the init
// segment carries no edit list. Everything here is a pure function of its
// arguments: no state is kept between calls, and the only bytes of a file that
// a fragment holds are those the caller hands over for the frames it asks about.

/** The size of a box's header: its size in 32 bits, then its type. */
const BOX_HEADER = 8

/** What a `trun` holds before its frames: its box header, version and flags (4), the frame count (4) and the data offset (4). */
const TRUN_HEAD = BOX_HEADER + 12

/** The width of a frame in a `trun`: its duration, size, flags and composition offset, 4 bytes each. */
const RUN_FRAME = 16

/** A `trun`'s flags: data offset (0x1), and each frame's duration (0x100), size (0x200), flags (0x400) and composition offset (0x800). */
const RUN_FLAGS = 0x000f01

/** A `tfhd`'s flag for offsets that count from the start of the `moof`, which the data offset of the `trun` does. */
const DEFAULT_BASE_IS_MOOF = 0x020000

/** A keyframe's flags: `sample_depends_on` 2, which is to say that it depends on no other frame. */
const KEYFRAME = 0x02000000

/** Any other frame's flags: `sample_depends_on` 1 (it depends on others) and `sample_is_non_sync_sample`. */
const DEPENDENT_FRAME = 0x01010000

/** The size a box can say in its 32 bits: header and payload together, which `mdat` is the one box to outgrow. */
const MAX_BOX = 0xffffffff

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value)
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

/** The letters of a string as bytes: a box type, a handler type or a name, all of them in ASCII. */
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (letter) => letter.charCodeAt(0))
}

function zeros(count: number): Uint8Array {
  return new Uint8Array(count)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A box: its size and type, then the parts. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts)
  return concat([u32(BOX_HEADER + body.length), ascii(type), body])
}

/** A box that starts with a version byte and 24 bits of flags. */
function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(
    type,
    Uint8Array.of(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff),
    ...parts,
  )
}

/** The matrix that leaves a picture as it is: 16.16 for a, b, c and d, 2.30 for w. */
function identityMatrix(): Uint8Array {
  return concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32))
}

/** A language as `mdhd` holds it: three letters, each 5 bits of its offset from 0x60, behind a zero bit; `und` for anything but three lowercase letters. */
function packedLanguage(language: string): number {
  const code = /^[a-z]{3}$/.test(language) ? language : 'und'
  return Array.from(code, (letter) => letter.charCodeAt(0) - 0x60).reduce(
    (packed, offset) => (packed << 5) | offset,
    0,
  )
}

/** `ftyp`: ISO base media at minor version 0x200, compatible with ISO base media version 6 (which has the fragment boxes written below) and with MP4 version 1. */
function fileType(): Uint8Array {
  return box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso6'), ascii('mp41'))
}

/** `mvhd`: thousandths of a second, no length (a stream has none to say), normal rate and volume, the identity matrix. */
function movieHeader(nextTrackId: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0), // created
    u32(0), // modified
    u32(1000),
    u32(0), // duration
    u32(0x10000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10), // reserved
    identityMatrix(),
    zeros(24), // pre-defined
    u32(nextTrackId),
  )
}

/** `tkhd`: the track's ID, no length, the matrix and the size in pixels of the source's, in 16.16. */
function trackHeader(track: PlayTrack, picture: boolean): Uint8Array {
  const { id, matrix, width, height } = track.header
  return fullBox(
    'tkhd',
    0,
    3, // enabled, and in the movie
    u32(0), // created
    u32(0), // modified
    u32(id),
    u32(0), // reserved
    u32(0), // duration
    zeros(8), // reserved
    u16(0), // layer
    u16(0), // alternate group
    u16(picture ? 0 : 0x0100), // volume: 1.0 for a sound
    u16(0), // reserved
    matrix,
    u32(picture ? width * 0x10000 : 0),
    u32(picture ? height * 0x10000 : 0),
  )
}

/** `mdhd`: the media's timescale and language, with no length. */
function mediaHeader(track: PlayTrack): Uint8Array {
  return fullBox(
    'mdhd',
    0,
    0,
    u32(0), // created
    u32(0), // modified
    u32(track.header.timescale),
    u32(0), // duration
    u16(packedLanguage(track.header.language)),
    u16(0), // pre-defined
  )
}

/** `hdlr`: a picture's or a sound's handler, with a name that ends in a zero. */
function handler(picture: boolean): Uint8Array {
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre-defined
    ascii(picture ? 'vide' : 'soun'),
    zeros(12), // reserved
    ascii(picture ? 'VideoHandler\0' : 'SoundHandler\0'),
  )
}

/**
 * The sample entry as the init segment holds it: a copy (the entry is a view
 * onto the file's bytes, and what was read is not written to) whose data
 * reference index, the 2 bytes after its 8-byte header and 6 reserved bytes, is 1.
 * The `dref` below has one entry, so an index of another number, as a source with
 * more references may have, would point past it.
 */
function entryOfInit(entry: Uint8Array): Uint8Array {
  const out = Uint8Array.from(entry)
  new DataView(out.buffer).setUint16(14, 1)
  return out
}

/** `minf`: the media header of a picture (flag 1, as ISO asks) or a sound, a data reference to this same stream, and the sample tables: the one description and no frame. */
function mediaInformation(track: PlayTrack, picture: boolean): Uint8Array {
  return box(
    'minf',
    picture ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4)),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    box(
      'stbl',
      fullBox('stsd', 0, 0, u32(1), entryOfInit(track.entry)),
      fullBox('stts', 0, 0, u32(0)),
      fullBox('stsc', 0, 0, u32(0)),
      fullBox('stsz', 0, 0, u32(0), u32(0)),
      fullBox('stco', 0, 0, u32(0)),
    ),
  )
}

/**
 * The init segment of a track: `ftyp` and a `moov` with the movie header, one
 * `trak` (its header with the source's matrix and size, and `mdia` with the
 * media header, handler and `minf`, whose `stsd` holds the track's own entry
 * and whose other tables are empty) and `mvex`/`trex`. There is no edit list:
 * the player gives the SourceBuffer the track's `timing.offsetSeconds` instead.
 * Times are not given, for the fragments carry them. A picture is a track
 * whose kind is `video`; any other is written as a sound.
 */
export function initSegment(track: PlayTrack): Uint8Array {
  const picture = track.header.kind === 'video'
  const { id } = track.header
  return concat([
    fileType(),
    box(
      'moov',
      // The next track's ID is the largest a movie can name when it can't be one more.
      movieHeader(Math.min(id + 1, 0xffffffff)),
      box(
        'trak',
        trackHeader(track, picture),
        box('mdia', mediaHeader(track), handler(picture), mediaInformation(track, picture)),
      ),
      box(
        'mvex',
        // The one description, and nothing assumed of a frame: each one says its own duration, size and flags.
        fullBox('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0)),
      ),
    ),
  ])
}

/** `trun` of frames [from, to): the data offset, then each frame's duration, size, flags and composition offset (signed). */
function trackRun(table: FrameTable, from: number, to: number, dataOffset: number): Uint8Array {
  const frames = new Uint8Array((to - from) * RUN_FRAME)
  const view = new DataView(frames.buffer)
  for (let i = from, at = 0; i < to; i += 1, at += RUN_FRAME) {
    view.setUint32(at, table.durations[i] ?? 0)
    view.setUint32(at + 4, table.sizes[i] ?? 0)
    view.setUint32(at + 8, table.sync[i] === 1 ? KEYFRAME : DEPENDENT_FRAME)
    view.setInt32(at + 12, table.cts[i] ?? 0)
  }
  const offset = new Uint8Array(4)
  new DataView(offset.buffer).setInt32(0, dataOffset)
  return fullBox('trun', 1, RUN_FLAGS, u32(to - from), offset, frames)
}

/** The header of an `mdat` of `payload` bytes: 8 bytes, or 16 (a size of 1, the type, then the size in 64 bits) when the size doesn't fit in 32. */
function dataHeader(payload: number): Uint8Array {
  if (BOX_HEADER + payload <= MAX_BOX) return concat([u32(BOX_HEADER + payload), ascii('mdat')])
  return concat([u32(1), ascii('mdat'), u64(16 + payload)])
}

/** Refuses a range of frames, or a sequence number, that a caller could not have meant: a RangeError, for the file has no part in it. */
function checkFragment(table: FrameTable, from: number, to: number, sequence: number): void {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= to ||
    to > table.count
  ) {
    throw new RangeError(
      `Frames ${from} to ${to} are not a range of at least one frame within the ${table.count} frames of the track.`,
    )
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new RangeError(
      `The sequence number ${sequence} is not a whole number from 1 to 2^32 - 1.`,
    )
  }
}

/**
 * Everything of a fragment but the bytes of its frames: the `moof`, then the
 * header of the `mdat` that follows it, and how many bytes that `mdat` holds.
 * Exported for the tests, and not by the package: a payload past 4 GiB is
 * tested through it, for a fragment itself would have to hold it.
 */
export function fragmentHead(
  track: PlayTrack,
  from: number,
  to: number,
  sequence: number,
): { head: Uint8Array; payload: number } {
  const { table } = track
  checkFragment(table, from, to, sequence)
  let payload = 0
  for (let i = from; i < to; i += 1) payload += table.sizes[i] ?? 0
  const data = dataHeader(payload)

  const mfhd = fullBox('mfhd', 0, 0, u32(sequence))
  const tfhd = fullBox('tfhd', 0, DEFAULT_BASE_IS_MOOF, u32(track.header.id))
  const tfdt = fullBox('tfdt', 1, 0, u64(table.dts[from] ?? 0))
  // The data starts after the `moof` and the `mdat`'s header. The `moof`'s size is known before its `trun` is
  // written: the headers of `moof` and `traf`, the boxes of fixed size, and a `trun` of its head and a frame each.
  const trunSize = TRUN_HEAD + RUN_FRAME * (to - from)
  const moofSize = 2 * BOX_HEADER + mfhd.length + tfhd.length + tfdt.length + trunSize
  const moof = box(
    'moof',
    mfhd,
    box('traf', tfhd, tfdt, trackRun(table, from, to, moofSize + data.length)),
  )
  return { head: concat([moof, data]), payload }
}

/**
 * A fragment of frames [from, to): `moof` (`mfhd` with `sequence`; `traf` with
 * `tfhd` whose offsets count from the `moof`, `tfdt` version 1 with the first
 * frame's raw decode time, and `trun` version 1 with the data offset and each
 * frame's duration, size, flags (a keyframe or not) and signed composition
 * offset), then `mdat` with the frames' bytes in order. `bytesAt(offset, size)`
 * is asked once for each frame, in order, and answers from the span of the file
 * the caller holds; an answer of another length than the size asked for is the
 * caller's mistake, as is a range that isn't one or a sequence number outside
 * 1 to 2^32 - 1 (all `RangeError`).
 */
export function fragment(
  track: PlayTrack,
  from: number,
  to: number,
  sequence: number,
  bytesAt: (offset: number, size: number) => Uint8Array,
): Uint8Array {
  const { table } = track
  const { head, payload } = fragmentHead(track, from, to, sequence)
  const out = new Uint8Array(head.length + payload)
  out.set(head)
  let at = head.length
  for (let i = from; i < to; i += 1) {
    const offset = table.offsets[i] ?? 0
    const size = table.sizes[i] ?? 0
    const bytes = bytesAt(offset, size)
    if (bytes.length !== size) {
      throw new RangeError(
        `Frame ${i} is ${size} bytes at offset ${offset}, but ${bytes.length} were given for it.`,
      )
    }
    out.set(bytes, at)
    at += size
  }
  return out
}

import { childBoxes, Reader } from './boxes.ts'
import { Mp4Error } from './errors.ts'
import type { TableType, TrackHeader } from './movie.ts'

// A track's sample tables, expanded into every frame (DESIGN.md §10.4, D45): for
// each one its offset in the file, its size, when it is decoded and for how
// long, how far its composition time is from that, and whether it is a
// keyframe. The tables of a movie are tiny next to what they describe (an
// `stts` of one entry says 432 000 durations), so what is read is checked first
// and cheaply: the counts of `stts`, `ctts` and `stsc` with its chunk table are
// read and made to agree with the sample count of `stsz` (or `stz2`), and the
// count of `stss` made to fit in it, before any array of frames is made; only
// then is each array filled, in one pass over its table, with no object for a
// frame. What each entry says is checked as it is read: each number of `stss`
// must be a sample the track has, and each description of `stsc` one of its own.
// A track is also held to the file it is in, whose size the caller gives: it has
// at most `MAX_FRAMES` frames, a constant sample size can't add up to more bytes
// than the file has (checked before any array is made), and each chunk must end
// inside the file.
// Offsets and decode times are doubles (exact to 2^53) and never go through
// 32-bit arithmetic: a file past 4 GiB has chunks that don't fit in it.

/** Every frame of one track, in decode order, in typed arrays: ticks are the track's timescale. */
export interface FrameTable {
  count: number
  timescale: number
  /** File offsets: Float64Array, exact to 2^53. */ offsets: Float64Array
  sizes: Uint32Array
  /** Decode times, from 0. */ dts: Float64Array
  durations: Uint32Array
  /** Composition offsets, signed (ctts v0 or v1); all 0 without a ctts. */ cts: Int32Array
  /** 1 for a keyframe (in stss, or every frame without one). */ sync: Uint8Array
}

/**
 * The most frames a track may have: 2^22, or 4 194 304. That is 19.4 hours at 60
 * frames a second, 9.7 hours at 120, and 24.8 hours of 48 kHz AAC, where a real
 * track is far below it (two hours at 60 frames a second is 432 000). It bounds
 * the arrays that a track is expanded into, 29 bytes a frame, to about 116 MiB a
 * track. A constant sample size has no entries to hold a count to, so an `stsz`
 * can claim 4 billion frames in 20 bytes, with the other tables agreeing in 60
 * more: this is what stands between that and arrays of over 100 GiB. The size of
 * the file is the other bound, under the cap: a table of a million frames can
 * still say more bytes than the file holds (`openSizes`, and the end of each
 * chunk in `frameTable`).
 */
const MAX_FRAMES = 2 ** 22

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** A table that is open to be read: a cursor in its body after the version and flags, and the version. */
interface OpenTable {
  reader: Reader
  version: number
}

/**
 * Opens the table of a type: its box (the whole box, header included, as
 * `TrackHeader.tables` holds it), its version (of those up to `newest`, the
 * layouts there are) and a cursor behind the flags. Null when the track has none.
 */
function open(track: TrackHeader, type: TableType, newest: 0 | 1): OpenTable | null {
  const bytes = track.tables[type]
  if (!bytes) return null
  const [box] = childBoxes(bytes, 0, bytes.length)
  if (!box) throw damaged(`The '${type}' box is empty.`)
  const reader = new Reader(bytes, box.body, box.end)
  const version = reader.u8()
  reader.skip(3) // flags
  if (version > newest) {
    throw damaged(
      `The '${type}' box is version ${version}, and only ${newest === 0 ? 'version 0 is' : 'versions 0 and 1 are'} read.`,
    )
  }
  return { reader, version }
}

/** The entry count a table starts with, refused when the entries it counts, `size` bytes each, can't all be in the box. */
function countEntries(table: OpenTable, type: TableType, size: number): number {
  const count = table.reader.u32()
  if (count > table.reader.remaining / size) {
    throw damaged(
      `The '${type}' box counts ${count} entries, but holds room for ${Math.floor(table.reader.remaining / size)}.`,
    )
  }
  return count
}

/** How many samples there are, and where their sizes are: `stsz`, or `stz2` when there is no `stsz`. */
interface Sizes {
  box: 'stsz' | 'stz2'
  /** At the first size, if sizes are listed. */
  reader: Reader
  count: number
  /** The one size of every sample, or 0 when each has its own. */
  constant: number
  /** The width of each listed size. */
  bits: 4 | 8 | 16 | 32
}

/**
 * Where the sizes are and how many samples there are, refused when the count is
 * more than a track may have, more than the box has room for, or, for a constant
 * size, more bytes than a file of `fileSize` bytes can hold: all of it before
 * any array is made.
 */
function openSizes(track: TrackHeader, fileSize: number): Sizes {
  const stsz = open(track, 'stsz', 0)
  let sizes: Sizes
  if (stsz) {
    const constant = stsz.reader.u32()
    sizes = { box: 'stsz', reader: stsz.reader, count: stsz.reader.u32(), constant, bits: 32 }
  } else {
    const stz2 = open(track, 'stz2', 0)
    if (!stz2) throw damaged(`The track has no 'stsz' or 'stz2' box.`)
    stz2.reader.skip(3) // reserved
    const bits = stz2.reader.u8()
    if (bits !== 4 && bits !== 8 && bits !== 16) {
      throw damaged(`The 'stz2' box holds sizes of ${bits} bits, and only 4, 8 and 16 are read.`)
    }
    sizes = { box: 'stz2', reader: stz2.reader, count: stz2.reader.u32(), constant: 0, bits }
  }
  if (sizes.count > MAX_FRAMES) {
    throw damaged(
      `The '${sizes.box}' box counts ${sizes.count} samples, more than the ${MAX_FRAMES} that a track is read with.`,
    )
  }
  if (sizes.constant === 0) {
    const room = Math.floor((sizes.reader.remaining * 8) / sizes.bits)
    if (sizes.count > room) {
      throw damaged(
        `The '${sizes.box}' box counts ${sizes.count} samples, but holds room for ${room}.`,
      )
    }
  } else if (sizes.count * sizes.constant > fileSize) {
    // A constant size lists nothing to hold the count to: the file does. The product is at most 2^54, and a double that rounds is still past any size a file has.
    throw damaged(
      `The '${sizes.box}' box counts ${sizes.count} samples of ${sizes.constant} bytes each, which the file's ${fileSize} bytes can't hold.`,
    )
  }
  return sizes
}

/** Runs of samples of `stts` and `ctts`: how many there are, then the duration or offset each has. */
interface Runs {
  counts: Uint32Array
  values: Int32Array | Uint32Array
  /** How many samples the runs add up to. */
  total: number
}

/**
 * The runs of `stts` (durations, unsigned) or of `ctts` (offsets, signed), or
 * null when the track has no such table. A `ctts` offset is signed in version 0
 * as in version 1: the standard says unsigned for version 0, but QuickTime-style
 * files carry negative offsets there, as 32 bits two's complement, and FFmpeg
 * reads them signed, so a file that plays there plays here.
 */
function readRuns(track: TrackHeader, type: 'stts' | 'ctts'): Runs | null {
  const table = open(track, type, type === 'ctts' ? 1 : 0)
  if (!table) return null
  const count = countEntries(table, type, 8)
  const signed = type === 'ctts'
  const counts = new Uint32Array(count)
  const values = signed ? new Int32Array(count) : new Uint32Array(count)
  let total = 0
  for (let index = 0; index < count; index += 1) {
    const samples = table.reader.u32()
    const value = signed ? table.reader.i32() : table.reader.u32()
    counts[index] = samples
    values[index] = value
    total += samples
  }
  return { counts, values, total }
}

/** Where the chunks are: `co64`, or `stco` when there is no `co64`. */
interface Chunks {
  box: 'stco' | 'co64'
  /** At the first offset. */
  reader: Reader
  count: number
}

/**
 * The chunk offsets. A track with both tables is read from `co64`: the writers
 * of a file past 4 GiB may leave a dummy or stale `stco` beside it, whose 32 bits
 * would cut the offsets short, where a `co64` is never the narrower of the two.
 */
function openChunks(track: TrackHeader): Chunks {
  const co64 = open(track, 'co64', 0)
  const stco = co64 ? null : open(track, 'stco', 0)
  const table = co64 ?? stco
  if (!table) throw damaged(`The track has no 'co64' or 'stco' box.`)
  const box = co64 ? 'co64' : 'stco'
  return { box, reader: table.reader, count: countEntries(table, box, co64 ? 8 : 4) }
}

/** The runs of chunks of `stsc`: the chunk each starts at, counting from 1, and how many samples each of its chunks holds. */
interface ChunkRuns {
  first: Uint32Array
  perChunk: Uint32Array
  /** How many samples the runs place in the chunks there are, the last run going on to the last chunk. */
  placed: number
}

/**
 * The runs of `stsc`, which must be as the standard has them: the first starts
 * at chunk 1, each starts after the one before it, none holds 0 samples, none
 * starts past the last chunk, each uses a sample description that the `stsd`
 * has (counting from 1), and a track with chunks has at least one.
 */
function readChunkRuns(track: TrackHeader, chunks: Chunks): ChunkRuns {
  const table = open(track, 'stsc', 0)
  if (!table) throw damaged(`The track has no 'stsc' box.`)
  const count = countEntries(table, 'stsc', 12)
  if (count === 0 && chunks.count > 0) {
    throw damaged(`The 'stsc' box has no entry for the ${chunks.count} chunks of '${chunks.box}'.`)
  }
  const first = new Uint32Array(count)
  const perChunk = new Uint32Array(count)
  let previous = 0
  for (let index = 0; index < count; index += 1) {
    const chunk = table.reader.u32()
    const samples = table.reader.u32()
    const description = table.reader.u32()
    if (chunk === 0) throw damaged(`The 'stsc' box has an entry for chunk 0: chunks count from 1.`)
    if (index === 0 && chunk !== 1) {
      throw damaged(`The 'stsc' box starts at chunk ${chunk}, so chunk 1 has no entry.`)
    }
    if (chunk <= previous) {
      throw damaged(
        `The 'stsc' box has entries that don't ascend: chunk ${chunk} after chunk ${previous}.`,
      )
    }
    if (samples === 0) throw damaged(`The 'stsc' box has chunk ${chunk} holding 0 samples.`)
    if (description < 1 || description > track.entries.length) {
      throw damaged(
        `The 'stsc' box has chunk ${chunk} using sample description ${description}, but the track has ${track.entries.length}, counting from 1.`,
      )
    }
    if (chunk > chunks.count) {
      throw damaged(
        `The 'stsc' box has an entry for chunk ${chunk}, but '${chunks.box}' counts ${chunks.count} chunks.`,
      )
    }
    first[index] = chunk
    perChunk[index] = samples
    previous = chunk
  }
  let placed = 0
  for (let index = 0; index < count; index += 1) {
    // A run goes on to the chunk before the next run's, and the last to the last chunk.
    const until = first[index + 1] ?? chunks.count + 1
    placed += (until - (first[index] ?? 0)) * (perChunk[index] ?? 0)
  }
  return { first, perChunk, placed }
}

function fillSizes(sizes: Sizes): Uint32Array {
  const { reader, count, constant, bits } = sizes
  const out = new Uint32Array(count)
  if (constant !== 0) {
    out.fill(constant)
  } else if (bits === 4) {
    for (let index = 0; index < count; index += 2) {
      const pair = reader.u8()
      out[index] = pair >> 4
      // With an odd count the low half of the last byte is unused.
      if (index + 1 < count) out[index + 1] = pair & 0x0f
    }
  } else if (bits === 8) {
    for (let index = 0; index < count; index += 1) out[index] = reader.u8()
  } else if (bits === 16) {
    for (let index = 0; index < count; index += 1) out[index] = reader.u16()
  } else {
    for (let index = 0; index < count; index += 1) out[index] = reader.u32()
  }
  return out
}

/** The keyframes `stss` lists: its cursor at the first, and how many it lists. */
interface Keyframes {
  table: OpenTable
  listed: number
}

/** `stss`, or null when the track has none; it can't list more samples than the track has. */
function openKeyframes(track: TrackHeader, count: number): Keyframes | null {
  const table = open(track, 'stss', 0)
  if (!table) return null
  const listed = countEntries(table, 'stss', 4)
  if (listed > count) {
    throw damaged(`The 'stss' box lists ${listed} samples, but the track has ${count}.`)
  }
  return { table, listed }
}

/** The marks of `stss`: 1 for each listed sample (counting from 1), or for every sample when the track has no `stss`. */
function fillSync(keyframes: Keyframes | null, count: number): Uint8Array {
  const out = new Uint8Array(count)
  if (!keyframes) return out.fill(1)
  const { table, listed } = keyframes
  for (let index = 0; index < listed; index += 1) {
    const sample = table.reader.u32()
    if (sample < 1 || sample > count) {
      throw damaged(
        `The 'stss' box lists sample ${sample}, but the track has samples 1 to ${count}.`,
      )
    }
    out[sample - 1] = 1
  }
  return out
}

/**
 * Expands a track's tables; refuses inconsistent ones (counts that disagree, a
 * chunk past the samples), a track of more than `MAX_FRAMES` frames, and frames
 * that don't lie inside a file of `fileSize` bytes (a constant sample size that
 * adds up to more, checked before any array is made, or a chunk that ends past
 * it) as Mp4Error('damaged'). A frame that ends exactly at the end of the file
 * is inside it. A `fileSize` that isn't a count of bytes is a RangeError, the
 * caller's mistake and not the file's.
 */
export function frameTable(track: TrackHeader, fileSize: number): FrameTable {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not a size that a file has.`)
  }
  if (track.problem !== null) throw damaged(`The track can't be read: ${track.problem}`)

  // First, what the tables say, and whether they say the same: nothing is made until they do.
  const sizes = openSizes(track, fileSize)
  const { count } = sizes
  const durationRuns = readRuns(track, 'stts')
  if (!durationRuns) throw damaged(`The track has no 'stts' box.`)
  if (durationRuns.total !== count) {
    throw damaged(
      `The 'stts' box counts ${durationRuns.total} samples where '${sizes.box}' counts ${count}.`,
    )
  }
  const offsetRuns = readRuns(track, 'ctts')
  if (offsetRuns && offsetRuns.total !== count) {
    throw damaged(
      `The 'ctts' box counts ${offsetRuns.total} samples where '${sizes.box}' counts ${count}.`,
    )
  }
  const chunks = openChunks(track)
  const chunkRuns = readChunkRuns(track, chunks)
  if (chunkRuns.placed !== count) {
    throw damaged(
      `The 'stsc' and '${chunks.box}' boxes place ${chunkRuns.placed} samples where '${sizes.box}' counts ${count}.`,
    )
  }

  const keyframes = openKeyframes(track, count)

  // Then each array, in one pass over its table.
  const sizeArray = fillSizes(sizes)
  const sync = fillSync(keyframes, count)

  const durations = new Uint32Array(count)
  const dts = new Float64Array(count)
  let sample = 0
  let time = 0
  for (let run = 0; run < durationRuns.counts.length; run += 1) {
    const end = sample + (durationRuns.counts[run] ?? 0)
    const duration = durationRuns.values[run] ?? 0
    durations.fill(duration, sample, end)
    for (; sample < end; sample += 1) {
      dts[sample] = time
      time += duration
    }
  }
  if (time > Number.MAX_SAFE_INTEGER) {
    throw damaged(`The durations of 'stts' add up to more than a number holds exactly.`)
  }

  const cts = new Int32Array(count)
  if (offsetRuns) {
    sample = 0
    for (let run = 0; run < offsetRuns.counts.length; run += 1) {
      const end = sample + (offsetRuns.counts[run] ?? 0)
      cts.fill(offsetRuns.values[run] ?? 0, sample, end)
      sample = end
    }
  }

  // Each chunk's offset, then each sample's after the sizes of those before it in the chunk.
  const offsets = new Float64Array(count)
  const { first, perChunk } = chunkRuns
  sample = 0
  let run = 0
  for (let chunk = 1; chunk <= chunks.count; chunk += 1) {
    while ((first[run + 1] ?? Infinity) <= chunk) run += 1
    let offset = chunks.box === 'co64' ? chunks.reader.u64() : chunks.reader.u32()
    for (const end = sample + (perChunk[run] ?? 0); sample < end; sample += 1) {
      offsets[sample] = offset
      offset += sizeArray[sample] ?? 0
    }
    // The offset only grows: if the last is exact, so was each before it.
    if (offset > Number.MAX_SAFE_INTEGER) {
      throw damaged(
        `Chunk ${chunk} of '${chunks.box}' reaches an offset past what a number holds exactly.`,
      )
    }
    // The offsets only grow within a chunk, so its end bounds every frame in it: a frame that ends past the file's end puts it there.
    if (offset > fileSize) {
      throw damaged(
        `Chunk ${chunk} of '${chunks.box}' ends at offset ${offset}, past the end of the file, which is ${fileSize} bytes long.`,
      )
    }
  }

  return { count, timescale: track.timescale, offsets, sizes: sizeArray, dts, durations, cts, sync }
}

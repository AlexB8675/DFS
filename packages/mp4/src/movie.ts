import { child, childBoxes, firstBox, leadingBoxes, Reader } from './boxes.ts'
import type { Box, LeadingBoxes } from './boxes.ts'
import { Mp4Error } from './errors.ts'

// The movie in a `moov`, and the header of each of its tracks (DESIGN.md §10.4,
// D45): what the repackager needs to choose a picture and a sound, and where
// their sample tables are, without expanding any of them. A track is read
// leniently: one whose boxes can't be read is kept, with a `problem` that says
// why, because only the tracks that are chosen have to be sound, and a file
// with a broken subtitle or timecode track still plays. Only a `moov` that
// can't be walked, or has no readable `mvhd`, turns the whole file away.

/** One sample description of a track: the `stsd` entry box. */
export interface SampleEntry {
  /** The entry's four-character code: `avc1`, `mp4a` and so on. */
  type: string
  /** The whole entry box, header included, as a view onto the `moov`. */
  bytes: Uint8Array
}

/** One entry of a track's edit list (`elst`). */
export interface Edit {
  /** How long the edit lasts, in the movie's timescale. */
  durationMovieTicks: number
  /** Where in the media it starts, in the media's timescale; -1 for an empty edit (a pause before the media starts). */
  mediaTime: number
  /** 16.16 fixed point, as stored. */
  rate: number
}

/** The sample tables the repackager reads. */
export type TableType = 'stts' | 'ctts' | 'stss' | 'stsz' | 'stz2' | 'stsc' | 'stco' | 'co64'

const TABLE_TYPES: readonly string[] = [
  'stts',
  'ctts',
  'stss',
  'stsz',
  'stz2',
  'stsc',
  'stco',
  'co64',
]

function isTable(type: string): type is TableType {
  return TABLE_TYPES.includes(type)
}

export interface TrackHeader {
  id: number
  kind: 'video' | 'audio' | 'other'
  /** From `hdlr`. */
  handler: string
  /** The media's timescale, from `mdhd`. */
  timescale: number
  /** The media's duration, in `timescale` ticks. */
  durationTicks: number
  /** Three letters (ISO 639-2/T), or `und` when `mdhd` says none or something that isn't three letters. */
  language: string
  /** The picture's size in pixels, the integer part of `tkhd`'s. */
  width: number
  height: number
  /** The tkhd's 36-byte matrix, verbatim: how the picture is turned, so a portrait video stays upright. */
  matrix: Uint8Array
  /** The track's edit list, or null when it has none. */
  edits: Edit[] | null
  entries: SampleEntry[]
  /** The stbl's tables, each a whole box (header included), as byte views of the moov, not expanded. */
  tables: Partial<Record<TableType, Uint8Array>>
  /** Why this track can't be read, when it can't: kept here, never thrown for the file. */
  problem: string | null
}

export interface Movie {
  /** The movie's timescale, which edit durations are in. */
  timescale: number
  durationTicks: number
  tracks: TrackHeader[]
}

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** The boxes inside `parent`, as far as they can be read: damage after the ones a track needs is not the track's problem. */
function childrenOf(moov: Uint8Array, parent: Box): LeadingBoxes {
  return leadingBoxes(moov, parent.body, parent.end)
}

/**
 * The first child of a type among `found`, which what is being read can't do
 * without. When it isn't there, the damage that stopped the walk is the reason,
 * if the walk was stopped; else it is simply not in the box.
 */
function need(found: LeadingBoxes, parent: Box, type: string): Box {
  const entry = found.boxes.find((box) => box.type === type)
  if (entry) return entry
  if (found.damage) throw found.damage.error
  throw damaged(`The '${parent.type}' box at offset ${parent.start} has no '${type}' box.`)
}

function bodyOf(moov: Uint8Array, box: Box): Reader {
  return new Reader(moov, box.body, box.end)
}

/** Reads a full box's version and flags; true for version 1, which holds times in 64 bits where version 0 holds 32. Any other version is a layout this reader doesn't know. */
function wideVersion(reader: Reader, box: Box): boolean {
  const version = reader.u8()
  reader.skip(3)
  if (version > 1) {
    throw damaged(
      `The '${box.type}' box at offset ${box.start} is version ${version}, and only 0 and 1 are read.`,
    )
  }
  return version === 1
}

/** A time or duration: 64 bits in a box of version 1, else 32. */
function timeOf(reader: Reader, wide: boolean): number {
  return wide ? reader.u64() : reader.u32()
}

function readMovieHeader(moov: Uint8Array, box: Box): { timescale: number; durationTicks: number } {
  const reader = bodyOf(moov, box)
  const wide = wideVersion(reader, box)
  reader.skip(wide ? 16 : 8) // when it was made and changed
  const timescale = reader.u32()
  return { timescale, durationTicks: timeOf(reader, wide) }
}

function readTrackHeader(
  moov: Uint8Array,
  box: Box,
): { id: number; width: number; height: number; matrix: Uint8Array } {
  const reader = bodyOf(moov, box)
  const wide = wideVersion(reader, box)
  reader.skip(wide ? 16 : 8) // when it was made and changed
  const id = reader.u32()
  reader.skip(4) // reserved
  reader.skip(wide ? 8 : 4) // duration, which the media's own is read for
  reader.skip(16) // reserved, layer, alternate group, volume, reserved
  // A copy: it is 36 bytes, and it is the one view that needn't keep the moov alive.
  const matrix = reader.bytes(36).slice()
  // Width and height are 16.16 fixed point: the integer part is the pixels.
  const width = reader.u32() >>> 16
  const height = reader.u32() >>> 16
  return { id, width, height, matrix }
}

/** `mdhd`'s language: three letters, each 5 bits, as an offset from 0x60 (`und` for 0 or all ones, or anything that isn't three letters). */
function languageOf(packed: number): string {
  const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f]
  // A MOV may hold a Macintosh language code instead (below 0x400): not letters either.
  if (letters.some((letter) => letter < 1 || letter > 26)) return 'und'
  return String.fromCharCode(...letters.map((letter) => letter + 0x60))
}

function readMediaHeader(
  moov: Uint8Array,
  box: Box,
): { timescale: number; durationTicks: number; language: string } {
  const reader = bodyOf(moov, box)
  const wide = wideVersion(reader, box)
  reader.skip(wide ? 16 : 8) // when it was made and changed
  const timescale = reader.u32()
  // A track that counts time in ticks of 0 seconds can't tell any time at all.
  if (timescale === 0) {
    throw damaged(`The 'mdhd' box at offset ${box.start} gives a timescale of 0.`)
  }
  const durationTicks = timeOf(reader, wide)
  return { timescale, durationTicks, language: languageOf(reader.u16() & 0x7fff) }
}

function readHandler(moov: Uint8Array, box: Box): string {
  const reader = bodyOf(moov, box)
  reader.skip(4) // version and flags
  reader.skip(4) // pre-defined (QuickTime's component type)
  return reader.fourcc()
}

function readEdits(moov: Uint8Array, edts: Box): Edit[] | null {
  const elst = child(moov, edts, 'elst')
  if (!elst) return null
  const reader = bodyOf(moov, elst)
  const wide = wideVersion(reader, elst)
  const count = reader.u32()
  // A duration, a media time and a rate for each: 8 + 8 + 4 bytes in version 1, 4 + 4 + 4 in version 0.
  const size = wide ? 20 : 12
  if (count > reader.remaining / size) {
    throw damaged(
      `The edit list at offset ${elst.start} claims ${count} edits, but holds room for ${Math.floor(reader.remaining / size)}.`,
    )
  }
  const edits: Edit[] = []
  for (let index = 0; index < count; index += 1) {
    const durationMovieTicks = timeOf(reader, wide)
    const mediaTime = wide ? reader.i64() : reader.i32()
    // The rate's integer and fraction halves together, as one number: 0x10000 is 1.
    edits.push({ durationMovieTicks, mediaTime, rate: reader.i32() })
  }
  return edits
}

/** The entries of an `stsd` box, which must hold as many as it counts. */
function readEntries(moov: Uint8Array, stsd: Box): SampleEntry[] {
  const reader = bodyOf(moov, stsd)
  reader.skip(4) // version and flags
  const count = reader.u32()
  const found = childBoxes(moov, reader.position, stsd.end)
  if (found.length !== count) {
    throw damaged(
      `The 'stsd' box at offset ${stsd.start} counts ${count} entries and holds ${found.length}.`,
    )
  }
  // A track that describes no sample can't be played: the description is what the decoder is made from.
  if (found.length === 0) {
    throw damaged(`The 'stsd' box at offset ${stsd.start} holds no sample description.`)
  }
  return found.map((entry) => ({ type: entry.type, bytes: moov.subarray(entry.start, entry.end) }))
}

/**
 * The sample descriptions and the tables of an `stbl`: the first of each kind
 * of box, as `child` finds the first. A damaged box that comes after them is
 * not the track's problem, unless it is one of these.
 */
function readSampleTables(
  moov: Uint8Array,
  stbl: Box,
): { entries: SampleEntry[]; tables: Partial<Record<TableType, Uint8Array>> } {
  const found = childrenOf(moov, stbl)
  const tables: Partial<Record<TableType, Uint8Array>> = {}
  for (const box of found.boxes) {
    if (isTable(box.type)) tables[box.type] ??= moov.subarray(box.start, box.end)
  }
  const { damage } = found
  if (damage?.type && (damage.type === 'stsd' || isTable(damage.type))) throw damage.error
  return { entries: readEntries(moov, need(found, stbl, 'stsd')), tables }
}

/**
 * One track, or what could be read of it, with `problem` set to the reason when
 * a box of it was wrong. Only an `Mp4Error` is the file's fault: anything else
 * is a bug here and is not hidden.
 */
function readTrack(moov: Uint8Array, trak: Box): TrackHeader {
  // What a track that can't be read holds where nothing was read: nothing.
  const track: TrackHeader = {
    id: 0,
    kind: 'other',
    handler: '',
    timescale: 0,
    durationTicks: 0,
    language: 'und',
    width: 0,
    height: 0,
    matrix: new Uint8Array(36),
    edits: null,
    entries: [],
    tables: {},
    problem: null,
  }
  try {
    const inTrak = childrenOf(moov, trak)
    const header = readTrackHeader(moov, need(inTrak, trak, 'tkhd'))
    track.id = header.id
    track.width = header.width
    track.height = header.height
    track.matrix = header.matrix

    const mdia = need(inTrak, trak, 'mdia')
    const inMdia = childrenOf(moov, mdia)
    const media = readMediaHeader(moov, need(inMdia, mdia, 'mdhd'))
    track.timescale = media.timescale
    track.durationTicks = media.durationTicks
    track.language = media.language
    // The `hdlr` that is a child of `mdia`: a MOV's `minf` has one of its own, for data.
    track.handler = readHandler(moov, need(inMdia, mdia, 'hdlr'))
    track.kind = track.handler === 'vide' ? 'video' : track.handler === 'soun' ? 'audio' : 'other'

    // The edit list is the one box that a track may do without: it is in the boxes that were read, or the track has none.
    const edts = inTrak.boxes.find((box) => box.type === 'edts')
    if (edts) track.edits = readEdits(moov, edts)

    const minf = need(inMdia, mdia, 'minf')
    const { entries, tables } = readSampleTables(moov, need(childrenOf(moov, minf), minf, 'stbl'))
    track.entries = entries
    track.tables = tables
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    track.problem = error.message
  }
  return track
}

/**
 * The movie in a `moov` box's bytes, header included. Refuses a fragmented file
 * (an `mvex` in the `moov`: it has nothing to split) and a `moov` that can't be
 * walked or whose `mvhd` can't be read, both with `Mp4Error`. The `moov` is the
 * first box of `moov`, and what follows it is not looked at. A track that can't
 * be read is in the result with its `problem`, never refused: its media
 * timescale is 0, it holds no sample description, or a box it needs is missing
 * or damaged, but not a damaged box that comes after the ones it needs.
 */
export function readMovie(moov: Uint8Array): Movie {
  const first = firstBox(moov, 0, moov.length)
  if (first?.type !== 'moov') throw damaged(`The bytes of the index don't start with a 'moov' box.`)
  const children = childBoxes(moov, first.body, first.end)
  if (children.some((entry) => entry.type === 'mvex')) {
    throw new Mp4Error(
      'fragmented',
      'The file is already in fragments (its index has an mvex), so there is nothing to split.',
    )
  }
  const mvhd = children.find((entry) => entry.type === 'mvhd')
  if (!mvhd) throw damaged(`The 'moov' box has no 'mvhd' box.`)
  const { timescale, durationTicks } = readMovieHeader(moov, mvhd)
  const tracks = children
    .filter((entry) => entry.type === 'trak')
    .map((trak) => readTrack(moov, trak))
  return { timescale, durationTicks, tracks }
}

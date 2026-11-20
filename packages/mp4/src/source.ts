// What a reader of a file in the page is given and asks for (DESIGN.md §10.4,
// D45). The module is pure: it never reads a file. A reader is called with the
// parts of the file its caller holds (chunks, each at an offset of the file) and
// gives either its result or the next range of the file it needs, which the
// caller reads, adds as a chunk and calls it again with. The same shape serves
// both containers.
//
// Step 5's engine meets a file through five functions that are the same for an
// MP4 and for a Matroska file: `openSource` gives the index (the picture, the
// sounds and the duration), `startCursor` and `seekCursor` say where to start
// reading, `nextRead` where to read next, and `framesIn` the frames that a chunk
// completes, as the tables the writer takes. Each container's own functions do the
// work (`mp4source.ts`, and `matroska/`); these choose between them by the
// index's `container`.

import { Mp4Error } from './errors.ts'
import { locateMoov, moovIn } from './locate.ts'
import { readMatroska } from './matroska/read.ts'
import type { MatroskaIndex } from './matroska/read.ts'
import { matroskaSeek } from './matroska/seek.ts'
import { matroskaFrames, matroskaStart } from './matroska/spans.ts'
import type { MatroskaCursor } from './matroska/spans.ts'
import { readMovie } from './movie.ts'
import { mp4Frames, mp4Index, mp4Next, mp4Nexts, mp4Seek, mp4Start } from './mp4source.ts'
import type { Mp4Cursor, Mp4Index } from './mp4source.ts'
import type { FragmentTrack } from './write.ts'

/** A range of a file: from `start` up to, and not including, `end`. */
export interface ByteRange {
  start: number
  end: number
}

/** A part of a file that a caller holds: its bytes, and the offset of the first of them in the file. */
export interface Chunk {
  start: number
  bytes: Uint8Array
}

/** What a reader gives each time it is called: its result, or the range of the file it needs to go on. */
export type Step<T> = { done: T } | { need: ByteRange }

/**
 * A sound track of a file that the player may choose, in the order of preference
 * (DESIGN.md §10.4, D45: the first plays unless the user chooses another). One
 * the reader can repackage has the names that Media Source is asked about, the
 * first of them the codec; one that it can't has the refusal, a sentence that
 * reads on its own. `id` is the track's number in the file.
 */
export type SoundOffer =
  | { id: number; language: string; codecNames: readonly string[]; codec: string }
  | { id: number; language: string; refusal: Mp4Error }

/** Where a chunk ends in the file. */
function endOf(chunk: Chunk): number {
  return chunk.start + chunk.bytes.length
}

/**
 * Of the chunks that hold the byte at `start`, the one that reaches furthest
 * (the first of them if two reach as far), as it is: not joined with any
 * other. Null when no chunk holds it. A chunk of no bytes holds none.
 */
export function heldFrom(chunks: readonly Chunk[], start: number): Chunk | null {
  let best: Chunk | null = null
  for (const chunk of chunks) {
    if (chunk.start > start || endOf(chunk) <= start) continue
    if (best === null || endOf(chunk) > endOf(best)) best = chunk
  }
  return best
}

/**
 * The bytes of the file from `start`, as far as the chunks hold them without a
 * gap, but no further than `limit`: all of [start, limit) when they hold it,
 * and when they don't, up to where the first gap is, which may be nothing at
 * all. A view onto the chunk when one holds all that is given; a copy of exactly
 * those bytes (not of the chunks) when it takes several, which may touch or
 * overlap, in any order.
 */
export function heldPrefix(chunks: readonly Chunk[], start: number, limit: number): Uint8Array {
  const run: Chunk[] = []
  let at = start
  while (at < limit) {
    const chunk = heldFrom(chunks, at)
    if (chunk === null) break
    run.push(chunk)
    at = Math.min(limit, endOf(chunk))
  }

  const [only, ...rest] = run
  if (only === undefined) return new Uint8Array(0)
  if (rest.length === 0) return only.bytes.subarray(start - only.start, at - only.start)

  const joined = new Uint8Array(at - start)
  let from = start
  for (const chunk of run) {
    const to = Math.min(at, endOf(chunk))
    joined.set(chunk.bytes.subarray(from - chunk.start, to - chunk.start), from - start)
    from = to
  }
  return joined
}

/**
 * The bytes of [start, end) of the file when the chunks hold all of them: a
 * view onto the chunk when one holds the whole range, a copy when chunks that
 * touch or overlap cover it (so a range that two reads hold between them is
 * held), and null when any byte of it is in none. A range that isn't one (an end
 * before its start, or a number that isn't a position in a file) is a RangeError,
 * the caller's mistake.
 */
export function heldBytes(chunks: readonly Chunk[], start: number, end: number): Uint8Array | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`${start} to ${end} is not a range of a file.`)
  }
  const held = heldPrefix(chunks, start, end)
  return held.length === end - start ? held : null
}

/** A container that a file can be in. */
export type Container = 'mp4' | 'matroska'

/** The types of box that an MP4 may start with: the file type, the index, the samples, and the padding and QuickTime's small boxes that writers put before them. */
const FIRST_BOXES: readonly string[] = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']

/**
 * The container of a file, from its first bytes: Matroska starts with EBML's magic
 * number, `1A 45 DF A3`, and an MP4 with a box whose type is one a file starts with
 * (`ftyp`, `moov`, `mdat`, `free`, `skip`, `wide`, `pnot`). Null for anything else,
 * and for a head too short to say (4 bytes for Matroska, 8 for an MP4's first
 * box header).
 */
export function sniff(head: Uint8Array): Container | null {
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return 'matroska'
  }
  if (head.length >= 8 && FIRST_BOXES.includes(String.fromCharCode(...head.subarray(4, 8)))) {
    return 'mp4'
  }
  return null
}

/** What opening a file gives, whichever container it is in. */
export type SourceIndex = Mp4Index | MatroskaIndex

/** Where reading goes on in a file, whichever container it is in. */
export type Cursor = Mp4Cursor | MatroskaCursor

/**
 * Opens the file of `fileSize` bytes from the chunks the caller holds, the first
 * of which starts at 0 (the head, a megabyte): gives the index, or the next range of
 * the file that it needs, which the caller reads, adds as a chunk and calls again
 * with them all. The container is told from the head (`sniff`).
 *
 * - An MP4's `moov` is located in the head (`locateMoov`), asked for when the chunks
 *   do not hold it whole (it is at the end of a phone's recording), and then read:
 *   `moovIn`, `readMovie` and `mp4Index`. A file with no `moov` to be found is
 *   `damaged`.
 * - A Matroska file is opened by `readMatroska`, which asks for what it needs.
 * - A file that is neither is `damaged`.
 *
 * A file the reader turns away is an `Mp4Error`, and nothing else is thrown for it.
 * A first chunk that does not start at 0, or a size that is not a count of bytes, is
 * a RangeError, the caller's mistake.
 */
export function openSource(chunks: readonly Chunk[], fileSize: number): Step<SourceIndex> {
  const head = chunks[0]
  if (head?.start !== 0) {
    throw new RangeError('The first chunk must start at the first byte of the file.')
  }
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not a size that a file has.`)
  }

  const container = sniff(head.bytes)
  if (container === 'matroska') return readMatroska(chunks, fileSize)
  if (container === 'mp4') {
    const moov = locateMoov(head.bytes, fileSize)
    if (moov === null) throw new Mp4Error('damaged', 'No moov was found in the file.')
    const bytes = heldBytes(chunks, moov.start, moov.end)
    if (bytes === null) return { need: moov }
    return { done: mp4Index(readMovie(moovIn(bytes)), fileSize) }
  }
  throw new Mp4Error('damaged', 'The file is neither MP4 nor Matroska.')
}

/** The cursor and the index belong to different containers: a mistake of the caller. */
function mismatch(index: SourceIndex, cursor: Cursor): RangeError {
  return new RangeError(
    `A cursor of ${cursor.container} cannot be used with the index of ${index.container}.`,
  )
}

/**
 * A cursor at the start of the file, for the sound with this id or none. For a
 * Matroska file any sound of `index.soundTracks` will do; for an MP4 the sound
 * that plays (`index.sound`), for the index holds the frames of that one alone:
 * another sound is a RangeError whose sentence says to make an index with it
 * (`{ ...index, sound: mp4Sound(index, id) }`).
 */
export function startCursor(index: SourceIndex, sound: number | null): Cursor {
  return index.container === 'matroska' ? matroskaStart(index, sound) : mp4Start(index, sound)
}

/**
 * Where to start reading the file for the time `seconds` on the playback timeline,
 * for the sound with this id or none: a cursor, or the next range of the file that
 * the seek needs, which the caller reads, adds as a chunk and calls again with them
 * all. A Matroska seek reads (`matroskaSeek`); an MP4's tables are held, so it is
 * done at once, at the picture's keyframe at or before the time and the sound frame
 * that covers it, and `chunks` are not looked at.
 */
export function seekCursor(
  index: SourceIndex,
  seconds: number,
  sound: number | null,
  chunks: readonly Chunk[],
): Step<Cursor> {
  if (index.container === 'matroska') return matroskaSeek(index, seconds, sound, chunks)
  return { done: mp4Seek(index, seconds, sound) }
}

/**
 * The offset of the file to read from next, or null when every frame has been
 * given: the cursor's place in a Matroska file, and in an MP4 the least offset of
 * the next frames of the picture and of the sound.
 */
export function nextRead(index: SourceIndex, cursor: Cursor): number | null {
  if (index.container === 'matroska') {
    if (cursor.container !== 'matroska') throw mismatch(index, cursor)
    return cursor.ended ? null : cursor.at
  }
  if (cursor.container !== 'mp4') throw mismatch(index, cursor)
  return mp4Next(index, cursor)
}

/**
 * Where each track reads next: the offset of the file of the next frame of the
 * picture and of the sound that plays, each null when that track has none left (the
 * sound's too when none plays). In an MP4 they are what the tables say, and in a file
 * whose sound lies apart from its picture they are far apart, so a caller that reads
 * from `nextRead` alone advances only the track that comes first and should read from
 * the one that is behind. In a Matroska file both are the cursor's place, for its
 * clusters hold the tracks together (the sound's null when none plays), and both are
 * null when every frame has been given.
 */
export function nextReads(
  index: SourceIndex,
  cursor: Cursor,
): { video: number | null; audio: number | null } {
  if (index.container === 'matroska') {
    if (cursor.container !== 'matroska') throw mismatch(index, cursor)
    if (cursor.ended) return { video: null, audio: null }
    return { video: cursor.at, audio: cursor.sound === null ? null : cursor.at }
  }
  if (cursor.container !== 'mp4') throw mismatch(index, cursor)
  return mp4Nexts(index, cursor)
}

/**
 * The frames of the picture and the sound that the chunk completes, as tables the
 * writer takes (`frames`, each a continuous run: the picture's first, then the
 * sound's), the cursor to go on with, and the stretches of the file that were
 * damaged and passed over (always none in an MP4). When the chunk completes
 * nothing, the cursor comes back where it was and the caller reads a bigger chunk
 * from where `nextRead` says. The cursor given is never changed.
 */
export function framesIn(
  index: SourceIndex,
  cursor: Cursor,
  chunk: Chunk,
): { frames: FragmentTrack[]; cursor: Cursor; skipped: ByteRange[] } {
  if (index.container === 'matroska') {
    if (cursor.container !== 'matroska') throw mismatch(index, cursor)
    return matroskaFrames(index, cursor, chunk)
  }
  if (cursor.container !== 'mp4') throw mismatch(index, cursor)
  return mp4Frames(index, cursor, chunk)
}

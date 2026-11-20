import { isDeepStrictEqual } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  chooseTracks,
  codecNames,
  fragment,
  framesIn,
  heldBytes,
  initSegment,
  Mp4Error,
  nextRead,
  openSource,
  pictureEnd,
  seekCursor,
  startCursor,
} from '../index.ts'
import type {
  ByteRange,
  Chunk,
  Cursor,
  FragmentTrack,
  MatroskaIndex,
  MatroskaPlayTrack,
  Mp4Index,
  PlayTrack,
  SourceIndex,
} from '../index.ts'
import { fragmentRuns } from '../browser/choice.ts'
import { readClusters } from '../matroska/clusters.ts'
import type { RawFrame } from '../matroska/clusters.ts'
import { readHeader } from '../matroska/ebml.ts'
import { readHead } from '../matroska/head.ts'
import { MAX_INDEX_READS, MAX_SEEK_READS } from '../matroska/limits.ts'
import { readTracks } from '../matroska/tracks.ts'
import type { MatroskaTrack } from '../matroska/tracks.ts'
import { box, visualEntry } from '../testing/build.ts'
import {
  Differences,
  esdsParts,
  firstShown,
  rotationIn,
  rotationOf,
  turn,
} from '../testing/compare.ts'
import {
  containerOf,
  HEAD_BYTES,
  isSynthetic,
  loadManifest,
  readIndex,
  readRange,
  uniqueTitles,
} from '../testing/corpus.ts'
import type { ManifestEntry } from '../testing/corpus.ts'
import { configBoxes, configProblems, writtenEntry } from '../testing/entries.ts'
import {
  decodes,
  probePacketsOf,
  probeStreams,
  remuxEntry,
  remuxPackets,
  streamStart,
} from '../testing/ffprobe.ts'
import type { ProbePacket, ProbeStream } from '../testing/ffprobe.ts'
import { dolbyVisionRecord } from '../testing/remux.ts'
import type { SampleEntry } from '../movie.ts'

// The Matroska reader checked against ffprobe and against ffmpeg's own remux, on
// the corpus (DESIGN.md §10.4, D45): the synthetic files `corpus:make` made and
// the user's two recordings, which are read where they are. Every file is opened
// and read through the five functions of the one source (`openSource`,
// `startCursor`, `seekCursor`, `nextRead`, `framesIn`) with each read counted. For
// each file expected to play, the frames of the picture and of the sound that
// plays are compared with `ffprobe -show_packets` of the same streams (where the
// block's body is, the size, when it is shown, the keyframe flag), over the whole
// file in 1 MiB chunks and, for a file under 50 MB, in one chunk too, which must
// give the same frames; the picture's first shown time, its rotation and its
// codec are compared with ffprobe's (a track first shows anything at the least time
// of its frames that end after 0, as the MP4 suite has it, which is how ffprobe
// leaves out an encoder's priming). Matroska stores only when a frame is shown,
// so the times a frame is decoded at are the reader's own, and for a track whose
// configuration states how far its decode runs ahead of its presentation they are
// compared with ffmpeg's remux of the stream to MP4 (`-c copy`), whose decode times
// the MP4 muxer works out and whose sample entry is what a Matroska track's must
// hold: the codec names, and each configuration box (`avcC`, `hvcC`, `av1C`,
// `vpcC`, `dOps`, `dfLa`, `dac3`, `dec3`, `alac` byte for byte, `esds` by its
// object type and its DecoderSpecificInfo, since ffmpeg writes bit rates). The two
// Dolby Vision files are compared with entries that this suite builds, for ffmpeg
// writes no `dvcC` untold. The user's two recordings get no remux: a remux is a
// copy of a video's content, and their videos are read where they are and never
// copied, not even to a file that is deleted at once; so what ffprobe says of
// them in place is all they are compared with (the frames, the codec's family,
// where each track starts, the rotation), and the decode times of their frames
// are held to rise and last at least a tick. The writer's output for each track
// of a synthetic file (the init segment and the fragments of the first 10 s) is
// decoded by ffmpeg with nothing said, and its entry holds the reader's boxes.
// Reads are held to their bounds: the open's, and the three seeks of each file
// (to a quarter, a half and nine tenths of its length), which must land at a
// keyframe of the picture at or before the time, by ffprobe's list. A file
// expected to be refused gives that reason. The same source opens an MP4, and
// there it must give what `readIndex` and `chooseTracks` give, with fragments,
// from the start and from the middle, byte for byte those of the old tracks. Run
// with `pnpm --filter @dfs/mp4 test:corpus`.

const all = loadManifest()
const matroska = all.filter((entry) => containerOf(entry.path) === 'matroska')
const mp4 = all.filter((entry) => containerOf(entry.path) === 'mp4')

/** A file under this size (50 MB) is also read in one chunk. */
const ONE_CHUNK_LIMIT = 50 * 1000 * 1000

/** The chunk a caller reads at a time: 1 MiB. */
const READ = 1024 * 1024

/** The tolerance for a time: ffprobe rounds each to a tick of its time base, a millisecond. */
const TOLERANCE = 0.001 + 1e-9

/** How much of a track the writer is made to write, and the decoder to decode: the first 10 s. */
const WRITTEN_SECONDS = 10

/** The MP4 windows: 10 s of a file, from its start and from its middle, and no more than this many bytes read for one. */
const WINDOW_SECONDS = 10
const WINDOW_BYTES = 64 * 1024 * 1024

/** What the run compared, said once at the end. */
const totals = {
  matroska: 0,
  refused: 0,
  frames: 0,
  written: 0,
  seeks: 0,
  mp4: 0,
  mp4Fragments: 0,
  noStart: 0,
}

// ---- Reading a file as the engine would ----

/** What a driven call gave, with every read it asked for. */
interface Opened<T> {
  value: T
  asks: ByteRange[]
}

/** The most reads a walk may ask for before the suite gives up on it: far more than any cap. */
const WALK_GUARD = 500

/**
 * Answers the read that a reader needs: it must lie inside the file and not be one
 * that the caller holds already (a thrown `Error` is the reader's mistake, and
 * fails the file), and is read where the file is and added as a chunk.
 */
function answer(
  path: string,
  size: number,
  what: string,
  need: ByteRange,
  chunks: Chunk[],
  asks: ByteRange[],
): void {
  if (
    !Number.isSafeInteger(need.start) ||
    !Number.isSafeInteger(need.end) ||
    need.start < 0 ||
    need.end <= need.start ||
    need.end > size
  ) {
    throw new Error(
      `${what} asked for ${need.start} to ${need.end}, which is no range inside the file of ${size} bytes.`,
    )
  }
  if (heldBytes(chunks, need.start, need.end) !== null) {
    throw new Error(`${what} asked for ${need.start} to ${need.end}, which the caller holds.`)
  }
  if (asks.length >= WALK_GUARD) {
    throw new Error(`${what} asked for more than ${WALK_GUARD} reads and is not going to stop.`)
  }
  asks.push(need)
  chunks.push({ start: need.start, bytes: readRange(path, need.start, need.end - need.start) })
}

/** Opens a file: the head (a megabyte) is the caller's first read, and the reader asks for the rest. Throws what `openSource` throws. */
function open(path: string, size: number): Opened<SourceIndex> {
  const chunks: Chunk[] = [{ start: 0, bytes: readRange(path, 0, Math.min(HEAD_BYTES, size)) }]
  const asks: ByteRange[] = []
  for (;;) {
    const step = openSource(chunks, size)
    if ('done' in step) return { value: step.done, asks }
    answer(path, size, 'Opening the file', step.need, chunks, asks)
  }
}

/** The Tracks element of a Matroska file, in the order of the file, which is the order of ffprobe's streams. */
function tracksOf(path: string, size: number): MatroskaTrack[] {
  const chunks: Chunk[] = [{ start: 0, bytes: readRange(path, 0, Math.min(HEAD_BYTES, size)) }]
  const asks: ByteRange[] = []
  for (;;) {
    const step = readHead(chunks, size)
    if ('need' in step) {
      answer(path, size, 'Reading the head', step.need, chunks, asks)
      continue
    }
    const { start, end } = step.done.tracks
    const bytes = readRange(path, start, end - start)
    const element = readHeader(bytes, 0, bytes.length)
    if (element === null) throw new Error(`The Tracks element at ${start} is cut short.`)
    return readTracks(bytes, element).tracks
  }
}

/** What `framesIn` gives. */
type Spans = ReturnType<typeof framesIn>

/**
 * Calls `framesIn` over a file from a cursor, 1 MiB from where `nextRead` says at
 * a time, a chunk twice the size when the cursor did not move (a frame is longer
 * than the chunk), until the cursor has ended, `stop` says so, or `budget` bytes
 * are read. With `whole` each chunk is the rest of the file. `each` is given the
 * cursor before the call, the chunk and what the call gave.
 */
function walk(
  path: string,
  size: number,
  index: SourceIndex,
  from: Cursor,
  each: (before: Cursor, chunk: Chunk, out: Spans) => void,
  options: { whole?: boolean; stop?: (cursor: Cursor) => boolean; budget?: number } = {},
): { cursor: Cursor; calls: number } {
  let cursor = from
  let length = READ
  let read = 0
  let calls = 0
  for (;;) {
    if (options.stop?.(cursor) === true) break
    const at = nextRead(index, cursor)
    if (at === null || (options.budget !== undefined && read >= options.budget)) break
    const want = options.whole === true ? size - at : Math.min(length, size - at)
    const chunk: Chunk = { start: at, bytes: readRange(path, at, want) }
    const out = framesIn(index, cursor, chunk)
    calls += 1
    read += want
    each(cursor, chunk, out)
    if (nextRead(index, out.cursor) !== at) {
      length = READ
    } else if (at + want >= size) {
      throw new Error(
        `The cursor does not move from ${at}, though the chunk reaches the end of the file (${want} bytes).`,
      )
    } else {
      length *= 2
    }
    cursor = out.cursor
  }
  return { cursor, calls }
}

/** The time on the playback timeline that a frame of a table is shown at, in seconds. */
function shownAt(
  table: FragmentTrack['table'],
  track: { timing: { offsetSeconds: number } },
  i: number,
): number {
  return ((table.dts[i] ?? 0) + (table.cts[i] ?? 0)) / table.timescale + track.timing.offsetSeconds
}

// ---- The frames of a Matroska file ----

/** One pass over a file from its start: each track's continuous runs as `framesIn` gave them, the blocks as the cluster walk reads them (the same chunks, the same places), and the damage passed over. */
interface Gathered {
  runs: Map<number, FragmentTrack[]>
  raw: Map<number, RawFrame[]>
  skipped: ByteRange[]
}

function gather(
  path: string,
  size: number,
  index: MatroskaIndex,
  sound: MatroskaPlayTrack | null,
  whole: boolean,
): Gathered {
  const tracks = sound === null ? [index.video.read] : [index.video.read, sound.read]
  const found: Gathered = { runs: new Map(), raw: new Map(), skipped: [] }
  for (const track of tracks) {
    found.runs.set(track.number, [])
    found.raw.set(track.number, [])
  }
  walk(
    path,
    size,
    index,
    startCursor(index, sound?.header.id ?? null),
    (before, chunk, out) => {
      if (before.container !== 'matroska') throw new Error('The cursor is not a Matroska one.')
      const read = readClusters(
        chunk,
        before.at,
        before.cluster,
        before.searching,
        index.segment.end,
        tracks,
      )
      for (const frame of read.frames) found.raw.get(frame.track)?.push(frame)
      for (const run of out.frames) found.runs.get(run.header.id)?.push(run)
      found.skipped.push(...out.skipped)
    },
    { whole },
  )
  return found
}

/** A track's runs as one list of frames, with when each is shown on the playback timeline, in seconds. */
interface Flat {
  count: number
  timescale: number
  offsets: number[]
  sizes: number[]
  dts: number[]
  durations: number[]
  cts: number[]
  shown: number[]
  keys: boolean[]
  /** Where each continuous run starts. */
  starts: number[]
}

/**
 * A track's tables as one list of frames. Each call of `framesIn` gives a table,
 * and a table goes on where the one before it ended: a run is cut only by a skip
 * (the stretches the file was damaged in), so with none the tables are one run,
 * and with some each table is taken for a run of its own.
 */
function flatten(
  runs: readonly FragmentTrack[],
  track: MatroskaPlayTrack,
  skipped: readonly ByteRange[],
): Flat {
  const flat: Flat = {
    count: 0,
    timescale: track.header.timescale,
    offsets: [],
    sizes: [],
    dts: [],
    durations: [],
    cts: [],
    shown: [],
    keys: [],
    starts: [],
  }
  for (const run of runs) {
    const { table } = run
    if (flat.count === 0 || skipped.length > 0) flat.starts.push(flat.count)
    for (let i = 0; i < table.count; i += 1) {
      flat.offsets.push(table.offsets[i] ?? 0)
      flat.sizes.push(table.sizes[i] ?? 0)
      flat.dts.push(table.dts[i] ?? 0)
      flat.durations.push(table.durations[i] ?? 0)
      flat.cts.push(table.cts[i] ?? 0)
      flat.shown.push(shownAt(table, track, i))
      flat.keys.push(table.sync[i] === 1)
    }
    flat.count += table.count
  }
  return flat
}

/** Whether two passes gave the same frames, value by value (not the same tables: a table is what one call gave). */
function sameFrames(a: Flat, b: Flat): boolean {
  return (
    a.count === b.count &&
    isDeepStrictEqual(a.offsets, b.offsets) &&
    isDeepStrictEqual(a.sizes, b.sizes) &&
    isDeepStrictEqual(a.dts, b.dts) &&
    isDeepStrictEqual(a.durations, b.durations) &&
    isDeepStrictEqual(a.cts, b.cts) &&
    isDeepStrictEqual(a.keys, b.keys)
  )
}

function isKey(packet: ProbePacket): boolean {
  return packet.flags?.includes('K') ?? false
}

/** A time that ffprobe prints in seconds, or undefined where it prints none. */
function secondsOf(text: string | undefined): number | undefined {
  const value = Number(text)
  return text === undefined || Number.isNaN(value) ? undefined : value
}

/**
 * The frames of a track against the packets ffprobe lists for its stream, one for
 * one. The picture starts at its first keyframe, as a cursor from the file's
 * start does (the packets before it are left out); the sound at its first frame.
 * Beside ffprobe's packets the blocks of the cluster walk must be the same frames
 * in the same order, so that a frame left out or given twice does not move every
 * comparison after it. `pos` is where ffprobe says a packet is, which for
 * Matroska is the start of the block's body (a lace's frames share it), `size`
 * the frame with what header stripping took, and the time the packet's `pts`.
 */
function compareFrames(
  label: string,
  track: MatroskaPlayTrack,
  flat: Flat,
  raw: readonly RawFrame[],
  packets: readonly ProbePacket[],
): string[] {
  const picture = track.header.kind === 'video'
  const problems: string[] = []
  const firstPacket = picture ? packets.findIndex(isKey) : 0
  const firstBlock = picture ? raw.findIndex((frame) => frame.keyframe) : 0
  if (firstPacket === -1 || firstBlock === -1) {
    return [`${label}: it has no keyframe, in ffprobe's packets or in the blocks`]
  }
  const listed = packets.slice(firstPacket)
  const blocks = raw.slice(firstBlock)
  if (flat.count !== listed.length || flat.count !== blocks.length) {
    problems.push(
      `${label}: ${flat.count} frames, the cluster walk reads ${blocks.length} and ffprobe lists ${listed.length} packets`,
    )
  }
  const found = new Differences()
  for (let i = 0; i < Math.min(flat.count, listed.length, blocks.length); i += 1) {
    const packet = listed[i] ?? {}
    const block = blocks[i]
    found.note('offset against the cluster walk', i, flat.offsets[i], block?.offset)
    found.note('pos', i, block?.body, Number(packet.pos))
    found.note('size', i, (flat.sizes[i] ?? 0) + track.prefix.length, Number(packet.size))
    found.noteNear('pts', i, flat.shown[i] ?? 0, secondsOf(packet.pts_time), TOLERANCE)
    found.note('keyframe', i, flat.keys[i], isKey(packet))
  }
  return [...problems, ...found.report(label)]
}

/**
 * What every track is held to, whatever its configuration says: a frame lasts at
 * least a tick, the decode times never decrease within a run, and each frame's
 * decode time and duration reach the next frame's decode time (a fragment gives a
 * frame's decode time as the first frame's plus the durations before it).
 */
function runProblems(label: string, flat: Flat): string[] {
  const found = new Differences()
  for (let i = 0; i < flat.count; i += 1) {
    found.note('duration of at least a tick', i, (flat.durations[i] ?? 0) >= 1, true)
    const last = flat.starts.includes(i + 1) || i + 1 === flat.count
    if (!last) {
      found.note(
        'decode times that do not decrease',
        i,
        (flat.dts[i + 1] ?? 0) >= (flat.dts[i] ?? 0),
        true,
      )
      found.note(
        'a decode time and a duration that reach the next decode time',
        i,
        (flat.dts[i] ?? 0) + (flat.durations[i] ?? 0),
        flat.dts[i + 1],
      )
    }
  }
  return found.report(label)
}

/**
 * The decode times against ffmpeg's remux of the stream to MP4, which works them
 * out as the demuxer's reorder depth makes them: `(dts - shift) / timescale -
 * codecDelay` (a decode time with the track's shift taken off, and the CodecDelay
 * that every timestamp has taken off) against the remux's, in seconds, frame for
 * frame.
 */
function compareDecodes(
  label: string,
  track: MatroskaPlayTrack,
  flat: Flat,
  codecDelaySeconds: number,
  packets: readonly ProbePacket[],
): string[] {
  const picture = track.header.kind === 'video'
  const firstPacket = picture ? packets.findIndex(isKey) : 0
  if (firstPacket === -1) return [`${label}: the remux lists no keyframe`]
  const listed = packets.slice(firstPacket)
  const problems: string[] = []
  if (listed.length !== flat.count) {
    problems.push(`${label}: ${flat.count} frames, but the remux lists ${listed.length} packets`)
  }
  const found = new Differences()
  for (let i = 0; i < Math.min(flat.count, listed.length); i += 1) {
    found.noteNear(
      'decode time against the remux',
      i,
      ((flat.dts[i] ?? 0) - track.read.shift) / flat.timescale - codecDelaySeconds,
      secondsOf(listed[i]?.dts_time),
      TOLERANCE,
    )
  }
  return [...problems, ...found.report(label)]
}

// ---- The codec ----

/** The start of the codec string (or of one of its strings) for each codec ffprobe names: the family, which the profile and level inside it are not part of. */
const FAMILIES: Record<string, string[]> = {
  h264: ['avc1', 'dva1', 'dvav'],
  hevc: ['hvc1', 'hev1', 'dvh1', 'dvhe'],
  av1: ['av01', 'dav1'],
  vp9: ['vp09'],
  aac: ['mp4a.40'],
  opus: ['opus'],
  flac: ['flac'],
  ac3: ['ac-3'],
  eac3: ['ec-3'],
  mp3: ['mp4a.6B'],
  alac: ['alac'],
}

/** The optional fields of an AV1 codec string with the values that it means when it leaves them out: not monochrome, 4:2:0 with an unknown position of the chroma samples, BT.709 primaries, transfer and matrix, limited range. */
const AV1_DEFAULTS = '0.110.01.01.01.0'

/** The track's codec against the family of the codec ffprobe names, and its names against the string ffprobe makes of it. */
function familyProblems(label: string, track: MatroskaPlayTrack, stream: ProbeStream): string[] {
  const family = FAMILIES[stream.codec_name ?? '']
  if (family === undefined) {
    return [
      `${label}: ffprobe says ${stream.codec_name ?? 'nothing'}, which the player doesn't take, but the track was accepted (codec ${track.codec})`,
    ]
  }
  const problems: string[] = []
  if (!family.some((start) => track.codec.toLowerCase().startsWith(start.toLowerCase()))) {
    problems.push(
      `${label}: codec string ${track.codec} is not of the family ${family.join(' or ')} of ffprobe's ${stream.codec_name}`,
    )
  }
  // FFmpeg's own RFC 6381 string, where it makes one (not for every codec): any of the track's names, to the character. AV1 has one more way: ffmpeg writes the optional fields of the string when the picture states its colour (`av01.0.09M.08.0.110.01.01.01.0` for a BT.709 picture of limited range, 4:2:0), though they are the values that the string means when it leaves them out, so the short name is the same codec.
  const mime = stream.mime_codec_string
  if (
    mime !== undefined &&
    mime !== '' &&
    !track.codecNames.includes(mime) &&
    !track.codecNames.some((name) => name.startsWith('av01.') && mime === `${name}.${AV1_DEFAULTS}`)
  ) {
    problems.push(
      `${label}: codec names ${track.codecNames.join(', ')}, ffprobe's mime_codec_string ${stream.mime_codec_string}`,
    )
  }
  return problems
}

/** The sample entry of a track as the MP4 reader would give it. */
function entryOf(track: MatroskaPlayTrack): SampleEntry {
  return {
    type: String.fromCharCode(...track.entry.subarray(4, 8)),
    bytes: track.entry,
    stsdVersion: 0,
  }
}

/**
 * An `hvcC` box (whole, header included) with the array_completeness bit of each
 * array of parameter sets cleared (`complete` false) or set, or null where the arrays
 * can't be walked. The reader sets it (Safari takes `hvc1` only then), whatever the
 * CodecPrivate says; FFmpeg's
 * MP4 muxer sets that bit (0xa0 for the VPS, where the CodecPrivate of a Matroska
 * file written by ffmpeg has 0x20) whatever the record it was given said: the
 * bit says that every NAL unit of the type is in the array, which the muxer takes
 * as true and a reader that carries the CodecPrivate as it is does not. Everything
 * else in the box is compared as it is.
 */
function withCompleteness(hvcC: Uint8Array, complete: boolean): Uint8Array | null {
  const out = Uint8Array.from(hvcC)
  // The 8 bytes of the box's header and the 22 of the record's fixed fields, then the number of arrays.
  let at = 8 + 22
  const arrays = out[at]
  if (arrays === undefined) return null
  at += 1
  for (let array = 0; array < arrays; array += 1) {
    const header = out[at]
    const count = ((out[at + 1] ?? 0) << 8) | (out[at + 2] ?? 0)
    if (header === undefined) return null
    out[at] = complete ? header | 0x80 : header & 0x7f
    at += 3
    for (let unit = 0; unit < count; unit += 1)
      at += 2 + (((out[at] ?? 0) << 8) | (out[at + 1] ?? 0))
    if (at > out.length) return null
  }
  return out
}

/** The offset of the first byte at which two boxes differ (their length, when one is the start of the other). */
function differsAt(a: Uint8Array, b: Uint8Array): number {
  const at = a.findIndex((byte, index) => byte !== b[index])
  return at === -1 ? Math.min(a.length, b.length) : at
}

/**
 * The track's entry against the entry it should be: its type, the codec names,
 * and each configuration box, the same boxes in both. Byte for byte, but for
 * `esds`, which ffmpeg writes with the bit rates the stream has (a Matroska file has
 * none): its object type and its DecoderSpecificInfo; and for the `hvcC` of ffmpeg's
 * remux, whose array_completeness bits are ffmpeg's (`withCompleteness`). The entry
 * it should be is ffmpeg's remux (`expectedFrom` 'remux') or one this suite built.
 */
function entryProblems(
  label: string,
  track: MatroskaPlayTrack,
  expected: SampleEntry,
  expectedFrom: 'remux' | 'built',
): string[] {
  const expectedBy = expectedFrom === 'remux' ? 'ffmpeg' : 'the built entry'
  const picture = track.header.kind === 'video'
  const ours = entryOf(track)
  const problems: string[] = []
  if (ours.type !== expected.type) {
    problems.push(`${label}: entry '${ours.type}', ${expectedBy}'s '${expected.type}'`)
  }
  const theirNames = codecNames(expected)
  if (!isDeepStrictEqual([...track.codecNames], [...theirNames])) {
    problems.push(
      `${label}: codec names ${track.codecNames.join(', ')}, ${expectedBy}'s ${theirNames.join(', ')}`,
    )
  }
  const mine = configBoxes(ours, picture)
  const theirs = configBoxes(expected, picture)
  for (const type of new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(type)
    const b = theirs.get(type)
    if (a === undefined || b === undefined) {
      problems.push(
        `${label}: ${a === undefined ? 'no' : 'a'} '${type}' box, where ${expectedBy}'s entry has ${b === undefined ? 'none' : 'one'}`,
      )
    } else if (type === 'esds') {
      const x = esdsParts(a)
      const y = esdsParts(b)
      if (x === null || y === null) {
        problems.push(
          `${label}: an 'esds' box whose descriptors can't be read (${x === null ? 'ours' : expectedBy})`,
        )
      } else {
        if (x.objectType !== y.objectType) {
          problems.push(
            `${label}: 'esds' object type ${x.objectType}, ${expectedBy}'s ${y.objectType}`,
          )
        }
        if (
          !isDeepStrictEqual(
            x.specific && Array.from(x.specific),
            y.specific && Array.from(y.specific),
          )
        ) {
          problems.push(`${label}: 'esds' DecoderSpecificInfo differs from ${expectedBy}'s`)
        }
      }
    } else {
      // An `hvcC` is compared but for the array_completeness bits (see `withCompleteness`): ours has them all set, and the record it was built from or ffmpeg's has what it has.
      const lenient = type === 'hvcC'
      const x = lenient ? withCompleteness(a, false) : a
      const y = lenient ? withCompleteness(b, false) : b
      if (x === null || y === null) {
        problems.push(`${label}: an 'hvcC' box whose arrays can't be walked`)
      } else if (lenient && differsAt(withCompleteness(a, true) ?? a, a) < a.length) {
        problems.push(`${label}: an 'hvcC' box whose arrays are not all marked complete`)
      } else if (x.length !== y.length || differsAt(x, y) < x.length) {
        problems.push(
          `${label}: '${type}' box of ${a.length} bytes, ${expectedBy}'s of ${b.length}, first differing at byte ${differsAt(x, y)}`,
        )
      }
    }
  }
  return problems
}

/** The Dolby Vision profile and compatibility ID of the two files that carry a record, which `corpus:make` wrote with `dolbyVisionRecord`. */
const DOLBY_VISION: Record<string, [profile: number, compatibility: number]> = {
  'hevc-dv8.mkv': [8, 1],
  'hevc-dv5.mkv': [5, 0],
}

/** The BlockAddIDType of the Dolby Vision records: `dvcC`, `dvvC` and `dvwC`. */
const DOLBY_VISION_TYPES = new Set([0x64766343, 0x64767643, 0x64767743])

/**
 * The entry that a Dolby Vision picture must have, built here and not taken from
 * ffmpeg (its MP4 muxer writes a `dvcC` only with `-strict unofficial`, and writes
 * no `dvh1` untold): the `hvcC` that is the CodecPrivate of the same pictures without
 * the record (the file `hevc-aac.mkv` that the Dolby Vision files were made from)
 * and the `dvcC` that holds the record the file's BlockAdditionMapping has,
 * which must be the one `corpus:make` wrote. A profile 5 picture or one with no
 * compatible base layer is `dvh1`; a compatible one is the `hvc1` that plays without
 * Dolby Vision.
 */
function dolbyVisionEntry(path: string, track: MatroskaTrack): SampleEntry {
  const [profile, compatibility] = DOLBY_VISION[path.split(/[\\/]/).at(-1) ?? ''] ?? []
  if (profile === undefined || compatibility === undefined) {
    throw new Error(`${path} has a Dolby Vision record, and the suite doesn't know which.`)
  }
  const record = track.blockAdditions.find(({ type }) => DOLBY_VISION_TYPES.has(type))?.extraData
  if (
    !isDeepStrictEqual(
      Array.from(record ?? []),
      Array.from(dolbyVisionRecord(profile, compatibility)),
    )
  ) {
    throw new Error(`${path} holds a Dolby Vision record other than ${profile}.${compatibility}.`)
  }
  const source = resolve(path, '..', 'hevc-aac.mkv')
  const codecPrivate = tracksOf(source, statSync(source).size).find(
    (one) => one.kind === 'video',
  )?.codecPrivate
  if (codecPrivate == null) throw new Error('hevc-aac.mkv has no CodecPrivate for its picture.')
  const base = box('hvcC', codecPrivate)
  const type = compatibility !== 0 && profile !== 5 ? 'hvc1' : 'dvh1'
  return {
    type,
    bytes: visualEntry(type, {}, base, box('dvcC', dolbyVisionRecord(profile, compatibility))),
    stsdVersion: 0,
  }
}

// ---- The suite's checks of one Matroska file ----

/** The reason a Matroska file is turned away, or null when it is taken: `openSource` throws it, or the first sound's refusal is it. */
function refusalOf(path: string, size: number): { reason: string; message: string } | null {
  try {
    const { value } = open(path, size)
    const first = value.sounds[0]
    if (first !== undefined && 'refusal' in first) {
      return { reason: first.refusal.reason, message: first.refusal.message }
    }
    return null
  } catch (error) {
    if (error instanceof Mp4Error) return { reason: error.reason, message: error.message }
    throw error
  }
}

function checkRefused(entry: ManifestEntry, reason: string): void {
  const refused = refusalOf(entry.path, statSync(entry.path).size)
  expect(refused?.reason).toBe(reason)
  expect(refused?.message).toMatch(/^The (picture|sound) track can't be played: /)
  totals.refused += 1
}

/** The seek's times: a quarter, a half and nine tenths of the file's length. */
const SEEKS = [0.25, 0.5, 0.9]

/** The seconds a frame is shown until, the last of those in the track: the end of a file whose Info has no duration. */
function endOf(flat: Flat): number {
  let end = 0
  for (let i = 0; i < flat.count; i += 1) {
    end = Math.max(end, (flat.shown[i] ?? 0) + (flat.durations[i] ?? 0) / flat.timescale)
  }
  return end
}

/**
 * The seeks of a file: to each of the times, from a caller that holds nothing
 * (so that every read is asked for), each within `MAX_SEEK_READS` reads and none for
 * a range held. A seek that has needed the most it may stops where the file starts,
 * which is before any time and so would pass for a landing: it is told by its reads
 * and not by where it lands. The cursor it lands at is read from until the picture
 * gives its first frame, which must be a keyframe by ffprobe's list, shown at or
 * before the time.
 */
function seekProblems(
  path: string,
  size: number,
  index: MatroskaIndex,
  sound: MatroskaPlayTrack | null,
  length: number,
  keys: readonly number[],
): string[] {
  const problems: string[] = []
  for (const fraction of SEEKS) {
    const label = `seek to ${Math.round(fraction * 100)}%`
    const time = fraction * length
    const chunks: Chunk[] = []
    const asks: ByteRange[] = []
    let landed: Cursor | null = null
    while (landed === null) {
      const step = seekCursor(index, time, sound?.header.id ?? null, chunks)
      if ('done' in step) landed = step.done
      else answer(path, size, label, step.need, chunks, asks)
    }
    if (asks.length >= MAX_SEEK_READS) {
      problems.push(
        `${label} (${time.toFixed(3)} s): ${asks.length} reads, the most that one takes (${MAX_SEEK_READS}), where it gives up and lands at the first cluster`,
      )
    }

    let first: { shown: number; key: boolean } | null = null
    walk(
      path,
      size,
      index,
      landed,
      (_before, _chunk, out) => {
        const run = out.frames.find((frame) => frame.header.id === index.video.header.id)
        if (run !== undefined && first === null) {
          first = { shown: shownAt(run.table, index.video, 0), key: run.table.sync[0] === 1 }
        }
      },
      { stop: () => first !== null },
    )
    const frame = first as { shown: number; key: boolean } | null
    if (frame === null) {
      problems.push(
        `${label} (${time.toFixed(3)} s): no picture frame is given from where it lands`,
      )
    } else {
      if (!frame.key) problems.push(`${label}: it lands at a frame that is not a keyframe`)
      if (!keys.some((key) => Math.abs(key - frame.shown) <= TOLERANCE)) {
        problems.push(
          `${label}: it lands at a frame shown at ${frame.shown} s, which is no keyframe of ffprobe's`,
        )
      }
      if (frame.shown > time + 1e-6) {
        problems.push(
          `${label}: it lands at a keyframe shown at ${frame.shown} s, after the time, ${time} s`,
        )
      }
    }
    totals.seeks += 1
  }
  return problems
}

async function checkPlays(entry: ManifestEntry): Promise<void> {
  const { path } = entry
  const size = statSync(path).size
  const own = !isSynthetic(path)
  const problems: string[] = []

  // The open, and what it asked for.
  const opened = open(path, size)
  const index = opened.value
  if (index.container !== 'matroska') throw new Error(`${path} was opened as ${index.container}.`)
  if (opened.asks.length > MAX_INDEX_READS) {
    problems.push(
      `opening asked for ${opened.asks.length} reads after the head, where ${MAX_INDEX_READS} are the most`,
    )
  }
  if (index.reads > MAX_INDEX_READS) {
    problems.push(`the index counts ${index.reads} reads after the head, over ${MAX_INDEX_READS}`)
  }
  if (opened.asks.length > index.reads) {
    problems.push(
      `opening asked for ${opened.asks.length} reads, but the index counts ${index.reads}`,
    )
  }

  // The tracks, in the order of the file, which is ffprobe's order of streams.
  const streams = await probeStreams(path)
  const tracks = tracksOf(path, size)
  if (streams.length !== tracks.length) {
    throw new Error(
      `The Tracks element has ${tracks.length} tracks, and ffprobe finds ${streams.length} streams.`,
    )
  }
  const streamOf = (id: number): number => tracks.findIndex((track) => track.number === id)
  const kinds: Record<string, string> = { video: 'video', audio: 'audio' }
  tracks.forEach((track, at) => {
    const kind = kinds[streams[at]?.codec_type ?? '']
    if (track.kind !== 'other' && kind !== track.kind) {
      problems.push(
        `track ${track.number} is a ${track.kind} and ffprobe's stream ${at} a ${streams[at]?.codec_type}`,
      )
    }
  })

  // The sound that plays; a synthetic file has all of its sounds checked, the user's file the one.
  const sound = index.sound
  if (sound === null && index.sounds.length > 0) {
    problems.push('the first sound is not played, but the file is expected to play')
  }
  if (
    sound === null &&
    streams.some((stream) => stream.codec_type === 'audio') &&
    index.sounds.length === 0
  ) {
    problems.push(`sound: ours is none, but ffprobe has an audio stream`)
  }
  const sounds = own ? (sound === null ? [] : [sound]) : index.soundTracks
  const wanted = entry.codecs
  if (wanted?.video !== undefined && !index.video.codec.startsWith(wanted.video)) {
    problems.push(
      `picture: codec string ${index.video.codec} doesn't start with ${wanted.video}, as the manifest says`,
    )
  }
  if (sound !== null && wanted?.audio !== undefined && !sound.codec.startsWith(wanted.audio)) {
    problems.push(
      `sound: codec string ${sound.codec} doesn't start with ${wanted.audio}, as the manifest says`,
    )
  }

  // The frames: one pass for each sound, the picture compared in the first.
  const passes: readonly (MatroskaPlayTrack | null)[] = sounds.length > 0 ? sounds : [null]
  const pictureNumber = streamOf(index.video.header.id)
  let pictureFlat: Flat | null = null
  for (const [pass, current] of passes.entries()) {
    const gathered = gather(path, size, index, current, false)
    if (gathered.skipped.length > 0) {
      problems.push(
        `${gathered.skipped.length} stretches of the file were passed over as damaged, the first at ${gathered.skipped[0]?.start}`,
      )
    }
    const wholeToo = size < ONE_CHUNK_LIMIT ? gather(path, size, index, current, true) : null
    const checked: [string, MatroskaPlayTrack][] = []
    if (pass === 0) checked.push(['picture', index.video])
    if (current !== null)
      checked.push([sounds.length > 1 ? `sound ${current.header.id}` : 'sound', current])

    for (const [label, track] of checked) {
      const runs = gathered.runs.get(track.header.id) ?? []
      const flat = flatten(runs, track, gathered.skipped)
      if (flat.count === 0) {
        problems.push(`${label}: no frames`)
        continue
      }
      if (track === index.video) pictureFlat = flat
      const number = streamOf(track.header.id)
      const stream = streams[number]
      const packets = await probePacketsOf(path, number)
      problems.push(
        ...compareFrames(label, track, flat, gathered.raw.get(track.header.id) ?? [], packets),
        ...runProblems(label, flat),
      )
      totals.frames += flat.count
      if (
        wholeToo !== null &&
        !sameFrames(
          flat,
          flatten(wholeToo.runs.get(track.header.id) ?? [], track, wholeToo.skipped),
        )
      ) {
        problems.push(
          `${label}: read in one chunk, the frames are not those that 1 MiB chunks give`,
        )
      }

      if (stream === undefined) {
        problems.push(`${label}: ffprobe has no stream ${number}`)
        continue
      }
      problems.push(...familyProblems(label, track, stream))

      // Where it starts, and (a picture) how it is turned.
      const start = streamStart(stream)
      if (start === null) {
        totals.noStart += 1
      } else {
        const ours = Math.min(
          ...runs.map((run) => firstShown({ table: run.table, timing: track.timing })),
        )
        if (!(Math.abs(ours - start) <= TOLERANCE)) {
          problems.push(
            `${label}: first shown at ${ours} s, ffprobe's start_time ${start} s (${stream.start_time})`,
          )
        }
      }
      if (track === index.video) {
        const ours = rotationOf(track.header.matrix)
        const theirs = rotationIn(stream)
        if (Math.abs(turn(ours, theirs)) > 0.5) {
          problems.push(`${label}: rotation ${ours} degrees, ffprobe's ${theirs}`)
        }
        if (path.endsWith('portrait-h264.mkv') && Math.abs(turn(theirs, 90)) > 0.5) {
          problems.push(
            `${label}: ffprobe reads a rotation of ${theirs} degrees, not the 90 that the file was made with`,
          )
        }
      }

      // Against the remux, for a synthetic file (the user's videos are never remuxed).
      if (!own) {
        const dolby =
          tracks[number]?.blockAdditions.some(({ type }) => DOLBY_VISION_TYPES.has(type)) === true
        const remuxed = await remuxPackets(path, number)
        if (track.read.depthStated) {
          const delay = (tracks[number]?.codecDelay ?? 0) / 1e9
          problems.push(...compareDecodes(label, track, flat, delay, remuxed))
        }
        const theirs =
          dolby && tracks[number] !== undefined
            ? dolbyVisionEntry(path, tracks[number])
            : await remuxEntry(path, number)
        problems.push(...entryProblems(label, track, theirs, dolby ? 'built' : 'remux'))
      }
    }
  }

  // The reads of the seeks.
  const flat = pictureFlat
  const keys = (await probePacketsOf(path, pictureNumber))
    .filter(isKey)
    .flatMap((packet) => secondsOf(packet.pts_time) ?? [])
  const length = index.durationSeconds ?? (flat === null ? 0 : endOf(flat))
  problems.push(...seekProblems(path, size, index, sound, length, keys))

  totals.matroska += 1
  expect(problems).toEqual([])
}

afterAll(() => {
  if (all.length === 0) return
  console.log(
    `Matroska corpus: ${totals.matroska} files compared, ${totals.frames} frames, ${totals.refused} refusals checked, ${totals.seeks} seeks, ${totals.written} fragments written and decoded, ${totals.noStart} streams with no start time from ffprobe; ${totals.mp4} MP4 files through the one source, ${totals.mp4Fragments} fragments equal to the old tracks'.`,
  )
})

describe('the Matroska corpus against ffprobe and ffmpeg', () => {
  if (matroska.length === 0) {
    it.skip('has no Matroska files: run `pnpm --filter @dfs/mp4 corpus:make` first', () => {
      // Nothing to run: this only says why.
    })
    return
  }
  const titles = uniqueTitles(matroska.map((entry) => entry.path))
  it.each(matroska.map((entry, i) => [titles[i] ?? entry.path, entry] as const))(
    '%s',
    async (_title, entry) => {
      if (entry.expect === 'plays') await checkPlays(entry)
      else checkRefused(entry, entry.expect.refused)
    },
  )
})

// ---- The writer ----

/**
 * What the writer makes of the first 10 s of a track: the init segment, then the
 * fragments of the frames the reader gave (each table of a call cut into runs by
 * `fragmentRuns`, as the player cuts them), written to a file and decoded by
 * ffmpeg with nothing said. The init segment's entry holds the reader's codec
 * configuration boxes byte for byte, which the decode does not show.
 */
async function checkWritten(
  name: string,
  track: MatroskaPlayTrack,
  runs: readonly FragmentTrack[],
  bytes: Uint8Array,
  folder: string,
): Promise<string[]> {
  const picture = track.header.kind === 'video'
  const init = initSegment(track)
  const parts: Uint8Array[] = [init]
  let sequence = 0
  for (const run of runs) {
    const { table } = run
    let to = 0
    while (to < table.count && (table.dts[to] ?? 0) < WRITTEN_SECONDS * table.timescale) to += 1
    if (to === 0) continue
    for (const [from, end] of fragmentRuns(table, 0, to, picture)) {
      sequence += 1
      parts.push(
        fragment(run, from, end, sequence, (offset, length) =>
          bytes.subarray(offset, offset + length),
        ),
      )
    }
  }
  if (sequence === 0) return [`${name}: no fragments to write`]

  const problems = configProblems(entryOf(track), writtenEntry(init), picture).map(
    (problem) => `${name}: ${problem}`,
  )
  const out = resolve(folder, `${name.replaceAll(' ', '-')}.mp4`)
  writeFileSync(out, Buffer.concat(parts))
  // Decoded back by FFmpeg, with nothing said: no browser here plays every codec, and a decoder that starts from the init segment's entry shows that the entry says what it needs.
  const undecoded = await decodes(out)
  if (undecoded !== null) problems.push(`${name}: the output does not decode: ${undecoded}`)
  totals.written += sequence
  return problems
}

const synthetic = matroska.filter((entry) => entry.expect === 'plays' && isSynthetic(entry.path))

describe('the writer against ffmpeg, on the synthetic Matroska files', () => {
  if (synthetic.length === 0) {
    it.skip('has no synthetic Matroska files', () => {
      // Nothing to run: this only says why.
    })
    return
  }
  const titles = uniqueTitles(synthetic.map((entry) => entry.path))
  it.each(synthetic.map((entry, i) => [titles[i] ?? entry.path, entry] as const))(
    '%s',
    async (title, entry) => {
      const { path } = entry
      const size = statSync(path).size
      const { value: index } = open(path, size)
      if (index.container !== 'matroska') throw new Error(`${title} was opened as an MP4.`)
      const bytes = readFileSync(path)
      const folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-corpus-'))
      try {
        const problems: string[] = []
        const sounds = index.soundTracks.length > 0 ? index.soundTracks : [null]
        for (const [pass, sound] of sounds.entries()) {
          const gathered = gather(path, size, index, sound, false)
          if (pass === 0) {
            problems.push(
              ...(await checkWritten(
                'picture',
                index.video,
                gathered.runs.get(index.video.header.id) ?? [],
                bytes,
                folder,
              )),
            )
          }
          if (sound !== null) {
            problems.push(
              ...(await checkWritten(
                `sound ${sound.header.id}`,
                sound,
                gathered.runs.get(sound.header.id) ?? [],
                bytes,
                folder,
              )),
            )
          }
        }
        expect(problems).toEqual([])
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
  )
})

// ---- An MP4 through the same source ----

/** The parts of a track that the MP4 reader and the source must give alike. */
const TRACK_PARTS = [
  'header',
  'table',
  'timing',
  'codecNames',
  'codec',
  'entry',
  'keyframes',
] as const

function trackProblems(label: string, ours: PlayTrack, theirs: PlayTrack): string[] {
  return TRACK_PARTS.filter((part) => !isDeepStrictEqual(ours[part], theirs[part])).map(
    (part) => `${label}: ${part} is not what chooseTracks gives`,
  )
}

/**
 * Ten seconds of an MP4 through `framesIn`, 1 MiB at a time from the cursor,
 * against the old tracks: the fragments of each call's frames, written from the
 * tables it gave, are byte for byte those of the same frames of the old
 * `PlayTrack`s (the range of frames the cursor moved over). The window ends when
 * each track has gone ten seconds from where it began, or after 64 MiB are read.
 */
function mp4Window(
  label: string,
  path: string,
  size: number,
  index: Mp4Index,
  old: { video: PlayTrack; audio: PlayTrack | null },
  from: Cursor,
): { problems: string[]; fragments: number } {
  if (from.container !== 'mp4') throw new Error('The cursor is not an MP4 one.')
  const problems: string[] = []
  let fragments = 0
  const until = (track: PlayTrack, frame: number): number =>
    (track.table.dts[frame] ?? 0) + WINDOW_SECONDS * track.table.timescale
  const videoUntil = until(old.video, from.videoFrame)
  const soundUntil = old.audio === null ? 0 : until(old.audio, from.soundFrame)
  const over = (track: PlayTrack, frame: number, limit: number): boolean =>
    frame >= track.table.count || (track.table.dts[frame] ?? 0) >= limit
  walk(
    path,
    size,
    index,
    from,
    (before, chunk, out) => {
      if (before.container !== 'mp4' || out.cursor.container !== 'mp4') return
      const bytesAt = (offset: number, length: number): Uint8Array =>
        chunk.bytes.subarray(offset - chunk.start, offset - chunk.start + length)
      const moved: [string, PlayTrack | null, number, number][] = [
        ['picture', old.video, before.videoFrame, out.cursor.videoFrame],
        ['sound', old.audio, before.soundFrame, out.cursor.soundFrame],
      ]
      for (const [what, track, first, last] of moved) {
        const given = out.frames.find((frames) => frames.header.id === track?.header.id)
        if (track === null || last <= first) {
          if (given !== undefined) {
            problems.push(`${label}: ${what} frames are given that no cursor moved over`)
          }
          continue
        }
        if (given?.table.count !== last - first) {
          problems.push(
            `${label}: the cursor moved over ${last - first} ${what} frames, and ${given?.table.count ?? 0} are given`,
          )
          continue
        }
        fragments += 1
        const ours = fragment(given, 0, given.table.count, fragments, bytesAt)
        const theirs = fragment(track, first, last, fragments, bytesAt)
        if (!Buffer.from(ours.buffer, ours.byteOffset, ours.length).equals(theirs)) {
          problems.push(
            `${label}: the fragment of ${what} frames ${first} to ${last} is not the old track's`,
          )
        }
      }
    },
    {
      stop: (cursor) =>
        cursor.container === 'mp4' &&
        over(old.video, cursor.videoFrame, videoUntil) &&
        (old.audio === null || over(old.audio, cursor.soundFrame, soundUntil)),
      budget: WINDOW_BYTES,
    },
  )
  return { problems, fragments }
}

/** What `run` gives, or the `Mp4Error` it throws; anything else thrown stays thrown. */
function refusedBy<T>(run: () => T): T | Mp4Error {
  try {
    return run()
  } catch (error) {
    if (error instanceof Mp4Error) return error
    throw error
  }
}

/** The cursor of a seek that is made at once, as an MP4's is: it asks for nothing. */
function landed(step: ReturnType<typeof seekCursor>): Cursor {
  if ('need' in step) throw new Error('The seek of an MP4 asks for a read.')
  return step.done
}

function checkMp4(entry: ManifestEntry): void {
  const { path } = entry
  const size = statSync(path).size
  const problems: string[] = []
  const old = refusedBy(() => chooseTracks(readIndex(path, size), size))
  const opened = refusedBy(() => open(path, size))

  if (old instanceof Mp4Error) {
    // The source gives the same refusal, or (for a sound that can't play, which is the first offer and not the file's end) an index that plays no sound and says why.
    if (opened instanceof Mp4Error) {
      if (opened.reason !== old.reason || opened.message !== old.message) {
        problems.push(
          `refused as ${opened.reason} (${opened.message}), where chooseTracks says ${old.reason} (${old.message})`,
        )
      }
    } else {
      const first = opened.value.sounds[0]
      if (
        opened.value.sound !== null ||
        first === undefined ||
        !('refusal' in first) ||
        first.refusal.reason !== old.reason ||
        first.refusal.message !== old.message
      ) {
        problems.push(`opened, where chooseTracks refuses it as ${old.reason}`)
      }
    }
    expect(problems).toEqual([])
    totals.mp4 += 1
    return
  }

  if (opened instanceof Mp4Error) {
    throw new Error(
      `openSource refuses the file (${opened.reason}: ${opened.message}), where chooseTracks plays it`,
    )
  }
  const { value: index } = opened
  if (index.container !== 'mp4') throw new Error(`${path} was opened as ${index.container}.`)
  problems.push(...trackProblems('picture', index.video, old.video))
  if ((index.sound === null) !== (old.audio === null)) {
    problems.push(
      `sound: ${index.sound === null ? 'none' : 'one'}, where chooseTracks gives ${old.audio === null ? 'none' : 'one'}`,
    )
  } else if (index.sound !== null && old.audio !== null) {
    problems.push(...trackProblems('sound', index.sound, old.audio))
  }
  if (index.durationSeconds !== pictureEnd(old.video)) {
    problems.push(
      `duration ${index.durationSeconds} s, the picture's end ${pictureEnd(old.video)} s`,
    )
  }

  // The first 10 s, and 10 s from the middle: the two windows that are read of the file.
  const sound = index.sound?.header.id ?? null
  const windows: [string, Cursor][] = [
    ['the first 10 s', startCursor(index, sound)],
    ['10 s from the middle', landed(seekCursor(index, index.durationSeconds / 2, sound, []))],
  ]
  for (const [label, cursor] of windows) {
    const window = mp4Window(label, path, size, index, old, cursor)
    problems.push(...window.problems)
    totals.mp4Fragments += window.fragments
  }
  expect(problems).toEqual([])
  totals.mp4 += 1
}

describe('an MP4 through the one source', () => {
  if (mp4.length === 0) {
    it.skip('has no MP4 files: run `pnpm --filter @dfs/mp4 corpus:make` first', () => {
      // Nothing to run: this only says why.
    })
    return
  }
  const titles = uniqueTitles(mp4.map((entry) => entry.path))
  it.each(mp4.map((entry, i) => [titles[i] ?? entry.path, entry] as const))(
    '%s',
    (_title, entry) => {
      checkMp4(entry)
    },
  )
})

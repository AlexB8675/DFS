// Makes the synthetic half of the MP4 and Matroska readers' test corpus with
// ffmpeg (DESIGN.md §10.4, D45): small files from generated pictures and tones,
// each with one of the box structures that real MP4 files come in, one of the
// ways that a Matroska file is laid out, or one of the codecs that a browser's
// Media Source plays (and some that none does), so that the readers and the
// writer can be checked against ffprobe, and the writer's output decoded by
// ffmpeg, on files whose content is not anyone's. A Matroska file ffmpeg can't
// write (frames laced, or stripped of their headers, a Dolby Vision record,
// clusters of unknown size) is derived from one that it wrote, by the rewriter in
// `src/testing/remux.ts`. It writes them to `corpus/synthetic/` and names them in
// `corpus/manifest.local.json` with what the reader must do with each (merged with
// the entries already there, keyed by path). A file that is already made is
// skipped, unless `--force`, which makes every file again, or it is derived from a
// file that was made in this run (it would no longer come from it). ffmpeg's
// encoders do not promise the same bytes twice, so to make one file again, delete
// it, and the files derived from it are made again with it.
//
// Run with `pnpm --filter @dfs/mp4 corpus:make [--force]`; it needs `ffmpeg` and
// `ffprobe` on the PATH.

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { child } from '../src/boxes.ts'
import type { Box } from '../src/boxes.ts'
import { frameTable } from '../src/frames.ts'
import { locateMoov, moovIn } from '../src/locate.ts'
import { readHeader } from '../src/matroska/ebml.ts'
import { readHead } from '../src/matroska/head.ts'
import { readTracks } from '../src/matroska/tracks.ts'
import type { MatroskaTrack } from '../src/matroska/tracks.ts'
import { readMovie } from '../src/movie.ts'
import { framesIn, nextRead, openSource, startCursor } from '../src/source.ts'
import {
  HEAD_BYTES,
  mergeEntries,
  readIndex,
  readManifest,
  readRange,
  syntheticDir,
  writeManifest,
} from '../src/testing/corpus.ts'
import type { ManifestEntry } from '../src/testing/corpus.ts'
import type { Lacing } from '../src/testing/ebml.ts'
import { layoutOf, remuxFile, withUnknownClustersFile } from '../src/testing/remux.ts'
import type { Changes, Layout } from '../src/testing/remux.ts'

/** Every file is this long, in seconds. */
const SECONDS = 12

/** A generated picture: 30 frames a second of a test pattern with a running clock. */
function picture(size: string): string[] {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${SECONDS}`]
}

/** A generated sound: a sine (mono), at 48 kHz unless it is given another rate. */
function tone(hertz: number, rate = 48000): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${hertz}:sample_rate=${rate}:duration=${SECONDS}`]
}

const H264 = [
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-bf',
  '3',
  '-g',
  '60',
  '-pix_fmt',
  'yuv420p',
]
const AAC = ['-c:a', 'aac', '-b:a', '128k']
/** VP9 as fast as it goes, with a keyframe every 2 s. */
const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-b:v',
  '1M',
  '-g',
  '60',
]
const OPUS = ['-c:a', 'libopus', '-b:a', '96k']

/**
 * What a Matroska file's top level must be: a predicate over the Segment's children
 * by name, in order, each run of the same said once (`layoutOf`), that gives what is
 * wrong with the file, or null.
 */
type LayoutCheck = (layout: Layout) => string | null

interface SpecBase {
  name: string
  /** The boxes at the top of an MP4 file, in order, or for a Matroska file a check of its layout (what it makes of the structure, checked after it is made). */
  layout: string | LayoutCheck
  /** ffprobe's codec name of each stream, in order. */
  streams: string[]
  expect: ManifestEntry['expect']
  codecs?: ManifestEntry['codecs']
  /** A change to the made file, in place and before it is checked: for what ffmpeg has no option to write. */
  patch?: (path: string) => void
  /** A check of the made file that ffprobe has no word for, throwing what is wrong. */
  verify?: (path: string) => void
}

/** A file ffmpeg writes. */
interface MadeSpec extends SpecBase {
  /** ffmpeg's arguments between the inputs' options and the output file. */
  args: string[]
}

/** A file that is the rewrite of another spec's file, which comes before it in the list: ffmpeg has no option to write it. Its streams must be the source's too. */
interface DerivedSpec extends SpecBase {
  /** The name of the file it is made from, in the synthetic folder. */
  from: string
  /** Writes the file at `out` from the one at `source`. */
  derive: (source: string, out: string) => void
}

type Spec = MadeSpec | DerivedSpec

/** A sound entry as the made file has it: its type and version, its rate field in hertz, and where its boxes begin (after the fields of its version). */
interface SoundEntry {
  type: string
  version: number
  /** The 16.16 field, as hertz. */
  rate: number
  bytes: Uint8Array
  inside: Box
}

/** The first sound's first sample description, as the reader gives it (the made file's own bytes). */
function soundEntryOf(path: string): SoundEntry {
  const size = statSync(path).size
  const entry = readIndex(path, size).tracks.find((track) => track.kind === 'audio')?.entries[0]
  if (!entry) throw new Error('The file has no sound with a sample description.')
  const view = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength)
  // After the 8 bytes of the box, 28 of fields (ISO/IEC 14496-12, and QuickTime's version 0), to which QuickTime's version 1 adds 16 and its version 2 adds 36.
  const version = view.getUint16(16)
  const fields = 36 + (version === 1 ? 16 : version === 2 ? 36 : 0)
  return {
    type: entry.type,
    version,
    rate: view.getUint32(32) / 0x10000,
    bytes: entry.bytes,
    inside: { type: entry.type, start: 0, body: fields, end: entry.bytes.length },
  }
}

/**
 * The colour codes in the first picture's `vpcC` box (VP Codec ISO Media File Format
 * Binding), read from the file's own bytes and not by the reader's naming: the colour
 * primaries, the transfer characteristics and the matrix coefficients, which are
 * ITU-T H.273 codes (9 is BT.2020, 16 is PQ), as the made file has them.
 */
function vpcColourOf(path: string): { primaries: number; transfer: number; matrix: number } {
  const size = statSync(path).size
  const entry = readIndex(path, size).tracks.find((track) => track.kind === 'video')?.entries[0]
  if (!entry) throw new Error('The file has no picture with a sample description.')
  // After the 8 bytes of the box's header, 78 of fields (ISO/IEC 14496-12: the data reference index and the 70 of a VisualSampleEntry), where the entry's boxes begin.
  const inside: Box = { type: entry.type, start: 0, body: 86, end: entry.bytes.length }
  const config = child(entry.bytes, inside, 'vpcC')
  if (!config) throw new Error(`The '${entry.type}' entry has no 'vpcC' box.`)
  // The box's version (1 byte) and flags (3), then the profile, the level and a byte of bit depth, chroma subsampling and range, then the three codes.
  const version = entry.bytes[config.body]
  if (version !== 1) {
    throw new Error(`The 'vpcC' box is version ${version}, and only 1 holds the colour codes.`)
  }
  const [primaries, transfer, matrix] = entry.bytes.subarray(config.body + 7, config.body + 10)
  if (primaries === undefined || transfer === undefined || matrix === undefined) {
    throw new Error(`The 'vpcC' box is cut short before its colour codes.`)
  }
  return { primaries, transfer, matrix }
}

/** The tag of a descriptor of an `esds` (ISO/IEC 14496-1), checked, and where its body begins: after a length of one to four bytes, 7 bits each, the top bit saying that another follows. */
function descriptorBody(bytes: Uint8Array, at: number, tag: number): number {
  if (bytes[at] !== tag) {
    throw new Error(`The descriptor at ${at} of the 'esds' has the tag ${bytes[at]}, not ${tag}.`)
  }
  let next = at + 1
  while (((bytes[next] ?? 0) & 0x80) !== 0) next += 1
  return next + 1
}

/**
 * Where the objectTypeIndication byte of the first sound's `esds` is in the
 * file, and what it says. The sound is found by the reader, and its entry's
 * position in the file is the moov's (where `locateMoov` puts it) plus its
 * position in the moov's bytes. The ES_Descriptor holds the stream's ID and its
 * flags (none are set by ffmpeg, so no stream, URL or clock follows), then the
 * DecoderConfigDescriptor, whose first byte this is.
 */
function objectTypeOf(path: string): { at: number; value: number } {
  const size = statSync(path).size
  const found = locateMoov(readRange(path, 0, Math.min(HEAD_BYTES, size)), size)
  if (!found) throw new Error('No moov was found in the file.')
  const range = readRange(path, found.start, found.end - found.start)
  const entry = readMovie(moovIn(range)).tracks.find((track) => track.kind === 'audio')?.entries[0]
  if (!entry) throw new Error('The file has no sound with a sample description.')
  const inside: Box = { type: entry.type, start: 0, body: 36, end: entry.bytes.length }
  const esds = child(entry.bytes, inside, 'esds')
  if (!esds) throw new Error(`The '${entry.type}' sample description has no 'esds' box.`)
  // The box's version and flags (4 bytes), then the ES_Descriptor: its ID (2 bytes) and its flags (1), then the DecoderConfigDescriptor.
  const stream = descriptorBody(entry.bytes, esds.body + 4, 0x03)
  if (entry.bytes[stream + 2] !== 0)
    throw new Error('The ES_Descriptor has flags that are not read.')
  const decoder = descriptorBody(entry.bytes, stream + 3, 0x04)
  const value = entry.bytes[decoder]
  if (value === undefined) throw new Error('The DecoderConfigDescriptor is empty.')
  // `entry.bytes` is a view of the moov, which is a view of the range that was read from `found.start`.
  const at = found.start + (entry.bytes.byteOffset - range.byteOffset) + decoder
  if (readRange(path, at, 1)[0] !== value) {
    throw new Error(`The byte at ${at} of the file is not the one the reader found (${value}).`)
  }
  return { at, value }
}

/** MPEG-4 audio's objectTypeIndication, which ffmpeg writes for AAC, and MPEG-2 AAC's low complexity profile. */
const OTI_MPEG4_AUDIO = 0x40
const OTI_MPEG2_AAC_LC = 0x67

/** The arguments that give the output the Matroska container, and WebM's. */
const MATROSKA = ['-f', 'matroska']
const WEBM = ['-f', 'webm']
/** 8-bit HEVC, as fast as it goes, with a keyframe every 2 s. */
const HEVC = [
  '-c:v',
  'libx265',
  '-preset',
  'veryfast',
  '-pix_fmt',
  'yuv420p',
  '-x265-params',
  'keyint=60:log-level=error',
]
/** A tick of a Matroska file's timestamps, which are in milliseconds, in seconds: how far apart a laced frame's time and the unlaced one's can be. */
const LACED_TOLERANCE = 0.001

/** Matroska's CodecIDs, which the rewriter finds the tracks to change by. */
const AAC_ID = 'A_AAC'
const AC3_ID = 'A_AC3'
const MP3_ID = 'A_MPEG/L3'

/** Every Matroska file has its Info and Tracks, and its Clusters after them. */
function basics({ names }: Layout): string | null {
  const info = names.indexOf('Info')
  const tracks = names.indexOf('Tracks')
  const cluster = names.indexOf('Cluster')
  if (info < 0 || tracks < 0 || cluster < 0) return 'it lacks Info, Tracks or a Cluster'
  if (tracks > cluster) return 'its Tracks come after a Cluster'
  return null
}

/** Cues after the last Cluster, as ffmpeg writes them by default, in a Segment and Clusters that have their sizes. */
const CUES_AFTER: LayoutCheck = (layout) => {
  const { names, segmentSized, clustersSized } = layout
  if (!segmentSized || !clustersSized) return 'its Segment or its Clusters have no size'
  if (names.filter((name) => name === 'Cues').length !== 1) return 'it does not have one Cues'
  if (names.lastIndexOf('Cues') < names.lastIndexOf('Cluster')) {
    return 'its Cues are not after the last Cluster'
  }
  return basics(layout)
}

/** Cues before the first Cluster, as `-cues_to_front 1` writes them. */
const CUES_FRONT: LayoutCheck = (layout) => {
  const { names, segmentSized } = layout
  if (!segmentSized) return 'its Segment has no size'
  if (names.filter((name) => name === 'Cues').length !== 1) return 'it does not have one Cues'
  if (names.indexOf('Cues') > names.indexOf('Cluster')) {
    return 'its Cues are not before the first Cluster'
  }
  return basics(layout)
}

/** No Cues and a Segment of unknown size, as `-live 1` writes a file. */
const LIVE: LayoutCheck = (layout) => {
  if (layout.segmentSized) return 'its Segment has a size'
  if (layout.names.includes('Cues')) return 'it has Cues'
  return basics(layout)
}

/** What the rewriter makes: Info, Tracks and Clusters alone, in a Segment of known size. */
const REBUILT: LayoutCheck = ({ names, segmentSized, clustersSized }) =>
  names.join(' ') === 'Info Tracks Cluster' && segmentSized && clustersSized
    ? null
    : 'it is not a Segment of Info, Tracks and Clusters, all of known size'

/** What the in-place rewrite makes of a live file: its Segment unknown still, no Cues, and every Cluster unknown. */
const UNKNOWN: LayoutCheck = (layout) => {
  if (layout.segmentSized || layout.clustersSized) return 'its Segment or its Clusters have a size'
  if (layout.names.includes('Cues')) return 'it has Cues'
  return basics(layout)
}

/** A layout as the log says it. */
function describeLayout({ names, segmentSized, clustersSized }: Layout): string {
  return [
    names.join(' '),
    ...(segmentSized ? [] : ['Segment of unknown size']),
    ...(clustersSized ? [] : ['Clusters of unknown size']),
  ].join('; ')
}

/** The tracks of a Matroska file, as the module reads its Tracks element (the head is the file's first megabyte, as the player reads it). */
function matroskaTracksOf(path: string): MatroskaTrack[] {
  const size = statSync(path).size
  const bytes = readRange(path, 0, Math.min(HEAD_BYTES, size))
  const head = readHead([{ start: 0, bytes }], size)
  if (!('done' in head)) throw new Error(`The head of ${path} needs more than its first megabyte.`)
  const { tracks } = head.done
  const el = tracks.end <= bytes.length ? readHeader(bytes, tracks.start, tracks.end) : null
  if (el === null) throw new Error(`The Tracks of ${path} are not in its first megabyte.`)
  return readTracks(bytes, el).tracks
}

/** What `framesOfFile` collects of a track: each frame as the writer will be given it (its stored bytes behind the prefix that header stripping took), with its times in the track's ticks. */
interface TrackFrames {
  timescale: number
  frames: Uint8Array[]
  dts: number[]
  pts: number[]
  sync: number[]
}

/** The picture's and the played sound's frames of a Matroska file, read through `openSource` and `framesIn` as the player reads them, from the file held whole. */
function framesOfFile(path: string): { video: number; frames: Map<number, TrackFrames> } {
  const bytes = Uint8Array.from(readFileSync(path))
  const chunk = { start: 0, bytes }
  const opened = openSource([chunk], bytes.length)
  if (!('done' in opened)) throw new Error(`${path} asks for more than it holds.`)
  const index = opened.done
  if (index.container !== 'matroska') throw new Error(`${path} is not a Matroska file.`)
  let cursor = startCursor(index, index.sound?.header.id ?? null)
  const frames = new Map<number, TrackFrames>()
  // One call gives the file; a few more would be a reader that gives it in parts.
  for (let turn = 0; ; turn += 1) {
    const given = framesIn(index, cursor, chunk)
    if (given.skipped.length > 0) {
      throw new Error(`${path} has damage: ${JSON.stringify(given.skipped)}`)
    }
    for (const track of given.frames) {
      const { table } = track
      const one = frames.get(track.header.id) ?? {
        timescale: table.timescale,
        frames: [],
        dts: [],
        pts: [],
        sync: [],
      }
      const prefix = track.prefix ?? new Uint8Array(0)
      for (let i = 0; i < table.count; i += 1) {
        const at = table.offsets[i] ?? 0
        const stored = bytes.subarray(at, at + (table.sizes[i] ?? 0))
        one.frames.push(Uint8Array.from([...prefix, ...stored]))
        one.dts.push(table.dts[i] ?? 0)
        one.pts.push((table.dts[i] ?? 0) + (table.cts[i] ?? 0))
        one.sync.push(table.sync[i] ?? 0)
      }
      frames.set(track.header.id, one)
    }
    if (nextRead(index, given.cursor) === null) break
    if (turn >= 100) throw new Error(`${path} does not end after ${turn} reads of the whole file.`)
    cursor = given.cursor
  }
  return { video: index.video.header.id, frames }
}

/**
 * A check that the file has the frames of another in the synthetic folder, which it
 * is derived from: the same tracks, and for each the same number of frames, with
 * the same bytes (what the file stores behind what header stripping took) and
 * keyframes, at the same times. The picture's times are exact. The sound's are
 * within `tolerance` seconds (0 is exact): a sound laced in the file is timed by
 * the durations of its frames, and ffmpeg writes the timecodes of the unlaced one
 * rounded to the millisecond, so they differ by up to a tick.
 */
function sameFramesAs(from: string, tolerance = 0): (path: string) => void {
  return (path) => {
    const wanted = framesOfFile(resolve(syntheticDir, from))
    const got = framesOfFile(path)
    const ids = (frames: Map<number, TrackFrames>): string => [...frames.keys()].join(', ')
    if (ids(wanted.frames) !== ids(got.frames)) {
      throw new Error(
        `The tracks with frames are ${ids(got.frames)}, not ${from}'s ${ids(wanted.frames)}.`,
      )
    }
    for (const [id, one] of wanted.frames) {
      const two = got.frames.get(id)
      if (two === undefined) throw new Error(`Track ${id} has no frames, and ${from}'s has.`)
      if (two.timescale !== one.timescale || two.frames.length !== one.frames.length) {
        throw new Error(
          `Track ${id} has ${two.frames.length} frames in a timescale of ${two.timescale}, not ${from}'s ${one.frames.length} in ${one.timescale}.`,
        )
      }
      const allowed = (id === wanted.video ? 0 : tolerance) * one.timescale + 1e-6
      for (let i = 0; i < one.frames.length; i += 1) {
        const a = one.frames[i] ?? new Uint8Array(0)
        const b = two.frames[i] ?? new Uint8Array(0)
        if (a.length !== b.length || a.some((byte, at) => byte !== b[at])) {
          throw new Error(`Frame ${i} of track ${id} is not ${from}'s.`)
        }
        if (one.sync[i] !== two.sync[i]) {
          throw new Error(`Frame ${i} of track ${id} differs from ${from}'s in its keyframe flag.`)
        }
        const dts = Math.abs((one.dts[i] ?? 0) - (two.dts[i] ?? 0))
        const pts = Math.abs((one.pts[i] ?? 0) - (two.pts[i] ?? 0))
        if (dts > allowed || pts > allowed) {
          throw new Error(
            `Frame ${i} of track ${id} is at ${two.dts[i]}/${two.pts[i]} (decode/presentation), ${from}'s at ${one.dts[i]}/${one.pts[i]}, in ticks of 1/${one.timescale} s: more than ${tolerance} s apart.`,
          )
        }
      }
    }
  }
}

/** A check that runs each of the checks in turn. */
function allOf(...checks: ((path: string) => void)[]): (path: string) => void {
  return (path) => {
    for (const check of checks) check(path)
  }
}

/** The side data of ffprobe's Dolby Vision configuration record. */
interface DoviSideData {
  side_data_type?: string
  dv_profile?: number
  dv_level?: number
  rpu_present_flag?: number
  el_present_flag?: number
  bl_present_flag?: number
  dv_bl_signal_compatibility_id?: number
}

/** A check that ffprobe reads a Dolby Vision configuration record of this profile and compatibility (with level 6, an RPU and a base layer, and no enhancement layer) from the first picture. */
function dolbyVisionIs(profile: number, compatibility: number): (path: string) => void {
  return (path) => {
    const out = run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_streams',
      '-of',
      'json',
      path,
    ])
    const parsed = JSON.parse(out) as { streams: { side_data_list?: DoviSideData[] }[] }
    const found = parsed.streams[0]?.side_data_list?.find(
      (data) => data.side_data_type === 'DOVI configuration record',
    )
    if (found === undefined) throw new Error('ffprobe reads no Dolby Vision configuration record.')
    const got = [
      found.dv_profile,
      found.dv_level,
      found.rpu_present_flag,
      found.el_present_flag,
      found.bl_present_flag,
      found.dv_bl_signal_compatibility_id,
    ]
    const wanted = [profile, 6, 1, 0, 1, compatibility]
    if (got.join(',') !== wanted.join(',')) {
      throw new Error(
        `ffprobe reads the Dolby Vision record (profile, level, rpu, el, bl, compatibility) ${got.join(', ')}, not ${wanted.join(', ')}.`,
      )
    }
  }
}

/** A rewrite of the file by the rewriter, with these changes. */
function remuxed(changes: Changes): (source: string, out: string) => void {
  return (source, out) => {
    remuxFile(source, out, changes)
  }
}

/** The frames of the tracks with this CodecID laced `count` to a block. */
function laced(
  codec: string,
  count: number,
  lacing: Lacing,
): (source: string, out: string) => void {
  return remuxed({ lace: { codec, count, lacing } })
}

const SPECS: Spec[] = [
  {
    // ftyp, moov, free, mdat: the index in front of the samples, as `-movflags +faststart` (or a phone's editor) leaves it.
    // The picture has 3 B-frames, so its decode times start before its presentation times and its edit list starts
    // in the media; the sound has AAC's priming, so its edit list does too.
    name: 'h264-aac-faststart.mp4',
    layout: 'ftyp moov free mdat',
    streams: ['h264', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // A stream-copy cut, as `ffmpeg -ss <t> -c copy` (and so LosslessCut) leaves it: the file above from 2.3 s, in the middle of
    // a group of pictures (keyframes every 2 s), by input seeking. The frames from the keyframe before the cut are kept,
    // behind a media edit that starts at the cut, so the picture's first frame is shown before its edit starts. Media Source
    // drops every frame shown before 0 and the rest of that group with them, so it would never start: the reader must refuse it.
    name: 'h264-aac-cut.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [
      '-ss',
      '2.3',
      '-i',
      resolve(syntheticDir, 'h264-aac-faststart.mp4'),
      '-c',
      'copy',
      '-f',
      'mp4',
    ],
    expect: { refused: 'edit-list' },
    verify: (path) => {
      const size = statSync(path).size
      const picture = readIndex(path, size).tracks.find((track) => track.kind === 'video')
      if (!picture) throw new Error('The cut has no picture track.')
      const edit = picture.edits?.at(-1)
      if (!edit) throw new Error(`The picture has no edit list: ${JSON.stringify(picture.edits)}`)
      const table = frameTable(picture, size)
      let first = Infinity
      for (let i = 0; i < table.count; i += 1) {
        first = Math.min(first, (table.dts[i] ?? 0) + (table.cts[i] ?? 0))
      }
      if (!(edit.mediaTime > first)) {
        throw new Error(
          `The picture's media edit starts at ${edit.mediaTime}, not after its first frame, shown at ${first} (in ticks of 1/${picture.timescale} s): it is no cut.`,
        )
      }
    },
  },
  {
    // ftyp, free, mdat, moov: the index after the samples, as a phone leaves a recording it has just stopped.
    name: 'h264-aac-end.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // Main 10 HEVC, in the `hvc1` entry that Safari takes and with the HDR (PQ, BT.2020) colour tags; index at the end.
    name: 'hevc10-hvc1-aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['hevc', 'aac'],
    args: [
      ...picture('1920x1080'),
      ...tone(440),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p10le',
      '-tag:v',
      'hvc1',
      '-x265-params',
      'keyint=60:log-level=error',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'hvc1.2.', audio: 'mp4a.40.2' },
  },
  {
    // 8-bit HEVC in the `hev1` entry (parameter sets may be in the samples), index at the end.
    name: 'hevc-hev1-aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['hevc', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hev1',
      '-x265-params',
      'keyint=60:log-level=error',
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'hev1.1.', audio: 'mp4a.40.2' },
  },
  {
    // AV1 (`av01`) and Opus (`Opus` with a `dOps`), index at the end.
    name: 'av1-opus.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['av1', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libsvtav1',
      '-preset',
      '10',
      '-g',
      '60',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'av01.0.', audio: 'opus' },
  },
  {
    // A picture turned a quarter: the `tkhd` matrix says 90 degrees and the picture is still 1280x720, as a phone held upright
    // records it. `-noautorotate` keeps ffmpeg from turning the pixels itself and dropping the matrix; `-display_rotation`
    // is an input option, so it comes before the picture's `-i`.
    name: 'portrait-h264.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [
      '-noautorotate',
      '-display_rotation',
      '90',
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // The sound starts 0.5 s after the picture (`-itsoffset` before the tone's `-i`): its edit list starts with an empty edit,
    // of 0.4787 s because ffmpeg takes AAC's 1024 priming samples off the pause, and then the media from its start.
    name: 'late-sound.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), '-itsoffset', '0.5', ...tone(440), ...H264, ...AAC, '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
    verify: (path) => {
      const size = statSync(path).size
      const sound = readIndex(path, size).tracks.find((track) => track.kind === 'audio')
      if (sound?.edits?.[0]?.mediaTime !== -1) {
        throw new Error(`The sound has no leading empty edit: ${JSON.stringify(sound?.edits)}`)
      }
    },
  },
  {
    // QuickTime's own flavour: `mov` brand, and AAC in a version 1 `mp4a` that holds its `esds` inside a `wave` box.
    name: 'qt-aac.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, '-f', 'mov'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // The sound in PCM (`sowt`), which Media Source doesn't take: the reader must refuse it.
    name: 'qt-pcm.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'pcm_s16le'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'pcm_s16le', '-f', 'mov'],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // One picture, two sounds (440 and 880 Hz) and a timecode track (`tmcd`): only the first picture and the first sound are played.
    name: 'extra-tracks.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'aac', 'aac', 'unknown'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...tone(880),
      '-map',
      '0',
      '-map',
      '1',
      '-map',
      '2',
      ...H264,
      ...AAC,
      '-timecode',
      '00:00:00:00',
      '-f',
      'mov',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // Already in fragments: an empty `moov` with an `mvex`, then `moof`/`mdat` pairs. The reader must refuse it.
    name: 'fragmented.mp4',
    layout: 'ftyp moov moof mdat mfra',
    streams: ['h264', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
    ],
    expect: { refused: 'fragmented' },
  },
  {
    // VP9 (`vp09`, with a `vpcC` of version 1) and Opus, index at the end.
    name: 'vp9-opus.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['vp9', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...VP9,
      '-pix_fmt',
      'yuv420p',
      ...OPUS,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'vp09.00', audio: 'opus' },
  },
  {
    // VP9 profile 2, 10 bits, in HDR's colour (PQ, BT.2020): `vp09.02`. With ffmpeg N-126374 the colour options of the output don't reach
    // libvpx's `vpcC` (it keeps 2, 2 and the matrix), so the picture is tagged by `setparams` in the filter graph, which does; `verify`
    // reads the codes from the made file.
    name: 'vp9-10bit-pq.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['vp9', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...VP9,
      '-profile:v',
      '2',
      '-pix_fmt',
      'yuv420p10le',
      '-vf',
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      ...OPUS,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'vp09.02' },
    verify: (path) => {
      const { primaries, transfer, matrix } = vpcColourOf(path)
      if (primaries !== 9 || transfer !== 16 || matrix !== 9) {
        throw new Error(
          `The 'vpcC' colour codes are ${primaries}, ${transfer} and ${matrix}, not 9, 16 and 9 (BT.2020, PQ, BT.2020 non-constant luminance).`,
        )
      }
    },
  },
  {
    // FLAC in MP4 (`fLaC` with a `dfLa`).
    name: 'h264-flac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'flac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'flac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'flac' },
  },
  {
    // FLAC at 96 kHz: ISO's rate field has 16 bits for the whole part of the rate, so ffmpeg writes half of it in the entry, and the
    // rate itself is in the `dfLa`.
    name: 'h264-flac96k.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'flac'],
    args: [...picture('1280x720'), ...tone(440, 96000), ...H264, '-c:a', 'flac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'flac' },
    verify: (path) => {
      const { rate } = soundEntryOf(path)
      if (rate !== 48000) throw new Error(`The entry's rate field is ${rate} Hz, not 48000.`)
    },
  },
  {
    // AC-3 in MP4 (`ac-3` with a `dac3`).
    name: 'h264-ac3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'ac3', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
  },
  {
    // E-AC-3 in MP4 (`ec-3` with a `dec3`).
    name: 'h264-eac3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'eac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'eac3', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'ec-3' },
  },
  {
    // Apple Lossless in MP4 (`alac`, with its magic cookie in an `alac` box).
    name: 'h264-alac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'alac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'alac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'alac' },
  },
  {
    // MP3 in MP4: an `mp4a` whose `esds` says MPEG-1 audio (0x6B), which is `mp4a.6B` and which browsers also know as `mp4a.40.34`.
    name: 'h264-mp3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'mp3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'libmp3lame', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
  },
  {
    // AC-3 in QuickTime's flavour: a version 1 entry with the `dac3` inside a `wave` box, which the init segment has to rewrite.
    name: 'h264-ac3.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'ac3', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
    verify: (path) => {
      const { type, version, bytes, inside } = soundEntryOf(path)
      if (type !== 'ac-3' || version !== 1) {
        throw new Error(`The sound is a '${type}' entry of version ${version}, not 'ac-3' of 1.`)
      }
      const wave = child(bytes, inside, 'wave')
      if (!wave || !child(bytes, wave, 'dac3'))
        throw new Error(`The entry has no 'dac3' in a 'wave'.`)
    },
  },
  {
    // Apple Lossless at 96 kHz in QuickTime's flavour: a version 2 entry, whose rate is a float and whose channels are in the bytes it adds.
    name: 'h264-alac96k.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'alac'],
    args: [...picture('1280x720'), ...tone(440, 96000), ...H264, '-c:a', 'alac', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'alac' },
    verify: (path) => {
      const { version } = soundEntryOf(path)
      if (version !== 2) throw new Error(`The sound entry is version ${version}, not 2.`)
    },
  },
  {
    // MP3 in QuickTime's flavour: the `.mp3` entry, version 1 and with no configuration box, which the init segment gives the type
    // `mp4a` and an `esds`.
    name: 'h264-mp3.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'mp3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'libmp3lame', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
    verify: (path) => {
      const { type, version } = soundEntryOf(path)
      if (type !== '.mp3' || version !== 1) {
        throw new Error(`The sound is a '${type}' entry of version ${version}, not '.mp3' of 1.`)
      }
    },
  },
  {
    // MPEG-2 AAC (low complexity, `mp4a.67`): the AAC file above, stream-copied, with one byte of its `esds` changed in place, the
    // objectTypeIndication, from MPEG-4 audio's 0x40 to MPEG-2 AAC LC's 0x67, which ffmpeg has no option to write. The size is the same.
    // It is named `mp4a.40.2` (the audio object type of its AudioSpecificConfig, which is also ffprobe's name for it) and no other,
    // and written with the object type 0x40 again, as Chrome's Media Source takes nothing else.
    name: 'h264-mpeg2aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: ['-i', resolve(syntheticDir, 'h264-aac-faststart.mp4'), '-c', 'copy', '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
    patch: (path) => {
      const { at, value } = objectTypeOf(path)
      if (value !== OTI_MPEG4_AUDIO) {
        throw new Error(
          `The objectTypeIndication is ${value}, and only ${OTI_MPEG4_AUDIO} is changed.`,
        )
      }
      const fd = openSync(path, 'r+')
      try {
        writeSync(fd, Uint8Array.of(OTI_MPEG2_AAC_LC), 0, 1, at)
      } finally {
        closeSync(fd)
      }
    },
    verify: (path) => {
      const { value } = objectTypeOf(path)
      if (value !== OTI_MPEG2_AAC_LC) {
        throw new Error(`The objectTypeIndication is ${value}, not ${OTI_MPEG2_AAC_LC}.`)
      }
    },
  },
  {
    // IAMF in MP4: Opus in an `iamf` entry with an `iacb`, for an audio element made of the output stream 1 (after the picture),
    // and a mix presentation that plays it in stereo.
    name: 'h264-iamf.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      '-c:a',
      'libopus',
      '-stream_group',
      'type=iamf_audio_element:id=1:st=1:audio_element_type=channel,layer=ch_layout=mono',
      '-stream_group',
      'type=iamf_mix_presentation:id=2:stg=0:annotations=en-us=default,submix=parameter_id=100:parameter_rate=48000|element=stg=0:parameter_id=101:parameter_rate=48000:annotations=en-us=main|layout=sound_system=stereo',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { audio: 'iamf.000.000.Opus' },
    verify: (path) => {
      const { type, bytes, inside } = soundEntryOf(path)
      if (type !== 'iamf') throw new Error(`The sound is a '${type}' entry, not 'iamf'.`)
      if (!child(bytes, inside, 'iacb')) throw new Error(`The 'iamf' entry has no 'iacb' box.`)
    },
  },
  {
    // MPEG-4 Visual (`mp4v`), which no browser's Media Source takes: the reader must refuse it.
    name: 'mpeg4-visual.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['mpeg4', 'aac'],
    args: [...picture('1280x720'), ...tone(440), '-c:v', 'mpeg4', ...AAC, '-f', 'mp4'],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // PCM in an ISO MP4 (`ipcm`), which no browser's Media Source takes: the reader must refuse it.
    name: 'h264-pcm.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'pcm_s16le'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'pcm_s16le', '-f', 'mp4'],
    expect: { refused: 'unsupported-codec' },
  },
  // ---------------------------------------------------------------------------
  // Matroska and WebM. The files ffmpeg writes come first; the derived ones, which
  // the rewriter makes from them, come last.
  {
    // Matroska as ffmpeg writes it: the SeekHead, Info, Tracks and Tags first, the Clusters, and the Cues after the last of them.
    name: 'h264-aac.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, ...MATROSKA],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // AC-3 in Matroska (`A_AC3`, with no CodecPrivate: the `dac3` is made from the first frame).
    name: 'h264-ac3.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'ac3', ...MATROSKA],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
  },
  {
    // HEVC (`V_MPEGH/ISO/HEVC` with an `hvcC` for its CodecPrivate) and AAC, 8 bits: the one HEVC file whose sound a browser takes, so that HEVC from Matroska is played, and the file the Dolby Vision ones are made from.
    name: 'hevc-aac.mkv',
    layout: CUES_AFTER,
    streams: ['hevc', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...HEVC, ...AAC, ...MATROSKA],
    expect: 'plays',
    codecs: { video: 'hvc1.1.', audio: 'mp4a.40.2' },
  },
  {
    // HEVC (`V_MPEGH/ISO/HEVC` with an `hvcC` for its CodecPrivate) and AC-3, 8 bits.
    name: 'hevc-ac3.mkv',
    layout: CUES_AFTER,
    streams: ['hevc', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...HEVC, '-c:a', 'ac3', ...MATROSKA],
    expect: 'plays',
  },
  {
    // E-AC-3 in Matroska (`A_EAC3`, the `dec3` made from the first frame).
    name: 'hevc-eac3.mkv',
    layout: CUES_AFTER,
    streams: ['hevc', 'eac3'],
    args: [...picture('1280x720'), ...tone(440), ...HEVC, '-c:a', 'eac3', ...MATROSKA],
    expect: 'plays',
    codecs: { audio: 'ec-3' },
  },
  {
    // AV1 (`V_AV1` with an `av1C`) and Opus (`A_OPUS`, an OpusHead and a CodecDelay).
    name: 'av1-opus.mkv',
    layout: CUES_AFTER,
    streams: ['av1', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libsvtav1',
      '-preset',
      '10',
      '-g',
      '60',
      '-pix_fmt',
      'yuv420p',
      ...OPUS,
      ...MATROSKA,
    ],
    expect: 'plays',
    codecs: { video: 'av01.0.', audio: 'opus' },
  },
  {
    // VP9 and Opus in WebM, which has no CodecPrivate for its picture: the `vpcC` is made from the first keyframe.
    name: 'vp9-opus.webm',
    layout: CUES_AFTER,
    streams: ['vp9', 'opus'],
    args: [...picture('1280x720'), ...tone(440), ...VP9, '-pix_fmt', 'yuv420p', ...OPUS, ...WEBM],
    expect: 'plays',
    codecs: { video: 'vp09.00.', audio: 'opus' },
  },
  {
    // VP9 profile 2, 10 bits, in HDR's colour (PQ, BT.2020), as the MP4 above has it; the Colour element of the track says so.
    name: 'vp9-10bit-pq.webm',
    layout: CUES_AFTER,
    streams: ['vp9', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...VP9,
      '-profile:v',
      '2',
      '-pix_fmt',
      'yuv420p10le',
      '-vf',
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      ...OPUS,
      ...WEBM,
    ],
    expect: 'plays',
    codecs: { video: 'vp09.02.' },
    verify: (path) => {
      const colour = matroskaTracksOf(path).find((track) => track.kind === 'video')?.video?.colour
      if (colour?.primaries !== 9 || colour.transfer !== 16 || colour.matrix !== 9) {
        throw new Error(
          `The Colour element says ${colour?.primaries}, ${colour?.transfer} and ${colour?.matrix}, not 9, 16 and 9 (BT.2020, PQ, BT.2020 non-constant luminance).`,
        )
      }
    },
  },
  {
    // FLAC in Matroska (`A_FLAC`, whose CodecPrivate is `fLaC` and the STREAMINFO block).
    name: 'h264-flac.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'flac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'flac', ...MATROSKA],
    expect: 'plays',
    codecs: { audio: 'flac' },
  },
  {
    // MP3 in Matroska (`A_MPEG/L3`), which the init segment gives the type `mp4a` and an `esds` of MPEG-1 audio.
    name: 'h264-mp3.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'mp3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'libmp3lame', ...MATROSKA],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
  },
  {
    // Apple Lossless in Matroska (`A_ALAC`, whose CodecPrivate is the magic cookie).
    name: 'h264-alac.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'alac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'alac', ...MATROSKA],
    expect: 'plays',
    codecs: { audio: 'alac' },
  },
  {
    // One picture and three sounds (440, 660 and 880 Hz), the second flagged default and the others not: the sound that plays is
    // the second, and the others are there to choose. `verify` reads the flags from the file's own tracks.
    name: 'three-sounds.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'aac', 'aac', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...tone(660),
      ...tone(880),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-map',
      '3:a',
      ...H264,
      ...AAC,
      '-disposition:a:0',
      '0',
      '-disposition:a:1',
      'default',
      '-disposition:a:2',
      '0',
      ...MATROSKA,
    ],
    expect: 'plays',
    verify: (path) => {
      const defaults = matroskaTracksOf(path)
        .filter((track) => track.kind === 'audio')
        .map((track) => track.default)
      if (defaults.join(', ') !== 'false, true, false') {
        throw new Error(
          `The sounds' FlagDefault are ${defaults.join(', ')}, not false, true, false.`,
        )
      }
    },
  },
  {
    // Written as a recording that is still being written: a Segment of unknown size (the Clusters have their sizes), no Duration and no Cues.
    name: 'h264-aac-live.mkv',
    layout: LIVE,
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, '-live', '1', ...MATROSKA],
    expect: 'plays',
  },
  {
    // The Cues in front of the Clusters, after the Tags, as `-cues_to_front 1` (or mkvmerge's default) puts them.
    name: 'h264-aac-cuesfront.mkv',
    layout: CUES_FRONT,
    streams: ['h264', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-cues_to_front',
      '1',
      ...MATROSKA,
    ],
    expect: 'plays',
  },
  {
    // A picture turned a quarter, as the MP4 above: the track's Projection has a ProjectionPoseRoll of 90 degrees, and the picture is still 1280x720.
    name: 'portrait-h264.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'aac'],
    args: [
      '-noautorotate',
      '-display_rotation',
      '90',
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      ...MATROSKA,
    ],
    expect: 'plays',
    verify: (path) => {
      const roll = matroskaTracksOf(path).find((track) => track.kind === 'video')?.video
        ?.rollDegrees
      if (roll !== 90) throw new Error(`The picture's ProjectionPoseRoll is ${roll}, not 90.`)
    },
  },
  {
    // DTS (`A_DTS`), which no browser's Media Source takes: the reader must refuse it.
    name: 'h264-dts.mkv',
    layout: CUES_AFTER,
    streams: ['h264', 'dts'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      '-c:a',
      'dca',
      '-strict',
      '-2',
      ...MATROSKA,
    ],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // VP8 and Vorbis in WebM (`V_VP8`, `A_VORBIS`), which the repackager has no sample entries for: the reader must refuse them.
    name: 'vp8-vorbis.webm',
    layout: CUES_AFTER,
    streams: ['vp8', 'vorbis'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '1M',
      '-g',
      '60',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libvorbis',
      ...WEBM,
    ],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // The AAC frames laced 4 to a block, in Xiph's lacing.
    name: 'h264-aac-xiph.mkv',
    from: 'h264-aac.mkv',
    derive: laced(AAC_ID, 4, 'xiph'),
    layout: REBUILT,
    streams: ['h264', 'aac'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
    verify: sameFramesAs('h264-aac.mkv', LACED_TOLERANCE),
  },
  {
    // The AC-3 frames, which are all of one size, laced 3 to a block in fixed-size lacing.
    name: 'h264-ac3-fixed.mkv',
    from: 'h264-ac3.mkv',
    derive: laced(AC3_ID, 3, 'fixed'),
    layout: REBUILT,
    streams: ['h264', 'ac3'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
    verify: sameFramesAs('h264-ac3.mkv', LACED_TOLERANCE),
  },
  {
    // The MP3 frames laced 4 to a block in EBML lacing.
    name: 'h264-mp3-ebml.mkv',
    from: 'h264-mp3.mkv',
    derive: laced(MP3_ID, 4, 'ebml'),
    layout: REBUILT,
    streams: ['h264', 'mp3'],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
    verify: sameFramesAs('h264-mp3.mkv', LACED_TOLERANCE),
  },
  {
    // `0B 77`, AC-3's sync word, taken off the start of every frame, with a ContentEncoding of header stripping (ContentCompAlgo 3) that says so.
    name: 'h264-ac3-stripped.mkv',
    from: 'h264-ac3.mkv',
    derive: remuxed({ strip: { codec: AC3_ID, prefix: Uint8Array.of(0x0b, 0x77) } }),
    layout: REBUILT,
    streams: ['h264', 'ac3'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
    verify: sameFramesAs('h264-ac3.mkv'),
  },
  {
    // The live file with the size of every Cluster written over as the unknown size, in place and in the same width.
    name: 'h264-aac-unknown.mkv',
    from: 'h264-aac-live.mkv',
    derive: withUnknownClustersFile,
    layout: UNKNOWN,
    streams: ['h264', 'aac'],
    expect: 'plays',
    verify: sameFramesAs('h264-aac-live.mkv'),
  },
  {
    // Dolby Vision profile 8.1 (compatible with HDR10): a BlockAdditionMapping `dvcC` on the picture.
    name: 'hevc-dv8.mkv',
    from: 'hevc-aac.mkv',
    derive: remuxed({ dolbyVision: { profile: 8, compatibility: 1 } }),
    layout: REBUILT,
    streams: ['hevc', 'aac'],
    expect: 'plays',
    verify: allOf(sameFramesAs('hevc-aac.mkv'), dolbyVisionIs(8, 1)),
  },
  {
    // Dolby Vision profile 5 (compatible with nothing): a `dvcC` of profile 5, compatibility 0.
    name: 'hevc-dv5.mkv',
    from: 'hevc-aac.mkv',
    derive: remuxed({ dolbyVision: { profile: 5, compatibility: 0 } }),
    layout: REBUILT,
    streams: ['hevc', 'aac'],
    expect: 'plays',
    verify: allOf(sameFramesAs('hevc-aac.mkv'), dolbyVisionIs(5, 0)),
  },
]

/** The types of the boxes at the top of a file, in order. */
function topLevelTypes(path: string): string {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  const types: string[] = []
  try {
    const header = new Uint8Array(16)
    let at = 0
    while (at + 8 <= size) {
      // What was read is what counts: the bytes of the box before are not this box's.
      header.fill(0)
      const got = readSync(fd, header, 0, 16, at)
      if (got < 8) throw new Error(`A box at ${at} has only ${got} bytes of header.`)
      const view = new DataView(header.buffer)
      let length = view.getUint32(0)
      if (length === 1) {
        if (got < 16)
          throw new Error(`A box at ${at} has a 64-bit size, and only ${got} bytes of header.`)
        length = Number(view.getBigUint64(8))
      }
      if (length === 0) length = size - at
      if (length < 8) throw new Error(`A box at ${at} has a size of ${length}.`)
      const kind = String.fromCharCode(...header.subarray(4, 8))
      if (types.at(-1) !== kind) types.push(kind)
      at += length
    }
  } finally {
    closeSync(fd)
  }
  // A file in fragments has a `moof` and an `mdat` for each: they are said once.
  return types.join(' ').replace(/(moof mdat)( moof mdat)+/, '$1')
}

function run(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${program} failed (${result.status}): ${result.stderr.slice(0, 2000)}`)
  }
  return result.stdout
}

function streamsOf(path: string): string[] {
  const out = run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(out) as { streams: { codec_name?: string }[] }
  return parsed.streams.map((stream) => stream.codec_name ?? 'unknown')
}

/** Checks the layout of a made file against its spec's, and gives it as the log says it. */
function checkLayout(spec: Spec, partial: string): string {
  if (typeof spec.layout === 'string') {
    const layout = topLevelTypes(partial)
    if (layout !== spec.layout) {
      throw new Error(`${spec.name} has the boxes '${layout}', not '${spec.layout}'.`)
    }
    return layout
  }
  const layout = layoutOf(Uint8Array.from(readFileSync(partial)))
  const problem = spec.layout(layout)
  if (problem !== null) {
    throw new Error(`${spec.name} has the layout '${describeLayout(layout)}', and ${problem}.`)
  }
  return describeLayout(layout)
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  mkdirSync(syntheticDir, { recursive: true })
  const entries: ManifestEntry[] = []
  const names = new Set<string>()
  // The files made in this run: a file derived from one of them is made again, for it came from a file that is gone.
  const made = new Set<string>()
  for (const spec of SPECS) {
    // A derived file is made after the file it comes from, which the list must have in front of it.
    if ('from' in spec && !names.has(spec.from)) {
      throw new Error(`${spec.name} is derived from ${spec.from}, which is not made before it.`)
    }
    names.add(spec.name)
    const path = resolve(syntheticDir, spec.name)
    if (existsSync(path) && !force && !('from' in spec && made.has(spec.from))) {
      console.log(`${spec.name}: already made`)
    } else {
      const partial = `${path}.partial`
      rmSync(partial, { force: true })
      let source: string | null = null
      if ('from' in spec) {
        source = resolve(syntheticDir, spec.from)
        if (!existsSync(source))
          throw new Error(`${spec.name} is derived from ${source}, which is not there.`)
        spec.derive(source, partial)
      } else {
        // `-t` is an output option, and is after the codecs so that it applies to the one output.
        run('ffmpeg', [
          '-y',
          '-hide_banner',
          '-v',
          'error',
          ...spec.args,
          '-t',
          String(SECONDS),
          partial,
        ])
      }
      spec.patch?.(partial)
      // It is checked before it has its name, so that a file with the name is always one that was.
      const started = streamsOf(partial)
      if (started.join(',') !== spec.streams.join(',')) {
        throw new Error(
          `${spec.name} has the streams ${started.join(', ')}, not ${spec.streams.join(', ')}.`,
        )
      }
      if (source !== null && streamsOf(source).join(',') !== started.join(',')) {
        throw new Error(`${spec.name} has the streams ${started.join(', ')}, not its source's.`)
      }
      const layout = checkLayout(spec, partial)
      spec.verify?.(partial)
      renameSync(partial, path)
      made.add(spec.name)
      console.log(`${spec.name}: made (${layout}; ${started.join(', ')})`)
    }
    entries.push({
      path,
      expect: spec.expect,
      ...(spec.codecs ? { codecs: spec.codecs } : {}),
    })
  }
  await writeManifest(mergeEntries(readManifest(), entries, true))
  console.log(`Manifest names ${entries.length} synthetic files.`)
}

await main()

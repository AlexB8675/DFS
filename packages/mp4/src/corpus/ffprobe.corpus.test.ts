import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chooseTracks, fragment, initSegment, Mp4Error } from '../index.ts'
import type { FrameTable, Mp4Refusal, PlayTrack } from '../index.ts'
import {
  containerOf,
  isSynthetic,
  loadManifest,
  readIndex,
  readRange,
  uniqueTitles,
} from '../testing/corpus.ts'
import type { ManifestEntry } from '../testing/corpus.ts'
import { Differences, firstShown, rotationIn, rotationOf, turn } from '../testing/compare.ts'
import { configProblems, writtenEntry } from '../testing/entries.ts'
import {
  decodes,
  iamfPacketSize,
  probe,
  probeEditedPackets,
  probePackets,
  probeStreams,
  streamStart,
} from '../testing/ffprobe.ts'
import type { ProbePacket, ProbeStream } from '../testing/ffprobe.ts'

// The reader and the writer, checked against ffprobe on the corpus (DESIGN.md
// §10.4, D45): the synthetic files `corpus:make` made and the user's own videos,
// which are read where they are. For each file expected to play, the sample
// tables of the picture and of the sound are compared frame by frame with
// FFmpeg's reading of the same file (offset, size, decode and presentation times
// in the stream's ticks, keyframes); so are the codec (against ffprobe's name,
// profile and own string), the rotation and the time scale; and so are the
// times with the edit list applied, which is what `offsetSeconds` has to get
// right: the start of each track, and its first frames (up to 300, from the first
// 5 s), within a tick. For each synthetic file the writer's output for the first
// 10 s is read back by ffprobe and decoded by ffmpeg (`-v error -xerror`, with
// nothing said), which proves the init segment of a codec that no browser here
// plays, and its sample entry holds the source's codec configuration box byte
// for byte, which the decode does not prove (ffmpeg's decoders for AAC and AC-3
// take what they need from the frames); and a file expected to be refused gives
// that reason. The codec is compared with ffprobe's name for it, any of the
// track's names for `mime_codec_string`; an IAMF sound by the codec inside it,
// with its packets the payload of the OBUs that its samples are. Run with
// `pnpm --filter @dfs/mp4 test:corpus`.

/** A file this large (500 MB) is compared by windows and not whole. */
const WHOLE_FILE_LIMIT = 500 * 1024 * 1024

// This suite takes the MP4 files: a Matroska file is for the Matroska suite. A file that is neither is left here, to be turned away as it always was.
const entries = loadManifest().filter((entry) => containerOf(entry.path) !== 'matroska')

// What the run compared, said once at the end.
const totals = { files: 0, refused: 0, windowed: 0, frames: 0, written: 0, noStart: 0 }

/** The size that ffprobe lists for frame `i`. */
type PacketSize = (i: number) => number | undefined

/**
 * The size that ffprobe lists for each frame of a track, read from the bytes
 * that `sample` gives. It is the frame's own, except in an IAMF sound: FFmpeg
 * lists the codec's packet, which it takes out of the OBU that the sample is
 * (`iamfPacketSize`), and -1 where the sample is no such OBU.
 */
function listedSizes(
  track: PlayTrack,
  sample: (offset: number, length: number) => Uint8Array,
): PacketSize {
  const { table } = track
  if (track.header.entries[0]?.type !== 'iamf') return (i) => table.sizes[i]
  return (i) => iamfPacketSize(sample(table.offsets[i] ?? 0, table.sizes[i] ?? 0)) ?? -1
}

/** Frame `i` of the table against a packet of ffprobe: `pos` (when `withPos`), `size` (as `listed` says), `dts`, `pts` and the keyframe flag, all in the stream's ticks. */
function compareFrame(
  found: Differences,
  table: FrameTable,
  i: number,
  packet: ProbePacket,
  withPos: boolean,
  listed: PacketSize,
): void {
  if (withPos) found.note('pos', i, table.offsets[i], Number(packet.pos))
  found.note('size', i, listed(i), Number(packet.size))
  found.note('dts', i, table.dts[i], packet.dts)
  found.note('pts', i, (table.dts[i] ?? 0) + (table.cts[i] ?? 0), packet.pts)
  found.note('keyframe', i, table.sync[i] === 1, packet.flags?.includes('K') ?? false)
}

/** Every frame of a track against every packet of ffprobe's list, in order. */
function compareWhole(
  label: string,
  table: FrameTable,
  packets: ProbePacket[],
  listed: PacketSize,
): string[] {
  const problems: string[] = []
  if (packets.length !== table.count) {
    problems.push(`${label}: ${table.count} frames, but ffprobe lists ${packets.length} packets`)
  }
  const found = new Differences()
  for (let i = 0; i < Math.min(table.count, packets.length); i += 1) {
    compareFrame(found, table, i, packets[i] ?? {}, true, listed)
  }
  return [...problems, ...found.report(label)]
}

/** The packets of a few windows of a large file, each matched to its frame by `pos`; how many are matched is returned. */
function compareWindows(
  label: string,
  table: FrameTable,
  packets: ProbePacket[],
  listed: PacketSize,
): { problems: string[]; matched: number } {
  const byOffset = new Map<number, number>()
  for (let i = table.count - 1; i >= 0; i -= 1) byOffset.set(table.offsets[i] ?? 0, i)
  const problems: string[] = []
  const found = new Differences()
  let matched = 0
  let unknown = 0
  for (const packet of packets) {
    const i = byOffset.get(Number(packet.pos))
    if (i === undefined) {
      unknown += 1
      if (unknown === 1)
        problems.push(`${label}: ffprobe has a packet at ${packet.pos}, which is no frame of ours`)
      continue
    }
    matched += 1
    compareFrame(found, table, i, packet, false, listed)
  }
  if (unknown > 1) problems.push(`${label}: ${unknown} packets of ffprobe are at no frame of ours`)
  // A window that matched nothing proves nothing.
  if (matched < Math.min(table.count, 300)) {
    problems.push(
      `${label}: only ${matched} of ffprobe's ${packets.length} packets were matched to frames`,
    )
  }
  return { problems: [...problems, ...found.report(label)], matched }
}

/** How many packets of each track are compared in the edited timeline. */
const EDITED_PACKETS = 300

/**
 * The first packets of a track with its edit list applied, against its frames
 * shifted by `offsetSeconds`: the offset the player gives its SourceBuffer has to
 * put every frame where FFmpeg puts it, within a tick (ffprobe rounds each time
 * to a whole tick, as the offset need not be one). The packets are matched to
 * frames by `pos`, over all the track's frames: the first packets of a file whose
 * sound is stored apart from its picture are not the first frames' bytes.
 */
function compareEdited(label: string, track: PlayTrack, packets: ProbePacket[]): string[] {
  const { table, timing } = track
  const byOffset = new Map<number, number>()
  for (let i = table.count - 1; i >= 0; i -= 1) byOffset.set(table.offsets[i] ?? 0, i)
  const shift = timing.offsetSeconds * table.timescale
  const found = new Differences()
  let matched = 0
  for (const packet of packets) {
    const i = byOffset.get(Number(packet.pos))
    if (i === undefined) continue
    matched += 1
    found.noteNear(
      'edited pts',
      i,
      (table.dts[i] ?? 0) + (table.cts[i] ?? 0) + shift,
      packet.pts,
      1,
    )
  }
  const problems = found.report(label)
  if (matched < Math.min(table.count, 50)) {
    problems.push(
      `${label}: only ${matched} of ffprobe's ${packets.length} edited packets were matched to frames`,
    )
  }
  return problems
}

/** The windows of a large file, in `-read_intervals` terms: its first 600 packets, 300 from the middle, 300 from near the end. */
function windowsOf(durationSeconds: number): string {
  const middle = Math.floor(durationSeconds / 2)
  const end = Math.max(0, Math.floor(durationSeconds) - 10)
  return `%+#600,${middle}%+#300,${end}%+#300`
}

const AVC_PROFILES: Record<string, number> = {
  Baseline: 0x42,
  'Constrained Baseline': 0x42,
  Main: 0x4d,
  Extended: 0x58,
  High: 0x64,
  'Constrained High': 0x64,
  'Progressive High': 0x64,
  'High 10': 0x6e,
  'High 10 Intra': 0x6e,
  'High 4:2:2': 0x7a,
  'High 4:2:2 Intra': 0x7a,
  'High 4:4:4 Predictive': 0xf4,
  'High 4:4:4 Intra': 0xf4,
}
const HEVC_PROFILES: Record<string, number> = {
  Main: 1,
  'Main 10': 2,
  'Main Still Picture': 3,
  Rext: 4,
}
const AV1_PROFILES: Record<string, number> = { Main: 0, High: 1, Professional: 2 }
const AAC_PROFILES: Record<string, number> = {
  Main: 1,
  LC: 2,
  SSR: 3,
  LTP: 4,
  'HE-AAC': 5,
  LD: 23,
  'HE-AACv2': 29,
  ELD: 39,
}

/**
 * What the codec string must start with, from ffprobe's codec name, tag and
 * profile: `avc1.64` for High, `hvc1.2.` or `hev1.2.` for Main 10, `av01.0.`,
 * `vp09.02` for VP9's profile 2, `mp4a.40.2`, `mp4a.6B` for MP3, `opus`, `flac`,
 * `ac-3`, `ec-3`, `alac`. Null when ffprobe names a codec that the player does
 * not take (then the track should have been refused), and the profile's part is
 * left off when ffprobe names a profile that this table doesn't know.
 */
function codecPrefix(stream: ProbeStream): string | null {
  const tag = stream.codec_tag_string ?? ''
  const profile = stream.profile ?? ''
  switch (stream.codec_name) {
    case 'h264': {
      const idc = AVC_PROFILES[profile]
      return `${tag}.${idc === undefined ? '' : idc.toString(16).padStart(2, '0')}`
    }
    case 'hevc': {
      const idc = HEVC_PROFILES[profile]
      return idc === undefined ? `${tag}.` : `${tag}.${idc}.`
    }
    case 'av1': {
      const idc = AV1_PROFILES[profile]
      return idc === undefined ? 'av01.' : `av01.${idc}.`
    }
    case 'aac': {
      const type = AAC_PROFILES[profile]
      return type === undefined ? 'mp4a.40.' : `mp4a.40.${type}`
    }
    case 'vp9': {
      const idc = /^Profile (\d)$/.exec(profile)?.[1]
      return idc === undefined ? 'vp09.' : `vp09.0${idc}`
    }
    case 'opus':
      return 'opus'
    case 'flac':
      return 'flac'
    case 'ac3':
      return 'ac-3'
    case 'eac3':
      return 'ec-3'
    case 'alac':
      return 'alac'
    case 'mp3':
      return 'mp4a.6B'
    default:
      return null
  }
}

/** IAMF's name for a codec inside it (`iamf.000.000.Opus`), as the codec's own RFC 6381 string, which is what FFmpeg names the stream by. */
const IAMF_INNER: Record<string, string> = { Opus: 'opus', fLaC: 'flac' }

/** What FFmpeg has no tag for in a stream: it gives an IAMF sound the tag of 0, because the stream is the codec inside it. */
const NO_TAG = '[0][0][0][0]'

/**
 * The names of a track that ffprobe's reading is compared with. `first` is the
 * track's own codec string, which the profile's prefix is matched against;
 * `all` is every name the track has, which ffprobe's `mime_codec_string` may be
 * any of (VP9's short form, MP3's `mp4a.40.34`, MPEG-2 AAC's `mp4a.40.N`, which
 * is its only name). An IAMF sound is named by the codec
 * inside it: that is what FFmpeg reads as the stream's codec. No name at all
 * when its string is not `iamf.PPP.AAA.<codec>`.
 */
function namesToCompare(track: PlayTrack, iamf: boolean): { first: string[]; all: string[] } {
  if (iamf) {
    const inner = /^iamf\.\d{3}\.\d{3}\.(.+)$/.exec(track.codec)?.[1]
    const names = inner === undefined ? [] : [IAMF_INNER[inner] ?? inner]
    return { first: names, all: names }
  }
  return { first: [track.codec], all: [...track.codecNames] }
}

/** The track against ffprobe's reading of its stream (edit lists applied): its codec, rotation, time base and where it starts. */
function compareStream(
  label: string,
  track: PlayTrack,
  stream: ProbeStream | undefined,
  wanted: string | undefined,
): string[] {
  if (!stream) return [`${label}: ffprobe has no such stream`]
  const problems: string[] = []

  const entryType = track.header.entries[0]?.type
  const iamf = entryType === 'iamf'
  const names = namesToCompare(track, iamf)
  if (iamf && names.first.length === 0) {
    problems.push(`${label}: codec string ${track.codec} is not iamf.PPP.AAA.<codec>`)
  }
  const prefix = codecPrefix(stream)
  if (prefix === null) {
    problems.push(
      `${label}: ffprobe says ${stream.codec_name ?? 'nothing'}, which the player doesn't take, but the track was accepted (codec ${track.codec})`,
    )
  } else if (!names.first.some((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))) {
    problems.push(
      `${label}: codec string ${track.codec} doesn't start with ${prefix} (ffprobe: ${stream.codec_name}, ${stream.profile})`,
    )
  }
  // FFmpeg's own RFC 6381 string, where it makes one (not for every codec): any of the track's names, to the character.
  if (stream.mime_codec_string !== undefined && !names.all.includes(stream.mime_codec_string)) {
    problems.push(
      `${label}: codec names ${track.codecNames.join(', ')}, ffprobe's mime_codec_string ${stream.mime_codec_string}`,
    )
  }
  if (wanted !== undefined && !track.codec.startsWith(wanted)) {
    problems.push(
      `${label}: codec string ${track.codec} doesn't start with ${wanted}, as the manifest says`,
    )
  }
  if (entryType !== stream.codec_tag_string && !(iamf && stream.codec_tag_string === NO_TAG)) {
    problems.push(`${label}: sample entry ${entryType}, ffprobe's tag ${stream.codec_tag_string}`)
  }

  if (stream.time_base !== `1/${track.header.timescale}`) {
    problems.push(
      `${label}: time scale ${track.header.timescale}, ffprobe's time base ${stream.time_base}`,
    )
  }
  if (track.header.kind === 'video') {
    const ours = rotationOf(track.header.matrix)
    const theirs = rotationIn(stream)
    if (Math.abs(turn(ours, theirs)) > 0.5) {
      problems.push(`${label}: rotation ${ours} degrees, ffprobe's ${theirs}`)
    }
  }

  // Where it starts: the first presentation time with the offset applied, within a tick. A stream that ffprobe gives no start for (it prints N/A) has nothing to be compared with: that is said once, and counted.
  const start = streamStart(stream)
  if (start === null) {
    totals.noStart += 1
    if (totals.noStart === 1) {
      console.warn(
        'ffprobe gives no start time for some streams: where those start is not compared (the count is in the totals line).',
      )
    }
    return problems
  }
  const ours = firstShown(track)
  const tick = 1 / track.table.timescale
  if (!(Math.abs(ours - start) <= tick + 1e-6)) {
    problems.push(
      `${label}: first shown at ${ours} s (offset ${track.timing.offsetSeconds} s), ffprobe's start_time ${start} s (${stream.start_time})`,
    )
  }
  return problems
}

/** The reason a file is turned away, or null when it is taken. */
function refusalOf(path: string, size: number): { reason: Mp4Refusal; message: string } | null {
  try {
    chooseTracks(readIndex(path, size), size)
    return null
  } catch (error) {
    if (error instanceof Mp4Error) return { reason: error.reason, message: error.message }
    throw error
  }
}

async function checkPlays(entry: ManifestEntry): Promise<void> {
  const size = statSync(entry.path).size
  const refused = refusalOf(entry.path, size)
  expect(refused, `refused (${refused?.reason}): ${refused?.message}`).toBeNull()
  const movie = readIndex(entry.path, size)
  const { video, audio } = chooseTracks(movie, size)

  const windowed = size >= WHOLE_FILE_LIMIT
  const intervals = windowed ? windowsOf(movie.durationTicks / movie.timescale) : undefined
  const streams = await probeStreams(entry.path)
  const problems: string[] = []
  let frames = 0
  for (const [name, track, select, wanted] of [
    ['picture', video, 'v:0', entry.codecs?.video],
    ['sound', audio, 'a:0', entry.codecs?.audio],
  ] as const) {
    if (!track) {
      // No sound is fine, unless ffprobe finds one.
      if (streams.some((stream) => stream.codec_type === 'audio')) {
        problems.push(`sound: ours is none, but ffprobe has an audio stream`)
      }
      continue
    }
    const stream = streams.find((s) => s.codec_type === (name === 'picture' ? 'video' : 'audio'))
    problems.push(...compareStream(name, track, stream, wanted))
    problems.push(
      ...compareEdited(name, track, await probeEditedPackets(entry.path, select, EDITED_PACKETS)),
    )
    const packets = await probePackets(entry.path, select, intervals)
    const listed = listedSizes(track, (offset, length) => readRange(entry.path, offset, length))
    if (windowed) {
      const result = compareWindows(name, track.table, packets, listed)
      problems.push(...result.problems)
      frames += result.matched
    } else {
      problems.push(...compareWhole(name, track.table, packets, listed))
      frames += track.table.count
    }
  }
  totals.files += 1
  totals.windowed += windowed ? 1 : 0
  totals.frames += frames
  expect(problems).toEqual([])
}

function checkRefused(entry: ManifestEntry, reason: Mp4Refusal): void {
  const refused = refusalOf(entry.path, statSync(entry.path).size)
  expect(refused?.reason).toBe(reason)
  expect(refused?.message).not.toBe('')
  totals.refused += 1
}

afterAll(() => {
  if (entries.length === 0) return
  console.log(
    `Corpus: ${totals.files} files compared (${totals.windowed} by windows), ${totals.frames} frames, ${totals.refused} refusals checked, ${totals.written} written tracks read back and decoded, ${totals.noStart} streams with no start time from ffprobe.`,
  )
})

describe('the corpus against ffprobe', () => {
  if (entries.length === 0) {
    it.skip('has no manifest: run `pnpm --filter @dfs/mp4 corpus:make` first', () => {
      // Nothing to run: this only says why.
    })
    return
  }

  // Two folders can hold files of one name: a title is the folder's name and the file's, and is told apart if it still repeats.
  const titles = uniqueTitles(entries.map((entry) => entry.path))
  it.each(entries.map((entry, i) => [titles[i] ?? entry.path, entry] as const))(
    '%s',
    async (_title, entry) => {
      if (entry.expect === 'plays') await checkPlays(entry)
      else checkRefused(entry, entry.expect.refused)
    },
  )
})

// ---- The writer ----

/** The ranges of frames [from, to) that make up the first `limit` seconds in fragments of at least `length` seconds: a picture's start at keyframes. */
function fragmentRanges(track: PlayTrack, length: number, limit: number): [number, number][] {
  const { table, keyframes, header } = track
  const picture = header.kind === 'video'
  const ranges: [number, number][] = []
  let from = 0
  while (from < table.count && (table.dts[from] ?? 0) < limit * table.timescale) {
    const boundary = (table.dts[from] ?? 0) + length * table.timescale
    let to = from + 1
    if (picture) {
      const next = keyframes.find((k) => k > from && (table.dts[k] ?? 0) >= boundary)
      to = next ?? table.count
    } else {
      while (to < table.count && (table.dts[to] ?? 0) < boundary) to += 1
    }
    ranges.push([from, to])
    from = to
  }
  return ranges
}

/**
 * What the writer makes of the first 10 s of a track, against the source's
 * frames and its entry: the entry the init segment holds carries the source's
 * codec configuration box byte for byte, and the output is decoded by ffmpeg and
 * read back by ffprobe. `title` is the file's, for the problems.
 */
async function checkWritten(
  title: string,
  name: string,
  track: PlayTrack,
  bytes: Uint8Array,
  source: ProbeStream | undefined,
  folder: string,
): Promise<string[]> {
  const ranges = fragmentRanges(track, 2, 10)
  const last = ranges.at(-1)
  if (!last) return [`${name}: no fragments to write`]
  const init = initSegment(track)
  const parts = [init]
  ranges.forEach(([from, to], k) => {
    parts.push(
      fragment(track, from, to, k + 1, (offset, length) => bytes.subarray(offset, offset + length)),
    )
  })
  const out = resolve(folder, `${name}.mp4`)
  writeFileSync(out, Buffer.concat(parts))
  // The entry that was written, read back from the init segment, holds the source's configuration box as it was. FFmpeg's decode below does not show it: its decoders for AAC and for AC-3 take what they need from the frames, and Safari's may need the box.
  const sourceEntry = track.header.entries[0]
  if (!sourceEntry) return [`${title}: ${name}: the track has no sample description`]
  const problems = configProblems(
    sourceEntry,
    writtenEntry(init),
    track.header.kind === 'video',
  ).map((problem) => `${title}: ${name}: ${problem}`)
  // Decoded back by FFmpeg, with nothing said: no browser here plays every codec, and a decoder that starts from the init segment's entry shows that the entry says what it needs. Nothing more is asked of an output that does not decode: ffprobe may not even read it.
  const undecoded = await decodes(out)
  if (undecoded !== null) {
    return [...problems, `${name}: the output does not decode: ${undecoded}`]
  }
  const packets =
    (
      (await probe(out, ['-show_entries', 'packet=size,pts,dts,flags'], false)) as {
        packets?: ProbePacket[]
      }
    ).packets ?? []
  const [written] = await probeStreams(out, false)
  const count = last[1]
  if (packets.length !== count) {
    problems.push(`${name}: wrote ${count} frames, ffprobe reads ${packets.length} from the output`)
  }
  const found = new Differences()
  const listed = listedSizes(track, (offset, length) => bytes.subarray(offset, offset + length))
  for (let i = 0; i < Math.min(count, packets.length); i += 1) {
    compareFrame(found, track.table, i, packets[i] ?? {}, false, listed)
  }
  problems.push(...found.report(`${name} written`))

  if (!written || !source) return [...problems, `${name}: no stream to compare in the output`]
  if (written.codec_name !== source.codec_name) {
    problems.push(`${name}: written as ${written.codec_name}, from ${source.codec_name}`)
  }
  // The tag is the source's, unless the init entry has another type than the source's: QuickTime's `.mp3` is written as `mp4a`.
  const writtenType = String.fromCharCode(...track.entry.subarray(4, 8))
  const wantedTag =
    writtenType === track.header.entries[0]?.type ? source.codec_tag_string : writtenType
  if (written.codec_tag_string !== wantedTag) {
    problems.push(
      `${name}: written with the tag ${written.codec_tag_string}, from ${source.codec_tag_string} (the init entry is a '${writtenType}')`,
    )
  }
  if (track.header.kind === 'video') {
    if (written.width !== source.width || written.height !== source.height) {
      problems.push(
        `${name}: written at ${written.width}x${written.height}, from ${source.width}x${source.height}`,
      )
    }
    if (Math.abs(turn(rotationIn(written), rotationIn(source))) > 0.5) {
      problems.push(
        `${name}: written with a rotation of ${rotationIn(written)}, from ${rotationIn(source)}`,
      )
    }
  } else if (written.channels !== source.channels || written.sample_rate !== source.sample_rate) {
    problems.push(
      `${name}: written as ${written.channels} channels at ${written.sample_rate} Hz, from ${source.channels} at ${source.sample_rate}`,
    )
  }
  totals.written += 1
  return problems
}

const synthetic = entries.filter((entry) => entry.expect === 'plays' && isSynthetic(entry.path))

describe('the writer against ffprobe, on the synthetic files', () => {
  if (synthetic.length === 0) {
    it.skip('has no synthetic files', () => {
      // Nothing to run: this only says why.
    })
    return
  }
  const titles = uniqueTitles(synthetic.map((entry) => entry.path))
  it.each(synthetic.map((entry, i) => [titles[i] ?? entry.path, entry] as const))(
    '%s',
    async (title, entry) => {
      const size = statSync(entry.path).size
      const { video, audio } = chooseTracks(readIndex(entry.path, size), size)
      const bytes = readFileSync(entry.path)
      const streams = await probeStreams(entry.path)
      const folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-corpus-'))
      try {
        const problems = await checkWritten(
          title,
          'picture',
          video,
          bytes,
          streams.find((s) => s.codec_type === 'video'),
          folder,
        )
        if (audio) {
          problems.push(
            ...(await checkWritten(
              title,
              'sound',
              audio,
              bytes,
              streams.find((s) => s.codec_type === 'audio'),
              folder,
            )),
          )
        }
        expect(problems).toEqual([])
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
  )
})

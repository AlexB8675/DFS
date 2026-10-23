import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chooseTracks, fragment, initSegment, Mp4Error, presentationSeconds } from '../index.ts'
import type { FrameTable, Mp4Refusal, PlayTrack } from '../index.ts'
import { loadManifest, readIndex, syntheticDir } from '../testing/corpus.ts'
import type { ManifestEntry } from '../testing/corpus.ts'
import { probe, probeEditedPackets, probePackets, probeStreams } from '../testing/ffprobe.ts'
import type { ProbePacket, ProbeStream } from '../testing/ffprobe.ts'

// The reader and the writer, checked against ffprobe on the corpus (DESIGN.md
// §10.4, D45): the synthetic files `corpus:make` made and the user's own videos,
// which are read where they are. For each file expected to play, the sample
// tables of the picture and of the sound are compared frame by frame with
// FFmpeg's reading of the same file (offset, size, decode and presentation times
// in the stream's ticks, keyframes); so are the codec (against ffprobe's name,
// profile and own string), the rotation and the time scale; and so are the
// times with the edit list applied, which is what `offsetSeconds` has to get
// right: the start of each track, and the first 300 frames, within a tick. For each synthetic file the writer's output for
// the first 10 s is read back by ffprobe, and a file expected to be refused gives
// that reason. Run with `pnpm --filter @dfs/mp4 test:corpus`.

/** A file this large (500 MB) is compared by windows and not whole. */
const WHOLE_FILE_LIMIT = 500 * 1024 * 1024

const entries = loadManifest()

// What the run compared, said once at the end.
const totals = { files: 0, refused: 0, windowed: 0, frames: 0, written: 0 }

/** A description of a difference that is too long for a line is cut. */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

interface Difference {
  count: number
  frame: number
  ours: unknown
  theirs: unknown
}

/** The differences between a track's frames and the packets ffprobe lists, per field: how many, and the first. */
class Differences {
  readonly byField = new Map<string, Difference>()

  note(field: string, frame: number, ours: unknown, theirs: unknown): void {
    if (ours === theirs) return
    this.record(field, frame, ours, theirs)
  }

  /** The same for numbers that are the same when they are within `tolerance`. */
  noteNear(
    field: string,
    frame: number,
    ours: number,
    theirs: number | undefined,
    tolerance: number,
  ): void {
    if (theirs !== undefined && Math.abs(ours - theirs) <= tolerance) return
    this.record(field, frame, ours, theirs)
  }

  private record(field: string, frame: number, ours: unknown, theirs: unknown): void {
    const seen = this.byField.get(field)
    if (seen) seen.count += 1
    else this.byField.set(field, { count: 1, frame, ours, theirs })
  }

  /** One line for each field that differs, naming the first frame that does. */
  report(label: string): string[] {
    return [...this.byField].map(
      ([field, { count, frame, ours, theirs }]) =>
        `${label}: ${field} differs in ${count} frames, first at frame ${frame}: ours ${shown(ours)}, ffprobe ${shown(theirs)}`,
    )
  }
}

/** Frame `i` of the table against a packet of ffprobe: `pos` (when `withPos`), `size`, `dts`, `pts` and the keyframe flag, all in the stream's ticks. */
function compareFrame(
  found: Differences,
  table: FrameTable,
  i: number,
  packet: ProbePacket,
  withPos: boolean,
): void {
  if (withPos) found.note('pos', i, table.offsets[i], Number(packet.pos))
  found.note('size', i, table.sizes[i], Number(packet.size))
  found.note('dts', i, table.dts[i], packet.dts)
  found.note('pts', i, (table.dts[i] ?? 0) + (table.cts[i] ?? 0), packet.pts)
  found.note('keyframe', i, table.sync[i] === 1, packet.flags?.includes('K') ?? false)
}

/** Every frame of a track against every packet of ffprobe's list, in order. */
function compareWhole(label: string, table: FrameTable, packets: ProbePacket[]): string[] {
  const problems: string[] = []
  if (packets.length !== table.count) {
    problems.push(`${label}: ${table.count} frames, but ffprobe lists ${packets.length} packets`)
  }
  const found = new Differences()
  for (let i = 0; i < Math.min(table.count, packets.length); i += 1) {
    compareFrame(found, table, i, packets[i] ?? {}, true)
  }
  return [...problems, ...found.report(label)]
}

/** The packets of a few windows of a large file, each matched to its frame by `pos`; how many are matched is returned. */
function compareWindows(
  label: string,
  table: FrameTable,
  packets: ProbePacket[],
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
    compareFrame(found, table, i, packet, false)
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
 * shifted by `offsetSeconds`: the offset the
 * player gives its SourceBuffer has to put every frame where FFmpeg puts it,
 * within a tick (ffprobe rounds each time to a whole tick, as the offset need
 * not be one). The packets are matched to frames by `pos`.
 */
function compareEdited(label: string, track: PlayTrack, packets: ProbePacket[]): string[] {
  const { table, timing } = track
  const byOffset = new Map<number, number>()
  for (let i = Math.min(table.count, EDITED_PACKETS * 10) - 1; i >= 0; i -= 1) {
    byOffset.set(table.offsets[i] ?? 0, i)
  }
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

/** `n/d` (a time base) as the ticks' length in seconds. */
function seconds(timeBase: string | undefined): number {
  const [n, d] = (timeBase ?? '').split('/').map(Number)
  return (n ?? Number.NaN) / (d ?? Number.NaN)
}

/**
 * The first moment at which a track shows anything, in seconds of the movie
 * with the edit list applied. A SourceBuffer's timeline starts at 0: a frame that
 * ends by then is dropped and one that crosses it is cut, which is how FFmpeg
 * trims an encoder's priming (an AAC sound's first 1024 samples, an Opus
 * sound's pre-skip) when it reports where a stream starts. So this is the least
 * presentation time among the frames that end after 0, and not before 0.
 */
function firstShown(track: PlayTrack): number {
  const { table, timing } = track
  let first = Infinity
  for (let i = 0; i < table.count; i += 1) {
    const begins = presentationSeconds(table, timing, i)
    const ends = begins + (table.durations[i] ?? 0) / table.timescale
    if (ends > 1e-9) first = Math.min(first, begins)
  }
  return Math.max(first, 0)
}

/** The display rotation a `tkhd` matrix says, in degrees counter-clockwise, as FFmpeg's `av_display_rotation_get` reads it. */
function rotationOf(matrix: Uint8Array): number {
  const view = new DataView(matrix.buffer, matrix.byteOffset, matrix.byteLength)
  const m = Array.from({ length: 9 }, (_, k) => view.getInt32(k * 4))
  const across = Math.hypot(m[0] ?? 0, m[3] ?? 0)
  const down = Math.hypot(m[1] ?? 0, m[4] ?? 0)
  if (across === 0 || down === 0) return 0
  return -Math.atan2((m[1] ?? 0) / down, (m[0] ?? 0) / across) * (180 / Math.PI)
}

function rotationIn(stream: ProbeStream): number {
  const matrix = stream.side_data_list?.find((data) => data.side_data_type === 'Display Matrix')
  return matrix?.rotation ?? 0
}

/** The difference of two angles, in degrees, from -180 to 180. */
function turn(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180
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
 * `mp4a.40.2`, `opus`. Null when ffprobe names a codec that the player does not
 * take (then the track should have been refused), and the profile's part is
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
    case 'opus':
      return 'opus'
    default:
      return null
  }
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

  const prefix = codecPrefix(stream)
  if (prefix === null) {
    problems.push(
      `${label}: ffprobe says ${stream.codec_name ?? 'nothing'}, which the player doesn't take, but the track was accepted (codec ${track.codec})`,
    )
  } else if (!track.codec.toLowerCase().startsWith(prefix.toLowerCase())) {
    problems.push(
      `${label}: codec string ${track.codec} doesn't start with ${prefix} (ffprobe: ${stream.codec_name}, ${stream.profile})`,
    )
  }
  // FFmpeg's own RFC 6381 string, where it makes one (not for every codec): the same, to the character.
  if (stream.mime_codec_string !== undefined && stream.mime_codec_string !== track.codec) {
    problems.push(
      `${label}: codec string ${track.codec}, ffprobe's mime_codec_string ${stream.mime_codec_string}`,
    )
  }
  if (wanted !== undefined && !track.codec.startsWith(wanted)) {
    problems.push(
      `${label}: codec string ${track.codec} doesn't start with ${wanted}, as the manifest says`,
    )
  }
  const entryType = track.header.entries[0]?.type
  if (entryType !== stream.codec_tag_string) {
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

  // Where it starts: the first presentation time with the offset applied, within a tick.
  const start =
    stream.start_pts === undefined
      ? Number(stream.start_time)
      : stream.start_pts * seconds(stream.time_base)
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
    chooseTracks(readIndex(path, size))
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
  const { video, audio } = chooseTracks(movie)

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
    if (windowed) {
      const result = compareWindows(name, track.table, packets)
      problems.push(...result.problems)
      frames += result.matched
    } else {
      problems.push(...compareWhole(name, track.table, packets))
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
    `Corpus: ${totals.files} files compared (${totals.windowed} by windows), ${totals.frames} frames, ${totals.refused} refusals checked, ${totals.written} written tracks read back.`,
  )
})

describe('the corpus against ffprobe', () => {
  if (entries.length === 0) {
    it.skip('has no manifest: run `pnpm --filter @dfs/mp4 corpus:make` first', () => {
      // Nothing to run: this only says why.
    })
    return
  }

  it.each(entries.map((entry) => [basename(entry.path), entry] as const))(
    '%s',
    async (_name, entry) => {
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

/** What the writer makes of the first 10 s of a track, read back by ffprobe, against the source's frames. */
async function checkWritten(
  name: string,
  track: PlayTrack,
  bytes: Uint8Array,
  source: ProbeStream | undefined,
  folder: string,
): Promise<string[]> {
  const ranges = fragmentRanges(track, 2, 10)
  const last = ranges.at(-1)
  if (!last) return [`${name}: no fragments to write`]
  const parts = [initSegment(track)]
  ranges.forEach(([from, to], k) => {
    parts.push(
      fragment(track, from, to, k + 1, (offset, length) => bytes.subarray(offset, offset + length)),
    )
  })
  const out = resolve(folder, `${name}.mp4`)
  writeFileSync(out, Buffer.concat(parts))

  const packets =
    (
      (await probe(out, ['-show_entries', 'packet=size,pts,dts,flags'], false)) as {
        packets?: ProbePacket[]
      }
    ).packets ?? []
  const [written] = await probeStreams(out, false)
  const problems: string[] = []
  const count = last[1]
  if (packets.length !== count) {
    problems.push(`${name}: wrote ${count} frames, ffprobe reads ${packets.length} from the output`)
  }
  const found = new Differences()
  for (let i = 0; i < Math.min(count, packets.length); i += 1) {
    compareFrame(found, track.table, i, packets[i] ?? {}, false)
  }
  problems.push(...found.report(`${name} written`))

  if (!written || !source) return [...problems, `${name}: no stream to compare in the output`]
  if (written.codec_name !== source.codec_name) {
    problems.push(`${name}: written as ${written.codec_name}, from ${source.codec_name}`)
  }
  if (written.codec_tag_string !== source.codec_tag_string) {
    problems.push(
      `${name}: written with the tag ${written.codec_tag_string}, from ${source.codec_tag_string}`,
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

const synthetic = entries.filter(
  (entry) => entry.expect === 'plays' && entry.path.startsWith(syntheticDir.replaceAll('\\', '/')),
)

describe('the writer against ffprobe, on the synthetic files', () => {
  if (synthetic.length === 0) {
    it.skip('has no synthetic files', () => {
      // Nothing to run: this only says why.
    })
    return
  }
  it.each(synthetic.map((entry) => [basename(entry.path), entry] as const))(
    '%s',
    async (_name, entry) => {
      const { video, audio } = chooseTracks(readIndex(entry.path, statSync(entry.path).size))
      const bytes = readFileSync(entry.path)
      const streams = await probeStreams(entry.path)
      const folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-corpus-'))
      try {
        const problems = await checkWritten(
          'picture',
          video,
          bytes,
          streams.find((s) => s.codec_type === 'video'),
          folder,
        )
        if (audio) {
          problems.push(
            ...(await checkWritten(
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

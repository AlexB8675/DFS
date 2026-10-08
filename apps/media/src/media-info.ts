import {
  MEDIA_LIMITS,
  mediaInfoSchema,
  type MediaChapter,
  type MediaInfo,
  type MediaStream,
  type MediaTags,
  type ProbeResult,
} from '@dfs/shared'
import { z } from 'zod'

// What ffprobe reports, as DFS keeps it (DESIGN.md §6.7): each stream with
// the codec string a browser is asked about, chapters, and an audio file's
// tags. ffprobe parsed a file anyone could upload, so nothing here trusts its
// answer: every field is optional, and strings and lists are cut to size.

const disposition = z.object({
  default: z.number().optional(),
  forced: z.number().optional(),
  attached_pic: z.number().optional(),
})

const tags = z.record(z.string(), z.unknown())

const sideData = z.looseObject({
  side_data_type: z.string().optional(),
  rotation: z.number().optional(),
  dv_profile: z.number().optional(),
})

const ffprobeStream = z.looseObject({
  index: z.number().optional(),
  codec_name: z.string().optional(),
  codec_type: z.string().optional(),
  profile: z.string().optional(),
  level: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  bits_per_raw_sample: z.string().optional(),
  color_transfer: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  sample_rate: z.string().optional(),
  disposition: disposition.optional(),
  tags: tags.optional(),
  side_data_list: z.array(sideData).optional(),
})

const ffprobeOutput = z.looseObject({
  streams: z.array(ffprobeStream).optional(),
  chapters: z
    .array(
      z.looseObject({
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        tags: tags.optional(),
      }),
    )
    .optional(),
  format: z
    .looseObject({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      tags: tags.optional(),
    })
    .optional(),
})

type FfprobeStream = z.infer<typeof ffprobeStream>

/** ffprobe's answer as media info, or why the file isn't audio or video. */
export function toMediaInfo(output: unknown): ProbeResult {
  const parsed = ffprobeOutput.safeParse(output)
  if (!parsed.success) return { ok: false, reason: 'ffprobe’s answer had an unexpected shape.' }
  const { streams = [], chapters = [], format = {} } = parsed.data

  const covers = streams.filter(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic === 1,
  )
  const kept = streams
    .filter(
      (stream) =>
        !covers.includes(stream) &&
        (stream.codec_type === 'video' ||
          stream.codec_type === 'audio' ||
          stream.codec_type === 'subtitle'),
    )
    .slice(0, MEDIA_LIMITS.streams)
    .map(toStream)
  const kind = kept.some((stream) => stream.type === 'video')
    ? 'video'
    : kept.some((stream) => stream.type === 'audio')
      ? 'audio'
      : null
  if (!kind) return { ok: false, reason: 'It holds no audio or video.' }

  // Ogg and FLAC keep their tags on the audio stream, the others on the file.
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const info: MediaInfo = {
    kind,
    container: clip(format.format_name, 80) ?? 'unknown',
    durationMs: milliseconds(format.duration),
    bitRate: whole(format.bit_rate),
    streams: kept,
    chapters: chapters.slice(0, MEDIA_LIMITS.chapters).flatMap((chapter): MediaChapter[] => {
      const startMs = milliseconds(chapter.start_time)
      const endMs = milliseconds(chapter.end_time)
      if (startMs === null || endMs === null) return []
      return [{ startMs, endMs, title: clip(tag(chapter.tags, 'title'), 300) }]
    }),
    tags: toTags({ ...lowerKeys(audio?.tags), ...lowerKeys(format.tags) }),
    hasCover: covers.length > 0,
  }
  const checked = mediaInfoSchema.safeParse(info)
  return checked.success
    ? { ok: true, info: checked.data }
    : { ok: false, reason: 'Its media info is out of bounds.' }
}

function toStream(stream: FfprobeStream, position: number): MediaStream {
  const type = stream.codec_type as MediaStream['type']
  const codec = clip(stream.codec_name, 40) ?? 'unknown'
  const video = type === 'video'
  const audio = type === 'audio'
  const bitDepth = video ? depth(stream) : null
  return {
    index: positive(stream.index, 10_000) ?? (stream.index === 0 ? 0 : position),
    type,
    codec,
    codecString: codecString(stream, bitDepth),
    profile: clip(stream.profile, 80),
    width: video ? positive(stream.width, 100_000) : null,
    height: video ? positive(stream.height, 100_000) : null,
    frameRate: video ? frameRate(stream) : null,
    bitDepth,
    hdr: video ? transfer(stream.color_transfer) : null,
    dolbyVision: video ? dolbyVisionProfile(stream) : null,
    rotation: video ? rotation(stream) : null,
    channels: audio ? positive(stream.channels, 64) : null,
    channelLayout: audio ? clip(stream.channel_layout, 40) : null,
    sampleRate: audio ? positive(whole(stream.sample_rate) ?? undefined, 1_000_000) : null,
    language: language(tag(stream.tags, 'language')),
    title: clip(tag(stream.tags, 'title'), 300),
    default: stream.disposition?.default === 1,
    forced: stream.disposition?.forced === 1,
  }
}

/**
 * The RFC 6381 string a browser is asked about (`canPlayType`), from what
 * ffprobe says of the stream. Some parts it doesn't say (H.264's constraint
 * flags, HEVC's tier) are the common values: a browser asked about the wrong
 * one can still fail to play, which the player handles.
 */
export function codecString(stream: FfprobeStream, bitDepth: number | null): string | null {
  const level = stream.level !== undefined && stream.level > 0 ? stream.level : null
  switch (stream.codec_name) {
    case 'h264': {
      const profile = AVC_PROFILES[stream.profile ?? ''] ?? 100
      const constraints = stream.profile === 'Constrained Baseline' ? 0x40 : 0
      return `avc1.${hex(profile)}${hex(constraints)}${hex(level ?? 40)}`
    }
    case 'hevc': {
      const [profile, compatibility] = HEVC_PROFILES[stream.profile ?? ''] ?? [1, '6']
      return `hvc1.${String(profile)}.${compatibility}.L${String(level ?? 120)}.B0`
    }
    case 'av1': {
      const profile = AV1_PROFILES[stream.profile ?? ''] ?? 0
      return `av01.${String(profile)}.${pad(level ?? 8)}M.${pad(bitDepth ?? 8)}`
    }
    case 'vp9': {
      const profile = /(\d)/.exec(stream.profile ?? '')?.[1] ?? '0'
      return `vp09.0${profile}.${vp9Level(stream)}.${pad(bitDepth ?? 8)}`
    }
    case 'vp8':
    case 'theora':
    case 'opus':
    case 'vorbis':
    case 'flac':
    case 'alac':
      return stream.codec_name
    case 'mpeg4':
      return 'mp4v.20.9'
    case 'mpeg2video':
      return 'mp4v.61'
    case 'mpeg1video':
      return 'mp4v.6A'
    case 'aac':
      return `mp4a.40.${String(AAC_PROFILES[stream.profile ?? ''] ?? 2)}`
    case 'mp3':
      return 'mp4a.6B'
    case 'mp2':
      return 'mp4a.69'
    case 'ac3':
      return 'ac-3'
    case 'eac3':
      return 'ec-3'
    case 'dts':
      return 'dtsc'
    case 'truehd':
      return 'mlpa'
    default:
      return null
  }
}

const AVC_PROFILES: Record<string, number> = {
  Baseline: 66,
  'Constrained Baseline': 66,
  Main: 77,
  Extended: 88,
  High: 100,
  'Progressive High': 100,
  'Constrained High': 100,
  'High 10': 110,
  'High 10 Intra': 110,
  'High 4:2:2': 122,
  'High 4:2:2 Intra': 122,
  'High 4:4:4 Predictive': 244,
  'High 4:4:4 Intra': 244,
}

/** The profile and its compatibility flags, as written in `hvc1` strings. */
const HEVC_PROFILES: Record<string, [number, string]> = {
  Main: [1, '6'],
  'Main 10': [2, '4'],
  'Main Still Picture': [3, '8'],
  Rext: [4, '10'],
}

const AV1_PROFILES: Record<string, number> = { Main: 0, High: 1, Professional: 2 }

const AAC_PROFILES: Record<string, number> = { LC: 2, HE: 5, 'HE-AACv2': 29, LD: 23, Main: 1 }

function vp9Level(stream: FfprobeStream): string {
  // ffprobe rarely knows VP9's level: guess it from the picture's size.
  const pixels = (stream.width ?? 0) * (stream.height ?? 0)
  if (pixels > 2048 * 1088) return '51'
  if (pixels > 1280 * 720) return '41'
  return '31'
}

function depth(stream: FfprobeStream): number | null {
  const raw = positive(whole(stream.bits_per_raw_sample) ?? undefined, 64)
  if (raw) return raw
  const fromFormat = /p(\d{2})(le|be)$/.exec(stream.pix_fmt ?? '')?.[1]
  if (fromFormat) return Number(fromFormat)
  return stream.pix_fmt ? 8 : null
}

function transfer(value: string | undefined): MediaStream['hdr'] {
  if (value === 'smpte2084') return 'pq'
  if (value === 'arib-std-b67') return 'hlg'
  return null
}

function dolbyVisionProfile(stream: FfprobeStream): number | null {
  const record = stream.side_data_list?.find(
    (data) => data.side_data_type === 'DOVI configuration record',
  )
  return record?.dv_profile !== undefined ? clamp(Math.round(record.dv_profile), 0, 100) : null
}

/** Clockwise degrees to turn the picture: ffprobe's display matrix says counterclockwise. */
function rotation(stream: FfprobeStream): number | null {
  const matrix = stream.side_data_list?.find((data) => data.side_data_type === 'Display Matrix')
  let degrees: number | null = null
  if (matrix?.rotation !== undefined) degrees = -matrix.rotation
  else {
    const rotate = Number(tag(stream.tags, 'rotate'))
    if (Number.isFinite(rotate) && tag(stream.tags, 'rotate') !== null) degrees = rotate
  }
  if (degrees === null) return null
  const turned = ((Math.round(degrees) % 360) + 360) % 360
  return turned === 0 ? null : turned
}

function frameRate(stream: FfprobeStream): number | null {
  for (const value of [stream.avg_frame_rate, stream.r_frame_rate]) {
    const [numerator, denominator] = (value ?? '').split('/').map(Number)
    if (numerator && denominator) {
      const rate = numerator / denominator
      if (rate > 0 && rate <= 10_000) return Math.round(rate * 1000) / 1000
    }
  }
  return null
}

function toTags(found: Record<string, unknown>): MediaTags {
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = found[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return null
  }
  return {
    title: clip(first('title'), 300),
    artist: clip(first('artist', 'album_artist', 'albumartist'), 300),
    album: clip(first('album'), 300),
    albumArtist: clip(first('album_artist', 'albumartist', 'album artist'), 300),
    genre: clip(first('genre'), 300),
    // "3", or "3/12".
    track: leadingNumber(first('track', 'tracknumber'), 100_000),
    disc: leadingNumber(first('disc', 'discnumber'), 10_000),
    year: leadingNumber(first('date', 'year', 'originaldate'), 9999),
  }
}

function lowerKeys(found: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(found ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
}

function tag(found: Record<string, unknown> | undefined, key: string): string | null {
  const value = lowerKeys(found)[key]
  return typeof value === 'string' ? value : null
}

function language(value: string | null): string | null {
  if (!value || value === 'und') return null
  return clip(value, 16)
}

function leadingNumber(value: string | null, max: number): number | null {
  const match = /^\s*(\d{1,6})/.exec(value ?? '')
  if (!match) return null
  const number = Number(match[1])
  return number >= 1 && number <= max ? number : null
}

function milliseconds(seconds: string | undefined): number | null {
  const value = Number(seconds)
  if (seconds === undefined || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1000)
}

function whole(value: string | undefined): number | null {
  const number = Number(value)
  return value !== undefined && Number.isSafeInteger(number) && number > 0 ? number : null
}

/** A count in bounds, else `null`: a crafted file's isn't kept. */
function positive(value: number | undefined, max: number): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : null
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  return value.length > max ? value.slice(0, max) : value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

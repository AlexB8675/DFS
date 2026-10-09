import { z } from 'zod'
import { splitExtension } from './names.ts'

// Audio and video (DESIGN.md §6.7): which files are examined and played, and
// what examining one finds. The media service parses files anyone with an
// account uploads, so the API takes its answers only within these bounds.

export type MediaKind = 'video' | 'audio'

/** By name, when the MIME type doesn't say: browsers leave it out for MKV, for one. */
const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  '.mp4': 'video',
  '.m4v': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.webm': 'video',
  '.avi': 'video',
  '.wmv': 'video',
  '.flv': 'video',
  '.mpg': 'video',
  '.mpeg': 'video',
  '.m2ts': 'video',
  '.mts': 'video',
  '.ogv': 'video',
  '.3gp': 'video',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.m4b': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.wav': 'audio',
  '.aif': 'audio',
  '.aiff': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
  '.mka': 'audio',
  '.wma': 'audio',
  '.ac3': 'audio',
  '.eac3': 'audio',
  '.dts': 'audio',
  '.ape': 'audio',
  '.wv': 'audio',
}

/**
 * Whether a file is audio or video, by its MIME type, else by its name. The
 * API examines these after an upload, and the players open them. `.ts` is
 * left to its MIME type: more often TypeScript than an MPEG-TS recording.
 */
export function mediaKind(name: string, mimeType: string | null): MediaKind | null {
  // Playlists name other files, which no player opens through them (§6.7).
  if (mimeType && PLAYLIST_TYPES.has(mimeType.toLowerCase())) return null
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  return MEDIA_EXTENSIONS[splitExtension(name).extension.toLowerCase()] ?? null
}

/** Playlists, typed as audio by browsers and Windows: M3U, HLS's M3U8 and PLS. */
const PLAYLIST_TYPES = new Set([
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/x-scpls',
])

/** The extensions `mediaKind` knows, for `fileCategory`. */
export const MEDIA_EXTENSION_KINDS: Readonly<Record<string, MediaKind>> = MEDIA_EXTENSIONS

const text = (max: number) => z.string().max(max).nullable()
const count = (max: number) => z.number().int().min(0).max(max).nullable()

export const mediaStreamSchema = z.object({
  /** The stream's index in the file, as ffmpeg numbers it. */
  index: z.number().int().min(0).max(10_000),
  type: z.enum(['video', 'audio', 'subtitle']),
  /** ffmpeg's name for the codec: `h264`, `hevc`, `aac`, `ac3`, `subrip`. */
  codec: z.string().max(40),
  /** RFC 6381, for asking the browser (`avc1.640028`, `mp4a.40.2`); `null` where there is none. */
  codecString: text(80),
  profile: text(80),
  width: count(100_000),
  height: count(100_000),
  frameRate: z.number().min(0).max(10_000).nullable(),
  bitDepth: count(64),
  /** The transfer of HDR video: PQ (HDR10, HDR10+, most Dolby Vision) or HLG. */
  hdr: z.enum(['pq', 'hlg']).nullable(),
  /** The Dolby Vision profile, when the stream carries one. */
  dolbyVision: count(100),
  /** Degrees to turn the picture for showing it, clockwise. */
  rotation: z.number().int().min(-360).max(360).nullable(),
  channels: count(64),
  channelLayout: text(40),
  sampleRate: count(1_000_000),
  language: text(16),
  title: text(300),
  default: z.boolean(),
  forced: z.boolean(),
})

export const mediaChapterSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  title: text(300),
})

export const mediaTagsSchema = z.object({
  title: text(300),
  artist: text(300),
  album: text(300),
  albumArtist: text(300),
  genre: text(300),
  track: count(100_000),
  disc: count(10_000),
  year: count(9999),
})

/** Streams, chapters and so on a file may list: past these, the media service keeps the first. */
export const MEDIA_LIMITS = { streams: 64, chapters: 500 } as const

export const mediaInfoSchema = z.object({
  kind: z.enum(['video', 'audio']),
  /** ffmpeg's name for the container: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, `mp3`. */
  container: z.string().max(80),
  durationMs: z.number().int().min(0).nullable(),
  bitRate: z.number().int().min(0).nullable(),
  streams: z.array(mediaStreamSchema).max(MEDIA_LIMITS.streams),
  chapters: z.array(mediaChapterSchema).max(MEDIA_LIMITS.chapters),
  tags: mediaTagsSchema,
  /** A picture in an audio file's tags: its cover. */
  hasCover: z.boolean(),
})

export type MediaStream = z.infer<typeof mediaStreamSchema>
export type MediaChapter = z.infer<typeof mediaChapterSchema>
export type MediaTags = z.infer<typeof mediaTagsSchema>
export type MediaInfo = z.infer<typeof mediaInfoSchema>

/**
 * The media service's answer to examining a file: what it is, or that it
 * holds nothing ffmpeg can read (not audio or video, a format it isn't
 * allowed to open, or a damaged file), which isn't asked again.
 */
export const probeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), info: mediaInfoSchema }),
  z.object({ ok: z.literal(false), reason: z.string().max(300) }),
])

export type ProbeResult = z.infer<typeof probeResultSchema>

/**
 * `GET /files/:id/media`: what examining the current version found, or why
 * it holds nothing to play (`problem`).
 */
export const fileMediaSchema = z.object({
  versionId: z.uuid(),
  info: mediaInfoSchema.nullable(),
  problem: z.string().max(300).nullable(),
})

export type FileMedia = z.infer<typeof fileMediaSchema>

/**
 * Subtitle streams the media service extracts as text (§6.7), by ffmpeg's
 * codec names; the others (PGS, VobSub, DVB) are pictures, listed but not shown.
 */
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
])

/** A subtitle stream as WebVTT larger than this is a crafted file's: a film's are a few hundred KB. */
export const MAX_SUBTITLE_TRACK_BYTES = 2 * 1024 * 1024

/** Subtitle streams the media service extracts in one pass, at most. */
export const MAX_SUBTITLE_STREAMS = 32

/** A subtitle stream inside a file, as WebVTT, or why it couldn't be. */
export const subtitleTrackSchema = z.object({
  index: z.number().int().min(0).max(10_000),
  vtt: z.string().max(MAX_SUBTITLE_TRACK_BYTES).nullable(),
  problem: z.string().max(300).nullable(),
})

export type SubtitleTrack = z.infer<typeof subtitleTrackSchema>

/**
 * The media service's answer to extracting subtitles: each stream asked
 * for, or that ffmpeg couldn't read the file, which isn't asked again.
 */
export const subtitleTracksResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), tracks: z.array(subtitleTrackSchema).max(MAX_SUBTITLE_STREAMS) }),
  z.object({ ok: z.literal(false), reason: z.string().max(300) }),
])

export type SubtitleTracksResult = z.infer<typeof subtitleTracksResultSchema>

/** Whether a stream is subtitles the media service can extract as text. */
export function isTextSubtitles(stream: Pick<MediaStream, 'type' | 'codec'>): boolean {
  return stream.type === 'subtitle' && TEXT_SUBTITLE_CODECS.has(stream.codec)
}

/** A subtitle file beside a video (`Film.it.srt`), with what its name says (§6.7). */
export const subtitleFileSchema = z.object({
  /** The subtitle file's own ID. */
  id: z.uuid(),
  name: z.string(),
  /** A BCP 47 tag, from its name; `null` when its name gives none. */
  language: z.string().max(35).nullable(),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
})

export type SubtitleFile = z.infer<typeof subtitleFileSchema>

/**
 * `GET /files/:id/playback`: what a player needs to start, from the
 * database alone, so it doesn't wait for the media info (§10.4).
 */
export const playbackSchema = z.object({
  /** The version to play: named in the content route's `?version=`. */
  versionId: z.uuid(),
  /** Where this user stopped in this version; `null` for the start. */
  positionMs: z.number().int().min(0).nullable(),
  subtitleFiles: z.array(subtitleFileSchema),
})

export type Playback = z.infer<typeof playbackSchema>

const reportMs = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60 * 1000)
const reportCount = z.number().int().min(0).max(1_000_000_000)

/**
 * `POST /files/:id/playback-report`: how a play went, as the player saw it,
 * sent when it ends (§10.4, §16). The API logs it and graphs its times.
 */
export const playbackReportSchema = z.object({
  versionId: z.uuid(),
  /** It showed a frame, it couldn't play, or the viewer left before either. */
  outcome: z.enum(['played', 'failed', 'left']),
  /** From the player starting to its first frame. */
  firstFrameMs: reportMs.nullable(),
  /** From the player starting to its playing: the first frame may come long before. */
  startMs: reportMs.nullable(),
  /** From the player starting to this report: how long the viewer stayed. */
  openMs: reportMs,
  /** Waits for data after the first frame (not seeks), and their time in all. */
  stalls: reportCount,
  stallMs: reportMs,
  /** Seeks, and the time in all from each to its picture. */
  seeks: reportCount,
  seekWaitMs: reportMs,
  /** Frames shown and dropped, as the browser counts them. */
  frames: reportCount,
  droppedFrames: reportCount,
  /** How fast the video arrived while the player waited for it, in bits a second, estimated. */
  arrivalBitsPerSecond: z.number().min(0).max(1e12).nullable(),
  /** What the browser said of decoding this video (Media Capabilities), if it was asked. */
  decoding: z
    .object({ supported: z.boolean(), smooth: z.boolean(), powerEfficient: z.boolean() })
    .nullable(),
  /** Why it couldn't play: the browser's error, or the codec in the way. */
  problem: z.string().max(300).nullable(),
})

export type PlaybackReport = z.infer<typeof playbackReportSchema>

/**
 * `GET /files/:id/media/:versionId/delivery`: the user's reads of the version
 * so far, summed and cumulative, so a player works out how fast its video
 * arrives, and whether the server waits for storage or for the connection,
 * from the differences between two asks (§10.4).
 */
export const deliverySchema = z.object({
  bytes: z.number().int().min(0),
  waitedForSourceMs: z.number().int().min(0),
  waitedForClientMs: z.number().int().min(0),
  running: z.number().int().min(0),
})

export type Delivery = z.infer<typeof deliverySchema>

/** `GET /connection-test?bytes=`: at most this much, so a test can't become a load. */
export const MAX_CONNECTION_TEST_BYTES = 32 * 1024 * 1024

/** A week: longer than any video, so a larger position is a client's mistake. */
const MAX_POSITION_MS = 7 * 24 * 60 * 60 * 1000

/** `PUT /files/:id/position`: where this user stopped, in the version they played. */
export const savePositionSchema = z.object({
  versionId: z.uuid(),
  positionMs: z.number().int().min(0).max(MAX_POSITION_MS),
})

export type SavePositionInput = z.infer<typeof savePositionSchema>

// ── The audio bar (§10.4) ────────────────────────────────────────────────────

/** A queue from a folder holds at most this many files. */
export const MAX_AUDIO_QUEUE = 1000

/**
 * An audio file in a queue, as the bar shows it before it plays: from the
 * media info kept for its version, which a file not examined yet hasn't.
 */
export const audioTrackSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  versionId: z.uuid(),
  durationMs: z.number().int().min(0).nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  /** A cover to show (`…/cover`): the picture in its tags, or one beside it. */
  hasCover: z.boolean(),
})

/**
 * `GET /folders/:id/audio?deep=`: a folder's audio files, or everything below
 * it, in play order: folder by folder, each by disc and track, else by name.
 */
export const audioQueueSchema = z.object({
  items: z.array(audioTrackSchema).max(MAX_AUDIO_QUEUE),
  /** More were there than a queue holds. */
  truncated: z.boolean(),
})

export type AudioTrack = z.infer<typeof audioTrackSchema>
export type AudioQueue = z.infer<typeof audioQueueSchema>

/** What puts a queue in play order: where a file sits below the folder played, and its tags. */
export interface PlayOrderKey {
  name: string
  /** The folders between the one played and the file: `[]` for its own files. */
  path: readonly string[]
  disc: number | null
  track: number | null
}

const naturalNames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Play order (§10.4): folder by folder, a folder's own files before its
 * subfolders', folders by name in natural order; in each, by disc and track
 * from the tags, files without a track after, by name in natural order.
 */
export function playOrder<T extends PlayOrderKey>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    const folders = comparePaths(a.path, b.path)
    if (folders !== 0) return folders
    // Those without a track, whatever their disc, after those with one.
    if (a.track === null || b.track === null) {
      if (a.track !== b.track) return a.track === null ? 1 : -1
    } else {
      const disc = (a.disc ?? 1) - (b.disc ?? 1)
      if (disc !== 0) return disc
      if (a.track !== b.track) return a.track - b.track
    }
    return naturalNames.compare(a.name, b.name)
  })
}

/** Folder paths in the order a walk through them takes: a folder before what is inside it. */
function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const order = naturalNames.compare(a[i] ?? '', b[i] ?? '')
    if (order !== 0) return order
  }
  return a.length - b.length
}

/** A cover larger than this, in a file's tags or beside it, isn't shown. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024

const COVER_NAMES = ['cover', 'folder', 'front']
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

/**
 * How good a cover a file beside an audio file makes, by its name, lower
 * first (§6.7): `cover`, `folder`, then `front`, each a JPEG, PNG or WebP;
 * `null` for any other file.
 */
export function coverFileRank(name: string): number | null {
  const { base, extension } = splitExtension(name.toLowerCase())
  const named = COVER_NAMES.indexOf(base)
  const typed = COVER_EXTENSIONS.indexOf(extension)
  return named === -1 || typed === -1 ? null : named * COVER_EXTENSIONS.length + typed
}

/** A cover's type, from its first bytes: only pictures every browser draws. */
export function coverType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte)
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  const riff = starts(0x52, 0x49, 0x46, 0x46)
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  return riff && webp ? 'image/webp' : null
}

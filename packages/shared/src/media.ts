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
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  return MEDIA_EXTENSIONS[splitExtension(name).extension.toLowerCase()] ?? null
}

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

/** A week: longer than any video, so a larger position is a client's mistake. */
const MAX_POSITION_MS = 7 * 24 * 60 * 60 * 1000

/** `PUT /files/:id/position`: where this user stopped, in the version they played. */
export const savePositionSchema = z.object({
  versionId: z.uuid(),
  positionMs: z.number().int().min(0).max(MAX_POSITION_MS),
})

export type SavePositionInput = z.infer<typeof savePositionSchema>

import { isTextSubtitles, type MediaInfo, type MediaStream } from '@dfs/shared'

// What this browser decodes (DESIGN.md §6.7, §10.4): each codec of a file's
// media info put to the browser by its RFC 6381 string, never the
// container, since Chrome plays MKV but doesn't say so.

/** `video.canPlayType`: `''` for no, `'maybe'` or `'probably'` for yes. */
export type CanPlayType = (type: string) => string

/** Whether this browser decodes a stream; `null` when there is no way to ask. */
export type Decodes = boolean | null

export interface Playability {
  video: { stream: MediaStream; decodes: Decodes } | null
  audio: { stream: MediaStream; decodes: Decodes } | null
}

/** The streams a direct play plays: the default video and sound, else the first of each. */
export function playedStreams(info: MediaInfo): {
  video: MediaStream | null
  audio: MediaStream | null
} {
  const pick = (type: MediaStream['type']) => {
    const streams = info.streams.filter((stream) => stream.type === type)
    return streams.find((stream) => stream.default) ?? streams[0] ?? null
  }
  return { video: pick('video'), audio: pick('audio') }
}

let probe: HTMLVideoElement | null = null

/**
 * This browser's `canPlayType`, asked of an element of its own: a player's
 * element goes once the answer is no.
 */
export function browserCanPlayType(type: string): string {
  probe ??= document.createElement('video')
  return probe.canPlayType(type)
}

/** Whether this browser decodes the streams a direct play would play. */
export function playability(info: MediaInfo, canPlayType: CanPlayType): Playability {
  const { video, audio } = playedStreams(info)
  return {
    video: video && { stream: video, decodes: decodes(video, canPlayType) },
    audio: audio && { stream: audio, decodes: decodes(audio, canPlayType) },
  }
}

/** What this browser can't do with a video it plays (§10.4), which another player can. */
export interface Unplayable {
  /** The sound's codec, when it can't decode it: the video plays silent. */
  sound: string | null
  /** It has picture subtitles (PGS, VobSub), which a browser can't show. */
  pictureSubtitles: boolean
  /** Its other sound tracks, which this browser can't switch to: it lists no tracks of its own. */
  otherSounds: number
}

/** What this browser can't do with a video, given whether it lists audio tracks of its own (Safari). */
export function unplayableOf(
  info: MediaInfo,
  verdict: Playability,
  listsTracks: boolean,
): Unplayable {
  const sounds = info.streams.filter((stream) => stream.type === 'audio').length
  return {
    sound: verdict.audio?.decodes === false ? codecLabel(verdict.audio.stream.codec) : null,
    pictureSubtitles: info.streams.some(
      (stream) => stream.type === 'subtitle' && !isTextSubtitles(stream),
    ),
    otherSounds: listsTracks ? 0 : Math.max(0, sounds - 1),
  }
}

/** Whether the browser says it decodes the stream's codec. */
export function decodes(stream: MediaStream, canPlayType: CanPlayType): Decodes {
  const type = mimeTypeOf(stream)
  return type === null ? null : canPlayType(type) !== ''
}

/**
 * The MIME type to ask about a codec under: the container it belongs to,
 * with its string as the codecs parameter, or a type of its own.
 */
export function mimeTypeOf(stream: Pick<MediaStream, 'codec' | 'codecString'>): string | null {
  switch (stream.codec) {
    case 'mp3':
    case 'mp2':
      return 'audio/mpeg'
    case 'flac':
      return 'audio/flac'
    case 'opus':
      return 'audio/ogg; codecs="opus"'
    case 'vorbis':
      return 'audio/ogg; codecs="vorbis"'
    case 'theora':
      return 'video/ogg; codecs="theora"'
    case 'vp8':
      return 'video/webm; codecs="vp8"'
  }
  const codec = stream.codecString
  if (codec === null) return null
  return /^(avc|hvc|hev|av01|vp09|mp4v|dv)/.test(codec)
    ? `video/mp4; codecs="${codec}"`
    : `audio/mp4; codecs="${codec}"`
}

/** U+2011, a hyphen no line breaks at. */
const NO_BREAK_HYPHEN = String.fromCharCode(0x2011)

const LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1',
  vc1: 'VC-1',
  wmv3: 'WMV',
  wmv2: 'WMV',
  theora: 'Theora',
  prores: 'ProRes',
  aac: 'AAC',
  mp3: 'MP3',
  mp2: 'MP2',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  wmav2: 'WMA',
  subrip: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  mov_text: 'MP4 text',
  webvtt: 'WebVTT',
  hdmv_pgs_subtitle: 'PGS',
  dvd_subtitle: 'VobSub',
  dvb_subtitle: 'DVB',
}

/**
 * A codec's name as people know it: `hevc` → HEVC, `eac3` → Dolby Digital
 * Plus (E-AC-3), its hyphens unbroken, so “(AC-3)” never wraps.
 */
export function codecLabel(codec: string): string {
  if (codec.startsWith('pcm_')) return 'PCM'
  return (LABELS[codec] ?? codec.toUpperCase()).replaceAll('-', NO_BREAK_HYPHEN)
}

/** A video stream in a few words: “HEVC Main 10 · 3840×2160 · 23.976 fps · HDR10”. */
export function describeVideo(stream: MediaStream): string {
  const parts = [[codecLabel(stream.codec), stream.profile].filter(Boolean).join(' ')]
  if (stream.width && stream.height) {
    const turned = stream.rotation !== null && Math.abs(stream.rotation) % 180 === 90
    parts.push(turned ? `${stream.height}×${stream.width}` : `${stream.width}×${stream.height}`)
  }
  if (stream.frameRate) parts.push(`${String(Math.round(stream.frameRate * 1000) / 1000)} fps`)
  if (stream.dolbyVision !== null) parts.push(`Dolby Vision ${String(stream.dolbyVision)}`)
  else if (stream.hdr) parts.push(stream.hdr === 'pq' ? 'HDR10' : 'HLG')
  return parts.join(' · ')
}

/** A picture in the fewest words: “4K · 60 fps · AV1 · HDR”, for a warning. */
export function describeBriefly(stream: MediaStream): string {
  const parts: string[] = []
  if (stream.width && stream.height) {
    const lines = Math.min(stream.width, stream.height)
    parts.push(lines >= 2160 ? '4K' : lines >= 1440 ? '1440p' : `${String(lines)}p`)
  }
  if (stream.frameRate) parts.push(`${String(Math.round(stream.frameRate))} fps`)
  parts.push(codecLabel(stream.codec))
  if (stream.hdr || stream.dolbyVision !== null) parts.push('HDR')
  return parts.join(' · ')
}

/** A sound stream in a few words: “E-AC-3 5.1 · English”. */
export function describeAudio(stream: MediaStream): string {
  const parts = [codecLabel(stream.codec)]
  if (stream.channelLayout) parts.push(stream.channelLayout.replace(/\(.*\)$/, ''))
  else if (stream.channels) parts.push(`${String(stream.channels)} ch`)
  const said = [languageName(stream.language), stream.title].filter(Boolean)
  return [parts.join(' '), ...said].join(' · ')
}

let names: Intl.DisplayNames | null = null

/** A language's name in English, from a tag or ffmpeg's three letters; `null` for none. */
export function languageName(language: string | null): string | null {
  if (!language || language === 'und') return null
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
    const [canonical] = Intl.getCanonicalLocales(language)
    return (canonical && names.of(canonical)) ?? language
  } catch {
    return language
  }
}

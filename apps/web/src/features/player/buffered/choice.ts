import type { MediaInfo } from '@dfs/shared'
import type { Device } from '../external-players'

/**
 * How a video plays here (§10.4, D45): in the page through DFS's own buffer
 * (Media Source), natively, or in another player offered instead.
 */
export type PagePlay =
  | { play: 'buffered' }
  /** Safari's own player, on an iPhone or iPad: their native player. */
  | { play: 'native' }
  /** Not in this page: another player is offered, for this reason. */
  | { play: 'elsewhere'; reason: 'format' | 'picture' | 'sound' | 'browser'; codec: string | null }

/**
 * Decides how a video plays on this device (§10.4, D45). An iPhone or iPad plays
 * in Safari's own player. Elsewhere a video plays in the page only through Media
 * Source: in a browser that has it, from an MP4 or MOV (ffmpeg's container name
 * starts with `mov,mp4`) or a Matroska or WebM file (`matroska`), whose first
 * picture and the sound that plays the browser takes. The engine repackages
 * Matroska into MP4 fragments, so the checks are for MP4's MIME types. The sound
 * that plays is an MP4's first, and a Matroska file's first flagged default, else
 * its first; the others are for another player. A stream with no
 * codec string is let through, as the player checks it as it opens. With no
 * media info, the name has to be an MP4's, MOV's, MKV's or WebM's. Anything else is for another
 * player, with the reason, and the codec where a codec is the reason.
 */
export function pagePlay(input: {
  name: string
  /** The media info, or `null` when there is none (not examined, or it failed). */
  info: MediaInfo | null
  device: Device
  /** Whether buffered play can run here (`bufferedPlayAvailable()`). */
  canBuffer: boolean
  /** `MediaSource.isTypeSupported`, or a test's stand-in. */
  supports: (mime: string) => boolean
}): PagePlay {
  const { name, info, device, canBuffer, supports } = input
  if (device === 'ios') return { play: 'native' }
  if (!canBuffer) return { play: 'elsewhere', reason: 'browser', codec: null }
  if (info === null) {
    return mayPlayBuffered(name)
      ? { play: 'buffered' }
      : { play: 'elsewhere', reason: 'format', codec: null }
  }
  const picture = info.streams.find((stream) => stream.type === 'video')
  if (
    info.kind !== 'video' ||
    !(info.container.startsWith('mov,mp4') || info.container.startsWith('matroska')) ||
    picture === undefined
  ) {
    return { play: 'elsewhere', reason: 'format', codec: null }
  }
  if (picture.codecString !== null && !supports(`video/mp4; codecs="${picture.codecString}"`)) {
    return { play: 'elsewhere', reason: 'picture', codec: picture.codec }
  }
  const sounds = info.streams.filter((stream) => stream.type === 'audio')
  const sound = info.container.startsWith('matroska')
    ? (sounds.find((stream) => stream.default) ?? sounds[0])
    : sounds[0]
  if (sound?.codecString != null && !soundSupported(sound.codec, sound.codecString, supports)) {
    return { play: 'elsewhere', reason: 'sound', codec: sound.codec }
  }
  return { play: 'buffered' }
}

/** The other names the engine asks Media Source for a sound codec by; mirrors `codecNames` in `@dfs/mp4`. */
const SOUND_ALIASES: Record<string, string[]> = {
  mp3: ['mp3', 'mp4a.40.34'],
  opus: ['Opus'],
  flac: ['fLaC'],
}

/** Whether Media Source takes a sound under its codec string or any name the engine also tries. */
function soundSupported(
  codec: string,
  codecString: string,
  supports: (mime: string) => boolean,
): boolean {
  // Own keys only: a codec named like an Object.prototype key has no other names.
  const aliases = Object.hasOwn(SOUND_ALIASES, codec) ? (SOUND_ALIASES[codec] ?? []) : []
  return [codecString, ...aliases].some((name) => supports(`audio/mp4; codecs="${name}"`))
}

/** Whether this browser has what buffered play needs (§10.4): Media Source, `AbortSignal.any` and WebCrypto, which the store encrypts with. */
export function bufferedPlayAvailable(
  scope: {
    MediaSource?: unknown
    AbortSignal?: { any?: unknown }
    crypto?: { subtle?: unknown }
  } = globalThis,
): boolean {
  return (
    scope.MediaSource !== undefined &&
    typeof scope.AbortSignal?.any === 'function' &&
    scope.crypto?.subtle !== undefined
  )
}

/**
 * Whether a file named `name` may play through the buffer: only an MP4, MOV,
 * MKV or WebM can, and its name is all there is to go on before the media info has come, so
 * the video player waits for the info only for these (§10.4). The info
 * (`pagePlay`) has the last word.
 */
export function mayPlayBuffered(name: string): boolean {
  return /\.(mp4|m4v|mov|mkv|webm)$/i.test(name)
}

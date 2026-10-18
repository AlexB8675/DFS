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
 * starts with `mov,mp4`; Matroska and WebM aren't split by mp4box) whose first
 * picture and first sound track the browser takes. The first sound track is the
 * one the engine plays; the others are for another player. A stream with no
 * codec string is let through, as the player checks it as it opens. With no
 * media info, the name has to be an MP4's or MOV's. Anything else is for another
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
  if (info.kind !== 'video' || !info.container.startsWith('mov,mp4') || picture === undefined) {
    return { play: 'elsewhere', reason: 'format', codec: null }
  }
  if (picture.codecString !== null && !supports(`video/mp4; codecs="${picture.codecString}"`)) {
    return { play: 'elsewhere', reason: 'picture', codec: picture.codec }
  }
  const sound = info.streams.find((stream) => stream.type === 'audio')
  if (sound?.codecString != null && !supports(`audio/mp4; codecs="${sound.codecString}"`)) {
    return { play: 'elsewhere', reason: 'sound', codec: sound.codec }
  }
  return { play: 'buffered' }
}

/** Whether this browser has what buffered play needs (§10.4): Media Source, `AbortSignal.any` and `Promise.withResolvers`. */
export function bufferedPlayAvailable(
  scope: {
    MediaSource?: unknown
    AbortSignal?: { any?: unknown }
    Promise?: { withResolvers?: unknown }
  } = globalThis,
): boolean {
  return (
    scope.MediaSource !== undefined &&
    typeof scope.AbortSignal?.any === 'function' &&
    typeof scope.Promise?.withResolvers === 'function'
  )
}

/**
 * Whether a file named `name` may play through the buffer: only an MP4 or MOV
 * can, and its name is all there is to go on before the media info has come, so
 * the video player waits for the info only for these (§10.4). The info
 * (`pagePlay`) has the last word.
 */
export function mayPlayBuffered(name: string): boolean {
  return /\.(mp4|m4v|mov)$/i.test(name)
}

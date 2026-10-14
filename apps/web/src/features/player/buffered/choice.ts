import type { MediaInfo } from '@dfs/shared'

/**
 * Whether a video plays through DFS's own buffer (§10.4): an MP4 or MOV (ffmpeg's
 * container name starts with `mov,mp4`) with a picture and at most one sound
 * track, in a browser with Media Source. Others keep `<video src>`: Matroska and
 * WebM aren't split by mp4box, and the browser switches between several sound
 * tracks only in a file it plays itself.
 */
export function playsBuffered(info: MediaInfo, mediaSource: boolean): boolean {
  if (!mediaSource || info.kind !== 'video') return false
  if (!info.container.startsWith('mov,mp4')) return false
  const pictures = info.streams.filter((stream) => stream.type === 'video').length
  const sounds = info.streams.filter((stream) => stream.type === 'audio').length
  return pictures >= 1 && sounds <= 1
}

/**
 * Whether a file named `name` may play through the buffer: only an MP4 or MOV
 * can, and its name is all there is to go on before the media info has come, so
 * the video player waits for the info only for these (§10.4). The info
 * (`playsBuffered`) has the last word.
 */
export function mayPlayBuffered(name: string): boolean {
  return /\.(mp4|m4v|mov)$/i.test(name)
}

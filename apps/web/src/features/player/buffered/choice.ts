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

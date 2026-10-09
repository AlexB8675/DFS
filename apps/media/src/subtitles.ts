import { MAX_SUBTITLE_TRACK_BYTES, type SubtitleTrack } from '@dfs/shared'
import { inputArguments, ProbeError, readFailed } from './ffprobe.ts'
import { firstLine, run } from './process.ts'

// Text subtitles inside a file, as WebVTT (DESIGN.md §6.7): every stream
// asked for in one pass of ffmpeg, since an MKV's are spread through the
// whole file, each to a pipe of its own. Only the subtitle streams are
// decoded; the video and the sound are skipped.

/** Long enough to read a film from staging, or from Discord on a first ask. */
const EXTRACT_TIMEOUT_MS = 15 * 60_000

/** ffmpeg's arguments: each stream to WebVTT on its own pipe, from fd 3 on. */
export function extractArguments(url: string, token: string, streams: readonly number[]): string[] {
  return [
    '-nostdin',
    '-v',
    'error',
    '-hide_banner',
    ...inputArguments(url, token),
    ...streams.flatMap((index, i) => [
      '-map',
      `0:${String(index)}`,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      `pipe:${String(3 + i)}`,
    ]),
  ]
}

/**
 * The streams as WebVTT, each bounded: one past its limit is a problem of
 * its own, and the others still come. Fails with a `ProbeError` when ffmpeg
 * does, saying whether the file or the reading of it was the trouble.
 */
export async function extractSubtitles(
  url: string,
  token: string,
  streams: readonly number[],
  options: { command?: string; timeoutMs?: number } = {},
): Promise<SubtitleTrack[]> {
  const ran = await run(options.command ?? 'ffmpeg', extractArguments(url, token, streams), {
    timeoutMs: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
    pipes: streams.length,
    maxBytes: MAX_SUBTITLE_TRACK_BYTES,
  })
  if (ran.timedOut) throw new ProbeError('ffmpeg took too long.', true)
  if (ran.code !== 0) {
    const message = firstLine(ran.stderr) || `ffmpeg exited with ${String(ran.code)}`
    throw new ProbeError(message, readFailed(ran.stderr))
  }
  return streams.map((index, i) => {
    const output = ran.outputs[i]
    return output
      ? { index, vtt: output.toString('utf8'), problem: null }
      : { index, vtt: null, problem: 'These subtitles are too large.' }
  })
}

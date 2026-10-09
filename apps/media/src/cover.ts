import { MAX_COVER_BYTES } from '@dfs/shared'
import { inputArguments, ProbeError, readFailed } from './ffprobe.ts'
import { firstLine, run } from './process.ts'

// An audio file's cover (DESIGN.md §6.7): the picture in its tags, copied
// out as it is, never decoded or converted. The API asks only for files
// whose media info says they have one, and checks what comes back is a
// picture before it serves it.

/** Covers sit at a file's start (ID3, FLAC) or in its index (MP4), which ffmpeg seeks to. */
const COVER_TIMEOUT_MS = 60_000

/** ffmpeg's arguments: the first picture stream, copied to stdout as it is. */
export function coverArguments(url: string, token: string): string[] {
  return [
    '-nostdin',
    '-v',
    'error',
    '-hide_banner',
    ...inputArguments(url, token),
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    'pipe:1',
  ]
}

/**
 * The cover's bytes, or `null` when there is none, or one too large to
 * serve. Fails with a `ProbeError` when ffmpeg does, saying whether the file
 * or the reading of it was the trouble.
 */
export async function extractCover(
  url: string,
  token: string,
  options: { command?: string; timeoutMs?: number } = {},
): Promise<Buffer | null> {
  const ran = await run(options.command ?? 'ffmpeg', coverArguments(url, token), {
    timeoutMs: options.timeoutMs ?? COVER_TIMEOUT_MS,
    maxBytes: MAX_COVER_BYTES,
    killPastMax: true,
  })
  const [cover] = ran.outputs
  // Stopped for being too large: no cover, rather than a broken file.
  if (cover === null) return null
  if (ran.timedOut) throw new ProbeError('ffmpeg took too long.', true)
  if (ran.code !== 0) {
    const message = firstLine(ran.stderr) || `ffmpeg exited with ${String(ran.code)}`
    // A file without a picture stream has nothing to map: no cover, not a failure.
    if (/matches no streams/i.test(ran.stderr)) return null
    throw new ProbeError(message, readFailed(ran.stderr))
  }
  return cover && cover.length > 0 ? cover : null
}

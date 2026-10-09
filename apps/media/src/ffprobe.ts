import { firstLine, run } from './process.ts'

// Running ffprobe (DESIGN.md §6.7). It parses files anyone with an account
// uploads, so it may open only what it is given, over HTTP from the API, and
// only as one of the containers DFS plays: never a playlist or a list of
// other files (HLS, concat), whose entries could name local files or other
// hosts on the internal network, nor images or devices.

/**
 * The containers ffmpeg may open, by its demuxers' names: MP4 and MOV,
 * Matroska and WebM, AVI, MPEG-TS and PS, ASF (WMV, WMA), FLV, Ogg, and
 * audio files.
 */
export const ALLOWED_FORMATS = [
  'mov',
  'matroska',
  'avi',
  'mpegts',
  'mpeg',
  'asf',
  'flv',
  'ogg',
  'mp3',
  'flac',
  'wav',
  'w64',
  'aiff',
  'aac',
  'ac3',
  'eac3',
  'dts',
  'truehd',
  'ape',
  'wv',
  'caf',
] as const

/** Protocols ffmpeg may use: the API's HTTP, and the TCP under it. */
export const ALLOWED_PROTOCOLS = ['http', 'tcp'] as const

/** An answer larger than this is a crafted file's: it is cut off. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const PROBE_TIMEOUT_MS = 60_000
/** ffmpeg's time for one read from the API, in microseconds. */
const READ_TIMEOUT_US = 30_000_000

/** ffmpeg or ffprobe failed: on the file, or (`sourceFailed`) on reading it from the API. */
export class ProbeError extends Error {
  /** The API couldn't be read, so the file may be fine: worth asking again. */
  readonly sourceFailed: boolean

  constructor(message: string, sourceFailed: boolean) {
    super(message)
    this.name = 'ProbeError'
    this.sourceFailed = sourceFailed
  }
}

/** ffprobe's arguments for a URL the API serves, with the token sent as a header. */
export function probeArguments(url: string, token: string): string[] {
  return [
    '-v',
    'error',
    '-hide_banner',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    ...inputArguments(url, token),
  ]
}

/**
 * How ffmpeg and ffprobe open a version: from the API alone, over HTTP, as
 * one of the containers DFS plays, with the token sent as a header.
 */
export function inputArguments(url: string, token: string): string[] {
  return [
    '-protocol_whitelist',
    ALLOWED_PROTOCOLS.join(','),
    '-format_whitelist',
    ALLOWED_FORMATS.join(','),
    '-rw_timeout',
    String(READ_TIMEOUT_US),
    '-headers',
    `Authorization: Bearer ${token}\r\n`,
    '-i',
    url,
  ]
}

/**
 * What ffprobe reports, as parsed JSON. Fails with a `ProbeError` saying
 * whether the file or the reading of it was the trouble.
 */
export async function runProbe(
  url: string,
  token: string,
  options: { command?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const ran = await run(options.command ?? 'ffprobe', probeArguments(url, token), {
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxBytes: MAX_OUTPUT_BYTES,
    killPastMax: true,
  })
  // Slow reads from Discord can take this long: not the file's fault.
  if (ran.timedOut) throw new ProbeError('ffprobe took too long.', true)
  const [stdout] = ran.outputs
  if (stdout === null) throw new ProbeError('ffprobe’s answer was too large.', false)
  if (ran.code !== 0) {
    const message = firstLine(ran.stderr) || `ffprobe exited with ${String(ran.code)}`
    throw new ProbeError(message, readFailed(ran.stderr))
  }
  try {
    return JSON.parse(stdout?.toString('utf8') ?? '') as unknown
  } catch {
    throw new ProbeError('ffprobe gave an answer that isn’t JSON.', false)
  }
}

/** The first line of `ffprobe -version`: which ffmpeg this is. */
export async function ffmpegVersion(command = 'ffprobe'): Promise<string> {
  const ran = await run(command, ['-version'], { timeoutMs: 10_000, maxBytes: 64 * 1024 })
  return firstLine(ran.outputs[0]?.toString('utf8') ?? '')
}

/** The API refused or didn't answer, rather than the file being unreadable. */
export function readFailed(stderr: string): boolean {
  return /Server returned [45]\d\d|Connection refused|Connection timed out|timed out|Network is unreachable|No route to host|I\/O error/i.test(
    stderr,
  )
}

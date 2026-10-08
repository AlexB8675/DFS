import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'

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
const MAX_ERROR_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 60_000
/** ffmpeg's time for one read from the API, in microseconds. */
const READ_TIMEOUT_US = 30_000_000
/** As low as a process can go, so the VPS's other work comes first. */
const LOWEST_PRIORITY = 19

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
    '-protocol_whitelist',
    ALLOWED_PROTOCOLS.join(','),
    '-format_whitelist',
    ALLOWED_FORMATS.join(','),
    '-rw_timeout',
    String(READ_TIMEOUT_US),
    '-headers',
    `Authorization: Bearer ${token}\r\n`,
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
  const ran = await run(
    options.command ?? 'ffprobe',
    probeArguments(url, token),
    options.timeoutMs ?? PROBE_TIMEOUT_MS,
  )
  // Slow reads from Discord can take this long: not the file's fault.
  if (ran.timedOut) throw new ProbeError('ffprobe took too long.', true)
  if (ran.tooLarge) throw new ProbeError('ffprobe’s answer was too large.', false)
  if (ran.code !== 0) {
    const message = firstLine(ran.stderr) || `ffprobe exited with ${String(ran.code)}`
    throw new ProbeError(message, readFailed(ran.stderr))
  }
  try {
    return JSON.parse(ran.stdout) as unknown
  } catch {
    throw new ProbeError('ffprobe gave an answer that isn’t JSON.', false)
  }
}

/** The first line of `ffprobe -version`: which ffmpeg this is. */
export async function ffmpegVersion(command = 'ffprobe'): Promise<string> {
  const ran = await run(command, ['-version'], 10_000)
  return firstLine(ran.stdout)
}

/** The API refused or didn't answer, rather than the file being unreadable. */
function readFailed(stderr: string): boolean {
  return /Server returned [45]\d\d|Connection refused|Connection timed out|timed out|Network is unreachable|No route to host|I\/O error/i.test(
    stderr,
  )
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim().slice(0, 300) ?? ''
}

interface Ran {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  tooLarge: boolean
}

function run(command: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, LOWEST_PRIORITY)
      } catch {
        // Not allowed here: it runs at the priority it has.
      }
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let tooLarge = false
    child.stdout.on('data', (data: Buffer) => {
      outBytes += data.length
      if (outBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true
        child.kill('SIGKILL')
        return
      }
      out.push(data)
    })
    child.stderr.on('data', (data: Buffer) => {
      errBytes += data.length
      if (errBytes <= MAX_ERROR_BYTES) err.push(data)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: tooLarge ? '' : Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        timedOut,
        tooLarge,
      })
    })
  })
}

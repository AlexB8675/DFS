// ffprobe, as the corpus suites run it (DESIGN.md §10.4): the file is read by
// FFmpeg's own MP4 demuxer, whose view of the same tables is what the reader's is
// compared with. Its output is cached in the corpus folder, keyed by the file's
// path, size and modification time and by the arguments, because a large video
// takes minutes to list and does not change. ffmpeg decodes what the writer
// writes, to prove that its init segments are whole. Tests and scripts only.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { cacheDir, manifestKey } from './corpus.ts'

/** One packet of `-show_entries packet=pos,size,dts,pts,flags`, as ffprobe's JSON has it: sizes and positions are strings, times are numbers in the stream's time base. */
export interface ProbePacket {
  pos?: string
  size?: string
  dts?: number
  pts?: number
  flags?: string
}

/** The fields of `-show_streams` that the suites read. */
export interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  codec_tag_string?: string
  mime_codec_string?: string
  time_base?: string
  /** A number, or the string "N/A" when ffprobe has none. */
  start_pts?: number | string
  /** Seconds as text, or "N/A". */
  start_time?: string
  width?: number
  height?: number
  channels?: number
  sample_rate?: string
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}

/** A time base such as `1/90000` as the length of a tick in seconds, or null when it is not one (ffprobe prints `N/A`, and a base of 1/0 is none). */
function tickSeconds(timeBase: string | undefined): number | null {
  const parts = /^(\d+)\/(\d+)$/.exec(timeBase ?? '')
  const [n, d] = [Number(parts?.[1]), Number(parts?.[2])]
  return parts && n > 0 && d > 0 ? n / d : null
}

/**
 * Where ffprobe says a stream starts, in seconds, with the edit list applied: its
 * start in ticks of the time base when it has one, else its start time. Null
 * when it says neither as a number: ffprobe prints `N/A` as a string for a start
 * it doesn't have, and `Number('N/A')` is not a number to compare with.
 */
export function streamStart(stream: ProbeStream): number | null {
  const tick = tickSeconds(stream.time_base)
  if (typeof stream.start_pts === 'number' && Number.isFinite(stream.start_pts) && tick !== null) {
    return stream.start_pts * tick
  }
  const text = stream.start_time
  if (typeof text === 'string' && text.trim() !== '' && Number.isFinite(Number(text))) {
    return Number(text)
  }
  return null
}

/** A leb128 number at `at` (IAMF v1.0 §3.2) and how many bytes it takes, or null when it is cut short or takes more than 8. */
function leb128At(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  let value = 0
  for (let length = 1; length <= 8; length += 1) {
    const byte = bytes[at + length - 1]
    if (byte === undefined) return null
    value += (byte & 0x7f) * 128 ** (length - 1)
    if ((byte & 0x80) === 0) return { value, length }
  }
  return null
}

/**
 * The size of the packet that FFmpeg lists for a sample of an IAMF sound. A
 * sample of an `iamf` entry is an OBU (IAMF v1.0 §3.2), and what FFmpeg gives
 * as its packet is the codec's own, which is the Audio Frame OBU's payload: not
 * the OBU's header, its size, the trimming of the samples at its end and at its
 * start, the extension header, or (for type 5, whose substream is not in the
 * type) the substream's ID. Null when the sample is not one Audio Frame OBU
 * (types 5 to 23) or its sizes do not add up; FFmpeg's packet is then not
 * something this can name.
 */
export function iamfPacketSize(sample: Uint8Array): number | null {
  const header = sample[0]
  if (header === undefined) return null
  const type = header >> 3
  if (type < 5 || type > 23) return null
  const size = leb128At(sample, 1)
  if (!size) return null
  const at = 1 + size.length
  if (at + size.value !== sample.length) return null
  // The fields that come before the payload, counted from the OBU's own size.
  let before = 0
  const skipNumber = (): boolean => {
    const number = leb128At(sample, at + before)
    if (!number) return false
    before += number.length
    return true
  }
  if ((header & 2) !== 0 && !(skipNumber() && skipNumber())) return null
  if ((header & 1) !== 0) {
    const extension = leb128At(sample, at + before)
    if (!extension) return null
    before += extension.length + extension.value
  }
  if (type === 5 && !skipNumber()) return null
  return before <= size.value ? size.value - before : null
}

/**
 * Runs a program (ffprobe) with its output in `outPath`. Rejects with its
 * complaint when it fails, and with a sentence that says so when it can't be run
 * at all (not installed, not on the PATH). The output file is closed once, by
 * whichever of the program's events comes first: a program that can't be run
 * emits an error and then a close.
 */
export function runToFile(program: string, args: string[], outPath: string): Promise<void> {
  return new Promise((done, fail) => {
    const fd = openSync(outPath, 'w')
    let finished = false
    const finish = (then: () => void): void => {
      if (finished) return
      finished = true
      closeSync(fd)
      then()
    }
    const child = spawn(program, args, { stdio: ['ignore', fd, 'pipe'] })
    let complaint = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (complaint.length < 4000) complaint += chunk.toString()
    })
    child.on('error', (error) => {
      finish(() => {
        fail(
          new Error(
            `${program} could not be run (is it installed and on the PATH?): ${error.message}`,
          ),
        )
      })
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) done()
        else fail(new Error(`${program} ${args.join(' ')} failed (${code}): ${complaint}`))
      })
    })
  })
}

/** The most of a program's complaint that is kept: enough to say what went wrong, not a log. */
const COMPLAINT_CHARS = 4000

/**
 * Runs a program with its output thrown away: its exit code (null when it was
 * stopped by a signal) and what it wrote to stderr. Rejects with a sentence when
 * it can't be run at all (not installed, not on the PATH).
 */
export function runForComplaint(
  program: string,
  args: string[],
): Promise<{ code: number | null; complaint: string }> {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let complaint = ''
    let finished = false
    child.stderr.on('data', (chunk: Buffer) => {
      if (complaint.length < COMPLAINT_CHARS) complaint += chunk.toString()
    })
    // A program that can't be run emits an error and then a close: the first of them settles it.
    child.on('error', (error) => {
      if (finished) return
      finished = true
      fail(
        new Error(
          `${program} could not be run (is it installed and on the PATH?): ${error.message}`,
        ),
      )
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      done({ code, complaint: complaint.slice(0, COMPLAINT_CHARS) })
    })
  })
}

/**
 * What is wrong with an ffmpeg decode that ran as `-v error -xerror`, or null
 * when nothing is: a clean decode exits 0 and says nothing. An exit of 0 with
 * something said is a problem too, because a decoder that gives up on a packet
 * may say so and go on.
 */
export function decodeProblem(result: { code: number | null; complaint: string }): string | null {
  const said = result.complaint.trim()
  if (result.code === null) return 'ffmpeg was stopped before it ended'
  if (result.code !== 0) {
    return said === ''
      ? `ffmpeg exited with ${result.code}`
      : `ffmpeg exited with ${result.code}: ${said}`
  }
  return said === '' ? null : `ffmpeg exited with 0 but said: ${said}`
}

/**
 * Decodes a file with FFmpeg, every frame of the picture and of the sound it
 * would play, and throws the output away (`-f null -`): what is said of it is
 * `decodeProblem`'s, null when it decodes cleanly. This is what proves that an
 * init segment says what a decoder needs where no browser here plays the codec.
 */
export async function decodes(path: string): Promise<string | null> {
  return decodeProblem(
    await runForComplaint('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']),
  )
}

/**
 * ffprobe's JSON for `args` (the options before the file), cached. `cache` is
 * false for what is not worth keeping, such as the check of a temporary file.
 */
export async function probe(path: string, args: string[], cache = true): Promise<unknown> {
  mkdirSync(cacheDir, { recursive: true })
  const stat = statSync(path)
  const key = createHash('sha256')
    .update(JSON.stringify([manifestKey(path), stat.size, stat.mtimeMs, args]))
    .digest('hex')
    .slice(0, 40)
  const cached = resolve(cacheDir, `${key}.json`)
  if (!(cache && existsSync(cached))) {
    const partial = `${cached}.${process.pid}.partial`
    try {
      await runToFile('ffprobe', ['-v', 'error', ...args, '-of', 'json', path], partial)
      if (cache) renameSync(partial, cached)
      else return JSON.parse(readFileSync(partial, 'utf8')) as unknown
    } finally {
      rmSync(partial, { force: true })
    }
  }
  return JSON.parse(readFileSync(cached, 'utf8')) as unknown
}

/** The streams of a file with the edit lists applied, as ffprobe reads it by default. */
export async function probeStreams(path: string, cache = true): Promise<ProbeStream[]> {
  const out = (await probe(path, ['-show_streams'], cache)) as { streams?: ProbeStream[] }
  return out.streams ?? []
}

/**
 * The packets of the first picture (`v:0`) or sound (`a:0`) of a file, as the
 * file's tables list them: the edit list is ignored, so times are the raw ones.
 * With `intervals`, only what `-read_intervals` names.
 */
export async function probePackets(
  path: string,
  select: 'v:0' | 'a:0',
  intervals?: string,
): Promise<ProbePacket[]> {
  const out = (await probe(path, [
    '-ignore_editlist',
    '1',
    '-select_streams',
    select,
    ...(intervals ? ['-read_intervals', intervals] : []),
    '-show_entries',
    'packet=pos,size,dts,pts,flags',
  ])) as { packets?: ProbePacket[] }
  return out.packets ?? []
}

/**
 * The first `count` packets of the first picture or sound with the edit list
 * applied, as ffprobe reads it by default: `pts` is then in the edited timeline
 * (in the stream's ticks), where the raw ones are not. The interval is the first
 * 5 s and not `count` packets: ffprobe counts the container's packets, and in a
 * file whose sound is stored apart from its picture the other stream may have
 * none among the first ones. Fewer than `count` come back from a stream that
 * has fewer in 5 s (a sound of 1024-sample packets has 235).
 */
export async function probeEditedPackets(
  path: string,
  select: 'v:0' | 'a:0',
  count: number,
): Promise<ProbePacket[]> {
  const out = (await probe(path, [
    '-select_streams',
    select,
    '-read_intervals',
    '%+5',
    '-show_entries',
    'packet=pos,size,dts,pts,flags',
  ])) as { packets?: ProbePacket[] }
  return (out.packets ?? []).slice(0, count)
}

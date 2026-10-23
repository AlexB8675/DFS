// ffprobe, as the corpus suites run it (DESIGN.md §10.4): the file is read by
// FFmpeg's own MP4 demuxer, whose view of the same tables is what the reader's is
// compared with. Its output is cached in the corpus folder, keyed by the file's
// path, size and modification time and by the arguments, because a large video
// takes minutes to list and does not change. Tests and scripts only.

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

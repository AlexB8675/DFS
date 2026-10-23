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
  start_pts?: number
  start_time?: string
  width?: number
  height?: number
  channels?: number
  sample_rate?: string
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}

/** Runs ffprobe with its output in `outPath`; rejects with ffprobe's complaint when it fails. */
function runToFile(args: string[], outPath: string): Promise<void> {
  return new Promise((done, fail) => {
    const fd = openSync(outPath, 'w')
    const child = spawn('ffprobe', args, { stdio: ['ignore', fd, 'pipe'] })
    let complaint = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (complaint.length < 4000) complaint += chunk.toString()
    })
    child.on('error', (error) => {
      closeSync(fd)
      fail(error)
    })
    child.on('close', (code) => {
      closeSync(fd)
      if (code === 0) done()
      else fail(new Error(`ffprobe ${args.join(' ')} failed (${code}): ${complaint}`))
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
      await runToFile(['-v', 'error', ...args, '-of', 'json', path], partial)
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
 * (in the stream's ticks), where the raw ones are not.
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
    `%+#${count}`,
    '-show_entries',
    'packet=pos,size,dts,pts,flags',
  ])) as { packets?: ProbePacket[] }
  return out.packets ?? []
}

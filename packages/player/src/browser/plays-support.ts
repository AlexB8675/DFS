// What the plays suite shares between its files (DESIGN.md §10.4; the iron-clad spec §4.9): reading a corpus
// file's index over HTTP ranges (never a whole file), what the browser can play of it, the 64 bytes taken from a
// file at a known offset, and the measures of a start and a seek. Every read of a file's bytes here is
// `cache: 'no-store'`, so that the suite's own reads leave nothing in the browser's HTTP cache (which one of its
// tests looks into). The user's files are read in place through the play server, and nothing here keeps their bytes.

import { chooseEngineTracks } from '../engine/tracks.ts'
import { HEAD_BYTES } from '../limits.ts'
import { locateMoov, openSource } from '@dfs/mp4'
import type { Chunk, SourceIndex } from '@dfs/mp4'
import { keyframeGapSeconds } from '../testing/keyframes.ts'
import { frames } from './play-harness.ts'
import type { Play } from './play-harness.ts'
import { fileUrl } from './server.ts'
import type { Network, PlayFile } from './server.ts'

/** The reads that finding a file's index may take: far above what any file needs (`MAX_INDEX_READS` is the reader's own bound). */
const MAX_INDEX_READS = 40

/** The bytes [from, to] of the file, inclusive, by one Range request that the browser's cache is not asked to keep. */
export async function fetchRange(url: string, from: number, to: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${from}-${to}` },
    cache: 'no-store',
  })
  if (response.status !== 206 && response.status !== 200) {
    throw new Error(
      `The play server answered a read of bytes ${from} to ${to} with ${response.status}.`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** The index of a file, read as the engine reads it: the head, then each range that `openSource` asks for. */
export async function readIndex(
  file: PlayFile,
): Promise<{ index: SourceIndex; moovEnd: number | null }> {
  const url = fileUrl(file.id)
  const chunks: Chunk[] = [
    { start: 0, bytes: await fetchRange(url, 0, Math.min(HEAD_BYTES, file.size) - 1) },
  ]
  for (let reads = 0; reads <= MAX_INDEX_READS; reads += 1) {
    const step = openSource(chunks, file.size)
    if ('done' in step) {
      // Where an MP4's index ends, which the engine must hold before it can feed a frame.
      const first = chunks[0]
      const moovEnd =
        step.done.container === 'mp4' && first !== undefined
          ? (locateMoov(first.bytes, file.size)?.end ?? null)
          : null
      return { index: step.done, moovEnd }
    }
    const { start, end } = step.need
    chunks.push({ start, bytes: await fetchRange(url, start, Math.min(end, file.size) - 1) })
  }
  throw new Error(`The index of ${file.name} was not found in ${MAX_INDEX_READS} reads.`)
}

/** What a file is to the suite: its index, its length, and how far apart its keyframes are (null where the index does not say). */
export interface Facts {
  index: SourceIndex
  /** The offset at which an MP4's moov ends; null for Matroska. */
  moovEnd: number | null
  durationSeconds: number | null
  /** The longest stretch of the picture with no keyframe, from an MP4's frame table; null for Matroska, whose index keeps no table. */
  keyframeGap: number | null
  /** Why this browser's Media Source can't play the file (it takes none of a track's codec names); null when it can. */
  unplayable: string | null
}

/** The most keyframe spacing that holds a file to the one-second marks of the fast link: a second, and a frame or two of rounding. */
export const DENSE_KEYFRAME_SECONDS = 1.05

export async function factsOf(file: PlayFile): Promise<Facts> {
  const { index, moovEnd } = await readIndex(file)
  const durationSeconds = index.durationSeconds
  const keyframeGap =
    index.container === 'mp4' ? keyframeGapSeconds(index.video, index.durationSeconds) : null
  const chosen = chooseEngineTracks(index, (mime) => MediaSource.isTypeSupported(mime))
  return {
    index,
    moovEnd,
    durationSeconds,
    keyframeGap,
    unplayable: 'refusal' in chosen ? chosen.refusal : null,
  }
}

/** Whether a file is held to the fast link's one-second marks. */
export function isDense(facts: Facts): boolean {
  return facts.keyframeGap !== null && facts.keyframeGap <= DENSE_KEYFRAME_SECONDS
}

/** 64 bytes of a file, taken by a Range request to the server, at an offset near the middle that is not a run of one or two values. */
export const PROBE_BYTES = 64

export async function probeOf(file: PlayFile): Promise<{ offset: number; bytes: Uint8Array }> {
  const url = fileUrl(file.id)
  const middle = Math.floor(file.size / 2)
  for (let step = 0; step < 256; step += 1) {
    const offset = middle + step * 4096
    if (offset + PROBE_BYTES > file.size) break
    const bytes = await fetchRange(url, offset, offset + PROBE_BYTES - 1)
    if (new Set(bytes).size >= 32) return { offset, bytes }
  }
  throw new Error(`${file.name} has no run of ${PROBE_BYTES} varied bytes near its middle.`)
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The fast link: at least 100 Mbit/s with 20 ms to the first byte (a good home link), and at least twice the
 * file's own bit rate, so that it keeps up with a file that is heavier than 100 Mbit/s too (the hold rule, which
 * waits for what the rest of a video will take on a link slower than it, is the links' tests', not this one's).
 * The brief names no number; a link with no limit at all would be the machine's loopback.
 */
export const FAST_BYTES_PER_SECOND = 12_500_000
export const FAST_LATENCY_MS = 20

export function fastLink(file: PlayFile, durationSeconds: number): Network {
  const bitrate = durationSeconds > 0 ? file.size / durationSeconds : 0
  return {
    bandwidthBytesPerSecond: Math.max(FAST_BYTES_PER_SECOND, Math.ceil(bitrate * 2)),
    latencyMs: FAST_LATENCY_MS,
  }
}

/** One line per measured test, printed for the report: user files by their manifest name only, with no bytes. */
export function report(line: Record<string, unknown>): void {
  console.info(`PLAYS ${JSON.stringify(line)}`)
}

/**
 * The start's two times, in ms from `from`: the first frame the element shows, and the moving picture (spec goal 2):
 * the first frame shown after the clock has moved past where it began, while the element plays. A paused first
 * frame is not a moving picture.
 */
export async function startPicture(
  play: Play,
  from: number,
  limitMs = 40_000,
): Promise<{ firstFrameMs: number; movingMs: number }> {
  const { video } = play
  let firstFrameMs: number | null = null
  let began: number | null = null
  let framesAtMove: number | null = null
  for (;;) {
    if (play.resolved || play.rejection !== null) {
      throw new Error('The play ended while waiting for the moving picture of the start.', {
        cause: play.rejection?.reason,
      })
    }
    if (performance.now() - from > limitMs)
      throw new Error('Gave up waiting for the moving picture.')
    if (video.readyState >= 2 && frames(video) > 0) {
      firstFrameMs ??= performance.now() - from
      began ??= video.currentTime
      if (!video.paused && video.currentTime > began + 0.05) {
        framesAtMove ??= frames(video)
        if (frames(video) > framesAtMove) {
          return { firstFrameMs, movingMs: performance.now() - from }
        }
      }
    }
    await pause(5)
  }
}

/**
 * A play's timeline as lines for a failure's report: what the engine and the element did, and when (ms after the
 * play began). The samples are left out, and the appends and removals are counted by runs (a track, how many, from
 * when to when), with the element's and the engine's state at the end.
 */
export function timelineOf(play: Play): string[] {
  const left = new Set(['sample', 'storeLevel'])
  const lines: string[] = []
  let run: {
    type: string
    track: string
    count: number
    bytes: number
    from: number
    to: number
  } | null = null
  const flush = (): void => {
    if (run !== null) {
      lines.push(
        `${Math.round(run.from)}-${Math.round(run.to)} ${run.type} ${run.track} x${run.count} ${run.bytes} bytes`,
      )
    }
    run = null
  }
  for (const { at, event } of play.stamped) {
    if (left.has(event.type)) continue
    if (event.type === 'append' || event.type === 'remove') {
      const track = event.track
      const bytes = event.type === 'append' ? event.bytes : 0
      if (run !== null && run.type === event.type && run.track === track) {
        run.count += 1
        run.bytes += bytes
        run.to = at
      } else {
        flush()
        run = { type: event.type, track, count: 1, bytes, from: at, to: at }
      }
      continue
    }
    flush()
    lines.push(`${Math.round(at)} ${JSON.stringify(event)}`)
  }
  flush()
  for (const wait of play.waits) {
    lines.push(
      `wait ${Math.round(wait.from)} to ${wait.to === null ? 'open' : Math.round(wait.to)}`,
    )
  }
  const { video } = play
  const ranges = Array.from({ length: video.buffered.length }, (_, i) => [
    video.buffered.start(i),
    video.buffered.end(i),
  ])
  lines.push(
    `element at ${video.currentTime} readyState ${video.readyState} paused ${video.paused} ranges ${JSON.stringify(ranges)}`,
  )
  const last = play.stats.at(-1)
  if (last !== undefined) lines.push(`stats ${JSON.stringify(last)}`)
  return lines
}

// What the browser suites share (DESIGN.md §10.4, D45): the browser's own name, the
// table of what it plays applied to a file's tracks, a video on a media source
// with a SourceBuffer for each track as the player sets one up, a test that runs
// on one and ends with a skip where the browser has no decoder, and the checks of
// when a picture is shown. The MP4 suite (`plays.browser.test.ts`) and the
// Matroska suite (`matroska.browser.test.ts`) differ in how they come by the
// frames they append and nothing here is about that: a function takes the least
// of a track it needs (`Playable`, `Timed`), so that a `PlayTrack`, with its whole
// frame table, and a `MatroskaPlayTrack`, with the frames a suite has gathered,
// both fit. Every failure names the file, the track and the check.

import type { TestContext } from 'vitest'
import { server } from 'vitest/browser'
import { Mp4Error } from '../errors.ts'
import { initSegment, presentationSeconds } from '../index.ts'
import type { InitTrack, PlayTrack } from '../index.ts'
import type { CorpusFile } from '../testing/provided.ts'
import { appendAll, mediaErrorOf, mediaSourceOpened, waitUntil } from './media.ts'
import { supportVerdict } from './support.ts'
import type { Engine } from './support.ts'

/** How much of a file's start is read to find its index: the same 1 MiB that the player will fetch. */
export const HEAD_BYTES = 1024 * 1024
/** How much of each track is appended for a start, and past a seek's target for a seek, in seconds. */
export const START_SECONDS = 4
export const SEEK_AHEAD_SECONDS = 2
/** Where a start must have got to, how long it has to get there, and how many pictures it must have shown by then. */
export const REACH_SECONDS = 1.5
export const REACH_WITHIN_MS = 10_000
export const MIN_PICTURES = 30
/** The clock must have moved this far for a video to count as having started. */
export const STARTED_SECONDS = 0.1
/** How long a paused video is given to answer a new callback with the picture it already shows. */
export const SETTLE_MS = 250
/** A test reads, appends and plays some megabytes, and the biggest files tens of them. */
export const TEST_TIMEOUT_MS = 90_000

export const BROWSER =
  server.browser === 'chromium'
    ? 'Chrome'
    : server.browser === 'firefox'
      ? 'Firefox'
      : server.browser

/** The engine of the running browser, which the table of what browsers play (support.ts) is by. */
function engineOf(browser: string): Engine {
  if (browser === 'chromium' || browser === 'firefox') return browser
  throw new Error(
    `support.ts has a table for Chrome and Firefox only, and this browser is ${browser}.`,
  )
}

const ENGINE = engineOf(server.browser)

export type Kind = 'picture' | 'sound'
export type Part = Kind | 'file'

/** Fails the test with the file, the track and the check, and what was found. */
export function fail(file: string, part: Part, check: string, detail: string): never {
  throw new Error(`${file}, ${part}, ${check}: ${detail}`)
}

export function sentence(error: unknown): string {
  if (error instanceof Mp4Error) return `${error.message} (refused as '${error.reason}')`
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** Runs the step, and fails with the file, the track and the check if it throws or rejects. */
export async function guarded<T>(
  file: string,
  part: Part,
  check: string,
  work: () => Promise<T> | T,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    return fail(file, part, check, sentence(error))
  }
}

/** What a suite needs of a track to set a player up and to hold the browser to the table: its init segment's input, its names and its timing. A `PlayTrack` is one, and so is a `MatroskaPlayTrack`. */
export type Playable = InitTrack & Pick<PlayTrack, 'codec' | 'codecNames' | 'timing'>

/** The tracks of a file that play: the picture, and the sound if it has one. */
export interface PlayerTracks {
  video: Playable
  audio: Playable | null
}

/** What the checks of when a frame is shown need of a track: the frames and where they are in time. A `PlayTrack` is one; a Matroska track is one with the frames gathered so far in a table. */
export type Timed = Pick<PlayTrack, 'table' | 'timing'>

/** The MIME type that asks this browser's Media Source about one codec name of a track. */
function mimeTypeOf(kind: 'video' | 'audio', name: string): string {
  return `${kind}/mp4; codecs="${name}"`
}

/** The first of the track's names that this browser's Media Source takes, or null where it takes none. */
function acceptedName(kind: 'video' | 'audio', track: Playable): string | null {
  return (
    track.codecNames.find((name) => MediaSource.isTypeSupported(mimeTypeOf(kind, name))) ?? null
  )
}

/** The MIME type for a track the browser took (see `checkSupport`), for a SourceBuffer to be made with. */
function acceptedType(kind: 'video' | 'audio', track: Playable): string {
  const name = acceptedName(kind, track)
  if (name === null) {
    throw new Error(`${BROWSER}'s Media Source took none of ${track.codecNames.join(', ')}`)
  }
  return mimeTypeOf(kind, name)
}

/**
 * Holds the browser's answer for each of the file's tracks to the table of what it
 * plays (support.ts, `supportVerdict`) before the file plays. Every track is
 * judged before any is skipped, so that a wrong name of the sound is found though
 * the picture is one the browser doesn't take. A disagreement with the table, or a
 * family it lacks, fails the test; so does a browser that takes the track only by
 * a later name than the first, the RFC 6381 one, except for Firefox's `mp3`: Firefox
 * refuses `mp4a.6B` for MP3 in MP4 and takes it as `mp3`. A codec that the browser
 * and the table agree it doesn't take skips the test, saying so.
 */
export function checkSupport(ctx: TestContext, file: CorpusFile, tracks: PlayerTracks): void {
  const judged: [Kind, 'video' | 'audio', Playable][] = [['picture', 'video', tracks.video]]
  if (tracks.audio) judged.push(['sound', 'audio', tracks.audio])
  let skip: string | undefined
  for (const [part, kind, track] of judged) {
    const verdict = supportVerdict(track, ENGINE, BROWSER, acceptedName(kind, track))
    if (verdict.outcome === 'fail') fail(file.name, part, 'the codec table', verdict.reason)
    if (verdict.outcome === 'skip') skip ??= verdict.reason
  }
  if (skip !== undefined) ctx.skip(skip)
}

/** A video element on a media source, with a SourceBuffer for each track and its init segment appended, as the player sets one up. */
export interface Player {
  video: HTMLVideoElement
  mediaSource: MediaSource
  picture: SourceBuffer
  sound: SourceBuffer | null
  /** The sequence number of the next fragment of each track: they increase from 1. */
  next: { picture: number; sound: number }
  close: () => void
}

export async function openPlayer(file: CorpusFile, tracks: PlayerTracks): Promise<Player> {
  const mediaSource = new MediaSource()
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  document.body.append(video)
  const objectUrl = URL.createObjectURL(mediaSource)
  const close = (): void => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(objectUrl)
  }
  try {
    const opened = mediaSourceOpened(video, mediaSource)
    video.src = objectUrl
    await guarded(file.name, 'file', 'opening the media source', () => opened)

    // Both buffers are added before either has its init segment: the video reaches its metadata once every buffer has one.
    const picture = await guarded(file.name, 'picture', 'adding its SourceBuffer', () =>
      mediaSource.addSourceBuffer(acceptedType('video', tracks.video)),
    )
    const sound = await guarded(file.name, 'sound', 'adding its SourceBuffer', () =>
      tracks.audio ? mediaSource.addSourceBuffer(acceptedType('audio', tracks.audio)) : null,
    )
    const buffers: [SourceBuffer, Playable, Kind][] = [[picture, tracks.video, 'picture']]
    if (sound && tracks.audio) buffers.push([sound, tracks.audio, 'sound'])
    for (const [buffer, track, part] of buffers) {
      await guarded(file.name, part, 'setting its timestampOffset and appendWindowEnd', () => {
        buffer.timestampOffset = track.timing.offsetSeconds
        if (track.timing.endSeconds !== null) buffer.appendWindowEnd = track.timing.endSeconds
      })
    }
    await Promise.all(
      buffers.map(([buffer, track, part]) =>
        guarded(file.name, part, 'appending its init segment', () =>
          appendAll(buffer, [initSegment(track)]),
        ),
      ),
    )
    return { video, mediaSource, picture, sound, next: { picture: 1, sound: 1 }, close }
  } catch (error) {
    close()
    throw error
  }
}

/**
 * When the first of frames [from, to) is shown, in seconds with the track's offset
 * applied, and not before 0: a frame that ends before 0 (AAC priming, Opus pre-skip)
 * is cut by the buffer's append window, as ffprobe trims it.
 */
export function firstShown(track: Timed, from: number, to: number): number {
  let least = Infinity
  for (let i = from; i < to; i += 1) {
    least = Math.min(least, presentationSeconds(track.table, track.timing, i))
  }
  return Math.max(least, 0)
}

/** How long the track's first frame lasts, in seconds: the tolerance of its start. */
export function firstFrameSeconds(track: Timed): number {
  return (track.table.durations[0] ?? 0) / track.table.timescale
}

/** How the player stands, for a failure's sake: the media source's state, the video's error, what is buffered. */
export function standing(player: Player): string {
  const sound = player.sound ? ranges(player.sound.buffered) : 'no sound'
  return `page ${document.visibilityState}, media source ${player.mediaSource.readyState}, ${mediaErrorOf(player.video)?.message ?? 'no MediaError'}, readyState ${player.video.readyState}, picture buffered ${ranges(player.picture.buffered)}, sound buffered ${sound}`
}

/** The first buffered second of a SourceBuffer, which must have some. */
export function bufferedStart(file: string, part: Part, buffer: SourceBuffer): number {
  if (buffer.buffered.length === 0) {
    fail(
      file,
      part,
      'buffering',
      'its SourceBuffer holds nothing after the fragments were appended',
    )
  }
  return buffer.buffered.start(0)
}

function ranges(buffered: TimeRanges): string {
  const out: string[] = []
  for (let i = 0; i < buffered.length; i += 1) {
    out.push(`${buffered.start(i).toFixed(3)}-${buffered.end(i).toFixed(3)}`)
  }
  return out.length === 0 ? 'none' : out.join(', ')
}

/** How many of the picture's frames are shown at or before the time. */
export function picturesBy(track: Timed, seconds: number): number {
  let count = 0
  for (let i = 0; i < track.table.count; i += 1) {
    if (presentationSeconds(track.table, track.timing, i) <= seconds) count += 1
  }
  return count
}

/**
 * The picture a seek to `target` should show, by the table: the one shown at the
 * target (the last shown at or before it) is `covering`; `expected` is the first
 * shown at or after half a frame before the target, as the brief puts it; and
 * `half` is half the covering frame's duration, the tolerance.
 */
export function pictureAt(
  track: Timed,
  target: number,
): { covering: number; expected: number; half: number } {
  const { table, timing } = track
  let covering = -Infinity
  let coveringDuration = 0
  for (let i = 0; i < table.count; i += 1) {
    const shown = presentationSeconds(table, timing, i)
    if (shown <= target && shown > covering) {
      covering = shown
      coveringDuration = (table.durations[i] ?? 0) / table.timescale
    }
  }
  const half = coveringDuration / 2
  let expected = Infinity
  for (let i = 0; i < table.count; i += 1) {
    const shown = presentationSeconds(table, timing, i)
    if (shown >= target - half && shown < expected) expected = shown
  }
  return { covering, expected, half }
}

/** What a test ends with besides passing or failing: a reason to skip it, said after the player is closed. */
export type Outcome = undefined | { skip: string }

/**
 * Whether the browser is Firefox without a window and the picture is HEVC: Firefox
 * says it can take HEVC, makes no decoder for it in that setting, and gives the
 * video a decode error ("RemoteMediaManager is not available"), after which the
 * source buffers refuse more fragments. It plays once Firefox has a window
 * (`DFS_HEADED=1`): the spike of 2026-10-22. This is the one failure that is
 * the browser's and not the output's, and any other fails the test.
 */
export function noDecoderHere(tracks: PlayerTracks): boolean {
  return (
    server.browser === 'firefox' &&
    server.config.browser.headless &&
    /^(hvc1|hev1)\./.test(tracks.video.codec)
  )
}

/** The reason to skip a test for the one browser setting that says it plays HEVC and has no decoder for it (see `noDecoderHere`). */
export function neverStarted(tracks: PlayerTracks, player: Player): string {
  return `${BROWSER} claims ${tracks.video.codec} but never started playing here (headless Firefox decodes HEVC only with a window: DFS_HEADED=1) [${standing(player)}]`
}

/**
 * Opens a player for the file's tracks, runs the test's work on it, and closes it
 * (a test left open would keep its decoders from the ones after it). The work
 * may end with a reason to skip; and a failure that leaves the video with a
 * decode error, in the one browser setting that has no decoder for the codec
 * (see `noDecoderHere`), is a skip with that reason too.
 */
export async function withPlayer(
  ctx: TestContext,
  file: CorpusFile,
  tracks: PlayerTracks,
  work: (player: Player) => Promise<Outcome>,
): Promise<void> {
  const player = await openPlayer(file, tracks)
  let outcome: Outcome
  try {
    outcome = await work(player)
  } catch (error) {
    // The decode error may come a moment after the append that it makes fail.
    if (noDecoderHere(tracks)) await waitUntil(() => player.video.error !== null, 1000)
    if (noDecoderHere(tracks) && player.video.error?.code === MediaError.MEDIA_ERR_DECODE) {
      outcome = { skip: neverStarted(tracks, player) }
    } else {
      throw error
    }
  } finally {
    // The reason to skip was worked out while the player was open: `standing` is read before this.
    player.close()
  }
  if (outcome) ctx.skip(outcome.skip)
}

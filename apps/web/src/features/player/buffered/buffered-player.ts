// Plays a video that the browser's own media cache can't keep up with
// (DESIGN.md §10.4). Firefox's cache for a `<video src>` drops to 32 MB on
// mobile data, about 2 s of a 120 Mbit/s phone video, and thrashes there. Media
// Source keeps up to about 150 MB that DFS fills itself, so the player reads the
// file's bytes, lets mp4box split them into fragments and appends those. It
// opens the video first: it finds the index, checks the codecs and gives the
// browser the init segments. Then it streams the rest of the file, holding the
// reading back while enough is buffered ahead of the playhead, dropping what
// was played, only at a keyframe, to make room, and opening the stream again
// where it broke off. The stream can also start again from any byte offset, and
// stays open after the end of the file for that: the play lasts until the caller
// aborts it or it fails. When the viewer seeks to a time that isn't buffered, the
// player drops what it has and streams from the keyframe before that time; and
// the play can begin at a time other than the start. The browser is not given
// the segments as they come: they are held back until enough is queued to play
// without stopping, at the start, after such a seek and after a stall, and then
// let go all at once, as YouTube's player does.

import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Track } from 'mp4box'
import { AppendQueue } from './append-queue'
import { mediaLayout, type MediaLayout } from './boxes'
import {
  aheadSeconds,
  bufferingGoal,
  bufferTargets,
  keyframeAtOrBefore,
  keyframeTimes,
  longestKeyframeGap,
  mimeOf,
  samplesPerSegment,
  type HoldReason,
} from './tracks'

export interface BufferedStats {
  phase: 'opening' | 'buffering' | 'ended' | 'failed'
  /** Codec strings of the tracks mp4box read, which play unless `supported` says no. */
  codecs: string[]
  /** Each SourceBuffer MIME type, and whether `MediaSource.isTypeSupported` said yes. */
  supported: Record<string, boolean>
  bytesReceived: number
  /** Time spent waiting on the network for the next piece. */
  readingMs: number
  /** Time reading was held back because enough was buffered. */
  heldMs: number
  aheadSeconds: number
  targetAheadSeconds: number
  /** The longest stretch of the video without a keyframe; 0 until known. */
  keyframeGapSeconds: number
  quotaErrors: number
  /** Times the stream was opened again after it broke off. */
  reopens: number
  /** Seeks to a time that wasn't buffered, which started the stream again there. */
  seeks: number
  /** Whether the segments are held back until enough is queued to play without stopping. */
  holding: boolean
  /** Holds that ended in playing: enough was queued, or the whole file was fed. */
  holds: number
  /** Time spent in the holds that ended. */
  holdMs: number
  segments: number
  error: string | null
}

export interface BufferedPlayOptions {
  video: HTMLVideoElement
  /** The file's bytes, from a route that answers `Range`: the content route. */
  url: string
  signal: AbortSignal
  /** Seconds into the video to begin at; 0 or missing is the start. */
  startAt?: number
  /**
   * Called with fresh numbers twice a second, and once more when the whole file
   * is appended or the play fails.
   */
  onStats: (stats: BufferedStats) => void
}

/** Everything `streamSamples` needs of the opening. */
interface StreamContext {
  options: BufferedPlayOptions
  /** Aborted when the caller aborts or the play fails: the play is over. */
  signal: AbortSignal
  file: ISOFile
  layout: MediaLayout
  fileSize: number
  durationSeconds: number
  /** The file's average rate. */
  bytesPerSecond: number
  /** Whether only sound is played, which can be cut anywhere. */
  soundOnly: boolean
  /** File offset where the first run begins: the start of the samples, or the keyframe before `startAt`. */
  firstOffset: number
  /** The video's keyframes in seconds, ascending; empty when only sound is played. */
  keyframes: readonly number[]
  /** The longest stretch of the video without a keyframe; 1 when only sound is played. */
  keyframeGapSeconds: number
  mediaSource: MediaSource
  /** One for each track played, the video's first. */
  queues: AppendQueue[]
  /** The wait for enough to be queued; it holds the queues. */
  holds: Holds
  stats: BufferedStats
  emit: () => void
  /** Ends the play with `message` shown. */
  fail: (message: string) => void
  /** What the queues call when a buffer is full. `streamSamples` puts its handling in `handle`. */
  quota: { handle: () => void }
  /**
   * Starts the stream again at file offset `offset`: drops what was collected and
   * ends the run under way, and a new one reads from there. `streamSamples`
   * puts its handling here, and it does nothing once the play is over.
   */
  restart: (offset: number) => void
}

/** How much of the file is read first, to find the index and learn the file's size. */
const HEAD_BYTES = 64 * 1024

/** How long mp4box has to read the index once it has all of it. */
const READY_TIMEOUT_MS = 15_000

const STATS_INTERVAL_MS = 500

/** The most bytes queued for the buffers and not yet appended while reading goes on. */
const MAX_PENDING_BYTES = 32 * 1024 * 1024

/** How long a held-back reading waits before it looks again, if no `timeupdate` comes first. */
const HOLD_RECHECK_MS = 250

/** A video element's `readyState` once it has the data for the frame at the playhead. */
const HAVE_CURRENT_DATA = 2

/** How long the file has been read before the link's speed is worked out from it. */
const LINK_MIN_READING_MS = 500

/**
 * The most of the buffer's target that is waited for. Reading stops once the
 * target is reached, so a goal at the target would be met only by chance.
 */
const GOAL_SHARE_OF_TARGET = 0.9

/** What was played is dropped at most this often. */
const TRIM_INTERVAL_MS = 1000

/**
 * How much earlier than a keyframe a cut is made (see `makeRoomBehind`).
 * B-frame composition delays and edit lists shift the presentation times by a
 * few frames, so a keyframe sits a little earlier in Media Source than its time
 * in the index. Half a second covers that, and only keeps a little more behind.
 */
const CUT_MARGIN_SECONDS = 0.5

/** How long after a quota error the full buffers are tried again, if no `timeupdate` comes first. */
const QUOTA_RETRY_MS = 500

/**
 * How far past a keyframe's time mp4box is asked to seek, so that the rounding
 * of a time can't put the seek before the keyframe, which is a group of frames early.
 */
const KEYFRAME_SLACK_SECONDS = 0.0005

/**
 * How near `startAt` the browser's first seek must be to count as that seek,
 * which the stream is already on its way to, not as the viewer's.
 */
const SAME_START_SECONDS = 0.01

/** How long to wait before the stream is opened again after it broke off. */
const REOPEN_WAIT_MS = 1000

/** How many times in a row the stream is opened again with no bytes coming in between. */
const MAX_REOPENS = 5

/**
 * How many bytes are collected before they are given to mp4box: fewer, larger
 * calls, as the connection hands out pieces of 16 to 64 KB, which would be
 * hundreds of calls a second at 120 Mbit/s. A megabyte is under 0.1 s of such a video.
 */
const FEED_BYTES = 1024 * 1024

/**
 * How much of a track goes in each segment. Segments are cut by sample count,
 * not at keyframes: half a second at 120 Mbit/s is 7.5 MB, which every Media
 * Source takes, whereas segments cut only at keyframes (5.6 s apart in some
 * phone videos) would be 80 MB.
 */
const SEGMENT_SECONDS = 0.5

/** `bytes` as an ArrayBuffer of exactly its bytes, which a view may be only part of. */
function exactBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes
  if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer
  return buffer.slice(byteOffset, byteOffset + byteLength)
}

/**
 * The queue given to `setSegmentOptions`, which mp4box hands back as an `unknown`
 * user; `null` for a track that isn't played, which was given no queue.
 */
function queueOf(user: unknown): AppendQueue | null {
  return user instanceof AppendQueue ? user : null
}

/**
 * Bytes `start` to `end` (included) of `url`, and the whole file's size from
 * `Content-Range`. `null` when the server didn’t answer a byte range, which is
 * checked before the body is read: a server that ignores `Range` sends it all.
 */
async function fetchRange(url: string, start: number, end: number, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
  const size = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1]
  if (response.status !== 206 || size === undefined) {
    void response.body?.cancel()
    return null
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), size: Number(size) }
}

/**
 * Places mp4box so that its next segments start at the keyframe at or before
 * `time`, and gives the file offset to read from; `null` when no track seeks
 * there. mp4box does two things on its own that this makes up for:
 * - Every track is placed at the keyframe, not at `time`. Sound placed at `time`
 *   skips the samples between the two, and the buffers mp4box holds with bytes it
 *   never used stay for good: a keyframe gap's worth of the file for each seek.
 * - It releases samples counting up from the last one released and doesn't go
 *   back, so after a seek back the samples of the first segment would stay in memory.
 *   That holds for every track mp4box segments, `segmented`, played or not.
 * Sound alone has no keyframes and is placed at `time`, held to the end of the
 * sound: mp4box places no track past its end, and then none at all.
 */
function placeAt(
  file: ISOFile,
  played: readonly Track[],
  segmented: readonly Track[],
  keyframes: readonly number[],
  time: number,
): number | null {
  const target =
    keyframes.length > 0
      ? keyframeAtOrBefore(keyframes, time) + KEYFRAME_SLACK_SECONDS
      : Math.min(time, ...played.map((track) => file.getTrackDuration(file.getTrackById(track.id))))
  const { offset } = file.seek(target, true)
  if (!Number.isFinite(offset)) return null
  for (const track of segmented) {
    const trak = file.getTrackById(track.id)
    trak.lastValidSample = Math.min(trak.lastValidSample || 0, trak.nextSample)
  }
  return offset
}

/**
 * Plays `url` in `video` through Media Source, buffering it itself (§10.4).
 * The play stays open after the whole file is appended, with the phase
 * 'ended', as the stream may start again from any point. It resolves only once
 * the play is over: when `signal` aborts, quietly, or when it fails. A failure
 * is a result, shown in the stats and never thrown.
 */
export async function playBuffered(options: BufferedPlayOptions): Promise<void> {
  const { video, url } = options
  if (options.signal.aborted) return

  const stats: BufferedStats = {
    phase: 'opening',
    codecs: [],
    supported: {},
    bytesReceived: 0,
    readingMs: 0,
    heldMs: 0,
    aheadSeconds: 0,
    targetAheadSeconds: 0,
    keyframeGapSeconds: 0,
    quotaErrors: 0,
    reopens: 0,
    seeks: 0,
    holding: false,
    holds: 0,
    holdMs: 0,
    segments: 0,
    error: null,
  }
  const emit = (): void => {
    stats.aheadSeconds = aheadSeconds(video.buffered, video.currentTime)
    options.onStats({ ...stats })
  }

  // Failing aborts `signal` too, which stops what is being fetched and waited for.
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const over = (): boolean => signal.aborted
  const { promise: stopped, resolve: stop } = Promise.withResolvers<undefined>()
  const onAbort = (): void => {
    stop(undefined)
  }
  signal.addEventListener('abort', onAbort)

  const fail = (message: string): void => {
    if (over()) return
    stats.phase = 'failed'
    stats.error = message
    emit()
    controller.abort()
  }
  /** What `promise` settles with, or `undefined` once the play is over. */
  const until = async <T>(promise: Promise<T>): Promise<T | undefined> => {
    const value = await Promise.race([promise, stopped.then(() => undefined)])
    return over() ? undefined : value
  }
  /** Reads a range, counting the bytes and the time spent waiting for them. */
  const read = async (start: number, end: number) => {
    const began = performance.now()
    const part = await fetchRange(url, start, end, signal)
    stats.readingMs += performance.now() - began
    if (part) stats.bytesReceived += part.bytes.length
    return part
  }

  // Whether the video has shown a frame yet, which a stall can only follow. `loadeddata` says so
  // (`onLoadedData`); this catches it should that event have gone by.
  let frameShown = false
  const interval = setInterval(() => {
    if (video.readyState >= HAVE_CURRENT_DATA) frameShown = true
    emit()
  }, STATS_INTERVAL_MS)
  const onVideoError = (): void => {
    // The message is often empty, and then nothing is said of what went wrong.
    const message = video.error?.message ?? ''
    fail(message.length > 0 ? message : 'The video element failed.')
  }
  video.addEventListener('error', onVideoError)
  // Removes the listeners added once the play is set up (`seeking`, `waiting`, `loadeddata`)
  // on any way out.
  const listening = new AbortController()

  try {
    // 1. The head, which tells the file's size, and 2. where its index is.
    const head = await read(0, HEAD_BYTES - 1)
    if (!head) {
      fail('The server didn’t answer a byte range.')
      return
    }
    const fileSize = head.size
    const layout = mediaLayout(head.bytes, fileSize)
    if (!layout) {
      fail('Not an MP4 this player can split.')
      return
    }

    // 3. mp4box, which keeps the samples (it drops them by default, and then splits nothing).
    const file = createFile(true)
    const ready = new Promise<Movie>((resolve) => {
      file.onReady = resolve
    })
    file.onError = (_module, message) => {
      fail(`mp4box: ${message}`)
    }

    // 4. The head and the index, wherever the index is.
    const append = (bytes: Uint8Array<ArrayBuffer>, fileStart: number): void => {
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(exactBuffer(bytes), fileStart))
    }
    append(head.bytes, 0)
    if (layout.moov.end > head.bytes.length) {
      const moovFrom = Math.max(layout.moov.start, head.bytes.length)
      const moov = await read(moovFrom, layout.moov.end - 1)
      if (!moov) {
        fail('The server didn’t answer a byte range.')
        return
      }
      append(moov.bytes, moovFrom)
    }

    // 5. mp4box says when it has read the index.
    const timer = setTimeout(() => {
      fail('mp4box couldn’t read the index.')
    }, READY_TIMEOUT_MS)
    const info = await until(ready)
    clearTimeout(timer)
    if (!info) return

    // 6. What the browser accepts. A track it can't play is left out, but the picture is needed.
    const videoTrack = info.videoTracks.at(0)
    const tracks = [videoTrack, info.audioTracks.at(0)].filter(
      (track): track is Track => track !== undefined,
    )
    for (const track of tracks) {
      stats.supported[mimeOf(track)] = MediaSource.isTypeSupported(mimeOf(track))
    }
    stats.codecs = tracks.map((track) => track.codec)
    emit()
    if (videoTrack && !stats.supported[mimeOf(videoTrack)]) {
      fail(`This browser can’t play ${videoTrack.codec} through Media Source.`)
      return
    }
    const played = tracks.filter((track) => stats.supported[mimeOf(track)])
    const first = played.at(0)
    if (!first) {
      fail('There is nothing in this file the browser can play.')
      return
    }

    // 7. The MediaSource, whose duration is set before any buffer is made.
    const durationSeconds = info.duration / info.timescale
    const mediaSource = new MediaSource()
    const opened = new Promise<Event>((resolve) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true })
    })
    video.src = URL.createObjectURL(mediaSource)
    if (!(await until(opened))) return
    mediaSource.duration = durationSeconds
    // The picture can only be cut at a keyframe. Sound alone can be cut anywhere.
    const keyframes = videoTrack ? keyframeTimes(file.getTrackSamplesInfo(videoTrack.id)) : []
    const keyframeGapSeconds = videoTrack ? longestKeyframeGap(keyframes, durationSeconds) : 1
    stats.keyframeGapSeconds = keyframeGapSeconds
    // mp4box wants the same sample count for every track. The picture's sets it,
    // and the sound's segments, with their small samples, come out shorter.
    const nbSamples = samplesPerSegment(first, SEGMENT_SECONDS)
    // The queues are made before the streaming is, which fills in what happens on a full buffer.
    const quota = { handle: (): void => undefined }
    const queueOfTrack = new Map(
      played.map((track) => [
        track.id,
        new AppendQueue(mediaSource.addSourceBuffer(mimeOf(track)), () => {
          stats.quotaErrors += 1
          quota.handle()
        }),
      ]),
    )
    const queues = [...queueOfTrack.values()]
    const bytesPerSecond = fileSize / durationSeconds
    const holds = createHolds({ video, queues, stats, bytesPerSecond, durationSeconds, emit })
    // Every track is segmented, not only the played ones: mp4box frees a fed buffer only once
    // every byte in it was used, and a track nobody segments never has its samples read. Its
    // bytes would stay for good, and over a long video that is the whole file. An unplayed track
    // (a metadata track, sound the browser rejects) gets no queue, and its segments are dropped.
    // Samples, not keyframes, decide where a segment ends (see SEGMENT_SECONDS).
    for (const track of info.tracks) {
      file.setSegmentOptions(track.id, queueOfTrack.get(track.id) ?? null, {
        nbSamples,
        rapAlignement: false,
      })
    }

    // 8. The init segments, of the played tracks.
    file.onSegment = (id, user, buffer, nextSample) => {
      try {
        const queue = queueOf(user)
        queue?.append(buffer)
        file.releaseUsedSamples(id, nextSample)
        if (queue) stats.segments += 1
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    for (const { user, buffer } of file.initializeSegmentation('per-track')) {
      queueOf(user)?.append(buffer)
    }
    // Nothing else goes to the browser until enough is queued to play without stopping (§10.4).
    // The init segments went first: the browser needs them to tell the video's size and length.
    holds.start('start')

    // 9. Where mp4box and the stream begin: the first samples, or the keyframe before
    // `startAt`. mp4box is placed before `start()`, which gives out the samples it has already.
    let firstOffset = layout.stream.from
    // The time the browser's own first seek will be to, which the stream is already on its way to.
    let startedAt: number | null = null
    const startAt = Math.min(options.startAt ?? 0, durationSeconds)
    if (startAt > 0) {
      const offset = placeAt(file, played, info.tracks, keyframes, startAt)
      if (offset !== null) {
        firstOffset = offset
        startedAt = startAt
      }
      // Before the first frame this sets where the browser begins; it seeks there on its own.
      video.currentTime = startAt
    }
    file.start()

    // 10. The rest of the file, and the viewer's seeks while it is read.
    stats.phase = 'buffering'
    emit()
    const context: StreamContext = {
      options,
      signal,
      file,
      layout,
      fileSize,
      durationSeconds,
      bytesPerSecond,
      soundOnly: videoTrack === undefined,
      firstOffset,
      keyframes,
      keyframeGapSeconds,
      mediaSource,
      queues,
      holds,
      stats,
      emit,
      fail,
      quota,
      restart: () => undefined,
    }
    // A time that isn't buffered is read on from its keyframe, and what was queued or
    // buffered for the old position goes. The browser says `seeking` only once the init
    // segments are appended, long after `streamSamples` has put `context.restart` in place.
    const onSeeking = (): void => {
      if (over()) return
      // A queue's reset can throw (a buffer that was detached refuses `remove()`); the play
      // then fails and shows it, instead of stalling with no word.
      try {
        const time = video.currentTime
        const first = startedAt
        startedAt = null
        if (first !== null && Math.abs(time - first) < SAME_START_SECONDS) return
        // While a reset runs, `video.buffered` still shows the old position's ranges until its
        // removal ends. A quick second seek into them isn't to a time that is buffered: it would
        // do nothing, and the removal would clear the very part it needs, never to be fetched.
        if (queues.every((queue) => !queue.resetting) && aheadSeconds(video.buffered, time) > 0) {
          return
        }
        const offset = placeAt(file, played, info.tracks, keyframes, time)
        if (offset === null) return
        stats.seeks += 1
        // A queue cancels only an append under way; a removal under way ends first.
        for (const queue of queues) queue.reset(mediaSource.duration)
        // As at the start, nothing is appended until enough is queued. Before `file.start()`,
        // which may give segments out at once.
        holds.start('start')
        // A small file may be held by mp4box whole, and then no piece is left to come that
        // would make it give the segments of the samples it holds.
        file.start()
        context.restart(offset)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    video.addEventListener('seeking', onSeeking, { signal: listening.signal })
    // The video ran out of data while playing: waits for more than a start does, so that a
    // stall isn't followed at once by another. Not while paused, seeking (the seek holds), or
    // before the first frame (the start holds), and not once everything is fed or ended: nothing
    // more is coming, and a held queue would never be appended.
    const onWaiting = (): void => {
      if (over() || holds.holding || video.paused || video.seeking) return
      if (stats.phase === 'ended' || !frameShown) return
      try {
        holds.start('stall')
        holds.check()
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    const onLoadedData = (): void => {
      frameShown = true
    }
    video.addEventListener('waiting', onWaiting, { signal: listening.signal })
    video.addEventListener('loadeddata', onLoadedData, { signal: listening.signal })
    await streamSamples(context)
  } catch (error) {
    // An abort, the caller's or fail()'s, isn't a failure to show.
    if (!over()) fail(error instanceof Error ? error.message : String(error))
  } finally {
    clearInterval(interval)
    video.removeEventListener('error', onVideoError)
    listening.abort()
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Resolves after `ms`, or sooner: at once when `signal` aborts, or when `wake`
 * is fired at its `target`.
 */
function pause(
  ms: number,
  signal: AbortSignal,
  wake?: { target: EventTarget; event: string },
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const listening = new AbortController()
    const done = (): void => {
      clearTimeout(timer)
      listening.abort()
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { signal: listening.signal })
    wake?.target.addEventListener(wake.event, done, { signal: listening.signal })
  })
}

/** Resolves once `signal` has aborted. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      resolve()
    }
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
}

/** Stops a stream's connection, whatever state it is in. */
function release(stream: { cancel(): Promise<void> }): void {
  stream.cancel().catch(() => undefined)
}

/** The wait for enough to be queued before the video plays (see `createHolds`). */
interface Holds {
  /** Whether every queue is held, so that the browser is given nothing more. */
  readonly holding: boolean
  /**
   * Holds every queue, for a start (the opening, or a seek) or a stall. Holding
   * already, it only changes why: a seek during a stall waits as a start does.
   * A stall is ignored once the run has fed everything, and a start begins a
   * run that hasn't fed anything.
   */
  start: (reason: HoldReason) => void
  /** Seconds to have queued before the queues are released, for what the hold is for. */
  goalSeconds: () => number
  /** Releases the queues if enough is queued; to be called whenever more may be. */
  check: () => void
  /** The run has fed all of the file to mp4box: releases, as waiting longer gains nothing. */
  finish: () => void
}

/**
 * Makes the queues wait until enough is queued to play without stopping, as
 * YouTube's player does (§10.4): seconds enough for a start, more after a stall,
 * and then they are all let go at once. The goal comes from `bufferingGoal`, with
 * the link's speed as measured while reading, and is held under the buffer's
 * target, which the gate keeps in `stats.targetAheadSeconds`. The browser waits
 * meanwhile (a start) or has nothing more to play (a stall), so a pause doesn't
 * end the wait, and the queued seconds alone do.
 */
function createHolds(input: {
  video: HTMLVideoElement
  queues: readonly AppendQueue[]
  stats: BufferedStats
  bytesPerSecond: number
  durationSeconds: number
  emit: () => void
}): Holds {
  const { video, queues, stats, bytesPerSecond, durationSeconds, emit } = input
  let holding = false
  let reason: HoldReason = 'start'
  let since = 0
  /** Whether the run under way has fed all of the file: no stall can wait for more. */
  let fed = false

  const goalSeconds = (): number => {
    const target = stats.targetAheadSeconds
    const linkBytesPerSecond =
      stats.readingMs < LINK_MIN_READING_MS ? null : stats.bytesReceived / (stats.readingMs / 1000)
    const goal = bufferingGoal({
      reason,
      linkBytesPerSecond,
      bytesPerSecond,
      targetAheadSeconds: target,
      remainingSeconds: durationSeconds - video.currentTime,
    })
    return Math.min(goal, target * GOAL_SHARE_OF_TARGET)
  }
  /** Releases every queue: the video plays, or has all there is. */
  const end = (): void => {
    holding = false
    stats.holding = false
    stats.holds += 1
    stats.holdMs += performance.now() - since
    for (const queue of queues) queue.release()
    emit()
  }

  return {
    get holding() {
      return holding
    },
    start: (why) => {
      // A start comes with a run that has fed nothing yet.
      if (why === 'start') fed = false
      else if (fed) return
      reason = why
      if (holding) return
      holding = true
      since = performance.now()
      stats.holding = true
      for (const queue of queues) queue.hold()
      emit()
    },
    goalSeconds,
    check: () => {
      if (!holding) return
      const queued = queues.reduce((sum, queue) => sum + queue.pendingBytes, 0) / bytesPerSecond
      // The gate stops reading once what is buffered and queued reaches the target. The goal is
      // under the target, but not by what is already buffered: waiting for more than the gate lets
      // in would be for ever, so that ends the hold too. While a seek's removal runs,
      // `video.buffered` still shows the old position's ranges, which count for nothing.
      const resetting = queues.some((queue) => queue.resetting)
      const ahead = resetting ? 0 : aheadSeconds(video.buffered, video.currentTime)
      if (queued >= goalSeconds() || ahead + queued >= stats.targetAheadSeconds) end()
    },
    finish: () => {
      fed = true
      if (holding) end()
    },
  }
}

/**
 * Holds the reading back while enough is buffered, and handles a full buffer
 * (§10.4). `roomToRead(within)` resolves once the playhead has less than the
 * target buffered ahead, counting the bytes waiting to be appended as buffered,
 * and few enough of them wait, or sooner, once `within` aborts: a run that is
 * replaced mustn't stay held. The target is how far ahead to buffer for this
 * file's bit rate and keyframe gap, and a quota error lowers it. What was
 * played is dropped only at a keyframe. While the queues are held (see
 * `createHolds`) more may be queued, up to the goal. This puts its handling of
 * a quota error in `context.quota`.
 */
function createBufferGate(context: StreamContext): {
  roomToRead: (within: AbortSignal) => Promise<void>
} {
  const { options, signal, queues, stats, soundOnly, keyframes, bytesPerSecond, holds } = context
  const { video } = options
  const targets = bufferTargets(bytesPerSecond, context.keyframeGapSeconds)
  let target = targets.aheadSeconds
  stats.targetAheadSeconds = target
  let trimmedAt = Number.NEGATIVE_INFINITY
  let retrying = false

  const ahead = (): number => aheadSeconds(video.buffered, video.currentTime)
  /** What is queued will be buffered, so it counts as buffered now. */
  const hasRoom = (): boolean => {
    const pending = queues.reduce((sum, queue) => sum + queue.pendingBytes, 0)
    // The queued bytes don't play until the hold ends, so the goal has to fit.
    const maxPending = holds.holding
      ? Math.max(MAX_PENDING_BYTES, holds.goalSeconds() * bytesPerSecond + FEED_BYTES)
      : MAX_PENDING_BYTES
    return ahead() + pending / bytesPerSecond < target && pending < maxPending
  }
  /**
   * Where to cut to drop what was played before `time`: just before the last
   * keyframe at or before it, or at `time` for sound alone. With no keyframe
   * known for a video the cut is at 0 or less, and nothing is dropped.
   */
  const cutBefore = (time: number): number =>
    soundOnly ? time : keyframeAtOrBefore(keyframes, time) - CUT_MARGIN_SECONDS
  /**
   * Drops what was played, further back than is kept, at most once a second.
   * Media Source drops the frames that depend on what is removed, up to the next
   * keyframe, so a cut just before a keyframe drops nothing that is still
   * needed. The margin covers the times being shifted a little.
   */
  const makeRoomBehind = (): void => {
    const cut = cutBefore(video.currentTime - targets.behindSeconds)
    if (cut <= 0 || performance.now() - trimmedAt < TRIM_INTERVAL_MS) return
    trimmedAt = performance.now()
    for (const queue of queues) queue.removeBefore(cut)
  }
  /** Waits for the playhead to move, a little while, or until `within` (the play) aborts. */
  const wait = (ms: number, within: AbortSignal = signal): Promise<void> =>
    pause(ms, within, { target: video, event: 'timeupdate' })

  // A full buffer: buffer less ahead from now on, drop all that was played
  // before the group of frames being played (all but a second, for sound
  // alone), and try the held segments again in a moment. Both buffers may hit
  // it at once, and then one retry is enough.
  context.quota.handle = () => {
    target = Math.max(2, ahead() * 0.8)
    stats.targetAheadSeconds = target
    const cut = soundOnly ? video.currentTime - 1 : cutBefore(video.currentTime)
    if (cut > 0) for (const queue of queues) queue.removeBefore(cut)
    if (retrying) return
    retrying = true
    void wait(QUOTA_RETRY_MS).then(() => {
      retrying = false
      if (signal.aborted) return
      for (const queue of queues) queue.retry()
    })
  }

  return {
    roomToRead: async (within) => {
      makeRoomBehind()
      holds.check()
      while (!hasRoom() && !within.aborted) {
        const began = performance.now()
        await wait(HOLD_RECHECK_MS, within)
        stats.heldMs += performance.now() - began
        makeRoomBehind()
        holds.check()
      }
    },
  }
}

/**
 * Collects the pieces of the stream and gives them to mp4box in larger parts
 * (see FEED_BYTES). Pieces must be added in file order, without a gap.
 */
function createFeeder(file: ISOFile) {
  let pieces: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  let from = 0
  return {
    /** Collects `piece`, which starts at file offset `at`. */
    add(piece: Uint8Array<ArrayBuffer>, at: number): void {
      if (pieces.length === 0) from = at
      pieces.push(piece)
      size += piece.byteLength
    },
    /** How many bytes are collected and not yet given to mp4box. */
    get size(): number {
      return size
    },
    /** Drops what is collected, for a stream that starts again somewhere else. */
    clear(): void {
      pieces = []
      size = 0
    },
    /** Gives mp4box what is collected, as one buffer. */
    feed(): void {
      if (pieces.length === 0) return
      const only = pieces.at(0)
      let buffer: ArrayBuffer
      if (only && pieces.length === 1) {
        buffer = exactBuffer(only)
      } else {
        const joined = new Uint8Array(size)
        let at = 0
        for (const piece of pieces) {
          joined.set(piece, at)
          at += piece.byteLength
        }
        buffer = joined.buffer
      }
      const start = from
      pieces = []
      size = 0
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, start))
    },
  }
}

/** A stream's reader, with the bytes as the exact pieces the connection sent. */
type StreamReader = ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>

/**
 * Opens the file's bytes from `offset` to the end of what is streamed, and
 * gives the reader, or the message to fail with when the server didn't answer
 * with that part of the file. Aborting `signal` stops the connection.
 */
async function openStream(
  context: StreamContext,
  offset: number,
  signal: AbortSignal,
): Promise<StreamReader | string> {
  const range = `bytes=${offset}-${context.layout.stream.to - 1}`
  const response = await fetch(context.options.url, { headers: { Range: range }, signal })
  const answered = response.headers.get('Content-Range') ?? ''
  if (response.status !== 206 || !answered.startsWith(`bytes ${offset}-`)) {
    void response.body?.cancel()
    return 'The server sent another part of the file.'
  }
  if (!response.body) return 'The server sent no data.'
  return response.body.getReader()
}

/**
 * One run of the stream: reads the file's bytes from `offset` to the end of
 * what is streamed and gives them to mp4box (§10.4). It reads only while the
 * buffer ahead of the playhead is under its target, so a long video is never
 * held in memory whole. The pieces are given to mp4box a megabyte at a time. A
 * connection that breaks off is opened again from the bytes already received;
 * an answer for another part of the file, or a connection that keeps breaking,
 * fails the play. An error from mp4box or a buffer isn't about the connection,
 * and ends the play through the caller. Resolves true once all of it is with
 * mp4box, and false once `within` aborts: the play is over, or a restart
 * replaced this run, which is no broken connection and counts no reopen.
 */
async function streamRun(
  context: StreamContext,
  gate: ReturnType<typeof createBufferGate>,
  feeder: ReturnType<typeof createFeeder>,
  from: number,
  within: AbortSignal,
): Promise<boolean> {
  const { layout, stats, emit, holds } = context
  // A function, or TypeScript takes `within.aborted` to stay false across an await.
  const over = (): boolean => within.aborted

  let offset = from
  let reader: StreamReader | null = null
  let brokenInARow = 0
  try {
    while (offset < layout.stream.to && !over()) {
      // Held here while enough is buffered. Not in the try below: an error from the
      // buffers while making room is no fault of the connection.
      await gate.roomToRead(within)
      if (over()) return false

      // Only the network is retried: opening the stream and reading from it.
      let piece: Uint8Array<ArrayBuffer> | undefined
      const began = performance.now()
      try {
        if (!reader) {
          const opened = await openStream(context, offset, within)
          if (typeof opened === 'string') {
            context.fail(opened)
            return false
          }
          reader = opened
        }
        const { done, value } = await reader.read()
        // A stream that ends before the part asked for has broken off too.
        if (!done) piece = value
      } catch {
        // An abort isn't a broken connection.
      }
      // Also for a piece that came as the run was replaced: the feeder was cleared meanwhile.
      if (over()) return false
      stats.readingMs += performance.now() - began

      if (!piece) {
        // What was collected goes to mp4box now: the stream may be a while in coming back.
        feeder.feed()
        holds.check()
        if (reader) release(reader)
        reader = null
        if (brokenInARow >= MAX_REOPENS) {
          context.fail('The connection kept breaking off.')
          return false
        }
        brokenInARow += 1
        stats.reopens += 1
        emit()
        await pause(REOPEN_WAIT_MS, within)
        continue
      }

      brokenInARow = 0
      feeder.add(piece, offset)
      offset += piece.byteLength
      stats.bytesReceived += piece.byteLength
      // Not retried: a parse error here is the file's, not the connection's.
      if (feeder.size >= FEED_BYTES || offset >= layout.stream.to) {
        feeder.feed()
        holds.check()
      }
    }
  } finally {
    if (reader) release(reader)
  }
  return !over()
}

/**
 * Ends a stream that reached the end of the file: all of it is with mp4box, which
 * gives the last segments, and the buffers take them (released, if they were held
 * for more to be queued). Then the media is ended and the phase is 'ended'. A
 * restart (`within` aborts) cuts this short and ends nothing.
 */
async function endStream(context: StreamContext, within: AbortSignal): Promise<void> {
  const { file, queues, mediaSource, stats, emit, holds } = context
  // A function, or TypeScript takes `within.aborted` to stay false across an await.
  const over = (): boolean => within.aborted
  // A restart may come between the last piece and here.
  if (over()) return
  file.flush()
  // All of it is with mp4box: nothing more can be queued, so waiting for more would be for
  // ever, and the queues could not drain.
  holds.finish()
  await Promise.race([Promise.all(queues.map((queue) => queue.drained())), whenAborted(within)])
  if (over()) return
  if (mediaSource.readyState === 'open') mediaSource.endOfStream()
  stats.phase = 'ended'
  emit()
}

/**
 * Streams the file to mp4box and on to the buffers, and stays open until the
 * play is over (§10.4). It does so in runs (see `streamRun`), the first from
 * `context.firstOffset`. `context.restart(offset)` ends the run under way,
 * or the wait after the end of the file, and a new run begins at `offset`. After
 * the end of the file the media is ended and the phase is 'ended' (`endStream`),
 * and a later restart sets it back to 'buffering'. Resolves once the play is
 * over: the caller aborted it, or it failed.
 */
async function streamSamples(context: StreamContext): Promise<void> {
  const { signal, stats, emit } = context
  const gate = createBufferGate(context)
  const feeder = createFeeder(context.file)
  // A function, or TypeScript takes `signal.aborted` to stay false across an await.
  const over = (): boolean => signal.aborted

  /** Where a restart was asked for since the run under way began; `null` if none was. */
  let asked: number | null = null
  const restartAsked = (): number | null => asked
  /** The run under way, which a restart aborts. */
  let current = new AbortController()
  context.restart = (offset) => {
    if (over()) return
    asked = offset
    feeder.clear()
    if (stats.phase === 'ended') {
      stats.phase = 'buffering'
      emit()
    }
    current.abort()
  }

  let offset = context.firstOffset
  while (!over()) {
    // Taking the request and starting the next run is one step, so a restart
    // always finds the run it replaces.
    asked = null
    current = new AbortController()
    const within = AbortSignal.any([signal, current.signal])
    if (await streamRun(context, gate, feeder, offset, within)) {
      await endStream(context, within)
      // The stream stays open for a restart.
      await whenAborted(within)
    }
    // Either a restart replaced the run, or the play is over.
    const next = restartAsked()
    if (next === null) return
    offset = next
  }
}

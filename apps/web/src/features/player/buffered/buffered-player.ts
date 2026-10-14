// Plays a video that the browser's own media cache can't keep up with
// (DESIGN.md §10.4). Firefox's cache for a `<video src>` drops to 32 MB on
// mobile data, about 2 s of a 120 Mbit/s phone video, and thrashes there. Media
// Source keeps up to about 150 MB that DFS fills itself, so the player reads the
// file's bytes, lets mp4box split them into fragments and appends those. It
// opens the video first: it finds the index, checks the codecs and gives the
// browser the init segments. Then it streams the rest of the file, holding the
// reading back while enough is buffered ahead of the playhead, dropping what
// was played, only at a keyframe, to make room, and opening the stream again
// where it broke off.

import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Track } from 'mp4box'
import { AppendQueue } from './append-queue'
import { mediaLayout, type MediaLayout } from './boxes'
import {
  aheadSeconds,
  bufferTargets,
  keyframeAtOrBefore,
  keyframeTimes,
  longestKeyframeGap,
  mimeOf,
  samplesPerSegment,
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
  segments: number
  error: string | null
}

export interface BufferedPlayOptions {
  video: HTMLVideoElement
  /** The file's bytes, from a route that answers `Range`: the content route. */
  url: string
  signal: AbortSignal
  /** Called with fresh numbers twice a second, and once more when it ends or fails. */
  onStats: (stats: BufferedStats) => void
}

/** Everything `streamSamples` needs of the opening. */
interface StreamContext {
  options: BufferedPlayOptions
  /** Aborted when the caller aborts or the play fails: the one to fetch with. */
  signal: AbortSignal
  file: ISOFile
  layout: MediaLayout
  fileSize: number
  durationSeconds: number
  /** Whether only sound is played, which can be cut anywhere. */
  soundOnly: boolean
  /** The video's keyframes in seconds, ascending; empty when only sound is played. */
  keyframes: readonly number[]
  /** The longest stretch of the video without a keyframe; 1 when only sound is played. */
  keyframeGapSeconds: number
  mediaSource: MediaSource
  /** One for each track played, the video's first. */
  queues: AppendQueue[]
  stats: BufferedStats
  emit: () => void
  /** Ends the play with `message` shown. */
  fail: (message: string) => void
  /** What the queues call when a buffer is full. `streamSamples` puts its handling in `handle`. */
  quota: { handle: () => void }
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

/** The queue given to `setSegmentOptions`, which mp4box hands back as an `unknown` user. */
function queueOf(user: unknown): AppendQueue {
  return user as AppendQueue
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
 * Plays `url` in `video` through Media Source, buffering it itself (§10.4).
 * Resolves once the whole file is appended. A failure is a result, shown in
 * the stats and never thrown; an abort through `signal` resolves quietly.
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

  const interval = setInterval(emit, STATS_INTERVAL_MS)
  const onVideoError = (): void => {
    // The message is often empty, and then nothing is said of what went wrong.
    const message = video.error?.message ?? ''
    fail(message.length > 0 ? message : 'The video element failed.')
  }
  video.addEventListener('error', onVideoError)

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
    const queues = played.map((track) => {
      const queue = new AppendQueue(mediaSource.addSourceBuffer(mimeOf(track)), () => {
        stats.quotaErrors += 1
        quota.handle()
      })
      // Samples, not keyframes, decide where a segment ends (see SEGMENT_SECONDS).
      file.setSegmentOptions(track.id, queue, { nbSamples, rapAlignement: false })
      return queue
    })

    // 8. The init segments, then the samples mp4box has already, which start with `start()`.
    file.onSegment = (id, user, buffer, nextSample) => {
      try {
        queueOf(user).append(buffer)
        file.releaseUsedSamples(id, nextSample)
        stats.segments += 1
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    for (const { user, buffer } of file.initializeSegmentation('per-track')) {
      queueOf(user).append(buffer)
    }
    file.start()

    // 9. The rest of the file.
    stats.phase = 'buffering'
    emit()
    await streamSamples({
      options,
      signal,
      file,
      layout,
      fileSize,
      durationSeconds,
      soundOnly: videoTrack === undefined,
      keyframes,
      keyframeGapSeconds,
      mediaSource,
      queues,
      stats,
      emit,
      fail,
      quota,
    })
    // Everything is appended by now, unless the play was stopped meanwhile.
    if (!over()) {
      stats.phase = 'ended'
      emit()
    }
  } catch (error) {
    // An abort, the caller's or fail()'s, isn't a failure to show.
    if (!over()) fail(error instanceof Error ? error.message : String(error))
  } finally {
    clearInterval(interval)
    video.removeEventListener('error', onVideoError)
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

/**
 * Holds the reading back while enough is buffered, and handles a full buffer
 * (§10.4). `roomToRead()` resolves once the playhead has less than the target
 * buffered ahead, counting the bytes waiting to be appended as buffered, and
 * few enough of them wait. The target is how far ahead to buffer for this
 * file's bit rate and keyframe gap, and a quota error lowers it. What was
 * played is dropped only at a keyframe. This puts its handling of a quota error
 * in `context.quota`.
 */
function createBufferGate(context: StreamContext): { roomToRead: () => Promise<void> } {
  const { options, signal, queues, stats, soundOnly, keyframes } = context
  const { video } = options
  const bytesPerSecond = context.fileSize / context.durationSeconds
  const targets = bufferTargets(bytesPerSecond, context.keyframeGapSeconds)
  let target = targets.aheadSeconds
  stats.targetAheadSeconds = target
  let trimmedAt = Number.NEGATIVE_INFINITY
  let retrying = false

  const ahead = (): number => aheadSeconds(video.buffered, video.currentTime)
  /** What is queued will be buffered, so it counts as buffered now. */
  const hasRoom = (): boolean => {
    const pending = queues.reduce((sum, queue) => sum + queue.pendingBytes, 0)
    return ahead() + pending / bytesPerSecond < target && pending < MAX_PENDING_BYTES
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
  /** Waits for the playhead to move, a little while or the end of the play. */
  const wait = (ms: number): Promise<void> =>
    pause(ms, signal, { target: video, event: 'timeupdate' })

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
    roomToRead: async () => {
      makeRoomBehind()
      while (!hasRoom() && !signal.aborted) {
        const began = performance.now()
        await wait(HOLD_RECHECK_MS)
        stats.heldMs += performance.now() - began
        makeRoomBehind()
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
 * with that part of the file.
 */
async function openStream(context: StreamContext, offset: number): Promise<StreamReader | string> {
  const range = `bytes=${offset}-${context.layout.stream.to - 1}`
  const response = await fetch(context.options.url, {
    headers: { Range: range },
    signal: context.signal,
  })
  const answered = response.headers.get('Content-Range') ?? ''
  if (response.status !== 206 || !answered.startsWith(`bytes ${offset}-`)) {
    void response.body?.cancel()
    return 'The server sent another part of the file.'
  }
  if (!response.body) return 'The server sent no data.'
  return response.body.getReader()
}

/**
 * Streams the rest of the file to mp4box and on to the buffers, and resolves
 * once all of it is appended and the stream is ended (§10.4). It reads only
 * while the buffer ahead of the playhead is under its target, so a long video
 * is never held in memory whole. The pieces are given to mp4box a megabyte at a
 * time. A connection that breaks off is opened again from the bytes already
 * received; an answer for another part of the file, or
 * a connection that keeps breaking, fails the play. An error from mp4box
 * or a buffer isn't about the connection, and ends the play through the caller.
 */
async function streamSamples(context: StreamContext): Promise<void> {
  const { signal, file, layout, queues, mediaSource, stats, emit } = context
  const gate = createBufferGate(context)
  const feeder = createFeeder(file)
  // A function, or TypeScript takes `signal.aborted` to stay false across an await.
  const over = (): boolean => signal.aborted

  let offset = layout.stream.from
  let reader: StreamReader | null = null
  let brokenInARow = 0
  try {
    while (offset < layout.stream.to && !over()) {
      // Held here while enough is buffered. Not in the try below: an error from the
      // buffers while making room is no fault of the connection.
      await gate.roomToRead()
      if (over()) return

      // Only the network is retried: opening the stream and reading from it.
      let piece: Uint8Array<ArrayBuffer> | undefined
      const began = performance.now()
      try {
        if (!reader) {
          const opened = await openStream(context, offset)
          if (typeof opened === 'string') {
            context.fail(opened)
            return
          }
          reader = opened
        }
        const { done, value } = await reader.read()
        // A stream that ends before the part asked for has broken off too.
        if (!done) piece = value
      } catch {
        // An abort isn't a broken connection, and ends the play.
        if (over()) return
      }
      stats.readingMs += performance.now() - began

      if (!piece) {
        if (over()) return
        // What was collected goes to mp4box now: the stream may be a while in coming back.
        feeder.feed()
        if (reader) release(reader)
        reader = null
        if (brokenInARow >= MAX_REOPENS) {
          context.fail('The connection kept breaking off.')
          return
        }
        brokenInARow += 1
        stats.reopens += 1
        emit()
        await pause(REOPEN_WAIT_MS, signal)
        continue
      }

      brokenInARow = 0
      feeder.add(piece, offset)
      offset += piece.byteLength
      stats.bytesReceived += piece.byteLength
      // Not retried: a parse error here is the file's, not the connection's.
      if (feeder.size >= FEED_BYTES || offset >= layout.stream.to) feeder.feed()
    }
  } finally {
    if (reader) release(reader)
  }
  if (over()) return

  // All the file is with mp4box: it gives the last segments, which the buffers then take.
  file.flush()
  await Promise.race([Promise.all(queues.map((queue) => queue.drained())), whenAborted(signal)])
  if (over()) return
  if (mediaSource.readyState === 'open') mediaSource.endOfStream()
}

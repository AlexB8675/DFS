// Plays a video that the browser's own media cache can't keep up with
// (DESIGN.md §10.4). Firefox's cache for a `<video src>` drops to 32 MB on
// mobile data, about 2 s of a 120 Mbit/s phone video, and thrashes there. Media
// Source keeps up to about 150 MB that DFS fills itself, so the player reads the
// file's bytes, lets mp4box split them into fragments and appends those. This
// opens the video: it finds the index, checks the codecs and gives the browser
// the init segments. The samples are streamed after that.

import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Track } from 'mp4box'
import { AppendQueue } from './append-queue'
import { mediaLayout, type MediaLayout } from './boxes'
import { mimeOf, samplesPerSegment } from './tracks'

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
  mediaSource: MediaSource
  /** One for each track played, the video's first. */
  queues: AppendQueue[]
  stats: BufferedStats
  emit: () => void
}

/** How much of the file is read first, to find the index and learn the file's size. */
const HEAD_BYTES = 64 * 1024

/** How long mp4box has to read the index once it has all of it. */
const READY_TIMEOUT_MS = 15_000

const STATS_INTERVAL_MS = 500

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
    quotaErrors: 0,
    reopens: 0,
    segments: 0,
    error: null,
  }
  const emit = (): void => {
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
    const mediaSource = new MediaSource()
    const opened = new Promise<Event>((resolve) => {
      mediaSource.addEventListener('sourceopen', resolve, { once: true })
    })
    video.src = URL.createObjectURL(mediaSource)
    if (!(await until(opened))) return
    const durationSeconds = info.duration / info.timescale
    mediaSource.duration = durationSeconds
    // mp4box wants the same sample count for every track. The picture's sets it,
    // and the sound's segments, with their small samples, come out shorter.
    const nbSamples = samplesPerSegment(first, SEGMENT_SECONDS)
    const queues = played.map((track) => {
      const queue = new AppendQueue(mediaSource.addSourceBuffer(mimeOf(track)), () => {
        stats.quotaErrors += 1
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
      mediaSource,
      queues,
      stats,
      emit,
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
 * Streams the rest of the file to mp4box and on to the buffers, and resolves
 * once all of it is appended (§10.4). Not written yet: the next step fills it in.
 */
function streamSamples(_context: StreamContext): Promise<void> {
  return Promise.resolve()
}

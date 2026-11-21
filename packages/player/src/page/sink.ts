// The Media Source sink (DESIGN.md §10.4; the iron-clad spec §4.8): takes the fragments the feeder makes and
// puts them in a `video` element, one SourceBuffer for each track. Appends and removals go one at a time
// for each SourceBuffer, each after the `updateend` of the one before. The sink holds no policy: the engine
// decides what to feed, what to remove and when to reopen, and the sink does it and says what the browser said.

import { initSegment } from '@dfs/mp4'
import type { Sink } from '../engine/feeder.ts'
import type { ChosenTracks, EngineTrack } from '../engine/tracks.ts'
import type { FedRun } from '../engine/window.ts'
import { APPEND_WINDOW_PAD_SECONDS, REMOVE_PAD_SECONDS } from '../limits.ts'

type Kind = 'video' | 'audio'

const KINDS: readonly Kind[] = ['video', 'audio']

/** An append that the SourceBuffer refused for want of room: the engine shrinks its window and goes on. */
export class SinkQuotaError extends Error {
  readonly quota = true as const

  constructor(message: string) {
    super(message)
    this.name = 'SinkQuotaError'
  }
}

/** The end of an operation for a sink that is closed or reopened under it: what the engine takes as the end of that feed. */
function aborted(what: string): DOMException {
  return new DOMException(what, 'AbortError')
}

/** A way out of an operation that waits on the browser, for a sink that is closed or reopened under it. */
type Cancel = (reason: Error) => void

export class MediaSourceSink implements Sink {
  readonly #video: HTMLVideoElement
  readonly #durationSeconds: number | null
  #mediaSource: MediaSource | null = null
  #tracks: ChosenTracks | null = null
  #buffers: Record<Kind, SourceBuffer | null> = { video: null, audio: null }
  /** The last operation of each SourceBuffer: the next one starts when it is done. */
  #tails: Record<Kind, Promise<void>> = { video: Promise.resolve(), audio: Promise.resolve() }
  /** The operations that wait on the browser now. */
  readonly #waiting = new Set<Cancel>()
  /** Counts the Media Sources: `reopen` and `close` each start a new one, and an operation of an older one is not run. */
  #generation = 0
  #closed = false
  /** True from a reopen's start until its new buffers are there. */
  #rebuilding = false
  /** Where the element is to go once what is buffered covers it. */
  #pendingSeek: number | null = null

  private constructor(video: HTMLVideoElement, durationSeconds: number | null) {
    this.#video = video
    this.#durationSeconds = durationSeconds
  }

  /** Makes the Media Source, gives the element its URL and waits for it to open. An abort of `signal` rejects with its reason. */
  static async open(
    video: HTMLVideoElement,
    durationSeconds: number | null,
    signal?: AbortSignal,
  ): Promise<MediaSourceSink> {
    const sink = new MediaSourceSink(video, durationSeconds)
    try {
      await sink.#attach(signal)
    } catch (error) {
      video.removeAttribute('src')
      video.load()
      throw error
    }
    return sink
  }

  /** A new Media Source on the element, opened. Its URL is let go once the element holds it, or when this fails. */
  async #attach(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const mediaSource = new MediaSource()
    this.#mediaSource = mediaSource
    const url = URL.createObjectURL(mediaSource)
    const video = this.#video
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel: Cancel = (reason) => {
          cleanup()
          reject(reason)
        }
        const opened = (): void => {
          cleanup()
          resolve()
        }
        // An error that was raised before this Media Source, and is still being told, is not this one's.
        const failed = (): void => {
          if (video.error === null) return
          cleanup()
          reject(new Error(this.#describe('The element refused the Media Source')))
        }
        const stopped = (): void => {
          cleanup()
          reject(signal?.reason as Error)
        }
        const cleanup = (): void => {
          mediaSource.removeEventListener('sourceopen', opened)
          video.removeEventListener('error', failed)
          signal?.removeEventListener('abort', stopped)
          this.#waiting.delete(cancel)
        }
        this.#waiting.add(cancel)
        mediaSource.addEventListener('sourceopen', opened, { once: true })
        video.addEventListener('error', failed)
        signal?.addEventListener('abort', stopped, { once: true })
        video.src = url
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** `what`, and the element's media error (its code and message) when it has one. */
  #describe(what: string): string {
    const error = this.#video.error
    return error === null
      ? `${what}.`
      : `${what} (media error ${error.code}${error.message === '' ? '' : `: ${error.message}`}).`
  }

  /**
   * One SourceBuffer for each track, the picture first, each with its offset and its append window, and
   * the init segments appended. The duration is set when it is known. Once only, and not after `close`.
   */
  async init(tracks: ChosenTracks): Promise<void> {
    if (this.#closed) throw aborted('The sink was closed.')
    if (this.#tracks !== null) throw new Error('The sink has its tracks already.')
    this.#tracks = tracks
    await this.#build()
  }

  async #build(): Promise<void> {
    const tracks = this.#tracks
    const mediaSource = this.#mediaSource
    if (tracks === null || mediaSource === null) throw new Error('The sink has no tracks yet.')
    const chosen: [Kind, EngineTrack][] = [['video', tracks.video]]
    if (tracks.audio !== null) chosen.push(['audio', tracks.audio])
    const made: Record<Kind, SourceBuffer | null> = { video: null, audio: null }
    try {
      for (const [kind, track] of chosen) {
        const buffer = mediaSource.addSourceBuffer(track.mime)
        made[kind] = buffer
        buffer.mode = 'segments'
        const { offsetSeconds, endSeconds } = track.track.timing
        buffer.timestampOffset = offsetSeconds
        if (endSeconds !== null) buffer.appendWindowEnd = endSeconds + APPEND_WINDOW_PAD_SECONDS
      }
    } catch (error) {
      for (const kind of KINDS) {
        const buffer = made[kind]
        if (buffer !== null) mediaSource.removeSourceBuffer(buffer)
      }
      throw error
    }
    if (
      this.#durationSeconds !== null &&
      Number.isFinite(this.#durationSeconds) &&
      this.#durationSeconds > 0
    ) {
      mediaSource.duration = this.#durationSeconds
    }
    this.#buffers = made
    this.#rebuilding = false
    await Promise.all(
      chosen.map(([kind, track]) =>
        this.#queue(kind, (buffer) => {
          buffer.appendBuffer(initSegment(track.track) as Uint8Array<ArrayBuffer>)
        }),
      ),
    )
  }

  /** Appends a fragment after the ones before it. A quota error rejects with `SinkQuotaError`. */
  append(kind: Kind, bytes: Uint8Array, _run: FedRun): Promise<void> {
    return this.#queue(kind, (buffer) => {
      buffer.appendBuffer(bytes as Uint8Array<ArrayBuffer>)
    })
  }

  /**
   * Removes what is before `before` (seconds). The end is padded a little short, so that rounding never
   * removes the keyframe of the group that `before` is the start of; a `before` that is not past the
   * pad removes nothing.
   */
  remove(kind: Kind, before: number): Promise<void> {
    if (!(before > REMOVE_PAD_SECONDS)) return Promise.resolve()
    return this.#queue(kind, (buffer) => {
      buffer.remove(0, before - REMOVE_PAD_SECONDS)
    })
  }

  /** What the SourceBuffer holds, as `[start, end]` in seconds; nothing when it has no buffer, is closed or reopening, or its Media Source is closed. Never throws. */
  buffered(kind: Kind): [number, number][] {
    const buffer = this.#buffers[kind]
    if (buffer === null || this.#closed || this.#rebuilding) return []
    if (this.#mediaSource?.readyState === 'closed') return []
    try {
      const out: [number, number][] = []
      const { buffered } = buffer
      for (let i = 0; i < buffered.length; i += 1) out.push([buffered.start(i), buffered.end(i)])
      return out
    } catch {
      return []
    }
  }

  /**
   * Puts the element at `at` (seconds) when what it can seek to covers it, else as soon as an append
   * makes it cover it: with no known duration nothing is seekable until data is buffered, and the
   * browser drops a seek made before. The last call wins.
   */
  seek(at: number): void {
    if (this.#closed) return
    this.#pendingSeek = at
    this.#flushSeek()
  }

  #flushSeek(): void {
    const at = this.#pendingSeek
    if (at === null || this.#closed) return
    const { seekable } = this.#video
    for (let i = 0; i < seekable.length; i += 1) {
      if (seekable.start(i) <= at && at <= seekable.end(i)) {
        this.#pendingSeek = null
        this.#video.currentTime = at
        return
      }
    }
  }

  /**
   * Ends the stream, once the operations of every track are done: Media Source then makes the duration the
   * buffered end. Does nothing for a sink that was closed or reopened meanwhile, or whose stream has ended.
   */
  async end(): Promise<void> {
    const generation = this.#generation
    for (;;) {
      const tails = KINDS.map((kind) => this.#tails[kind])
      await Promise.all(tails)
      if (KINDS.every((kind, i) => this.#tails[kind] === tails[i])) break
    }
    if (this.#closed || generation !== this.#generation) return
    const mediaSource = this.#mediaSource
    if (mediaSource?.readyState !== 'open') return
    if (KINDS.some((kind) => this.#buffers[kind]?.updating === true)) return
    mediaSource.endOfStream()
  }

  /** A new Media Source with fresh SourceBuffers and init segments, and the element at `at`. The caller feeds again, and plays if it was playing. Operations queued before are rejected. */
  async reopen(at: number, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw aborted('The sink was closed.')
    if (this.#tracks === null) throw new Error('The sink has no tracks yet.')
    this.#generation += 1
    const generation = this.#generation
    this.#rebuilding = true
    this.#buffers = { video: null, audio: null }
    this.#tails = { video: Promise.resolve(), audio: Promise.resolve() }
    this.#letGo(aborted('The Media Source was reopened.'))
    await this.#attach(signal)
    if (generation !== this.#generation) throw aborted('The Media Source was reopened again.')
    await this.#build()
    if (generation !== this.#generation) throw aborted('The Media Source was reopened again.')
    this.seek(at)
  }

  /** Lets the element go of the media. */
  close(): void {
    this.#closed = true
    this.#generation += 1
    this.#buffers = { video: null, audio: null }
    this.#tails = { video: Promise.resolve(), audio: Promise.resolve() }
    this.#pendingSeek = null
    this.#letGo(aborted('The sink was closed.'))
    this.#video.removeAttribute('src')
    this.#video.load()
  }

  /** Ends every operation that waits on the browser, for a Media Source that is going away. */
  #letGo(reason: Error): void {
    for (const cancel of [...this.#waiting]) cancel(reason)
  }

  /** Runs `start` on the track's SourceBuffer when the operations before it are done, and resolves at its `updateend`. */
  #queue(kind: Kind, start: (buffer: SourceBuffer) => void): Promise<void> {
    if (this.#closed) return Promise.reject(aborted('The sink was closed.'))
    const buffer = this.#buffers[kind]
    if (buffer === null) {
      return Promise.reject(
        this.#rebuilding
          ? aborted('The Media Source is being reopened.')
          : new Error(`The sink has no ${kind} buffer.`),
      )
    }
    const generation = this.#generation
    const run = this.#tails[kind].then(() => this.#run(kind, buffer, generation, start))
    this.#tails[kind] = run.catch(() => undefined)
    return run
  }

  #run(
    kind: Kind,
    buffer: SourceBuffer,
    generation: number,
    start: (buffer: SourceBuffer) => void,
  ): Promise<void> {
    if (this.#closed || generation !== this.#generation) {
      return Promise.reject(aborted('The Media Source is gone.'))
    }
    return new Promise<void>((resolve, reject) => {
      let failed = false
      let stopped = false
      const cancel: Cancel = (reason) => {
        cleanup()
        reject(reason)
      }
      const cleanup = (): void => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', broke)
        buffer.removeEventListener('abort', broken)
        this.#waiting.delete(cancel)
      }
      // The browser's `error` and `abort` come before its `updateend`, and the buffer takes no operation until the latter.
      const broke = (): void => {
        failed = true
      }
      const broken = (): void => {
        stopped = true
      }
      const done = (): void => {
        cleanup()
        if (stopped) reject(aborted(`The ${kind} buffer's operation was aborted.`))
        else if (failed) reject(new Error(this.#describe(`The ${kind} buffer failed`)))
        else {
          resolve()
          this.#flushSeek()
        }
      }
      this.#waiting.add(cancel)
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', broke)
      buffer.addEventListener('abort', broken)
      try {
        start(buffer)
      } catch (error) {
        cleanup()
        if (error instanceof DOMException && error.name === 'QuotaExceededError') {
          reject(new SinkQuotaError(`The ${kind} buffer is full: ${error.message}`))
        } else {
          const why = error instanceof Error ? error.message : String(error)
          reject(new Error(this.#describe(`The ${kind} buffer refused an operation: ${why}`)))
        }
      }
    })
  }
}

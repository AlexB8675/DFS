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

/** A way out of an operation that waits on the browser, for a sink that is closed or reopened under it. */
type Cancel = (reason: Error) => void

export class MediaSourceSink implements Sink {
  readonly #video: HTMLVideoElement
  readonly #durationSeconds: number | null
  #mediaSource: MediaSource | null = null
  #url: string | null = null
  #tracks: ChosenTracks | null = null
  #buffers: Record<Kind, SourceBuffer | null> = { video: null, audio: null }
  /** The last operation of each SourceBuffer: the next one starts when it is done. */
  #tails: Record<Kind, Promise<void>> = { video: Promise.resolve(), audio: Promise.resolve() }
  /** The operations that wait on the browser now. */
  readonly #waiting = new Set<Cancel>()
  #closed = false

  private constructor(video: HTMLVideoElement, durationSeconds: number | null) {
    this.#video = video
    this.#durationSeconds = durationSeconds
  }

  /** Makes the Media Source, gives the element its URL and waits for it to open. */
  static async open(
    video: HTMLVideoElement,
    durationSeconds: number | null,
  ): Promise<MediaSourceSink> {
    const sink = new MediaSourceSink(video, durationSeconds)
    await sink.#attach()
    return sink
  }

  /** A new Media Source on the element, opened. The old URL is let go. */
  async #attach(): Promise<void> {
    if (this.#url !== null) URL.revokeObjectURL(this.#url)
    const mediaSource = new MediaSource()
    this.#mediaSource = mediaSource
    const url = URL.createObjectURL(mediaSource)
    this.#url = url
    const video = this.#video
    await new Promise<void>((resolve, reject) => {
      const cancel: Cancel = (reason) => {
        cleanup()
        reject(reason)
      }
      const opened = (): void => {
        cleanup()
        resolve()
      }
      const failed = (): void => {
        cleanup()
        reject(new Error(this.#describe('The element refused the Media Source')))
      }
      const cleanup = (): void => {
        mediaSource.removeEventListener('sourceopen', opened)
        video.removeEventListener('error', failed)
        this.#waiting.delete(cancel)
      }
      this.#waiting.add(cancel)
      mediaSource.addEventListener('sourceopen', opened, { once: true })
      video.addEventListener('error', failed, { once: true })
      video.src = url
    })
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
   * the init segments appended. The duration is set when it is known.
   */
  async init(tracks: ChosenTracks): Promise<void> {
    this.#tracks = tracks
    await this.#build()
  }

  async #build(): Promise<void> {
    const tracks = this.#tracks
    const mediaSource = this.#mediaSource
    if (tracks === null || mediaSource === null) throw new Error('The sink has no tracks yet.')
    const chosen: [Kind, EngineTrack][] = [['video', tracks.video]]
    if (tracks.audio !== null) chosen.push(['audio', tracks.audio])
    this.#buffers = { video: null, audio: null }
    this.#tails = { video: Promise.resolve(), audio: Promise.resolve() }
    for (const [kind, track] of chosen) {
      const buffer = mediaSource.addSourceBuffer(track.mime)
      buffer.mode = 'segments'
      const { offsetSeconds, endSeconds } = track.track.timing
      buffer.timestampOffset = offsetSeconds
      if (endSeconds !== null) buffer.appendWindowEnd = endSeconds + APPEND_WINDOW_PAD_SECONDS
      this.#buffers[kind] = buffer
    }
    if (this.#durationSeconds !== null && Number.isFinite(this.#durationSeconds)) {
      mediaSource.duration = this.#durationSeconds
    }
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

  /** What the SourceBuffer holds, as `[start, end]` in seconds. */
  buffered(kind: Kind): [number, number][] {
    const buffer = this.#buffers[kind]
    if (buffer === null) return []
    const out: [number, number][] = []
    const { buffered } = buffer
    for (let i = 0; i < buffered.length; i += 1) out.push([buffered.start(i), buffered.end(i)])
    return out
  }

  /** Ends the stream, once the appends before it are done: Media Source then makes the duration the buffered end. A stream that has ended is left as it is. */
  async end(): Promise<void> {
    await Promise.all(KINDS.map((kind) => this.#tails[kind]))
    const mediaSource = this.#mediaSource
    if (mediaSource?.readyState === 'open') mediaSource.endOfStream()
  }

  /** A new Media Source with fresh SourceBuffers and init segments, and the element at `at`. The caller feeds again, and plays if it was playing. */
  async reopen(at: number): Promise<void> {
    if (this.#tracks === null) throw new Error('The sink has no tracks yet.')
    this.#letGo(new Error('The Media Source was reopened.'))
    await this.#attach()
    await this.#build()
    this.#video.currentTime = at
  }

  /** Lets the element go of the media. */
  close(): void {
    this.#closed = true
    this.#letGo(new Error('The sink was closed.'))
    if (this.#url !== null) URL.revokeObjectURL(this.#url)
    this.#url = null
    this.#video.removeAttribute('src')
    this.#video.load()
  }

  /** Ends every operation that waits on the browser, for a Media Source that is going away. */
  #letGo(reason: Error): void {
    for (const cancel of [...this.#waiting]) cancel(reason)
  }

  /** Runs `start` on the track's SourceBuffer when the operations before it are done, and resolves at its `updateend`. */
  #queue(kind: Kind, start: (buffer: SourceBuffer) => void): Promise<void> {
    const buffer = this.#buffers[kind]
    if (buffer === null) return Promise.reject(new Error(`The sink has no ${kind} buffer.`))
    const run = this.#tails[kind].then(() => this.#run(kind, buffer, start))
    this.#tails[kind] = run.catch(() => undefined)
    return run
  }

  #run(kind: Kind, buffer: SourceBuffer, start: (buffer: SourceBuffer) => void): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('The sink was closed.'))
    return new Promise<void>((resolve, reject) => {
      let failed = false
      const cancel: Cancel = (reason) => {
        cleanup()
        reject(reason)
      }
      const cleanup = (): void => {
        buffer.removeEventListener('updateend', done)
        buffer.removeEventListener('error', broke)
        this.#waiting.delete(cancel)
      }
      // The browser's `error` comes before its `updateend`, and the buffer takes no operation until the latter.
      const broke = (): void => {
        failed = true
      }
      const done = (): void => {
        cleanup()
        if (failed) reject(new Error(this.#describe(`The ${kind} buffer failed`)))
        else resolve()
      }
      this.#waiting.add(cancel)
      buffer.addEventListener('updateend', done)
      buffer.addEventListener('error', broke)
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

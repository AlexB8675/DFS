// The engine's play (DESIGN.md §10.4; the iron-clad spec §4.8): ties the downloader and its store, the feeder,
// the decoder window and the Media Source sink into one play of a file in a `video` element, from its start
// or from a given time to its end. It opens the download, then the feeder and the sink together; feeds the
// first fragments and puts the clock where every track has frames (the common start); and then feeds in a
// loop of promises, never timers, as the window asks, removes what is played past the window behind, and
// ends the stream once every fragment is in. In this part it never calls `play()`, never answers a seek, holds
// no play for the network and has no watchdog: those are the controls, which come after it.
//
// A play is rejected only before its first frame (the common start is its mark), with the feeder's
// `{ refusal, reason }` when the file cannot play, or the reason of whatever else failed or of the signal.
// After it a failure is an `error` event and the phase `failed`, the feeding stops, and the promise
// resolves when the signal aborts, once the downloader (and so the store) and the sink are closed.

import { Mp4Error } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { messageOf } from '../downloader.ts'
import type { Downloader } from '../downloader.ts'
import { Feeder } from '../engine/feeder.ts'
import type { Sink } from '../engine/feeder.ts'
import type { ChosenTracks, EngineTrack } from '../engine/tracks.ts'
import { DecoderWindow } from '../engine/window.ts'
import type { FedRun } from '../engine/window.ts'
import {
  GAP_EDGE_SECONDS,
  POSITION_EVERY_MS,
  SOUND_WAIT_SECONDS,
  STATS_EVERY_MS,
  WATCH_EVERY_MS,
  WINDOW_AHEAD_SECONDS,
} from '../limits.ts'
import { openDownload } from '../open-download.ts'
import type { StorageEstimator, StoreWorker } from '../open.ts'
import { ReadError } from '../read.ts'
import { MediaSourceSink, SinkQuotaError } from './sink.ts'

type Kind = 'video' | 'audio'

/** The length of a frame that the engine takes when the picture's table cannot say: a Matroska file's, which has none. */
const UNKNOWN_FRAME_SECONDS = 1 / 30

/** The engine's numbers, with the old engine's `BufferedStats` fields under the same names (a field that does not apply keeps its meaning, with the nearest value). */
export interface EngineStats {
  phase: 'opening' | 'buffering' | 'ended' | 'failed'
  /** The codec names of the tracks that play. */
  codecs: string[]
  /** Each SourceBuffer MIME type, and whether `MediaSource.isTypeSupported` said yes: the engine only plays a type that it did. */
  supported: Record<string, boolean>
  /** The bytes of the file that the store holds now. */
  bytesReceived: number
  /** Time the downloader spent reading from the network. */
  readingMs: number
  /** Time the feeding was held back because the window was full. */
  heldMs: number
  /** Seconds buffered in the element from the playhead on. */
  aheadSeconds: number
  /** Seconds the window reaches ahead. */
  targetAheadSeconds: number
  /** The longest stretch of the picture without a keyframe; 0, as it is not measured. */
  keyframeGapSeconds: number
  quotaErrors: number
  /** Times the watchdog reopened Media Source. */
  reopens: number
  /** Seeks outside the window. */
  seeks: number
  /** Whether the play is held for the network. */
  holding: boolean
  /** Holds that ended in playing. */
  holds: number
  /** Time spent in the holds that ended. */
  holdMs: number
  /** Fragments appended. */
  segments: number
  error: string | null
  backend: 'disk' | 'memory'
  /** The bytes the store holds. */
  storedBytes: number
  /** The bytes the decoder window holds. */
  windowBytes: number
  /** The downloader's measured rate in bytes a second, null before it knows one. */
  rate: number | null
}

export interface PlayStreamedOptions {
  video: HTMLVideoElement
  /** The file's route, which the play's reads are made of. */
  url: string
  /** The play's id, which names its directory in the private file system. */
  playId: string
  /** Makes the worker that serves the disk store, or is null where there is none to make. */
  makeWorker: (() => StoreWorker) | null
  /** Ends the play. */
  signal: AbortSignal
  /** Seconds into the file to begin at; 0 or missing is the start. */
  startAt?: number
  onEvent: (event: TimelineEventInput) => void
  onStats: (stats: EngineStats) => void
  fetch?: typeof fetch
  estimate?: StorageEstimator
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** The name in a type's `codecs="…"`. */
function codecsOf(mime: string): string {
  return /codecs="([^"]*)"/.exec(mime)?.[1] ?? mime
}

/** How long one frame of the picture is, in seconds, when its table says. */
function frameSeconds(track: EngineTrack): number {
  const { track: source } = track
  if ('table' in source && source.table.count > 0 && source.table.timescale > 0) {
    const first = source.table.durations[0] ?? 0
    if (first > 0) return first / source.table.timescale
  }
  return UNKNOWN_FRAME_SECONDS
}

/** The seconds from `at` to the end of the range that holds it (a range's edge counts as holding it, a little short), or 0. */
function aheadOf(buffered: TimeRanges, at: number): number {
  for (let i = 0; i < buffered.length; i += 1) {
    if (buffered.start(i) - GAP_EDGE_SECONDS <= at && at <= buffered.end(i)) {
      return Math.max(0, buffered.end(i) - at)
    }
  }
  return 0
}

class Play {
  readonly #options: PlayStreamedOptions
  readonly #video: HTMLVideoElement
  readonly #signal: AbortSignal
  /** Aborts what the feed waits on: when the play is over, or fails. The controls will abort it for a seek. */
  readonly #feedControl = new AbortController()
  readonly #window = new DecoderWindow()
  #downloader: Downloader | null = null
  #feeder: Feeder | null = null
  #sink: MediaSourceSink | null = null
  /** The kinds that play: the picture, and the sound once the first feed has decided that there is one. */
  #kinds: Kind[] = ['video']
  /** Where the play starts, in seconds. */
  #target = 0
  /** True from the common start, the play's first frame: the clock is the playhead from then on. */
  #started = false
  /** True once a feed answered `'ended'`: every fragment is appended. */
  #feedDone = false
  /** True once the stream was ended: nothing is appended or removed after it. */
  #ended = false
  #failed = false
  /** True from the abort of the signal: the engine says nothing more of its own. */
  #stopped = false
  #closing: Promise<void> | null = null
  /** Fragments appended, and the first feed's count of them, for a feed's progress. */
  #appended = 0
  readonly #wakers: (() => void)[] = []
  readonly #timers: ReturnType<typeof setInterval>[] = []
  readonly #listeners: [string, () => void][] = []
  #lastStatsAt = performance.now()
  readonly #stats: EngineStats = {
    phase: 'opening',
    codecs: [],
    supported: {},
    bytesReceived: 0,
    readingMs: 0,
    heldMs: 0,
    aheadSeconds: 0,
    targetAheadSeconds: WINDOW_AHEAD_SECONDS,
    keyframeGapSeconds: 0,
    quotaErrors: 0,
    reopens: 0,
    seeks: 0,
    holding: false,
    holds: 0,
    holdMs: 0,
    segments: 0,
    error: null,
    backend: 'memory',
    storedBytes: 0,
    windowBytes: 0,
    rate: null,
  }

  constructor(options: PlayStreamedOptions) {
    this.#options = options
    this.#video = options.video
    this.#signal = options.signal
    const startAt = options.startAt
    this.#target = startAt !== undefined && Number.isFinite(startAt) && startAt > 0 ? startAt : 0
    const stop = (): void => {
      this.#stopped = true
      this.#feedControl.abort(this.#signal.reason)
      this.#wake()
    }
    if (this.#signal.aborted) stop()
    else this.#signal.addEventListener('abort', stop, { once: true })
  }

  /** An event of the downloader's or the feeder's: sent as it is, whatever the play's state, and never allowed to stop the play. */
  readonly #emit = (event: TimelineEventInput): void => {
    try {
      this.#options.onEvent(event)
    } catch {
      // The record of a play must not stop it.
    }
  }

  /** An event of the engine's own: not sent once the play is over. */
  #say(event: TimelineEventInput): void {
    if (!this.#stopped) this.#emit(event)
  }

  #publish(): void {
    if (this.#stopped) return
    const stats = this.#stats
    const downloader = this.#downloader
    if (downloader !== null) {
      const { store } = downloader
      const held = store.held()
      stats.backend = store.backend
      stats.storedBytes = store.stats().storedBytes
      stats.bytesReceived = held.bytes()
      stats.rate = downloader.rate()
    }
    stats.windowBytes = this.#window.bytes()
    stats.aheadSeconds = aheadOf(this.#video.buffered, this.#video.currentTime)
    try {
      this.#options.onStats({
        ...stats,
        codecs: [...stats.codecs],
        supported: { ...stats.supported },
      })
    } catch {
      // The page's numbers must not stop a play either.
    }
  }

  #setPhase(phase: EngineStats['phase']): void {
    if (this.#stats.phase === phase && phase !== 'opening') return
    this.#stats.phase = phase
    this.#say({ type: 'phase', phase })
    this.#publish()
  }

  /** Where the playhead is: the target until the common start has put the clock there. */
  #at(): number {
    return this.#started ? this.#video.currentTime : this.#target
  }

  #wake(): void {
    for (const wake of this.#wakers.splice(0)) wake()
  }

  /** Resolves at the next tick, `timeupdate`, `seeking`, `waiting` or abort. */
  #nextWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wakers.push(resolve)
    })
  }

  /**
   * Opens the download, then the feeder and the sink together, feeds the first fragments, and puts the
   * clock at the common start. Rejects as the play is rejected (see the head of the file). The first
   * frame is the mark: when this resolves the play has begun.
   */
  async open(): Promise<void> {
    const options = this.#options
    this.#setPhase('opening')
    const downloader = await openDownload({
      url: options.url,
      playId: options.playId,
      makeWorker: options.makeWorker,
      onEvent: this.#emit,
      signal: this.#signal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
    })
    this.#downloader = downloader
    const [opened, attached] = await Promise.allSettled([
      Feeder.open(downloader, (mime) => MediaSource.isTypeSupported(mime), this.#emit, {
        signal: this.#signal,
      }),
      MediaSourceSink.open(this.#video, null, this.#signal),
    ])
    if (opened.status === 'fulfilled') this.#feeder = opened.value
    if (attached.status === 'fulfilled') this.#sink = attached.value
    if (opened.status === 'rejected') throw opened.reason
    if (attached.status === 'rejected') throw attached.reason
    const feeder = opened.value
    const sink = attached.value
    sink.setDuration(feeder.durationSeconds)

    const { video: picture, audio } = feeder.tracks
    this.#stats.codecs = [codecsOf(picture.mime)]
    this.#stats.supported[picture.mime] = true
    if (audio !== null) this.#stats.supported[audio.mime] = true
    this.#startTimers()
    this.#setPhase('buffering')

    if (this.#target > 0) await feeder.seek(this.#target, this.#feedControl.signal)
    // The first fragments: fed until the picture is buffered, which is where the clock can be put.
    for (;;) {
      const result = await this.#feedOnce()
      if (sink.buffered('video').length > 0 || result === 'ended') break
      if (result === 'idle') await this.#nextWake()
    }
    this.#applyCommonStart(picture)
    this.#started = true
    this.#givePosition()
    this.#publish()
  }

  /** The sink that the feeder gives its fragments to: it tells the window what was appended, and the timeline, and makes the sound decision's sentence. */
  readonly #fragments: Sink = {
    init: async (tracks: ChosenTracks): Promise<void> => {
      const sink = this.#sink
      const feeder = this.#feeder
      if (sink === null || feeder === null) throw new Error('The sink is not open.')
      if (tracks.audio === null && feeder.tracks.audio !== null) {
        this.#say({
          type: 'error',
          from: 'engine',
          code: null,
          message: `The sound had no frames in the first ${SOUND_WAIT_SECONDS} s of the picture, so the play goes on without it.`,
        })
      }
      this.#kinds = tracks.audio === null ? ['video'] : ['video', 'audio']
      if (tracks.audio !== null) this.#stats.codecs.push(codecsOf(tracks.audio.mime))
      await sink.init(tracks)
    },
    append: async (kind: Kind, bytes: Uint8Array, run: FedRun): Promise<void> => {
      const sink = this.#sink
      if (sink === null) throw new Error('The sink is not open.')
      try {
        await sink.append(kind, bytes, run)
      } catch (error) {
        if (error instanceof SinkQuotaError) this.#quota(kind, bytes.length)
        throw error
      }
      this.#window.fed(run)
      this.#appended += 1
      this.#stats.segments += 1
      this.#say({ type: 'append', track: kind, bytes: bytes.length })
    },
  }

  /** A quota error: logged, and the window shrinks. The fragment stays with the feeder, to be appended again. */
  #quota(kind: Kind, pendingBytes: number): void {
    this.#stats.quotaErrors += 1
    this.#say({ type: 'quota', track: kind, pendingBytes })
    const limit = this.#window.quota()
    this.#say({
      type: 'watchdog',
      action: 'quota',
      at: this.#at(),
      detail: `The window now holds at most ${limit} bytes.`,
    })
  }

  /**
   * The common start (DESIGN.md §10.4): the clock goes to the latest of the tracks' first buffered
   * starts at or after the target, so that a track that begins late (a sound shown 0.48 s in) does not
   * leave the element waiting at a time it has no sound for. A move of more than a frame is logged.
   */
  #applyCommonStart(picture: EngineTrack): void {
    const sink = this.#sink
    if (sink === null) return
    const target = this.#target
    let start = target
    for (const kind of this.#kinds) {
      const range = sink.buffered(kind).find(([, end]) => end > target)
      if (range !== undefined) start = Math.max(start, range[0])
    }
    if (start - target > frameSeconds(picture)) {
      this.#say({
        type: 'watchdog',
        action: 'gap',
        at: target,
        detail: `The tracks first have frames at ${start.toFixed(3)} s, so the play starts there and not at ${target.toFixed(3)} s.`,
      })
    }
    if (Math.abs(this.#video.currentTime - start) > 1e-6) sink.seek(start)
  }

  /** Gives the downloader the file offset of the picture at the playhead, when it is known. */
  #givePosition(): void {
    const offset = this.#feeder?.positions.offsetAt(this.#video.currentTime) ?? null
    if (offset !== null) this.#downloader?.setPosition(offset)
  }

  #startTimers(): void {
    const video = this.#video
    const wake = (): void => {
      this.#wake()
    }
    for (const name of ['timeupdate', 'seeking', 'waiting']) {
      video.addEventListener(name, wake)
      this.#listeners.push([name, wake])
    }
    this.#timers.push(
      setInterval(() => {
        const sink = this.#sink
        if (sink !== null && !this.#ended) {
          for (const kind of this.#kinds) this.#window.sync(kind, sink.buffered(kind))
        }
        this.#wake()
      }, WATCH_EVERY_MS),
      setInterval(() => {
        if (this.#started && !this.#video.paused) this.#givePosition()
      }, POSITION_EVERY_MS),
      setInterval(() => {
        const now = performance.now()
        const passed = now - this.#lastStatsAt
        this.#lastStatsAt = now
        if (this.#downloader?.state() === 'reading') this.#stats.readingMs += passed
        if (!this.#feedDone && !this.#failed && this.#started && this.#nothingWanted()) {
          this.#stats.heldMs += passed
        }
        this.#publish()
      }, STATS_EVERY_MS),
    )
  }

  #stopTimers(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer)
    for (const [name, listener] of this.#listeners.splice(0)) {
      this.#video.removeEventListener(name, listener)
    }
  }

  #nothingWanted(): boolean {
    const at = this.#at()
    return this.#kinds.every((kind) => this.#window.wants(kind, at) === null)
  }

  /** Removes what the window says is due, at the keyframes, and tells the window and the timeline. True when it removed something. An abort of the sink ends it quietly. */
  async #removeDue(): Promise<boolean> {
    const sink = this.#sink
    if (sink === null || this.#ended) return false
    let removed = false
    for (const kind of this.#kinds) {
      const cut = this.#window.toRemove(kind, this.#at())
      if (cut === null) continue
      try {
        await sink.remove(kind, cut)
      } catch (error) {
        if (isAbort(error)) return removed
        throw error
      }
      // The window is told the cut as it was asked for: the sink pads the end a little, not the start.
      this.#window.removed(kind, cut)
      this.#say({ type: 'remove', track: kind, before: cut })
      removed = true
    }
    return removed
  }

  /**
   * One step of the feed: removes what is due, then feeds to what the window wants, if it wants any.
   * Answers `'fed'` when it made progress (go on at once), `'idle'` when it has nothing to do or made
   * none (wait for the next wake), and `'ended'` when the file has no more fragments, all appended.
   * A quota error is not an error: the window shrank, and what could be removed was.
   */
  async #feedOnce(): Promise<'fed' | 'idle' | 'ended'> {
    const feeder = this.#feeder
    if (feeder === null) throw new Error('The feeder is not open.')
    if (this.#feedDone) return 'ended'
    const signal = this.#feedControl.signal
    try {
      signal.throwIfAborted()
      await this.#removeDue()
      const at = this.#at()
      let until: number | null = null
      for (const kind of this.#kinds) {
        const wanted = this.#window.wants(kind, at)
        if (wanted !== null) until = Math.max(until ?? -Infinity, wanted.until)
      }
      if (until === null) return 'idle'
      const before = this.#appended
      const result = await feeder.feed(until, this.#fragments, signal)
      if (result === 'ended') {
        this.#feedDone = true
        return 'ended'
      }
      return this.#appended > before ? 'fed' : 'idle'
    } catch (error) {
      if (error instanceof SinkQuotaError) return (await this.#removeDue()) ? 'fed' : 'idle'
      // The end of a feed, whether the play is over or the sink was closed under it, is no failure.
      if (isAbort(error) && !signal.aborted) return 'idle'
      throw error
    }
  }

  /** The loop that feeds for the rest of the play. It ends when the play is over or has failed; a failure is told, not thrown. */
  async #pump(): Promise<void> {
    try {
      while (!this.#stopped && !this.#failed) {
        if (this.#feedDone) {
          if (!this.#ended) await this.#finish()
          else await this.#nextWake()
          continue
        }
        const result = await this.#feedOnce()
        if (result === 'idle') await this.#nextWake()
      }
    } catch (error) {
      if (!this.#stopped && !this.#failed) this.#fail(error)
    }
  }

  /** Ends the stream, once, when every fragment is appended. */
  async #finish(): Promise<void> {
    const sink = this.#sink
    if (sink === null) return
    // Set first, so that nothing is removed or fed while the stream ends: a removal would open it again.
    this.#ended = true
    await sink.end()
    this.#setPhase('ended')
  }

  /** A failure after the first frame: told on the timeline, and the feeding stops. */
  #fail(error: unknown): void {
    if (this.#failed || this.#stopped) return
    this.#failed = true
    const message = messageOf(error)
    this.#stats.error = message
    this.#say({ type: 'error', from: 'engine', code: null, message })
    this.#setPhase('failed')
    this.#feedControl.abort(error)
    this.#stopTimers()
    this.#wake()
  }

  /**
   * A play that is rejected before its first frame: the phase is `failed`, and the sentence is on the
   * timeline once, from whoever found it. The feeder tells a refusal and a damaged file, and the download a
   * read the server refuses for good; any other failure is told here. An abort is the viewer leaving.
   */
  rejected(error: unknown): void {
    if (this.#stopped) return
    const refusal = typeof error === 'object' && error !== null && 'refusal' in error
    const message = refusal ? messageOf(new Error(String(error.refusal))) : messageOf(error)
    const told = refusal || error instanceof Mp4Error || (error instanceof ReadError && error.fatal)
    if (!told) this.#say({ type: 'error', from: 'engine', code: null, message })
    this.#stats.error = message
    this.#setPhase('failed')
  }

  /** The play's life after its first frame, until the signal aborts. Resolves once everything is closed. */
  async run(): Promise<void> {
    const pump = this.#pump()
    if (!this.#signal.aborted) {
      await new Promise<void>((resolve) => {
        this.#signal.addEventListener(
          'abort',
          () => {
            resolve()
          },
          { once: true },
        )
      })
    }
    await pump
    await this.close()
  }

  /** Stops the timers, the listeners and the feed, lets the element go of the media and closes the downloader, which closes the store. Once. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#stopped = true
      this.#stopTimers()
      this.#feedControl.abort(this.#signal.reason)
      this.#wake()
      this.#sink?.close()
      await this.#downloader?.close()
    })()
    return this.#closing
  }
}

/**
 * Plays the file at `url` in `video`, from its start or from `startAt`, to its end. Resolves when the
 * signal aborts, with the downloader, the store and the sink closed. Rejects only before the first frame:
 * with `{ refusal, reason }` (an `EngineRefusal`) when the file cannot play, and otherwise as the failure
 * was, a `ReadError` of the download or the signal's reason.
 */
export async function playStreamed(options: PlayStreamedOptions): Promise<void> {
  const play = new Play(options)
  try {
    await play.open()
  } catch (error) {
    play.rejected(error)
    await play.close()
    throw error
  }
  await play.run()
}

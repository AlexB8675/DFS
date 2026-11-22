// The engine's play (DESIGN.md §10.4; the iron-clad spec §4.8): ties the downloader and its store, the feeder,
// the decoder window and the Media Source sink into one play of a file in a `video` element, from its start or
// from a given time to its end. It opens the download, then the feeder and the sink together; feeds the first
// fragments and puts the clock where every track has frames (the common start); and then feeds in a loop of
// promises, never timers, as the window asks, removes what is played past the window behind, and ends the
// stream once every fragment is in.
//
// The controls are composed from modules of their own: the seeks' events and deadline (`seeks.ts`), the hold
// for the network (`holding.ts`) and the watchdog's samples (`watching.ts`). They decide; this file applies.
// One loop, the pump, is the only caller of the feeder, the window's reset and the sink's reopen. A seek
// outside the window, a refeed and a reopen are requests: each aborts the feed in flight, and the pump serves
// the latest at the top of its loop, so the feeder's cursor is never moved under a feed.
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
import { slowWhile } from '../engine/hold.ts'
import { holdingRange, holdsAt } from '../engine/holds-at.ts'
import { mergeRequests } from '../engine/requests.ts'
import type { Request } from '../engine/requests.ts'
import { feedTargets } from '../engine/targets.ts'
import type { ChosenTracks, EngineTrack } from '../engine/tracks.ts'
import { bytesReceivedOf } from '../engine/received.ts'
import type { WatchAction } from '../engine/watchdog.ts'
import { DecoderWindow } from '../engine/window.ts'
import type { FedRun } from '../engine/window.ts'
import {
  POSITION_EVERY_MS,
  SEEK_DEADLINE_MS,
  SOUND_WAIT_SECONDS,
  STATS_EVERY_MS,
  WATCH_EVERY_MS,
  WINDOW_AHEAD_SECONDS,
} from '../limits.ts'
import { openDownload } from '../open-download.ts'
import type { StorageEstimator, StoreWorker } from '../open.ts'
import { ReadError } from '../read.ts'
import { Holding } from './holding.ts'
import { Seeks } from './seeks.ts'
import { MediaSourceSink, SinkQuotaError } from './sink.ts'
import { HAVE_FUTURE_DATA, aheadOf, hasDataAt, isPaused } from './video.ts'
import { Watching } from './watching.ts'

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
  /** The bytes of the file that the store has taken, cumulative: what it holds, what it has evicted and what it has dropped (frontier blocks let go of). */
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
  /** The bytes the store has evicted from its slots, in all: stored data that was lost (a frontier block let go of is not counted, R49). */
  evictedBytes: number
  /** The bytes the decoder window holds. */
  windowBytes: number
  /** The downloader's measured rate in bytes a second, null before it knows one. */
  rate: number | null
  /** The slow-video signal: the downloader's measured rate is known and below the file's bit rate (its size over its length). Worked out while the downloader is `reading` or `waiting` (so that it does not flicker in a retry), once a rate is known; false when it is `done`, `full` or `failed`, or the rate or the length is unknown. */
  slow: boolean
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
  /**
   * Whether the engine should be playing now: read each time it would start or resume play (at the start, after a
   * seek, when a hold for the network ends). Missing, the engine never calls `play()` for those, and never holds
   * the play: the element is the viewer's. (A reopen of the decoder by the watchdog plays again if it was playing.)
   */
  autoplay?: () => boolean
  onEvent: (event: TimelineEventInput) => void
  onStats: (stats: EngineStats) => void
  fetch?: typeof fetch
  estimate?: StorageEstimator
  /** For tests: the decoder window's starting limit in bytes; `WINDOW_BYTES` when missing. */
  windowBytes?: number
}

function isRefusal(error: unknown): error is { refusal: string } {
  return typeof error === 'object' && error !== null && 'refusal' in error
}

/** Whether a lower layer has already put the failure on the timeline: a refusal and a damaged file (the feeder's), a read the server refused for good (the download's). */
function isTold(error: unknown): boolean {
  return (
    isRefusal(error) || error instanceof Mp4Error || (error instanceof ReadError && error.fatal)
  )
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

class Play {
  readonly #options: PlayStreamedOptions
  readonly #video: HTMLVideoElement
  readonly #signal: AbortSignal
  /** Aborts what the feed waits on: when the play is over or fails, and for a request (a seek, a refeed, a reopen), which starts the next feed with a new one. */
  #feedControl = new AbortController()
  readonly #window: DecoderWindow
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
  /** True once the stream was ended: nothing is appended or removed after it, until a request starts the feed again. */
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
  /** The start the sink was asked for while it has not yet put the clock there: the playhead is the start until it has. */
  #pendingStart: number | null = null
  /** True from a quota error that nothing could mend until the next append or removal: the timeline hears of it once. */
  #quotaStalled = false
  /** Every `SinkQuotaError` of the play, one per refusal: a cover counts as refused only when this rose during a round of it (a stall, `#quotaStalled`, can outlive a refeed). */
  #quotaRefusals = 0
  /** Where the playhead was at such an error once the play had begun: the feed waits for it to move. */
  #stallAt: number | null = null
  /** What the pump is asked to do next, if anything: requests are merged, never dropped. */
  #request: Request | null = null
  /** The request the pump is serving: merged back into the next when a newer one aborts it. */
  #serving: Request | null = null
  /** True while the pump awaits `feeder.feed`: a feed that waits for bytes. */
  #feeding = false
  /** The time of the viewer's latest seek during the opening, which the start is moved to. */
  #userSeek: number | null = null
  /** The time the engine itself moved the clock to, until the element's `seeking` for it has come: that seek is the engine's, not the viewer's. */
  #ownSeek: number | null = null
  /** Where the clock is expected to be before the first frame: a clock elsewhere is a seek of the viewer's that the element did not tell. */
  #clockHint = 0
  readonly #seeks: Seeks
  readonly #holding: Holding
  #watching: Watching | null = null
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
    evictedBytes: 0,
    windowBytes: 0,
    rate: null,
    slow: false,
  }

  constructor(options: PlayStreamedOptions) {
    this.#options = options
    this.#video = options.video
    this.#signal = options.signal
    this.#window = new DecoderWindow(options.windowBytes)
    this.#seeks = new Seeks(
      options.video,
      (event) => {
        this.#say(event)
      },
      () => performance.now(),
    )
    this.#holding = new Holding({
      video: options.video,
      autoplay: options.autoplay,
      downloader: () => this.#downloader,
      feeder: () => this.#feeder,
      feedDone: () => this.#feedDone,
      canCheck: () => !this.#busy() && !this.#stopped && !this.#failed,
      say: (event) => {
        this.#say(event)
      },
      stats: this.#stats,
      changed: () => {
        this.#publish()
      },
      now: () => performance.now(),
    })
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
      const storeStats = store.stats()
      stats.storedBytes = storeStats.storedBytes
      stats.evictedBytes = storeStats.evictedBytes
      stats.bytesReceived = bytesReceivedOf(held.bytes(), storeStats)
      stats.rate = downloader.rate()
      const duration = this.#feeder?.durationSeconds ?? null
      stats.slow =
        duration !== null &&
        duration > 0 &&
        slowWhile(downloader.state(), stats.rate, downloader.fileSize / duration)
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
    const pending = this.#pendingStart
    if (pending !== null) {
      if (Math.abs(this.#video.currentTime - pending) > 0.25) return pending
      this.#pendingStart = null
    }
    return this.#started ? this.#video.currentTime : this.#target
  }

  #wake(): void {
    for (const wake of this.#wakers.splice(0)) wake()
  }

  /** Resolves at the next tick, `timeupdate`, `seeking`, `waiting`, request or abort. */
  #nextWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#wakers.push(resolve)
    })
  }

  /** Puts the clock at `at` through the sink, and remembers that the `seeking` that follows is the engine's own. */
  #moveTo(at: number): void {
    this.#ownSeek = at
    this.#clockHint = at
    this.#sink?.seek(at)
  }

  /**
   * Asks the pump for a seek, a refeed or a reopen: the feed in flight is aborted, and the pump serves the
   * request, the strongest of those asked before it got to it. Does nothing once the play is over.
   */
  #post(request: Request): void {
    if (this.#stopped || this.#failed) return
    this.#request = mergeRequests(this.#request, request)
    this.#restartFeed()
    this.#wake()
  }

  /** Whether a request waits for the pump (the compiler cannot see that an `await` lets one come). */
  #requested(): boolean {
    return this.#request !== null
  }

  /** The request that waits for the pump, read afresh (the compiler cannot see that an `await` lets one come). */
  #waiting(): Request | null {
    return this.#request
  }

  /** Whether a request waits or is being served: the feed is being moved, and the hold and the watchdog have nothing to say. */
  #busy(): boolean {
    return this.#request !== null || this.#serving !== null
  }

  /** A request for what is asked of the engine now, from the playhead's place and intent: what the watchdog and the deadline give. */
  #own(kind: Request['kind']): Request {
    return {
      kind,
      to: this.#at(),
      told: false,
      seek: false,
      playing: !isPaused(this.#video) || this.#holding.wantsPlay,
    }
  }

  /** Ends the feed in flight, as a restart and no failure, and gives the next one a new signal. */
  #restartFeed(): void {
    if (this.#stopped || this.#failed) return
    this.#feedControl.abort(new DOMException('The feed was restarted.', 'AbortError'))
    this.#feedControl = new AbortController()
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
      // The index comes first: the onward reads begin once the feeder has it (below), so that its bytes do not share the link with a read that the start cannot use yet.
      holdOnward: true,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
    })
    this.#downloader = downloader
    // Each fails the other at once: a refused file does not wait for the element, nor the element for the file.
    const opening = new AbortController()
    const joined = AbortSignal.any([this.#signal, opening.signal])
    const failOther = (reason: unknown): void => {
      opening.abort(reason)
    }
    const feederOpen = Feeder.open(
      downloader,
      (mime) => MediaSource.isTypeSupported(mime),
      this.#emit,
      { signal: joined },
    )
    const sinkOpen = MediaSourceSink.open(this.#video, null, joined)
    feederOpen.catch(failOther)
    sinkOpen.catch(failOther)
    const [opened, attached] = await Promise.allSettled([feederOpen, sinkOpen])
    if (opened.status === 'fulfilled') this.#feeder = opened.value
    if (attached.status === 'fulfilled') this.#sink = attached.value
    if (opened.status === 'rejected') throw opened.reason
    if (attached.status === 'rejected') throw attached.reason
    const feeder = opened.value
    const sink = attached.value
    sink.setDuration(feeder.durationSeconds)

    const { video: picture, audio } = feeder.tracks
    this.#watching = new Watching(this.#video, picture)
    this.#stats.codecs = [codecsOf(picture.mime)]
    this.#stats.supported[picture.mime] = true
    if (audio !== null) this.#stats.supported[audio.mime] = true
    this.#startTimers()
    this.#setPhase('buffering')

    // The first fragments of the start. A seek of the viewer's meanwhile moves the start: the fragments fed for the old one stay in the buffer, but are cleared, and the feed begins again at the new one.
    let target = this.#target
    let first = true
    for (;;) {
      const signal = this.#feedControl.signal
      try {
        if (target > 0 || !first) await feeder.seek(target, signal)
        first = false
        // The index is read and the position is the start's: the eager reading begins.
        downloader.releaseOnward()
        await this.#feedCovering(target, () => this.#userSeek !== null)
      } catch (error) {
        // A seek of the viewer's restarted the feed: that is no failure. Anything else is.
        if (!isAbort(error) || this.#userSeek === null || this.#stopped) throw error
      }
      this.#signal.throwIfAborted()
      const sought = this.#openingSeek()
      if (sought === null) break
      target = sought
      this.#target = sought
      this.#resetFeed()
      await this.#clearSink()
      // A newer seek during the clearing is taken before the old target is fed.
      while (this.#userSeek !== null) {
        target = this.#userSeek
        this.#userSeek = null
        this.#target = target
      }
    }
    this.#target = target
    this.#applyCommonStart(target)
    this.#started = true
    this.#givePosition()
    this.#holding.begin('start')
    this.#publish()
  }

  /** The target of a seek of the viewer's made during the opening, if there was one: told by the element, or seen as a clock that is not where the engine expects it. */
  #openingSeek(): number | null {
    const told = this.#userSeek
    this.#userSeek = null
    if (told !== null) return told
    const now = this.#video.currentTime
    if (Math.abs(now - this.#clockHint) <= 0.25) return null
    this.#clockHint = now
    this.#seeks.begin(now, false)
    this.#stats.seeks += 1
    return now
  }

  /** Feeds until every playing track has data past `target`, the feed ends, a feed makes no progress, or `interrupted`. */
  async #feedCovering(target: number, interrupted: () => boolean): Promise<void> {
    const sink = this.#sink
    if (sink === null) throw new Error('The sink is not open.')
    // True after a round that the browser refused, with nothing mended: the feed starts at the keyframe at or before
    // the target, so nothing behind it can be removed, and no later wait can free room. It is tried once more, at the
    // next wake. Only a refusal of this cover counts, not a stall that began before it (§10.4).
    let refused = false
    for (;;) {
      const refusals = this.#quotaRefusals
      const result = await this.#feedOnce()
      if (interrupted()) return
      if (result === 'ended' || this.#covers(sink, target)) return
      if (result === 'fed') {
        refused = false
        continue
      }
      if (this.#quotaRefusals === refusals) return
      if (refused) {
        throw new Error(
          "A group of pictures of this file is larger than the browser's buffer, so it cannot be played here.",
        )
      }
      refused = true
      await this.#nextWake()
      // The retry must really try: a playhead that has not moved would make the feed wait for it.
      this.#stallAt = null
    }
  }

  /** Whether every playing track has buffered data that ends past `target`. */
  #covers(sink: MediaSourceSink, target: number): boolean {
    return this.#kinds.every((kind) => sink.buffered(kind).some(([, end]) => end > target))
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
        if (error instanceof SinkQuotaError) {
          this.#quotaRefusals += 1
          this.#quota(kind, bytes.length)
        }
        throw error
      }
      this.#quotaStalled = false
      this.#window.fed(run)
      this.#appended += 1
      this.#stats.segments += 1
      this.#say({ type: 'append', track: kind, bytes: bytes.length })
    },
  }

  /** A quota error: logged, and the window shrinks. The fragment stays with the feeder, to be appended again. */
  #quota(kind: Kind, pendingBytes: number): void {
    // A refusal that follows another with nothing mended between is the same stall: it shrinks the window once and is told once.
    if (this.#quotaStalled) return
    this.#quotaStalled = true
    const limit = this.#window.quota()
    this.#stats.quotaErrors += 1
    this.#say({ type: 'quota', track: kind, pendingBytes })
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
   * leave the element waiting at a time it has no sound for. A move of more than a frame is logged. It is
   * the one start-gap policy: a start, a seek outside the window and a reopen all end in it.
   */
  #applyCommonStart(target: number): void {
    const sink = this.#sink
    const feeder = this.#feeder
    if (sink === null || feeder === null) return
    const picture = feeder.tracks.video
    // A target past the end of the file (the feed ended before covering it): the play starts at the last frames there are.
    const past = this.#feedDone && !this.#covers(sink, target)
    let start = past ? -Infinity : target
    for (const kind of this.#kinds) {
      const ranges = sink.buffered(kind)
      if (past) {
        const last = ranges.at(-1)
        if (last !== undefined) start = Math.max(start, last[0])
        continue
      }
      const range = ranges.find(([, end]) => end > target)
      if (range !== undefined) start = Math.max(start, range[0])
    }
    if (start === -Infinity) start = target
    if (start - target > frameSeconds(picture)) {
      this.#say({
        type: 'watchdog',
        action: 'gap',
        at: target,
        detail: `The tracks first have frames at ${start.toFixed(3)} s, so the play starts there and not at ${target.toFixed(3)} s.`,
      })
    }
    // A start that is not the target (a sound late, a target past the end) is the seek's target now, so that it completes.
    if (Math.abs(start - target) > 1e-6) this.#seeks.retarget(start)
    if (Math.abs(this.#video.currentTime - start) > 1e-6) {
      this.#moveTo(start)
      if (Math.abs(this.#video.currentTime - start) > 1e-6) this.#pendingStart = start
    }
  }

  /**
   * A seek within the window whose target lies before the start of the range that holds it, on a playing track
   * (a late first frame, or the start of what the window keeps, after a removal): the clock goes to the latest
   * such start, as the common start does for a late track, and the seek is retargeted there so that it completes.
   * Within the window `last[0]` is the window's start, not the last group, so the common start's branch for a
   * target past the end does not apply.
   */
  #applyWindowStart(target: number): void {
    const sink = this.#sink
    const feeder = this.#feeder
    if (sink === null || feeder === null) return
    let start = target
    for (const kind of this.#kinds) {
      const range = holdingRange(sink.buffered(kind), target, this.#feedDone)
      if (range !== undefined) start = Math.max(start, range[0])
    }
    if (start - target <= 1e-6) return
    if (start - target > frameSeconds(feeder.tracks.video)) {
      this.#say({
        type: 'watchdog',
        action: 'gap',
        at: target,
        detail: `The tracks first have frames at ${start.toFixed(3)} s, so the play starts there and not at ${target.toFixed(3)} s.`,
      })
    }
    this.#seeks.retarget(start)
    this.#moveTo(start)
  }

  /** Gives the downloader the file offset of the picture at the playhead, when it is known. */
  #givePosition(): void {
    const offset = this.#feeder?.positions.offsetAt(this.#video.currentTime) ?? null
    if (offset !== null) this.#downloader?.setPosition(offset)
  }

  /** Whether the decoder window holds the playhead at `at`: every playing track has buffered data there, with room ahead, or to the end of the file. */
  #inWindow(at: number): boolean {
    const sink = this.#sink
    if (sink === null) return false
    return this.#kinds.every((kind) => holdsAt(sink.buffered(kind), at, this.#feedDone))
  }

  /** The element's `seeking`: a seek of the engine's own is passed over; the viewer's is told, and, outside the window, asked of the pump. */
  #onSeeking(): void {
    const video = this.#video
    const at = video.currentTime
    const own = this.#ownSeek
    this.#ownSeek = null
    this.#holding.moved()
    if (own !== null && Math.abs(own - at) < 1e-3) {
      this.#wake()
      return
    }
    if (this.#stopped || this.#failed) return
    this.#watching?.noteSeek()
    // A seek that waited for data is the old position's: the viewer has moved the clock since.
    this.#sink?.cancelSeek()
    // The playhead moved: what waited for it to move, no longer waits.
    this.#pendingStart = null
    this.#stallAt = null
    this.#quotaStalled = false
    this.#clockHint = at
    if (!this.#started) {
      // A seek during the opening is kept, and applied at the start.
      this.#userSeek = at
      this.#seeks.begin(at, false)
      this.#stats.seeks += 1
      this.#restartFeed()
      this.#wake()
      return
    }
    const inWindow = this.#inWindow(at)
    // The intent before the seek is settled: playing, or held for a play that is wanted.
    const playing = !isPaused(video) || this.#holding.wantsPlay
    this.#seeks.begin(at, inWindow)
    // A seek into the band just before a range's start (inside `holdsAt`'s edge) has no data at its target: the clock goes to the latest such start.
    if (inWindow) this.#applyWindowStart(at)
    // Within the window the playhead's own place is the position. Outside it the feeder's seek gives it, at the
    // group of the target, which only the feeder knows: `Positions` still holds the old runs then, and gave
    // the downloader a wrong offset first, and a second restart later.
    if (inWindow) this.#givePosition()
    if (!inWindow) {
      this.#stats.seeks += 1
      this.#post({ kind: 'seek', to: at, told: true, seek: true, playing })
    }
    if (!this.#busy()) this.#holding.check()
    this.#wake()
  }

  #startTimers(): void {
    this.#lastStatsAt = performance.now()
    const video = this.#video
    const on = (name: string, listener: () => void): void => {
      video.addEventListener(name, listener)
      this.#listeners.push([name, listener])
    }
    const wake = (): void => {
      this.#wake()
    }
    const picture = (): void => {
      this.#seeks.check()
    }
    on('timeupdate', wake)
    on('seeking', () => {
      this.#onSeeking()
    })
    on('waiting', () => {
      this.#wake()
      if (this.#started) this.#holding.stalled()
    })
    for (const name of ['timeupdate', 'seeked', 'playing', 'canplay', 'loadeddata']) {
      on(name, picture)
    }
    on('pause', () => {
      this.#holding.paused()
    })
    on('play', () => {
      this.#holding.played()
    })
    this.#timers.push(
      setInterval(() => {
        const sink = this.#sink
        if (sink !== null && !this.#ended) {
          for (const kind of this.#kinds) this.#window.sync(kind, sink.buffered(kind))
        }
        // A play that has ended wakes only for a request, not for a tick.
        if (!this.#ended) this.#wake()
        if (this.#started && !this.#stopped && !this.#failed) this.#control()
      }, WATCH_EVERY_MS),
      setInterval(() => {
        const video = this.#video
        if (
          this.#started &&
          !video.paused &&
          !video.ended &&
          // The clock is at a seek's target before the runs there are fed: its place is not known yet, and the
          // feeder's seek has given the downloader the group's.
          !this.#seeks.pending &&
          this.#downloader?.state() !== 'done'
        ) {
          this.#givePosition()
        }
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

  /** What the tick does for the controls: the seek's picture and deadline, the hold's release, and the watchdog's sample. */
  #control(): void {
    this.#seeks.check()
    const late = this.#seeks.overdue()
    if (late !== null) {
      const seconds = SEEK_DEADLINE_MS / 1000
      this.#say({
        type: 'error',
        from: 'engine',
        code: null,
        message: `The seek to ${late.toFixed(1)} s showed no picture in ${seconds} s.`,
      })
      // A request that waits or is served is already feeding at its target: a refeed on top of it would only restart it.
      if (!this.#busy()) {
        this.#say({
          type: 'watchdog',
          action: 'refeed',
          at: this.#video.currentTime,
          detail: `The seek to ${late.toFixed(1)} s passed its deadline of ${seconds} s, so the window is fed again from the store there.`,
        })
        this.#post(this.#own('refeed'))
      }
    }
    // While the feed is being moved the hold has nothing to check, and the watchdog is told the play is held, so its clocks start afresh.
    if (!this.#busy()) this.#holding.check()
    const action =
      this.#watching?.sample(
        this.#holding.holding || this.#busy(),
        this.#feeding,
        this.#trackEnds(),
      ) ?? null
    if (action !== null) this.#applyWatch(action)
  }

  /** Where each playing track's buffer ends at the playhead (the end of the last range that starts at or before it); null for a track with none there. */
  #trackEnds(): { name: string; end: number | null }[] {
    const sink = this.#sink
    if (sink === null) return []
    const at = this.#video.currentTime
    return this.#kinds.map((kind) => {
      const before = sink.buffered(kind).filter(([start]) => start <= at)
      return {
        name: kind === 'audio' ? 'sound' : 'picture',
        end: before.length === 0 ? null : Math.max(...before.map(([, end]) => end)),
      }
    })
  }

  /** Does what the watchdog says, and logs it. */
  #applyWatch(action: WatchAction): void {
    const at = this.#video.currentTime
    switch (action.action) {
      case 'gap':
        this.#say({
          type: 'watchdog',
          action: 'gap',
          at,
          detail: `The clock stood still at ${at.toFixed(3)} s and the next frames are at ${action.to.toFixed(3)} s, so it steps there.`,
        })
        this.#moveTo(action.to)
        break
      case 'refeed':
        // A feed that waits for bytes, with no data at the playhead, is not a stuck play: a refeed would only restart the wait.
        if (this.#feeding && !hasDataAt(this.#video.buffered, at)) break
        this.#say({
          type: 'watchdog',
          action: 'refeed',
          at,
          detail: `The clock stood still at ${at.toFixed(3)} s, so the window is emptied and fed again from the store there.`,
        })
        this.#post(this.#own('refeed'))
        break
      case 'reopen':
        this.#say({
          type: 'watchdog',
          action: 'reopen',
          at,
          detail: `The clock stood still at ${at.toFixed(3)} s after a refeed, so Media Source is opened again there.`,
        })
        this.#stats.reopens += 1
        this.#post(this.#own('reopen'))
        break
      case 'stuck':
        this.#say({ type: 'watchdog', action: 'stuck', at, detail: action.detail })
        this.#fail(new Error(action.detail))
        break
    }
  }

  #stopTimers(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer)
    this.#holding.dispose()
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

  /** Empties the decoder's buffers: what they hold is not what the window will be fed with, once the feed is moved. */
  async #clearSink(): Promise<void> {
    const sink = this.#sink
    if (sink === null) return
    // A kind with no buffer yet (before the first feed has given the sink its tracks) has nothing to clear.
    for (const kind of this.#kinds) {
      if (sink.buffered(kind).length > 0) await sink.remove(kind, Infinity)
    }
  }

  /** Starts the feed afresh: the window holds nothing, nothing is ended, and what waited for the playhead or for room waits no more. */
  #resetFeed(): void {
    this.#window.reset()
    this.#feedDone = false
    this.#ended = false
    // A quota stall is not cleared here: a refeed that meets the same refusal is the same stall, told once.
    this.#stallAt = null
    this.#pendingStart = null
    if (this.#stats.phase === 'ended') this.#setPhase('buffering')
  }

  /**
   * One step of the feed: removes what is due, then feeds to what the window wants, if it wants any.
   * Answers `'fed'` when it made progress (go on at once), `'idle'` when it has nothing to do or made
   * none (wait for the next wake), and `'ended'` when the file has no more fragments, all appended.
   * A quota error is not an error: the window shrank, and what could be removed was. A feed that a
   * request restarted is `'idle'`: the pump serves the request next.
   */
  async #feedOnce(): Promise<'fed' | 'idle' | 'ended'> {
    const feeder = this.#feeder
    if (feeder === null) throw new Error('The feeder is not open.')
    if (this.#feedDone) return 'ended'
    const signal = this.#feedControl.signal
    try {
      signal.throwIfAborted()
      if (this.#stallAt !== null) {
        // After a quota error that nothing could mend, the feed waits for the playhead to move; a clock that has run out of data cannot, so a starved element tries again.
        const moved = Math.abs(this.#video.currentTime - this.#stallAt) > 1e-3
        if (!moved && this.#video.readyState >= HAVE_FUTURE_DATA) return 'idle'
        this.#stallAt = null
      }
      if (await this.#removeDue()) this.#quotaStalled = false
      const at = this.#at()
      const untils = feedTargets(this.#kinds.map((kind) => this.#window.wants(kind, at)))
      // The least first, so that a track far ahead does not pull the other past its window in one call; the next only when that appended nothing.
      for (const until of untils) {
        const before = this.#appended
        this.#feeding = true
        let result: 'more' | 'ended'
        try {
          result = await feeder.feed(until, this.#fragments, signal)
        } finally {
          this.#feeding = false
        }
        if (result === 'ended') {
          this.#feedDone = true
          return 'ended'
        }
        if (this.#appended > before) return 'fed'
      }
      return 'idle'
    } catch (error) {
      if (error instanceof SinkQuotaError) {
        if (await this.#removeDue()) {
          this.#quotaStalled = false
          return 'fed'
        }
        if (this.#started) this.#stallAt = this.#video.currentTime
        return 'idle'
      }
      // The end of a feed, whether a request restarted it or the sink was closed or reopened under it, is no failure; the play's own end is thrown to the pump, which is stopping.
      if (isAbort(error) && !this.#stopped && !this.#failed) return 'idle'
      throw error
    }
  }

  /** The loop that feeds for the rest of the play, and serves the requests. It ends when the play is over or has failed; a failure is told, not thrown. */
  async #pump(): Promise<void> {
    try {
      while (!this.#stopped && !this.#failed) {
        if (this.#requested()) {
          await this.#serve()
          continue
        }
        if (this.#feedDone) {
          if (!this.#ended) await this.#finish()
          else await this.#nextWake()
          continue
        }
        const result = await this.#feedOnce()
        if (result === 'idle' && !this.#requested()) await this.#nextWake()
      }
    } catch (error) {
      if (!this.#stopped && !this.#failed) this.#fail(error)
    }
  }

  /**
   * Serves the pending request, from the place it carries (`to`, never the clock read after a reopen). A seek
   * or a refeed empties the decoder's buffers, as the window's book is emptied, and feeds from `to` out of the
   * store (which keeps what it holds, and fetches only what it lacks); after the end, and for a reopen (the
   * watchdog's last resort), Media Source is opened again instead (a removal would open an ended one). The feed
   * ends in the common start; a seek's ends in the hold, and a play that was playing before a reopen plays
   * again. A newer request ends this one at once, and this one is merged into it, so what it carried (a
   * reopen, a seek's target and hold) is still served.
   */
  async #serve(): Promise<void> {
    const request = this.#request
    const sink = this.#sink
    const feeder = this.#feeder
    if (request === null || sink === null || feeder === null) return
    this.#request = null
    this.#serving = request
    const video = this.#video
    const signal = this.#feedControl.signal
    let completed = false
    try {
      const { to } = request
      const reopen = request.kind === 'reopen' || this.#ended
      if (reopen) {
        this.#clockHint = to
        this.#ownSeek = to
        await sink.reopen(to, signal)
      } else {
        await this.#clearSink()
      }
      this.#resetFeed()
      // A clock that is not at the target yet (a seek the sink deferred) leaves the playhead at the target for the feed.
      if (Math.abs(video.currentTime - to) > 1e-6) this.#pendingStart = to
      await feeder.seek(to, signal)
      await this.#feedCovering(to, () => this.#requested())
      if (this.#requested()) return
      this.#signal.throwIfAborted()
      this.#applyCommonStart(to)
      this.#givePosition()
      if (request.seek) this.#holding.begin('seek', request.playing)
      // A new Media Source pauses the element: the engine gives back what it took, with or without an autoplay.
      if (reopen && request.playing && !this.#holding.holding && isPaused(video)) {
        video.play().catch(() => undefined)
      }
      completed = true
    } catch (error) {
      // A newer request, or the end of the play, ends this one; anything else is the play's failure.
      if (isAbort(error) || this.#stopped || this.#failed) return
      throw error
    } finally {
      this.#serving = null
      const newer = this.#waiting()
      if (!completed && newer !== null) this.#request = mergeRequests(request, newer)
    }
  }

  /** Ends the stream, once, when every fragment is appended. */
  async #finish(): Promise<void> {
    const sink = this.#sink
    if (sink === null) return
    // Set first, so that nothing is removed or fed while the stream ends: a removal would open it again.
    this.#ended = true
    await sink.end()
    // A play that was stopped or failed meanwhile, or a request that waits, has the last word: no phase of an end that is not the play's.
    if (this.#stopped || this.#failed || this.#requested()) return
    this.#setPhase('ended')
  }

  /** A failure after the first frame: told on the timeline, and the feeding stops. */
  #fail(error: unknown): void {
    if (this.#failed || this.#stopped) return
    this.#failed = true
    const message = messageOf(error)
    this.#stats.error = message
    if (!isTold(error)) this.#say({ type: 'error', from: 'engine', code: null, message })
    this.#setPhase('failed')
    this.#request = null
    this.#feedControl.abort(error)
    this.#stopTimers()
    this.#wake()
    // No more is read or stored; the element keeps its last picture until the signal.
    void this.#downloader?.close()
  }

  /**
   * A play that is rejected before its first frame: the phase is `failed`, and the sentence is on the
   * timeline once, from whoever found it. The feeder tells a refusal and a damaged file, and the download a
   * read the server refuses for good; any other failure is told here. An abort is the viewer leaving.
   */
  rejected(error: unknown): void {
    if (this.#stopped) return
    const message = isRefusal(error) ? messageOf(new Error(error.refusal)) : messageOf(error)
    if (!isTold(error)) this.#say({ type: 'error', from: 'engine', code: null, message })
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
    // A SourceBuffer operation that does not end must not hold the closing.
    this.#sink?.close()
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

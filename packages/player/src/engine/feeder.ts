// The feeder (DESIGN.md §10.4; the iron-clad spec §4.8): turns `@dfs/mp4`'s one source into
// fragments for a sink, reading the file through a `ByteSource`. It opens a file (the head and
// the tail at once, then what the reader asks for), seeks it, and feeds fragments in time order.
// It is pure: no DOM, no timer, nothing it waits for but the source and the sink. The same code
// serves an MP4 and a Matroska file, for the reader's functions are the same for both.
//
// The rule for each read (R19): of the tracks that have frames left, the one whose fed time ends
// earliest says where to read (the picture on a tie), so that a file that lays its sound apart
// from its picture feeds both, in step. The read is a chunk, doubled while it completes no frame,
// and a frame that no chunk of `MAX_CHUNK_BYTES` completes fails the play (R18).

import {
  Mp4Error,
  byteSpan,
  fragment,
  fragmentRuns,
  framesIn,
  nextReads,
  openSource,
  presentationSeconds,
  seekCursor,
  startCursor,
} from '@dfs/mp4'
import type { ByteRange, Chunk, Cursor, FragmentTrack, SourceIndex } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { clip } from '../downloader.ts'
import {
  CHUNK_BYTES,
  HEAD_BYTES,
  MAX_CHUNK_BYTES,
  SOUND_WAIT_SECONDS,
  TAIL_BYTES,
} from '../limits.ts'
import { IndexCache } from './index-cache.ts'
import { Positions } from './positions.ts'
import type { ByteSource } from './source.ts'
import { chooseEngineTracks } from './tracks.ts'
import type { ChosenTracks, EngineRefusal, EngineTrack } from './tracks.ts'
import type { FedRun } from './window.ts'

/** What the feeder gives its fragments to: the SourceBuffers, in the page. */
export interface Sink {
  /** Called once, after the first feed has decided whether the play has a sound: `audio` is null when it has none. */
  init(tracks: ChosenTracks): Promise<void>
  /** A fragment of a track, in time order, and what it covers. */
  append(kind: 'video' | 'audio', bytes: Uint8Array, run: FedRun): Promise<void>
}

/** A fragment made and not yet given to the sink, and the least offset of the file its frames lie at. */
interface Pending {
  kind: 'video' | 'audio'
  bytes: Uint8Array
  run: FedRun
  offset: number
}

type Kind = 'video' | 'audio'

function send(onEvent: (event: TimelineEventInput) => void, message: string): void {
  onEvent({ type: 'error', from: 'engine', code: null, message: clip(message) })
}

/** True when `after` is further along the file than `before`: a frame was taken, or the reader moved. */
function advanced(before: Cursor, after: Cursor): boolean {
  if (before.container === 'mp4' && after.container === 'mp4') {
    return before.videoFrame !== after.videoFrame || before.soundFrame !== after.soundFrame
  }
  if (before.container === 'matroska' && after.container === 'matroska') {
    return before.at !== after.at || before.ended !== after.ended
  }
  return false
}

/** The playback times a run of frames covers: from the first shown to the end of the last shown. */
function timesOf(track: EngineTrack, frames: FragmentTrack, from: number, to: number): FedRun {
  const { table } = frames
  const { timing } = track.track
  let start = Infinity
  let end = -Infinity
  for (let i = from; i < to; i += 1) {
    const shown = presentationSeconds(table, timing, i)
    start = Math.min(start, shown)
    end = Math.max(end, shown + (table.durations[i] ?? 0) / table.timescale)
  }
  return {
    kind: track.kind,
    start,
    end,
    bytes: 0,
    // A picture's run starts at a keyframe when its first frame is a sync frame; a sound's frames all are.
    keyframe: track.kind === 'audio' || table.sync[from] === 1,
  }
}

export class Feeder {
  readonly index: SourceIndex
  readonly tracks: ChosenTracks
  readonly durationSeconds: number | null
  /** Where in the file each fragment given lies, for the downloader's position. */
  readonly positions = new Positions()

  readonly #source: ByteSource
  readonly #onEvent: (event: TimelineEventInput) => void
  readonly #cache: IndexCache
  #cursor: Cursor
  /** Whether the play has a sound, decided once at the first feed (R21): null until `init` was called. */
  #decision: 'sound' | 'none' | null = null
  /** Fragments made and not yet appended: the first feed's, until the decision, and any the sink refused. */
  #pending: Pending[] = []
  /** Whether a sound frame has come since the start or the last seek, and where the picture began. */
  #sawSound = false
  /** Whether a read was made at the sound's next offset since the start or the last seek (R21c). */
  #soundRead = false
  #pictureFrom: number | null = null
  /** Where each track's fed time ends, on the playback timeline, or null before it has fed any. */
  #fedEnd: Record<Kind, number | null> = { video: null, audio: null }
  /** The sequence number of each track's last fragment, never reset in a play. */
  readonly #sequence: Record<Kind, number> = { video: 0, audio: 0 }

  private constructor(
    source: ByteSource,
    onEvent: (event: TimelineEventInput) => void,
    cache: IndexCache,
    index: SourceIndex,
    tracks: ChosenTracks,
  ) {
    this.#source = source
    this.#onEvent = onEvent
    this.#cache = cache
    this.index = index
    this.tracks = tracks
    this.durationSeconds = index.durationSeconds
    this.#cursor = startCursor(index, tracks.video.soundId)
  }

  /** How many bytes of the file's index the cache holds: none for an MP4 once it is open, for its seeks read no chunk. */
  get cachedBytes(): number {
    return this.#cache.bytes
  }

  /**
   * Opens the file: the head and the tail are asked for at once (`fetchNow`). The reader is
   * given the head as soon as it is read, and every range it then needs is one plain read
   * through the source, which serves it from the store or from the read in flight, so a file
   * whose index is at its start does not wait for its end. The tail's prefetch carries a signal
   * of its own, aborted when the open ends (used or not) and when `options.signal` aborts, so
   * nothing is left waiting on the downloader. Every chunk the open read is held in a list of
   * its own until the reader is done, and only then goes to the index cache (which may evict,
   * and the reader needs all it asked for). Rejects with `{ refusal, reason }` (after logging
   * the sentence) when the file can't be played; anything else, a failed read or an abort (the
   * signal's reason, with no event), rejects as it is.
   */
  static async open(
    source: ByteSource,
    isTypeSupported: (mime: string) => boolean,
    onEvent: (event: TimelineEventInput) => void,
    options: { cacheBytes?: number; signal?: AbortSignal } = {},
  ): Promise<Feeder> {
    const { signal } = options
    const size = source.fileSize
    const headRange: ByteRange = { start: 0, end: Math.min(HEAD_BYTES, size) }
    const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES)
    const tailRange: ByteRange | null = tailStart < size ? { start: tailStart, end: size } : null

    const tail = new AbortController()
    const callOff = (): void => {
      tail.abort(signal?.reason)
    }
    signal?.addEventListener('abort', callOff, { once: true })
    try {
      signal?.throwIfAborted()
      // A failure of an ask to fetch now shows in the reads that need the range, if any does.
      const ignore = (): undefined => undefined
      if (size > 0) {
        source.fetchNow(headRange, signal).catch(ignore)
        if (tailRange !== null) source.fetchNow(tailRange, tail.signal).catch(ignore)
      }
      const held: Chunk[] = [
        { start: 0, bytes: size > 0 ? await source.read(headRange, signal) : new Uint8Array(0) },
      ]
      let index: SourceIndex
      try {
        let step = openSource(held, size)
        while ('need' in step) {
          const need = { start: step.need.start, end: Math.min(step.need.end, size) }
          held.push({ start: need.start, bytes: await source.read(need, signal) })
          step = openSource(held, size)
        }
        index = step.done
      } catch (error) {
        if (!(error instanceof Mp4Error)) throw error
        send(onEvent, error.message)
        const refusal: EngineRefusal = { refusal: error.message, reason: error.reason }
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the refusal is the plain value the engine reads.
        throw refusal
      }

      const chosen = chooseEngineTracks(index, isTypeSupported)
      if ('refusal' in chosen) {
        send(onEvent, chosen.refusal)
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the refusal is the plain value the engine reads.
        throw chosen
      }
      const [head, ...rest] = held
      const cache = new IndexCache(
        head ?? { start: 0, bytes: new Uint8Array(0) },
        options.cacheBytes,
      )
      for (const chunk of rest) cache.add(chunk)
      // An MP4's seek is made from its tables and reads no chunk: what was read for the index (a `moov` can be hundreds of megabytes) is let go.
      if (index.container === 'mp4') cache.clear()
      return new Feeder(source, onEvent, cache, index, chosen)
    } finally {
      signal?.removeEventListener('abort', callOff)
      tail.abort()
    }
  }

  /** The id of the sound that is read: the chosen one until the first feed has decided for none. */
  #soundId(): number | null {
    return this.#decision === 'none' ? null : this.tracks.video.soundId
  }

  /**
   * Moves reading to `seconds` (on the playback timeline). An MP4's tables are held, so the
   * cursor comes at once. A Matroska seek that the cache cannot serve needs reads: its position
   * is then first set to an estimate by time (when the file says its duration), and the reader's
   * `need` reads go through the source. The chunks of a seek are held in a list of its own until
   * the reader is done, then go to the index cache. The position then goes to where reading
   * starts. A seek never discards what the source holds, and keeps the sequence numbers and the
   * sound's decision. An abort rejects with the signal's reason, with no event, and leaves the
   * feeder where it was.
   */
  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { index } = this
    const sound = this.#soundId()
    const held: Chunk[] = []
    let estimated = false
    let step: ReturnType<typeof seekCursor>
    // What the seek read goes to the cache whether it finishes or is cut short: the next one needs it too.
    try {
      step = seekCursor(index, seconds, sound, this.#cache.chunks())
      while ('need' in step) {
        if (!estimated) {
          estimated = true
          this.#estimate(seconds)
        }
        const need = {
          start: step.need.start,
          end: Math.min(step.need.end, this.#source.fileSize),
        }
        held.push({ start: need.start, bytes: await this.#source.read(need, signal) })
        step = seekCursor(index, seconds, sound, [...this.#cache.chunks(), ...held])
      }
    } finally {
      for (const chunk of held) this.#cache.add(chunk)
    }
    this.#cursor = step.done
    this.#pending = []
    this.#sawSound = false
    this.#soundRead = false
    this.#pictureFrom = null
    this.#fedEnd = { video: null, audio: null }
    // The download follows the picture (R42): the sound's chunk may lie before the keyframe, far from the group, and is
    // read by the feeder's own read like any range. The sound's place only when the picture has no frame left.
    const next = nextReads(index, this.#cursor)
    const at = next.video ?? next.audio
    if (at !== null) this.#source.setPosition(at)
  }

  /** Sets the downloader's position to where `seconds` probably is in a Matroska file, by time, before the seek's reads; nothing when the file says no duration. */
  #estimate(seconds: number): void {
    const { index } = this
    if (
      index.container !== 'matroska' ||
      index.durationSeconds === null ||
      index.durationSeconds <= 0 ||
      !Number.isFinite(seconds)
    ) {
      return
    }
    const { firstCluster, segment } = index
    const estimate = firstCluster + (seconds / index.durationSeconds) * (segment.end - firstCluster)
    const last = Math.max(firstCluster, segment.end - 1)
    this.#source.setPosition(Math.floor(Math.min(Math.max(estimate, firstCluster), last)))
  }

  /**
   * Feeds fragments to the sink, in time order, until every track that plays and has frames
   * left has been fed to `until` (seconds on the playback timeline), or the file ends. Answers
   * `'ended'` when no track has a frame left to read (the picture's alone, once the play has no
   * sound), and `'more'` when it stopped at `until`. At the first feed of a play the fragments
   * are held until it is known whether there is a sound (R21), so that feed may go past `until`.
   *
   * Every read gets the signal; an abort rejects with its reason and no event. A frame that no
   * chunk of 32 MiB completes rejects with an `Mp4Error` of `damaged` (R18), after an event.
   */
  async feed(until: number, sink: Sink, signal: AbortSignal): Promise<'more' | 'ended'> {
    for (;;) {
      signal.throwIfAborted()
      const next = nextReads(this.index, this.#cursor)
      await this.#settle(sink, next, signal)
      const picture = next.video
      const sound = this.#decision === 'none' || this.tracks.audio === null ? null : next.audio
      if (picture === null && sound === null) return 'ended'
      if (this.#decision !== null && this.#reached(until, picture, sound)) return 'more'
      await this.#readFrom(this.#turn(picture, sound), sound, signal)
    }
  }

  /**
   * Whether the feed has done what `until` asks: every track that plays and has frames left
   * has fed to it. A Matroska file's clusters hold the tracks together, and its cursor cannot
   * say that a sound has run out, so the picture alone speaks for it.
   */
  #reached(until: number, picture: number | null, sound: number | null): boolean {
    if (picture !== null && (this.#fedEnd.video ?? -Infinity) < until) return false
    const counts = sound !== null && this.index.container === 'mp4'
    return !counts || (this.#fedEnd.audio ?? -Infinity) >= until
  }

  /** The offset to read at: that of the track whose fed time ends earliest (the picture on a tie, R19). */
  #turn(picture: number | null, sound: number | null): number {
    if (picture === null) return sound ?? 0
    if (sound === null) return picture
    const video = this.#fedEnd.video ?? -Infinity
    const audio = this.#fedEnd.audio ?? -Infinity
    return audio < video ? sound : picture
  }

  /** Reads a chunk at `at`, doubled while it completes no frame, and takes the frames it completes. */
  async #readFrom(at: number, soundNext: number | null, signal: AbortSignal): Promise<void> {
    const fileSize = this.#source.fileSize
    const soundAt = soundNext !== null && at === soundNext
    let size = CHUNK_BYTES
    for (;;) {
      const range = { start: at, end: Math.min(at + size, fileSize) }
      const chunk: Chunk = { start: at, bytes: await this.#source.read(range, signal) }
      let result: ReturnType<typeof framesIn>
      try {
        result = framesIn(this.index, this.#cursor, chunk)
      } catch (error) {
        if (error instanceof Mp4Error) send(this.#onEvent, error.message)
        throw error
      }
      if (
        result.frames.length > 0 ||
        result.skipped.length > 0 ||
        advanced(this.#cursor, result.cursor)
      ) {
        await this.#take(result, chunk, soundAt, signal)
        return
      }
      this.#cursor = result.cursor
      if (size >= MAX_CHUNK_BYTES || range.end >= fileSize) {
        const message =
          size >= MAX_CHUNK_BYTES
            ? `No frame completes within ${MAX_CHUNK_BYTES / (1024 * 1024)} MiB from offset ${at}.`
            : `No frame completes from offset ${at} to the end of the file.`
        send(this.#onEvent, message)
        throw new Mp4Error('damaged', message)
      }
      size = Math.min(size * 2, MAX_CHUNK_BYTES)
    }
  }

  /**
   * Makes a fragment of each run of the frames the chunk completed, reading the span of a run
   * that the chunk doesn't hold (R20), and only then commits: the cursor, the sequence numbers,
   * the fragments, the fed times and the events of damage passed over, all in one step that
   * waits for nothing, so an abort or a failed read leaves the feeder as it was and the chunk
   * is read again.
   */
  async #take(
    result: ReturnType<typeof framesIn>,
    chunk: Chunk,
    soundAt: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { video, audio } = this.tracks
    const queues: Record<Kind, Pending[]> = { video: [], audio: [] }
    const sequence = { ...this.#sequence }
    let sawSound = false
    for (const frames of result.frames) {
      if (frames.table.count === 0) continue
      let engine: EngineTrack | null = null
      if (frames.header.id === video.track.header.id) engine = video
      else if (audio !== null && frames.header.id === audio.track.header.id) {
        // A sound's frames are never written once the play has none (R21b); they are counted until then.
        sawSound = true
        if (this.#decision !== 'none') engine = audio
      }
      if (engine === null) continue
      for (const [from, to] of fragmentRuns(
        frames.table,
        0,
        frames.table.count,
        engine.kind === 'video',
      )) {
        const run = timesOf(engine, frames, from, to)
        const span = byteSpan([{ table: frames.table, from, to }])
        const held = span.start >= chunk.start && span.end <= chunk.start + chunk.bytes.length
        // A frame of a Matroska table may lie in a chunk read earlier (R20): its span is read from the store.
        const source: Chunk = held
          ? chunk
          : { start: span.start, bytes: await this.#source.read(span, signal) }
        sequence[engine.kind] += 1
        const bytes = fragment(frames, from, to, sequence[engine.kind], (offset, size) =>
          source.bytes.subarray(offset - source.start, offset - source.start + size),
        )
        queues[engine.kind].push({
          kind: engine.kind,
          bytes,
          run: { ...run, bytes: bytes.length },
          offset: span.start,
        })
      }
    }
    // Each track's fragments stay in the order they were cut, which is decode order (a run may
    // start before the one before it, where frames are reordered); the two are merged by start.
    const merged: Pending[] = []
    let v = 0
    let a = 0
    while (v < queues.video.length || a < queues.audio.length) {
      const next = queues.video[v]
      const other = queues.audio[a]
      if (next !== undefined && (other === undefined || next.run.start <= other.run.start)) {
        merged.push(next)
        v += 1
      } else if (other !== undefined) {
        merged.push(other)
        a += 1
      }
    }

    // The commit: nothing below waits.
    for (const stretch of result.skipped) {
      send(
        this.#onEvent,
        `Passed over damaged bytes ${stretch.start} to ${stretch.end} of the file, and went on.`,
      )
    }
    this.#cursor = result.cursor
    this.#sequence.video = sequence.video
    this.#sequence.audio = sequence.audio
    if (sawSound) this.#sawSound = true
    if (soundAt) this.#soundRead = true
    for (const one of merged) {
      this.#pending.push(one)
      this.#fedEnd[one.kind] = Math.max(this.#fedEnd[one.kind] ?? -Infinity, one.run.end)
      if (one.kind === 'video') {
        this.#pictureFrom = Math.min(this.#pictureFrom ?? Infinity, one.run.start)
      }
    }
  }

  /**
   * Decides whether the play has a sound, once (R21, R21c), and gives the fragments to the sink.
   * - A play with no sound track decides none at once.
   * - A sound frame decides sound.
   * - A sound with no next offset at all (no frames, or the end) decides none.
   * - Otherwise none is decided only when a read was made at the sound's next offset and the
   *   picture has covered `SOUND_WAIT_SECONDS` since without a sound frame coming.
   * Fragments made before the decision are kept in order and appended after `init`. An abort
   * stops before `init` and before each append, and the fragments not yet appended stay held.
   */
  async #settle(
    sink: Sink,
    next: { video: number | null; audio: number | null },
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#decision === null) {
      let decided: 'sound' | 'none' | null = null
      if (this.tracks.audio === null) decided = 'none'
      else if (this.#sawSound) decided = 'sound'
      else if (next.audio === null) decided = 'none'
      else if (
        this.#soundRead &&
        this.#pictureFrom !== null &&
        (this.#fedEnd.video ?? -Infinity) - this.#pictureFrom >= SOUND_WAIT_SECONDS
      ) {
        decided = 'none'
      }
      if (decided === null) return
      signal.throwIfAborted()
      await sink.init({
        video: this.tracks.video,
        audio: decided === 'sound' ? this.tracks.audio : null,
      })
      this.#decision = decided
    }
    for (let held = this.#pending[0]; held !== undefined; held = this.#pending[0]) {
      signal.throwIfAborted()
      await sink.append(held.kind, held.bytes, held.run)
      this.#pending.shift()
      this.positions.add({ ...held.run, offset: held.offset })
    }
  }
}

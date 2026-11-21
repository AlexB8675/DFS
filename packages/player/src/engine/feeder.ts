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
  nextRead,
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

  /**
   * Opens the file: the head and the tail are asked for at once, then whatever else the reader
   * needs is read through the source, and every chunk is kept in the index cache. Rejects with
   * `{ refusal, reason }` (after logging the sentence) when the file can't be played; anything
   * else, a failed read or an abort, rejects as it is.
   */
  static async open(
    source: ByteSource,
    isTypeSupported: (mime: string) => boolean,
    onEvent: (event: TimelineEventInput) => void,
  ): Promise<Feeder> {
    const size = source.fileSize
    const headRange: ByteRange = { start: 0, end: Math.min(HEAD_BYTES, size) }
    const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES)
    const tailRange: ByteRange | null = tailStart < size ? { start: tailStart, end: size } : null

    let head: Uint8Array = new Uint8Array(0)
    let tail: Uint8Array | null = null
    if (size > 0) {
      await Promise.all([
        source.fetchNow(headRange),
        ...(tailRange === null ? [] : [source.fetchNow(tailRange)]),
      ])
      ;[head, tail] = await Promise.all([
        source.read(headRange),
        tailRange === null ? null : source.read(tailRange),
      ])
    }
    const cache = new IndexCache({ start: 0, bytes: head })
    if (tailRange !== null && tail !== null) cache.add({ start: tailRange.start, bytes: tail })

    let index: SourceIndex
    try {
      let step = openSource(cache.chunks(), size)
      while ('need' in step) {
        const need = { start: step.need.start, end: Math.min(step.need.end, size) }
        cache.add({ start: need.start, bytes: await source.read(need) })
        step = openSource(cache.chunks(), size)
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
    return new Feeder(source, onEvent, cache, index, chosen)
  }

  /** The id of the sound that is read: the chosen one until the first feed has decided for none. */
  #soundId(): number | null {
    return this.#decision === 'none' ? null : this.tracks.video.soundId
  }

  /**
   * Moves reading to `seconds` (on the playback timeline): a Matroska file's position is first
   * set to an estimate by time (when the file says its duration), then the reader's `need` reads
   * go through the index cache and the source; an MP4's tables are held, so the cursor comes at
   * once. The position then goes to where reading starts. A seek never discards what the source
   * holds, and keeps the sequence numbers and the sound's decision. An abort rejects with the
   * signal's reason, with no event.
   */
  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { index } = this
    if (
      index.container === 'matroska' &&
      index.durationSeconds !== null &&
      index.durationSeconds > 0 &&
      Number.isFinite(seconds)
    ) {
      const { firstCluster, segment } = index
      const estimate =
        firstCluster + (seconds / index.durationSeconds) * (segment.end - firstCluster)
      const last = Math.max(firstCluster, segment.end - 1)
      this.#source.setPosition(Math.floor(Math.min(Math.max(estimate, firstCluster), last)))
    }

    const sound = this.#soundId()
    let step = seekCursor(index, seconds, sound, this.#cache.chunks())
    while ('need' in step) {
      const need = { start: step.need.start, end: Math.min(step.need.end, this.#source.fileSize) }
      this.#cache.add({ start: need.start, bytes: await this.#source.read(need, signal) })
      step = seekCursor(index, seconds, sound, this.#cache.chunks())
    }
    this.#cursor = step.done
    this.#pending = []
    this.#sawSound = false
    this.#pictureFrom = null
    this.#fedEnd = { video: null, audio: null }
    const at = nextRead(index, this.#cursor)
    if (at !== null) this.#source.setPosition(at)
  }

  /**
   * Feeds fragments to the sink, in time order, until the picture's fed time reaches `until`
   * (seconds on the playback timeline) or the file ends. Answers `'ended'` when no track has a
   * frame left to read (the picture's alone, once the play has no sound), and `'more'` when it
   * stopped at `until`. At the first feed of a play the fragments are held until it is known
   * whether there is a sound (R21), so that feed may go past `until`.
   *
   * Every read gets the signal; an abort rejects with its reason and no event. A frame that no
   * chunk of 32 MiB completes rejects with an `Mp4Error` of `damaged` (R18), after an event.
   */
  async feed(until: number, sink: Sink, signal: AbortSignal): Promise<'more' | 'ended'> {
    for (;;) {
      signal.throwIfAborted()
      const next = nextReads(this.index, this.#cursor)
      const picture = next.video
      const sound = this.#decision === 'none' || this.tracks.audio === null ? null : next.audio
      const ended = picture === null && sound === null
      await this.#settle(sink, ended)
      if (ended) return 'ended'
      if (this.#decision !== null && this.#reached(until, picture, sound)) return 'more'
      await this.#readFrom(this.#turn(picture, sound), signal)
    }
  }

  /** Whether the feed has done what `until` asks: the picture reached it, or, with the picture all fed, the sound did. */
  #reached(until: number, picture: number | null, sound: number | null): boolean {
    if (picture !== null) return (this.#fedEnd.video ?? -Infinity) >= until
    return sound === null || (this.#fedEnd.audio ?? -Infinity) >= until
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
  async #readFrom(at: number, signal: AbortSignal): Promise<void> {
    const fileSize = this.#source.fileSize
    let size = CHUNK_BYTES
    for (;;) {
      const range = { start: at, end: Math.min(at + size, fileSize) }
      const chunk: Chunk = { start: at, bytes: await this.#source.read(range, signal) }
      const result = framesIn(this.index, this.#cursor, chunk)
      if (
        result.frames.length > 0 ||
        result.skipped.length > 0 ||
        advanced(this.#cursor, result.cursor)
      ) {
        await this.#take(result, chunk, signal)
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

  /** Logs the damage that was passed over, and makes a fragment of each run of the frames the chunk completed. */
  async #take(
    result: ReturnType<typeof framesIn>,
    chunk: Chunk,
    signal: AbortSignal,
  ): Promise<void> {
    for (const stretch of result.skipped) {
      send(
        this.#onEvent,
        `Passed over damaged bytes ${stretch.start} to ${stretch.end} of the file, and went on.`,
      )
    }
    this.#cursor = result.cursor

    const { video, audio } = this.tracks
    const runs: { engine: EngineTrack; frames: FragmentTrack; from: number; to: number }[] = []
    for (const frames of result.frames) {
      if (frames.table.count === 0) continue
      let engine: EngineTrack | null = null
      if (frames.header.id === video.track.header.id) engine = video
      else if (audio !== null && frames.header.id === audio.track.header.id) {
        // A sound's frames are never written once the play has none (R21b); they are counted until then.
        this.#sawSound = true
        if (this.#decision !== 'none') engine = audio
      }
      if (engine === null) continue
      for (const [from, to] of fragmentRuns(
        frames.table,
        0,
        frames.table.count,
        engine.kind === 'video',
      )) {
        runs.push({ engine, frames, from, to })
      }
    }
    // Both tracks' runs in the order of their times; a picture's before a sound's at the same time.
    const timed = runs.map((run) => ({
      ...run,
      run: timesOf(run.engine, run.frames, run.from, run.to),
    }))
    timed.sort((a, b) => a.run.start - b.run.start)

    for (const { engine, frames, from, to, run } of timed) {
      const span = byteSpan([{ table: frames.table, from, to }])
      const held = span.start >= chunk.start && span.end <= chunk.start + chunk.bytes.length
      // A frame of a Matroska table may lie in a chunk read earlier (R20): its span is read from the store.
      const source: Chunk = held
        ? chunk
        : { start: span.start, bytes: await this.#source.read(span, signal) }
      this.#sequence[engine.kind] += 1
      const bytes = fragment(frames, from, to, this.#sequence[engine.kind], (offset, size) =>
        source.bytes.subarray(offset - source.start, offset - source.start + size),
      )
      this.#pending.push({
        kind: engine.kind,
        bytes,
        run: { ...run, bytes: bytes.length },
        offset: span.start,
      })
      this.#fedEnd[engine.kind] = Math.max(this.#fedEnd[engine.kind] ?? -Infinity, run.end)
      if (engine.kind === 'video') {
        this.#pictureFrom = Math.min(this.#pictureFrom ?? Infinity, run.start)
      }
    }
  }

  /**
   * Decides whether the play has a sound, once (R21), and gives the fragments to the sink. A play
   * with no sound track decides at once. Otherwise it waits for a sound frame (the play has a
   * sound) or for `SOUND_WAIT_SECONDS` of picture without one, or the file's end (it has none).
   * Fragments made before the decision are kept in order and appended after `init`.
   */
  async #settle(sink: Sink, ended: boolean): Promise<void> {
    if (this.#decision === null) {
      let decided: 'sound' | 'none' | null = null
      if (this.tracks.audio === null) decided = 'none'
      else if (this.#sawSound) decided = 'sound'
      else if (
        ended ||
        (this.#pictureFrom !== null &&
          (this.#fedEnd.video ?? -Infinity) - this.#pictureFrom >= SOUND_WAIT_SECONDS)
      ) {
        decided = 'none'
      }
      if (decided === null) return
      await sink.init({
        video: this.tracks.video,
        audio: decided === 'sound' ? this.tracks.audio : null,
      })
      this.#decision = decided
    }
    for (let held = this.#pending[0]; held !== undefined; held = this.#pending[0]) {
      await sink.append(held.kind, held.bytes, held.run)
      this.#pending.shift()
      this.positions.add({ ...held.run, offset: held.offset })
    }
  }
}

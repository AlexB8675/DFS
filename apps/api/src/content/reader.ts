import {
  chunkContext,
  chunkFrameLayout,
  FrameError,
  openFrame,
  openSegment,
  sha256,
  uuidBytes,
  type AesKey,
  type ChunkFrameLayout,
} from '@dfs/crypto'
import type { Executor } from '@dfs/db'
import type { SourceFigures } from '@dfs/shared'
import { isFresh, type BlobReader, type CdnUrl, type StoredBlob } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

// Reading a file back (DESIGN.md §6.2): find the chunks that cover a byte
// range, read each frame from staging (still syncing) or the blob store
// (stored, through the frame cache), check it, decrypt it, and stream the
// requested slice. A stored chunk sealed in segments (format 2, §7.3) is read
// by segment instead: only the segments the range covers, each checked and
// sent on as it arrives, from the frame cache (positional reads, for a frame it
// holds whole) or by Range from Discord, so the first bytes don't wait for
// the whole 20 MiB. Chunks are read ahead while the current one is sent,
// the first once the client has taken some of the first chunk, more as it
// keeps up, never past the requested range. A response asks for its next
// piece only once its socket has taken the last (`paced`, send.ts), and gives
// up on what is being read once its client has gone (`cancellation`), so a
// cancelled seek stops fetching at once. A video's first chunk and end, where
// its index usually is, are fetched into the cache as its player opens (`warmVideo`).

/** What reading needs to know about a file version. */
export interface ReadableVersion extends Record<string, unknown> {
  version_id: string
  size_bytes: number
  chunk_size: number
  chunk_count: number
  wrapped_dek: Buffer
  key_id: string
}

interface ChunkLocation extends Record<string, unknown> {
  idx: number
  plain_size: number
  frame_size: number
  frame_sha256: Buffer
  staged_path: string | null
  blob_id: number | null
  blob_offset: number | null
  blob_state: string | null
  /** A pack's file in staging, until the pack is stored. */
  blob_staged_path: string | null
  channel_id: string | null
  message_id: string | null
  attachment_id: string | null
  cdn_url: string | null
  cdn_url_expires_ms: number | null
}

/** Chunk locations are looked up this many at a time, so a huge file isn't loaded at once. */
const LOOKUP_BATCH = 64
/**
 * Chunks read ahead at most, once a reader has kept up for as many: a whole
 * file streams with this many requests overlapping (measured in DESIGN.md §6.2).
 */
const MAX_READ_AHEAD = 2
/**
 * The next chunk is read once the client has taken this much of the first,
 * or half of what it wants of it, whichever comes first: it plays from a
 * seek, rather than passing by, and the next chunk is under way well before
 * it is wanted, wherever in a chunk the seek landed. A seek left sooner reads
 * nothing past its chunk; one left later gives up the read at once (`signal`).
 * The window across a stream's requests (`ReadAhead`) asks this of a run of
 * reads too, and that the run has gone on for `FOLLOW_AFTER_MS`, as bytes sent
 * run ahead of the client's: it reads nothing ahead of a run that has sent less
 * than this, nor of one given up sooner.
 */
export const READ_AHEAD_AFTER_BYTES = 2 * 1024 * 1024
const NOTHING_TO_GIVE_BACK = () => undefined

export class ContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentError'
  }
}

/** What a read's bytes count as on the graphs (§16): sent to a browser, or read by the media service. */
export type ReadCounter = 'downloads.bytes' | 'media.read_bytes'

/** Where a read's bytes came from (§6.2): staging, the frame cache, or the blob store (Discord; the local store in development). */
export type ReadSource = 'staging' | 'cache' | 'discord'

/** A read's bytes and waits by source. */
export type ReadSources = Record<ReadSource, SourceFigures>

/** All zeros. */
export function readSources(): ReadSources {
  return {
    staging: { bytes: 0, waitMs: 0 },
    cache: { bytes: 0, waitMs: 0 },
    discord: { bytes: 0, waitMs: 0 },
  }
}

/**
 * Bytes `start` to `end` (inclusive) of a version, as plaintext, each piece
 * counted as `counter` as it is handed on. Once `signal` aborts, the chunks
 * being read are given up on, unless another reader waits for them too, and
 * the stream fails with its reason.
 *
 * With `sources`, each piece's bytes are added to the source it came from, with
 * the time the reader waited for it (§16). That is the time from asking for
 * the next piece until it arrives, charged to that piece's source, whatever
 * went into the wait: starting reads ahead, looking chunks up, signing URLs,
 * unwrapping the key. The time a `yield` takes is the client's, and never
 * charged here. A piece read ahead and already waiting costs nothing.
 */
export async function* readVersion(
  app: FastifyInstance,
  version: ReadableVersion,
  start: number,
  end: number,
  signal?: AbortSignal,
  counter: ReadCounter = 'downloads.bytes',
  sources?: ReadSources,
): AsyncGenerator<Uint8Array> {
  if (end < start) return
  let asked = performance.now()
  const { version_id: versionId, chunk_size: chunkSize } = version
  const key = await app.dataKeys.get(versionId, () =>
    app.keys.unwrapDek(version.wrapped_dek, version.key_id, uuidBytes(versionId)),
  )
  const locations = chunksBetween(
    app,
    versionId,
    Math.floor(start / chunkSize),
    Math.floor(end / chunkSize),
  )
  // The chunk to send next, then those read ahead, each with its share of
  // the API's memory budget for reading ahead.
  const reading: { chunk: ChunkLocation; read: ChunkRead; giveBack: () => void }[] = []
  let upcoming = await locations.next()
  let ahead = 0
  /** Chunks the client has taken whole. */
  let taken = 0
  /** Starts reading chunks until `count` are; while one is being sent, all of them read ahead. */
  const startReads = async (count: number, sending: boolean) => {
    while (!upcoming.done && reading.length < count) {
      const chunk = upcoming.value
      // A chunk read ahead holds its frame and the plaintext of the segments it has opened,
      // about twice its frame, until it is sent or its frame is the cache's.
      const giveBack =
        (!sending && reading.length === 0) || !app.readBudget
          ? NOTHING_TO_GIVE_BACK
          : app.readBudget.tryTake(2 * chunk.frame_size)
      if (!giveBack) break
      const chunkStart = chunk.idx * chunkSize
      const from = Math.max(0, start - chunkStart)
      const to = Math.min(chunk.plain_size - 1, end - chunkStart)
      reading.push({
        chunk,
        read: new ChunkRead((emit) =>
          readChunk(app, versionId, key, chunk, { from, to, signal, emit }),
        ),
        giveBack,
      })
      upcoming = await locations.next()
    }
  }
  try {
    for (;;) {
      await startReads(ahead + 1, false)
      const current = reading.shift()
      if (!current) return
      const chunkStart = current.chunk.idx * chunkSize
      const expected =
        Math.min(current.chunk.plain_size - 1, end - chunkStart) -
        Math.max(0, start - chunkStart) +
        1
      // Pieces are counted once the client's socket has taken them (`paced`).
      const readAheadAt =
        ahead === 0 ? Math.min(READ_AHEAD_AFTER_BYTES, Math.ceil(expected / 2)) : Infinity
      let sent = 0
      try {
        for await (const { bytes: piece, source } of current.read.pieces()) {
          if (sources) {
            sources[source].bytes += piece.length
            sources[source].waitMs += performance.now() - asked
          }
          sent += piece.length
          app.metrics.record(counter, piece.length)
          yield piece
          // The next piece is asked for from here, reads ahead started included.
          asked = performance.now()
          if (ahead === 0 && sent >= readAheadAt) {
            ahead = 1
            await startReads(ahead, true)
          }
        }
      } finally {
        current.giveBack()
      }
      // A range cut short passes every check of what did arrive: never send it as whole.
      if (sent !== expected) {
        throw new ContentError(
          `Chunk ${String(current.chunk.idx)} of ${versionId} gave ${String(sent)} bytes of ${String(expected)}.`,
        )
      }
      // Grown by whole chunks the client took, not by pieces of one: the
      // first's start only brings forward reading the one after it.
      taken += 1
      ahead = Math.min(MAX_READ_AHEAD, Math.max(ahead, taken))
    }
  } finally {
    // Reads ahead that nobody will send give their memory back once given up
    // on (`signal`), or else finish into the cache.
    for (const { read, giveBack } of reading) void read.finished.then(giveBack)
    await locations.return(undefined)
  }
}

/** A checked piece of a chunk's plaintext, and where it came from. */
interface SourcedPiece {
  bytes: Uint8Array
  source: ReadSource
}

/**
 * A chunk being read: its plaintext in checked pieces, each with its source,
 * kept until taken. It starts reading at once, so a chunk read ahead fills
 * while the one before it is sent, and a failure comes out when it is reached.
 */
class ChunkRead {
  /** Settles once the read is over, however it went: it never rejects. */
  readonly finished: Promise<void>
  readonly #pieces: SourcedPiece[] = []
  #over = false
  #error: Error | null = null
  #wake: (() => void) | null = null

  constructor(read: (emit: (piece: Uint8Array, source: ReadSource) => void) => Promise<void>) {
    this.finished = read((bytes, source) => {
      this.#pieces.push({ bytes, source })
      this.#notify()
    }).then(
      () => {
        this.#over = true
        this.#notify()
      },
      (error: unknown) => {
        this.#error = error instanceof Error ? error : new Error(String(error))
        this.#over = true
        this.#notify()
      },
    )
  }

  async *pieces(): AsyncGenerator<SourcedPiece> {
    for (;;) {
      const piece = this.#pieces.shift()
      if (piece) {
        yield piece
        continue
      }
      if (this.#over) {
        if (this.#error !== null) throw this.#error
        return
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }
}

interface ChunkRange {
  /** The first and last byte wanted, in the chunk's plaintext. */
  from: number
  to: number
  signal: AbortSignal | undefined
  /** Takes each checked piece, in order, with the source its plaintext came from. */
  emit: (piece: Uint8Array, source: ReadSource) => void
}

/** The locations of chunks `first` to `last`, a batch at a time, with fresh CDN URLs. */
async function* chunksBetween(
  app: FastifyInstance,
  versionId: string,
  first: number,
  last: number,
): AsyncGenerator<ChunkLocation, void, undefined> {
  for (let from = first; from <= last; from += LOOKUP_BATCH) {
    const to = Math.min(last, from + LOOKUP_BATCH - 1)
    const chunks = await chunkLocations(app.db, versionId, from, to)
    if (chunks.length !== to - from + 1) {
      throw new ContentError(
        `Version ${versionId} is missing chunks ${String(from)}–${String(to)}.`,
      )
    }
    await signUrls(app, chunks)
    yield* chunks
  }
}

/**
 * Reads bytes `from` to `to` of a chunk. A stored one sealed in segments is
 * read by segment: from the frame cache where it holds them, kept whole or in
 * part, and from Discord's CDN for the rest. The others are read whole
 * (staging, format 1), and only the segments wanted are opened.
 */
async function readChunk(
  app: FastifyInstance,
  versionId: string,
  key: AesKey,
  chunk: ChunkLocation,
  range: ChunkRange,
): Promise<void> {
  const context = chunkContext(versionId, chunk.idx)
  let layout: ChunkFrameLayout | null
  try {
    layout = chunkFrameLayout(chunk.plain_size, chunk.frame_size)
  } catch (error) {
    if (!(error instanceof FrameError)) throw error
    throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} has the wrong size.`)
  }
  if (layout && streamable(app, chunk)) {
    await streamSegments(app, versionId, key, chunk, layout, range)
    return
  }
  const { frame, source } = await checkedFrame(app, versionId, chunk, range.signal)
  if (!layout) {
    const plaintext = await openFrame(key, frame, context)
    if (plaintext.length !== chunk.plain_size) {
      throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} has the wrong size.`)
    }
    range.emit(plaintext.subarray(range.from, range.to + 1), source)
    return
  }
  for (let index = layout.segmentOf(range.from); index <= layout.segmentOf(range.to); index += 1) {
    const start = layout.segmentStart(index)
    const plaintext = await openSegment(
      key,
      layout,
      index,
      frame.subarray(start, start + layout.segmentLength(index)),
      context,
    )
    range.emit(wanted(layout, index, plaintext, range), source)
  }
}

/**
 * A stored chunk that is read by segment: not in staging, and from a store
 * that can stream. One the frame cache holds whole is too, a segment at a time
 * from its file, so it isn't read and hashed whole to serve a few segments.
 */
function streamable(app: FastifyInstance, chunk: ChunkLocation): boolean {
  return (
    !chunk.staged_path &&
    !chunk.blob_staged_path &&
    chunk.blob_state === 'stored' &&
    app.blobStore.stream !== undefined
  )
}

/** The part of segment `index`'s plaintext that `range` wants. */
function wanted(
  layout: ChunkFrameLayout,
  index: number,
  plaintext: Uint8Array,
  range: ChunkRange,
): Uint8Array {
  const start = layout.plaintextStart(index)
  return plaintext.subarray(
    Math.max(0, range.from - start),
    Math.min(plaintext.length, range.to - start + 1),
  )
}

/**
 * How much of a video's end is fetched as its player opens: the index most
 * tools write last (an MP4's sample tables, about 2 MB an hour of video at
 * 30 fps; an MKV's cues, a few kilobytes), which a browser reads before it
 * plays, a round trip to Discord sooner.
 */
export const WARM_END_BYTES = 4 * 1024 * 1024
/**
 * The segments at the very end fetched first, on a request of their own:
 * the last megabyte holds a shorter video's whole index, which in one request
 * with the rest would come last.
 */
const INDEX_SEGMENTS = 4
/** A fetch of a video's start and end given up after this long: nobody waits for it. */
const WARM_TIMEOUT_MS = 30_000
/** Videos fetched at once per API at most; more are left to their players. */
const MAX_WARMING = 4
/** The versions being fetched, so a player asking again starts nothing. */
const warming = new WeakMap<FastifyInstance, Set<string>>()

/**
 * Fetches a stored version's start and end from Discord into the frame
 * cache, ahead of the reader who will want them: a player reads a video's
 * first bytes, looks at its end for the index, then plays from the start. A
 * video of several chunks has its first chunk fetched whole, and the last
 * `WARM_END_BYTES` that aren't in it, the last megabyte first, on a request
 * of its own; one of a single chunk has all of it fetched, the same last
 * megabyte first and the rest on another request, never whole. A chunk is
 * fetched only if the cache would keep what is fetched of it, and holds that
 * much of the read budget until its fetches are over, twice that for a frame
 * fetched whole, which holds the plaintext of its segments too. What is kept, staged or
 * being fetched is left as it is, nothing is sent anywhere, and it runs on if
 * the viewer leaves, into the cache. Best effort: it never throws.
 */
export async function warmVideo(app: FastifyInstance, version: ReadableVersion): Promise<void> {
  const cache = app.frameCache
  const {
    version_id: versionId,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
    size_bytes: size,
  } = version
  let under = warming.get(app)
  if (!under) {
    under = new Set()
    warming.set(app, under)
  }
  if (!cache || !app.blobStore.stream || size === 0) return
  if (under.has(versionId) || under.size >= MAX_WARMING) return
  under.add(versionId)
  const settled: Promise<unknown>[] = []
  try {
    const key = await app.dataKeys.get(versionId, () =>
      app.keys.unwrapDek(version.wrapped_dek, version.key_id, uuidBytes(versionId)),
    )
    const signal = AbortSignal.timeout(WARM_TIMEOUT_MS)
    // The end of a longer video starts after its first chunk, which comes whole.
    const several = chunkCount > 1
    const start = several ? Math.max(chunkSize, size - WARM_END_BYTES) : 0
    const chunks: ChunkLocation[] = []
    for await (const chunk of chunksBetween(
      app,
      versionId,
      Math.floor(start / chunkSize),
      Math.floor((size - 1) / chunkSize),
    )) {
      chunks.push(chunk)
    }
    // The last chunk first, for the index in it.
    for (const chunk of chunks.reverse()) {
      const layout = streamable(app, chunk)
        ? chunkFrameLayout(chunk.plain_size, chunk.frame_size)
        : null
      if (!layout) continue
      const first = layout.segmentOf(Math.max(0, start - chunk.idx * chunkSize))
      const last = layout.segments - 1
      const wanted = Array.from({ length: last - first + 1 }, (_, index) => first + index)
      // Kept already, whole or by segment: nothing to fetch, nor to read off the cache's disk.
      if (
        cache.has(chunk.frame_sha256) ||
        wanted.every((index) => cache.hasSegment(chunk.frame_sha256, index))
      ) {
        continue
      }
      const split =
        chunk.idx === chunkCount - 1 ? Math.max(first, last - INDEX_SEGMENTS + 1) : first
      // What the runs hold meanwhile and then the cache keeps: a frame fetched whole, all of it;
      // otherwise the segments from `first`, each kept on its own.
      const kept =
        split === 0
          ? chunk.frame_size
          : layout.segmentStart(last) + layout.segmentLength(last) - layout.segmentStart(first)
      // Nothing is fetched to be thrown away. A frame fetched whole also holds the plaintext of
      // the segments it has opened until it is the cache's: twice its size from the read budget.
      if (!cache.canKeep(kept)) continue
      const giveBack = app.readBudget
        ? app.readBudget.tryTake(split === 0 ? 2 * kept : kept)
        : NOTHING_TO_GIVE_BACK
      if (!giveBack) continue
      const fetch: SegmentFetch = { app, versionId, key, chunk, layout, signal, reader: false }
      const sources = [
        ...planSegments(fetch, split, last, false).values(),
        ...(split > first ? planSegments(fetch, first, split - 1, false).values() : []),
      ]
      // A run is over once its frame, if it was fetched whole, is the cache's.
      const done = Promise.allSettled(
        sources.flatMap((source) => (source.kind === 'fetch' ? [source.ended] : [])),
      ).then(giveBack)
      settled.push(done)
    }
    // After the index's request is made, and not awaited: nothing of the end waits for it.
    if (several) settled.push(prefetchChunk(app, version, 0, signal))
    await Promise.all(settled)
  } catch (error) {
    app.log.info({ err: error, versionId }, 'could not fetch a video’s start and end ahead')
  } finally {
    await Promise.allSettled(settled)
    under.delete(versionId)
  }
}

/**
 * What fetching a chunk ahead came to (§6.2). `fetched`: its own fetches have
 * ended and the cache has what they fetched. `kept`: the cache holds the frame, whole or every segment of it:
 * nothing was fetched. `shared`: nothing was fetched either, but some of what
 * the cache lacks is being fetched by other reads, which may be a client's, and
 * a seek or a reconnect cancels that and caches nothing, so the chunk is worth
 * trying again. `skipped`: nothing to fetch, with no frame cache, a store that
 * can't stream, or a chunk that isn't stored in segments (staged, still
 * syncing, or format 1). `busy`: no room for the frame in the read budget or
 * the cache. `failed`: a fetch failed or was aborted, or the cache didn't keep
 * what was fetched.
 */
export type PrefetchOutcome = 'fetched' | 'kept' | 'shared' | 'skipped' | 'busy' | 'failed'

/**
 * Fetches chunk `index` of a stored version whole into the frame cache, ahead
 * of whoever will read it (a video's first chunk as its player opens, the
 * chunks a stream is about to want). It takes twice the frame's size from the
 * read budget (the frame, and the plaintext of the segments opened from it)
 * until its fetches have ended and starts only if the cache would keep
 * the frame, so memory and Discord's bandwidth never go on one that is then
 * thrown away; what is kept already is left as it is, and what other reads
 * are fetching is shared rather than fetched twice. Once `signal` aborts,
 * what it fetches is given up on and nothing of it is cached. Resolves once
 * the frame has been handed to the cache, and never rejects.
 */
export async function prefetchChunk(
  app: FastifyInstance,
  version: ReadableVersion,
  index: number,
  signal: AbortSignal,
): Promise<PrefetchOutcome> {
  const cache = app.frameCache
  const { version_id: versionId } = version
  if (!cache || !app.blobStore.stream || index < 0 || index >= version.chunk_count) {
    return 'skipped'
  }
  let giveBack: () => void = NOTHING_TO_GIVE_BACK
  try {
    let chunk: ChunkLocation | undefined
    for await (const found of chunksBetween(app, versionId, index, index)) {
      chunk = found
      break
    }
    if (!chunk || !streamable(app, chunk)) return 'skipped'
    const layout = chunkFrameLayout(chunk.plain_size, chunk.frame_size)
    if (!layout) return 'skipped'
    const last = layout.segments - 1
    if (
      cache.has(chunk.frame_sha256) ||
      Array.from({ length: layout.segments }, (_, i) => i).every((i) =>
        cache.hasSegment(chunk.frame_sha256, i),
      )
    ) {
      return 'kept'
    }
    if (!cache.canKeep(chunk.frame_size)) return 'busy'
    // Given up on already: nothing is fetched.
    signal.throwIfAborted()
    // Until its frame is the cache's it holds that frame and the plaintext of every segment
    // it has opened: twice the frame's size.
    if (app.readBudget) {
      const taken = app.readBudget.tryTake(2 * chunk.frame_size)
      if (!taken) return 'busy'
      giveBack = taken
    }
    const key = await app.dataKeys.get(versionId, () =>
      app.keys.unwrapDek(version.wrapped_dek, version.key_id, uuidBytes(versionId)),
    )
    const fetch: SegmentFetch = { app, versionId, key, chunk, layout, signal, reader: false }
    const planned = [...planSegments(fetch, 0, last, false)]
    const own = planned.flatMap(([at, source]) => (source.kind === 'fetch' ? [{ at, source }] : []))
    // Nothing of its own to fetch: all of it kept, or some of it fetched by others meanwhile,
    // which may be a client's read, cancelled by a seek or a reconnect before it caches anything.
    if (own.length === 0) {
      return planned.some(([, source]) => source.kind === 'shared') ? 'shared' : 'kept'
    }
    // The runs end once the frame is the cache's, which is later than their last segment.
    await Promise.all(own.map(({ source }) => source.ended))
    const settled = await Promise.allSettled(own.map(({ source }) => source.plaintext))
    const failure = settled.find((result): result is PromiseRejectedResult => {
      return result.status === 'rejected'
    })
    if (failure) {
      if (!signal.aborted) {
        app.log.info(
          { err: failure.reason, versionId, chunk: index },
          'could not fetch a chunk ahead',
        )
      }
      return 'failed'
    }
    // What it fetched is the cache's now, whole or by segment, unless the cache had no room
    // when it was handed over: then the reader fetches it again from Discord, which a log of
    // fetches ahead mustn't call a success. (What it leaned on is another read's business.)
    const frame = chunk.frame_sha256
    if (!own.every(({ at }) => cache.has(frame) || cache.hasSegment(frame, at))) {
      app.log.info({ versionId, chunk: index }, 'a chunk fetched ahead wasn’t kept')
      return 'failed'
    }
    return 'fetched'
  } catch (error) {
    if (!signal.aborted) {
      app.log.info({ err: error, versionId, chunk: index }, 'could not fetch a chunk ahead')
    }
    return 'failed'
  } finally {
    giveBack()
  }
}

/**
 * Segments read past the end of a small range, into the cache, so the reads
 * that follow it (a PDF's next pages, ffmpeg's next look) find them there.
 * A range that runs to the end of its chunk, as a player's does, gets none:
 * a seek cancelled at once fetches only what it asked for.
 */
const READ_AROUND_SEGMENTS = 4

/**
 * A client's read shares another's fetch only when the fetch will reach the
 * first segment the read takes from it within this many (2 MiB, some 60 to 90
 * ms of Discord at 22 to 34 MB/s, about one warm first byte, so waiting that
 * long is no slower than a request of its own and doesn't split the
 * bandwidth): a fetch brings its segments in order, so a read taking one
 * further on would wait for every segment before it, and fetches its own
 * instead (§6.2). Once the fetch is that close, the read shares all of its
 * later segments too, which come ahead of the read. A fetch ahead shares
 * anything.
 */
export const SHARE_WITHIN_SEGMENTS = 8

/** Where a run of segments being fetched has got to: the next it will deliver. */
interface RunProgress {
  next: number
}

/** A segment a run is fetching: its checked plaintext, and the run's progress. */
interface UnderWay {
  plaintext: Promise<Uint8Array>
  run: RunProgress
}

/**
 * Segments being fetched, by frame and index, so readers of the same one
 * share the fetch: every run fetching a segment has its own entry for it, as
 * checked plaintext with the run's progress, so one that ends (a cancelled
 * read's) leaves the others' visible. In memory only: the cache keeps
 * ciphertext. Kept per API by its blob store, not by `app`: Fastify gives
 * each plugin's routes an instance of its own, which inherits what the API
 * decorates, so a key of `app` would keep a read of the content routes, one of
 * a share link's, a video's warm start and a stream's window apart, though
 * they all fetch from the same place.
 */
const segmentsUnderWay = new WeakMap<BlobReader, Map<string, UnderWay[]>>()

/**
 * Where a segment a reader wants comes from: the cache's ciphertext, or a
 * fetch's plaintext. The cache's is read when the reader reaches that segment,
 * not when it is planned, so planning reads nothing and a frame's ciphertext
 * is never held whole; `whole` says it is part of a frame kept whole, rather
 * than a segment kept on its own. The segments of a run this plan started
 * share its `ended`, which settles, and never rejects, once the run is over
 * and its frame, if it was read whole, handed to the cache: after the last
 * segment's plaintext, which whoever fetches ahead mustn't stop at.
 */
type SegmentSource =
  | { kind: 'cache'; whole: boolean; ciphertext: () => Promise<Uint8Array | null> }
  | { kind: 'fetch'; plaintext: Promise<Uint8Array>; ended: Promise<void> }
  | { kind: 'shared'; plaintext: Promise<Uint8Array> }

/**
 * Reads the segments of a stored chunk that a range covers, each checked by
 * its own tag and emitted as soon as it has arrived: kept ones from the
 * cache (a frame kept whole by positional reads of just those segments), ones
 * another reader is fetching from that fetch, and the rest from the CDN,
 * consecutive ones in one request. A chunk fetched whole is also checked
 * against its SHA-256 and kept whole.
 */
async function streamSegments(
  app: FastifyInstance,
  versionId: string,
  key: AesKey,
  chunk: ChunkLocation,
  layout: ChunkFrameLayout,
  range: ChunkRange,
): Promise<void> {
  const context = chunkContext(versionId, chunk.idx)
  const first = layout.segmentOf(range.from)
  const last = layout.segmentOf(range.to)
  const fetch: SegmentFetch = {
    app,
    versionId,
    key,
    chunk,
    layout,
    signal: range.signal,
    reader: true,
  }
  const sources = planSegments(fetch, first, last, false)
  for (let index = first; index <= last; index += 1) {
    let plaintext: Uint8Array | null = null
    // Where the plaintext that is finally emitted came from, after any re-plan.
    let origin: ReadSource = 'discord'
    // Once more if a kept copy fails its tag or was evicted, or another
    // reader's fetch was given up on: then this reader fetches it itself.
    for (let attempt = 0; plaintext === null; attempt += 1) {
      const source = sources.get(index)
      if (!source) throw new ContentError(`Segment ${String(index)} wasn't planned.`)
      try {
        if (source.kind === 'cache') {
          const ciphertext = await source.ciphertext()
          if (ciphertext) {
            plaintext = await openSegment(key, layout, index, ciphertext, context)
          } else if (source.whole) {
            // A frame kept whole that gave nothing of it is let go.
            app.frameCache?.forget(chunk.frame_sha256)
          }
        } else {
          plaintext = await source.plaintext
        }
        if (plaintext) {
          // Served from the cache, or by another reader's fetch: no request of its own.
          app.frameCache?.counted(source.kind !== 'fetch')
          origin = source.kind === 'cache' ? 'cache' : 'discord'
        }
      } catch (error) {
        if (range.signal?.aborted || source.kind === 'fetch' || attempt > 0) throw error
        // A bad segment of a frame kept whole lets the whole frame go: it is
        // fetched again by segment, as any part is, and kept whole once read whole.
        if (source.kind === 'cache') {
          if (source.whole) app.frameCache?.forget(chunk.frame_sha256)
          else app.frameCache?.forgetSegment(chunk.frame_sha256, index)
        }
      }
      if (plaintext === null) {
        if (attempt > 0) throw new ContentError(`Segment ${String(index)} couldn't be read.`)
        for (const [replanned, next] of planSegments(fetch, index, last, true)) {
          sources.set(replanned, next)
        }
      }
    }
    range.emit(wanted(layout, index, plaintext, range), origin)
  }
}

interface SegmentFetch {
  app: FastifyInstance
  versionId: string
  key: AesKey
  chunk: ChunkLocation
  layout: ChunkFrameLayout
  signal: AbortSignal | undefined
  /** A client's read, rather than a fetch ahead of one: it shares only fetches that will soon reach what it takes from them. */
  reader: boolean
}

/**
 * Where segments `from` to `last` come from, starting the fetches needed: a
 * frame the cache holds whole first, then segments it keeps on their own,
 * then fetches under way (for a client's read, a run that will reach the first
 * segment the read takes from it within `SHARE_WITHIN_SEGMENTS`, and then all
 * of its later segments; a fetch ahead shares any). With `fresh`, segment
 * `from` is fetched whatever the cache or another reader says of it.
 */
function planSegments(
  fetch: SegmentFetch,
  from: number,
  last: number,
  fresh: boolean,
): Map<number, SegmentSource> {
  const { app, chunk, layout } = fetch
  const cache = app.frameCache
  const underWay = segmentsUnderWay.get(app.blobStore)
  const sources = new Map<number, SegmentSource>()
  const keyOf = (index: number) =>
    `${Buffer.from(chunk.frame_sha256).toString('hex')}-${String(index)}`
  // The runs this plan has met, and whether a reader takes from each: decided
  // at the first segment it would take from the run, which the walk reaches first.
  const joined = new Map<RunProgress, boolean>()
  const shareable = (index: number): UnderWay | null => {
    const entries = underWay?.get(keyOf(index)) ?? []
    if (!fetch.reader) return entries[0] ?? null
    const already = entries.find((entry) => joined.get(entry.run) === true)
    if (already) return already
    for (const entry of entries) {
      if (joined.has(entry.run)) continue
      // Too far from the fetch under way: this read fetches its own instead.
      const near = index - entry.run.next <= SHARE_WITHIN_SEGMENTS
      joined.set(entry.run, near)
      if (near) return entry
    }
    return null
  }
  const found = (index: number): SegmentSource | null => {
    if (fresh && index === from) return null
    // Read when the reader gets to it: positional reads of just that segment.
    if (cache?.has(chunk.frame_sha256)) {
      return {
        kind: 'cache',
        whole: true,
        ciphertext: () =>
          cache.frameSlice(
            chunk.frame_sha256,
            layout.segmentStart(index),
            layout.segmentLength(index),
          ),
      }
    }
    if (cache?.hasSegment(chunk.frame_sha256, index)) {
      return {
        kind: 'cache',
        whole: false,
        ciphertext: () => cache.segment(chunk.frame_sha256, index),
      }
    }
    const shared = shareable(index)
    return shared ? { kind: 'shared', plaintext: shared.plaintext } : null
  }
  // The whole chunk is fetched whole, so it is kept as one frame in place of
  // the segments kept on their own; unless the cache holds it whole already,
  // or another reader is fetching some of it, which is shared instead, or
  // half or more of its segments are kept on their own: then, as for any
  // range, only the missing ones are fetched, rather than the chunk again.
  const indexes = Array.from({ length: layout.segments }, (_, i) => i)
  const wholeChunk =
    !fresh &&
    from === 0 &&
    last === layout.segments - 1 &&
    !cache?.has(chunk.frame_sha256) &&
    indexes.filter((i) => cache?.hasSegment(chunk.frame_sha256, i)).length * 2 < layout.segments
  if (wholeChunk && !indexes.some((i) => underWay?.has(keyOf(i)))) {
    startRun(fetch, 0, last, sources)
    return sources
  }
  let run: number | null = null
  for (let index = from; index <= last; index += 1) {
    const source = found(index)
    if (!source) {
      run ??= index
      continue
    }
    if (run !== null) startRun(fetch, run, index - 1, sources)
    run = null
    sources.set(index, source)
  }
  if (run !== null) {
    // A small range's run goes on past its end, into the cache, while what
    // follows is neither kept nor being fetched.
    let end = last
    if (last < layout.segments - 1) {
      const until = Math.min(layout.segments - 1, run + READ_AROUND_SEGMENTS - 1)
      while (end < until && !found(end + 1)) end += 1
    }
    startRun(fetch, run, end, sources)
  }
  return sources
}

/**
 * Fetches segments `from` to `to` in one request, each shared as checked
 * plaintext while under way. The segments of a run that covers the whole
 * frame are kept as that frame; the others each on their own.
 */
function startRun(
  fetch: SegmentFetch,
  from: number,
  to: number,
  sources: Map<number, SegmentSource>,
): void {
  const { app, chunk, layout } = fetch
  const hex = Buffer.from(chunk.frame_sha256).toString('hex')
  let underWay = segmentsUnderWay.get(app.blobStore)
  if (!underWay) {
    underWay = new Map()
    segmentsUnderWay.set(app.blobStore, underWay)
  }
  const registry = underWay
  const whole = from === 0 && to === layout.segments - 1
  const pending = new Map<number, PromiseWithResolvers<Uint8Array>>()
  const ended = Promise.withResolvers<undefined>()
  // How far the run has got, for the readers who would share what it has under way.
  const progress: RunProgress = { next: from }
  for (let index = from; index <= to; index += 1) {
    const deferred = Promise.withResolvers<Uint8Array>()
    // Segments read around a range have no reader waiting.
    void deferred.promise.catch(() => undefined)
    pending.set(index, deferred)
    sources.set(index, { kind: 'fetch', plaintext: deferred.promise, ended: ended.promise })
    const key = `${hex}-${String(index)}`
    registry.set(key, [
      ...(registry.get(key) ?? []),
      { plaintext: deferred.promise, run: progress },
    ])
  }
  const settle = (index: number) => {
    const deferred = pending.get(index)
    pending.delete(index)
    if (deferred) {
      const key = `${hex}-${String(index)}`
      // Only its own entry: another run fetching this segment keeps its place.
      const others = (registry.get(key) ?? []).filter(
        (entry) => entry.plaintext !== deferred.promise,
      )
      if (others.length > 0) registry.set(key, others)
      else registry.delete(key)
    }
    return deferred
  }
  const finished = fetchRun(fetch, from, to, whole, progress, (index, plaintext, ciphertext) => {
    // Kept before it is let go of, so readers who look next find it.
    if (!whole) app.frameCache?.putSegment(chunk.frame_sha256, index, ciphertext)
    const deferred = whole ? pending.get(index) : settle(index)
    deferred?.resolve(plaintext)
  }).then(
    (frame) => {
      if (frame && app.frameCache) {
        if (Buffer.from(frame.hash).equals(chunk.frame_sha256)) {
          app.frameCache.put(chunk.frame_sha256, frame.bytes)
        } else {
          // Every segment passed its tag, so what was sent is right; the
          // stored frame differs from its hash all the same.
          app.log.warn(
            { versionId: fetch.versionId, chunk: chunk.idx },
            'a frame read whole doesn’t match its hash',
          )
        }
      }
      for (const index of [...pending.keys()]) settle(index)
    },
    (error: unknown) => {
      // Unregistered first, so a reader who looks again doesn't find it.
      const failed = [...pending.keys()].map((index) => settle(index))
      for (const deferred of failed) deferred?.reject(error)
    },
  )
  // However it went, the run is over, and a whole frame is the cache's, after its last segment.
  // Not `finally`: a handler above that threw would make this an unhandled rejection.
  void finished.then(
    () => {
      ended.resolve(undefined)
    },
    () => {
      ended.resolve(undefined)
    },
  )
}

/**
 * Streams segments `from` to `to` of a stored frame from the CDN, checking
 * each and handing it on with its ciphertext as soon as it has arrived. With
 * `whole`, the header is read too, and the whole frame is returned with its
 * SHA-256. If the frame moves meanwhile (§6.6), the rest is read where it is
 * now, from the next segment on. `progress.next` is the next segment it will
 * hand on, kept up to date for the readers who might share the run.
 */
async function fetchRun(
  fetch: SegmentFetch,
  from: number,
  to: number,
  whole: boolean,
  progress: RunProgress,
  emit: (index: number, plaintext: Uint8Array, ciphertext: Uint8Array) => void,
): Promise<{ bytes: Uint8Array; hash: Uint8Array } | null> {
  const { app, versionId, key, chunk, layout, signal } = fetch
  const store = app.blobStore
  if (!store.stream) throw new ContentError('This store can’t stream.')
  const context = chunkContext(versionId, chunk.idx)
  const frame = whole ? Buffer.allocUnsafe(chunk.frame_size) : null
  const end = layout.segmentStart(to) + layout.segmentLength(to)
  let location = chunk
  let next = from
  for (;;) {
    const start = frame && next === 0 ? 0 : layout.segmentStart(next)
    let position = start
    let pending = Buffer.alloc(0)
    // The header, read with a whole frame: kept for the cache, not opened.
    let header = start === 0 ? layout.segmentStart(0) : 0
    try {
      for await (const piece of store.stream(
        blobOf(location),
        (location.blob_offset ?? 0) + start,
        end - start,
        signal,
      )) {
        frame?.set(piece, position)
        position += piece.length
        pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece])
        if (header > 0) {
          const skipped = Math.min(header, pending.length)
          header -= skipped
          pending = pending.subarray(skipped)
        }
        while (next <= to && pending.length >= layout.segmentLength(next)) {
          const ciphertext = pending.subarray(0, layout.segmentLength(next))
          pending = pending.subarray(layout.segmentLength(next))
          emit(next, await openSegment(key, layout, next, ciphertext, context), ciphertext)
          next += 1
          progress.next = next
        }
      }
      if (next <= to) {
        throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} was cut short.`)
      }
      break
    } catch (error) {
      // Given up on, or failed where it was: only a frame that moved is read again.
      if (signal?.aborted || error instanceof FrameError) throw error
      const moved = await movedLocation(app, versionId, location)
      if (moved?.blob_state !== 'stored' || moved.blob_offset === null) throw error
      location = moved
    }
  }
  return frame ? { bytes: frame, hash: await sha256(frame) } : null
}

function blobOf(chunk: ChunkLocation): StoredBlob {
  return {
    id: chunk.blob_id ?? 0,
    channelId: chunk.channel_id,
    messageId: chunk.message_id,
    attachmentId: chunk.attachment_id,
    url: cdnUrlOf(chunk),
  }
}

/**
 * A chunk's frame, checked against its SHA-256, with the source that served
 * it (§16): staging for one still there (its file, or its place in a pack);
 * for a stored one read through the frame cache, the cache if it gave a good
 * copy, Discord if the cache had to read it again from the blob store (a copy
 * that failed its check, or had gone from disk, is such a read); and without a
 * cache, the blob store (Discord; the local store in development). A reader
 * that joins another's read of the same frame is counted as the cache's.
 */
async function checkedFrame(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
  signal: AbortSignal | undefined,
): Promise<{ frame: Uint8Array; source: ReadSource }> {
  // Set once the cache has had to ask for the frame.
  const reading = { fetched: false }
  // Through the cache, the fetch has its own signal: the cache gives up on it
  // only once every reader waiting for the frame has.
  const read = async (fetchSignal: AbortSignal | undefined) => {
    reading.fetched = true
    const frame = await readFrame(app, versionId, chunk, fetchSignal)
    if (!Buffer.from(await sha256(frame)).equals(chunk.frame_sha256)) {
      throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} is corrupt.`)
    }
    return frame
  }
  const staged = !!chunk.staged_path || !!chunk.blob_staged_path
  if (staged || chunk.blob_state !== 'stored' || !app.frameCache) {
    return { frame: await read(signal), source: staged ? 'staging' : 'discord' }
  }
  const frame = await app.frameCache.load(chunk.frame_sha256, read, signal)
  return { frame, source: reading.fetched ? 'discord' : 'cache' }
}

async function chunkLocations(
  db: Executor,
  versionId: string,
  from: number,
  to: number,
): Promise<ChunkLocation[]> {
  const { rows } = await db.execute<ChunkLocation>(sql`
    SELECT chunk.idx, chunk.plain_size, chunk.frame_size, chunk.frame_sha256, chunk.staged_path,
      chunk.blob_id::float8 AS blob_id, chunk.blob_offset, blob.state::text AS blob_state,
      blob.staged_path AS blob_staged_path,
      blob.channel_id, blob.message_id, blob.attachment_id,
      blob.cdn_url, (extract(epoch FROM blob.cdn_url_expires_at) * 1000)::float8 AS cdn_url_expires_ms
    FROM chunks chunk LEFT JOIN blobs blob ON blob.id = chunk.blob_id
    WHERE chunk.version_id = ${versionId} AND chunk.idx BETWEEN ${from} AND ${to}
    ORDER BY chunk.idx`)
  return rows
}

/**
 * A frame from staging while its blob isn't stored: its own file, or its
 * place in a sealed pack (§6.6). From the blob store after. If the bot packs
 * or stores it and removes the staged file between the lookup and the read,
 * or compacts its pack and deletes the old one (§6.6), the chunk is looked
 * up again and read where it is now.
 */
async function readFrame(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const { staged_path: own, blob_staged_path: pack, blob_offset: offset } = chunk
  if (own || (pack && offset !== null)) {
    try {
      return own
        ? await app.staging.read(own)
        : await app.staging.readRange(pack ?? '', offset ?? 0, chunk.frame_size)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
      return readMoved(app, versionId, chunk, error, signal)
    }
  }
  if (chunk.blob_id === null || chunk.blob_offset === null || chunk.blob_state !== 'stored') {
    throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} is not readable.`)
  }
  try {
    return await app.blobStore.read(blobOf(chunk), chunk.blob_offset, chunk.frame_size, signal)
  } catch (error) {
    // Given up on: it didn't fail where it was.
    if (signal?.aborted) throw error
    return readMoved(app, versionId, chunk, error, signal)
  }
}

/** The frame where it is now, if it moved since `chunk` was looked up; otherwise `error`. */
async function readMoved(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
  error: unknown,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const moved = await movedLocation(app, versionId, chunk)
  if (!moved) throw error
  return readFrame(app, versionId, moved, signal)
}

/** Where a chunk is now, if that isn't where it was looked up: `null` if it hasn't moved. */
async function movedLocation(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
): Promise<ChunkLocation | null> {
  const [moved] = await chunkLocations(app.db, versionId, chunk.idx, chunk.idx)
  if (
    !moved ||
    (moved.staged_path === chunk.staged_path &&
      moved.blob_staged_path === chunk.blob_staged_path &&
      moved.blob_id === chunk.blob_id &&
      moved.blob_offset === chunk.blob_offset)
  ) {
    return null
  }
  await signUrls(app, [moved])
  return moved
}

/**
 * Signs, in one request, the CDN URLs a lookup batch is missing or that are
 * about to expire, rather than one request per chunk as they are read.
 */
async function signUrls(app: FastifyInstance, chunks: ChunkLocation[]): Promise<void> {
  const reader: BlobReader = app.blobStore
  if (!reader.signUrls) return
  // Frames the cache holds need no URL at all.
  const stale = chunks.filter(
    (chunk) =>
      chunk.blob_state === 'stored' &&
      !chunk.staged_path &&
      !isFresh(cdnUrlOf(chunk)) &&
      !app.frameCache?.has(chunk.frame_sha256),
  )
  const blobs = new Map<number, ChunkLocation>()
  for (const chunk of stale) if (chunk.blob_id !== null) blobs.set(chunk.blob_id, chunk)
  if (blobs.size === 0) return
  let signed: Map<number, CdnUrl>
  try {
    signed = await reader.signUrls(
      [...blobs].map(([id, chunk]) => ({
        id,
        channelId: chunk.channel_id,
        messageId: chunk.message_id,
        attachmentId: chunk.attachment_id,
      })),
    )
  } catch {
    // Each frame read signs its own URL then: one a cache may still serve
    // doesn't fail for want of the bot.
    return
  }
  for (const chunk of stale) {
    const url = chunk.blob_id === null ? undefined : signed.get(chunk.blob_id)
    if (url) {
      chunk.cdn_url = url.url
      chunk.cdn_url_expires_ms = url.expiresAt.getTime()
    }
  }
}

function cdnUrlOf(chunk: ChunkLocation): CdnUrl | null {
  if (!chunk.cdn_url || chunk.cdn_url_expires_ms === null) return null
  return { url: chunk.cdn_url, expiresAt: new Date(chunk.cdn_url_expires_ms) }
}

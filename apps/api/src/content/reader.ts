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
import { isFresh, type BlobReader, type CdnUrl, type StoredBlob } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

// Reading a file back (DESIGN.md §6.2): find the chunks that cover a byte
// range, read each frame from staging (still syncing) or the blob store
// (stored, through the frame cache), check it, decrypt it, and stream the
// requested slice. A chunk sealed in segments (format 2, §7.3) that has to
// come from Discord streams instead: only the segments the range covers, by
// Range, each checked and sent on as it arrives, so the first bytes don't
// wait for the whole 20 MiB. Chunks are read ahead while the current one is sent,
// more of them as the reader keeps up, never past the requested range. A
// response asks for its next piece only once its socket has taken the last
// (`paced`, send.ts), and gives up on what is being read once its client has
// gone (`cancellation`), so a cancelled seek stops fetching at once.

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
 * Chunks read ahead at most, once a reader has kept up for as many: a seek
 * that stops after one chunk costs one, and a whole file streams with this
 * many requests overlapping (measured in DESIGN.md §6.2).
 */
const MAX_READ_AHEAD = 2
const NOTHING_TO_GIVE_BACK = () => undefined

export class ContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentError'
  }
}

/**
 * Bytes `start` to `end` (inclusive) of a version, as plaintext. Once
 * `signal` aborts, the chunks being read are given up on, unless another
 * reader waits for them too, and the stream fails with its reason.
 */
export async function* readVersion(
  app: FastifyInstance,
  version: ReadableVersion,
  start: number,
  end: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (end < start) return
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
  try {
    for (;;) {
      while (!upcoming.done && reading.length <= ahead) {
        const chunk = upcoming.value
        const giveBack =
          reading.length === 0 || !app.readBudget
            ? NOTHING_TO_GIVE_BACK
            : app.readBudget.tryTake(chunk.frame_size)
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
      const current = reading.shift()
      if (!current) return
      const chunkStart = current.chunk.idx * chunkSize
      const expected =
        Math.min(current.chunk.plain_size - 1, end - chunkStart) -
        Math.max(0, start - chunkStart) +
        1
      let sent = 0
      try {
        for await (const piece of current.read.pieces()) {
          sent += piece.length
          app.metrics.record('downloads.bytes', piece.length)
          yield piece
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
      // Grown by whole chunks the client took, not by pieces of one.
      ahead = Math.min(MAX_READ_AHEAD, ahead + 1)
    }
  } finally {
    // Reads ahead that nobody will send give their memory back once given up
    // on (`signal`), or else finish into the cache.
    for (const { read, giveBack } of reading) void read.finished.then(giveBack)
    await locations.return(undefined)
  }
}

/**
 * A chunk being read: its plaintext in checked pieces, kept until taken.
 * It starts reading at once, so a chunk read ahead fills while the one
 * before it is sent, and a failure comes out when it is reached.
 */
class ChunkRead {
  /** Settles once the read is over, however it went: it never rejects. */
  readonly finished: Promise<void>
  readonly #pieces: Uint8Array[] = []
  #over = false
  #error: Error | null = null
  #wake: (() => void) | null = null

  constructor(read: (emit: (piece: Uint8Array) => void) => Promise<void>) {
    this.finished = read((piece) => {
      this.#pieces.push(piece)
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

  async *pieces(): AsyncGenerator<Uint8Array> {
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
  /** Takes each checked piece, in order. */
  emit: (piece: Uint8Array) => void
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
 * Reads bytes `from` to `to` of a chunk. One sealed in segments that has to
 * come from Discord streams them; the others are read whole (staging, the
 * frame cache, format 1), and only the segments wanted are opened.
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
  const frame = await checkedFrame(app, versionId, chunk, range.signal)
  if (!layout) {
    const plaintext = await openFrame(key, frame, context)
    if (plaintext.length !== chunk.plain_size) {
      throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} has the wrong size.`)
    }
    range.emit(plaintext.subarray(range.from, range.to + 1))
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
    range.emit(wanted(layout, index, plaintext, range))
  }
}

/** A stored chunk Discord's CDN can stream: not in staging, nor already in the frame cache. */
function streamable(app: FastifyInstance, chunk: ChunkLocation): boolean {
  return (
    !chunk.staged_path &&
    !chunk.blob_staged_path &&
    chunk.blob_state === 'stored' &&
    app.blobStore.stream !== undefined &&
    !app.frameCache?.has(chunk.frame_sha256)
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
 * Segments read past the end of a small range, into the cache, so the reads
 * that follow it (a PDF's next pages, ffmpeg's next look) find them there.
 * A range that runs to the end of its chunk, as a player's does, gets none:
 * a seek cancelled at once fetches only what it asked for.
 */
const READ_AROUND_SEGMENTS = 4

/**
 * Segments being fetched, as checked plaintext, by frame and index, so
 * readers of the same one share the fetch. In memory only: the cache keeps
 * ciphertext.
 */
const segmentsUnderWay = new WeakMap<FastifyInstance, Map<string, Promise<Uint8Array>>>()

/** Where a segment a reader wants comes from: the cache's ciphertext, or a fetch's plaintext. */
type SegmentSource =
  | { kind: 'cache'; ciphertext: Promise<Uint8Array | null> }
  | { kind: 'fetch' | 'shared'; plaintext: Promise<Uint8Array> }

/**
 * Reads the segments of a stored chunk that a range covers, each checked by
 * its own tag and emitted as soon as it has arrived: kept ones from the
 * cache, ones another reader is fetching from that fetch, and the rest from
 * the CDN, consecutive ones in one request. A chunk read whole is also
 * checked against its SHA-256 and kept whole.
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
  const fetch: SegmentFetch = { app, versionId, key, chunk, layout, signal: range.signal }
  const sources = planSegments(fetch, first, last, false)
  for (let index = first; index <= last; index += 1) {
    let plaintext: Uint8Array | null = null
    // Once more if a kept copy fails its tag or was evicted, or another
    // reader's fetch was given up on: then this reader fetches it itself.
    for (let attempt = 0; plaintext === null; attempt += 1) {
      const source = sources.get(index)
      if (!source) throw new ContentError(`Segment ${String(index)} wasn't planned.`)
      try {
        if (source.kind === 'cache') {
          const ciphertext = await source.ciphertext
          if (ciphertext) plaintext = await openSegment(key, layout, index, ciphertext, context)
        } else {
          plaintext = await source.plaintext
        }
        // Served from the cache, or by another reader's fetch: no request of its own.
        if (plaintext) app.frameCache?.counted(source.kind !== 'fetch')
      } catch (error) {
        if (range.signal?.aborted || source.kind === 'fetch' || attempt > 0) throw error
        if (source.kind === 'cache') app.frameCache?.forgetSegment(chunk.frame_sha256, index)
      }
      if (plaintext === null) {
        if (attempt > 0) throw new ContentError(`Segment ${String(index)} couldn't be read.`)
        for (const [replanned, next] of planSegments(fetch, index, last, true)) {
          sources.set(replanned, next)
        }
      }
    }
    range.emit(wanted(layout, index, plaintext, range))
  }
}

interface SegmentFetch {
  app: FastifyInstance
  versionId: string
  key: AesKey
  chunk: ChunkLocation
  layout: ChunkFrameLayout
  signal: AbortSignal | undefined
}

/**
 * Where segments `from` to `last` come from, starting the fetches needed.
 * With `fresh`, segment `from` is fetched whatever the cache or another
 * reader says of it.
 */
function planSegments(
  fetch: SegmentFetch,
  from: number,
  last: number,
  fresh: boolean,
): Map<number, SegmentSource> {
  const { app, chunk, layout } = fetch
  const cache = app.frameCache
  const underWay = segmentsUnderWay.get(app)
  const sources = new Map<number, SegmentSource>()
  const keyOf = (index: number) =>
    `${Buffer.from(chunk.frame_sha256).toString('hex')}-${String(index)}`
  const found = (index: number): SegmentSource | null => {
    if (fresh && index === from) return null
    if (cache?.hasSegment(chunk.frame_sha256, index)) {
      return { kind: 'cache', ciphertext: cache.segment(chunk.frame_sha256, index) }
    }
    const shared = underWay?.get(keyOf(index))
    return shared ? { kind: 'shared', plaintext: shared } : null
  }
  // The whole chunk is fetched whole, kept segments or not, so it is kept
  // as one frame in their place; unless another reader is fetching some of
  // it, which is shared instead.
  const wholeChunk = !fresh && from === 0 && last === layout.segments - 1
  if (
    wholeChunk &&
    !Array.from({ length: layout.segments }, (_, i) => i).some((i) => underWay?.has(keyOf(i)))
  ) {
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
  let underWay = segmentsUnderWay.get(app)
  if (!underWay) {
    underWay = new Map()
    segmentsUnderWay.set(app, underWay)
  }
  const registry = underWay
  const whole = from === 0 && to === layout.segments - 1
  const pending = new Map<number, PromiseWithResolvers<Uint8Array>>()
  for (let index = from; index <= to; index += 1) {
    const deferred = Promise.withResolvers<Uint8Array>()
    // Segments read around a range have no reader waiting.
    void deferred.promise.catch(() => undefined)
    pending.set(index, deferred)
    sources.set(index, { kind: 'fetch', plaintext: deferred.promise })
    registry.set(`${hex}-${String(index)}`, deferred.promise)
  }
  const settle = (index: number) => {
    const deferred = pending.get(index)
    pending.delete(index)
    const key = `${hex}-${String(index)}`
    if (deferred && registry.get(key) === deferred.promise) registry.delete(key)
    return deferred
  }
  void fetchRun(fetch, from, to, whole, (index, plaintext, ciphertext) => {
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
}

/**
 * Streams segments `from` to `to` of a stored frame from the CDN, checking
 * each and handing it on with its ciphertext as soon as it has arrived. With
 * `whole`, the header is read too, and the whole frame is returned with its
 * SHA-256. If the frame moves meanwhile (§6.6), the rest is read where it is
 * now, from the next segment on.
 */
async function fetchRun(
  fetch: SegmentFetch,
  from: number,
  to: number,
  whole: boolean,
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

/** A chunk's frame, checked against its SHA-256. Stored ones come through the frame cache. */
async function checkedFrame(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  // Through the cache, the fetch has its own signal: the cache gives up on it
  // only once every reader waiting for the frame has.
  const read = async (fetchSignal: AbortSignal | undefined) => {
    const frame = await readFrame(app, versionId, chunk, fetchSignal)
    if (!Buffer.from(await sha256(frame)).equals(chunk.frame_sha256)) {
      throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} is corrupt.`)
    }
    return frame
  }
  const stored = !chunk.staged_path && !chunk.blob_staged_path && chunk.blob_state === 'stored'
  return stored && app.frameCache
    ? app.frameCache.load(chunk.frame_sha256, read, signal)
    : read(signal)
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

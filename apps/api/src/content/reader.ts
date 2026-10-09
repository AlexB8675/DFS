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
 * Streams the segments of a stored chunk that a range covers from the CDN,
 * each checked by its own tag and emitted as soon as it has arrived. When
 * the range is the whole chunk, the whole frame is read, checked against
 * its SHA-256 and kept in the frame cache too. If the frame moves meanwhile
 * (§6.6), the rest is read where it is now, from the next segment on.
 */
async function streamSegments(
  app: FastifyInstance,
  versionId: string,
  key: AesKey,
  chunk: ChunkLocation,
  layout: ChunkFrameLayout,
  range: ChunkRange,
): Promise<void> {
  const store = app.blobStore
  if (!store.stream) throw new ContentError('This store can’t stream.')
  const context = chunkContext(versionId, chunk.idx)
  const first = layout.segmentOf(range.from)
  const last = layout.segmentOf(range.to)
  // The whole frame, header and all, is kept for the cache.
  const frame =
    first === 0 && last === layout.segments - 1 ? Buffer.allocUnsafe(chunk.frame_size) : null
  const end = layout.segmentStart(last) + layout.segmentLength(last)
  let location = chunk
  let next = first
  for (;;) {
    const from = frame && next === 0 ? 0 : layout.segmentStart(next)
    let position = from
    let pending = Buffer.alloc(0)
    // The header, read with a whole frame: kept for the cache, not opened.
    let header = from === 0 ? layout.segmentStart(0) : 0
    try {
      for await (const piece of store.stream(
        blobOf(location),
        (location.blob_offset ?? 0) + from,
        end - from,
        range.signal,
      )) {
        frame?.set(piece, position)
        position += piece.length
        pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece])
        if (header > 0) {
          const skipped = Math.min(header, pending.length)
          header -= skipped
          pending = pending.subarray(skipped)
        }
        while (next <= last && pending.length >= layout.segmentLength(next)) {
          const bytes = pending.subarray(0, layout.segmentLength(next))
          pending = pending.subarray(layout.segmentLength(next))
          range.emit(
            wanted(layout, next, await openSegment(key, layout, next, bytes, context), range),
          )
          next += 1
        }
      }
      if (next <= last)
        throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} was cut short.`)
      break
    } catch (error) {
      // Given up on, or failed where it was: only a frame that moved is read again.
      if (range.signal?.aborted || error instanceof FrameError) throw error
      const moved = await movedLocation(app, versionId, location)
      if (moved?.blob_state !== 'stored' || moved.blob_offset === null) throw error
      location = moved
    }
  }
  if (frame && app.frameCache) {
    if (Buffer.from(await sha256(frame)).equals(chunk.frame_sha256)) {
      app.frameCache.put(chunk.frame_sha256, frame)
    } else {
      // Every segment passed its tag, so what was sent is right; the stored
      // frame differs from its hash all the same, which the scrubber will see.
      app.log.warn({ versionId, chunk: chunk.idx }, 'a frame read whole doesn’t match its hash')
    }
  }
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

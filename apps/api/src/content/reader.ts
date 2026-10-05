import { chunkContext, openFrame, sha256, uuidBytes, type AesKey } from '@dfs/crypto'
import type { Executor } from '@dfs/db'
import { isFresh, type BlobReader, type CdnUrl } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

// Reading a file back (DESIGN.md §6.2): find the chunks that cover a byte
// range, read each frame from staging (still syncing) or the blob store
// (stored, through the frame cache), check its SHA-256, decrypt it, and stream
// the requested slice. Chunks are read ahead while the current one is sent,
// more of them as the reader keeps up, never past the requested range.

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

/** Bytes `start` to `end` (inclusive) of a version, as plaintext. */
export async function* readVersion(
  app: FastifyInstance,
  version: ReadableVersion,
  start: number,
  end: number,
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
  const reading: { chunk: ChunkLocation; plaintext: Promise<Uint8Array>; giveBack: () => void }[] =
    []
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
        reading.push({ chunk, plaintext: prefetchChunk(app, versionId, key, chunk), giveBack })
        upcoming = await locations.next()
      }
      const current = reading.shift()
      if (!current) return
      let plaintext: Uint8Array
      try {
        plaintext = await current.plaintext
      } finally {
        current.giveBack()
      }
      const chunkStart = current.chunk.idx * chunkSize
      yield plaintext.subarray(
        Math.max(0, start - chunkStart),
        Math.min(plaintext.length, end - chunkStart + 1),
      )
      ahead = Math.min(MAX_READ_AHEAD, ahead + 1)
    }
  } finally {
    // Reads ahead that nobody will send finish into the cache, then give their memory back.
    for (const { plaintext, giveBack } of reading) void plaintext.then(giveBack, giveBack)
    await locations.return(undefined)
  }
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
    await signUrls(app.blobStore, chunks)
    yield* chunks
  }
}

/** Starts reading a chunk without leaving an unhandled rejection if the stream pauses or closes. */
function prefetchChunk(
  app: FastifyInstance,
  versionId: string,
  key: AesKey,
  chunk: ChunkLocation,
): Promise<Uint8Array> {
  const next = readChunk(app, versionId, key, chunk)
  // The original promise still rejects when awaited; observe it immediately,
  // since backpressure or a disconnected client can delay or skip that await.
  void next.catch(() => undefined)
  return next
}

async function readChunk(
  app: FastifyInstance,
  versionId: string,
  key: AesKey,
  chunk: ChunkLocation,
): Promise<Uint8Array> {
  const frame = await checkedFrame(app, versionId, chunk)
  const plaintext = await openFrame(key, frame, chunkContext(versionId, chunk.idx))
  if (plaintext.length !== chunk.plain_size) {
    throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} has the wrong size.`)
  }
  return plaintext
}

/** A chunk's frame, checked against its SHA-256. Stored ones come through the frame cache. */
async function checkedFrame(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
): Promise<Uint8Array> {
  const read = async () => {
    const frame = await readFrame(app, versionId, chunk)
    if (!Buffer.from(await sha256(frame)).equals(chunk.frame_sha256)) {
      throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} is corrupt.`)
    }
    return frame
  }
  const stored = !chunk.staged_path && !chunk.blob_staged_path && chunk.blob_state === 'stored'
  return stored && app.frameCache ? app.frameCache.load(chunk.frame_sha256, read) : read()
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
 * the chunk is looked up again.
 */
async function readFrame(
  app: FastifyInstance,
  versionId: string,
  chunk: ChunkLocation,
): Promise<Uint8Array> {
  const { staged_path: own, blob_staged_path: pack, blob_offset: offset } = chunk
  if (own || (pack && offset !== null)) {
    try {
      return own
        ? await app.staging.read(own)
        : await app.staging.readRange(pack ?? '', offset ?? 0, chunk.frame_size)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
      const [moved] = await chunkLocations(app.db, versionId, chunk.idx, chunk.idx)
      if (!moved || (moved.staged_path === own && moved.blob_staged_path === pack)) throw error
      return readFrame(app, versionId, moved)
    }
  }
  if (chunk.blob_id === null || chunk.blob_offset === null || chunk.blob_state !== 'stored') {
    throw new ContentError(`Chunk ${String(chunk.idx)} of ${versionId} is not readable.`)
  }
  return app.blobStore.read(
    {
      id: chunk.blob_id,
      channelId: chunk.channel_id,
      messageId: chunk.message_id,
      attachmentId: chunk.attachment_id,
      url: cdnUrlOf(chunk),
    },
    chunk.blob_offset,
    chunk.frame_size,
  )
}

/**
 * Signs, in one request, the CDN URLs a lookup batch is missing or that are
 * about to expire, rather than one request per chunk as they are read.
 */
async function signUrls(reader: BlobReader, chunks: ChunkLocation[]): Promise<void> {
  if (!reader.signUrls) return
  const stale = chunks.filter(
    (chunk) => chunk.blob_state === 'stored' && !chunk.staged_path && !isFresh(cdnUrlOf(chunk)),
  )
  const blobs = new Map<number, ChunkLocation>()
  for (const chunk of stale) if (chunk.blob_id !== null) blobs.set(chunk.blob_id, chunk)
  if (blobs.size === 0) return
  const signed = await reader.signUrls(
    [...blobs].map(([id, chunk]) => ({
      id,
      channelId: chunk.channel_id,
      messageId: chunk.message_id,
      attachmentId: chunk.attachment_id,
    })),
  )
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

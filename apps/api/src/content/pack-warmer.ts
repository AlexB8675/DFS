import { sha256 } from '@dfs/crypto'
import { uuidArray, type Executor } from '@dfs/db'
import { isFresh, type CdnUrl, type StoredBlob } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

// Whole packs for ZIP downloads (DESIGN.md §6.2). Small files of one folder
// usually share a pack, and a ZIP reads them one after another: one request
// per file would cost a round trip each. When an archive needs enough of a
// pack, the pack is fetched whole, once, and its frames go to the frame cache,
// where reading each file finds them. The next pack is fetched while this
// one's files are sent.

/**
 * Discord's CDN as measured (DESIGN.md §6.2): a request's round trip, and
 * how fast bytes come. A pack is fetched whole when the round trips it saves
 * outweigh the bytes it adds: for files of 100 KB, from about a quarter of a
 * 10 MiB pack on. Fewer of its files are read with a range each.
 */
const ROUND_TRIP_MS = 40
const BYTES_PER_MS = 7_000

interface PackedFrame extends Record<string, unknown> {
  version_id: string
  blob_offset: number
  frame_size: number
  frame_sha256: Buffer
  blob_id: number
  size_bytes: number
  channel_id: string | null
  message_id: string | null
  attachment_id: string | null
  cdn_url: string | null
  cdn_url_expires_ms: number | null
}

interface Pack {
  blob: StoredBlob
  size: number
  frames: { offset: number; size: number; sha256: Buffer }[]
}

export class PackWarmer {
  readonly #app: FastifyInstance
  readonly #packs: Map<number, Pack>
  /** The pack each version's frame is in, for the versions worth a whole pack. */
  readonly #packOf: Map<string, number>
  /** Packs in the order the archive first needs them. */
  readonly #order: number[]
  readonly #warming = new Map<number, Promise<void>>()

  private constructor(
    app: FastifyInstance,
    packs: Map<number, Pack>,
    packOf: Map<string, number>,
    order: number[],
  ) {
    this.#app = app
    this.#packs = packs
    this.#packOf = packOf
    this.#order = order
  }

  /**
   * Plans the packs worth fetching whole for these versions, in the order
   * they will be read, and signs their URLs in one request. `null` when there
   * is no frame cache to put them in (local storage).
   */
  static async plan(
    app: FastifyInstance,
    versionIds: readonly string[],
  ): Promise<PackWarmer | null> {
    const cache = app.frameCache
    if (!cache || versionIds.length === 0) return null
    // Frames the cache holds already need no fetching at all.
    const frames = (await packedFrames(app.db, versionIds)).filter(
      (frame) => !cache.has(frame.frame_sha256),
    )
    const packs = new Map<number, Pack>()
    for (const frame of frames) {
      let pack = packs.get(frame.blob_id)
      if (!pack) {
        pack = {
          blob: {
            id: frame.blob_id,
            channelId: frame.channel_id,
            messageId: frame.message_id,
            attachmentId: frame.attachment_id,
            url:
              frame.cdn_url && frame.cdn_url_expires_ms !== null
                ? { url: frame.cdn_url, expiresAt: new Date(frame.cdn_url_expires_ms) }
                : null,
          },
          size: frame.size_bytes,
          frames: [],
        }
        packs.set(frame.blob_id, pack)
      }
      pack.frames.push({
        offset: frame.blob_offset,
        size: frame.frame_size,
        sha256: frame.frame_sha256,
      })
    }
    for (const [id, pack] of packs) {
      const needed = pack.frames.reduce((total, frame) => total + frame.size, 0)
      const roundTripsSaved = (pack.frames.length - 1) * ROUND_TRIP_MS
      if (roundTripsSaved < (pack.size - needed) / BYTES_PER_MS) packs.delete(id)
    }
    if (packs.size === 0) return null

    const stale = [...packs.values()].filter((pack) => !isFresh(pack.blob.url))
    if (stale.length > 0 && app.blobStore.signUrls) {
      let signed: Map<number, CdnUrl>
      try {
        signed = await app.blobStore.signUrls(stale.map((pack) => pack.blob))
      } catch (error) {
        // Warming is only faster: without it, each file is read on its own.
        app.log.warn(
          { err: error },
          'could not sign pack URLs for a ZIP; reading its files one by one',
        )
        return null
      }
      for (const pack of stale) pack.blob.url = signed.get(pack.blob.id) ?? null
    }
    const packOf = new Map<string, number>()
    for (const frame of frames) {
      if (packs.has(frame.blob_id)) packOf.set(frame.version_id, frame.blob_id)
    }
    const order: number[] = []
    for (const versionId of versionIds) {
      const id = packOf.get(versionId)
      if (id !== undefined && !order.includes(id)) order.push(id)
    }
    return new PackWarmer(app, packs, packOf, order)
  }

  /** Call before reading a version: fetches its pack if worth it, and starts on the next one. */
  async before(versionId: string): Promise<void> {
    const id = this.#packOf.get(versionId)
    if (id === undefined) return
    const next = this.#order[this.#order.indexOf(id) + 1]
    if (next !== undefined) void this.#warm(next)
    await this.#warm(id)
  }

  /** Fetches a pack whole into the frame cache. On any trouble, its files are read frame by frame. */
  #warm(id: number): Promise<void> {
    let warming = this.#warming.get(id)
    if (!warming) {
      warming = this.#fetch(id).catch((error: unknown) => {
        this.#app.log.warn(
          { err: error, blobId: id },
          'could not fetch a whole pack; reading its frames one by one',
        )
      })
      this.#warming.set(id, warming)
    }
    return warming
  }

  async #fetch(id: number): Promise<void> {
    const pack = this.#packs.get(id)
    const cache = this.#app.frameCache
    // Without room in the read-ahead budget, the frames are read one by one.
    const giveBack = pack && cache ? this.#app.readBudget?.tryTake(pack.size) : null
    if (!pack || !cache || !giveBack) return
    try {
      const data = await this.#app.blobStore.read(pack.blob, 0, pack.size)
      for (const frame of pack.frames) {
        // A copy, so the cache doesn't keep the whole pack alive.
        const bytes = data.slice(frame.offset, frame.offset + frame.size)
        if (Buffer.from(await sha256(bytes)).equals(frame.sha256)) cache.put(frame.sha256, bytes)
      }
    } finally {
      giveBack()
    }
  }
}

async function packedFrames(db: Executor, versionIds: readonly string[]): Promise<PackedFrame[]> {
  const { rows } = await db.execute<PackedFrame>(sql`
    SELECT chunk.version_id, chunk.blob_offset, chunk.frame_size, chunk.frame_sha256,
      blob.id::float8 AS blob_id, blob.size_bytes, blob.channel_id, blob.message_id,
      blob.attachment_id, blob.cdn_url,
      (extract(epoch FROM blob.cdn_url_expires_at) * 1000)::float8 AS cdn_url_expires_ms
    FROM chunks chunk JOIN blobs blob ON blob.id = chunk.blob_id
    WHERE chunk.version_id = ANY(${uuidArray(versionIds)})
      AND blob.kind = 'pack' AND blob.state = 'stored'`)
  return rows
}

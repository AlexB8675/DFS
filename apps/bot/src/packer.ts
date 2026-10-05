import type { Database, Executor } from '@dfs/db'
import type { Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

// Packing small frames (DESIGN.md §6.6). The frames of small files, and the
// small ends of large files, wait in staging until the packer concatenates
// them into a pack of about 10 MiB: one Discord message for many files, and
// files uploaded together side by side. The packer needs no keys, since
// frames are self-delimiting ciphertext. Only the leading bot runs it.

/** Waiting frames looked at per pack: enough to fill one with frames of 1 KiB. */
const WINDOW = 10_000

export interface PackerOptions {
  db: Database
  staging: Staging
  /** `BLOB_MAX_BYTES` and `PACK_TARGET_BYTES` (DESIGN.md §15). */
  sizes: { blobMaxBytes: number; packTargetBytes: number }
  /** `PACK_MAX_WAIT_MS`: how long a frame waits for others before a partial pack is sealed. */
  maxWaitMs: number
  /** Queues sealed packs for storing, in the transaction that seals them. */
  enqueue?: (tx: Executor, blobIds: number[]) => Promise<void>
  log?: Pick<FastifyBaseLogger, 'warn'>
}

interface WaitingFrame extends Record<string, unknown> {
  id: number
  frame_size: number
  staged_path: string
}

export class Packer {
  readonly #options: PackerOptions
  /** When the packer first saw each frame it is looking at waiting. */
  #firstSeen = new Map<number, number>()
  /** Frames whose staged file is missing or wrong: logged once, then left out. */
  readonly #broken = new Set<number>()

  constructor(options: PackerOptions) {
    this.#options = options
  }

  /**
   * Seals every pack that is due, and returns how many. A pack is due once it
   * reaches `PACK_TARGET_BYTES`, when the frames left waiting don't fit in
   * it, or when its oldest frame has waited `PACK_MAX_WAIT_MS`. `force`
   * seals what is waiting at once, for tests.
   */
  async sealDue({ force = false, now = Date.now() } = {}): Promise<number> {
    let sealed = 0
    for (;;) {
      const result = await this.#sealOne(force, now)
      if (result === 'idle') return sealed
      if (result === 'sealed') sealed += 1
    }
  }

  async #sealOne(force: boolean, now: number): Promise<'sealed' | 'idle' | 'retry'> {
    const { db, staging, sizes, maxWaitMs, enqueue, log } = this.#options
    // Whether a pack is due is decided without locks: the packer looks every second.
    const waiting = await this.#waiting(db, false)
    const firstSeen = new Map<number, number>()
    for (const frame of waiting) firstSeen.set(frame.id, this.#firstSeen.get(frame.id) ?? now)
    this.#firstSeen = firstSeen
    const [first] = waiting
    if (!first) return 'idle'
    const { picked, size } = this.#pick(waiting)
    const due =
      force ||
      size >= sizes.packTargetBytes ||
      picked.length < waiting.length ||
      waiting.length === WINDOW ||
      now - (firstSeen.get(first.id) ?? now) >= maxWaitMs
    if (!due) return 'idle'

    // Set inside the transaction: the pack file written, and the frames it holds.
    const sealed: { pack: string | null; frames: string[]; broken: boolean } = {
      pack: null,
      frames: [],
      broken: false,
    }
    try {
      await db.transaction(async (tx) => {
        // Locked, and picked again: a purge may have taken some meanwhile. A
        // purge of one of them waits for this pack, then counts it out (purge.ts).
        const { picked } = this.#pick(await this.#waiting(tx, true))
        const frames: Uint8Array[] = []
        const placed: { id: number; at: number }[] = []
        let offset = 0
        for (const frame of picked) {
          const bytes = await staging.read(frame.staged_path).catch(() => null)
          if (bytes?.length !== frame.frame_size) {
            log?.warn(
              { chunkId: frame.id, stagedPath: frame.staged_path },
              'a staged frame is missing or the wrong size; it is left out of packs',
            )
            this.#broken.add(frame.id)
            sealed.broken = true
            return
          }
          placed.push({ id: frame.id, at: offset })
          frames.push(bytes)
          offset += bytes.length
        }
        if (frames.length === 0) return
        const data = Buffer.concat(frames)
        // Hash on the thread pool, keeping the bot responsive for other work.
        const hash = Buffer.from(await crypto.subtle.digest('SHA-256', data))
        const pack = staging.packPath()
        sealed.pack = pack
        await staging.write(pack, data)

        const { rows: created } = await tx.execute<{ id: number }>(sql`
          INSERT INTO blobs (kind, state, size_bytes, live_bytes, frame_count, sha256, staged_path)
          VALUES ('pack', 'staged', ${data.length}, ${data.length}, ${frames.length}, ${hash}, ${pack})
          RETURNING id::float8 AS id`)
        const blobId = created[0]?.id
        if (blobId === undefined) throw new Error('The pack was not recorded.')
        await tx.execute(sql`
          UPDATE chunks SET blob_id = ${blobId}, blob_offset = placed.at, staged_path = NULL
          FROM jsonb_to_recordset(${JSON.stringify(placed)}::jsonb) AS placed(id bigint, at integer)
          WHERE chunks.id = placed.id`)
        await enqueue?.(tx, [blobId])
        sealed.frames = picked.map((frame) => frame.staged_path)
      })
    } catch (error) {
      if (sealed.pack) await staging.remove(sealed.pack).catch(() => undefined)
      throw error
    }
    if (sealed.broken) return 'retry'
    if (sealed.frames.length === 0) return 'idle'
    // The pack holds them now. A file left behind by a crash here goes with
    // its version's folder once the version is stored.
    for (const frame of sealed.frames) {
      await staging.remove(frame).catch((error: unknown) => {
        log?.warn({ err: error, stagedPath: frame }, 'could not remove a packed frame')
      })
    }
    return 'sealed'
  }

  /** Frames of completed uploads waiting for a pack, oldest first. */
  async #waiting(db: Executor, lock: boolean): Promise<WaitingFrame[]> {
    const { rows } = await db.execute<WaitingFrame>(sql`
      SELECT chunk.id::float8 AS id, chunk.frame_size, chunk.staged_path
      FROM chunks chunk JOIN file_versions version ON version.id = chunk.version_id
      WHERE chunk.blob_id IS NULL AND chunk.purged_at IS NULL
        AND chunk.staged_path IS NOT NULL AND version.state = 'syncing'
      ORDER BY chunk.id LIMIT ${WINDOW}
      ${lock ? sql`FOR UPDATE OF chunk SKIP LOCKED` : sql``}`)
    return rows.filter((frame) => !this.#broken.has(frame.id))
  }

  /** In order, every frame that still fits: files uploaded together stay together. */
  #pick(waiting: readonly WaitingFrame[]): { picked: WaitingFrame[]; size: number } {
    const { sizes } = this.#options
    const picked: WaitingFrame[] = []
    let size = 0
    for (const frame of waiting) {
      if (size >= sizes.packTargetBytes) break
      if (size + frame.frame_size > sizes.blobMaxBytes) continue
      picked.push(frame)
      size += frame.frame_size
    }
    return { picked, size }
  }
}

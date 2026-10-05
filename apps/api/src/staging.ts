import type { Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

/**
 * Removes the staged frames of versions that no longer exist, after the
 * transaction that removed them committed. A failure only leaves files
 * behind, so it is logged rather than surfaced.
 */
export async function removeStagedVersions(
  app: FastifyInstance,
  versionIds: readonly string[],
): Promise<void> {
  for (const versionId of versionIds) {
    try {
      await app.staging.removeVersion(versionId)
    } catch (error) {
      app.log.warn({ err: error, versionId }, 'could not remove staged frames')
    }
  }
}

/**
 * Whether staging holds more than `STAGING_MAX_BYTES` of frames not yet
 * stored (§6.1). Summed from the database at most every few seconds, so a
 * burst of parts costs one query, not one each.
 */
export class StagingLimit {
  readonly #db: Executor
  readonly #maxBytes: number
  #checkedAt = -Infinity
  #full = false
  #checking: Promise<boolean> | null = null

  constructor(db: Executor, maxBytes: number) {
    this.#db = db
    this.#maxBytes = maxBytes
  }

  async isFull(now = Date.now()): Promise<boolean> {
    if (this.#checking) return this.#checking
    if (now - this.#checkedAt < 3000) return this.#full
    this.#checking = this.#check(now).finally(() => {
      this.#checking = null
    })
    return this.#checking
  }

  async #check(now: number): Promise<boolean> {
    // Frames on their own, and sealed packs waiting to be stored.
    const { rows } = await this.#db.execute<{ bytes: number }>(sql`
      SELECT (
        (SELECT coalesce(sum(frame_size), 0) FROM chunks WHERE staged_path IS NOT NULL) +
        (SELECT coalesce(sum(size_bytes), 0) FROM blobs
          WHERE kind = 'pack' AND state IN ('staged', 'uploading') AND staged_path IS NOT NULL)
      )::float8 AS bytes`)
    this.#full = (rows[0]?.bytes ?? 0) >= this.#maxBytes
    this.#checkedAt = now
    return this.#full
  }
}

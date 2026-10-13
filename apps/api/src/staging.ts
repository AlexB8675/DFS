import {
  LOCK_NAMESPACE,
  LOCKS,
  reservedStagingSql,
  STAGING_TURN_SECONDS,
  stagedBytesSql,
  type Database,
} from '@dfs/db'
import { sql, type SQL } from 'drizzle-orm'
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

/** A waiting stream's turn still holds: its client came back lately (§6.1). */
const liveTurn = (alias: string) => sql`${sql.identifier(alias)}.staging_waiting_since IS NOT NULL
  AND ${sql.identifier(alias)}.staging_waiting_seen_at > now() - make_interval(secs => ${STAGING_TURN_SECONDS}::int)`

/**
 * The room the oldest stream still waiting needs (§6.1): `0` when none
 * waits, or when the asking stream is itself the oldest.
 */
function firstWaitingSql(uploadId?: string): SQL {
  const behind =
    uploadId === undefined
      ? sql``
      : sql`AND waiting.id <> ${uploadId} AND waiting.staging_waiting_since < coalesce((
          SELECT mine.staging_waiting_since FROM upload_sessions mine
          WHERE mine.id = ${uploadId} AND ${liveTurn('mine')}), 'infinity')`
  return sql`coalesce((
    SELECT waiting.staging_wanted_bytes FROM upload_sessions waiting
    WHERE ${liveTurn('waiting')} ${behind}
    ORDER BY waiting.staging_waiting_since, waiting.id LIMIT 1), 0)`
}

/**
 * Room in staging (§6.1, D38): the frames it holds, what streams under way
 * have reserved, and whose turn it is. A stream gets in by reserving all it
 * has yet to send (`admit`), so it always has room to finish; a single part
 * gets in while `isFull` says there is room.
 */
export class StagingRoom {
  readonly #db: Database
  readonly #maxBytes: number
  #checkedAt = -Infinity
  #full = false
  #checking: Promise<boolean> | null = null

  constructor(db: Database, maxBytes: number) {
    this.#db = db
    this.#maxBytes = maxBytes
  }

  /**
   * Whether a single part must wait: what staging holds, what streams have
   * reserved, and the room the oldest waiting stream needs reach the limit.
   * Summed from the database at most every few seconds, so a burst of parts
   * costs one query, not one each; staging can pass its limit by the parts
   * let in on a figure a few seconds old, which its disk has room for.
   */
  async isFull(now = Date.now()): Promise<boolean> {
    if (this.#checking) return this.#checking
    if (now - this.#checkedAt < 3000) return this.#full
    this.#checking = this.#check(now).finally(() => {
      this.#checking = null
    })
    return this.#checking
  }

  async #check(now: number): Promise<boolean> {
    const { rows } = await this.#db.execute<{ bytes: number }>(
      sql`SELECT (${stagedBytesSql()} + ${reservedStagingSql()} + ${firstWaitingSql()})::float8 AS bytes`,
    )
    this.#full = (rows[0]?.bytes ?? 0) >= this.#maxBytes
    this.#checkedAt = now
    return this.#full
  }

  /**
   * Lets a stream in if staging has room for `needBytes` besides what it
   * holds, what others reserved and, when an older stream waits, that
   * stream's need: then reserves it. Otherwise records that the stream
   * waits, keeping its turn while its client keeps coming back. One short
   * transaction under a lock of its own, so streams on two API instances
   * can't both take the last room.
   */
  async admit(uploadId: string, needBytes: number): Promise<boolean> {
    const fits = await this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.stagingRoom})`)
      const { rows } = await tx.execute<{ used: number; ahead: number }>(sql`
        SELECT (${stagedBytesSql()} + ${reservedStagingSql(uploadId)})::float8 AS used,
          ${firstWaitingSql(uploadId)}::float8 AS ahead`)
      const room = rows[0]
      const admitted = room !== undefined && room.used + room.ahead + needBytes <= this.#maxBytes
      await tx.execute(
        admitted
          ? sql`
            UPDATE upload_sessions SET staging_reserved_bytes = ${needBytes},
              staging_reserved_at = now(), staging_waiting_since = NULL,
              staging_waiting_seen_at = NULL, staging_wanted_bytes = 0
            WHERE id = ${uploadId}`
          : sql`
            UPDATE upload_sessions session SET
              staging_waiting_since = CASE WHEN ${liveTurn('session')}
                THEN session.staging_waiting_since ELSE now() END,
              staging_waiting_seen_at = now(), staging_wanted_bytes = ${needBytes}
            WHERE session.id = ${uploadId}`,
      )
      return admitted
    })
    // What this instance knew of the room is out of date either way.
    this.#checkedAt = -Infinity
    return fits
  }

  /** Keeps a stream's reservation counted: every 30 s while it runs. */
  async renew(uploadId: string): Promise<void> {
    await this.#db.execute(sql`
      UPDATE upload_sessions SET staging_reserved_at = now()
      WHERE id = ${uploadId} AND staging_reserved_bytes > 0`)
  }

  /**
   * Gives back what a stream that stopped had left reserved. Its turn, if it
   * was refused, stays for its client's next try.
   */
  async release(uploadId: string): Promise<void> {
    await this.#db.execute(sql`
      UPDATE upload_sessions SET staging_reserved_bytes = 0, staging_reserved_at = NULL
      WHERE id = ${uploadId} AND staging_reserved_bytes > 0`)
    this.#checkedAt = -Infinity
  }
}

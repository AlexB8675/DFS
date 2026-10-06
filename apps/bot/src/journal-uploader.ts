import type { Database } from '@dfs/db'
import type { JournalStore } from '@dfs/storage'
import { sql } from 'drizzle-orm'

// Posts the journal batches the API sealed (DESIGN.md §8) to #dfs-journal,
// oldest first and one at a time. A batch that fails stays first in line, so
// batches reach Discord in order; tries after a failure wait longer each
// time, up to five minutes, so an outage doesn't hammer Discord.

const FIRST_WAIT_MS = 5000
const LONGEST_WAIT_MS = 5 * 60_000

interface StagedBatch extends Record<string, unknown> {
  batch_no: number
  first_id: number
  last_id: number
  sealed: Buffer | null
}

export class JournalUploader {
  readonly #db: Database
  readonly #journal: JournalStore
  #failures = 0
  #retryAt = 0

  constructor(deps: { db: Database; journal: JournalStore }) {
    this.#db = deps.db
    this.#journal = deps.journal
  }

  /** Stores the staged batches in number order; returns how many went. Throws on a failure. */
  async run(now = Date.now()): Promise<number> {
    if (now < this.#retryAt) return 0
    let stored = 0
    for (;;) {
      const { rows } = await this.#db.execute<StagedBatch>(sql`
        SELECT batch_no::float8 AS batch_no, first_id::float8 AS first_id,
          last_id::float8 AS last_id, sealed
        FROM journal_batches WHERE state = 'staged' ORDER BY batch_no LIMIT 1`)
      const [batch] = rows
      if (!batch?.sealed) {
        this.#failures = 0
        return stored
      }
      let location
      try {
        location = await this.#journal.put(
          { batchNo: batch.batch_no, firstId: batch.first_id, lastId: batch.last_id },
          new Uint8Array(batch.sealed),
        )
      } catch (error) {
        this.#failures += 1
        this.#retryAt =
          Date.now() + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** (this.#failures - 1))
        const reason = error instanceof Error ? error.message : String(error)
        await this.#db.execute(sql`
          UPDATE journal_batches SET attempts = attempts + 1, last_error = ${reason}
          WHERE batch_no = ${batch.batch_no}`)
        throw error
      }
      await this.#db.execute(sql`
        UPDATE journal_batches SET state = 'stored', sealed = NULL, stored_at = now(),
          channel_id = ${location.channelId}, message_id = ${location.messageId},
          attachment_id = ${location.attachmentId}, last_error = NULL
        WHERE batch_no = ${batch.batch_no} AND state = 'staged'`)
      this.#failures = 0
      stored += 1
    }
  }
}

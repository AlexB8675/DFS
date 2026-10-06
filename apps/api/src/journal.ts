import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { journalBatchContext, sealObject, sha256 } from '@dfs/crypto'
import { LOCK_NAMESPACE, LOCKS, journalBatches, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

// The journal's way to Discord (DESIGN.md §8). Records not yet flushed are
// sealed into numbered batches, one transaction each, under a lock of their
// own so one API instance flushes at a time; the leading bot posts the
// batches to #dfs-journal in order. A batch number is taken under that lock
// and given back if its transaction rolls back, so numbers stay contiguous.
//
// A batch is `{v, instance, batch, records: [{id, kind, at, record}]}` as
// JSON, gzip'd (frame flag GZIP), sealed as an object for its number. A
// record too large for one batch is cut into pieces, each in a batch of its
// own (`piece: {id, index, count, data}`, `records` empty), all sealed in one
// transaction: recovery joins the pieces' `data` and parses the record.

/** Records per batch at most. */
export const BATCH_RECORDS = 5000
/** A batch's records as JSON, before gzip, at most: sealed, it stays well under an attachment. */
export const BATCH_MAX_BYTES = 8 * 1024 * 1024
/** The frame flag of a gzip'd batch. */
export const GZIP_FLAG = 0x01
const PAYLOAD_VERSION = 1
/** How often the flusher looks whether a batch's worth of records waits. */
const CHECK_EVERY_MS = 5000

const gzipped = promisify(gzip)

export interface FlushLimits {
  maxRecords?: number
  maxBytes?: number
}

/**
 * Seals every record not yet flushed into batches. Returns the numbers of the
 * batches sealed, none if there was nothing to seal or another API instance
 * was flushing.
 */
export async function flushJournal(
  app: FastifyInstance,
  limits: FlushLimits = {},
): Promise<number[]> {
  const sealed: number[] = []
  for (;;) {
    const batches = await sealNext(app, limits)
    if (batches.length === 0) return sealed
    sealed.push(...batches)
  }
}

interface JournalRow extends Record<string, unknown> {
  id: number
  kind: string
  record: unknown
  created_at: string
}

/** Seals the next batch, or the pieces of a record too large for one, in one transaction. */
async function sealNext(
  app: FastifyInstance,
  { maxRecords = BATCH_RECORDS, maxBytes = BATCH_MAX_BYTES }: FlushLimits,
): Promise<number[]> {
  return app.db.transaction(async (tx) => {
    const { rows: locked } = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.journalFlush}) AS locked`)
    if (!locked[0]?.locked) return []
    const { rows } = await tx.execute<JournalRow>(sql`
      SELECT id::float8 AS id, kind, record, created_at::text AS created_at FROM journal
      WHERE batch_no IS NULL ORDER BY id LIMIT ${maxRecords}`)
    if (rows.length === 0) return []
    const { rows: numbers } = await tx.execute<{ next: number }>(sql`
      SELECT coalesce(max(batch_no), 0)::float8 + 1 AS next FROM journal_batches`)
    const first = numbers[0]?.next ?? 1
    const { rows: instances } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM instance LIMIT 1`)
    const instance = instances[0]?.id ?? ''

    // Whole records, in ID order, up to the cap.
    const entries: string[] = []
    let bytes = 0
    for (const row of rows) {
      const entry = JSON.stringify({
        id: row.id,
        kind: row.kind,
        at: new Date(row.created_at).toISOString(),
        record: row.record,
      })
      const size = Buffer.byteLength(entry)
      if (entries.length > 0 && bytes + size > maxBytes) break
      entries.push(entry)
      bytes += size
    }
    const header = (batch: number) =>
      `{"v":${String(PAYLOAD_VERSION)},"instance":${JSON.stringify(instance)},"batch":${String(batch)}`
    const ids = rows.slice(0, entries.length).map((row) => row.id)
    const firstId = ids[0] ?? 0
    const lastId = ids.at(-1) ?? 0

    const payloads: string[] = []
    const [only] = entries
    if (entries.length === 1 && only !== undefined && bytes > maxBytes) {
      // One record too large: its JSON in pieces. A UTF-16 unit takes at most
      // three bytes of UTF-8, and JSON keeps a lone surrogate as an escape.
      const pieceLength = Math.max(1, Math.floor((maxBytes - 1024) / 3))
      const count = Math.ceil(only.length / pieceLength)
      for (let index = 0; index < count; index += 1) {
        const piece = JSON.stringify({
          id: firstId,
          index,
          count,
          data: only.slice(index * pieceLength, (index + 1) * pieceLength),
        })
        payloads.push(`${header(first + index)},"records":[],"piece":${piece}}`)
      }
    } else {
      payloads.push(`${header(first)},"records":[${entries.join(',')}]}`)
    }

    const sealed: number[] = []
    for (const [index, payload] of payloads.entries()) {
      const batchNo = first + index
      const object = await sealObject(
        app.keys,
        new Uint8Array(await gzipped(payload)),
        journalBatchContext(batchNo),
        GZIP_FLAG,
      )
      await tx.insert(journalBatches).values({
        batchNo,
        firstId,
        lastId,
        recordCount: entries.length,
        sealed: Buffer.from(object),
        sizeBytes: object.length,
        sha256: Buffer.from(await sha256(object)),
      })
      sealed.push(batchNo)
    }
    // A record cut into pieces belongs to the batch with its last piece.
    await tx.execute(sql`
      UPDATE journal SET batch_no = ${sealed.at(-1) ?? first}
      WHERE id = ANY(${`{${ids.join(',')}}`}::bigint[])`)
    return sealed
  })
}

/** How many records wait to be flushed, counting up to `limit`. */
export async function waitingRecords(db: Executor, limit: number): Promise<number> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM journal WHERE batch_no IS NULL LIMIT ${limit}
    ) waiting`)
  return rows[0]?.count ?? 0
}

/**
 * Flushes the journal every `JOURNAL_FLUSH_INTERVAL_MS`, or as soon as a
 * batch's worth of records waits. Started by `main.ts` only, so tests flush
 * when they choose.
 */
export class JournalFlusher {
  readonly #app: FastifyInstance
  #timer: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> = Promise.resolve()
  #stopped = true
  #flushedAt = 0

  constructor(app: FastifyInstance) {
    this.#app = app
  }

  start(): void {
    this.#stopped = false
    this.#schedule(0)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    await this.#running
  }

  #schedule(delay: number): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      this.#running = this.#tick()
        .catch((error: unknown) => {
          this.#app.log.warn({ err: error }, 'flushing the journal failed; trying again later')
        })
        .finally(() => {
          this.#schedule(CHECK_EVERY_MS)
        })
    }, delay)
  }

  async #tick(): Promise<void> {
    const due =
      Date.now() - this.#flushedAt >= this.#app.config.journalFlushIntervalMs ||
      (await waitingRecords(this.#app.db, BATCH_RECORDS)) >= BATCH_RECORDS
    if (!due) return
    await flushJournal(this.#app)
    this.#flushedAt = Date.now()
  }
}

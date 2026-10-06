import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { JournalUploader } from '@dfs/bot/journal-uploader'
import { instanceId, journalChannel } from '@dfs/bot/storage'
import { journalBatchContext, openObject } from '@dfs/crypto'
import { appendJournal, storageChannels } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { DiscordJournalStore } from '@dfs/storage'
import { FakeDiscord } from '@dfs/storage/testing'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from './app.ts'
import { flushJournal, GZIP_FLAG } from './journal.ts'
import { testConfig } from './testing/config.ts'

const gunzipped = promisify(gunzip)

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

interface Payload {
  v: number
  instance: string
  batch: number
  records: { id: number; kind: string; at: string; record: Record<string, unknown> }[]
  piece?: { id: number; index: number; count: number; data: string }
}

/** A sealed batch, opened as recovery would: with nothing but the key file. */
async function open(batchNo: number, posted?: Uint8Array): Promise<Payload> {
  const { rows } = await app.db.execute<{ sealed: Buffer }>(sql`
    SELECT sealed FROM journal_batches WHERE batch_no = ${batchNo}`)
  const sealed = posted ?? rows[0]?.sealed
  if (!sealed) throw new Error(`No batch ${String(batchNo)}.`)
  const { plaintext, flags } = await openObject(app.keys, sealed, journalBatchContext(batchNo))
  expect(flags).toBe(GZIP_FLAG)
  return JSON.parse((await gunzipped(plaintext)).toString('utf8')) as Payload
}

async function journaled(kind: string, records: Record<string, unknown>[]): Promise<number[]> {
  await appendJournal(
    app.db,
    records.map((record) => ({ kind: kind as 'node.upsert', record })),
  )
  const { rows } = await app.db.execute<{ id: number }>(sql`
    SELECT id::float8 AS id FROM journal WHERE kind = ${kind} ORDER BY id`)
  return rows.map((row) => row.id)
}

async function unflushed(): Promise<number> {
  const { rows } = await app.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM journal WHERE batch_no IS NULL`)
  return rows[0]?.count ?? 0
}

describe('the journal (§8)', () => {
  it('seals what waits into a batch that opens with the key alone, records in order', async () => {
    const ids = await journaled('node.upsert', [{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const sealed = await flushJournal(app)
    expect(sealed).toHaveLength(1)
    expect(await unflushed()).toBe(0)

    const [batchNo] = sealed
    const payload = await open(batchNo ?? 0)
    const { rows: instance } = await app.db.execute<{ id: string }>(sql`SELECT id FROM instance`)
    expect(payload).toMatchObject({ v: 1, instance: instance[0]?.id, batch: batchNo })
    const mine = payload.records.filter((entry) => ids.includes(entry.id))
    expect(mine.map((entry) => entry.record)).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    expect(payload.records.map((entry) => entry.id)).toEqual(
      payload.records.map((entry) => entry.id).sort((a, b) => a - b),
    )
    expect(await flushJournal(app)).toEqual([])
  })

  it('numbers batches one after another, and cuts a record too large into pieces', async () => {
    await journaled('user.upsert', [{ n: 1 }, { n: 2 }, { n: 3 }])
    const big = { data: 'é'.repeat(3000) }
    const [bigId] = (await journaled('version.stored', [big])).slice(-1)
    const sealed = await flushJournal(app, { maxRecords: 2, maxBytes: 2048 })
    expect(sealed.slice(1)).toEqual(sealed.slice(1).map((_, index) => (sealed[0] ?? 0) + index + 1))

    const payloads = await Promise.all(sealed.map((batchNo) => open(batchNo)))
    const pieces = payloads.flatMap((payload) => (payload.piece ? [payload.piece] : []))
    expect(pieces.length).toBeGreaterThan(2)
    expect(pieces.map((piece) => piece.index)).toEqual(pieces.map((_, index) => index))
    expect(pieces.every((piece) => piece.id === bigId && piece.count === pieces.length)).toBe(true)
    const joined = JSON.parse(pieces.map((piece) => piece.data).join('')) as Payload['records'][0]
    expect(joined).toMatchObject({ id: bigId, kind: 'version.stored', record: big })
    // The record belongs to the batch with its last piece.
    const { rows } = await app.db.execute<{ batch_no: number }>(sql`
      SELECT batch_no::float8 AS batch_no FROM journal WHERE id = ${bigId ?? 0}`)
    expect(rows[0]?.batch_no).toBe(sealed.at(-1))
  })

  it('flushes once when two flush at the same time', async () => {
    await journaled(
      'node.upsert',
      Array.from({ length: 10 }, (_, n) => ({ n })),
    )
    const before = await lastBatch()
    const [left, right] = await Promise.all([
      flushJournal(app, { maxRecords: 3 }),
      flushJournal(app, { maxRecords: 3 }),
    ])
    const all = [...left, ...right].sort((a, b) => a - b)
    expect(all).toEqual(all.map((_, index) => before + index + 1))
    expect(await unflushed()).toBe(0)
  })

  it('reaches #dfs-journal, where the batch opens with the key alone', async () => {
    const discord = new FakeDiscord()
    const channel = discord.addTextChannel('dfs-journal', discord.addCategory('DFS Dev').id)
    await app.db
      .insert(storageChannels)
      .values({ discordChannelId: channel.id, name: 'dfs-journal', kind: 'journal' })
    await journaled('node.upsert', [{ trip: 'round' }])
    const [batchNo] = await flushJournal(app)
    const uploader = new JournalUploader({
      db: app.db,
      journal: new DiscordJournalStore({
        rest: discord,
        channel: () => journalChannel(app.db, discord, discord.guildId, 'DFS Dev'),
        instanceId: () => instanceId(app.db),
      }),
    })
    await uploader.run()

    const message = discord.messages.find((candidate) =>
      candidate.content.startsWith(`dfs1 j=${String(batchNo)} `),
    )
    // What the CDN holds for its attachment, by the link without its signature.
    const posted = discord.cdn.get((message?.attachments[0]?.url ?? '').split('?')[0] ?? '')
    const payload = await open(batchNo ?? 0, posted)
    expect(payload.records.map((entry) => entry.record)).toContainEqual({ trip: 'round' })
  })

  it('gives a batch’s number back when its transaction fails', async () => {
    await journaled('node.upsert', [{ late: true }])
    const before = await lastBatch()
    await app.db.execute(sql`
      ALTER TABLE journal_batches ADD CONSTRAINT test_refuse CHECK (batch_no < 0) NOT VALID`)
    try {
      await expect(flushJournal(app)).rejects.toThrow()
    } finally {
      await app.db.execute(sql`ALTER TABLE journal_batches DROP CONSTRAINT test_refuse`)
    }
    expect(await unflushed()).toBe(1)
    expect(await flushJournal(app)).toEqual([before + 1])
  })
})

async function lastBatch(): Promise<number> {
  const { rows } = await app.db.execute<{ last: number }>(sql`
    SELECT coalesce(max(batch_no), 0)::float8 AS last FROM journal_batches`)
  return rows[0]?.last ?? 0
}

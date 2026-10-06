import type { Config } from '@dfs/config'
import {
  abandonUploads,
  ADMIN_TASK_QUEUE,
  BLOB_UPLOAD_QUEUE,
  foldAllFolderStats,
  PostgresSampler,
  pruneMetrics,
  QUEUES,
  sampleSystem,
  textArray,
  type AdminTaskJob,
  type BlobUploadJob,
  type Database,
  type Metrics,
} from '@dfs/db'
import { channelsInCategory, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { fromDrizzle, type JobResult, type PgBoss } from 'pg-boss'
import { collectGarbage, uploadsWaiting } from './collector.ts'
import { keepGateway } from './gateway.ts'
import { Packer } from './packer.ts'
import { reconcileOrphans } from './reconciler.ts'
import { instanceId, type BotStorage } from './storage.ts'
import { runAdminTask } from './tasks.ts'
import { storeBlobs } from './uploader.ts'

// What only the leading bot does (DESIGN.md §11): pack small frames (§6.6),
// store staged blobs, delete released ones (§6.4), clean up orphan messages
// (§6.1), keep folder sizes current (§12.1), and clean up after expired
// uploads and sessions.

const FOLD_EVERY_MS = 2000
const JANITOR_EVERY_MS = 10 * 60_000
const PACK_EVERY_MS = 1000
const COLLECT_EVERY_MS = 2000
/** Deletes per round while blobs wait to be stored, and while none do (§6.4). */
const COLLECT_WHILE_UPLOADING = 1
const COLLECT_WHILE_IDLE = 20
const RECONCILE_EVERY_MS = 60 * 60_000
/** The system's figures, for the admin's graphs (§16). */
const SAMPLE_EVERY_MS = 60_000
/** A pack file nothing refers to after this long was left by a crash while sealing. */
const STRAY_PACK_MS = 60 * 60_000
/**
 * Jobs per batch, and batches at once. Each batch stores its blobs side by
 * side, and the store gives each channel UPLOAD_CHANNEL_CONCURRENCY posts at a
 * time, so 32 blobs in hand keep a dozen channels busy while one waits out a
 * rate limit. A blob is read only once it is posted.
 */
const UPLOAD_BATCH = 8
const UPLOAD_BATCHES = 4

export interface LeaderWork {
  stop: () => Promise<void>
}

export async function startLeaderWork(options: {
  config: Config
  db: Database
  boss: PgBoss
  storage: BotStorage
  metrics?: Metrics
  log: FastifyBaseLogger
}): Promise<LeaderWork> {
  const { config, db, boss, storage, metrics, log } = options
  const { store, discord } = storage
  const staging = new Staging(config.stagingDir)
  await boss.createQueue(QUEUES.blobUpload, BLOB_UPLOAD_QUEUE)
  // A queue made by an older version keeps its options unless they are updated.
  const { retryDelayMax: _fixed, ...changeable } = BLOB_UPLOAD_QUEUE
  await boss.updateQueue(QUEUES.blobUpload, changeable)

  if (config.blobStore === 'chaos') {
    log.warn('BLOB_STORE=chaos: storing blobs will fail now and then, on purpose')
  }
  const deps = { db, staging, store, log, metrics }
  await boss.work<
    BlobUploadJob,
    unknown,
    {
      batchSize: number
      burstWhenBatchFull: boolean
      localConcurrency: number
      perJobResults: true
    }
  >(
    QUEUES.blobUpload,
    {
      batchSize: UPLOAD_BATCH,
      burstWhenBatchFull: true,
      localConcurrency: UPLOAD_BATCHES,
      perJobResults: true,
    },
    async (jobs): Promise<JobResult[]> => {
      const failures = await storeBlobs(
        deps,
        jobs.map((job) => job.data.blobId),
        UPLOAD_BATCH,
      )
      if (failures.size > 0) metrics?.record('discord.post_failures', failures.size)
      return jobs.map((job) => {
        const error = failures.get(job.data.blobId)
        if (error === undefined) return { id: job.id, status: 'completed' }
        log.warn(
          { err: error, blobId: job.data.blobId },
          'storing a blob failed; it will be retried',
        )
        return { id: job.id, status: 'failed', output: { message: error.message } }
      })
    },
  )

  const packer = new Packer({
    db,
    staging,
    sizes: config.sizes,
    maxWaitMs: config.packMaxWaitMs,
    enqueue: async (tx, blobIds) => {
      const jobs = blobIds.map((blobId) => ({ data: { blobId } satisfies BlobUploadJob }))
      await boss.insert(QUEUES.blobUpload, jobs, { db: fromDrizzle(tx, sql) })
    },
    log,
  })

  // Admin → Storage: one task at a time, each once (ADMIN_TASK_QUEUE).
  await boss.createQueue(QUEUES.adminTask, ADMIN_TASK_QUEUE)
  await boss.updateQueue(QUEUES.adminTask, ADMIN_TASK_QUEUE)
  await boss.work<AdminTaskJob>(
    QUEUES.adminTask,
    { batchSize: 1, localConcurrency: 1 },
    async ([job]) => {
      if (!job) return null
      log.info({ task: job.data.kind, by: job.data.requestedBy }, 'running an admin task')
      const message = await runAdminTask(
        { config, db, boss, storage, staging, packer, log },
        job.data,
      )
      return { message }
    },
  )

  const loops = [
    repeat(PACK_EVERY_MS, log, 'packing small files', async () => {
      const sealed = await packer.sealDue()
      if (sealed > 0) metrics?.record('packs.sealed', sealed)
    }),
    // Uploads come first, but deleting never stops altogether.
    repeat(COLLECT_EVERY_MS, log, 'deleting released blobs', async () => {
      const limit = (await uploadsWaiting(db)) ? COLLECT_WHILE_UPLOADING : COLLECT_WHILE_IDLE
      const deleted = await collectGarbage({ db, store, staging, log }, limit)
      if (deleted > 0) metrics?.record('discord.deleted', deleted)
    }),
    repeat(FOLD_EVERY_MS, log, 'folding folder sizes', () => foldAllFolderStats(db)),
    repeat(JANITOR_EVERY_MS, log, 'cleaning up', () => cleanUp(db, staging)),
  ]
  // The leader alone samples them, so the figures aren't counted once per bot.
  if (metrics) {
    const postgres = new PostgresSampler()
    loops.push(
      repeat(SAMPLE_EVERY_MS, log, 'sampling the system', () => sampleSystem(db, metrics)),
      repeat(SAMPLE_EVERY_MS, log, 'sampling PostgreSQL', () => postgres.sample(db, metrics)),
    )
  }
  const { guildId, categoryName } = config.discord
  if (discord && guildId) {
    loops.push(
      repeat(RECONCILE_EVERY_MS, log, 'reconciling orphan messages', async () => {
        const report = await reconcileOrphans({
          db,
          rest: discord,
          instanceId: await instanceId(db),
          inCategory: await channelsInCategory(discord, guildId, categoryName),
          log,
        })
        if (report.deleted > 0) {
          metrics?.record('orphans.deleted', report.deleted)
          log.info(report, 'deleted orphan messages')
        }
      }),
    )
  }
  // Production only (DISCORD_GATEWAY, D25): one connection, the leader's.
  const gateway =
    discord && guildId && config.discord.gateway
      ? keepGateway({ config, db, rest: discord, log })
      : null
  return {
    stop: async () => {
      await Promise.all([...loops.map((loop) => loop.stop()), gateway?.stop()])
    },
  }
}

/**
 * Gives up uploads past their 24 hours, forgets ended sessions, removes
 * pack files a crash left before their pack was recorded, and drops metrics
 * past their keeping.
 */
export async function cleanUp(db: Database, staging: Staging, now = Date.now()): Promise<void> {
  await db.execute(
    sql`DELETE FROM upload_sessions WHERE expires_at <= now() AND state = 'completed'`,
  )
  await db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`)
  await pruneMetrics(db, now)
  const versions = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM upload_sessions
      WHERE expires_at <= now() AND state = 'receiving'
      LIMIT 500 FOR UPDATE SKIP LOCKED`)
    return abandonUploads(
      tx,
      rows.map((row) => row.id),
    )
  })
  for (const versionId of versions) await staging.removeVersion(versionId)

  const stale = (await staging.packFiles()).filter((file) => now - file.writtenAt > STRAY_PACK_MS)
  if (stale.length > 0) {
    const { rows } = await db.execute<{ staged_path: string }>(sql`
      SELECT staged_path FROM blobs
      WHERE staged_path = ANY(${textArray(stale.map((file) => file.path))})`)
    const recorded = new Set(rows.map((row) => row.staged_path))
    for (const file of stale) {
      if (!recorded.has(file.path)) await staging.remove(file.path)
    }
  }
}

/** Runs `work` now and then again `everyMs` after each run ends, so runs never overlap. */
function repeat(
  everyMs: number,
  log: FastifyBaseLogger,
  what: string,
  work: () => Promise<void>,
): { stop: () => Promise<void> } {
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> = Promise.resolve()
  let stopped = false
  const run = () => {
    running = work()
      .catch((error: unknown) => {
        log.warn({ err: error }, `${what} failed; trying again later`)
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(run, everyMs)
      })
  }
  run()
  return {
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
  }
}

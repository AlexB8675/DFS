import type { Config } from '@dfs/config'
import {
  abandonIdleUploads,
  abandonUploads,
  ADMIN_TASK_QUEUE,
  BLOB_UPLOAD_QUEUE,
  expireTrash,
  foldAllFolderStats,
  PostgresSampler,
  pruneJournal,
  pruneMetrics,
  purgeUnneededVersions,
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
import { Compactor, dropStalePacks } from './compactor.ts'
import { keepGateway } from './gateway.ts'
import { JournalUploader } from './journal-uploader.ts'
import { Packer } from './packer.ts'
import { reconcileOrphans } from './reconciler.ts'
import { instanceId, type BotStorage } from './storage.ts'
import { runAdminTask } from './tasks.ts'
import { storeBlobs } from './uploader.ts'

// What only the leading bot does (DESIGN.md §11): pack small frames and
// merge packs that hold little (§6.6), store staged blobs, delete released
// ones (§6.4), clean up orphan messages
// (§6.1), keep folder sizes current (§12.1), post the journal's batches to
// #dfs-journal (§8), clean up after expired uploads and sessions, empty the
// trash of what has been there too long (§6.4), delete earlier versions once
// no share link serves them (§7.5), and drop old metrics, audit entries and
// journal records already posted.

const FOLD_EVERY_MS = 2000
const JANITOR_EVERY_MS = 10 * 60_000
/**
 * An upload lives in its page, which says every minute that it is open
 * (§6.1): one quiet this long closed without cancelling, crashed or went
 * offline, and its half file goes from its folder.
 */
const IDLE_UPLOAD_MINUTES = 10
const IDLE_UPLOADS_EVERY_MS = 60_000
const PACK_EVERY_MS = 1000
/** One group of packs merged per run (§6.6): a minute after the last run ends. */
const COMPACT_EVERY_MS = 60_000
const COLLECT_EVERY_MS = 2000
/** Deletes per round while blobs wait to be stored, and while none do (§6.4). */
const COLLECT_WHILE_UPLOADING = 1
const COLLECT_WHILE_IDLE = 20
const RECONCILE_EVERY_MS = 60 * 60_000
/** The API seals a batch a minute or so: one is posted within seconds. */
const JOURNAL_EVERY_MS = 5000
/**
 * The system's figures, for the admin's graphs (§16): one sample in each
 * half-minute bucket, a little after it starts.
 */
const SAMPLE_EVERY_MS = 30_000
const SAMPLE_AT_MS = 2_000
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

  const compactor = new Compactor({
    db,
    store,
    rule: {
      threshold: config.compactThreshold,
      packTargetBytes: config.sizes.packTargetBytes,
      minAgeDays: config.compactMinAgeDays,
    },
    log,
    metrics,
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
        { config, db, boss, storage, staging, packer, compactor, log },
        job.data,
      )
      return { message }
    },
  )

  const journalUploader = new JournalUploader({ db, journal: storage.journal })
  const loops = [
    repeat(PACK_EVERY_MS, log, 'packing small files', async () => {
      const sealed = await packer.sealDue()
      if (sealed > 0) metrics?.record('packs.sealed', sealed)
    }),
    // Uploads come first: compaction waits for every blob to be stored.
    repeat(COMPACT_EVERY_MS, log, 'merging packs that hold little', async () => {
      if (!(await uploadsWaiting(db))) await compactor.compact()
    }),
    // Uploads come first, but deleting never stops altogether.
    repeat(COLLECT_EVERY_MS, log, 'deleting released blobs', async () => {
      const limit = (await uploadsWaiting(db)) ? COLLECT_WHILE_UPLOADING : COLLECT_WHILE_IDLE
      const deleted = await collectGarbage({ db, store, staging, log }, limit)
      if (deleted > 0) metrics?.record('discord.deleted', deleted)
    }),
    repeat(FOLD_EVERY_MS, log, 'folding folder sizes', () => foldAllFolderStats(db)),
    repeat(JOURNAL_EVERY_MS, log, 'posting journal batches', async () => {
      await journalUploader.run()
    }),
    repeat(JANITOR_EVERY_MS, log, 'cleaning up', () => cleanUp(db, staging)),
    repeat(JANITOR_EVERY_MS, log, 'dropping packs a crash left half made', async () => {
      await dropStalePacks(db, store)
    }),
    repeat(IDLE_UPLOADS_EVERY_MS, log, 'giving up uploads whose page is gone', async () => {
      await giveUpIdleUploads(db, staging)
    }),
    // On their own, so a failure in one never holds back the others.
    repeat(JANITOR_EVERY_MS, log, 'dropping old metrics', () => pruneMetrics(db)),
    repeat(JANITOR_EVERY_MS, log, 'dropping posted journal records', async () => {
      await pruneJournal(db)
    }),
    repeat(JANITOR_EVERY_MS, log, 'deleting versions no link serves', async () => {
      await dropUnneededVersions(db, staging)
    }),
    repeat(JANITOR_EVERY_MS, log, 'emptying old trash', async () => {
      const items = await emptyOldTrash(db, staging, config.trashRetentionDays)
      if (items > 0) log.info({ items }, 'emptied items kept their days in the trash')
    }),
  ]
  // The leader alone samples them, so the figures aren't counted once per bot.
  if (metrics) {
    const postgres = new PostgresSampler()
    loops.push(
      onTheClock(SAMPLE_EVERY_MS, SAMPLE_AT_MS, log, 'sampling the system', () =>
        sampleSystem(db, metrics),
      ),
      onTheClock(SAMPLE_EVERY_MS, SAMPLE_AT_MS, log, 'sampling PostgreSQL', () =>
        postgres.sample(db, metrics),
      ),
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
 * Gives up uploads past their 24 hours, forgets ended sessions and audit
 * entries older than a year, and removes pack files a crash left before their
 * pack was recorded.
 */
export async function cleanUp(db: Database, staging: Staging, now = Date.now()): Promise<void> {
  await db.execute(
    sql`DELETE FROM upload_sessions WHERE expires_at <= now() AND state = 'completed'`,
  )
  await db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`)
  await db.execute(sql`DELETE FROM audit_log WHERE at < now() - interval '1 year'`)
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

/** Gives up uploads whose page went quiet (§6.1), and removes their staged frames. */
export async function giveUpIdleUploads(db: Database, staging: Staging): Promise<void> {
  const versions = await abandonIdleUploads(db, IDLE_UPLOAD_MINUTES)
  for (const versionId of versions) await staging.removeVersion(versionId)
}

/**
 * Deletes earlier versions whose share links have all stopped working (§7.5),
 * and their staged frames.
 */
export async function dropUnneededVersions(db: Database, staging: Staging): Promise<void> {
  for (const versionId of await purgeUnneededVersions(db)) await staging.removeVersion(versionId)
}

/**
 * Purges what has been in the trash longer than `retentionDays` (§6.4), and
 * the staged frames of what it purged. Returns how many items went.
 */
export async function emptyOldTrash(
  db: Database,
  staging: Staging,
  retentionDays: number,
): Promise<number> {
  const { items, versionIds } = await expireTrash(db, retentionDays)
  for (const versionId of versionIds) await staging.removeVersion(versionId)
  return items
}

/**
 * Runs `work` `atMs` past each multiple of `everyMs` on the clock, so each
 * bucket of that size gets exactly one run, where `repeat` would drift and
 * now and then leave one empty. A run that overruns the next mark skips it;
 * runs never overlap.
 */
export function onTheClock(
  everyMs: number,
  atMs: number,
  log: Pick<FastifyBaseLogger, 'warn'>,
  what: string,
  work: () => Promise<void>,
): { stop: () => Promise<void> } {
  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> = Promise.resolve()
  let stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, everyMs - ((Date.now() - atMs) % everyMs))
  }
  const run = () => {
    running = work()
      .catch((error: unknown) => {
        log.warn({ err: error }, `${what} failed; trying again later`)
      })
      .finally(schedule)
  }
  schedule()
  return {
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
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

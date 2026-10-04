import type { Config } from '@dfs/config'
import {
  abandonUploads,
  BLOB_UPLOAD_QUEUE,
  foldAllFolderStats,
  QUEUES,
  type BlobUploadJob,
  type Database,
} from '@dfs/db'
import { LocalBlobStore, Staging } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { JobResult, PgBoss } from 'pg-boss'
import { storeBlobs } from './uploader.ts'

// What only the leading bot does (DESIGN.md §11): store staged blobs, keep
// folder sizes current (§12.1), and clean up after expired uploads and
// sessions (§6.1).

const FOLD_EVERY_MS = 2000
const JANITOR_EVERY_MS = 10 * 60_000

export interface LeaderWork {
  stop: () => Promise<void>
}

export async function startLeaderWork(options: {
  config: Config
  db: Database
  boss: PgBoss
  log: FastifyBaseLogger
}): Promise<LeaderWork> {
  const { config, db, boss, log } = options
  const staging = new Staging(config.stagingDir)
  await boss.createQueue(QUEUES.blobUpload, BLOB_UPLOAD_QUEUE)

  if (config.blobStore === 'local') {
    const deps = { db, staging, store: new LocalBlobStore(config.localBlobDir) }
    await boss.work<BlobUploadJob, unknown, { batchSize: number; perJobResults: true }>(
      QUEUES.blobUpload,
      { batchSize: 8, perJobResults: true },
      async (jobs): Promise<JobResult[]> => {
        const failures = await storeBlobs(
          deps,
          jobs.map((job) => job.data.blobId),
        )
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
  } else {
    log.warn('Discord storage arrives with M1: staged blobs wait until then')
  }

  const loops = [
    repeat(FOLD_EVERY_MS, log, 'folding folder sizes', () => foldAllFolderStats(db)),
    repeat(JANITOR_EVERY_MS, log, 'cleaning up', () => cleanUp(db, staging)),
  ]
  return {
    stop: async () => {
      await Promise.all(loops.map((loop) => loop.stop()))
    },
  }
}

/** Gives up uploads past their 24 hours, and forgets ended sessions. */
export async function cleanUp(db: Database, staging: Staging): Promise<void> {
  const versions = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM upload_sessions
      WHERE expires_at <= now() AND state = 'receiving'
      LIMIT 500 FOR UPDATE SKIP LOCKED`)
    const staged = await abandonUploads(
      tx,
      rows.map((row) => row.id),
    )
    await tx.execute(
      sql`DELETE FROM upload_sessions WHERE expires_at <= now() AND state = 'completed'`,
    )
    await tx.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`)
    return staged
  })
  for (const versionId of versions) await staging.removeVersion(versionId)
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

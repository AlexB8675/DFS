import {
  appendJournal,
  isMissingTable,
  LOCK_NAMESPACE,
  LOCKS,
  QUEUES,
  type AdminTaskJob,
} from '@dfs/db'
import {
  ADMIN_TASK_LABELS,
  adminTaskKindSchema,
  DISCORD_TASKS,
  type AdminTask,
  type AdminTaskRequest,
  type StorageStatus,
} from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { fromDrizzle } from 'pg-boss'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { botHealth } from './system.ts'

// Admin → Storage (DESIGN.md §9): what is stuck between staging and Discord,
// and the tasks an admin can have the leading bot run now.

/** `GET /admin/storage`. */
export async function storageStatus(app: FastifyInstance): Promise<StorageStatus> {
  const [uploads, deletions] = await Promise.all([
    failingUploads(app),
    app.db.execute<{
      blob_id: string
      channel: string | null
      attempts: number
      error: string | null
    }>(sql`
      SELECT blob.id::text AS blob_id, channel.name AS channel, blob.attempts,
        blob.last_error AS error
      FROM blobs blob LEFT JOIN storage_channels channel ON channel.id = blob.channel_id
      WHERE blob.state = 'deleting' AND blob.attempts > 0
      ORDER BY blob.attempts DESC, blob.id LIMIT 100`),
  ])
  return {
    blobStore: app.config.blobStore,
    uploads,
    deletions: deletions.rows.map((row) => ({
      blobId: row.blob_id,
      channelName: row.channel,
      attempts: row.attempts,
      error: row.error,
    })),
  }
}

/**
 * Uploads that failed: those retrying come from pg-boss's index of waiting
 * jobs. Those that gave up have no index, so they are read only when
 * pg-boss's counts say there are some.
 */
async function failingUploads(app: FastifyInstance): Promise<StorageStatus['uploads']> {
  try {
    const { rows: counts } = await app.db.execute<{ failed: number }>(sql`
      SELECT coalesce(sum(failed_count), 0)::int AS failed FROM pgboss.queue
      WHERE name = ${QUEUES.blobUpload}`)
    const states = (counts[0]?.failed ?? 0) > 0 ? sql`('retry', 'failed')` : sql`('retry')`
    const { rows } = await app.db.execute<{
      id: string
      state: 'retry' | 'failed'
      attempts: number
      max_attempts: number
      created_on: string
      error: string | null
      blob_id: string
      kind: 'solo' | 'pack' | null
      size_bytes: number | null
    }>(sql`
      SELECT job.id, job.state, job.retry_count AS attempts, job.retry_limit + 1 AS max_attempts,
        job.created_on::text AS created_on, job.output->>'message' AS error,
        job.data->>'blobId' AS blob_id, blob.kind, blob.size_bytes::float8 AS size_bytes
      FROM pgboss.job job
      LEFT JOIN blobs blob ON blob.id = (job.data->>'blobId')::bigint
      WHERE job.name = ${QUEUES.blobUpload} AND job.state IN ${states}
      ORDER BY job.created_on LIMIT 100`)
    return rows.map((row) => ({
      jobId: row.id,
      blobId: row.blob_id,
      kind: row.kind,
      sizeBytes: row.size_bytes,
      state: row.state === 'failed' ? 'failed' : 'retrying',
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      error: row.error,
      since: new Date(row.created_on).toISOString(),
    }))
  } catch (error) {
    // pg-boss's tables come with the bot's first start.
    if (isMissingTable(error)) return []
    throw error
  }
}

interface TaskRow extends Record<string, unknown> {
  id: string
  state: string
  data: AdminTaskJob
  output: { message?: unknown } | null
  created_on: string
  completed_on: string | null
}

/** `GET /admin/tasks`: the latest tasks, newest first. */
export async function listTasks(app: FastifyInstance): Promise<AdminTask[]> {
  const { rows } = await app.db.execute<TaskRow>(sql`
    SELECT id, state::text AS state, data, output, created_on::text AS created_on,
      completed_on::text AS completed_on
    FROM pgboss.job WHERE name = ${QUEUES.adminTask}
    ORDER BY created_on DESC LIMIT 20`)
  return rows.flatMap((row) => task(row) ?? [])
}

/** `GET /admin/tasks/:id`. */
export async function getTask(app: FastifyInstance, id: string): Promise<AdminTask> {
  const { rows } = await app.db.execute<TaskRow>(sql`
    SELECT id, state::text AS state, data, output, created_on::text AS created_on,
      completed_on::text AS completed_on
    FROM pgboss.job WHERE name = ${QUEUES.adminTask} AND id = ${id}`)
  const found = rows[0] && task(rows[0])
  // Dropped after waiting too long for a leader, or after its week of keeping.
  if (!found) throw new ApiError(404, 'not_found', 'No such task.')
  return found
}

/**
 * `POST /admin/tasks`: queues a task for the leading bot. Refused while no
 * bot leads with its queue running, so a task never runs long after it was
 * asked for, and while one of its kind waits or runs, so a second click
 * never creates a second channel.
 */
export async function startTask(
  app: FastifyInstance,
  admin: Auth,
  request: AdminTaskRequest,
): Promise<AdminTask> {
  if (DISCORD_TASKS.includes(request.kind) && app.config.blobStore !== 'discord') {
    throw new ApiError(
      409,
      'not_discord',
      'This needs Discord storage, and DFS stores blobs elsewhere here.',
    )
  }
  // Before taking the lock below: the bot may take its time to answer.
  const bot = await botHealth(app)
  if (bot.status !== 'ok') {
    throw new ApiError(
      503,
      'bot_unavailable',
      `The bot can’t take tasks now (${bot.detail}); try again once it leads.`,
    )
  }
  const data: AdminTaskJob = { kind: request.kind, requestedBy: admin.user.displayName }
  const boss = await app.queue.get()
  const id = await app.db.transaction(async (tx) => {
    // One request at a time looks for a task under way, then queues its own.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, ${LOCKS.adminTask})`)
    const { rows: underWay } = await tx.execute(sql`
      SELECT 1 FROM pgboss.job
      WHERE name = ${QUEUES.adminTask} AND state IN ('created', 'retry', 'active')
        AND data->>'kind' = ${request.kind}
      LIMIT 1`)
    if (underWay.length > 0) {
      throw new ApiError(
        409,
        'task_running',
        'That task is already waiting for the bot or running. One the bot never takes is dropped after 10 minutes; one cut short by a bot stopping, after 15.',
      )
    }
    const queued = await boss.send(QUEUES.adminTask, data, { db: fromDrizzle(tx, sql) })
    if (!queued) throw new Error('The job queue didn’t take the task.')
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: admin.user.id,
        action: 'task.started',
        target: ADMIN_TASK_LABELS[request.kind],
      }),
    )
    return queued
  })
  return getTask(app, id)
}

function task(row: TaskRow): AdminTask | null {
  const kind = adminTaskKindSchema.safeParse(row.data.kind)
  if (!kind.success) return null
  const message = typeof row.output?.message === 'string' ? row.output.message : null
  const state =
    row.state === 'active'
      ? 'running'
      : row.state === 'completed'
        ? 'done'
        : row.state === 'failed' || row.state === 'cancelled'
          ? 'failed'
          : 'pending'
  return {
    id: row.id,
    kind: kind.data,
    requestedBy: row.data.requestedBy,
    state,
    result: state === 'failed' ? (message ?? 'It failed without saying why.') : message,
    createdAt: new Date(row.created_on).toISOString(),
    finishedAt: row.completed_on ? new Date(row.completed_on).toISOString() : null,
  }
}

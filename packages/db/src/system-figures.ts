import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import type { Metrics } from './metrics.ts'
import { QUEUES } from './queues.ts'

// The state of the whole system in figures (DESIGN.md §16): the admin
// overview shows them as they are, and the leading bot samples them into the
// metrics once a minute. Every query reads an index or a small table, except
// the blob totals, one pass over `blobs` (a row per 10 MiB stored, or per pack).

export interface SystemFigures {
  /** Versions waiting to reach Discord, and their bytes. */
  syncFiles: number
  syncBytes: number
  stagedBytes: number
  /** Stored blobs, how many of them are packs, their bytes and how many of those are still used. */
  blobs: number
  packs: number
  storedBytes: number
  liveBytes: number
  /** Blobs waiting to be stored, waiting to be deleted, and lost. */
  waitingBlobs: number
  deletingBlobs: number
  lostBlobs: number
  /** Upload jobs waiting, how long the oldest has, and those that gave up. */
  pendingJobs: number
  oldestPendingSeconds: number
  failedJobs: number
  databaseBytes: number
  users: number
  files: number
  fileBytes: number
  sessions: number
}

export async function systemFigures(db: Database): Promise<SystemFigures> {
  const [figures, queue] = await Promise.all([
    db.execute<Omit<SystemFigures, 'pendingJobs' | 'oldestPendingSeconds' | 'failedJobs'>>(sql`
      SELECT
        (SELECT count(*)::float8 FROM file_versions WHERE state = 'syncing') AS "syncFiles",
        (SELECT coalesce(sum(size_bytes), 0)::float8 FROM file_versions WHERE state = 'syncing')
          AS "syncBytes",
        (SELECT coalesce(sum(frame_size), 0)::float8 FROM chunks WHERE staged_path IS NOT NULL)
          AS "stagedBytes",
        blob.*,
        pg_database_size(current_database())::float8 AS "databaseBytes",
        account.*,
        (SELECT coalesce(sum(stats.file_count), 0)::float8
          FROM users JOIN folder_stats stats ON stats.node_id = users.root_node_id) AS files,
        (SELECT count(*)::float8 FROM sessions WHERE expires_at > now()) AS sessions
      FROM (
        SELECT
          count(*) FILTER (WHERE state = 'stored')::float8 AS blobs,
          count(*) FILTER (WHERE state = 'stored' AND kind = 'pack')::float8 AS packs,
          coalesce(sum(size_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS "storedBytes",
          coalesce(sum(live_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS "liveBytes",
          count(*) FILTER (WHERE state IN ('staged', 'uploading'))::float8 AS "waitingBlobs",
          count(*) FILTER (WHERE state = 'deleting')::float8 AS "deletingBlobs",
          count(*) FILTER (WHERE state = 'lost')::float8 AS "lostBlobs"
        FROM blobs
      ) blob, (
        SELECT count(*)::float8 AS users, coalesce(sum(used_bytes), 0)::float8 AS "fileBytes"
        FROM users
      ) account`),
    queueFigures(db),
  ])
  const [row] = figures.rows
  if (!row) throw new Error('The system figures query returned nothing.')
  return { ...row, ...queue }
}

/**
 * pg-boss's own tables, which exist once a bot has started. Waiting jobs
 * come from its index of them; failed ones from the counts its monitor keeps
 * (refreshed every minute). Before the first start there are none; any other
 * error is a real one, such as a pg-boss upgrade that renamed a column.
 */
async function queueFigures(
  db: Database,
): Promise<Pick<SystemFigures, 'pendingJobs' | 'oldestPendingSeconds' | 'failedJobs'>> {
  try {
    const { rows } = await db.execute<{ pending: number; oldest: number; failed: number }>(sql`
      SELECT count(*)::float8 AS pending,
        coalesce(extract(epoch FROM now() - min(created_on)), 0)::float8 AS oldest,
        (SELECT coalesce(sum(failed_count), 0)::float8 FROM pgboss.queue
          WHERE name = ${QUEUES.blobUpload}) AS failed
      FROM pgboss.job
      WHERE name = ${QUEUES.blobUpload} AND state < 'active' AND NOT blocked`)
    const [row] = rows
    return {
      pendingJobs: row?.pending ?? 0,
      oldestPendingSeconds: Math.round(row?.oldest ?? 0),
      failedJobs: row?.failed ?? 0,
    }
  } catch (error) {
    if (!missingTable(error)) throw error
    return { pendingJobs: 0, oldestPendingSeconds: 0, failedJobs: 0 }
  }
}

/** `undefined_table` or `invalid_schema_name`, in the error or what drizzle wrapped. */
function missingTable(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown }
    if (code === '42P01' || code === '3F000') return true
  }
  return false
}

/** Samples the system's figures into the metrics; the leading bot does, once a minute. */
export async function sampleSystem(db: Database, metrics: Metrics): Promise<void> {
  const figures = await systemFigures(db)
  metrics.record('sync.files', figures.syncFiles)
  metrics.record('sync.bytes', figures.syncBytes)
  metrics.record('staging.bytes', figures.stagedBytes)
  metrics.record('storage.bytes', figures.storedBytes)
  metrics.record('storage.live_bytes', figures.liveBytes)
  metrics.record('storage.blobs', figures.blobs)
  metrics.record('storage.packs', figures.packs)
  metrics.record('blobs.waiting', figures.waitingBlobs)
  metrics.record('blobs.deleting', figures.deletingBlobs)
  metrics.record('blobs.lost', figures.lostBlobs)
  metrics.record('queue.pending', figures.pendingJobs)
  metrics.record('queue.failed', figures.failedJobs)
  metrics.record('db.bytes', figures.databaseBytes)
  metrics.record('users.count', figures.users)
  metrics.record('files.count', figures.files)
  metrics.record('files.bytes', figures.fileBytes)
  metrics.record('sessions.count', figures.sessions)
}

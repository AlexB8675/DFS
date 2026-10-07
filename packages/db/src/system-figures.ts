import { sql, type SQL } from 'drizzle-orm'
import type { Database } from './client.ts'
import { isMissingTable } from './errors.ts'
import type { Metrics } from './metrics.ts'
import { QUEUES } from './queues.ts'

// The state of the whole system in figures (DESIGN.md §16): the admin
// overview shows them as they are, and the leading bot samples them into the
// metrics once a minute. Every query reads an index or a small table, except
// the storage totals, one pass over `blobs` (a row per 10 MiB stored, or per
// pack), which the overview may take from a while ago.

/**
 * What staging holds, as one SQL expression: frames on their own, and sealed
 * packs waiting to be stored (a solo blob's file is its frame's). The upload
 * limit refuses uploads by it, and the admin pages show it.
 */
export function stagedBytesSql(): SQL {
  return sql`(
    (SELECT coalesce(sum(frame_size), 0) FROM chunks WHERE staged_path IS NOT NULL) +
    (SELECT coalesce(sum(size_bytes), 0) FROM blobs
      WHERE kind = 'pack' AND state IN ('staged', 'uploading') AND staged_path IS NOT NULL)
  )`
}

/** The pass over `blobs`: what is stored, and what waits to be stored or deleted. */
export interface StorageTotals {
  /** Stored blobs, how many of them are packs, their bytes and how many of those are still used. */
  blobs: number
  packs: number
  storedBytes: number
  liveBytes: number
  /** Blobs waiting to be stored, and waiting to be deleted. */
  waitingBlobs: number
  deletingBlobs: number
}

export interface SystemFigures extends StorageTotals {
  /** Versions waiting to reach Discord, and their bytes. */
  syncFiles: number
  syncBytes: number
  /** Frames and sealed packs in staging (`stagedBytesSql`). */
  stagedBytes: number
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

/**
 * The system's figures. `totals` gives the pass over `blobs`: by default made
 * now, or one from a while ago where the figures are read often.
 */
export async function systemFigures(
  db: Database,
  totals: () => Promise<StorageTotals> = () => storageTotals(db),
): Promise<SystemFigures> {
  const [figures, storage, queue] = await Promise.all([
    db.execute<
      Omit<
        SystemFigures,
        keyof StorageTotals | 'pendingJobs' | 'oldestPendingSeconds' | 'failedJobs'
      >
    >(sql`
      SELECT
        (SELECT count(*)::float8 FROM file_versions WHERE state = 'syncing') AS "syncFiles",
        (SELECT coalesce(sum(size_bytes), 0)::float8 FROM file_versions WHERE state = 'syncing')
          AS "syncBytes",
        ${stagedBytesSql()}::float8 AS "stagedBytes",
        pg_database_size(current_database())::float8 AS "databaseBytes",
        account.*,
        (SELECT coalesce(sum(stats.file_count), 0)::float8
          FROM users JOIN folder_stats stats ON stats.node_id = users.root_node_id) AS files,
        (SELECT count(*)::float8 FROM sessions WHERE expires_at > now()) AS sessions
      FROM (
        SELECT count(*)::float8 AS users, coalesce(sum(used_bytes), 0)::float8 AS "fileBytes"
        FROM users
      ) account`),
    totals(),
    queueFigures(db),
  ])
  const [row] = figures.rows
  if (!row) throw new Error('The system figures query returned nothing.')
  return { ...row, ...storage, ...queue }
}

/** One pass over `blobs`. */
export async function storageTotals(db: Database): Promise<StorageTotals> {
  const { rows } = await db.execute<Pick<StorageTotals, keyof StorageTotals>>(sql`
    SELECT
      count(*) FILTER (WHERE state = 'stored')::float8 AS blobs,
      count(*) FILTER (WHERE state = 'stored' AND kind = 'pack')::float8 AS packs,
      coalesce(sum(size_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS "storedBytes",
      coalesce(sum(live_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS "liveBytes",
      count(*) FILTER (WHERE state IN ('staged', 'uploading'))::float8 AS "waitingBlobs",
      count(*) FILTER (WHERE state = 'deleting')::float8 AS "deletingBlobs"
    FROM blobs`)
  const [row] = rows
  if (!row) throw new Error('The storage totals query returned nothing.')
  return row
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
    if (!isMissingTable(error)) throw error
    return { pendingJobs: 0, oldestPendingSeconds: 0, failedJobs: 0 }
  }
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
  metrics.record('queue.pending', figures.pendingJobs)
  metrics.record('queue.failed', figures.failedJobs)
  metrics.record('db.bytes', figures.databaseBytes)
  metrics.record('users.count', figures.users)
  metrics.record('files.count', figures.files)
  metrics.record('files.bytes', figures.fileBytes)
  metrics.record('sessions.count', figures.sessions)
}

import { sql } from 'drizzle-orm'
import type { Database } from './client.ts'
import type { Metrics } from './metrics.ts'

// PostgreSQL's own statistics for the admin's graphs (DESIGN.md §16), sampled
// by the leading bot once a minute. Levels (connections, lock waits, the
// longest transaction, dead rows) are recorded as they are; the server's
// running totals (commits, blocks read, rows, WAL…) as what they grew by since
// the last sample, so they read as rates and add up over any range.

interface Sample extends Record<string, unknown> {
  connections: number
  active: number
  lock_waits: number
  oldest_xact_ms: number
  dead_rows: number
  commits: number
  rollbacks: number
  deadlocks: number
  cache_hits: number
  disk_reads: number
  rows_read: number
  rows_written: number
  temp_bytes: number
  wal_bytes: number
}

const TOTALS = [
  ['commits', 'pg.commits'],
  ['rollbacks', 'pg.rollbacks'],
  ['deadlocks', 'pg.deadlocks'],
  ['cache_hits', 'pg.cache_hits'],
  ['disk_reads', 'pg.disk_reads'],
  ['rows_read', 'pg.rows_read'],
  ['rows_written', 'pg.rows_written'],
  ['temp_bytes', 'pg.temp_bytes'],
  ['wal_bytes', 'pg.wal_bytes'],
] as const

export class PostgresSampler {
  /** The totals at the last sample: the first sample only sets them. */
  #last: Sample | null = null

  async sample(db: Database, metrics: Metrics): Promise<void> {
    const { rows } = await db.execute<Sample>(sql`
      SELECT
        activity.*,
        d.xact_commit::float8 AS commits,
        d.xact_rollback::float8 AS rollbacks,
        d.deadlocks::float8 AS deadlocks,
        d.blks_hit::float8 AS cache_hits,
        d.blks_read::float8 AS disk_reads,
        (d.tup_returned + d.tup_fetched)::float8 AS rows_read,
        (d.tup_inserted + d.tup_updated + d.tup_deleted)::float8 AS rows_written,
        d.temp_bytes::float8 AS temp_bytes,
        (SELECT wal_bytes::float8 FROM pg_stat_wal) AS wal_bytes,
        (SELECT coalesce(sum(n_dead_tup), 0)::float8 FROM pg_stat_user_tables) AS dead_rows
      FROM pg_stat_database d, (
        SELECT
          count(*)::float8 AS connections,
          count(*) FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::float8 AS active,
          count(*) FILTER (WHERE wait_event_type = 'Lock')::float8 AS lock_waits,
          coalesce(max(extract(epoch FROM now() - xact_start))
            FILTER (WHERE pid <> pg_backend_pid()), 0)::float8 * 1000 AS oldest_xact_ms
        FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
      ) activity
      WHERE d.datname = current_database()`)
    const now = rows[0]
    if (!now) return
    metrics.record('pg.connections', now.connections)
    metrics.record('pg.active', now.active)
    metrics.record('pg.lock_waits', now.lock_waits)
    metrics.record('pg.oldest_xact_ms', now.oldest_xact_ms)
    metrics.record('pg.dead_rows', now.dead_rows)

    const last = this.#last
    this.#last = now
    if (!last) return
    // A total that went down was reset (a restart, or pg_stat_reset): start over.
    if (TOTALS.some(([column]) => now[column] < last[column])) return
    for (const [column, name] of TOTALS) {
      const grown = now[column] - last[column]
      if (grown > 0) metrics.record(name, grown)
    }
  }
}

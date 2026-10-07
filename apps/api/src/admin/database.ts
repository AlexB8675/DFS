import { hasErrorCode } from '@dfs/db'
import type { DatabaseStatus } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { auditAlone } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'

// Admin → Database (DESIGN.md §16): PostgreSQL as it is now, from its own
// statistics views, and the two things an admin may do about a stuck query.
// Only this database's connections are shown, with their SQL as sent: DFS
// sends values apart from its SQL, so its queries show placeholders; what
// someone types in psql, and schema changes, show as typed.

/** How much of each query to show. */
const QUERY_CHARS = 400
/** Settings worth knowing when tuning. */
const SETTINGS = [
  'max_connections',
  'shared_buffers',
  'effective_cache_size',
  'work_mem',
  'maintenance_work_mem',
  'max_wal_size',
  'checkpoint_timeout',
  'random_page_cost',
  'autovacuum',
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'shared_preload_libraries',
]

export async function databaseStatus(app: FastifyInstance): Promise<DatabaseStatus> {
  const { db } = app
  // First, so the queries below, running side by side, aren't among what runs.
  const sessions = await db.execute<{
    pid: number
    application: string
    state: string
    wait_type: string | null
    wait_event: string | null
    query_seconds: number
    transaction_seconds: number | null
    query: string
    blocked_by: number[]
  }>(sql`
        SELECT pid, coalesce(nullif(application_name, ''), 'unnamed') AS application,
          coalesce(state, 'unknown') AS state, wait_event_type AS wait_type, wait_event,
          greatest(extract(epoch FROM now() - coalesce(query_start, backend_start)), 0)::float8
            AS query_seconds,
          greatest(extract(epoch FROM now() - xact_start), 0)::float8 AS transaction_seconds,
          left(coalesce(query, ''), ${QUERY_CHARS}) AS query,
          pg_blocking_pids(pid) AS blocked_by
        FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
          AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
          -- Quick queries come and go; these are the ones worth a look.
          AND (state <> 'active' OR wait_event_type = 'Lock'
            OR query_start < now() - interval '250 milliseconds')
        ORDER BY xact_start NULLS LAST, query_start LIMIT 25`)
  const [overview, applications, tables, unused, settings, statements] = await Promise.all([
    db.execute<{
      version: string
      started_at: string
      size: number
      stats_since: string | null
      used: number
      max: number
      commits: number
      rollbacks: number
      deadlocks: number
      hits: number
      reads: number
      temp_bytes: number
    }>(sql`
        SELECT
          split_part(version(), ' on ', 1) AS version,
          pg_postmaster_start_time()::text AS started_at,
          pg_database_size(current_database())::float8 AS size,
          d.stats_reset::text AS stats_since,
          (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend')
            AS used,
          current_setting('max_connections')::int AS max,
          d.xact_commit::float8 AS commits, d.xact_rollback::float8 AS rollbacks,
          d.deadlocks::float8 AS deadlocks, d.blks_hit::float8 AS hits,
          d.blks_read::float8 AS reads, d.temp_bytes::float8 AS temp_bytes
        FROM pg_stat_database d WHERE d.datname = current_database()`),
    db.execute<{
      application: string
      total: number
      active: number
      idle: number
      idle_in_transaction: number
    }>(sql`
        SELECT coalesce(nullif(application_name, ''), 'unnamed') AS application,
          count(*)::int AS total,
          count(*) FILTER (WHERE state = 'active')::int AS active,
          count(*) FILTER (WHERE state = 'idle')::int AS idle,
          count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_transaction
        FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend'
        GROUP BY 1 ORDER BY 2 DESC, 1`),
    db.execute<{
      name: string
      total: number
      table_bytes: number
      index_bytes: number
      rows: number
      dead_rows: number
      vacuumed: string | null
      analyzed: string | null
      seq_scans: number
      index_scans: number
    }>(sql`
        SELECT
          CASE WHEN schemaname = 'public' THEN relname ELSE schemaname || '.' || relname END
            AS name,
          pg_total_relation_size(relid)::float8 AS total,
          pg_relation_size(relid)::float8 AS table_bytes,
          pg_indexes_size(relid)::float8 AS index_bytes,
          n_live_tup::float8 AS rows, n_dead_tup::float8 AS dead_rows,
          greatest(last_vacuum, last_autovacuum)::text AS vacuumed,
          greatest(last_analyze, last_autoanalyze)::text AS analyzed,
          coalesce(seq_scan, 0)::float8 AS seq_scans, coalesce(idx_scan, 0)::float8 AS index_scans
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC LIMIT 25`),
    db.execute<{ table: string; name: string; bytes: number }>(sql`
        SELECT stat.relname AS table, stat.indexrelname AS name,
          pg_relation_size(stat.indexrelid)::float8 AS bytes
        FROM pg_stat_user_indexes stat JOIN pg_index ix ON ix.indexrelid = stat.indexrelid
        WHERE stat.schemaname = 'public' AND stat.idx_scan = 0
          AND NOT ix.indisunique AND NOT ix.indisprimary
        ORDER BY bytes DESC, name LIMIT 25`),
    db.execute<{ name: string; value: string }>(sql`
        SELECT name, current_setting(name) AS value
        FROM unnest(${`{${SETTINGS.join(',')}}`}::text[]) AS name`),
    slowestStatements(app),
  ])

  const row = overview.rows[0]
  if (!row) throw new Error('pg_stat_database has no row for this database.')
  const reads = row.hits + row.reads
  return {
    checkedAt: new Date().toISOString(),
    version: row.version,
    startedAt: new Date(row.started_at).toISOString(),
    sizeBytes: row.size,
    statsSince: row.stats_since ? new Date(row.stats_since).toISOString() : null,
    connections: {
      used: row.used,
      max: row.max,
      byApplication: applications.rows.map((entry) => ({
        application: entry.application,
        total: entry.total,
        active: entry.active,
        idle: entry.idle,
        idleInTransaction: entry.idle_in_transaction,
      })),
    },
    cacheHitRatio: reads > 0 ? row.hits / reads : null,
    commits: row.commits,
    rollbacks: row.rollbacks,
    deadlocks: row.deadlocks,
    tempBytes: row.temp_bytes,
    sessions: sessions.rows.map((session) => ({
      pid: session.pid,
      application: session.application,
      state: session.state,
      waitingFor:
        session.wait_type && session.state === 'active'
          ? `${session.wait_type}: ${session.wait_event ?? ''}`
          : null,
      querySeconds: session.query_seconds,
      transactionSeconds: session.transaction_seconds,
      query: session.query,
      blockedBy: session.blocked_by,
    })),
    tables: tables.rows.map((table) => ({
      name: table.name,
      totalBytes: table.total,
      tableBytes: table.table_bytes,
      indexBytes: table.index_bytes,
      rows: table.rows,
      deadRows: table.dead_rows,
      lastVacuumAt: table.vacuumed ? new Date(table.vacuumed).toISOString() : null,
      lastAnalyzeAt: table.analyzed ? new Date(table.analyzed).toISOString() : null,
      seqScans: table.seq_scans,
      indexScans: table.index_scans,
    })),
    unusedIndexes: unused.rows,
    statements,
    settings: settings.rows,
  }
}

/**
 * The statements that took the most time in total, normalized by
 * pg_stat_statements (constants become placeholders). Explains how to turn
 * it on where it isn't.
 */
async function slowestStatements(app: FastifyInstance): Promise<DatabaseStatus['statements']> {
  try {
    const { rows } = await app.db.execute<{
      query: string
      calls: number
      total_ms: number
      mean_ms: number
      rows: number
    }>(sql`
      SELECT left(query, ${QUERY_CHARS}) AS query, calls::float8 AS calls,
        total_exec_time::float8 AS total_ms, mean_exec_time::float8 AS mean_ms,
        rows::float8 AS rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        -- The admin pages' own look at the statistics isn't the system's work.
        AND position('pg_stat' in query) = 0
      ORDER BY total_exec_time DESC LIMIT 15`)
    return {
      unavailable: null,
      items: rows.map((row) => ({
        query: row.query,
        calls: row.calls,
        totalMs: row.total_ms,
        meanMs: row.mean_ms,
        rows: row.rows,
      })),
    }
  } catch (error) {
    // The extension isn't created (42P01), or the library isn't loaded (55000).
    if (hasErrorCode(error, '42P01')) {
      return {
        unavailable:
          'The pg_stat_statements extension isn’t installed: a superuser can run CREATE EXTENSION pg_stat_statements; in this database.',
        items: [],
      }
    }
    if (hasErrorCode(error, '55000')) {
      return {
        unavailable:
          'Start PostgreSQL with shared_preload_libraries = pg_stat_statements to keep statement statistics.',
        items: [],
      }
    }
    throw error
  }
}

/**
 * `POST /admin/database/tables/:name/vacuum`: vacuums and analyzes one of
 * the tables the page lists, by the name it shows there. Vacuum doesn't
 * block reading or writing it; on a large table it takes a while.
 */
export async function vacuumTable(app: FastifyInstance, admin: Auth, name: string): Promise<void> {
  const { rows } = await app.db.execute<{ schema: string; table: string }>(sql`
    SELECT schemaname AS schema, relname AS table FROM pg_stat_user_tables
    WHERE CASE WHEN schemaname = 'public' THEN relname ELSE schemaname || '.' || relname END
      = ${name}`)
  const [found] = rows
  if (!found) throw new ApiError(404, 'not_found', 'No such table.')
  // Names from the catalog, quoted as identifiers: never text from the request.
  await app.db.execute(
    sql`VACUUM (ANALYZE) ${sql.identifier(found.schema)}.${sql.identifier(found.table)}`,
  )
  await auditAlone(app.db, { actorId: admin.user.id, action: 'database.vacuumed', target: name })
}

/**
 * Cancels a connection's query, or ends the connection: only this database's
 * client connections, never the one asking. Audited. A connection idle in a
 * transaction has no query to cancel, and PostgreSQL would ignore the
 * signal; only ending it closes the transaction.
 */
export async function signalSession(
  app: FastifyInstance,
  admin: Auth,
  pid: number,
  how: 'cancel' | 'terminate',
): Promise<void> {
  const { rows } = await app.db.execute<{ application: string; state: string | null }>(sql`
    SELECT coalesce(nullif(application_name, ''), 'unnamed') AS application, state
    FROM pg_stat_activity
    WHERE pid = ${pid} AND datname = current_database() AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()`)
  const [target] = rows
  if (!target) throw new ApiError(404, 'not_found', 'No such database connection.')
  if (how === 'cancel' && target.state !== 'active') {
    throw new ApiError(
      409,
      'not_running',
      'That connection isn’t running a query; end the connection to close its transaction.',
    )
  }
  const signal =
    how === 'cancel' ? sql`pg_cancel_backend(${pid})` : sql`pg_terminate_backend(${pid})`
  const { rows: signalled } = await app.db.execute<{ done: boolean }>(sql`SELECT ${signal} AS done`)
  // It ended between the two looks.
  if (!signalled[0]?.done) throw new ApiError(404, 'not_found', 'No such database connection.')
  await auditAlone(app.db, {
    actorId: admin.user.id,
    action: how === 'cancel' ? 'database.query_cancelled' : 'database.session_ended',
    target: `${target.application} (${String(pid)})`,
  })
}

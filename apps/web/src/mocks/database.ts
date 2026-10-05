import type { DatabaseSession, DatabaseStatus } from '@dfs/shared'

// Made-up PostgreSQL figures for the mock API (§16): a few connections at
// work, one of them stuck behind another's lock, and the tables DFS has.

const MB = 1024 ** 2
const GB = 1024 ** 3
const STARTED = Date.now() - 3 * 86_400_000

const SESSIONS: DatabaseSession[] = [
  {
    pid: 4211,
    application: 'dfs-bot',
    state: 'idle in transaction',
    waitingFor: null,
    querySeconds: 412,
    transactionSeconds: 415,
    query: 'UPDATE blobs SET state = $1, stored_at = now() WHERE id = $2',
    blockedBy: [],
  },
  {
    pid: 4388,
    application: 'dfs-api',
    state: 'active',
    waitingFor: 'Lock: transactionid',
    querySeconds: 37,
    transactionSeconds: 37,
    query: 'UPDATE file_versions SET state = $1 WHERE id = ANY($2::uuid[])',
    blockedBy: [4211],
  },
  {
    pid: 4402,
    application: 'dfs-api',
    state: 'active',
    waitingFor: null,
    querySeconds: 0.4,
    transactionSeconds: 0.4,
    query:
      'SELECT node.id, node.name, node.kind, node.size_bytes FROM nodes node WHERE node.parent_id = $1 AND node.deleted_at IS NULL ORDER BY node.kind, node.name_key, node.id LIMIT $2',
    blockedBy: [],
  },
]

const TABLES: [string, number, number][] = [
  ['chunks', 1_840_000, 0.42],
  ['nodes', 612_000, 0.35],
  ['file_versions', 598_000, 0.12],
  ['metrics', 214_000, 0.03],
  ['journal', 182_000, 0.08],
  ['blobs', 21_400, 0.01],
  ['folder_stats', 48_000, 0.04],
  ['audit_log', 9_100, 0.01],
  ['sessions', 37, 0.001],
  ['users', 6, 0.0001],
]

export function mockDatabaseStatus(ended: ReadonlySet<number>): DatabaseStatus {
  const sessions = SESSIONS.filter((session) => !ended.has(session.pid)).map((session) => ({
    ...session,
    // Nothing is blocked once what blocked it is gone.
    blockedBy: session.blockedBy.filter((pid) => !ended.has(pid)),
    waitingFor: session.blockedBy.some((pid) => !ended.has(pid)) ? session.waitingFor : null,
  }))
  const totalBytes = TABLES.reduce((sum, [, , share]) => sum + share, 0)
  return {
    checkedAt: new Date().toISOString(),
    version: 'PostgreSQL 18.6',
    startedAt: new Date(STARTED).toISOString(),
    sizeBytes: Math.round(2.3 * GB),
    statsSince: new Date(STARTED).toISOString(),
    connections: {
      used: 14,
      max: 100,
      byApplication: [
        { application: 'dfs-api', total: 8, active: 2, idle: 6, idleInTransaction: 0 },
        { application: 'dfs-bot', total: 4, active: 0, idle: 3, idleInTransaction: 1 },
        { application: 'dfs-bot-queue', total: 2, active: 0, idle: 2, idleInTransaction: 0 },
      ],
    },
    cacheHitRatio: 0.9962,
    commits: 18_420_311,
    rollbacks: 2_114,
    deadlocks: 0,
    tempBytes: 312 * MB,
    sessions,
    tables: TABLES.map(([name, rows, share], index) => {
      const bytes = Math.round((share / totalBytes) * 2.2 * GB)
      return {
        name,
        totalBytes: bytes,
        tableBytes: Math.round(bytes * 0.6),
        indexBytes: Math.round(bytes * 0.4),
        rows,
        deadRows: Math.round(rows * (index % 3 === 0 ? 0.08 : 0.01)),
        lastVacuumAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
        lastAnalyzeAt: new Date(Date.now() - (index + 1) * 1_800_000).toISOString(),
        seqScans: index * 12,
        indexScans: rows * 40,
      }
    }),
    unusedIndexes: [{ table: 'nodes', name: 'nodes_listing_by_size', bytes: 24 * MB }],
    statements: {
      unavailable: null,
      items: [
        {
          query: 'SELECT node.id, node.name FROM nodes node WHERE node.parent_id = $1 LIMIT $2',
          calls: 412_330,
          totalMs: 1_840_220,
          meanMs: 4.46,
          rows: 9_812_004,
        },
        {
          query: 'INSERT INTO chunks (version_id, idx, frame_size) VALUES ($1, $2, $3)',
          calls: 1_204_118,
          totalMs: 902_114,
          meanMs: 0.75,
          rows: 1_204_118,
        },
        {
          query: 'UPDATE blobs SET state = $1, stored_at = now() WHERE id = $2',
          calls: 21_400,
          totalMs: 61_220,
          meanMs: 2.86,
          rows: 21_400,
        },
      ],
    },
    settings: [
      { name: 'max_connections', value: '100' },
      { name: 'shared_buffers', value: '128MB' },
      { name: 'effective_cache_size', value: '4GB' },
      { name: 'work_mem', value: '4MB' },
      { name: 'maintenance_work_mem', value: '64MB' },
      { name: 'max_wal_size', value: '1GB' },
      { name: 'checkpoint_timeout', value: '5min' },
      { name: 'random_page_cost', value: '4' },
      { name: 'autovacuum', value: 'on' },
      { name: 'statement_timeout', value: '0' },
      { name: 'idle_in_transaction_session_timeout', value: '0' },
      { name: 'shared_preload_libraries', value: 'pg_stat_statements' },
    ],
  }
}

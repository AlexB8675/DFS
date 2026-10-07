import type { Executor } from '@dfs/db'
import { sql, type SQL } from 'drizzle-orm'

// The recovery drill's diff (DESIGN.md §8, §17): a database rebuilt from the
// journal against the one it was journaled from, table by table and column
// by column. Every column counts unless it is listed below with why it can't;
// a table this doesn't know fails the comparison, so whatever is added next
// gets a decision rather than slipping past the drill.

interface TableSpec {
  table: string
  /** Its rows' order, which is how they are matched. */
  key: string[]
  /** Columns recovery doesn't bring back, each for its reason. */
  exclude: string[]
  /** Values to compare in place of excluded ones, such as a channel by its Discord ID. */
  extra?: SQL
  /** Rows that aren't compared, on either side. */
  where?: SQL
}

const CHANNEL = sql`(SELECT discord_channel_id FROM storage_channels WHERE id = t.channel_id) AS channel`

const TABLES: readonly TableSpec[] = [
  // Its ID is all there is; when it was made, the new database made it.
  { table: 'instance', key: ['id'], exclude: ['created_at'] },
  // Sign-in counters and the last visit are transient (§8); reservations
  // belong to uploads in progress, which recovery doesn't bring back.
  {
    table: 'users',
    key: ['id'],
    exclude: ['failed_sign_ins', 'sign_in_locked_until', 'last_seen_at', 'reserved_bytes'],
  },
  { table: 'nodes', key: ['id'], exclude: [] },
  { table: 'file_versions', key: ['id'], exclude: [] },
  // A chunk's row ID is new; it is matched by its version and place.
  { table: 'chunks', key: ['version_id', 'idx'], exclude: ['id'] },
  // Signed links expire and are signed again; tries, errors, checks and
  // losses are the bot's at the time; the channel is matched by Discord ID;
  // recovery knows when a blob was stored, not when it was staged.
  {
    table: 'blobs',
    key: ['id'],
    exclude: [
      'channel_id',
      'cdn_url',
      'cdn_url_expires_at',
      'attempts',
      'last_error',
      'created_at',
      'last_verified_at',
      'lost_at',
    ],
    extra: CHANNEL,
    // A deleted blob is a tombstone: one released before it was ever stored
    // was never journaled, so it is only compared while it holds something.
    where: sql`t.state <> 'deleted'`,
  },
  // Registered again from Discord: new IDs; whether one takes new blobs and
  // how far the reconciler got aren't journaled.
  {
    table: 'storage_channels',
    key: ['discord_channel_id'],
    exclude: ['id', 'enabled', 'reconciled_through', 'created_at'],
  },
  // Download counts are usage, like used bytes, and start afresh (§8).
  { table: 'share_links', key: ['id'], exclude: ['download_count'] },
  { table: 'audit_log', key: ['id'], exclude: [] },
  // As read back from Discord: posted, with nothing left to post.
  {
    table: 'journal_batches',
    key: ['batch_no'],
    exclude: ['sealed', 'channel_id', 'attempts', 'last_error', 'created_at', 'stored_at'],
    extra: CHANNEL,
  },
  // Folded again from the tree.
  { table: 'folder_stats', key: ['node_id'], exclude: ['updated_at'] },
]

/** Tables recovery leaves empty: sessions, uploads in progress, tickets, graphs, the outbox. */
const NOT_RECOVERED = new Set([
  'sessions',
  'upload_sessions',
  'archive_tickets',
  'metrics',
  'journal',
  'folder_stats_dirty',
])

export interface Difference {
  table: string
  /** The row, by its key. */
  key: string
  /** The column that differs, or `row` when one side lacks the row. */
  column: string
  source: unknown
  recovered: unknown
}

/** Every difference between the database and the one recovered from its journal, up to `limit`. */
export async function compareDatabases(
  source: Executor,
  recovered: Executor,
  limit = 200,
): Promise<Difference[]> {
  const differences: Difference[] = []
  const { rows: tables } = await source.execute<{ name: string }>(sql`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
      AND tablename <> '__drizzle_migrations' ORDER BY tablename`)
  const known = new Set(TABLES.map((spec) => spec.table))
  for (const { name } of tables) {
    if (!known.has(name) && !NOT_RECOVERED.has(name)) {
      differences.push({
        table: name,
        key: '*',
        column: 'table',
        source: 'a table the drill doesn’t know',
        recovered: 'decide whether recovery covers it (apps/api/src/recover/compare.ts)',
      })
    }
  }

  for (const spec of TABLES) {
    const { rows: columns } = await source.execute<{ name: string; type: string }>(sql`
      SELECT column_name AS name, data_type AS type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${spec.table} ORDER BY ordinal_position`)
    // Times to the millisecond: a record made from a row in JavaScript keeps no more.
    const compared = columns
      .filter((column) => !spec.exclude.includes(column.name))
      .map((column) =>
        column.type.startsWith('timestamp')
          ? sql`date_trunc('milliseconds', t.${sql.identifier(column.name)}) AS ${sql.identifier(column.name)}`
          : sql`t.${sql.identifier(column.name)}`,
      )
    const query = sql`
      SELECT ${sql.join([...compared, ...(spec.extra ? [spec.extra] : [])], sql`, `)}
      FROM ${sql.identifier(spec.table)} t
      ${spec.where ? sql`WHERE ${spec.where}` : sql``}
      ORDER BY ${sql.join(
        spec.key.map((name) => sql`t.${sql.identifier(name)}`),
        sql`, `,
      )}`
    const [left, right] = await Promise.all([source.execute(query), recovered.execute(query)])
    const keyOf = (row: Record<string, unknown>) =>
      spec.key.map((name) => String(normalize(row[name]))).join('/')
    const rightByKey = new Map(right.rows.map((row) => [keyOf(row), row]))
    const leftKeys = new Set<string>()
    for (const row of left.rows) {
      const key = keyOf(row)
      leftKeys.add(key)
      const other = rightByKey.get(key)
      if (!other) {
        differences.push({
          table: spec.table,
          key,
          column: 'row',
          source: 'present',
          recovered: 'missing',
        })
        continue
      }
      for (const name of Object.keys(row)) {
        const a = normalize(row[name])
        const b = normalize(other[name])
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          differences.push({ table: spec.table, key, column: name, source: a, recovered: b })
        }
      }
    }
    for (const row of right.rows) {
      const key = keyOf(row)
      if (!leftKeys.has(key)) {
        differences.push({
          table: spec.table,
          key,
          column: 'row',
          source: 'missing',
          recovered: 'present',
        })
      }
    }
    if (differences.length >= limit) break
  }
  return differences.slice(0, limit)
}

/** A value as both sides can agree on it: times to the millisecond, bytes as hex. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  return value
}

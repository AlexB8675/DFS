import { foldAllFolderStats, type Database, type Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import { trashedVia, type FoldedState, type VersionState } from './fold.ts'
import type { CategoryChannel } from './journal-source.ts'
import { RecoveryError, type ReadBatch } from './read-journal.ts'

// Writing the recovered state into an empty database (DESIGN.md §8), in one
// transaction: what the journal holds, under the IDs it had, and then what
// is derived from it. Rows go through `jsonb_populate_recordset`, so each
// field lands in its column as PostgreSQL reads it, and a column the
// journal carries tomorrow needs nothing here.

type Row = Record<string, unknown>

const ROWS_PER_STATEMENT = 1000

export interface WriteInput {
  state: FoldedState
  instanceId: string
  batches: readonly ReadBatch[]
  /** The category's channels, which blobs and batches name by their Discord IDs. */
  channels: readonly CategoryChannel[]
  /**
   * The highest blob ID in use where the blobs are: a blob posted but never
   * journaled must not have its ID taken by a new one.
   */
  blobIdFloor: number
}

/** Refuses a database that holds anything: recovery never writes over one in use. */
export async function assertEmpty(db: Executor): Promise<void> {
  const { rows } = await db.execute<{ count: number }>(sql`
    SELECT ((SELECT count(*) FROM users) + (SELECT count(*) FROM nodes))::int AS count`)
  if ((rows[0]?.count ?? 0) > 0) {
    throw new RecoveryError(
      'The database to recover into isn’t empty. Recovery only writes into a new, migrated database.',
    )
  }
}

/** Writes the state, then recomputes what is derived: usage, trash marks, live bytes, folder sizes. */
export async function writeRecovered(db: Database, input: WriteInput): Promise<void> {
  const { state } = input
  await db.transaction(async (tx) => {
    await assertEmpty(tx)
    // This database's name for itself: the one its messages carry (§4).
    await tx.execute(sql`UPDATE instance SET id = ${input.instanceId}`)

    const channelIds = new Map<string, string>()
    if (input.channels.length > 0) {
      const { rows } = await tx.execute<{ id: string; discord_channel_id: string }>(sql`
        INSERT INTO storage_channels (discord_channel_id, name, kind)
        SELECT discord_channel_id, name, kind::channel_kind
        FROM jsonb_to_recordset(${JSON.stringify(
          input.channels.map((channel) => ({
            discord_channel_id: channel.discordChannelId,
            name: channel.name,
            kind: channel.kind,
          })),
        )}::jsonb) AS r(discord_channel_id text, name text, kind text)
        RETURNING id, discord_channel_id`)
      for (const row of rows) channelIds.set(row.discord_channel_id, row.id)
    }

    await insert(
      tx,
      'users',
      [...state.users.values()].map(({ rootNodeId: _root, ...user }) => snake(user)),
    )

    // Parents before children; files point at their versions once those exist.
    const depth = (node: Row): number => {
      let count = 0
      for (let parentId = node.parentId as string | null; parentId; count += 1) {
        parentId = (state.nodes.get(parentId)?.parentId as string | null | undefined) ?? null
      }
      return count
    }
    const nodes = [...state.nodes.values()].toSorted((a, b) => depth(a) - depth(b))
    await insert(
      tx,
      'nodes',
      nodes.map(({ currentVersionId: _current, ...node }) =>
        snake({ ...node, trashedVia: trashedVia(state, node) }),
      ),
    )
    await insert(
      tx,
      'file_versions',
      [...state.versions.values()].map((version) => ({
        ...olderVersionFields(state, version),
        id: version.id,
        node_id: version.nodeId,
        version_no: version.versionNo,
        state: 'stored',
        size_bytes: version.sizeBytes,
        chunk_size: version.chunkSize,
        chunk_count: version.chunkCount,
        chunks_stored: version.chunkCount,
        content_hash: hex(version.contentHash),
        wrapped_dek: hex(Buffer.from(version.wrappedDek as string, 'base64').toString('hex')),
        key_id: version.keyId,
        modified_at: version.modifiedAt ?? null,
      })),
    )
    await tx.execute(sql`
      UPDATE nodes SET current_version_id = r.version_id
      FROM jsonb_to_recordset(${JSON.stringify(
        nodes
          .filter((node) => node.currentVersionId)
          .map((node) => ({ id: node.id, version_id: node.currentVersionId })),
      )}::jsonb) AS r(id uuid, version_id uuid)
      WHERE nodes.id = r.id`)
    await tx.execute(sql`
      UPDATE users SET root_node_id = r.root_node_id
      FROM jsonb_to_recordset(${JSON.stringify(
        [...state.users.values()]
          .filter((user) => user.rootNodeId)
          .map((user) => ({ id: user.id, root_node_id: user.rootNodeId })),
      )}::jsonb) AS r(id uuid, root_node_id uuid)
      WHERE users.id = r.id`)

    const framesIn = new Map<number, number>()
    for (const version of state.versions.values()) {
      for (const chunk of version.chunks ?? []) {
        framesIn.set(chunk.blobId, (framesIn.get(chunk.blobId) ?? 0) + 1)
      }
    }
    await insert(
      tx,
      'blobs',
      [...state.blobs.values()].map((blob) => ({
        id: blob.id,
        kind: blob.kind,
        state: blob.deleted ? 'deleted' : 'stored',
        size_bytes: blob.sizeBytes,
        // Older records don't say: a solo blob holds one frame, a pack at
        // least those still pointing at it.
        frame_count: blob.frameCount ?? (blob.kind === 'solo' ? 1 : (framesIn.get(blob.id) ?? 0)),
        sha256: hex(blob.sha256),
        channel_id: blob.discordChannelId
          ? (channelIds.get(blob.discordChannelId as string) ?? null)
          : null,
        message_id: blob.messageId ?? null,
        attachment_id: blob.attachmentId ?? null,
        created_at: blob.storedAt,
        stored_at: blob.storedAt,
      })),
      { overriding: true },
    )
    await insert(
      tx,
      'chunks',
      [...state.versions.values()].flatMap((version) =>
        (version.chunks ?? []).map((chunk) => ({
          version_id: version.id,
          idx: chunk.idx,
          plain_size: chunk.plainSize,
          frame_size: chunk.frameSize,
          plain_sha256: hex(chunk.plainSha256),
          frame_sha256: hex(chunk.frameSha256),
          // A blob the journal never saw: the version can't be read, and is marked lost.
          blob_id: state.blobs.has(chunk.blobId) ? chunk.blobId : null,
          blob_offset: state.blobs.has(chunk.blobId) ? chunk.offset : null,
        })),
      ),
    )
    await insert(
      tx,
      'share_links',
      [...state.shares.values()].map(({ tokenHash, ...share }) =>
        snake({ ...share, tokenHash: hex(tokenHash) }),
      ),
    )
    await insert(
      tx,
      'audit_log',
      [...state.audit.values()].map((entry) => snake(entry)),
      { overriding: true },
    )
    await insert(
      tx,
      'journal_batches',
      input.batches.map((batch) => ({
        batch_no: batch.batchNo,
        first_id: batch.firstId,
        last_id: batch.lastId,
        record_count: batch.recordCount,
        state: 'stored',
        size_bytes: batch.sizeBytes,
        sha256: hex(batch.sha256.toString('hex')),
        channel_id: batch.message ? (channelIds.get(batch.message.discordChannelId) ?? null) : null,
        message_id: batch.message?.messageId ?? null,
        attachment_id: batch.message?.attachmentId ?? null,
        stored_at: new Date().toISOString(),
      })),
    )

    // New IDs continue after those the journal and Discord used.
    await restartIdentity(tx, 'blobs', highest(state.blobs.keys(), input.blobIdFloor))
    await restartIdentity(tx, 'audit_log', highest(state.audit.keys(), 0))
    await restartIdentity(tx, 'journal', state.lastRecordId)

    // What is derived, as the API and the bot keep it.
    await tx.execute(sql`
      UPDATE blobs SET live_bytes = coalesce((
          SELECT sum(chunk.frame_size) FROM chunks chunk
          WHERE chunk.blob_id = blobs.id AND chunk.purged_at IS NULL), 0)`)
    // Nothing live left: the garbage collector deletes its message.
    await tx.execute(sql`
      UPDATE blobs SET state = 'deleting' WHERE state = 'stored' AND live_bytes = 0`)
    await tx.execute(sql`
      UPDATE file_versions SET state = 'lost'
      WHERE id IN (
        SELECT chunk.version_id FROM chunks chunk
        LEFT JOIN blobs blob ON blob.id = chunk.blob_id
        WHERE blob.id IS NULL OR blob.state = 'deleted')`)
    await tx.execute(sql`
      UPDATE users SET used_bytes = coalesce((
        SELECT sum(version.size_bytes) FROM file_versions version
        JOIN nodes node ON node.id = version.node_id
        WHERE node.owner_id = users.id
          AND version.state IN ('syncing', 'stored', 'failed', 'lost')), 0)`)
    await tx.execute(sql`
      INSERT INTO folder_stats_dirty (node_id) SELECT id FROM nodes WHERE kind = 'folder'`)
  })
  await foldAllFolderStats(db)
}

/**
 * Who made a version and when: in its record since `createdBy` and
 * `createdAt` were journaled; before, the file's owner, who makes every
 * version, and for a first version its file's creation, which was in the
 * same transaction. A later version's creation is known no better than
 * when it was journaled as stored.
 */
function olderVersionFields(state: FoldedState, version: VersionState): Row {
  const node = state.nodes.get(version.nodeId)
  return {
    created_by: version.createdBy ?? node?.ownerId ?? null,
    created_at:
      version.createdAt ?? (version.versionNo === 1 && node ? node.createdAt : version.journaledAt),
  }
}

/** Inserts rows in statements of `ROWS_PER_STATEMENT`, keeping identity values with `overriding`. */
async function insert(
  tx: Executor,
  table: string,
  rows: readonly Row[],
  { overriding = false } = {},
): Promise<void> {
  if (rows.length === 0) return
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const list = sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `,
  )
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + ROWS_PER_STATEMENT)
    await tx.execute(sql`
      INSERT INTO ${sql.identifier(table)} (${list})
      ${overriding ? sql`OVERRIDING SYSTEM VALUE` : sql``}
      SELECT ${list} FROM jsonb_populate_recordset(NULL::${sql.identifier(table)}, ${JSON.stringify(chunk)}::jsonb)`)
  }
}

async function restartIdentity(tx: Executor, table: string, highest: number): Promise<void> {
  if (highest < 1) return
  await tx.execute(sql`
    SELECT setval(pg_get_serial_sequence(${table}, 'id'), ${highest})`)
}

function highest(values: Iterable<number>, floor: number): number {
  let top = floor
  for (const value of values) if (value > top) top = value
  return top
}

/** A record's camelCase fields as columns. */
function snake(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  )
}

/** Hex as PostgreSQL reads a `bytea`. */
function hex(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? `\\x${value}` : null
}

import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  appendJournal,
  auditRecords,
  nodeRecords,
  shareRecords,
  userRecord,
  type Database,
} from '@dfs/db'
import { auditLog, nodes, shareLinks, users } from '@dfs/db'
import { channelExists, deleteChannel, type DiscordRest } from '@dfs/storage'
import { asc, inArray, sql } from 'drizzle-orm'
import { setUpDiscord } from './discord-setup.ts'

// `dfs reset-storage` (docs/DEPLOY.md): every file goes, with its blobs,
// their Discord channels and the journal, while accounts, folders, links to
// folders and the audit log stay. The journal starts again from them, so
// `dfs recover` rebuilds what is left. Run with the API and the bot stopped;
// running it again finishes what a failed run left.

export interface ResetOptions {
  /** The instance ID the operator typed: this database's, or nothing happens. */
  instance: string
  /** Discord, when blobs are stored there: its channels are deleted and made again. */
  discord: { rest: DiscordRest; guildId: string; categoryName: string } | null
  /** Emptied: staged frames, cached ones, and blobs and journal batches of a local store. */
  directories: string[]
  /** Connections whose names say the API or the bot is running; a test leaves out its own. */
  services?: string[]
}

export interface ResetReport {
  files: number
  versions: number
  blobs: number
  journalRecords: number
  channels: { deleted: string[]; gone: string[] }
  /** What the fresh journal holds. */
  baseline: { users: number; folders: number; shares: number; auditEntries: number }
  setup: { changes: string[]; registered: string[] }
}

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResetRefusedError'
  }
}

/** What `dfs reset-storage` would delete: counts to show before deleting. */
export async function storageCounts(
  db: Database,
): Promise<{ files: number; versions: number; blobs: number; journalRecords: number }> {
  const { rows } = await db.execute<{
    files: number
    versions: number
    blobs: number
    journal_records: number
  }>(sql`
    SELECT (SELECT count(*) FROM nodes WHERE kind = 'file')::int AS files,
      (SELECT count(*) FROM file_versions)::int AS versions,
      (SELECT count(*) FROM blobs)::int AS blobs,
      (SELECT count(*) FROM journal)::int AS journal_records`)
  const [row] = rows
  return {
    files: row?.files ?? 0,
    versions: row?.versions ?? 0,
    blobs: row?.blobs ?? 0,
    journalRecords: row?.journal_records ?? 0,
  }
}

export async function resetStorage(db: Database, options: ResetOptions): Promise<ResetReport> {
  await refuseUnlessQuiet(db, options.instance, options.services ?? ['dfs-api', 'dfs-bot'])
  const counts = await storageCounts(db)

  // Discord first: a journal channel left standing would hold an old batch 1
  // beside the new one, and recovery stops on two batches with one number.
  const registered = await db.execute<{ discord_channel_id: string; name: string }>(sql`
    SELECT discord_channel_id, name FROM storage_channels ORDER BY name`)
  const channels = { deleted: [] as string[], gone: [] as string[] }
  if (options.discord) {
    const { rest } = options.discord
    for (const channel of registered.rows) {
      const deleted = await deleteChannel(rest, channel.discord_channel_id)
      ;(deleted ? channels.deleted : channels.gone).push(channel.name)
    }
    for (const channel of registered.rows) {
      if (await channelExists(rest, channel.discord_channel_id)) {
        throw new ResetRefusedError(
          `#${channel.name} is still on Discord, so nothing in the database was changed. Delete it, or run this again.`,
        )
      }
    }
  }

  const baseline = await db.transaction(async (tx) => {
    // Links to files serve versions that go; links to folders stay.
    await tx.execute(sql`
      DELETE FROM share_links WHERE node_id IN (SELECT id FROM nodes WHERE kind = 'file')`)
    await tx.execute(sql`DELETE FROM upload_sessions`)
    await tx.execute(sql`DELETE FROM archive_tickets`)
    await tx.execute(sql`UPDATE nodes SET current_version_id = NULL WHERE kind = 'file'`)
    await tx.execute(sql`DELETE FROM chunks`)
    await tx.execute(sql`DELETE FROM file_versions`)
    await tx.execute(sql`DELETE FROM nodes WHERE kind = 'file'`)
    await tx.execute(sql`DELETE FROM blobs`)
    await tx.execute(sql`DELETE FROM journal`)
    await tx.execute(sql`DELETE FROM journal_batches`)
    await tx.execute(sql`DELETE FROM storage_channels`)
    // Derived from files, of which there are none now.
    await tx.execute(sql`UPDATE users SET used_bytes = 0, reserved_bytes = 0`)
    await tx.execute(
      sql`UPDATE folder_stats SET file_count = 0, total_bytes = 0, updated_at = now()`,
    )
    await tx.execute(sql`DELETE FROM folder_stats_dirty`)
    await tx.insert(auditLog).values({
      userId: null,
      action: 'storage.reset',
      meta: {
        target: 'Storage',
        details: `dfs reset-storage: ${String(counts.files)} files, ${String(counts.blobs)} blobs, ${String(counts.journalRecords)} journal records`,
      },
    })

    // The journal starts again from what is left, in the order the API
    // writes it: each user, then folders parents first, then links, then
    // the audit log as it was written.
    const people = await tx.select().from(users).orderBy(asc(users.createdAt))
    const depths = await tx.execute<{ id: string }>(sql`
      WITH RECURSIVE tree (id, depth) AS (
        SELECT id, 0 FROM nodes WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, tree.depth + 1 FROM nodes child JOIN tree ON child.parent_id = tree.id
      )
      SELECT id FROM tree ORDER BY depth, id`)
    const order = depths.rows.map((row) => row.id)
    const folders =
      order.length === 0 ? [] : await tx.select().from(nodes).where(inArray(nodes.id, order))
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    const sortedFolders = order.flatMap((id) => {
      const folder = byId.get(id)
      return folder ? [folder] : []
    })
    const links = await tx.select().from(shareLinks).orderBy(asc(shareLinks.createdAt))
    const entries = await tx.select().from(auditLog).orderBy(asc(auditLog.id))
    await appendJournal(tx, [
      ...people.map((person) => userRecord(person)),
      ...nodeRecords(sortedFolders),
      ...shareRecords(links),
      ...auditRecords(entries),
    ])
    return {
      users: people.length,
      folders: sortedFolders.length,
      shares: links.length,
      auditEntries: entries.length,
    }
  })

  for (const directory of options.directories) await empty(directory)

  const setup = options.discord
    ? await setUpDiscord(db, options.discord.rest, options.discord)
    : { changes: [], registered: [] }

  return { ...counts, channels, baseline, setup }
}

/** Refuses a wrong instance, or a database the API or the bot is using. */
async function refuseUnlessQuiet(
  db: Database,
  instance: string,
  services: readonly string[],
): Promise<void> {
  const { rows } = await db.execute<{ id: string; busy: string | null }>(sql`
    SELECT (SELECT id FROM instance) AS id,
      (SELECT string_agg(DISTINCT application_name, ', ') FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = ANY(${`{${services.join(',')}}`}::text[])) AS busy`)
  const [row] = rows
  if (row?.id !== instance) {
    throw new ResetRefusedError(
      `This database is instance ${row?.id ?? '(none)'}, not ${instance}: nothing was changed.`,
    )
  }
  if (row.busy) {
    throw new ResetRefusedError(
      `${row.busy} ${row.busy.includes(',') ? 'are' : 'is'} using this database: stop them first. Nothing was changed.`,
    )
  }
}

/** Removes what is in a directory, keeping the directory. One that isn't there is empty. */
async function empty(directory: string): Promise<void> {
  const entries = await readdir(directory).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    await rm(path.join(directory, entry), { recursive: true, force: true })
  }
}

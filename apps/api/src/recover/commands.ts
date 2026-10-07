import { randomBytes } from 'node:crypto'
import type { Config } from '@dfs/config'
import { MasterKeys } from '@dfs/crypto'
import { createDatabase, createPool, runMigrations } from '@dfs/db'
import { createDiscordRest } from '@dfs/storage'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { compareDatabases } from './compare.ts'
import {
  categoryChannels,
  DiscordJournalSource,
  LocalJournalSource,
  type CategoryChannel,
  type JournalSource,
} from './journal-source.ts'
import { highestLocalBlob, highestPostedBlob, recover, type RecoveryReport } from './recover.ts'

// `dfs recover` and `dfs drill` (DESIGN.md §8, §17). Both only read the
// journal and the blobs, from Discord or the local blob store.

export interface RecoveryOptions {
  /** Where the journal is: Discord, or the folder beside the local blob store. */
  from: 'discord' | 'local'
  instanceId?: string
  /** Every master key, current and retired. */
  keyFile: string
}

interface Opened {
  source: JournalSource
  channels: readonly CategoryChannel[]
  blobIdFloor: (instanceId: string) => Promise<number>
}

function openSource(config: Config, from: RecoveryOptions['from']): Promise<Opened> | Opened {
  if (from === 'local') {
    return {
      source: new LocalJournalSource(config.localBlobDir),
      channels: [],
      blobIdFloor: () => highestLocalBlob(config.localBlobDir),
    }
  }
  const { botToken, guildId, categoryName } = config.discord
  if (!botToken || !guildId) {
    throw new Error(
      'Reading the journal from Discord needs DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.',
    )
  }
  const rest = createDiscordRest(botToken)
  return categoryChannels(rest, guildId, categoryName).then((channels) => ({
    source: new DiscordJournalSource({ rest, channels }),
    channels,
    blobIdFloor: (instanceId: string) => highestPostedBlob(rest, channels, instanceId),
  }))
}

/** `dfs recover`: fills the database at `into`, which must be new or empty, from the journal. */
export async function recoverCommand(
  config: Config,
  options: RecoveryOptions & { into: string },
): Promise<RecoveryReport> {
  const keys = await MasterKeys.fromFile(options.keyFile)
  const opened = await openSource(config, options.from)
  await runMigrations(options.into)
  const pool = createPool(options.into, {
    applicationName: 'dfs-recover',
    onError: () => undefined,
  })
  try {
    return await recover({
      db: createDatabase(pool),
      keys,
      instanceId: options.instanceId,
      ...opened,
    })
  } finally {
    await pool.end()
  }
}

/**
 * `dfs drill`: recovers into a database of its own on the same server, says
 * how it differs from the one in use, and drops it. True when they match.
 */
export async function drillCommand(config: Config, options: RecoveryOptions): Promise<boolean> {
  const name = `dfs_drill_${randomBytes(6).toString('hex')}`
  const into = new URL(config.databaseUrl)
  into.pathname = `/${name}`
  await admin(config.databaseUrl, `CREATE DATABASE ${name}`)
  try {
    const report = await recoverCommand(config, { ...options, into: into.href })
    printReport(report)
    const live = createPool(config.databaseUrl, {
      applicationName: 'dfs-drill',
      onError: () => undefined,
    })
    const rebuilt = createPool(into.href, {
      applicationName: 'dfs-drill',
      onError: () => undefined,
    })
    try {
      // What the journal on Discord can't have yet shows up as differences too.
      const { rows } = await createDatabase(live).execute<{
        unflushed: number
        staged: number
      }>(sql`
        SELECT (SELECT count(*) FROM journal WHERE batch_no IS NULL)::int AS unflushed,
          (SELECT count(*) FROM journal_batches WHERE state = 'staged')::int AS staged`)
      const waiting = rows[0]
      if (waiting && (waiting.unflushed > 0 || waiting.staged > 0)) {
        console.info(
          `[WARN] Not on Discord yet: ${String(waiting.unflushed)} journal record(s) not sealed, ${String(waiting.staged)} batch(es) not posted.`,
        )
      }
      const differences = await compareDatabases(createDatabase(live), createDatabase(rebuilt))
      for (const difference of differences) {
        console.info(
          `[DIFF] ${difference.table} ${difference.key} ${difference.column}: ${JSON.stringify(difference.source)} → ${JSON.stringify(difference.recovered)}`,
        )
      }
      console.info(
        differences.length === 0
          ? '[INFO] The rebuilt database matches the one in use.'
          : `[WARN] ${String(differences.length)} difference(s). Changes made while the drill ran, or not yet posted to the journal, show up here too.`,
      )
      return differences.length === 0
    } finally {
      await live.end()
      await rebuilt.end()
    }
  } finally {
    await admin(config.databaseUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  }
}

export function printReport(report: RecoveryReport): void {
  const { counts, settled } = report
  console.info(`[INFO] Recovered database ${report.instanceId} from ${report.source}:`)
  console.info(
    `  ${String(report.batches)} batches, ${String(report.records)} records${
      report.duplicates.length > 0
        ? `, ${String(report.duplicates.length)} posted twice and read once`
        : ''
    }`,
  )
  console.info(
    `  ${String(counts.users)} users, ${String(counts.nodes)} items, ${String(counts.versions)} versions, ${String(counts.blobs)} blobs, ${String(counts.shares)} share links, ${String(counts.auditEntries)} audit entries`,
  )
  for (const file of settled.droppedFiles) {
    console.info(`[WARN] Dropped “${file.name}” (${file.id}): its upload never reached Discord.`)
  }
  for (const file of settled.rolledBack) {
    console.info(
      `[WARN] “${file.name}” (${file.id}) is back at version ${String(file.versionNo)}: its newest never reached Discord.`,
    )
  }
  if (settled.unreadableVersions.length > 0) {
    console.info(
      `[WARN] ${String(settled.unreadableVersions.length)} version(s) dropped: a blob they need isn't in the journal.`,
    )
  }
  if (settled.orphans.length > 0) {
    console.info(`[WARN] ${String(settled.orphans.length)} item(s) dropped: their folder is gone.`)
  }
}

async function admin(databaseUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'dfs-drill' })
  await client.connect()
  try {
    await client.query(statement)
  } finally {
    await client.end()
  }
}

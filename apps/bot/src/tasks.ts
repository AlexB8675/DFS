import type { Config } from '@dfs/config'
import { QUEUES, registerStorageChannels, type AdminTaskJob, type Database } from '@dfs/db'
import { adminTaskRequestSchema, DISCORD_TASKS } from '@dfs/shared'
import {
  channelsInCategory,
  createDataChannel,
  discordProblem,
  type DiscordRestClient,
  type Staging,
} from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { retryFailedDeletions } from './collector.ts'
import { capitalized, setUpDiscord } from './discord-setup.ts'
import type { Packer } from './packer.ts'
import { reconcileOrphans } from './reconciler.ts'
import { recoverBlob } from './recover.ts'
import { instanceId, type BotStorage } from './storage.ts'

// What an admin can have the leading bot do now (Admin → Storage, DESIGN.md
// §9): the API queues it as an `admin.task` job, and the leader runs it, one
// at a time, and keeps what it did as the job's result.

export interface TaskDeps {
  config: Config
  db: Database
  boss: PgBoss
  storage: BotStorage
  staging: Staging
  packer: Packer
  log: FastifyBaseLogger
}

/** Runs one task; returns what it did in a sentence, or throws saying why it couldn't. */
export async function runAdminTask(deps: TaskDeps, job: AdminTaskJob): Promise<string> {
  const { config, db, boss, storage, staging, packer, log } = deps
  // A task from a newer API than this bot fails here, not halfway.
  const task = adminTaskRequestSchema.parse(job)
  const discord = DISCORD_TASKS.includes(task.kind) ? discordOf(config, storage.discord) : null
  try {
    switch (task.kind) {
      case 'channel.create': {
        if (!discord) break
        const channel = await createDataChannel(discord.rest, discord.guildId, discord.categoryName)
        await registerStorageChannels(db, [channel], `Admin → Storage, by ${job.requestedBy}`)
        return `Created #${channel.name}; it takes new blobs within a minute.`
      }
      case 'discord.setup': {
        if (!discord) break
        const done = await setUpDiscord(
          db,
          discord.rest,
          discord,
          `Admin → Storage, by ${job.requestedBy}`,
        )
        return `${done.map(capitalized).join('; ')}.`
      }
      case 'packs.seal': {
        const sealed = await packer.sealDue({ force: true })
        return sealed === 0
          ? 'Nothing was waiting to be packed.'
          : `Sealed ${String(sealed)} ${sealed === 1 ? 'pack' : 'packs'}; ${sealed === 1 ? 'it goes' : 'they go'} to Discord next.`
      }
      case 'orphans.reconcile': {
        if (!discord) break
        const report = await reconcileOrphans({
          db,
          rest: discord.rest,
          instanceId: await instanceId(db),
          inCategory: await channelsInCategory(discord.rest, discord.guildId, discord.categoryName),
          log,
        })
        const failed =
          report.failed > 0 ? ` ${String(report.failed)} channels couldn’t be read.` : ''
        return `Checked ${String(report.checked)} messages and deleted ${String(report.deleted)} orphans.${failed}`
      }
      case 'uploads.retry': {
        const { rows } = await db.execute<{ id: string }>(sql`
          SELECT id FROM pgboss.job
          WHERE name = ${QUEUES.blobUpload} AND state = 'failed' LIMIT 1000`)
        if (rows.length === 0) return 'No upload had given up.'
        await boss.retry(
          QUEUES.blobUpload,
          rows.map((row) => row.id),
        )
        // pg-boss gives each one more try, now (not a new round of backoff).
        return `Gave ${String(rows.length)} ${rows.length === 1 ? 'upload' : 'uploads'} one more try, now. The failed count catches up within a minute.`
      }
      case 'deletions.retry': {
        const { deleted, failures } = await retryFailedDeletions({
          db,
          store: storage.store,
          staging,
          log,
        })
        if (deleted === 0 && failures.length === 0) return 'No deletion was failing.'
        const still =
          failures.length > 0
            ? ` ${String(failures.length)} still ${failures.length === 1 ? 'fails' : 'fail'}: ${failures[0] ?? ''}`
            : ''
        return `Deleted ${String(deleted)} ${deleted === 1 ? 'blob' : 'blobs'}.${still}`
      }
      case 'blob.recover':
        return await recoverBlob({ db, store: storage.store }, Number(task.blobId))
    }
  } catch (error) {
    // Discord's refusals in plain words; anything else as it is.
    const problem = discordProblem(error)
    if (problem) throw new Error(problem, { cause: error })
    throw error
  }
  throw new Error('This needs Discord storage, and this bot stores blobs elsewhere.')
}

function discordOf(
  config: Config,
  rest: DiscordRestClient | null,
): { rest: DiscordRestClient; guildId: string; categoryName: string } | null {
  const { guildId, categoryName } = config.discord
  return rest && guildId ? { rest, guildId, categoryName } : null
}

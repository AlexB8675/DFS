import { bigintArray, type Database } from '@dfs/db'
import {
  botUserId,
  deleteMessage,
  messagesAfter,
  parseBlobMessage,
  snowflakeTime,
  type DiscordRest,
} from '@dfs/storage'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

// Orphan messages (DESIGN.md §6.1): a post whose answer was lost and that was
// posted again after Discord's nonce window, or one whose blob was recorded
// elsewhere. The reconciler reads each registered data channel from where it
// last stopped and deletes this database's data messages that no blob
// records. Messages of other databases (another `i=`), of anyone but the bot,
// and anything younger than an hour, which an upload may still be recording,
// are left alone.

/** An upload records its message within seconds; an hour leaves a wide margin. */
const GRACE_MS = 60 * 60_000
const PAGE = 100

export interface ReconcileReport {
  /** Data messages of this database looked at. */
  checked: number
  /** Of those, the orphans deleted. */
  deleted: number
  /** Channels it couldn't read or clean this time; the next run starts where each stopped. */
  failed: number
}

export async function reconcileOrphans(options: {
  db: Database
  rest: DiscordRest
  instanceId: string
  /** The channels inside this environment's category; registered ones outside it aren't read (D25). */
  inCategory?: ReadonlySet<string>
  log?: Pick<FastifyBaseLogger, 'warn'>
  now?: number
}): Promise<ReconcileReport> {
  const { db, rest, instanceId, inCategory, log, now = Date.now() } = options
  const bot = await botUserId(rest)
  const { rows: channels } = await db.execute<{
    id: string
    discord_channel_id: string
    reconciled_through: string | null
  }>(sql`
    SELECT id, discord_channel_id, reconciled_through FROM storage_channels
    WHERE kind = 'data' ORDER BY id`)
  const report: ReconcileReport = { checked: 0, deleted: 0, failed: 0 }

  for (const channel of channels) {
    if (inCategory && !inCategory.has(channel.discord_channel_id)) continue
    // A channel gone or out of reach mustn't keep the others from being cleaned.
    try {
      await reconcileChannel(db, rest, { ...channel, bot, instanceId, now }, report)
    } catch (error) {
      report.failed += 1
      log?.warn(
        { err: error, discordChannelId: channel.discord_channel_id },
        'could not reconcile a channel',
      )
    }
  }
  return report
}

async function reconcileChannel(
  db: Database,
  rest: DiscordRest,
  channel: {
    id: string
    discord_channel_id: string
    reconciled_through: string | null
    bot: string
    instanceId: string
    now: number
  },
  report: ReconcileReport,
): Promise<void> {
  const { bot, instanceId, now } = channel
  let after = channel.reconciled_through ?? '0'
  for (;;) {
    const page = await messagesAfter(rest, channel.discord_channel_id, after, PAGE)
    const settled = page.filter((message) => now - snowflakeTime(message.id) >= GRACE_MS)
    const ours = settled.flatMap((message) => {
      const blob = message.author.id === bot ? parseBlobMessage(message.content) : null
      return blob?.instanceId === instanceId ? [{ message, blobId: blob.blobId }] : []
    })
    if (ours.length > 0) {
      const ids = bigintArray(ours.map((entry) => entry.blobId))
      const { rows: recorded } = await db.execute<{ id: number; message_id: string | null }>(sql`
        SELECT id::float8 AS id, message_id FROM blobs
        WHERE id = ANY(${ids}) AND state <> 'deleted'`)
      const messageOf = new Map(recorded.map((blob) => [blob.id, blob.message_id]))
      for (const { message, blobId } of ours) {
        report.checked += 1
        if (messageOf.get(blobId) === message.id) continue
        await deleteMessage(rest, channel.discord_channel_id, message.id)
        report.deleted += 1
      }
    }
    const last = settled.at(-1)
    if (last) {
      after = last.id
      await db.execute(sql`
        UPDATE storage_channels SET reconciled_through = ${after} WHERE id = ${channel.id}`)
    }
    // A short page is the end of the channel; a young message, the end of what is settled.
    if (page.length < PAGE || settled.length < page.length) break
  }
}

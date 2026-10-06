import { bigintArray, notifySynced, textArray, uuidArray, type Database } from '@dfs/db'
import type { DiscordRest } from '@dfs/storage'
import { Routes } from 'discord-api-types/v10'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

// Messages deleted in Discord by someone else (DESIGN.md §6.5). The gateway
// reports every deletion in the server; those of a stored blob in one of this
// environment's channels make the blob `lost`, and with it every file version
// that had a frame in it. The bot's own deletions never count: the GC deletes
// blobs already `deleting`, and the reconciler and the uploader delete
// messages no blob records.

export interface LostReport {
  /** The registered channel's name. */
  channel: string
  blobs: number
  files: number
}

export async function markLost(
  db: Database,
  discordChannelId: string,
  messageIds: readonly string[],
): Promise<LostReport | null> {
  if (messageIds.length === 0) return null
  return db.transaction(async (tx) => {
    // Blob rows first, then their versions in ID order, as storing does.
    const { rows: blobs } = await tx.execute<{ id: number; channel: string }>(sql`
      -- The last signed link stays: if the CDN still has the attachment, it is
      -- only through a link that read it before the message went.
      UPDATE blobs SET state = 'lost', lost_at = now()
      FROM storage_channels channel
      WHERE blobs.channel_id = channel.id AND channel.discord_channel_id = ${discordChannelId}
        AND blobs.state = 'stored'
        AND blobs.message_id = ANY(${textArray(messageIds)})
      RETURNING blobs.id::float8 AS id, channel.name AS channel`)
    const [first] = blobs
    if (!first) return null
    const blobIds = bigintArray(blobs.map((blob) => blob.id))
    await tx.execute(sql`
      SELECT id FROM file_versions
      WHERE id IN (SELECT version_id FROM chunks WHERE blob_id = ANY(${blobIds}))
      ORDER BY id FOR NO KEY UPDATE`)
    const { rows: versions } = await tx.execute<{ id: string }>(sql`
      UPDATE file_versions SET state = 'lost'
      WHERE id IN (SELECT version_id FROM chunks WHERE blob_id = ANY(${blobIds}))
        AND state IN ('syncing', 'stored')
      RETURNING id`)
    // Only files whose current version this is show the change.
    const { rows: shown } = await tx.execute<{
      user_id: string
      id: string
      parent_id: string
    }>(sql`
      SELECT owner_id AS user_id, id, parent_id FROM nodes
      WHERE current_version_id = ANY(${uuidArray(versions.map((version) => version.id))})
        AND parent_id IS NOT NULL`)
    const byOwner = new Map<string, { id: string; parentId: string }[]>()
    for (const row of shown) {
      const files = byOwner.get(row.user_id) ?? []
      files.push({ id: row.id, parentId: row.parent_id })
      byOwner.set(row.user_id, files)
    }
    for (const [userId, files] of byOwner) {
      await notifySynced(
        tx,
        userId,
        files.map(({ id, parentId }) => ({ id, parentId, syncState: 'lost' })),
      )
    }
    return { channel: first.channel, blobs: blobs.length, files: shown.length }
  })
}

/**
 * Says in `#dfs-log` what was lost, by counts and channel only: messages
 * never name files (DESIGN.md §4). Without a registered log channel, it only
 * logs.
 */
export async function alertLost(
  db: Database,
  rest: DiscordRest,
  report: LostReport,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  log.warn(report, 'storage messages were deleted in Discord; their blobs are lost')
  const { rows } = await db.execute<{ discord_channel_id: string }>(sql`
    SELECT discord_channel_id FROM storage_channels WHERE kind = 'log' ORDER BY id LIMIT 1`)
  const logChannel = rows[0]?.discord_channel_id
  if (!logChannel) return
  const blobs =
    report.blobs === 1 ? '1 storage message was' : `${String(report.blobs)} storage messages were`
  const files = report.files === 1 ? '1 file is' : `${String(report.files)} files are`
  await rest.post(Routes.channelMessages(logChannel), {
    body: {
      content: `⚠️ ${blobs} deleted in #${report.channel}. ${files} lost; the admin overview lists them.`,
      allowed_mentions: { parse: [] },
    },
  })
}

import type { Config } from '@dfs/config'
import type { Database } from '@dfs/db'
import {
  ChaosBlobStore,
  createDiscordRest,
  DiscordBlobStore,
  LocalBlobStore,
  type BlobStore,
  type CdnUrl,
  type StorageChannel,
} from '@dfs/storage'
import type { RefreshedUrls } from '@dfs/shared'
import { sql } from 'drizzle-orm'

// Where the bot stores blobs (BLOB_STORE, DESIGN.md §15), and the signed URLs
// it hands the API for reading them back from Discord (§6.2).

/** Posting a 10 MiB attachment takes longer than Discord's 15 s default on a slow uplink. */
const DISCORD_TIMEOUT_MS = 120_000

export function botBlobStore(config: Config, db: Database): BlobStore {
  if (config.blobStore === 'discord') {
    // Config refuses BLOB_STORE=discord for the bot without a token.
    const token = config.discord.botToken ?? ''
    return new DiscordBlobStore({
      rest: createDiscordRest(token, { timeoutMs: DISCORD_TIMEOUT_MS }),
      channels: () => dataChannels(db),
      maxBytes: config.sizes.blobMaxBytes,
    })
  }
  const local = new LocalBlobStore(config.localBlobDir)
  return config.blobStore === 'chaos' ? new ChaosBlobStore(local) : local
}

/** This environment's registered data channels, the only ones it posts to or reads (D25). */
export async function dataChannels(db: Database): Promise<StorageChannel[]> {
  const { rows } = await db.execute<{ id: string; discord_channel_id: string; enabled: boolean }>(
    sql`SELECT id, discord_channel_id, enabled FROM storage_channels WHERE kind = 'data' ORDER BY id`,
  )
  return rows.map((row) => ({
    id: row.id,
    discordChannelId: row.discord_channel_id,
    enabled: row.enabled,
  }))
}

/**
 * `POST /internal/urls/refresh`: fresh signed URLs for these stored blobs,
 * also saved for the next read. A blob whose message is gone gets none.
 */
export async function refreshBlobUrls(
  db: Database,
  store: BlobStore,
  blobIds: readonly number[],
): Promise<Map<number, CdnUrl>> {
  if (!store.signUrls || blobIds.length === 0) return new Map()
  const { rows } = await db.execute<{
    id: number
    channel_id: string | null
    message_id: string | null
    attachment_id: string | null
  }>(sql`
    SELECT id::float8 AS id, channel_id, message_id, attachment_id FROM blobs
    WHERE id = ANY(${`{${blobIds.join(',')}}`}::bigint[]) AND state = 'stored'`)
  const signed = await store.signUrls(
    rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      messageId: row.message_id,
      attachmentId: row.attachment_id,
    })),
  )
  if (signed.size > 0) {
    const saved = [...signed].map(([id, url]) => ({ id, url: url.url, expires_at: url.expiresAt }))
    await db.execute(sql`
      UPDATE blobs SET cdn_url = signed.url, cdn_url_expires_at = signed.expires_at
      FROM jsonb_to_recordset(${JSON.stringify(saved)}::jsonb)
        AS signed(id bigint, url text, expires_at timestamptz)
      WHERE blobs.id = signed.id`)
  }
  return signed
}

/** The answer of `POST /internal/urls/refresh`. */
export function refreshedUrls(urls: Map<number, CdnUrl>): RefreshedUrls {
  return {
    urls: [...urls].map(([blobId, url]) => ({
      blobId,
      url: url.url,
      expiresAt: url.expiresAt.toISOString(),
    })),
  }
}

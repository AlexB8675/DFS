import { RESTEvents } from '@discordjs/rest'
import type { Config } from '@dfs/config'
import { bigintArray, type Database, type Metrics } from '@dfs/db'
import {
  channelsInCategory,
  ChaosBlobStore,
  createDiscordRest,
  DiscordBlobStore,
  DiscordJournalStore,
  LocalBlobStore,
  LocalJournalStore,
  type BlobStore,
  type JournalChannel,
  type JournalStore,
  type CdnUrl,
  type DiscordRest,
  type DiscordRestClient,
  type StorageChannel,
} from '@dfs/storage'
import type { FastifyBaseLogger } from 'fastify'
import type { RefreshedUrls } from '@dfs/shared'
import { sql } from 'drizzle-orm'

// Where the bot stores blobs (BLOB_STORE, DESIGN.md §15), and the signed URLs
// it hands the API for reading them back from Discord (§6.2).

/** Posting a 10 MiB attachment takes longer than Discord's 15 s default on a slow uplink. */
const DISCORD_TIMEOUT_MS = 120_000

export interface BotStorage {
  store: BlobStore
  /** Where journal batches go (§8): #dfs-journal, or a folder beside local blobs. */
  journal: JournalStore
  /** Discord's REST client when blobs go there: for the gateway, the reconciler and channel checks. */
  discord: DiscordRestClient | null
}

export function botStorage(
  config: Config,
  db: Database,
  log?: Pick<FastifyBaseLogger, 'warn'>,
  metrics?: Metrics,
): BotStorage {
  if (config.blobStore === 'discord') {
    // Config refuses BLOB_STORE=discord for the bot without a token and a server.
    const { botToken, guildId, categoryName } = config.discord
    const rest = createDiscordRest(botToken ?? '', { timeoutMs: DISCORD_TIMEOUT_MS })
    if (metrics) countDiscordRequests(rest, metrics)
    const store = new DiscordBlobStore({
      rest,
      channels: () => placeableChannels(db, rest, guildId ?? '', categoryName, log),
      maxBytes: config.sizes.blobMaxBytes,
      instanceId: () => instanceId(db),
      perChannel: config.uploadChannelConcurrency,
    })
    const journal = new DiscordJournalStore({
      rest,
      channel: () => journalChannel(db, rest, guildId ?? '', categoryName),
      instanceId: () => instanceId(db),
    })
    return { store, journal, discord: rest }
  }
  const local = new LocalBlobStore(config.localBlobDir)
  return {
    store: config.blobStore === 'chaos' ? new ChaosBlobStore(local) : local,
    journal: new LocalJournalStore(config.localBlobDir),
    discord: null,
  }
}

/**
 * The registered journal channel inside this environment's category in
 * Discord (D25), if there is one: batches are never posted anywhere else.
 */
export async function journalChannel(
  db: Database,
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
): Promise<JournalChannel | null> {
  const { rows } = await db.execute<{ id: string; discord_channel_id: string }>(sql`
    SELECT id, discord_channel_id FROM storage_channels WHERE kind = 'journal' ORDER BY id`)
  if (rows.length === 0) return null
  const inCategory = await channelsInCategory(rest, guildId, categoryName)
  const row = rows.find((candidate) => inCategory.has(candidate.discord_channel_id))
  return row ? { id: row.id, discordChannelId: row.discord_channel_id } : null
}

/**
 * Every call to Discord goes through this one client, the gateway's too, so
 * it sees every answer: 429s included, which it retries on its own, and the
 * waits it chooses to stay inside the rate limits (DESIGN.md §16).
 */
function countDiscordRequests(rest: DiscordRestClient, metrics: Metrics): void {
  rest.on(RESTEvents.Response, (_request, response) => {
    metrics.record('discord.requests')
    if (response.status === 429) metrics.record('discord.429')
    else if (response.status >= 500) metrics.record('discord.server_errors')
  })
  rest.on(RESTEvents.RateLimited, (limit) => {
    metrics.record('discord.waits', limit.timeToReset)
  })
}

/** This database's name for itself, which its Discord messages carry (DESIGN.md §4). */
export async function instanceId(db: Database): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM instance LIMIT 1`)
  const id = rows[0]?.id
  if (!id) throw new Error('This database has no instance ID: run its migrations.')
  return id
}

/**
 * The registered data channels, of which only those inside this
 * environment's category in Discord take new blobs (D25). One registered by
 * mistake, or moved out of the category, keeps its blobs readable.
 */
export async function placeableChannels(
  db: Database,
  rest: DiscordRest,
  guildId: string,
  categoryName: string,
  log?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<StorageChannel[]> {
  const [registered, inside] = await Promise.all([
    dataChannels(db),
    channelsInCategory(rest, guildId, categoryName),
  ])
  return registered.map((channel) => {
    const placeable = inside.has(channel.discordChannelId)
    if (channel.enabled && !placeable) {
      log?.warn(
        { discordChannelId: channel.discordChannelId, categoryName },
        'a registered channel is outside this environment’s category; it takes no new blobs',
      )
    }
    return { ...channel, enabled: channel.enabled && placeable }
  })
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
    WHERE id = ANY(${bigintArray(blobIds)}) AND state = 'stored'`)
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

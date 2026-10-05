import {
  formatBytes,
  METRIC_STEPS,
  type AuditEntry,
  type CreateChannelInput,
  type Page,
  type StorageChannel,
  type SystemHealth,
} from '@dfs/shared'
import { storageChannels, systemFigures } from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'
import { FAILING_DELETE_ATTEMPTS, healthAlerts } from './alerts.ts'

// The admin overview, storage channels and the audit log (DESIGN.md §9).

const startedAt = Date.now()

/**
 * `GET /admin/health`: alerts, services, queue, sync backlog, staging, cache,
 * storage and lost blobs.
 */
export async function systemHealth(app: FastifyInstance): Promise<SystemHealth> {
  const [bot, figures, recent, troubles, lost] = await Promise.all([
    botHealth(app),
    systemFigures(app.db),
    // From the metrics: what reached Discord lately, the cache's hits this
    // last hour, and the failures of the last hour that make alerts.
    app.db.execute<{
      posted: number
      seconds: number
      hits: number
      misses: number
      rate_limited: number
      server_errors: number
      cdn_failures: number
      post_failures: number
    }>(sql`
      SELECT
        coalesce(sum(sum) FILTER (WHERE name = 'discord.posted'
          AND at >= date_trunc('minute', now()) - interval '4 minutes'), 0)::float8 AS posted,
        extract(epoch FROM now() - date_trunc('minute', now()) + interval '4 minutes')::float8
          AS seconds,
        coalesce(sum(count) FILTER (WHERE name = 'cache.hits'), 0)::float8 AS hits,
        coalesce(sum(count) FILTER (WHERE name = 'cache.misses'), 0)::float8 AS misses,
        coalesce(sum(sum) FILTER (WHERE name = 'discord.429'), 0)::float8 AS rate_limited,
        coalesce(sum(sum) FILTER (WHERE name = 'http.server_errors'), 0)::float8 AS server_errors,
        coalesce(sum(sum) FILTER (WHERE name = 'cdn.failures'), 0)::float8 AS cdn_failures,
        coalesce(sum(sum) FILTER (WHERE name = 'discord.post_failures'), 0)::float8
          AS post_failures
      FROM metrics
      WHERE step = ${METRIC_STEPS.minute} AND at >= now() - interval '1 hour'
        AND name IN ('discord.posted', 'cache.hits', 'cache.misses', 'discord.429',
          'http.server_errors', 'cdn.failures', 'discord.post_failures')`),
    // Both read the blobs waiting to be deleted (an index) or those lost (rare).
    app.db.execute<{ failing_deletions: number; lost_files: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM blobs
          WHERE state = 'deleting' AND attempts >= ${FAILING_DELETE_ATTEMPTS}) AS failing_deletions,
        (SELECT count(DISTINCT chunk.version_id)::int
          FROM blobs blob JOIN chunks chunk ON chunk.blob_id = blob.id
          WHERE blob.state = 'lost') AS lost_files`),
    app.db.execute<{
      id: string
      channel: string | null
      lost_at: string | null
      files: number
    }>(sql`
      SELECT blob.id::text AS id, channel.name AS channel, blob.lost_at::text AS lost_at,
        (SELECT count(DISTINCT version_id)::int FROM chunks WHERE blob_id = blob.id) AS files
      FROM blobs blob LEFT JOIN storage_channels channel ON channel.id = blob.channel_id
      WHERE blob.state = 'lost' ORDER BY blob.lost_at DESC NULLS LAST LIMIT 50`),
  ])
  const local = app.config.blobStore !== 'discord'
  const latest = recent.rows[0]
  const cacheReads = (latest?.hits ?? 0) + (latest?.misses ?? 0)
  return {
    checkedAt: new Date().toISOString(),
    alerts: healthAlerts({
      bot,
      lostBlobs: figures.lostBlobs,
      lostFiles: troubles.rows[0]?.lost_files ?? 0,
      failedJobs: figures.failedJobs,
      oldestPendingSeconds: figures.oldestPendingSeconds,
      stagedBytes: figures.stagedBytes,
      stagingMaxBytes: app.config.stagingMaxBytes,
      failingDeletions: troubles.rows[0]?.failing_deletions ?? 0,
      lastHour: {
        rateLimited: latest?.rate_limited ?? 0,
        serverErrors: latest?.server_errors ?? 0,
        cdnFailures: latest?.cdn_failures ?? 0,
        postFailures: latest?.post_failures ?? 0,
      },
    }),
    services: [
      { name: 'API', status: 'ok', detail: `up ${uptime()}` },
      bot,
      {
        name: 'Database',
        status: 'ok',
        detail: `PostgreSQL · ${formatBytes(figures.databaseBytes)}`,
      },
      {
        name: local ? 'Blob store' : 'Discord',
        status: figures.lostBlobs > 0 ? 'degraded' : 'ok',
        detail:
          figures.lostBlobs > 0
            ? `${String(figures.lostBlobs)} lost ${figures.lostBlobs === 1 ? 'blob' : 'blobs'}`
            : local
              ? 'Local files'
              : 'Connected',
      },
    ],
    queue: {
      pendingJobs: figures.pendingJobs,
      failedJobs: figures.failedJobs,
      oldestPendingSeconds: figures.oldestPendingSeconds,
    },
    sync: {
      backlogFiles: figures.syncFiles,
      backlogBytes: figures.syncBytes,
      bytesPerSecond: (latest?.posted ?? 0) / Math.max(1, latest?.seconds ?? 0),
    },
    staging: { usedBytes: figures.stagedBytes, maxBytes: app.config.stagingMaxBytes },
    cache: {
      usedBytes: app.frameCache?.bytes ?? 0,
      maxBytes: app.config.cacheMaxBytes,
      hitRate: cacheReads === 0 ? 0 : (latest?.hits ?? 0) / cacheReads,
    },
    storage: {
      blobCount: figures.blobs,
      packCount: figures.packs,
      storedBytes: figures.storedBytes,
      liveBytes: figures.liveBytes,
    },
    // The scrubber, journal flushes and backups arrive with M4.
    scrubber: { lastRunAt: null, checkedBlobs: 0, totalBlobs: figures.blobs, problems: 0 },
    backups: { lastBackupAt: null, lastJournalFlushAt: null },
    lostBlobs: lost.rows.map((row) => ({
      blobId: row.id,
      channelName: row.channel ?? 'local',
      detectedAt: row.lost_at ? new Date(row.lost_at).toISOString() : new Date().toISOString(),
      affectedFiles: row.files,
    })),
  }
}

const botErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

/**
 * Has the bot check that a channel registered by hand is in this
 * environment's category, and make it private to the bot (D25): development
 * must never take production's channels by their ID.
 */
async function adoptChannel(app: FastifyInstance, discordChannelId: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${app.config.botInternalUrl}/internal/channels/adopt`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${app.config.internalRpcSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ discordChannelId }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApiError(503, 'bot_unavailable', 'The bot isn’t answering; try again shortly.')
  }
  if (response.ok) {
    await response.body?.cancel()
    return
  }
  const refusal = botErrorSchema.safeParse(await response.json().catch(() => null))
  if (response.status === 422 && refusal.success) {
    throw new ApiError(422, 'channel_refused', refusal.data.error.message)
  }
  throw new ApiError(
    503,
    'bot_unavailable',
    refusal.success ? refusal.data.error.message : 'The bot couldn’t check that channel.',
  )
}

const botHealthSchema = z.object({ role: z.string(), queue: z.string() })

async function botHealth(app: FastifyInstance): Promise<SystemHealth['services'][number]> {
  try {
    const response = await fetch(`${app.config.botInternalUrl}/internal/health`, {
      headers: { authorization: `Bearer ${app.config.internalRpcSecret}` },
      signal: AbortSignal.timeout(2000),
    })
    const health = botHealthSchema.parse(await response.json())
    const ok = health.role === 'leader' && health.queue === 'running'
    return {
      name: 'Bot',
      status: ok ? 'ok' : 'degraded',
      detail: `${health.role}, queue ${health.queue}`,
    }
  } catch {
    return { name: 'Bot', status: 'down', detail: 'Not answering' }
  }
}

// ── Storage channels ─────────────────────────────────────────────────────────

export async function listChannels(app: FastifyInstance): Promise<StorageChannel[]> {
  const { rows } = await app.db.execute<{
    id: string
    discord_channel_id: string
    name: string
    enabled: boolean
    created_at: string
    blob_count: number
    stored_bytes: number
  }>(sql`
    SELECT channel.id, channel.discord_channel_id, channel.name, channel.enabled,
      channel.created_at::text AS created_at,
      count(blob.id) FILTER (WHERE blob.state = 'stored')::int AS blob_count,
      coalesce(sum(blob.size_bytes) FILTER (WHERE blob.state = 'stored'), 0)::float8 AS stored_bytes
    FROM storage_channels channel LEFT JOIN blobs blob ON blob.channel_id = channel.id
    WHERE channel.kind = 'data'
    GROUP BY channel.id ORDER BY channel.created_at`)
  return rows.map((row) => ({
    id: row.id,
    discordChannelId: row.discord_channel_id,
    name: row.name,
    enabled: row.enabled,
    blobCount: row.blob_count,
    storedBytes: row.stored_bytes,
    createdAt: new Date(row.created_at).toISOString(),
  }))
}

export async function createChannel(
  app: FastifyInstance,
  admin: Auth,
  input: CreateChannelInput,
): Promise<StorageChannel> {
  if (app.config.blobStore === 'discord') await adoptChannel(app, input.discordChannelId)
  try {
    await app.db.insert(storageChannels).values({
      discordChannelId: input.discordChannelId,
      name: input.name,
    })
  } catch (error) {
    if (isUniqueViolation(error, 'storage_channels_discord_id')) {
      throw new ApiError(409, 'channel_exists', 'This channel is already in use.')
    }
    throw error
  }
  await audit(app.db, { actorId: admin.user.id, action: 'channel.created', target: input.name })
  return channelById(app, input.discordChannelId, 'discord')
}

/** `PATCH /admin/channels/:id`: one channel at least keeps taking new blobs. */
export async function setChannelEnabled(
  app: FastifyInstance,
  admin: Auth,
  id: string,
  enabled: boolean,
): Promise<StorageChannel> {
  await app.db.transaction(async (tx) => {
    // Serializes toggles, so two can't both turn off "the other" last channel.
    await tx.execute(sql`LOCK TABLE storage_channels IN SHARE ROW EXCLUSIVE MODE`)
    const [channel] = await tx.select().from(storageChannels).where(eq(storageChannels.id, id))
    if (!channel) throw new ApiError(404, 'not_found', 'No such channel.')
    if (channel.enabled === enabled) return
    if (!enabled) {
      const { rows } = await tx.execute<{ others: number }>(sql`
        SELECT count(*)::int AS others FROM storage_channels
        WHERE enabled AND kind = 'data' AND id <> ${id}`)
      if ((rows[0]?.others ?? 0) === 0) {
        throw new ApiError(409, 'last_channel', 'At least one channel must take new blobs.')
      }
    }
    await tx.update(storageChannels).set({ enabled }).where(eq(storageChannels.id, id))
    await audit(tx, {
      actorId: admin.user.id,
      action: enabled ? 'channel.enabled' : 'channel.disabled',
      target: channel.name,
    })
  })
  return channelById(app, id, 'id')
}

async function channelById(
  app: FastifyInstance,
  key: string,
  by: 'id' | 'discord',
): Promise<StorageChannel> {
  const channel = (await listChannels(app)).find((candidate) =>
    by === 'id' ? candidate.id === key : candidate.discordChannelId === key,
  )
  if (!channel) throw new ApiError(404, 'not_found', 'No such channel.')
  return channel
}

// ── Audit log ────────────────────────────────────────────────────────────────

/** `GET /admin/audit`: newest first, paged by ID. */
export async function auditLog(
  app: FastifyInstance,
  cursor: string | undefined,
  limit: number,
): Promise<Page<AuditEntry>> {
  const before = cursor && /^\d+$/.test(cursor) ? sql`AND entry.id < ${cursor}::bigint` : sql``
  const { rows } = await app.db.execute<{
    id: string
    at: string
    actor: string | null
    action: string
    target: string | null
    details: string | null
  }>(sql`
    SELECT entry.id::text AS id, entry.at::text AS at, actor.display_name AS actor, entry.action,
      entry.meta->>'target' AS target, entry.meta->>'details' AS details
    FROM audit_log entry LEFT JOIN users actor ON actor.id = entry.user_id
    WHERE true ${before}
    ORDER BY entry.id DESC
    LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      at: new Date(row.at).toISOString(),
      actorName: row.actor ?? (row.action === 'auth.login_failed' ? 'Unknown' : 'System'),
      action: row.action,
      target: row.target ?? '',
      details: row.details,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
}

function uptime(): string {
  const minutes = Math.floor((Date.now() - startedAt) / 60_000)
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} days`
}

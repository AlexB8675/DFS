import {
  formatBytes,
  type AuditEntry,
  type CreateChannelInput,
  type Page,
  type StorageChannel,
  type SystemHealth,
} from '@dfs/shared'
import { storageChannels } from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'

// The admin overview, storage channels and the audit log (DESIGN.md §9).

const startedAt = Date.now()

/** `GET /admin/health`: services, queue, sync backlog, staging, storage and lost blobs. */
export async function systemHealth(app: FastifyInstance): Promise<SystemHealth> {
  const [bot, database, queue, figures, lost] = await Promise.all([
    botHealth(app),
    app.db.execute<{ size: number }>(
      sql`SELECT pg_database_size(current_database())::float8 AS size`,
    ),
    queueFigures(app),
    app.db.execute<{
      backlog_files: number
      backlog_bytes: number
      recent_bytes: number
      staged_bytes: number
      blobs: number
      packs: number
      stored_bytes: number
      live_bytes: number
      lost: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM file_versions WHERE state = 'syncing') AS backlog_files,
        (SELECT coalesce(sum(size_bytes), 0)::float8 FROM file_versions WHERE state = 'syncing')
          AS backlog_bytes,
        (SELECT coalesce(sum(size_bytes), 0)::float8 FROM blobs
          WHERE state = 'stored' AND stored_at > now() - interval '1 minute') AS recent_bytes,
        (SELECT coalesce(sum(frame_size), 0)::float8 FROM chunks WHERE staged_path IS NOT NULL)
          AS staged_bytes,
        count(*) FILTER (WHERE state = 'stored')::int AS blobs,
        count(*) FILTER (WHERE state = 'stored' AND kind = 'pack')::int AS packs,
        coalesce(sum(size_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS stored_bytes,
        coalesce(sum(live_bytes) FILTER (WHERE state = 'stored'), 0)::float8 AS live_bytes,
        count(*) FILTER (WHERE state = 'lost')::int AS lost
      FROM blobs`),
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
  const numbers = figures.rows[0]
  const local = app.config.blobStore !== 'discord'
  return {
    checkedAt: new Date().toISOString(),
    services: [
      { name: 'API', status: 'ok', detail: `up ${uptime()}` },
      bot,
      {
        name: 'Database',
        status: 'ok',
        detail: `PostgreSQL · ${formatBytes(database.rows[0]?.size ?? 0)}`,
      },
      {
        name: local ? 'Blob store' : 'Discord',
        status: (numbers?.lost ?? 0) > 0 ? 'degraded' : 'ok',
        detail:
          (numbers?.lost ?? 0) > 0
            ? `${String(numbers?.lost)} lost blobs`
            : local
              ? 'Local files'
              : 'Connected',
      },
    ],
    queue,
    sync: {
      backlogFiles: numbers?.backlog_files ?? 0,
      backlogBytes: numbers?.backlog_bytes ?? 0,
      bytesPerSecond: (numbers?.recent_bytes ?? 0) / 60,
    },
    staging: { usedBytes: numbers?.staged_bytes ?? 0, maxBytes: app.config.stagingMaxBytes },
    // The frame cache arrives with Discord storage (M1).
    cache: { usedBytes: 0, maxBytes: app.config.cacheMaxBytes, hitRate: 0 },
    storage: {
      blobCount: numbers?.blobs ?? 0,
      packCount: numbers?.packs ?? 0,
      storedBytes: numbers?.stored_bytes ?? 0,
      liveBytes: numbers?.live_bytes ?? 0,
    },
    // The scrubber, journal flushes and backups arrive with M4.
    scrubber: { lastRunAt: null, checkedBlobs: 0, totalBlobs: numbers?.blobs ?? 0, problems: 0 },
    backups: { lastBackupAt: null, lastJournalFlushAt: null },
    lostBlobs: lost.rows.map((row) => ({
      blobId: row.id,
      channelName: row.channel ?? 'local',
      detectedAt: row.lost_at ? new Date(row.lost_at).toISOString() : new Date().toISOString(),
      affectedFiles: row.files,
    })),
  }
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

/** pg-boss's own table; it exists once the bot has started once. */
async function queueFigures(app: FastifyInstance): Promise<SystemHealth['queue']> {
  try {
    const { rows } = await app.db.execute<{ pending: number; failed: number; oldest: number }>(sql`
      SELECT
        count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS pending,
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        coalesce(extract(epoch FROM now() - min(created_on) FILTER (WHERE state IN ('created', 'retry'))), 0)::int
          AS oldest
      FROM pgboss.job`)
    const [row] = rows
    return {
      pendingJobs: row?.pending ?? 0,
      failedJobs: row?.failed ?? 0,
      oldestPendingSeconds: row?.oldest ?? 0,
    }
  } catch {
    return { pendingJobs: 0, failedJobs: 0, oldestPendingSeconds: 0 }
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

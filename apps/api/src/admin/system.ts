import {
  formatBytes,
  METRIC_STEPS,
  TIMING_BOUNDS,
  timingBucketName,
  type AuditEntry,
  type AuditQuery,
  type CreateChannelInput,
  type Page,
  type StorageChannel,
  type SystemHealth,
} from '@dfs/shared'
import {
  appendJournal,
  percentile,
  storageChannels,
  storageTotals,
  systemFigures,
  type StorageTotals,
} from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit, auditAlone } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { reach } from '../checks.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'
import { FAILING_DELETE_ATTEMPTS, healthAlerts } from './alerts.ts'

// The admin overview, storage channels and the audit log (DESIGN.md §9).

/** When this API instance started. */
export const apiStartedAt = new Date()

/** The timing the overview's slow-start alert reads, and the indexes of its buckets. */
const FIRST_BYTE = 'downloads.first_byte_ms'
const TIMING_BUCKETS = Array.from({ length: TIMING_BOUNDS.length + 1 }, (_, index) => index)

/** How many file reads were timed to their first byte, and the 95th percentile of their times. */
function firstByteFigures(rows: { name: string; count: number; max: number }[]): {
  reads: number
  p95Ms: number | null
} {
  const byName = new Map(rows.map((row) => [row.name, row]))
  const counts = TIMING_BUCKETS.map(
    (index) => byName.get(timingBucketName(FIRST_BYTE, index))?.count ?? 0,
  )
  return {
    reads: byName.get(FIRST_BYTE)?.count ?? 0,
    p95Ms: percentile(counts, 0.95, byName.get(FIRST_BYTE)?.max ?? null),
  }
}

/** How long the overview's storage totals are shared: they change slowly, and cost a scan. */
const TOTALS_FOR_MS = 30_000
const recentTotalsByApp = new WeakMap<
  FastifyInstance,
  { at: number; totals: Promise<StorageTotals> }
>()

/**
 * The pass over `blobs`, made at most every `TOTALS_FOR_MS` however many
 * admins watch the overview; everything else it shows is read as it is now.
 */
function recentTotals(app: FastifyInstance, now = Date.now()): Promise<StorageTotals> {
  const kept = recentTotalsByApp.get(app)
  if (kept && now - kept.at < TOTALS_FOR_MS) return kept.totals
  const totals = storageTotals(app.db)
  recentTotalsByApp.set(app, { at: now, totals })
  // A failure isn't kept: the next look tries again.
  void totals.catch(() => {
    if (recentTotalsByApp.get(app)?.totals === totals) recentTotalsByApp.delete(app)
  })
  return totals
}

/**
 * `GET /admin/health`: alerts, services, queue, sync backlog, staging, cache
 * and storage.
 */
export async function systemHealth(app: FastifyInstance): Promise<SystemHealth> {
  const [bot, media, figures, recent, firstBytes, troubles, database] = await Promise.all([
    botHealth(app),
    mediaHealth(app),
    systemFigures(app.db, () => recentTotals(app)),
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
      cdn_slow_downs: number
      post_failures: number
      deadlocks: number
      media_failures: number
      download_failures: number
      play_read_failures: number
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
        coalesce(sum(sum) FILTER (WHERE name = 'cdn.429'), 0)::float8 AS cdn_slow_downs,
        coalesce(sum(sum) FILTER (WHERE name = 'discord.post_failures'), 0)::float8
          AS post_failures,
        coalesce(sum(sum) FILTER (WHERE name = 'pg.deadlocks'), 0)::float8 AS deadlocks,
        coalesce(sum(sum) FILTER (WHERE name = 'media.failures'), 0)::float8 AS media_failures,
        coalesce(sum(sum) FILTER (WHERE name = 'downloads.failures'), 0)::float8
          AS download_failures,
        coalesce(sum(sum) FILTER (WHERE name = 'player.failures.read'), 0)::float8
          AS play_read_failures
      FROM metrics
      WHERE step = ${METRIC_STEPS.minute} AND at >= now() - interval '1 hour'
        AND name IN ('discord.posted', 'cache.hits', 'cache.misses', 'discord.429',
          'http.server_errors', 'cdn.failures', 'cdn.429', 'discord.post_failures', 'pg.deadlocks',
          'media.failures', 'downloads.failures', 'player.failures.read')`),
    // The last hour's times to a file's first byte, by bucket, for their 95th percentile.
    app.db.execute<{ name: string; count: number; max: number }>(sql`
      SELECT name, sum(count)::float8 AS count, max(max)::float8 AS max
      FROM metrics
      WHERE step = ${METRIC_STEPS.minute} AND at >= now() - interval '1 hour'
        AND name IN (${sql.join(
          [FIRST_BYTE, ...TIMING_BUCKETS.map((index) => timingBucketName(FIRST_BYTE, index))],
          sql`, `,
        )})
      GROUP BY name`),
    // Blobs that keep failing to delete, through the index of the GC's queue,
    // and how far the journal is behind.
    app.db.execute<{
      failing_deletions: number
      password_resets: number
      journal_behind: number
      journal_error: string | null
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM blobs
          WHERE state = 'deleting' AND attempts >= ${FAILING_DELETE_ATTEMPTS}) AS failing_deletions,
        (SELECT count(*)::int FROM users
          WHERE password_reset_requested_at IS NOT NULL AND disabled_at IS NULL) AS password_resets,
        -- The oldest change not in #dfs-journal: not sealed yet, or sealed and not posted (§8).
        greatest(
          (SELECT extract(epoch FROM now() - min(created_at)) FROM journal WHERE batch_no IS NULL),
          (SELECT extract(epoch FROM now() - min(created_at)) FROM journal_batches
            WHERE state = 'staged'),
          0)::float8 AS journal_behind,
        (SELECT last_error FROM journal_batches WHERE state = 'staged'
          ORDER BY batch_no LIMIT 1) AS journal_error`),
    // PostgreSQL's connections: how many of the limit, and the stuck ones.
    app.db.execute<{
      connections: number
      max_connections: number
      oldest_transaction: number
      long_lock_waits: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend')
          AS connections,
        current_setting('max_connections')::int AS max_connections,
        coalesce(max(extract(epoch FROM now() - xact_start)), 0)::float8 AS oldest_transaction,
        count(*) FILTER (WHERE wait_event_type = 'Lock'
          AND query_start < now() - interval '30 seconds')::int AS long_lock_waits
      FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()`),
  ])
  const local = app.config.blobStore !== 'discord'
  const latest = recent.rows[0]
  const cacheReads = (latest?.hits ?? 0) + (latest?.misses ?? 0)
  const discordCheck = app.checks.reading('discord')
  const internetCheck = app.checks.reading('internet')
  const discord = reach(discordCheck)
  return {
    checkedAt: new Date().toISOString(),
    alerts: healthAlerts({
      bot,
      media: media.status,
      failedJobs: figures.failedJobs,
      oldestPendingSeconds: figures.oldestPendingSeconds,
      stagedBytes: figures.stagedBytes,
      stagingMaxBytes: app.config.stagingMaxBytes,
      failingDeletions: troubles.rows[0]?.failing_deletions ?? 0,
      passwordResets: troubles.rows[0]?.password_resets ?? 0,
      database: {
        connections: database.rows[0]?.connections ?? 0,
        maxConnections: database.rows[0]?.max_connections ?? 0,
        oldestTransactionSeconds: database.rows[0]?.oldest_transaction ?? 0,
        longLockWaits: database.rows[0]?.long_lock_waits ?? 0,
      },
      lastHour: {
        rateLimited: latest?.rate_limited ?? 0,
        serverErrors: latest?.server_errors ?? 0,
        cdnFailures: latest?.cdn_failures ?? 0,
        cdnSlowDowns: latest?.cdn_slow_downs ?? 0,
        postFailures: latest?.post_failures ?? 0,
        deadlocks: latest?.deadlocks ?? 0,
        mediaFailures: latest?.media_failures ?? 0,
        downloadFailures: latest?.download_failures ?? 0,
        playReadFailures: latest?.play_read_failures ?? 0,
        firstBytes: firstByteFigures(firstBytes.rows),
      },
      network: {
        discordDown: !local && discordCheck.down,
        internetDown: internetCheck.down,
      },
      journal: {
        behindSeconds: troubles.rows[0]?.journal_behind ?? 0,
        lastError: troubles.rows[0]?.journal_error ?? null,
      },
    }),
    services: [
      { name: 'API', status: 'ok', detail: `up ${uptime()}` },
      bot,
      media,
      {
        name: 'Database',
        status: 'ok',
        detail: `PostgreSQL · ${formatBytes(figures.databaseBytes)}`,
      },
      local
        ? { name: 'Blob store', status: 'ok', detail: 'Local files' }
        : { name: 'Discord', ...discord },
      { name: 'Internet', ...reach(internetCheck) },
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

export async function botHealth(app: FastifyInstance): Promise<SystemHealth['services'][number]> {
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

/** The media service (§6.7): which ffmpeg it runs, or that audio and video play only as they are. */
export async function mediaHealth(app: FastifyInstance): Promise<SystemHealth['services'][number]> {
  if (!app.media) {
    return {
      name: 'Media',
      status: 'degraded',
      detail: 'Not set up: audio and video play as they are',
    }
  }
  try {
    const health = await app.media.client.health()
    // "ffprobe version 7.1.5-0+deb13u1 Copyright …" says ffmpeg 7.1.5.
    const version = /version (\d[\w.]*)/.exec(health.ffmpeg)?.[1]
    return { name: 'Media', status: 'ok', detail: version ? `ffmpeg ${version}` : 'Up' }
  } catch {
    return { name: 'Media', status: 'down', detail: 'Not answering' }
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
  await auditAlone(app.db, {
    actorId: admin.user.id,
    action: 'channel.created',
    target: input.name,
  })
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
    await appendJournal(
      tx,
      await audit(tx, {
        actorId: admin.user.id,
        action: enabled ? 'channel.enabled' : 'channel.disabled',
        target: channel.name,
      }),
    )
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

/**
 * `GET /admin/audit`: newest first, paged by ID, narrowed to some kinds of
 * action (by prefix), one actor, or words in its target or details.
 */
export async function auditLog(app: FastifyInstance, query: AuditQuery): Promise<Page<AuditEntry>> {
  const { cursor, limit, actions, actorId, q } = query
  const before = cursor && /^\d+$/.test(cursor) ? sql`AND entry.id < ${cursor}::bigint` : sql``
  const kinds =
    actions && actions.length > 0
      ? sql`AND (${sql.join(
          actions.map((prefix) => sql`starts_with(entry.action, ${prefix})`),
          sql` OR `,
        )})`
      : sql``
  const by = actorId ? sql`AND entry.user_id = ${actorId}` : sql``
  const words = q ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null
  const about = words
    ? sql`AND (entry.meta->>'target' ILIKE ${words} OR entry.meta->>'details' ILIKE ${words})`
    : sql``
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
    WHERE true ${before} ${kinds} ${by} ${about}
    ORDER BY entry.id DESC
    LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      at: new Date(row.at).toISOString(),
      // Signed-out actions: by whoever was at the sign-in page.
      actorName: row.actor ?? (row.action.startsWith('auth.') ? 'Unknown' : 'System'),
      action: row.action,
      target: row.target ?? '',
      details: row.details,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  }
}

function uptime(): string {
  const minutes = Math.floor((Date.now() - apiStartedAt.getTime()) / 60_000)
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} days`
}

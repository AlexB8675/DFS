import { describeSettings, type SettingView } from '@dfs/config'
import { formatBytes, type SystemInfo } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'

// Admin → System (DESIGN.md §15): what this DFS is and how it is set up,
// from a fixed list of settings safe to show (the bot's too, where they
// differ), its Discord channels, its disks, and clearing the frame cache.

const startedAt = new Date()

const botSettingsSchema = z.array(z.object({ key: z.string(), value: z.string() }))

/** `GET /admin/system`. */
export async function systemInfo(app: FastifyInstance): Promise<SystemInfo> {
  const [instance, channels, staged, bot] = await Promise.all([
    app.db.execute<{ id: string }>(sql`SELECT id FROM instance LIMIT 1`),
    app.db.execute<{
      name: string
      kind: 'data' | 'journal' | 'backup' | 'log'
      discord_channel_id: string
      enabled: boolean
    }>(sql`
      SELECT name, kind, discord_channel_id, enabled FROM storage_channels
      ORDER BY kind, name`),
    app.db.execute<{ bytes: number }>(sql`
      SELECT coalesce(sum(frame_size), 0)::float8 AS bytes FROM chunks
      WHERE staged_path IS NOT NULL`),
    botSettings(app),
  ])
  const { settings, secrets } = describeSettings(app.config, process.env)
  const botValues = new Map(bot?.map((setting) => [setting.key, setting.value]))
  const { config, frameCache } = app
  return {
    environment: config.nodeEnv,
    instanceId: instance.rows[0]?.id ?? 'unknown',
    node: process.version,
    apiStartedAt: startedAt.toISOString(),
    settings: settings.map((setting) => {
      const botValue = botValues.get(setting.key)
      return {
        ...setting,
        botValue: botValue !== undefined && botValue !== setting.value ? botValue : null,
      }
    }),
    botSettings: bot !== null,
    secrets,
    discord: {
      guildId: config.discord.guildId,
      categoryName: config.discord.categoryName,
      gateway: config.discord.gateway,
      channels: channels.rows.map((channel) => ({
        name: channel.name,
        kind: channel.kind,
        discordChannelId: channel.discord_channel_id,
        enabled: channel.enabled,
      })),
    },
    staging: {
      dir: config.stagingDir,
      usedBytes: staged.rows[0]?.bytes ?? 0,
      maxBytes: config.stagingMaxBytes,
    },
    frameCache: frameCache && {
      dir: config.cacheDir,
      usedBytes: frameCache.bytes,
      maxBytes: config.cacheMaxBytes,
      frames: frameCache.frames,
    },
  }
}

/** The bot's own settings, to show where they differ; `null` while it doesn't answer. */
async function botSettings(app: FastifyInstance): Promise<SettingView[] | null> {
  try {
    const response = await fetch(`${app.config.botInternalUrl}/internal/settings`, {
      headers: { authorization: `Bearer ${app.config.internalRpcSecret}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return null
    const parsed = botSettingsSchema.safeParse(await response.json())
    return parsed.success ? (parsed.data as SettingView[]) : null
  } catch {
    return null
  }
}

/**
 * `POST /admin/system/cache/clear`: lets this API instance's cached frames
 * go; they are read from Discord again as needed. Returns the bytes freed.
 */
export async function clearFrameCache(app: FastifyInstance, admin: Auth): Promise<number> {
  if (!app.frameCache) {
    throw new ApiError(409, 'no_cache', 'With local storage there is no frame cache to clear.')
  }
  const freed = await app.frameCache.clear()
  await audit(app.db, {
    actorId: admin.user.id,
    action: 'system.cache_cleared',
    target: 'Frame cache',
    details: formatBytes(freed),
  })
  return freed
}

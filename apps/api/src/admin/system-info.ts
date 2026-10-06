import { describeSettings, type SecretView, type SettingView } from '@dfs/config'
import { stagedBytesSql } from '@dfs/db'
import { formatBytes, type SystemInfo } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.ts'
import type { Auth } from '../auth/sessions.ts'
import { ApiError } from '../errors.ts'
import { apiStartedAt } from './system.ts'

// Admin → System (DESIGN.md §15): what this DFS is and how it is set up,
// from a fixed list of settings safe to show, each as the service that reads
// it has it (the bot's own where only it reads them, and where the two
// differ), its Discord channels, its disks, and clearing the frame cache.

/** The bot's `/internal/settings`: only what it reads, and its secrets as set or not. */
const botSettingsSchema = z.object({
  settings: z.array(z.object({ key: z.string(), value: z.string(), set: z.boolean() })),
  secrets: z.array(z.object({ key: z.string(), set: z.boolean() })),
  discord: z.object({
    guildId: z.string().nullable(),
    categoryName: z.string(),
    gateway: z.boolean(),
  }),
})
type BotSettings = z.infer<typeof botSettingsSchema>

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
    app.db.execute<{ bytes: number }>(sql`SELECT ${stagedBytesSql()}::float8 AS bytes`),
    botSettings(app),
  ])
  const { config, frameCache } = app
  // The API reads the Discord settings only to show them: the bot's are the ones that count.
  const { guildId, categoryName, gateway } = bot?.discord ?? config.discord
  return {
    environment: config.nodeEnv,
    instanceId: instance.rows[0]?.id ?? 'unknown',
    node: process.version,
    apiStartedAt: apiStartedAt.toISOString(),
    ...mergeSettings(describeSettings(config, process.env), bot),
    botSettings: bot !== null,
    discord: {
      guildId,
      categoryName,
      gateway,
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

/**
 * Each setting and secret as the service reading it has it: those only the
 * bot reads come from the bot once it answers, and those both read carry
 * the bot's value where it differs. A secret only the bot reads is `null`
 * while it doesn't answer.
 */
export function mergeSettings(
  api: { settings: SettingView[]; secrets: SecretView[] },
  bot: Pick<BotSettings, 'settings' | 'secrets'> | null,
): Pick<SystemInfo, 'settings' | 'secrets'> {
  const botSettings = new Map(bot?.settings.map((setting) => [setting.key, setting]))
  const botSecrets = new Map(bot?.secrets.map((secret) => [secret.key, secret.set]))
  return {
    settings: api.settings.map((setting) => {
      const theirs = botSettings.get(setting.key)
      if (setting.usedBy === 'bot' && theirs) {
        return { ...setting, value: theirs.value, set: theirs.set, botValue: null }
      }
      const differs = setting.usedBy === 'both' && theirs && theirs.value !== setting.value
      return { ...setting, botValue: differs ? theirs.value : null }
    }),
    secrets: api.secrets.map((secret) => ({
      ...secret,
      set: secret.usedBy === 'bot' ? (botSecrets.get(secret.key) ?? null) : secret.set,
    })),
  }
}

/** The bot's own settings; `null` while it doesn't answer, or answers as a bot from before. */
async function botSettings(app: FastifyInstance): Promise<BotSettings | null> {
  try {
    const response = await fetch(`${app.config.botInternalUrl}/internal/settings`, {
      headers: { authorization: `Bearer ${app.config.internalRpcSecret}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return null
    const parsed = botSettingsSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : null
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

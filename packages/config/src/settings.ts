import type { Config } from './config.ts'

// The settings in effect, for Admin → System (DESIGN.md §15): a fixed list
// of those safe to show, each as the environment variable that sets it, its
// value, whether it was set or is the default, and which service reads it.
// Secrets show only whether they are set. Nothing else of the config leaves
// the process.

export type SettingGroup = 'General' | 'Storage' | 'Disks' | 'Accounts' | 'Durability'

/**
 * Which service reads a setting: each may be given only its own, so only
 * those both read must agree. Settings nothing reads yet are `both`, unless
 * DESIGN.md names the service that will.
 */
export type SettingUser = 'api' | 'bot' | 'both'

export interface SettingView {
  /** The environment variable. */
  key: string
  group: SettingGroup
  /** As in effect, the way it would be written in `.env`. */
  value: string
  /** Given in the environment, rather than left to the default. */
  set: boolean
  usedBy: SettingUser
}

export interface SecretView {
  key: string
  usedBy: SettingUser
  set: boolean
}

const KiB = 1024

/** `20 GiB` rather than 21474836480, when it divides evenly. */
function size(bytes: number): string {
  for (const [unit, factor] of [
    ['TiB', KiB ** 4],
    ['GiB', KiB ** 3],
    ['MiB', KiB ** 2],
    ['KiB', KiB],
  ] as const) {
    if (bytes >= factor && bytes % factor === 0) return `${String(bytes / factor)} ${unit}`
  }
  return `${String(bytes)} bytes`
}

export function describeSettings(
  config: Config,
  env: Record<string, string | undefined>,
): { settings: SettingView[]; secrets: SecretView[] } {
  const given = (key: string) => (env[key] ?? '') !== ''
  const entry = (
    group: SettingGroup,
    usedBy: SettingUser,
    key: string,
    value: string | number | boolean,
  ): SettingView => ({ key, group, value: String(value), set: given(key), usedBy })
  const { discord, sizes } = config
  return {
    settings: [
      entry('General', 'both', 'NODE_ENV', config.nodeEnv),
      entry('General', 'both', 'LOG_LEVEL', config.logLevel),
      entry('General', 'api', 'PUBLIC_BASE_URL', config.publicBaseUrl),
      entry('General', 'api', 'API_PORT', config.apiPort),
      entry('General', 'bot', 'BOT_PORT', config.botPort),
      entry('General', 'api', 'TRUSTED_PROXY_CIDRS', config.trustedProxyCidrs.join(', ')),
      entry('Storage', 'both', 'BLOB_STORE', config.blobStore),
      // The API reads these only to show them.
      entry('Storage', 'bot', 'DISCORD_GUILD_ID', discord.guildId ?? 'none'),
      entry('Storage', 'bot', 'DISCORD_CATEGORY_NAME', discord.categoryName),
      entry('Storage', 'bot', 'DISCORD_GATEWAY', discord.gateway ? 'on' : 'off'),
      // Chunks are cut to it by the API, and packed to it by the bot.
      entry('Storage', 'both', 'DISCORD_ATTACHMENT_LIMIT', size(discord.attachmentLimit)),
      entry('Storage', 'bot', 'UPLOAD_CHANNEL_CONCURRENCY', config.uploadChannelConcurrency),
      entry('Storage', 'api', 'PACK_THRESHOLD_BYTES', size(sizes.packThresholdBytes)),
      entry('Storage', 'bot', 'PACK_TARGET_BYTES', size(sizes.packTargetBytes)),
      entry('Storage', 'bot', 'PACK_MAX_WAIT_MS', config.packMaxWaitMs),
      // The bot compacts packs (§6.6).
      entry('Storage', 'bot', 'COMPACT_THRESHOLD', config.compactThreshold),
      entry('Storage', 'both', 'LOCAL_BLOB_DIR', config.localBlobDir),
      entry('Disks', 'both', 'STAGING_DIR', config.stagingDir),
      entry('Disks', 'api', 'STAGING_MAX_BYTES', size(config.stagingMaxBytes)),
      entry('Disks', 'api', 'CACHE_DIR', config.cacheDir),
      entry('Disks', 'api', 'CACHE_MAX_BYTES', size(config.cacheMaxBytes)),
      entry('Accounts', 'api', 'DEFAULT_QUOTA_BYTES', size(config.defaultQuotaBytes)),
      entry('Accounts', 'api', 'TEMP_PASSWORD_DAYS', config.tempPasswordDays),
      entry('Accounts', 'api', 'VERSION_RETENTION', config.versionRetention),
      entry('Accounts', 'both', 'TRASH_RETENTION_DAYS', config.trashRetentionDays),
      // Trashing a large folder in the request, or as a job past it (§7.2).
      entry('Accounts', 'api', 'TRASH_SYNC_LIMIT', config.trashSyncLimit),
      entry('Durability', 'both', 'SCRUB_REQUESTS_PER_HOUR', config.scrubRequestsPerHour),
      // The API flushes the journal: it needs the master key (§8).
      entry('Durability', 'api', 'JOURNAL_FLUSH_INTERVAL_MS', config.journalFlushIntervalMs),
      entry('Durability', 'both', 'BACKUP_RETENTION', config.backupRetention),
    ],
    secrets: (
      [
        ['DATABASE_URL', 'both'],
        ['INTERNAL_RPC_SECRET', 'both'],
        ['DISCORD_BOT_TOKEN', 'bot'],
        ['MASTER_KEY_FILE', 'api'],
      ] as const
    ).map(([key, usedBy]) => ({ key, usedBy, set: given(key) })),
  }
}

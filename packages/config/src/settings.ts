import type { Config } from './config.ts'

// The settings in effect, for Admin → System (DESIGN.md §15): a fixed list
// of those safe to show, each as the environment variable that sets it, its
// value, and whether it was set or is the default. Secrets show only whether
// they are set. Nothing else of the config leaves the process.

export type SettingGroup = 'General' | 'Storage' | 'Disks' | 'Accounts' | 'Durability'

export interface SettingView {
  /** The environment variable. */
  key: string
  group: SettingGroup
  /** As in effect, the way it would be written in `.env`. */
  value: string
  /** Given in the environment, rather than left to the default. */
  set: boolean
}

export interface SecretView {
  key: string
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
  const entry = (group: SettingGroup, key: string, value: string | number | boolean) => ({
    key,
    group,
    value: String(value),
    set: given(key),
  })
  const { discord, sizes } = config
  return {
    settings: [
      entry('General', 'NODE_ENV', config.nodeEnv),
      entry('General', 'LOG_LEVEL', config.logLevel),
      entry('General', 'PUBLIC_BASE_URL', config.publicBaseUrl),
      entry('General', 'API_PORT', config.apiPort),
      entry('General', 'BOT_PORT', config.botPort),
      entry('General', 'TRUSTED_PROXY_CIDRS', config.trustedProxyCidrs.join(', ')),
      entry('Storage', 'BLOB_STORE', config.blobStore),
      entry('Storage', 'DISCORD_GUILD_ID', discord.guildId ?? 'none'),
      entry('Storage', 'DISCORD_CATEGORY_NAME', discord.categoryName),
      entry('Storage', 'DISCORD_GATEWAY', discord.gateway ? 'on' : 'off'),
      entry('Storage', 'DISCORD_ATTACHMENT_LIMIT', size(discord.attachmentLimit)),
      entry('Storage', 'UPLOAD_CHANNEL_CONCURRENCY', config.uploadChannelConcurrency),
      entry('Storage', 'PACK_THRESHOLD_BYTES', size(sizes.packThresholdBytes)),
      entry('Storage', 'PACK_TARGET_BYTES', size(sizes.packTargetBytes)),
      entry('Storage', 'PACK_MAX_WAIT_MS', config.packMaxWaitMs),
      entry('Storage', 'COMPACT_THRESHOLD', config.compactThreshold),
      entry('Storage', 'LOCAL_BLOB_DIR', config.localBlobDir),
      entry('Disks', 'STAGING_DIR', config.stagingDir),
      entry('Disks', 'STAGING_MAX_BYTES', size(config.stagingMaxBytes)),
      entry('Disks', 'CACHE_DIR', config.cacheDir),
      entry('Disks', 'CACHE_MAX_BYTES', size(config.cacheMaxBytes)),
      entry('Accounts', 'DEFAULT_QUOTA_BYTES', size(config.defaultQuotaBytes)),
      entry('Accounts', 'TEMP_PASSWORD_DAYS', config.tempPasswordDays),
      entry('Accounts', 'VERSION_RETENTION', config.versionRetention),
      entry('Accounts', 'TRASH_RETENTION_DAYS', config.trashRetentionDays),
      entry('Accounts', 'TRASH_SYNC_LIMIT', config.trashSyncLimit),
      entry('Durability', 'SCRUB_REQUESTS_PER_HOUR', config.scrubRequestsPerHour),
      entry('Durability', 'JOURNAL_FLUSH_INTERVAL_MS', config.journalFlushIntervalMs),
      entry('Durability', 'BACKUP_RETENTION', config.backupRetention),
    ],
    secrets: ['DATABASE_URL', 'INTERNAL_RPC_SECRET', 'DISCORD_BOT_TOKEN', 'MASTER_KEY_FILE'].map(
      (key) => ({ key, set: given(key) }),
    ),
  }
}

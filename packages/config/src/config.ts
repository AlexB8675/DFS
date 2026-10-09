import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { deriveSizes, frameOverheadBytes, GiB, MiB, parseByteSize } from './sizes.ts'

// Settings from the environment (DESIGN.md §15), parsed once at startup.
// Development and tests get defaults that match docker-compose.dev.yml and
// keep data under ./.data; production has no such defaults and must set them.

export type Service = 'api' | 'bot' | 'cli'
export type NodeEnv = 'development' | 'test' | 'production'

export interface Config {
  nodeEnv: NodeEnv
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  databaseUrl: string
  /**
   * Where blobs go. `chaos` is the local store with the bot's writes failing
   * now and then (DESIGN.md §17), to test retries; development only.
   */
  blobStore: 'discord' | 'local' | 'chaos'
  localBlobDir: string
  discord: {
    botToken: string | null
    guildId: string | null
    categoryName: string
    gateway: boolean
    attachmentLimit: number
  }
  sizes: {
    blobMaxBytes: number
    chunkSize: number
    packThresholdBytes: number
    packTargetBytes: number
  }
  packMaxWaitMs: number
  compactThreshold: number
  compactMinAgeDays: number
  masterKeyFile: string
  stagingDir: string
  stagingMaxBytes: number
  cacheDir: string
  cacheMaxBytes: number
  uploadChannelConcurrency: number
  scrubRequestsPerHour: number
  journalFlushIntervalMs: number
  backupRetention: number
  trashRetentionDays: number
  trashSyncLimit: number
  defaultQuotaBytes: number
  tempPasswordDays: number
  internalRpcSecret: string
  botInternalUrl: string
  /**
   * The media service (§6.7), which the API alone calls; `null` without one,
   * when audio and video play only as they are.
   */
  mediaInternalUrl: string | null
  /** Where users reach DFS, without a trailing slash: share links and the sign-in `Origin` check. Empty only for a production bot. */
  publicBaseUrl: string
  apiPort: number
  botPort: number
  trustedProxyCidrs: string[]
  /** What is deployed: built into the images by docker/deploy.sh. */
  release: Release
}

/**
 * A deploy: its git revision and when it was made (`DFS_VERSION`,
 * `DFS_DEPLOYED_AT`); `dev` and `null` for code not deployed.
 */
export interface Release {
  version: string
  deployedAt: string | null
}

export class ConfigError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** Defaults for development and tests only; see docker/docker-compose.dev.yml. */
const DEVELOPMENT = {
  DATABASE_URL: 'postgres://dfs:dfs@localhost:5432/dfs',
  INTERNAL_RPC_SECRET: 'development-only-internal-rpc-secret',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  BOT_INTERNAL_URL: 'http://localhost:3001',
  /** Its container, from `pnpm db:up` (docker-compose.dev.yml); tests have none. */
  MEDIA_INTERNAL_URL: 'http://localhost:3002',
  BLOB_STORE: 'local',
  DISCORD_CATEGORY_NAME: 'DFS Dev',
  DISCORD_GATEWAY: 'off',
  STAGING_DIR: '.data/staging',
  CACHE_DIR: '.data/cache',
  /** Created on first start if missing, in development only. */
  MASTER_KEY_FILE: '.data/master-key.json',
} as const

const PRODUCTION = {
  BOT_INTERNAL_URL: 'http://bot:3001',
  BLOB_STORE: 'discord',
  DISCORD_CATEGORY_NAME: 'DFS',
  DISCORD_GATEWAY: 'on',
  STAGING_DIR: '/data/staging',
  CACHE_DIR: '/data/cache',
  MASTER_KEY_FILE: '/run/secrets/dfs_master_key',
} as const

/** An unset or empty variable reads as missing, so `KEY=` in a .env file means "use the default". */
function setting<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

/** A byte size such as `512 MiB`; `undefined` when unset. */
const optionalByteSize = setting(
  z
    .string()
    .optional()
    .transform((text, context) => {
      if (text === undefined) return undefined
      const bytes = parseByteSize(text)
      if (bytes === null) {
        context.addIssue({ code: 'custom', message: `expected a size like 512 MiB, got "${text}"` })
        return z.NEVER
      }
      return bytes
    }),
)

function byteSize(fallback: number) {
  return optionalByteSize.transform((bytes) => bytes ?? fallback)
}

function integer(fallback: number, min = 0) {
  return setting(z.coerce.number().int().min(min).default(fallback))
}

const port = (fallback: number) =>
  setting(z.coerce.number().int().min(1).max(65535).default(fallback))

const envSchema = z.object({
  NODE_ENV: setting(z.enum(['development', 'test', 'production']).default('development')),
  LOG_LEVEL: setting(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  DATABASE_URL: setting(z.url({ protocol: /^postgres(ql)?$/ }).optional()),
  BLOB_STORE: setting(z.enum(['discord', 'local', 'chaos']).optional()),
  LOCAL_BLOB_DIR: setting(z.string().default('.data/blobs')),
  DISCORD_BOT_TOKEN: setting(z.string().optional()),
  DISCORD_GUILD_ID: setting(
    z
      .string()
      .regex(/^\d{17,20}$/, 'expected a Discord ID (17–20 digits)')
      .optional(),
  ),
  DISCORD_CATEGORY_NAME: setting(z.string().optional()),
  DISCORD_GATEWAY: setting(z.enum(['on', 'off']).optional()),
  DISCORD_ATTACHMENT_LIMIT: byteSize(20 * MiB),
  PACK_THRESHOLD_BYTES: byteSize(4 * MiB),
  PACK_TARGET_BYTES: optionalByteSize,
  PACK_MAX_WAIT_MS: integer(30_000),
  COMPACT_THRESHOLD: setting(z.coerce.number().min(0).max(1).default(0.3)),
  COMPACT_MIN_AGE_DAYS: integer(7),
  MASTER_KEY_FILE: setting(z.string().optional()),
  STAGING_DIR: setting(z.string().optional()),
  STAGING_MAX_BYTES: byteSize(20 * GiB),
  CACHE_DIR: setting(z.string().optional()),
  CACHE_MAX_BYTES: byteSize(5 * GiB),
  UPLOAD_CHANNEL_CONCURRENCY: integer(2, 1),
  SCRUB_REQUESTS_PER_HOUR: integer(600),
  JOURNAL_FLUSH_INTERVAL_MS: integer(60_000, 1000),
  BACKUP_RETENTION: integer(7, 1),
  TRASH_RETENTION_DAYS: integer(30, 1),
  TRASH_SYNC_LIMIT: integer(50_000, 1),
  DEFAULT_QUOTA_BYTES: byteSize(100 * GiB),
  TEMP_PASSWORD_DAYS: integer(7, 1),
  INTERNAL_RPC_SECRET: setting(z.string().optional()),
  BOT_INTERNAL_URL: setting(z.url().optional()),
  MEDIA_INTERNAL_URL: setting(z.url().optional()),
  PUBLIC_BASE_URL: setting(z.url().optional()),
  API_PORT: port(3000),
  BOT_PORT: port(3001),
  TRUSTED_PROXY_CIDRS: setting(z.string().default('127.0.0.1/32,::1/128')),
  DFS_VERSION: setting(z.string().default('dev')),
  DFS_DEPLOYED_AT: setting(z.iso.datetime().optional()),
})

/**
 * Secrets that may come from a file instead, as Compose mounts them in
 * /run/secrets (DESIGN.md §13.2): `DATABASE_URL_FILE` holds `DATABASE_URL`.
 */
const SECRET_FILES = ['DATABASE_URL', 'INTERNAL_RPC_SECRET', 'DISCORD_BOT_TOKEN'] as const

/** The environment with each `<NAME>_FILE` read into `<NAME>`, without its line ending. */
function withSecretFiles(
  env: Record<string, string | undefined>,
  problems: string[],
): Record<string, string | undefined> {
  const resolved = { ...env }
  for (const name of SECRET_FILES) {
    const file = env[`${name}_FILE`]
    if (!file) continue
    if (env[name]) {
      problems.push(`${name}: set it or ${name}_FILE, not both`)
      continue
    }
    try {
      resolved[name] = readFileSync(file, 'utf8').trim()
    } catch {
      // The path only: never the contents.
      problems.push(`${name}_FILE: can't read ${file}`)
    }
  }
  return resolved
}

export interface LoadOptions {
  /** Which process is starting; production checks what that process needs. */
  service: Service
  /** Relative paths in settings resolve against this: the repository root. */
  rootDir: string
}

/**
 * Parses the environment into a `Config`, or throws a `ConfigError` listing
 * every problem at once. Takes the environment as an argument, so tests never
 * read the real one.
 */
export function loadConfig(env: Record<string, string | undefined>, options: LoadOptions): Config {
  const problems: string[] = []
  const parsed = envSchema.safeParse(withSecretFiles(env, problems))
  if (!parsed.success) {
    throw new ConfigError([
      ...problems,
      ...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    ])
  }
  const raw = parsed.data
  const production = raw.NODE_ENV === 'production'
  const defaults = production ? PRODUCTION : DEVELOPMENT

  function required(name: 'DATABASE_URL' | 'INTERNAL_RPC_SECRET'): string {
    const value = raw[name] ?? (production ? undefined : DEVELOPMENT[name])
    if (value === undefined) {
      problems.push(`${name}: required in production`)
      return ''
    }
    return value
  }

  const databaseUrl = required('DATABASE_URL')
  // Only the API and the bot talk to each other; commands and migrations don't.
  const internalRpcSecret =
    options.service === 'cli' && !raw.INTERNAL_RPC_SECRET ? '' : required('INTERNAL_RPC_SECRET')
  if (production && internalRpcSecret && internalRpcSecret.length < 32) {
    problems.push('INTERNAL_RPC_SECRET: use at least 32 random characters')
  }
  if (production && raw.BLOB_STORE === 'chaos') {
    problems.push('BLOB_STORE: chaos is for development only')
  }
  // Development shares the server and the bot with production, so this is
  // all that keeps it out of production's channels (D25).
  if (!production && raw.DISCORD_CATEGORY_NAME === PRODUCTION.DISCORD_CATEGORY_NAME) {
    problems.push(
      `DISCORD_CATEGORY_NAME: ${PRODUCTION.DISCORD_CATEGORY_NAME} is production's category; development uses its own, such as ${DEVELOPMENT.DISCORD_CATEGORY_NAME}`,
    )
  }
  const blobStore = raw.BLOB_STORE ?? defaults.BLOB_STORE
  if (options.service === 'bot' && blobStore === 'discord') {
    // The token to post with, and the server whose category it keeps to (D25).
    for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID'] as const) {
      if (!raw[name]) {
        problems.push(`${name}: the bot needs it to store blobs in Discord (BLOB_STORE=discord)`)
      }
    }
  }
  if (production && options.service === 'api' && !raw.PUBLIC_BASE_URL) {
    problems.push('PUBLIC_BASE_URL: required in production')
  }

  const derived = deriveSizes(raw.DISCORD_ATTACHMENT_LIMIT)
  const packTargetBytes = raw.PACK_TARGET_BYTES ?? derived.defaultPackTargetBytes
  if (derived.chunkSize <= 0) {
    problems.push('DISCORD_ATTACHMENT_LIMIT: too small to hold a chunk')
  }
  const packFrameBytes = raw.PACK_THRESHOLD_BYTES + frameOverheadBytes(raw.PACK_THRESHOLD_BYTES)
  if (packFrameBytes > derived.blobMaxBytes) {
    problems.push(
      `PACK_THRESHOLD_BYTES: too large for its frame to fit in a pack (${String(packFrameBytes)} bytes, over ${String(derived.blobMaxBytes)})`,
    )
  }
  if (packTargetBytes > derived.blobMaxBytes) {
    problems.push(
      `PACK_TARGET_BYTES: must be at most BLOB_MAX_BYTES (${String(derived.blobMaxBytes)} bytes)`,
    )
  }

  const trustedProxyCidrs = raw.TRUSTED_PROXY_CIDRS.split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean)

  if (problems.length > 0) throw new ConfigError(problems)

  const directory = (value: string) => path.resolve(options.rootDir, value)
  return {
    nodeEnv: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    databaseUrl,
    blobStore,
    localBlobDir: directory(raw.LOCAL_BLOB_DIR),
    discord: {
      botToken: raw.DISCORD_BOT_TOKEN ?? null,
      guildId: raw.DISCORD_GUILD_ID ?? null,
      categoryName: raw.DISCORD_CATEGORY_NAME ?? defaults.DISCORD_CATEGORY_NAME,
      gateway: (raw.DISCORD_GATEWAY ?? defaults.DISCORD_GATEWAY) === 'on',
      attachmentLimit: raw.DISCORD_ATTACHMENT_LIMIT,
    },
    sizes: {
      blobMaxBytes: derived.blobMaxBytes,
      chunkSize: derived.chunkSize,
      packThresholdBytes: raw.PACK_THRESHOLD_BYTES,
      packTargetBytes,
    },
    packMaxWaitMs: raw.PACK_MAX_WAIT_MS,
    compactThreshold: raw.COMPACT_THRESHOLD,
    compactMinAgeDays: raw.COMPACT_MIN_AGE_DAYS,
    masterKeyFile: directory(raw.MASTER_KEY_FILE ?? defaults.MASTER_KEY_FILE),
    stagingDir: directory(raw.STAGING_DIR ?? defaults.STAGING_DIR),
    stagingMaxBytes: raw.STAGING_MAX_BYTES,
    cacheDir: directory(raw.CACHE_DIR ?? defaults.CACHE_DIR),
    cacheMaxBytes: raw.CACHE_MAX_BYTES,
    uploadChannelConcurrency: raw.UPLOAD_CHANNEL_CONCURRENCY,
    scrubRequestsPerHour: raw.SCRUB_REQUESTS_PER_HOUR,
    journalFlushIntervalMs: raw.JOURNAL_FLUSH_INTERVAL_MS,
    backupRetention: raw.BACKUP_RETENTION,
    trashRetentionDays: raw.TRASH_RETENTION_DAYS,
    trashSyncLimit: raw.TRASH_SYNC_LIMIT,
    defaultQuotaBytes: raw.DEFAULT_QUOTA_BYTES,
    tempPasswordDays: raw.TEMP_PASSWORD_DAYS,
    internalRpcSecret,
    botInternalUrl: raw.BOT_INTERNAL_URL ?? defaults.BOT_INTERNAL_URL,
    mediaInternalUrl:
      (
        raw.MEDIA_INTERNAL_URL ??
        (raw.NODE_ENV === 'development' ? DEVELOPMENT.MEDIA_INTERNAL_URL : null)
      )?.replace(/\/+$/, '') ?? null,
    publicBaseUrl: (raw.PUBLIC_BASE_URL ?? (production ? '' : DEVELOPMENT.PUBLIC_BASE_URL)).replace(
      /\/+$/,
      '',
    ),
    apiPort: raw.API_PORT,
    botPort: raw.BOT_PORT,
    trustedProxyCidrs,
    release: { version: raw.DFS_VERSION, deployedAt: raw.DFS_DEPLOYED_AT ?? null },
  }
}

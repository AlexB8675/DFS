import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, type LoadOptions } from './config.ts'
import { GiB, MiB, parseByteSize } from './sizes.ts'

const root = path.resolve('/repo')
const api: LoadOptions = { service: 'api', rootDir: root }

/** The problems a `ConfigError` lists, or a failure if none was thrown. */
function problems(env: Record<string, string>, options: LoadOptions = api): string[] {
  try {
    loadConfig(env, options)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('Expected a ConfigError')
}

describe('parseByteSize', () => {
  it.each([
    ['10485760', 10 * MiB],
    ['512 MiB', 512 * MiB],
    ['20GiB', 20 * GiB],
    ['1.5 GiB', 1.5 * GiB],
  ])('reads %j', (text, bytes) => {
    expect(parseByteSize(text)).toBe(bytes)
  })

  it.each(['20 GB', 'lots', '-1', '1.5'])('refuses %j', (text) => {
    expect(parseByteSize(text)).toBeNull()
  })
})

describe('loadConfig', () => {
  it('derives the sizes of DESIGN §7.3 from the 10 MiB attachment limit', () => {
    const { sizes } = loadConfig({}, api)
    expect(sizes.blobMaxBytes).toBe(10 * MiB - 64 * 1024)
    expect(sizes.chunkSize).toBe(10_354_688)
    // A solo blob: one chunk plus the 38-byte frame overhead.
    expect(sizes.chunkSize + 38).toBe(10_354_726)
    expect(sizes.packTargetBytes).toBe(sizes.blobMaxBytes - 256 * 1024)
  })

  it('runs in development with no settings, against the dev compose database', () => {
    const config = loadConfig({}, api)
    expect(config).toMatchObject({
      nodeEnv: 'development',
      databaseUrl: 'postgres://dfs:dfs@localhost:5432/dfs',
      blobStore: 'local',
      discord: { categoryName: 'DFS Dev', gateway: false },
      stagingDir: path.join(root, '.data', 'staging'),
      masterKeyFile: path.join(root, '.data', 'master-key.json'),
      publicBaseUrl: 'http://localhost:5173',
      apiPort: 3000,
    })
  })

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ API_PORT: '', STAGING_MAX_BYTES: '' }, api)).toMatchObject({
      apiPort: 3000,
      stagingMaxBytes: 20 * GiB,
    })
  })

  it('has no development defaults in production', () => {
    expect(problems({ NODE_ENV: 'production' })).toEqual([
      'DATABASE_URL: required in production',
      'INTERNAL_RPC_SECRET: required in production',
      'PUBLIC_BASE_URL: required in production',
    ])
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://dfs@postgres/dfs',
      INTERNAL_RPC_SECRET: 'x'.repeat(32),
      DISCORD_BOT_TOKEN: 'a-bot-token',
      DISCORD_GUILD_ID: '1035095470428659723',
    }
    // Only the API serves the public URL.
    expect(loadConfig(production, { ...api, service: 'bot' })).toMatchObject({
      blobStore: 'discord',
      discord: { categoryName: 'DFS', gateway: true },
      stagingDir: path.resolve('/data/staging'),
      masterKeyFile: path.resolve('/run/secrets/dfs_master_key'),
    })
    expect(
      problems({ ...production, INTERNAL_RPC_SECRET: 'short' }, { ...api, service: 'bot' }),
    ).toEqual(['INTERNAL_RPC_SECRET: use at least 32 random characters'])
  })

  it('needs only the database for commands and migrations in production', () => {
    const cli = { ...api, service: 'cli' as const }
    expect(problems({ NODE_ENV: 'production' }, cli)).toEqual([
      'DATABASE_URL: required in production',
    ])
    expect(
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://dfs@postgres/dfs' }, cli)
        .databaseUrl,
    ).toBe('postgres://dfs@postgres/dfs')
  })

  it('reads secrets from files, as Compose mounts them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dfs-config-'))
    const file = (name: string, contents: string) => {
      writeFileSync(path.join(dir, name), contents)
      return path.join(dir, name)
    }
    const env = {
      NODE_ENV: 'production',
      BLOB_STORE: 'local',
      DATABASE_URL_FILE: file('database_url', 'postgres://dfs:a-password@postgres/dfs\n'),
      INTERNAL_RPC_SECRET_FILE: file('rpc', `${'s'.repeat(32)}\n`),
    }
    expect(loadConfig(env, { ...api, service: 'bot' })).toMatchObject({
      databaseUrl: 'postgres://dfs:a-password@postgres/dfs',
      internalRpcSecret: 's'.repeat(32),
    })
    const unreadable = path.join(dir, 'missing')
    expect(
      problems(
        { ...env, INTERNAL_RPC_SECRET: 'x'.repeat(32), DATABASE_URL_FILE: unreadable },
        { ...api, service: 'bot' },
      ),
    ).toEqual([
      `DATABASE_URL_FILE: can't read ${unreadable}`,
      'INTERNAL_RPC_SECRET: set it or INTERNAL_RPC_SECRET_FILE, not both',
      'DATABASE_URL: required in production',
    ])
  })

  it('takes the chaos blob store in development only', () => {
    expect(loadConfig({ BLOB_STORE: 'chaos' }, api).blobStore).toBe('chaos')
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://dfs@postgres/dfs',
      INTERNAL_RPC_SECRET: 'x'.repeat(32),
      BLOB_STORE: 'chaos',
    }
    expect(problems(production, { ...api, service: 'bot' })).toEqual([
      'BLOB_STORE: chaos is for development only',
    ])
  })

  it("keeps development out of production's Discord category", () => {
    expect(loadConfig({}, api).discord.categoryName).toBe('DFS Dev')
    expect(problems({ DISCORD_CATEGORY_NAME: 'DFS' })).toEqual([
      "DISCORD_CATEGORY_NAME: DFS is production's category; development uses its own, such as DFS Dev",
    ])
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://dfs@postgres/dfs',
      INTERNAL_RPC_SECRET: 'x'.repeat(32),
      DISCORD_BOT_TOKEN: 'a-bot-token',
      DISCORD_GUILD_ID: '1035095470428659723',
    }
    expect(loadConfig(production, { ...api, service: 'bot' }).discord.categoryName).toBe('DFS')
  })

  it('gives the bot a token and a server when it stores in Discord, and only the bot', () => {
    expect(problems({ BLOB_STORE: 'discord' }, { ...api, service: 'bot' })).toEqual([
      'DISCORD_BOT_TOKEN: the bot needs it to store blobs in Discord (BLOB_STORE=discord)',
      'DISCORD_GUILD_ID: the bot needs it to store blobs in Discord (BLOB_STORE=discord)',
    ])
    expect(loadConfig({ BLOB_STORE: 'discord' }, api).blobStore).toBe('discord')
  })

  it('refuses pack sizes that can never fit an attachment', () => {
    expect(problems({ PACK_THRESHOLD_BYTES: '10 MiB', PACK_TARGET_BYTES: '10 MiB' })).toEqual([
      expect.stringMatching(/^PACK_THRESHOLD_BYTES: must be at most 10420186 bytes/),
      expect.stringMatching(/^PACK_TARGET_BYTES: must be at most BLOB_MAX_BYTES/),
    ])
  })

  it('names each malformed setting', () => {
    expect(problems({ STAGING_MAX_BYTES: '20 GB', API_PORT: '70000', BLOB_STORE: 's3' })).toEqual([
      expect.stringMatching(/^BLOB_STORE: /),
      expect.stringMatching(/^STAGING_MAX_BYTES: expected a size like 512 MiB/),
      expect.stringMatching(/^API_PORT: /),
    ])
  })
})

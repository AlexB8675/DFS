import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { describeSettings } from './settings.ts'

describe('describeSettings (§15)', () => {
  const env = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://dfs:a-secret-password@db:5432/dfs',
    INTERNAL_RPC_SECRET: 'an-internal-secret',
    DISCORD_BOT_TOKEN: 'a-bot-token',
    STAGING_MAX_BYTES: '50 GiB',
  }
  const { settings, secrets } = describeSettings(
    loadConfig(env, { service: 'api', rootDir: '/srv/dfs' }),
    env,
  )

  it('shows what is in effect, and whether it was set or is the default', () => {
    expect(settings.find((setting) => setting.key === 'STAGING_MAX_BYTES')).toEqual({
      key: 'STAGING_MAX_BYTES',
      group: 'Disks',
      value: '50 GiB',
      set: true,
      usedBy: 'api',
    })
    expect(settings.find((setting) => setting.key === 'CACHE_MAX_BYTES')).toMatchObject({
      value: '5 GiB',
      set: false,
    })
  })

  it('says only whether secrets are set, never what they are', () => {
    expect(secrets).toEqual([
      { key: 'DATABASE_URL', usedBy: 'both', set: true },
      { key: 'INTERNAL_RPC_SECRET', usedBy: 'both', set: true },
      { key: 'DISCORD_BOT_TOKEN', usedBy: 'bot', set: true },
      { key: 'MASTER_KEY_FILE', usedBy: 'api', set: false },
    ])
    const shown = JSON.stringify({ settings, secrets })
    for (const secret of ['a-secret-password', 'an-internal-secret', 'a-bot-token']) {
      expect(shown).not.toContain(secret)
    }
  })

  it('counts a secret given as a file as set, if the file holds one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dfs-settings-'))
    const file = (name: string, contents: string) => {
      writeFileSync(path.join(dir, name), contents)
      return path.join(dir, name)
    }
    const fromFiles = describeSettings(loadConfig(env, { service: 'api', rootDir: '/srv/dfs' }), {
      MASTER_KEY_FILE: '/run/secrets/dfs_master_key',
      DATABASE_URL_FILE: file('database_url', 'postgres://dfs:a-password@postgres/dfs\n'),
      DISCORD_BOT_TOKEN_FILE: file('discord_bot_token', '\n'),
      INTERNAL_RPC_SECRET_FILE: path.join(dir, 'missing'),
    })
    expect(fromFiles.secrets.filter((secret) => secret.set).map((secret) => secret.key)).toEqual([
      'DATABASE_URL',
      'MASTER_KEY_FILE',
    ])
    expect(JSON.stringify(fromFiles)).not.toContain('a-password')
  })

  it('says which service reads each, so only those both read are compared', () => {
    const users = (usedBy: string) =>
      settings.filter((setting) => setting.usedBy === usedBy).map((setting) => setting.key)
    // Each container may be given only what it reads.
    expect(users('api')).toEqual(
      expect.arrayContaining([
        'PUBLIC_BASE_URL',
        'STAGING_MAX_BYTES',
        'CACHE_DIR',
        'CACHE_MAX_BYTES',
      ]),
    )
    expect(users('bot')).toEqual(
      expect.arrayContaining(['DISCORD_GUILD_ID', 'DISCORD_GATEWAY', 'PACK_MAX_WAIT_MS']),
    )
    // Where both look, they must agree: the same staging, the same chunks.
    expect(users('both')).toEqual(
      expect.arrayContaining([
        'BLOB_STORE',
        'STAGING_DIR',
        'LOCAL_BLOB_DIR',
        'DISCORD_ATTACHMENT_LIMIT',
      ]),
    )
  })
})

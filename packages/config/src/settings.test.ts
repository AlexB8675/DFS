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
    })
    expect(settings.find((setting) => setting.key === 'CACHE_MAX_BYTES')).toMatchObject({
      value: '5 GiB',
      set: false,
    })
  })

  it('says only whether secrets are set, never what they are', () => {
    expect(secrets).toEqual([
      { key: 'DATABASE_URL', set: true },
      { key: 'INTERNAL_RPC_SECRET', set: true },
      { key: 'DISCORD_BOT_TOKEN', set: true },
      { key: 'MASTER_KEY_FILE', set: false },
    ])
    const shown = JSON.stringify({ settings, secrets })
    for (const secret of ['a-secret-password', 'an-internal-secret', 'a-bot-token']) {
      expect(shown).not.toContain(secret)
    }
  })
})

import type { SecretView, SettingView } from '@dfs/config'
import { describe, expect, it } from 'vitest'
import { mergeSettings } from './system-info.ts'

// Admin → System (DESIGN.md §15): each setting as the service reading it has
// it, and only those both read compared, since each container may be given
// only its own.

const setting = (
  key: string,
  usedBy: SettingView['usedBy'],
  value: string,
  set = true,
): SettingView => ({ key, group: 'Storage', value, set, usedBy })

const api = {
  settings: [
    setting('STAGING_DIR', 'both', '/data/staging'),
    setting('CACHE_DIR', 'api', '/data/cache'),
    setting('PACK_MAX_WAIT_MS', 'bot', '30000', false),
  ],
  secrets: [
    { key: 'DATABASE_URL', usedBy: 'both', set: true },
    { key: 'DISCORD_BOT_TOKEN', usedBy: 'bot', set: false },
    { key: 'MASTER_KEY_FILE', usedBy: 'api', set: true },
  ] satisfies SecretView[],
}

describe('mergeSettings (§15)', () => {
  it('marks a setting both read where the bot’s differs, and no other', () => {
    const { settings } = mergeSettings(api, {
      settings: [
        { key: 'STAGING_DIR', value: '/srv/staging', set: true },
        { key: 'CACHE_DIR', value: '/elsewhere', set: true },
        { key: 'PACK_MAX_WAIT_MS', value: '30000', set: false },
      ],
      secrets: [],
    })
    expect(settings.find((entry) => entry.key === 'STAGING_DIR')?.botValue).toBe('/srv/staging')
    // The API alone reads it: the bot's value says nothing.
    expect(settings.find((entry) => entry.key === 'CACHE_DIR')).toMatchObject({
      value: '/data/cache',
      botValue: null,
    })
  })

  it('shows what only the bot reads as the bot has it, its secrets too', () => {
    const merged = mergeSettings(api, {
      settings: [{ key: 'PACK_MAX_WAIT_MS', value: '2000', set: true }],
      secrets: [{ key: 'DISCORD_BOT_TOKEN', set: true }],
    })
    expect(merged.settings.find((entry) => entry.key === 'PACK_MAX_WAIT_MS')).toMatchObject({
      value: '2000',
      set: true,
      botValue: null,
    })
    expect(merged.secrets).toEqual([
      { key: 'DATABASE_URL', usedBy: 'both', set: true },
      { key: 'DISCORD_BOT_TOKEN', usedBy: 'bot', set: true },
      { key: 'MASTER_KEY_FILE', usedBy: 'api', set: true },
    ])
  })

  it('keeps the API’s view while the bot doesn’t answer, and doesn’t guess its secrets', () => {
    const merged = mergeSettings(api, null)
    expect(merged.settings.map((entry) => [entry.key, entry.value, entry.botValue])).toEqual([
      ['STAGING_DIR', '/data/staging', null],
      ['CACHE_DIR', '/data/cache', null],
      ['PACK_MAX_WAIT_MS', '30000', null],
    ])
    expect(merged.secrets.find((secret) => secret.key === 'DISCORD_BOT_TOKEN')?.set).toBeNull()
  })
})

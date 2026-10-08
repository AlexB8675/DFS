import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MasterKeys } from '@dfs/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEDIA_TOKEN_LIFETIME_MS, mediaToken, mediaTokenValid } from './token.ts'

let dir: string
let keys: MasterKeys
const version = '01a11353-edcb-7c90-8918-70850edcd1f9'
const other = '01a11353-edcb-7c90-8918-70850edcd1fa'

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dfs-media-token-'))
  await MasterKeys.createFile(path.join(dir, 'master-key.json'))
  keys = await MasterKeys.fromFile(path.join(dir, 'master-key.json'))
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('media tokens (§6.7)', () => {
  it('let the media service read the version they were made for, for a few hours', async () => {
    const now = Date.now()
    const token = await mediaToken(keys, version, now)
    expect(await mediaTokenValid(keys, version, token, now)).toBe(true)
    expect(await mediaTokenValid(keys, version, token, now + MEDIA_TOKEN_LIFETIME_MS - 1)).toBe(
      true,
    )
    expect(await mediaTokenValid(keys, version, token, now + MEDIA_TOKEN_LIFETIME_MS)).toBe(false)
  })

  it('read no other version, and can’t be altered or made up', async () => {
    const token = await mediaToken(keys, version)
    expect(await mediaTokenValid(keys, other, token)).toBe(false)
    const [expiry = '', mac = ''] = token.split('.')
    // A later expiry with the same MAC.
    expect(await mediaTokenValid(keys, version, `${String(Number(expiry) + 1)}.${mac}`)).toBe(false)
    expect(await mediaTokenValid(keys, version, `${expiry}.${'A'.repeat(43)}`)).toBe(false)
    expect(await mediaTokenValid(keys, version, '')).toBe(false)
    expect(await mediaTokenValid(keys, version, 'not a token')).toBe(false)
  })

  it('aren’t a share’s unlock cookie, signed with the same key', async () => {
    // The unlock cookie signs `share-unlock:<share>:<password version>:<expiry>`.
    const expiresAt = Date.now() + 60_000
    const unlock = Buffer.from(
      await keys.sign(`share-unlock:${version}:1:${String(expiresAt)}`),
    ).toString('base64url')
    expect(await mediaTokenValid(keys, version, `${String(expiresAt)}.${unlock}`)).toBe(false)
  })
})

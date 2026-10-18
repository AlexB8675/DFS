import { MasterKeys } from '@dfs/crypto'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lookupTokenHashes, newLongToken, storedTokenHash } from './tokens.ts'

describe('share token hashes', () => {
  let dir: string
  let file: string
  let keys: MasterKeys

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dfs-keys-'))
    file = path.join(dir, 'master-key.json')
    await MasterKeys.createFile(file)
    keys = await MasterKeys.fromFile(file)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('makes a long token of 128 random bits, as base64url', () => {
    const token = newLongToken()
    expect(token).toMatch(/^[\w-]{22}$/)
    expect(newLongToken()).not.toBe(token)
  })

  it('hashes a long token with SHA-256, as before', async () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUv'
    const sha = createHash('sha256').update(token).digest()
    expect(await storedTokenHash(keys, token)).toEqual(sha)
    expect(await lookupTokenHashes(keys, token)).toEqual([sha])
  })

  it('hashes a code under a key from the master key, not SHA-256', async () => {
    const stored = await storedTokenHash(keys, 'k7hm2q')
    expect(stored).not.toEqual(createHash('sha256').update('k7hm2q').digest())
    const key = await keys.deriveBits(keys.currentId, 'dfs1-share-code')
    expect(stored).toEqual(createHmac('sha256', key).update('k7hm2q').digest())
    expect(await lookupTokenHashes(keys, 'k7hm2q')).toEqual([stored])
  })

  it('finds a code made before the master key was rotated', async () => {
    const stored = await storedTokenHash(keys, 'k7hm2q')
    // A new key file: the old key kept as k1, a new current k2.
    const old = JSON.parse(await readFile(file, 'utf8')) as {
      current: string
      keys: Record<string, string>
    }
    const rotated = path.join(dir, 'rotated.json')
    await writeFile(
      rotated,
      JSON.stringify({
        current: 'k2',
        keys: { ...old.keys, k2: randomBytes(32).toString('base64') },
      }),
    )
    const after = await MasterKeys.fromFile(rotated)
    expect(after.keyIds()).toEqual(['k2', 'k1'])
    expect(await lookupTokenHashes(after, 'k7hm2q')).toContainEqual(stored)
    // New links are stored under the new current key, and found first.
    const [first] = await lookupTokenHashes(after, 'k7hm2q')
    expect(first).toEqual(await storedTokenHash(after, 'k7hm2q'))
    expect(first).not.toEqual(stored)
  })
})

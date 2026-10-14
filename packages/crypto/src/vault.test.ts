import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MasterKeys } from './keys.ts'
import {
  generateRecoveryKey,
  generateVaultKey,
  generateVaultSalt,
  normalizeRecoveryKey,
} from './vault.ts'

describe('deriving from a master key (§7.7)', () => {
  let dir: string
  let keys: MasterKeys
  let otherKeys: MasterKeys

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dfs-vault-keys-'))
    await MasterKeys.createFile(path.join(dir, 'a.json'))
    await MasterKeys.createFile(path.join(dir, 'b.json'))
    keys = await MasterKeys.fromFile(path.join(dir, 'a.json'))
    otherKeys = await MasterKeys.fromFile(path.join(dir, 'b.json'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('derives the same 32 bytes every time for one purpose', async () => {
    const first = await keys.deriveBits(keys.currentId, 'dfs1-vault-code')
    const second = await keys.deriveBits(keys.currentId, 'dfs1-vault-code')
    expect(first).toHaveLength(32)
    expect(second).toEqual(first)
  })

  it('derives other bytes for another purpose', async () => {
    const code = await keys.deriveBits(keys.currentId, 'dfs1-vault-code')
    const other = await keys.deriveBits(keys.currentId, 'dfs1-other')
    expect(other).not.toEqual(code)
  })

  it('derives from the key itself, not from its ID', async () => {
    // Both files' current key is "k1", so only the key bytes can differ.
    expect(otherKeys.currentId).toBe(keys.currentId)
    const mine = await keys.deriveBits(keys.currentId, 'dfs1-vault-code')
    const theirs = await otherKeys.deriveBits(otherKeys.currentId, 'dfs1-vault-code')
    expect(theirs).not.toEqual(mine)
  })

  it('refuses a key that is not in the file', async () => {
    await expect(keys.deriveBits('nope', 'x')).rejects.toThrow(/not in the key file/)
  })
})

describe('recovery keys (§7.7)', () => {
  it('makes six groups of four characters from the alphabet, never the same twice', () => {
    const key = generateRecoveryKey()
    expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(generateRecoveryKey()).not.toBe(key)
  })

  it('reads a key back as its 24 canonical characters', () => {
    const key = generateRecoveryKey()
    expect(normalizeRecoveryKey(key)).toBe(key.replaceAll('-', ''))
  })

  it('does not mind case, spaces for dashes, or spaces around it', () => {
    const key = generateRecoveryKey()
    const canonical = key.replaceAll('-', '')
    expect(normalizeRecoveryKey(key.toLowerCase())).toBe(canonical)
    expect(normalizeRecoveryKey(key.replaceAll('-', ' '))).toBe(canonical)
    expect(normalizeRecoveryKey(`  ${key}  `)).toBe(canonical)
  })

  it('reads O as 0, and I and L as 1', () => {
    expect(normalizeRecoveryKey('ooLI-2233-4455-6677-8899-AABB')).toBe('00112233445566778899AABB')
  })

  it('rejects what cannot be a recovery key', () => {
    expect(normalizeRecoveryKey('')).toBeNull()
    expect(normalizeRecoveryKey('too short')).toBeNull()
    expect(normalizeRecoveryKey('0123456789ABCDEFGHJKMNP')).toBeNull() // 23 characters
    expect(normalizeRecoveryKey('0123456789ABCDEFGHJKMNPQR')).toBeNull() // 25 characters
    expect(normalizeRecoveryKey('0123456789ABCDEFGHJKMNPU')).toBeNull() // U is not in the alphabet
  })
})

describe('vault keys and salts (§7.7)', () => {
  it('makes a 32-byte vault key, never the same twice', () => {
    const key = generateVaultKey()
    expect(key).toHaveLength(32)
    expect(generateVaultKey()).not.toEqual(key)
  })

  it('makes a 16-byte salt', () => {
    expect(generateVaultSalt()).toHaveLength(16)
  })
})

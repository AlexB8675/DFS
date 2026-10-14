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
  openVaultKeyFromSession,
  sealVaultKeyForSession,
  unwrapVaultKeyByCode,
  unwrapVaultKeyByRecovery,
  wrapVaultKeyByCode,
  wrapVaultKeyByRecovery,
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

describe('wrapping the vault key (§7.7)', { timeout: 30_000 }, () => {
  const userId = '0192f3a4-5b6c-7d8e-9f00-112233445566'
  const otherUserId = '0192f3a4-5b6c-7d8e-9f00-112233445567'
  const code = '123456'

  let dir: string
  let keys: MasterKeys
  let otherKeys: MasterKeys
  const vaultKey = generateVaultKey()
  const salt = generateVaultSalt()
  const recoveryKey = generateRecoveryKey()
  let codeWrap: Uint8Array
  let recoveryWrap: Uint8Array

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dfs-vault-wrap-'))
    await MasterKeys.createFile(path.join(dir, 'a.json'))
    await MasterKeys.createFile(path.join(dir, 'b.json'))
    keys = await MasterKeys.fromFile(path.join(dir, 'a.json'))
    otherKeys = await MasterKeys.fromFile(path.join(dir, 'b.json'))
    codeWrap = await wrapVaultKeyByCode(keys, vaultKey, code, salt, userId)
    recoveryWrap = await wrapVaultKeyByRecovery(vaultKey, recoveryKey, userId)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('unwraps a code wrap with the same code, and starts it with the master key ID', async () => {
    expect(codeWrap[0]).toBe(2)
    expect(new TextDecoder().decode(codeWrap.subarray(1, 3))).toBe(keys.currentId)
    expect(keys.currentId).toBe('k1')
    expect(await unwrapVaultKeyByCode(keys, codeWrap, code, salt, userId)).toEqual(vaultKey)
  })

  it('gives null for a wrong code', async () => {
    expect(await unwrapVaultKeyByCode(keys, codeWrap, '654321', salt, userId)).toBeNull()
  })

  it('gives null for another salt or another user', async () => {
    expect(await unwrapVaultKeyByCode(keys, codeWrap, code, generateVaultSalt(), userId)).toBeNull()
    expect(await unwrapVaultKeyByCode(keys, codeWrap, code, salt, otherUserId)).toBeNull()
  })

  it('gives null with another master key of the same ID', async () => {
    expect(otherKeys.currentId).toBe(keys.currentId)
    expect(await unwrapVaultKeyByCode(otherKeys, codeWrap, code, salt, userId)).toBeNull()
  })

  it('reads the code as NFC', async () => {
    const wrapped = await wrapVaultKeyByCode(keys, vaultKey, 'café123', salt, userId)
    expect(await unwrapVaultKeyByCode(keys, wrapped, 'café123', salt, userId)).toEqual(vaultKey)
  })

  it('gives null for a truncated or empty code wrap', async () => {
    expect(await unwrapVaultKeyByCode(keys, codeWrap.subarray(0, 5), code, salt, userId)).toBeNull()
    expect(await unwrapVaultKeyByCode(keys, new Uint8Array(0), code, salt, userId)).toBeNull()
  })

  it('unwraps a recovery wrap with the key as shown, lowercased, or with spaces for dashes', async () => {
    expect(await unwrapVaultKeyByRecovery(recoveryWrap, recoveryKey, userId)).toEqual(vaultKey)
    expect(await unwrapVaultKeyByRecovery(recoveryWrap, recoveryKey.toLowerCase(), userId)).toEqual(
      vaultKey,
    )
    expect(
      await unwrapVaultKeyByRecovery(recoveryWrap, recoveryKey.replaceAll('-', ' '), userId),
    ).toEqual(vaultKey)
  })

  it('gives null for another recovery key, another user, or something that is no key', async () => {
    expect(await unwrapVaultKeyByRecovery(recoveryWrap, generateRecoveryKey(), userId)).toBeNull()
    expect(await unwrapVaultKeyByRecovery(recoveryWrap, recoveryKey, otherUserId)).toBeNull()
    expect(await unwrapVaultKeyByRecovery(recoveryWrap, 'too short', userId)).toBeNull()
  })

  it('refuses to wrap under something that is no recovery key', async () => {
    await expect(wrapVaultKeyByRecovery(vaultKey, 'nope', userId)).rejects.toThrow()
  })

  it("does not read a code wrap's bytes as a recovery wrap", async () => {
    expect(await unwrapVaultKeyByRecovery(codeWrap.subarray(3), recoveryKey, userId)).toBeNull()
  })

  it('seals the vault key for a session, and opens it only with that token and session', async () => {
    const token = 'a'.repeat(43)
    const sessionId = 'f'.repeat(64)
    const sealed = await sealVaultKeyForSession(vaultKey, token, sessionId)
    expect(await openVaultKeyFromSession(sealed, token, sessionId)).toEqual(vaultKey)
    expect(await openVaultKeyFromSession(sealed, 'b'.repeat(43), sessionId)).toBeNull()
    expect(await openVaultKeyFromSession(sealed, token, 'e'.repeat(64))).toBeNull()
  })

  it('seals the same key differently each time', async () => {
    const token = 'a'.repeat(43)
    const sessionId = 'f'.repeat(64)
    const first = await sealVaultKeyForSession(vaultKey, token, sessionId)
    const second = await sealVaultKeyForSession(vaultKey, token, sessionId)
    expect(second).not.toEqual(first)
  })
})

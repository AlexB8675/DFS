// The vault's keys (DESIGN.md §7.7). An account's vault has a random vault
// key, wrapped under a key from its lock code and under one from its
// recovery key. The recovery key is shown once: 24 characters of Crockford's
// base32 (120 random bits), in six groups of four, read back forgivingly.

import { argon2 } from 'node:crypto'
import { promisify } from 'node:util'
import { uuidBytes } from './context.ts'
import type { AesKey, MasterKeys } from './keys.ts'

export const VAULT_KEY_BYTES = 32
export const VAULT_SALT_BYTES = 16

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_LENGTH = 24

/** A fresh vault key. */
export function generateVaultKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES))
}

/** A fresh salt for deriving a vault's code key. */
export function generateVaultSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_SALT_BYTES))
}

/** A recovery key as shown, `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryKey(): string {
  // 32 divides 256, so taking each byte's low five bits picks every character evenly.
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH))
  const characters = Array.from(bytes, (byte) => RECOVERY_ALPHABET.charAt(byte & 31)).join('')
  const groups: string[] = []
  for (let start = 0; start < RECOVERY_LENGTH; start += 4)
    groups.push(characters.slice(start, start + 4))
  return groups.join('-')
}

/**
 * A recovery key as typed back, in its 24 canonical characters, or `null` if
 * it can't be one: case, spaces and dashes don't matter, and `O`, `I` and `L`
 * read as the `0` and `1` they look like.
 */
export function normalizeRecoveryKey(input: string): string | null {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1')
  if (canonical.length !== RECOVERY_LENGTH) return null
  for (const character of canonical) {
    if (!RECOVERY_ALPHABET.includes(character)) return null
  }
  return canonical
}

// argon2id with 64 MiB and three passes (§7.7): each try at a code costs that
// much, for someone holding the database and the master key both.
const CODE_STRETCH = { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32 } as const
const NONCE_BYTES = 12
const stretch = promisify(argon2)
const utf8 = (text: string) => new TextEncoder().encode(text)

/**
 * The vault key wrapped under the code, with the current master key:
 * `key_id length (1) | key_id | nonce (12) | ciphertext (32) | tag (16)`.
 */
export async function wrapVaultKeyByCode(
  keys: MasterKeys,
  vaultKey: Uint8Array,
  code: string,
  salt: Uint8Array,
  userId: string,
): Promise<Uint8Array> {
  const keyId = utf8(keys.currentId)
  const key = await codeKey(keys, keys.currentId, code, salt, userId)
  const sealed = await seal(key, vaultKey, wrapAad('code', userId))
  const wrapped = new Uint8Array(1 + keyId.length + sealed.length)
  wrapped[0] = keyId.length
  wrapped.set(keyId, 1)
  wrapped.set(sealed, 1 + keyId.length)
  return wrapped
}

/** The vault key, or `null` for a wrong code (or a wrap that isn't this user's). */
export async function unwrapVaultKeyByCode(
  keys: MasterKeys,
  wrapped: Uint8Array,
  code: string,
  salt: Uint8Array,
  userId: string,
): Promise<Uint8Array | null> {
  const keyIdLength = wrapped[0] ?? 0
  if (keyIdLength === 0 || wrapped.length <= 1 + keyIdLength) return null
  const keyId = new TextDecoder().decode(wrapped.subarray(1, 1 + keyIdLength))
  const key = await codeKey(keys, keyId, code, salt, userId)
  return open(key, wrapped.subarray(1 + keyIdLength), wrapAad('code', userId))
}

/** The vault key wrapped under a recovery key (`nonce | ciphertext | tag`). */
export async function wrapVaultKeyByRecovery(
  vaultKey: Uint8Array,
  recoveryKey: string,
  userId: string,
): Promise<Uint8Array> {
  const canonical = normalizeRecoveryKey(recoveryKey)
  if (!canonical) throw new Error('Not a recovery key.')
  return seal(await recoveryKeyKey(canonical, userId), vaultKey, wrapAad('recovery', userId))
}

/** The vault key, or `null` for a wrong or malformed recovery key. */
export async function unwrapVaultKeyByRecovery(
  wrapped: Uint8Array,
  recoveryKey: string,
  userId: string,
): Promise<Uint8Array | null> {
  const canonical = normalizeRecoveryKey(recoveryKey)
  if (!canonical) return null
  return open(await recoveryKeyKey(canonical, userId), wrapped, wrapAad('recovery', userId))
}

/**
 * The vault key sealed for one session, under a key from its cookie's token,
 * which the database never holds (§7.1, §7.7).
 */
export async function sealVaultKeyForSession(
  vaultKey: Uint8Array,
  token: string,
  sessionId: string,
): Promise<Uint8Array> {
  return seal(await sessionKey(token, sessionId), vaultKey, sessionAad(sessionId))
}

/** The vault key from a session's sealed copy, or `null` with another token or session. */
export async function openVaultKeyFromSession(
  sealed: Uint8Array,
  token: string,
  sessionId: string,
): Promise<Uint8Array | null> {
  return open(await sessionKey(token, sessionId), sealed, sessionAad(sessionId))
}

async function codeKey(
  keys: MasterKeys,
  keyId: string,
  code: string,
  salt: Uint8Array,
  userId: string,
): Promise<AesKey> {
  const stretched = await stretch('argon2id', {
    message: code.normalize('NFC'),
    nonce: salt,
    ...CODE_STRETCH,
  })
  const salted = await keys.deriveBits(keyId, 'dfs1-vault-code')
  return derivedKey(stretched, salted, join(utf8('dfs1-vault-code'), uuidBytes(userId)))
}

function recoveryKeyKey(canonical: string, userId: string): Promise<AesKey> {
  return derivedKey(
    utf8(canonical),
    new Uint8Array(32),
    join(utf8('dfs1-vault-recovery'), uuidBytes(userId)),
  )
}

function sessionKey(token: string, sessionId: string): Promise<AesKey> {
  return derivedKey(utf8(token), new Uint8Array(32), utf8(`dfs1-vault-session|${sessionId}`))
}

async function derivedKey(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<AesKey> {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** What a wrap is, bound in: a code's wrap can't pass for a recovery key's, or another user's. */
function wrapAad(kind: 'code' | 'recovery', userId: string): Uint8Array {
  return join(utf8(`dfs1-vault-key|${kind}|`), uuidBytes(userId))
}

function sessionAad(sessionId: string): Uint8Array {
  return utf8(`dfs1-vault-session|${sessionId}`)
}

async function seal(key: AesKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    key,
    plaintext,
  )
  return join(nonce, new Uint8Array(sealed))
}

/** The plaintext, or `null` when the tag doesn't match: a wrong key, or other bytes. */
async function open(key: AesKey, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length <= NONCE_BYTES) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, NONCE_BYTES), additionalData: aad },
      key,
      sealed.subarray(NONCE_BYTES),
    )
    return new Uint8Array(plaintext)
  } catch {
    return null
  }
}

function join(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

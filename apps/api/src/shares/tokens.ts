import type { MasterKeys } from '@dfs/crypto'
import { isShortCode } from '@dfs/shared'
import { createHash, createHmac, randomBytes } from 'node:crypto'

// How a share link's token is found in the database (DESIGN.md §7.5, D46).
//
// A long token has 128 random bits, so its SHA-256 is enough: a stolen dump
// can't be searched for it. A short link's code has only about 1.45 billion
// values, so under a plain SHA-256 a stolen dump would give every code away
// by trying them all (§7.4). A code is therefore stored under an HMAC, keyed
// from the master key, which the dump doesn't hold.

/** Names the key derived from the master key for hashing short codes. */
const CODE_KEY_INFO = 'dfs1-share-code'

/** A new long token: 128 random bits as base64url. */
export function newLongToken(): string {
  return randomBytes(16).toString('base64url')
}

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/** The HMAC of a code under the master key `keyId`. */
async function codeHash(keys: MasterKeys, keyId: string, code: string): Promise<Buffer> {
  const key = await keys.deriveBits(keyId, CODE_KEY_INFO)
  return createHmac('sha256', key).update(code).digest()
}

/**
 * What a new link's token is stored as: the SHA-256 of a long token, or the
 * HMAC of a code under the current master key. `token` must already be
 * canonical (`canonicalShareToken`).
 */
export async function storedTokenHash(keys: MasterKeys, token: string): Promise<Buffer> {
  return isShortCode(token) ? codeHash(keys, keys.currentId, token) : sha256(token)
}

/**
 * Every value a link with this token may be stored as, to look it up by. A
 * code may have been made under a master key since retired, so it has one
 * hash for each key in the key file, the current key's first. `token` must
 * already be canonical (`canonicalShareToken`).
 */
export async function lookupTokenHashes(keys: MasterKeys, token: string): Promise<Buffer[]> {
  if (!isShortCode(token)) return [sha256(token)]
  return Promise.all(keys.keyIds().map((keyId) => codeHash(keys, keyId, token)))
}

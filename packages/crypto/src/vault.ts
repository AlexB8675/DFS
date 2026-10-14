// The vault's keys (DESIGN.md §7.7). An account's vault has a random vault
// key, wrapped under a key from its lock code and under one from its
// recovery key. The recovery key is shown once: 24 characters of Crockford's
// base32 (120 random bits), in six groups of four, read back forgivingly.

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

// Web Crypto, in browsers and Node alike; this package has neither's type library.
declare const crypto: { getRandomValues: <T extends Uint8Array>(array: T) => T }

/** Letters and digits that can't be mistaken for one another when read aloud or copied by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const GROUPS = 4
const GROUP_LENGTH = 4

/**
 * A temporary password for a new account or a reset (DESIGN.md §7.1), such
 * as `k7mp-x3qa-9wtd-hc4e`: about 79 bits from a CSPRNG, and easy to pass on.
 */
export function generatePassword(): string {
  const length = GROUPS * GROUP_LENGTH
  const chars: string[] = []
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % ALPHABET.length)
  while (chars.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && chars.length < length) chars.push(ALPHABET.charAt(byte % ALPHABET.length))
    }
  }
  const groups: string[] = []
  for (let i = 0; i < length; i += GROUP_LENGTH) {
    groups.push(chars.slice(i, i + GROUP_LENGTH).join(''))
  }
  return groups.join('-')
}

// Web Crypto, in browsers and Node alike; this package has neither's type library.
declare const crypto: { getRandomValues: <T extends Uint8Array>(array: T) => T }

/**
 * What a short share link's code is made of (DESIGN.md §7.5, D46): the digits,
 * the lowercase letters but `i`, `l` and `o`, and the hyphen, which TVs'
 * keyboards have. Lowercase only, so a code is easy to say and to type.
 */
export const SHORT_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstuvwxyz-'
export const SHORT_CODE_LENGTH = 6

/**
 * A code is typed by hand or read out, on a TV or someone else's phone, so the
 * hyphen is kept off both ends (an app turning text into a link may leave a
 * last punctuation mark out) and is never doubled (phones turn `--` into a
 * dash). This is the whole rule: 1,451,567,304 codes.
 */
const SHORT_CODE = /^[0-9a-hjkmnp-z](?:[0-9a-hjkmnp-z]|-(?!-)){4}[0-9a-hjkmnp-z]$/

/** Whether `token` is a short code exactly as `newShortCode` makes one. */
export function isShortCode(token: string): boolean {
  return SHORT_CODE.test(token)
}

/** Six random characters from the alphabet, hyphen rules not yet applied. */
function drawCharacters(): string {
  const chars: string[] = []
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % SHORT_CODE_ALPHABET.length)
  while (chars.length < SHORT_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH * 2))) {
      if (byte < limit && chars.length < SHORT_CODE_LENGTH) {
        chars.push(SHORT_CODE_ALPHABET.charAt(byte % SHORT_CODE_ALPHABET.length))
      }
    }
  }
  return chars.join('')
}

/**
 * A new short code from a CSPRNG. A draw that breaks the hyphen rules is
 * thrown away whole rather than mended, so every code is equally likely.
 */
export function newShortCode(): string {
  let code = drawCharacters()
  while (!isShortCode(code)) code = drawCharacters()
  return code
}

/**
 * The share token as the API looks it up. A token of six characters is read as
 * a code typed carelessly: capitals are lowercase, `o` is `0`, and `i` and `l`
 * are `1`. If that makes a code, that is the token; any other token, long ones
 * included (case-sensitive base64url), comes back exactly as it was.
 */
export function canonicalShareToken(token: string): string {
  if (token.length !== SHORT_CODE_LENGTH) return token
  const read = token.toLowerCase().replaceAll('o', '0').replaceAll('i', '1').replaceAll('l', '1')
  return isShortCode(read) ? read : token
}

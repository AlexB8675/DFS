import type { MasterKeys } from '@dfs/crypto'

// The media service's tokens (DESIGN.md §6.7): it reads a version's
// plaintext from the API only with one the API signed for that version
// alone, valid a few hours, so a flaw in ffmpeg reaches only the files it
// is asked to play. Signed like share-unlock cookies (§7.5), under a claim
// of its own, so neither can pass for the other.

/** Long enough for a film to be examined, and read whole for its subtitles. */
export const MEDIA_TOKEN_LIFETIME_MS = 6 * 60 * 60_000

/** A token for reading `versionId`: `<expiry ms>.<HMAC, base64url>`. */
export async function mediaToken(
  keys: Pick<MasterKeys, 'sign'>,
  versionId: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + MEDIA_TOKEN_LIFETIME_MS
  const mac = Buffer.from(await keys.sign(claim(versionId, expiresAt))).toString('base64url')
  return `${String(expiresAt)}.${mac}`
}

/** Whether `token` is a live token for `versionId`. */
export async function mediaTokenValid(
  keys: Pick<MasterKeys, 'verify'>,
  versionId: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const match = /^(\d{1,16})\.([\w-]{43})$/.exec(token)
  if (!match?.[1] || !match[2]) return false
  const expiresAt = Number(match[1])
  if (expiresAt <= now) return false
  return keys.verify(claim(versionId, expiresAt), Buffer.from(match[2], 'base64url'))
}

function claim(versionId: string, expiresAt: number): string {
  return `media-read:${versionId}:${String(expiresAt)}`
}

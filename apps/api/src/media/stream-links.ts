import type { MasterKeys } from '@dfs/crypto'

// Stream links (DESIGN.md §6.7): an address another player opens (VLC) to
// play one version of an audio or video file, without DFS's session. Signed
// like media tokens and share-unlock cookies, under a claim of their own, so
// none can pass for another; valid 12 hours, and only while whoever made one
// may still read the file: the user, with the file in their drive and their
// account enabled, or the share link, still live and with the same password.

/** A film and a pause, without leaving an address that works for days. */
export const STREAM_LINK_LIFETIME_MS = 12 * 60 * 60_000

/** Whose link it is: a user's, or a share link's, at its password's version. */
export type StreamScope =
  { kind: 'user'; userId: string } | { kind: 'share'; shareId: string; passwordVersion: number }

/** What a stream link lets its holder read, and until when (ms). */
export interface StreamGrant {
  scope: StreamScope
  nodeId: string
  versionId: string
  expiresAt: number
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TOKEN = new RegExp(
  `^(?:u\\.(${UUID})|s\\.(${UUID})\\.(\\d{1,9}))\\.(${UUID})\\.(${UUID})\\.(\\d{1,16})\\.([\\w-]{43})$`,
)

/**
 * The token in a stream link's address: `u.<user>` or `s.<share>.<password
 * version>`, then `<node>.<version>.<expiry ms>.<HMAC, base64url>`.
 */
export async function streamToken(
  keys: Pick<MasterKeys, 'sign'>,
  grant: StreamGrant,
): Promise<string> {
  const mac = Buffer.from(await keys.sign(claim(grant))).toString('base64url')
  const { scope } = grant
  const whose =
    scope.kind === 'user'
      ? `u.${scope.userId}`
      : `s.${scope.shareId}.${String(scope.passwordVersion)}`
  return `${whose}.${grant.nodeId}.${grant.versionId}.${String(grant.expiresAt)}.${mac}`
}

/** What `token` grants, if it is a stream link's and still live; otherwise `null`. */
export async function readStreamToken(
  keys: Pick<MasterKeys, 'verify'>,
  token: string,
  now = Date.now(),
): Promise<StreamGrant | null> {
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, userId, shareId, passwordVersion, nodeId, versionId, expires, mac] = match
  if (!nodeId || !versionId || !expires || !mac) return null
  const expiresAt = Number(expires)
  if (expiresAt <= now) return null
  const scope: StreamScope | null = userId
    ? { kind: 'user', userId }
    : shareId && passwordVersion
      ? { kind: 'share', shareId, passwordVersion: Number(passwordVersion) }
      : null
  if (!scope) return null
  const grant = { scope, nodeId, versionId, expiresAt }
  // As written, alone: its last character's two unused bits changed would decode the same.
  const bytes = Buffer.from(mac, 'base64url')
  if (bytes.toString('base64url') !== mac) return null
  return (await keys.verify(claim(grant), bytes)) ? grant : null
}

/** A stream link's token, hidden in an address for the logs: it lets anyone read the file. */
export function hideStreamToken(url: string): string {
  return url.replace(/^(\/api\/stream\/)[^/?]+/, '$1…')
}

function claim(grant: StreamGrant): string {
  const { scope } = grant
  const whose =
    scope.kind === 'user'
      ? `user:${scope.userId}`
      : `share:${scope.shareId}:${String(scope.passwordVersion)}`
  return `stream:${whose}:${grant.nodeId}:${grant.versionId}:${String(grant.expiresAt)}`
}

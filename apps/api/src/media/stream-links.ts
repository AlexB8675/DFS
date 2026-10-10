import type { MasterKeys } from '@dfs/crypto'

// Stream links (DESIGN.md §6.7): a share link's address for another player
// (VLC), which plays an audio or video file without DFS's session or a
// link's password, and lasts as long as the share link does. Signed like
// media tokens and share-unlock cookies, under a claim of its own, so none
// can pass for another; it names the link, its password's version (a new
// password ends it), and the file in it. Public, as a share link is: anyone
// who has one can play that file until the link is turned off, expires, or
// the file is deleted.

/** What a stream link plays: a file reached through a share link. */
export interface StreamGrant {
  shareId: string
  /** The link's password's version when it was made: a new password ends it. */
  passwordVersion: number
  nodeId: string
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TOKEN = new RegExp(`^s\\.(${UUID})\\.(\\d{1,9})\\.(${UUID})\\.([\\w-]{43})$`)

/** The token in a stream link's address: `s.<share>.<password version>.<file>.<HMAC, base64url>`. */
export async function streamToken(
  keys: Pick<MasterKeys, 'sign'>,
  grant: StreamGrant,
): Promise<string> {
  const mac = Buffer.from(await keys.sign(claim(grant))).toString('base64url')
  return `s.${grant.shareId}.${String(grant.passwordVersion)}.${grant.nodeId}.${mac}`
}

/** What `token` grants, if it is a stream link's; otherwise `null`. */
export async function readStreamToken(
  keys: Pick<MasterKeys, 'verify'>,
  token: string,
): Promise<StreamGrant | null> {
  const match = TOKEN.exec(token)
  if (!match) return null
  const [, shareId, passwordVersion, nodeId, mac] = match
  if (!shareId || !passwordVersion || !nodeId || !mac) return null
  const grant = { shareId, passwordVersion: Number(passwordVersion), nodeId }
  // As written, alone: its last character's two unused bits changed would decode the same.
  const bytes = Buffer.from(mac, 'base64url')
  if (bytes.toString('base64url') !== mac) return null
  return (await keys.verify(claim(grant), bytes)) ? grant : null
}

/** A stream link's token, hidden in an address for the logs: it lets anyone play its file. */
export function hideStreamToken(url: string): string {
  return url.replace(/^(\/api\/stream\/)[^/?]+/, '$1…')
}

function claim(grant: StreamGrant): string {
  return `stream:share:${grant.shareId}:${String(grant.passwordVersion)}:${grant.nodeId}`
}

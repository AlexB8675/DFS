import { timingSafeEqual } from 'node:crypto'
import type { MasterKeys } from '@dfs/crypto'

// Stream links (DESIGN.md §6.7): a share link's address for another player
// (the device's own, or VLC), which plays an audio or video file without
// DFS's session or a link's password, and lasts as long as the share link
// does. Short, to copy and paste: the share link's ID, the file's when it is
// one inside a shared folder, and 12 bytes of an HMAC over them and the
// link's password's version (a new password ends it), in base64url, 38
// characters for a file link and 59 inside a folder. Derived, not stored, so
// it survives a recovery with its share link. Public, as a share link is:
// anyone who has one can play that file until the link is turned off,
// expires, or the file is deleted.

/** What a stream link plays: a file reached through a share link. */
export interface StreamGrant {
  shareId: string
  /** The link's password's version when it was made: a new password ends it. */
  passwordVersion: number
  nodeId: string
}

/** A stream link's token, read: the share link, and the file unless it is the link's own. */
export interface StreamToken {
  shareId: string
  /** `null` for the file a file link shares. */
  nodeId: string | null
  mac: Buffer
}

const ID_BYTES = 16
const MAC_BYTES = 12

/** The token in a stream link's address, for a file a share link reaches (`rootNodeId` its own). */
export async function streamToken(
  keys: Pick<MasterKeys, 'sign'>,
  grant: StreamGrant,
  rootNodeId: string,
): Promise<string> {
  const mac = Buffer.from(await keys.sign(claim(grant))).subarray(0, MAC_BYTES)
  const ids = grant.nodeId === rootNodeId ? [grant.shareId] : [grant.shareId, grant.nodeId]
  return Buffer.concat([...ids.map(uuidBytes), mac]).toString('base64url')
}

/** A stream link's token, read but not yet checked; `null` if it can't be one. */
export function parseStreamToken(token: string): StreamToken | null {
  if (!/^[\w-]{38}$|^[\w-]{59}$/.test(token)) return null
  const bytes = Buffer.from(token, 'base64url')
  // As written, alone: its last character's unused bits changed would decode the same.
  if (bytes.toString('base64url') !== token) return null
  const inFolder = bytes.length === 2 * ID_BYTES + MAC_BYTES
  return {
    shareId: uuidOf(bytes.subarray(0, ID_BYTES)),
    nodeId: inFolder ? uuidOf(bytes.subarray(ID_BYTES, 2 * ID_BYTES)) : null,
    mac: bytes.subarray(bytes.length - MAC_BYTES),
  }
}

/** Whether a read token was made for this grant: the link's password and file as they are now. */
export async function streamTokenValid(
  keys: Pick<MasterKeys, 'sign'>,
  token: StreamToken,
  grant: StreamGrant,
): Promise<boolean> {
  const mac = Buffer.from(await keys.sign(claim(grant))).subarray(0, MAC_BYTES)
  return token.shareId === grant.shareId && timingSafeEqual(mac, token.mac)
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LEGACY_TOKEN = new RegExp(`^s\\.(${UUID})\\.(\\d{1,9})\\.(${UUID})\\.([\\w-]{43})$`)

/**
 * What a token of the first, longer form grants (`s.<share>.<password
 * version>.<file>.<HMAC>`, 2026-10-10, before addresses were made short), so
 * links copied then still play; otherwise `null`.
 */
export async function readLegacyStreamToken(
  keys: Pick<MasterKeys, 'verify'>,
  token: string,
): Promise<StreamGrant | null> {
  const match = LEGACY_TOKEN.exec(token)
  if (!match) return null
  const [, shareId, passwordVersion, nodeId, mac] = match
  if (!shareId || !passwordVersion || !nodeId || !mac) return null
  const grant = { shareId, passwordVersion: Number(passwordVersion), nodeId }
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

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

function uuidOf(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

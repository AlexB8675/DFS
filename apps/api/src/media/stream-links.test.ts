import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  hideStreamToken,
  parseStreamToken,
  readLegacyStreamToken,
  streamToken,
  streamTokenValid,
  type StreamGrant,
} from './stream-links.ts'

// Stream links' tokens (DESIGN.md §6.7): short, for a file through a share link.

const KEY = Buffer.from('a test key for stream links, 32 bytes!')
const keys = {
  sign: (data: string) => Promise.resolve(createHmac('sha256', KEY).update(data).digest()),
  verify: (data: string, mac: Uint8Array) => {
    const expected = createHmac('sha256', KEY).update(data).digest()
    return Promise.resolve(mac.length === expected.length && timingSafeEqual(mac, expected))
  },
}

const SHARE = '01a12311-f64c-79b5-a8b7-178df84d0afe'
const ROOT = '01a12311-f64c-79b5-a8b7-178df84d0af0'
const FILE = '01a12311-f64c-79b5-a8b7-178df84d0afc'
const ownFile: StreamGrant = { shareId: SHARE, passwordVersion: 3, nodeId: ROOT }
const inFolder: StreamGrant = { shareId: SHARE, passwordVersion: 3, nodeId: FILE }

/** Whether `token` grants `grant`, as the stream route checks it. */
async function grants(token: string, grant: StreamGrant): Promise<boolean> {
  const parsed = parseStreamToken(token)
  if (!parsed) return false
  return streamTokenValid(keys, parsed, { ...grant, nodeId: parsed.nodeId ?? ROOT })
}

describe('stream links’ tokens (§6.7)', () => {
  it('are short: 38 characters for a file link’s own file, 59 for one in a folder', async () => {
    const own = await streamToken(keys, ownFile, ROOT)
    const inside = await streamToken(keys, inFolder, ROOT)
    expect(own).toMatch(/^[\w-]{38}$/)
    expect(inside).toMatch(/^[\w-]{59}$/)
    expect(parseStreamToken(own)).toMatchObject({ shareId: SHARE, nodeId: null })
    expect(parseStreamToken(inside)).toMatchObject({ shareId: SHARE, nodeId: FILE })
    expect(await grants(own, ownFile)).toBe(true)
    expect(await grants(inside, inFolder)).toBe(true)
    // The same each time.
    expect(await streamToken(keys, ownFile, ROOT)).toBe(own)
  })

  it('grant nothing once the link’s password changes, or anything in them is changed', async () => {
    const token = await streamToken(keys, inFolder, ROOT)
    expect(await grants(token, { ...inFolder, passwordVersion: 4 })).toBe(false)
    const bytes = Buffer.from(token, 'base64url')
    const flipped = (at: number) => {
      const copy = Buffer.from(bytes)
      copy[at] = (copy[at] ?? 0) ^ 1
      return copy.toString('base64url')
    }
    // The share's ID, the file's, the MAC; and the last character's unused bits.
    for (const changed of [flipped(0), flipped(20), flipped(bytes.length - 1)]) {
      expect(await grants(changed, inFolder)).toBe(false)
    }
    const lastBits = `${token.slice(0, -1)}${String.fromCharCode((token.at(-1) ?? 'A').charCodeAt(0) ^ 1)}`
    expect(parseStreamToken(lastBits)).toBeNull()
    for (const other of [token.slice(0, -1), `${token}A`, '', 'not-a-token']) {
      expect(parseStreamToken(other)).toBeNull()
    }
  })

  it('still reads those of the first, longer form, checked whole', async () => {
    const mac = createHmac('sha256', KEY)
      .update(`stream:share:${SHARE}:3:${FILE}`)
      .digest('base64url')
    const legacy = `s.${SHARE}.3.${FILE}.${mac}`
    expect(await readLegacyStreamToken(keys, legacy)).toEqual(inFolder)
    expect(await readLegacyStreamToken(keys, legacy.replace('.3.', '.4.'))).toBeNull()
    expect(parseStreamToken(legacy)).toBeNull()
  })

  it('are kept out of the logs', () => {
    expect(hideStreamToken('/api/stream/AbC-123_xyz')).toBe('/api/stream/…')
    expect(hideStreamToken('/api/stream/s.abc.0.def.mac/Film.mkv')).toBe('/api/stream/…/Film.mkv')
    expect(hideStreamToken('/api/files/abc/content')).toBe('/api/files/abc/content')
  })
})

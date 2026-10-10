import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hideStreamToken, readStreamToken, streamToken, type StreamGrant } from './stream-links.ts'

// Stream links' tokens (DESIGN.md §6.7): signed for one version, whose, and until when.

const KEY = Buffer.from('a test key for stream links, 32 bytes!')
const keys = {
  sign: (data: string) => Promise.resolve(createHmac('sha256', KEY).update(data).digest()),
  verify: (data: string, mac: Uint8Array) => {
    const expected = createHmac('sha256', KEY).update(data).digest()
    return Promise.resolve(mac.length === expected.length && timingSafeEqual(mac, expected))
  },
}

const NOW = 1_800_000_000_000
const byUser: StreamGrant = {
  scope: { kind: 'user', userId: '01a12311-f64c-79b5-a8b7-178df84d0afb' },
  nodeId: '01a12311-f64c-79b5-a8b7-178df84d0afc',
  versionId: '01a12311-f64c-79b5-a8b7-178df84d0afd',
  expiresAt: NOW + 60_000,
}
const byLink: StreamGrant = {
  ...byUser,
  scope: { kind: 'share', shareId: '01a12311-f64c-79b5-a8b7-178df84d0afe', passwordVersion: 3 },
}

describe('stream links’ tokens (§6.7)', () => {
  it('grants what they were made for, a user’s or a link’s, until they expire', async () => {
    for (const grant of [byUser, byLink]) {
      const token = await streamToken(keys, grant)
      expect(token).toMatch(/^[\w.-]+$/)
      expect(await readStreamToken(keys, token, NOW)).toEqual(grant)
      expect(await readStreamToken(keys, token, grant.expiresAt)).toBeNull()
    }
  })

  it('grants nothing once anything in them is changed', async () => {
    const token = await streamToken(keys, byLink)
    const changed = [
      token.replace(byLink.versionId, byLink.nodeId),
      token.replace('.3.', '.4.'),
      token.replace(String(byLink.expiresAt), String(byLink.expiresAt + 1)),
      token.replace(/^s\./, 'u.'),
      // The MAC's middle, and its last character's unused bits, which decode the same.
      `${token.slice(0, -20)}${token.at(-20) === 'A' ? 'B' : 'A'}${token.slice(-19)}`,
      `${token.slice(0, -1)}${String.fromCharCode((token.at(-1) ?? 'A').charCodeAt(0) ^ 1)}`,
      token.slice(0, -1),
      '',
    ]
    for (const other of changed) expect(await readStreamToken(keys, other, NOW)).toBeNull()
  })

  it('is kept out of the logs', () => {
    expect(hideStreamToken('/api/stream/u.abc.def.123.mac/Film.mkv')).toBe('/api/stream/…/Film.mkv')
    expect(hideStreamToken('/api/files/abc/content')).toBe('/api/files/abc/content')
  })
})

import { createHmac, timingSafeEqual } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hideStreamToken, readStreamToken, streamToken, type StreamGrant } from './stream-links.ts'

// Stream links' tokens (DESIGN.md §6.7): signed for a file, through a share link.

const KEY = Buffer.from('a test key for stream links, 32 bytes!')
const keys = {
  sign: (data: string) => Promise.resolve(createHmac('sha256', KEY).update(data).digest()),
  verify: (data: string, mac: Uint8Array) => {
    const expected = createHmac('sha256', KEY).update(data).digest()
    return Promise.resolve(mac.length === expected.length && timingSafeEqual(mac, expected))
  },
}

const grant: StreamGrant = {
  shareId: '01a12311-f64c-79b5-a8b7-178df84d0afe',
  passwordVersion: 3,
  nodeId: '01a12311-f64c-79b5-a8b7-178df84d0afc',
}

describe('stream links’ tokens (§6.7)', () => {
  it('grants what they were made for, the same token each time', async () => {
    const token = await streamToken(keys, grant)
    expect(token).toMatch(/^s\.[\w.-]+$/)
    expect(await readStreamToken(keys, token)).toEqual(grant)
    expect(await streamToken(keys, grant)).toBe(token)
  })

  it('grants nothing once anything in them is changed', async () => {
    const token = await streamToken(keys, grant)
    const changed = [
      token.replace(grant.nodeId, grant.shareId),
      token.replace('.3.', '.4.'),
      token.replace(/^s\./, 'u.'),
      // The MAC's middle, and its last character's unused bits, which decode the same.
      `${token.slice(0, -20)}${token.at(-20) === 'A' ? 'B' : 'A'}${token.slice(-19)}`,
      `${token.slice(0, -1)}${String.fromCharCode((token.at(-1) ?? 'A').charCodeAt(0) ^ 1)}`,
      token.slice(0, -1),
      '',
    ]
    for (const other of changed) expect(await readStreamToken(keys, other)).toBeNull()
  })

  it('is kept out of the logs', () => {
    expect(hideStreamToken('/api/stream/s.abc.0.def.mac/Film.mkv')).toBe('/api/stream/…/Film.mkv')
    expect(hideStreamToken('/api/files/abc/content')).toBe('/api/files/abc/content')
  })
})

import { describe, expect, it } from 'vitest'
import { pairingCallbackUrl, parsePairRequest } from './pairing'

// What the browser tells the backup app after the person decides (§7.6): the app
// listens on 127.0.0.1 only, and the page must never send anyone anywhere else.

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

function request(overrides: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams({
    name: 'Studio PC',
    port: '53122',
    challenge: CHALLENGE,
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  return params
}

describe('parsePairRequest', () => {
  it('reads the name, the port and the challenge', () => {
    expect(CHALLENGE).toHaveLength(43)
    expect(
      parsePairRequest(new URLSearchParams(`name=Studio%20PC&port=53122&challenge=${CHALLENGE}`)),
    ).toEqual({ name: 'Studio PC', port: 53122, challenge: CHALLENGE })
  })

  it('trims the name', () => {
    expect(parsePairRequest(request({ name: '  Studio PC \n' }))?.name).toBe('Studio PC')
  })

  it.each(['name', 'port', 'challenge'])('refuses a request without %s', (missing) => {
    expect(parsePairRequest(request({ [missing]: null }))).toBeNull()
  })

  it('refuses an empty name, or one longer than the API takes', () => {
    expect(parsePairRequest(request({ name: '' }))).toBeNull()
    expect(parsePairRequest(request({ name: '   ' }))).toBeNull()
    expect(parsePairRequest(request({ name: 'a'.repeat(80) }))?.name).toBe('a'.repeat(80))
    expect(parsePairRequest(request({ name: 'a'.repeat(81) }))).toBeNull()
  })

  it('takes only ports a program may listen on without privileges', () => {
    expect(parsePairRequest(request({ port: '1024' }))?.port).toBe(1024)
    expect(parsePairRequest(request({ port: '65535' }))?.port).toBe(65535)
    for (const port of ['0', '1023', '65536', '12.5', 'abc', '', '-5', '1e4', '0x4000', ' 53122']) {
      expect(parsePairRequest(request({ port })), port).toBeNull()
    }
  })

  it('takes only a challenge of 43 URL-safe characters', () => {
    expect(parsePairRequest(request({ challenge: CHALLENGE.slice(0, 42) }))).toBeNull()
    expect(parsePairRequest(request({ challenge: `${CHALLENGE}A` }))).toBeNull()
    expect(parsePairRequest(request({ challenge: `${CHALLENGE.slice(0, 42)}=` }))).toBeNull()
    expect(parsePairRequest(request({ challenge: `${CHALLENGE.slice(0, 42)}+` }))).toBeNull()
    expect(parsePairRequest(request({ challenge: `${CHALLENGE.slice(0, 42)}/` }))).toBeNull()
  })

  it('ignores anything else in the address, such as a host to go back to', () => {
    const parsed = parsePairRequest(
      request({ host: 'evil.example', callback: 'https://evil.example/' }),
    )
    expect(parsed).toEqual({ name: 'Studio PC', port: 53122, challenge: CHALLENGE })
  })
})

describe('pairingCallbackUrl', () => {
  it('sends the code to the app on this computer', () => {
    expect(pairingCallbackUrl(53122, { code: 'abc_-1' })).toBe(
      'http://127.0.0.1:53122/callback?code=abc_-1',
    )
  })

  it('tells the app when the person said no', () => {
    expect(pairingCallbackUrl(53122, { error: 'access_denied' })).toBe(
      'http://127.0.0.1:53122/callback?error=access_denied',
    )
  })

  it('is always http://127.0.0.1, for whatever port and code', () => {
    for (const port of [1024, 8080, 53122, 65535]) {
      const url = new URL(pairingCallbackUrl(port, { code: 'x' }))
      expect(url.protocol).toBe('http:')
      expect(url.hostname).toBe('127.0.0.1')
      expect(url.port).toBe(String(port))
      expect(url.pathname).toBe('/callback')
    }
    // A code that tried to change the address is only a value in the query.
    const url = new URL(pairingCallbackUrl(53122, { code: '@evil.example/&x=#' }))
    expect(url.origin).toBe('http://127.0.0.1:53122')
    expect(url.searchParams.get('code')).toBe('@evil.example/&x=#')
    expect([...url.searchParams.keys()]).toEqual(['code'])
  })
})

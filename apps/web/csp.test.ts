import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Production's Content-Security-Policy (docker/Caddyfile) lets index.html's
// inline theme script run by its hash. Changing the script means changing
// the hash there too, or light themes flash dark before the app loads.

describe('the Content-Security-Policy', () => {
  it('allows index.html’s inline script by its hash', () => {
    const html = readFileSync(new URL('index.html', import.meta.url), 'utf8')
    const caddyfile = readFileSync(new URL('../../docker/Caddyfile', import.meta.url), 'utf8')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256')
      .update(scripts[0] ?? '')
      .digest('base64')
    expect(caddyfile).toContain(`'sha256-${hash}'`)
  })
})

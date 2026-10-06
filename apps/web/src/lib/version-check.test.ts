import { describe, expect, it } from 'vitest'
import { entryScript, isOutdated } from './version-check'

describe('the version check', () => {
  it('finds the entry script a built index.html loads', () => {
    const html =
      '<script type="module" crossorigin src="/assets/index-BjGKEVJC.js"></script>' +
      '<link rel="modulepreload" crossorigin href="/assets/dist-88Oo_SvH.js">'
    expect(entryScript(html)).toBe('/assets/index-BjGKEVJC.js')
    expect(entryScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull()
  })

  it('calls a page outdated only when both entries are known and differ', () => {
    expect(isOutdated('/assets/index-a.js', '/assets/index-b.js')).toBe(true)
    expect(isOutdated('/assets/index-a.js', '/assets/index-a.js')).toBe(false)
    expect(isOutdated('/assets/index-a.js', null)).toBe(false)
    expect(isOutdated(null, '/assets/index-b.js')).toBe(false)
  })
})

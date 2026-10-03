import { describe, expect, it } from 'vitest'
import { safeNextPath } from './session'

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/drive/abc?select=1')).toBe('/drive/abc?select=1')
  })

  it.each([null, '', 'https://evil.com', '//evil.com', '/\\evil.com', 'drive'])(
    'falls back to /drive for %j',
    (next) => {
      expect(safeNextPath(next)).toBe('/drive')
    },
  )
})

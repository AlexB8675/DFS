import { describe, expect, it } from 'vitest'
import { isMissingModule, isOutdated } from './version-check'

describe('the version check', () => {
  it('calls a page outdated only when the server says another version', () => {
    expect(isOutdated('361410b', '0907f83')).toBe(true)
    expect(isOutdated('361410b', '361410b')).toBe(false)
    expect(isOutdated('361410b', null)).toBe(false)
    expect(isOutdated('361410b', '')).toBe(false)
    // A development build runs against whatever is there.
    expect(isOutdated('dev', '361410b')).toBe(false)
  })

  it('knows a part of the app that failed to load, as each browser says it', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://dfs.example/assets/trash-page-Bq2.js',
      'error loading dynamically imported module: https://dfs.example/assets/trash-page-Bq2.js',
      'Importing a module script failed.',
    ]) {
      expect(isMissingModule(new TypeError(message))).toBe(true)
    }
    expect(isMissingModule(new TypeError('Failed to fetch'))).toBe(false)
    expect(isMissingModule(new Error('Importing a module script failed.'))).toBe(false)
  })
})

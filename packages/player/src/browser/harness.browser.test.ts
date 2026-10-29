// The browser harness (DESIGN.md §10.4): the store stands on two things that
// only a real browser has, the origin private file system and the Web Locks. If
// either is missing here, the browser suites can't say anything about the store.

import { describe, expect, test } from 'vitest'

describe('the browser has what the store stands on', () => {
  test('gives an origin private file system', () => {
    expect(typeof navigator.storage.getDirectory).toBe('function')
  })

  test('gives Web Locks', () => {
    expect(typeof navigator.locks.request).toBe('function')
  })
})

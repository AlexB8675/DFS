import { describe, expect, it } from 'vitest'
import { bytesReceivedOf } from './received.ts'

// The bytes the engine has received (DESIGN.md §10.4): what the store holds, and what it let go of.

describe('bytesReceivedOf', () => {
  it('is the bytes held and the bytes evicted from slots', () => {
    expect(bytesReceivedOf(1000, { evictedBytes: 300, droppedBytes: 0 })).toBe(1300)
  })

  it('counts the frontier blocks that were let go of as well: they were received, and never stored (R54)', () => {
    expect(bytesReceivedOf(1000, { evictedBytes: 300, droppedBytes: 50 })).toBe(1350)
  })
})

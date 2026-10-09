import { describe, expect, it } from 'vitest'
import { UnderWay } from './under-way.ts'

describe('UnderWay (§16)', () => {
  it('counts what is under way, and samples the most since the last sample', () => {
    const underWay = new UnderWay()
    const first = underWay.enter()
    const second = underWay.enter()
    second()
    // Leaving twice counts once.
    second()
    expect(underWay.now).toBe(1)
    // A burst between samples isn't missed.
    expect(underWay.sample()).toBe(2)
    expect(underWay.sample()).toBe(1)
    first()
    expect(underWay.sample()).toBe(1)
    expect(underWay.sample()).toBe(0)
  })
})

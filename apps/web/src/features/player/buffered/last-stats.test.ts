import { describe, expect, it } from 'vitest'
import { holdsPlay, LastStats } from './last-stats'

describe('LastStats', () => {
  it('has nothing before a play has numbers', () => {
    const last = new LastStats<string>()
    last.start()
    expect(last.get()).toBeNull()
  })

  it('returns what the play set, at once', () => {
    const last = new LastStats<string>()
    const set = last.start()
    set('one')
    expect(last.get()).toBe('one')
    set('two')
    expect(last.get()).toBe('two')
  })

  it('keeps the numbers when the play is over by its own failure', () => {
    const last = new LastStats<string>()
    const set = last.start()
    set('failed')
    // The hook is disabled by the problem: no new play starts, nothing clears.
    expect(last.get()).toBe('failed')
  })

  it('is cleared when the next play starts', () => {
    const last = new LastStats<string>()
    last.start()('old')
    last.start()
    expect(last.get()).toBeNull()
  })

  it('ignores a late callback from an aborted earlier play', () => {
    const last = new LastStats<string>()
    const setOld = last.start()
    const setNew = last.start()
    setNew('new')
    setOld('late')
    expect(last.get()).toBe('new')
  })

  it('ignores a late callback of an earlier play before the new one has numbers', () => {
    const last = new LastStats<string>()
    const setOld = last.start()
    last.start()
    setOld('late')
    expect(last.get()).toBeNull()
  })
})

describe('holdsPlay', () => {
  const stats = (holding: boolean, begun: boolean) => ({ holding, begun })

  it('holds while the engine holds for the network', () => {
    expect(holdsPlay(stats(true, true), true)).toBe(true)
  })

  it('holds while a buffered play has not begun, with or without numbers', () => {
    expect(holdsPlay(null, true)).toBe(true)
    expect(holdsPlay(stats(false, false), true)).toBe(true)
  })

  it('does not hold a play that is running', () => {
    expect(holdsPlay(stats(false, true), true)).toBe(false)
  })

  it('does not hold what is not a buffered play', () => {
    expect(holdsPlay(null, false)).toBe(false)
  })
})

import type * as Player from '@dfs/player'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { clearPlayLeftovers } from './play-store'

const cleanLeftovers = vi.hoisted(() => vi.fn<() => Promise<number>>())

vi.mock('@dfs/player', () => ({ cleanLeftovers }))

/** Lets what `clearPlayLeftovers` left running (it returns at once) settle, rejections included. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('clearing the leftovers of crashed plays at startup', () => {
  let debug: MockInstance<typeof console.debug>

  beforeEach(() => {
    cleanLeftovers.mockReset()
    debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not throw in a browser with no navigator.storage', async () => {
    const actual = await vi.importActual<typeof Player>('@dfs/player')
    cleanLeftovers.mockImplementation(actual.cleanLeftovers)
    vi.stubGlobal('navigator', {})

    expect(() => {
      clearPlayLeftovers()
    }).not.toThrow()
    await settle()

    expect(cleanLeftovers).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('does not throw when the clean-up rejects, and leaves no rejection unhandled', async () => {
    cleanLeftovers.mockRejectedValue(new Error('the private file system said no'))

    expect(() => {
      clearPlayLeftovers()
    }).not.toThrow()
    await settle()

    expect(cleanLeftovers).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('does not throw when the clean-up throws at once', async () => {
    cleanLeftovers.mockImplementation(() => {
      throw new Error('no clean-up at all')
    })

    expect(() => {
      clearPlayLeftovers()
    }).not.toThrow()
    await settle()

    expect(cleanLeftovers).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('returns without waiting for the clean-up', () => {
    cleanLeftovers.mockReturnValue(new Promise<number>(() => undefined))

    clearPlayLeftovers()

    expect(cleanLeftovers).toHaveBeenCalledTimes(1)
  })

  it('logs the count once with console.debug when it removed some', async () => {
    cleanLeftovers.mockResolvedValue(3)

    clearPlayLeftovers()
    await settle()

    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]?.join(' '))).toContain('3')
  })

  it('logs nothing when it removed none', async () => {
    cleanLeftovers.mockResolvedValue(0)

    clearPlayLeftovers()
    await settle()

    expect(cleanLeftovers).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })
})

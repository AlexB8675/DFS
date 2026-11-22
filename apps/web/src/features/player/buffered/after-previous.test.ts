import { describe, expect, it, vi } from 'vitest'
import { afterPrevious, PREVIOUS_PLAY_WAIT_MS } from './after-previous'

describe('afterPrevious', () => {
  it('starts only after the previous play has settled', async () => {
    const log: string[] = []
    let settle: () => void = () => undefined
    const previous = new Promise<void>((resolve) => {
      settle = () => {
        log.push('previous settled')
        resolve()
      }
    })
    const next = afterPrevious(previous, new AbortController().signal, () => {
      log.push('start')
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(log).toEqual([])
    settle()
    await next
    expect(log).toEqual(['previous settled', 'start'])
  })

  it('never starts a play whose signal aborted while it waited', async () => {
    const controller = new AbortController()
    let settle: () => void = () => undefined
    const previous = new Promise<void>((resolve) => {
      settle = resolve
    })
    let started = false
    const next = afterPrevious(previous, controller.signal, () => {
      started = true
      return Promise.resolve()
    })
    controller.abort()
    settle()
    await next
    expect(started).toBe(false)
  })

  it('starts after a previous play that rejected', async () => {
    let started = false
    await afterPrevious(Promise.reject(new Error('boom')), new AbortController().signal, () => {
      started = true
      return Promise.resolve()
    })
    expect(started).toBe(true)
  })

  it('settles when the play it starts settles', async () => {
    let done = false
    await afterPrevious(Promise.resolve(), new AbortController().signal, async () => {
      await Promise.resolve()
      done = true
    })
    expect(done).toBe(true)
  })

  it('starts anyway once a previous play that never settles has been waited for long enough', async () => {
    vi.useFakeTimers()
    try {
      let started = false
      const next = afterPrevious(
        new Promise<void>(() => undefined),
        new AbortController().signal,
        () => {
          started = true
          return Promise.resolve()
        },
      )
      await vi.advanceTimersByTimeAsync(PREVIOUS_PLAY_WAIT_MS - 1)
      expect(started).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await next
      expect(started).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts at once when the previous play settles sooner, leaving no timer behind', async () => {
    vi.useFakeTimers()
    try {
      let started = false
      const next = afterPrevious(Promise.resolve(), new AbortController().signal, () => {
        started = true
        return Promise.resolve()
      })
      await vi.advanceTimersByTimeAsync(0)
      await next
      expect(started).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never starts an aborted play after the wait', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let started = false
      const next = afterPrevious(new Promise<void>(() => undefined), controller.signal, () => {
        started = true
        return Promise.resolve()
      })
      controller.abort()
      await vi.advanceTimersByTimeAsync(PREVIOUS_PLAY_WAIT_MS)
      await next
      expect(started).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

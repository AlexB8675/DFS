import { describe, expect, it, vi } from 'vitest'
import { AppendQueue, type BufferTarget } from './append-queue'

/** A SourceBuffer as the queue sees it: busy after each operation until `finish()`. */
class FakeBuffer extends EventTarget implements BufferTarget {
  updating = false
  appended: number[] = []
  removed: [number, number][] = []
  /** How many times the queue cancelled what was under way. */
  aborted = 0
  /** Throws QuotaExceededError on the next appends while this is above 0. */
  fullFor = 0
  /** Throws this on the next append, whatever the buffer holds. */
  failWith: Error | null = null
  appendBuffer(data: ArrayBuffer): void {
    if (this.failWith) {
      const error = this.failWith
      this.failWith = null
      throw error
    }
    if (this.fullFor > 0) {
      this.fullFor -= 1
      throw new DOMException('full', 'QuotaExceededError')
    }
    this.updating = true
    this.appended.push(data.byteLength)
  }
  remove(start: number, end: number): void {
    this.updating = true
    this.removed.push([start, end])
  }
  /** Cancels an operation under way: the browser stops updating at once. */
  abort(): void {
    this.aborted += 1
    this.updating = false
  }
  /** What the browser does when an operation ends. */
  finish(): void {
    this.updating = false
    this.dispatchEvent(new Event('updateend'))
  }
}

/** A queue over a fresh fake, with a spy on its out-of-room callback. */
function setup() {
  const fake = new FakeBuffer()
  const onQuotaExceeded = vi.fn()
  const queue = new AppendQueue(fake, onQuotaExceeded)
  return { fake, onQuotaExceeded, queue }
}

describe('AppendQueue (§10.4)', () => {
  it('appends one segment at a time, in order', () => {
    const { fake, queue } = setup()
    queue.append(new ArrayBuffer(3))
    queue.append(new ArrayBuffer(5))
    expect(fake.appended).toEqual([3])
    fake.finish()
    expect(fake.appended).toEqual([3, 5])
  })

  it('counts the bytes queued and not yet appended', () => {
    const { fake, queue } = setup()
    queue.append(new ArrayBuffer(3))
    queue.append(new ArrayBuffer(5))
    expect(queue.pendingBytes).toBe(5)
    fake.finish()
    expect(queue.pendingBytes).toBe(0)
    fake.finish()
    expect(queue.pendingBytes).toBe(0)
  })

  it('drops what is buffered before a time, in its place among the appends', () => {
    const { fake, queue } = setup()
    queue.append(new ArrayBuffer(3))
    queue.removeBefore(10)
    queue.append(new ArrayBuffer(5))
    expect(fake.removed).toEqual([])
    fake.finish()
    expect(fake.removed).toEqual([[0, 10]])
    expect(fake.appended).toEqual([3])
    fake.finish()
    expect(fake.appended).toEqual([3, 5])
  })

  it('skips a removal that has nothing before it', () => {
    const { fake, queue } = setup()
    queue.append(new ArrayBuffer(3))
    queue.removeBefore(0)
    queue.append(new ArrayBuffer(5))
    fake.finish()
    expect(fake.removed).toEqual([])
    expect(fake.appended).toEqual([3, 5])
  })

  it('holds a segment the browser has no room for, and says so once', () => {
    const { fake, onQuotaExceeded, queue } = setup()
    fake.fullFor = 1
    queue.append(new ArrayBuffer(4))
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1)
    expect(fake.appended).toEqual([])
    expect(queue.pendingBytes).toBe(4)
    expect(queue.idle).toBe(false)

    queue.append(new ArrayBuffer(2))
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1)
    expect(fake.appended).toEqual([])
    expect(queue.pendingBytes).toBe(6)
  })

  it('makes room first on retry, then appends the held segment', () => {
    const { fake, queue } = setup()
    fake.fullFor = 1
    queue.append(new ArrayBuffer(4))
    queue.removeBefore(6)
    expect(fake.removed).toEqual([])
    queue.retry()
    expect(fake.removed).toEqual([[0, 6]])
    expect(fake.appended).toEqual([])
    fake.finish()
    expect(fake.appended).toEqual([4])
  })

  it('runs the removals queued during a stop in order, ahead of the held segment and the rest', () => {
    const { fake, queue } = setup()
    fake.fullFor = 1
    queue.append(new ArrayBuffer(4))
    queue.append(new ArrayBuffer(2))
    queue.removeBefore(6)
    queue.removeBefore(8)
    queue.retry()
    expect(fake.removed).toEqual([[0, 6]])
    fake.finish()
    expect(fake.removed).toEqual([
      [0, 6],
      [0, 8],
    ])
    fake.finish()
    expect(fake.appended).toEqual([4])
    fake.finish()
    expect(fake.appended).toEqual([4, 2])
  })

  it('stops again, and says so again, when the room made is not enough', () => {
    const { fake, onQuotaExceeded, queue } = setup()
    fake.fullFor = 2
    queue.append(new ArrayBuffer(4))
    queue.retry()
    expect(onQuotaExceeded).toHaveBeenCalledTimes(2)
    expect(fake.appended).toEqual([])
    queue.retry()
    expect(fake.appended).toEqual([4])
    expect(queue.pendingBytes).toBe(0)
  })

  it('lets the out-of-room callback make room and retry at once', () => {
    const fake = new FakeBuffer()
    fake.fullFor = 1
    const queue: AppendQueue = new AppendQueue(fake, () => {
      queue.removeBefore(6)
      queue.retry()
    })
    queue.append(new ArrayBuffer(4))
    expect(fake.removed).toEqual([[0, 6]])
    fake.finish()
    expect(fake.appended).toEqual([4])
  })

  it('throws any other error from the browser, out of append', () => {
    const { fake, onQuotaExceeded, queue } = setup()
    fake.failWith = new Error('boom')
    expect(() => {
      queue.append(new ArrayBuffer(4))
    }).toThrow('boom')
    expect(onQuotaExceeded).not.toHaveBeenCalled()
  })

  it('drops a segment the browser refused for another reason, and carries on with the next', () => {
    const { fake, queue } = setup()
    fake.failWith = new Error('boom')
    expect(() => {
      queue.append(new ArrayBuffer(4))
    }).toThrow('boom')
    expect(queue.pendingBytes).toBe(0)
    expect(queue.idle).toBe(true)
    queue.append(new ArrayBuffer(2))
    expect(fake.appended).toEqual([2])
  })

  it('is idle only when nothing is queued and the browser is not busy', () => {
    const { fake, queue } = setup()
    expect(queue.idle).toBe(true)
    queue.append(new ArrayBuffer(3))
    expect(queue.idle).toBe(false)
    queue.append(new ArrayBuffer(5))
    fake.finish()
    expect(queue.idle).toBe(false)
    fake.finish()
    expect(queue.idle).toBe(true)
  })

  it('settles drained() at once when idle', async () => {
    const { queue } = setup()
    await expect(queue.drained()).resolves.toBeUndefined()
  })

  it('settles drained() after the last operation ends', async () => {
    const { fake, queue } = setup()
    queue.append(new ArrayBuffer(3))
    queue.append(new ArrayBuffer(5))
    let done = false
    const drained = queue.drained().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    fake.finish()
    await Promise.resolve()
    expect(done).toBe(false)
    fake.finish()
    await drained
    expect(done).toBe(true)
  })

  describe('holding segments back', () => {
    it('queues appends while held, and runs them in order once released', () => {
      const { fake, queue } = setup()
      queue.hold()
      queue.append(new ArrayBuffer(3))
      queue.append(new ArrayBuffer(5))
      expect(fake.appended).toEqual([])
      expect(queue.pendingBytes).toBe(8)
      queue.release()
      expect(fake.appended).toEqual([3])
      expect(queue.pendingBytes).toBe(5)
      fake.finish()
      expect(fake.appended).toEqual([3, 5])
    })

    it('is held between hold() and release()', () => {
      const { queue } = setup()
      expect(queue.held).toBe(false)
      queue.hold()
      expect(queue.held).toBe(true)
      queue.hold()
      expect(queue.held).toBe(true)
      queue.release()
      expect(queue.held).toBe(false)
    })

    it('lets an operation already handed to the browser finish, and starts nothing after it', () => {
      const { fake, queue } = setup()
      queue.append(new ArrayBuffer(3))
      queue.hold()
      queue.append(new ArrayBuffer(5))
      fake.finish()
      expect(fake.appended).toEqual([3])
      queue.release()
      expect(fake.appended).toEqual([3, 5])
    })

    it('queues removals while held, in their place among the appends', () => {
      const { fake, queue } = setup()
      queue.hold()
      queue.append(new ArrayBuffer(3))
      queue.removeBefore(10)
      queue.append(new ArrayBuffer(5))
      expect(fake.removed).toEqual([])
      queue.release()
      expect(fake.appended).toEqual([3])
      fake.finish()
      expect(fake.removed).toEqual([[0, 10]])
      fake.finish()
      expect(fake.appended).toEqual([3, 5])
    })

    it('is not idle, nor drained, while segments wait behind a hold', async () => {
      const { fake, queue } = setup()
      queue.hold()
      expect(queue.idle).toBe(true)
      queue.append(new ArrayBuffer(3))
      expect(queue.idle).toBe(false)
      let done = false
      const drained = queue.drained().then(() => {
        done = true
      })
      await Promise.resolve()
      expect(done).toBe(false)
      queue.release()
      await Promise.resolve()
      expect(done).toBe(false)
      fake.finish()
      await drained
      expect(done).toBe(true)
    })

    it('does not retry a segment held for lack of room when released', () => {
      const { fake, onQuotaExceeded, queue } = setup()
      fake.fullFor = 1
      queue.append(new ArrayBuffer(4))
      expect(onQuotaExceeded).toHaveBeenCalledTimes(1)
      queue.hold()
      queue.release()
      expect(fake.appended).toEqual([])
      expect(queue.pendingBytes).toBe(4)
      queue.retry()
      expect(fake.appended).toEqual([4])
    })

    it('does not release a hold when it retries after a lack of room', () => {
      const { fake, queue } = setup()
      fake.fullFor = 1
      queue.append(new ArrayBuffer(4))
      queue.hold()
      queue.retry()
      expect(queue.held).toBe(true)
      expect(fake.appended).toEqual([])
      queue.release()
      expect(fake.appended).toEqual([4])
    })
  })

  describe('resetting for a seek', () => {
    it('drops what is queued, cancels what is under way, and clears the buffer to a time', () => {
      const { fake, queue } = setup()
      queue.append(new ArrayBuffer(3))
      queue.append(new ArrayBuffer(5))
      queue.append(new ArrayBuffer(7))
      expect(fake.appended).toEqual([3])
      queue.reset(30)
      expect(queue.pendingBytes).toBe(0)
      expect(fake.aborted).toBe(1)
      expect(fake.removed).toEqual([[0, 30]])
      fake.finish()
      expect(fake.appended).toEqual([3])
      expect(queue.idle).toBe(true)
    })

    it('queues no removal when there is nothing before the time', () => {
      const { fake, queue } = setup()
      queue.append(new ArrayBuffer(3))
      queue.append(new ArrayBuffer(5))
      queue.reset(0)
      expect(queue.pendingBytes).toBe(0)
      expect(fake.aborted).toBe(1)
      expect(fake.removed).toEqual([])
      expect(queue.idle).toBe(true)
    })

    it('still runs its removal while held, but nothing appended after it', () => {
      const { fake, queue } = setup()
      queue.hold()
      queue.append(new ArrayBuffer(3))
      queue.reset(30)
      expect(queue.held).toBe(true)
      expect(queue.pendingBytes).toBe(0)
      expect(fake.removed).toEqual([[0, 30]])
      queue.append(new ArrayBuffer(5))
      fake.finish()
      expect(fake.appended).toEqual([])
      expect(queue.pendingBytes).toBe(5)
      queue.release()
      expect(fake.appended).toEqual([5])
    })

    it('does not release a hold, nor take one', () => {
      const { queue } = setup()
      queue.reset(0)
      expect(queue.held).toBe(false)
      queue.hold()
      queue.reset(0)
      expect(queue.held).toBe(true)
    })

    it('drops a segment held for lack of room, and the stop with it', () => {
      const { fake, onQuotaExceeded, queue } = setup()
      fake.fullFor = 1
      queue.append(new ArrayBuffer(4))
      queue.removeBefore(6)
      expect(onQuotaExceeded).toHaveBeenCalledTimes(1)
      queue.reset(10)
      expect(queue.pendingBytes).toBe(0)
      expect(fake.removed).toEqual([[0, 10]])
      queue.append(new ArrayBuffer(2))
      expect(fake.appended).toEqual([])
      fake.finish()
      expect(fake.appended).toEqual([2])
      expect(onQuotaExceeded).toHaveBeenCalledTimes(1)
    })

    it('settles drained() once everything queued is dropped', async () => {
      const { queue } = setup()
      queue.hold()
      queue.append(new ArrayBuffer(3))
      let done = false
      const drained = queue.drained().then(() => {
        done = true
      })
      await Promise.resolve()
      expect(done).toBe(false)
      queue.reset(0)
      await drained
      expect(done).toBe(true)
    })
  })
})

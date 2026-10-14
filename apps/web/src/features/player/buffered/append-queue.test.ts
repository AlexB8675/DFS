import { describe, expect, it, vi } from 'vitest'
import { AppendQueue, type BufferTarget } from './append-queue'

/** A SourceBuffer as the queue sees it: busy after each operation until `finish()`. */
class FakeBuffer extends EventTarget implements BufferTarget {
  updating = false
  appended: number[] = []
  removed: [number, number][] = []
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
})

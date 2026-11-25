import { getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reserveRoom, streamBody } from './stream-body.ts'
import type { StreamStart } from './uploads.ts'

afterEach(() => {
  vi.useRealTimers()
})

function fakeApp(admit: () => Promise<boolean>) {
  const stagingRoom = {
    admit: vi.fn(admit),
    renew: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  }
  return { app: { stagingRoom } as unknown as FastifyInstance, stagingRoom }
}

describe('streamBody', () => {
  it('notices a client that left before it started, and answers at once', async () => {
    const { app, stagingRoom } = fakeApp(() => Promise.resolve(false))
    const raw = new PassThrough()
    raw.destroy()
    await new Promise((resolve) => raw.once('close', resolve))
    const request = { raw, log: { info: vi.fn(), warn: vi.fn() } } as unknown as FastifyRequest
    const reply = { header: vi.fn() } as unknown as FastifyReply
    const start: StreamStart = {
      chunkSize: 3,
      chunkCount: 1,
      bytes: 3,
      completed: false,
      needBytes: 100,
    }
    const began = Date.now()
    await expect(
      streamBody(app, request, reply, { user: { id: 'u' } } as never, 'id', 0, start, {
        completeAlone: true,
      }),
    ).rejects.toMatchObject({ code: 'upload_interrupted' })
    expect(Date.now() - began).toBeLessThan(1000)
    expect(stagingRoom.admit).not.toHaveBeenCalled()
  })
})

describe('reserveRoom', () => {
  it('leaves at most one abort listener on the signal through a long wait', async () => {
    vi.useFakeTimers()
    let tries = 0
    const { app } = fakeApp(() => Promise.resolve(++tries > 15))
    const gone = new AbortController()
    const seen: number[] = []
    const waiting = reserveRoom(app, 'id', 1, gone.signal)
    for (let i = 0; i < 15; i += 1) {
      await vi.advanceTimersByTimeAsync(2_000)
      seen.push(getEventListeners(gone.signal, 'abort').length)
    }
    await waiting
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
    expect(getEventListeners(gone.signal, 'abort')).toHaveLength(0)
  })

  it('stops at once for a signal already aborted', async () => {
    const { app, stagingRoom } = fakeApp(() => Promise.resolve(false))
    const gone = new AbortController()
    gone.abort()
    await expect(reserveRoom(app, 'id', 1, gone.signal)).rejects.toMatchObject({
      code: 'upload_interrupted',
    })
    expect(stagingRoom.admit).not.toHaveBeenCalled()
  })
})

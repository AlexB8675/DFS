import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { notModified, paced, requestedRange } from './send.ts'

const file = { version_id: '01a11353-edcb-7c90-8918-70850edcd1f9', size_bytes: 100 }

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}

describe('resumed downloads (§6.2)', () => {
  it('serves the rest of the version the download began with', () => {
    expect(
      requestedRange(request({ range: 'bytes=40-', 'if-range': `"${file.version_id}"` }), file),
    ).toEqual({ start: 40, end: 99 })
    expect(requestedRange(request({ range: 'bytes=40-' }), file)).toEqual({ start: 40, end: 99 })
  })

  it('serves the whole file when the download began with another version', () => {
    expect(
      requestedRange(request({ range: 'bytes=40-', 'if-range': '"another-version"' }), file),
    ).toBeNull()
    // A date: we send no Last-Modified, so it can't name this version.
    expect(
      requestedRange(
        request({ range: 'bytes=40-', 'if-range': 'Wed, 07 Oct 2026 10:00:00 GMT' }),
        file,
      ),
    ).toBeNull()
  })
})

describe('revalidation (§6.2)', () => {
  it('knows a browser has the version when If-None-Match names it', () => {
    const etag = `"${file.version_id}"`
    expect(notModified(request({ 'if-none-match': etag }), file)).toBe(true)
    expect(notModified(request({ 'if-none-match': `W/${etag}` }), file)).toBe(true)
    expect(notModified(request({ 'if-none-match': `"another-version", ${etag}` }), file)).toBe(true)
    expect(notModified(request({ 'if-none-match': '*' }), file)).toBe(true)
  })

  it('sends the file when the browser has another version, or none', () => {
    expect(notModified(request({}), file)).toBe(false)
    expect(notModified(request({ 'if-none-match': '"another-version"' }), file)).toBe(false)
    // Unquoted, it isn't our ETag.
    expect(notModified(request({ 'if-none-match': file.version_id }), file)).toBe(false)
  })
})

describe('pacing a download by its client (§6.2)', () => {
  /** Three pieces, counting those asked for, and whether the source was ended. */
  function counted() {
    const state = { asked: 0, ended: false }
    async function* pieces() {
      try {
        for (let index = 0; index < 3; index += 1) {
          state.asked += 1
          // A moment, as reading a chunk takes.
          await setImmediate()
          yield new Uint8Array(16).fill(index)
        }
      } finally {
        state.ended = true
      }
    }
    return { state, pieces: pieces() }
  }

  /** A response whose client takes nothing until `send` is called. */
  function slowResponse() {
    const sent: Uint8Array[] = []
    const waiting: (() => void)[] = []
    const response = new Writable({
      highWaterMark: 8,
      write(piece: Uint8Array, _encoding, callback) {
        sent.push(piece)
        waiting.push(callback)
      },
    })
    const send = async () => {
      waiting.shift()?.()
      await setImmediate()
    }
    return { response, sent, send }
  }

  it('asks for the next piece only once the response has sent the last', async () => {
    const { state, pieces } = counted()
    const { response, sent, send } = slowResponse()
    const written = (count: number) =>
      vi.waitFor(() => {
        expect(sent).toHaveLength(count)
      })
    Readable.from(paced(response, pieces)).pipe(response)
    await written(1)
    await setImmediate()
    // Readable.from alone would have asked for the second piece already.
    expect(state.asked).toBe(1)

    await send()
    expect(state.asked).toBe(2)
    await written(2)
    await send()
    await written(3)
    await send()
    await finished(response)
    expect(sent.map((piece) => piece[0])).toEqual([0, 1, 2])
    expect(state.ended).toBe(true)
  })

  it('counts what it sent, and how long it waited for the client against the source', async () => {
    const { pieces } = counted()
    const { response, sent, send } = slowResponse()
    const stats = {
      startedAt: performance.now(),
      bytes: 0,
      firstPieceMs: null,
      sourceMs: 0,
      clientMs: 0,
    }
    Readable.from(paced(response, pieces, stats)).pipe(response)
    for (let count = 1; count <= 3; count += 1) {
      await vi.waitFor(() => {
        expect(sent).toHaveLength(count)
      })
      // The client keeps each piece a while before taking the next.
      await new Promise((resolve) => setTimeout(resolve, 30))
      await send()
    }
    await finished(response)
    expect(stats.bytes).toBe(48)
    expect(stats.firstPieceMs).not.toBeNull()
    // The client took its time; the source answered at once.
    expect(stats.clientMs).toBeGreaterThan(50)
    expect(stats.sourceMs).toBeLessThan(stats.clientMs)
  })

  it('ends the source when the response closes before it has sent a piece', async () => {
    const { state, pieces } = counted()
    const { response } = slowResponse()
    Readable.from(paced(response, pieces)).pipe(response)
    await vi.waitFor(() => {
      expect(response.writableNeedDrain).toBe(true)
    })
    response.destroy()
    await vi.waitFor(() => {
      expect(state.ended).toBe(true)
    })
    expect(state.asked).toBe(1)
  })
})

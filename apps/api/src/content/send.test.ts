import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { requestedRange } from './send.ts'

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

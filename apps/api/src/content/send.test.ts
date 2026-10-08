import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { notModified, requestedRange } from './send.ts'

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

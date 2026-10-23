import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseRange, startCorpusServer } from './serve.ts'
import type { CorpusServer } from './serve.ts'

// The Range server that the browser suites read the corpus from (DESIGN.md
// §10.4, D45): what a Range header asks for, and what the server answers with,
// checked without a browser.

describe('parseRange', () => {
  it('takes a first and last byte, cut to the end of the file', () => {
    expect(parseRange('bytes=0-15', 100)).toEqual({ start: 0, end: 15 })
    expect(parseRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 })
  })

  it('takes an open end as the end of the file, even from its last byte', () => {
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
    expect(parseRange('bytes=99-', 100)).toEqual({ start: 99, end: 99 })
  })

  it('takes a suffix as that many of the last bytes, or all of them when it is longer', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 })
  })

  it('is unsatisfiable when it starts at or past the end, or asks for no bytes', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=100-200', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('is ignored when there is none, or it is another unit, several ranges, or malformed', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('items=0-5', 100)).toBeUndefined()
    expect(parseRange('bytes=0-5, 10-15', 100)).toBeUndefined()
    expect(parseRange('bytes=-', 100)).toBeUndefined()
    expect(parseRange('bytes=10-5', 100)).toBeUndefined()
    expect(parseRange('bytes=a-b', 100)).toBeUndefined()
  })
})

describe('startCorpusServer', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, at) => at % 251)
  let folder: string
  let server: CorpusServer

  beforeAll(async () => {
    folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-serve-'))
    const path = resolve(folder, 'clip.mp4')
    writeFileSync(path, bytes)
    server = await startCorpusServer([{ path, expect: 'plays' }])
  })

  afterAll(async () => {
    await server.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const at = (id: number) => `${server.info.url}/file/${id}`

  it('lists each file by id and base name, with its size and expectation, and no path', () => {
    expect(server.info.files).toEqual([{ id: 0, name: 'clip.mp4', expect: 'plays', size: 1000 }])
    expect(JSON.stringify(server.info)).not.toContain(folder.replaceAll('\\', '/'))
  })

  it('answers a range with 206, the bytes asked for and their Content-Range', async () => {
    const response = await fetch(at(0), { headers: { Range: 'bytes=16-31' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 16-31/1000')
    expect(response.headers.get('Content-Length')).toBe('16')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(16, 32))
  })

  it('answers a request with no range with the whole file, and HEAD with its headers alone', async () => {
    const whole = await fetch(at(0))
    expect(whole.status).toBe(200)
    expect(whole.headers.get('Accept-Ranges')).toBe('bytes')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes)

    const head = await fetch(at(0), { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('1000')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('answers a range that starts past the end with 416 and the size', async () => {
    const response = await fetch(at(0), { headers: { Range: 'bytes=1000-' } })
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */1000')
    await response.arrayBuffer()
  })

  it('lets a page on another origin ask for a range, and read what it is given', async () => {
    const preflight = await fetch(at(0), {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Headers': 'range' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Range')

    const response = await fetch(at(0), { headers: { Range: 'bytes=0-0' } })
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe(
      'Content-Range, Content-Length, Accept-Ranges',
    )
    await response.arrayBuffer()
  })

  it('has nothing at any other path, for another id, or for another method', async () => {
    for (const path of ['/', '/file/1', '/file/-1', '/file/0/extra', '/file/../0']) {
      const response = await fetch(`${server.info.url}${path}`)
      expect(response.status, path).toBe(404)
      await response.arrayBuffer()
    }
    const post = await fetch(at(0), { method: 'POST' })
    expect(post.status).toBe(405)
    await post.arrayBuffer()
  })

  it('leaves out a file that is gone from the disk when it begins, with one warning, and numbers the rest from 0', async () => {
    const present = resolve(folder, 'present.mp4')
    writeFileSync(present, bytes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const other = await startCorpusServer([
      { path: resolve(folder, 'never-there.mp4'), expect: 'plays' },
      { path: present, expect: 'plays' },
      { path: resolve(folder, 'also-gone.mp4'), expect: 'plays' },
    ])
    try {
      expect(other.info.files).toEqual([
        { id: 0, name: 'present.mp4', expect: 'plays', size: 1000 },
      ])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('2 of 3')
      const response = await fetch(`${other.info.url}/file/0`, { headers: { Range: 'bytes=0-3' } })
      expect(response.status).toBe(206)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(0, 4))
    } finally {
      warn.mockRestore()
      await other.close()
    }
  })

  it('says nothing when every file is there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const path = resolve(folder, 'clip.mp4')
      const other = await startCorpusServer([{ path, expect: 'plays' }])
      await other.close()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('answers 404 for a file that has gone from the disk since it began', async () => {
    const path = resolve(folder, 'gone.mp4')
    writeFileSync(path, bytes)
    const other = await startCorpusServer([{ path, expect: 'plays' }])
    try {
      rmSync(path)
      const response = await fetch(`${other.info.url}/file/0`)
      expect(response.status).toBe(404)
      await response.arrayBuffer()
    } finally {
      await other.close()
    }
  })
})

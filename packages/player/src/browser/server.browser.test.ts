// The play server from a real page (DESIGN.md §10.4): the page is on Vitest's port, the server on its own, so
// what a fetch can read of the server's answers depends on its CORS headers, which only a browser enforces.

import { afterEach, describe, expect, test } from 'vitest'
import { clearLog, control, fileUrl, files, log, switchNetwork } from './server.ts'

afterEach(async () => {
  await control({})
  await clearLog()
})

const available = files().filter((file) => file.size > 1000)
const suite = available.length === 0 ? describe.skip : describe

suite('the play server, from the page', () => {
  const file = available[0]

  test('serves a range, and the page can read the range headers', async () => {
    const response = await fetch(fileUrl(file?.id ?? ''), { headers: { Range: 'bytes=0-99' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes 0-99/${file?.size}`)
    expect(response.headers.get('Content-Length')).toBe('100')
    expect(response.headers.get('ETag')).not.toBeNull()
    expect((await response.arrayBuffer()).byteLength).toBe(100)
  })

  test('shapes the network and says what it saw', async () => {
    await clearLog()
    await control({ latencyMs: 300, faults: [{ kind: 'status', status: 503 }] })
    const started = performance.now()
    const refused = await fetch(fileUrl(file?.id ?? ''), { headers: { Range: 'bytes=0-9' } })
    expect(refused.status).toBe(503)
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
    const served = await fetch(fileUrl(file?.id ?? ''), { headers: { Range: 'bytes=0-9' } })
    expect(served.status).toBe(206)
    await served.arrayBuffer()
    expect(await log()).toEqual([
      { id: file?.id, range: 'bytes=0-9', status: 503, bytesSent: 0, outcome: 'done' },
      { id: file?.id, range: 'bytes=0-9', status: 206, bytesSent: 10, outcome: 'done' },
    ])
  })

  test('a switch breaks the connection the page is reading and refuses it for a while', async () => {
    await control({ faults: [{ kind: 'stall', afterBytes: 100, ms: null }] })
    const open = await fetch(fileUrl(file?.id ?? ''), { headers: { Range: 'bytes=0-999' } })
    const broke = expect(open.arrayBuffer()).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await switchNetwork(500)
    await broke
    await expect(fetch(fileUrl(file?.id ?? ''))).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect((await fetch(fileUrl(file?.id ?? ''), { headers: { Range: 'bytes=0-9' } })).status).toBe(
      206,
    )
  })
})

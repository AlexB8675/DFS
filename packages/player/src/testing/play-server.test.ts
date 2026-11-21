import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { isSynthetic, loadManifest } from '@dfs/mp4/testing/node'
import type { ManifestEntry } from '@dfs/mp4/testing/node'
import { startPlayServer } from './play-server.ts'
import type { PlayServer } from './play-server.ts'
import type { LogEntry, Network } from './provided.ts'

// The server of the browser suites (DESIGN.md §10.4): the corpus behind Range, over a network that
// a test shapes. The suites of the Media Source sink and of the engine stand on it, so what it
// answers, and how it misbehaves on request, is tested here. It reads the synthetic files that
// `corpus:make` writes, and skips when that has not been run.

const synthetic: ManifestEntry[] = loadManifest().filter((entry) => isSynthetic(entry.path))
const suite = synthetic.length === 0 ? describe.skip : describe
if (synthetic.length === 0) {
  console.warn('play-server tests skipped: run `pnpm --filter @dfs/mp4 corpus:make` first.')
}

const servers: PlayServer[] = []

async function serve(entries: readonly ManifestEntry[] = synthetic): Promise<PlayServer> {
  const server = await startPlayServer(entries)
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** The largest file of the synthetic corpus: the network tests read megabytes of it. */
function biggest(server: PlayServer): { id: string; size: number } {
  const files = [...server.info.files].sort((a, b) => b.size - a.size)
  const file = files[0]
  if (file === undefined) throw new Error('no file')
  return file
}

async function control(server: PlayServer, net: Network): Promise<void> {
  const response = await fetch(`${server.info.controlBase}/control`, {
    method: 'POST',
    body: JSON.stringify(net),
  })
  expect(response.status).toBe(204)
}

/** A network change: every open data connection is broken, and new ones are refused for `refuseMs`. */
async function switchNetwork(server: PlayServer, refuseMs: number): Promise<void> {
  const response = await fetch(`${server.info.controlBase}/switch`, {
    method: 'POST',
    body: JSON.stringify({ refuseMs }),
  })
  expect(response.status).toBe(204)
}

async function logOf(server: PlayServer): Promise<LogEntry[]> {
  return (await (await fetch(`${server.info.controlBase}/log`)).json()) as LogEntry[]
}

/** Reads a response's body to its end and says how many bytes came, or that the connection broke. */
async function drain(response: Response): Promise<number | 'broken'> {
  try {
    return (await response.arrayBuffer()).byteLength
  } catch {
    return 'broken'
  }
}

/** Reads up to `limit` bytes, then gives up on the body. */
async function readSome(response: Response, limit: number): Promise<number> {
  let total = 0
  // Leaving the loop gives up on the body.
  for await (const piece of response.body as AsyncIterable<Uint8Array>) {
    total += piece.length
    if (total >= limit) break
  }
  return total
}

const later = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

suite('the play server', () => {
  describe('the answers', () => {
    it('lists the manifest files with a size and an expectation, and never a path', async () => {
      const server = await serve()
      expect(server.info.files).toHaveLength(synthetic.length)
      const first = server.info.files[0]
      const entry = synthetic[0]
      expect(first?.size).toBe(statSync(entry?.path ?? '').size)
      expect(first?.expect).toBe(entry?.expect)
      expect(first?.synthetic).toBe(true)
      expect(first?.name).toMatch(/^synthetic\/.+\..+$/)
      expect(JSON.stringify(server.info)).not.toContain('corpus/synthetic')
    })

    it('answers a range with a 206 and the headers the content route gives', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const response = await fetch(`${server.info.base}/file/${file?.id}`, {
        headers: { Range: 'bytes=10-109' },
      })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-range')).toBe(`bytes 10-109/${file?.size}`)
      expect(response.headers.get('content-length')).toBe('100')
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
      expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
      expect(new Uint8Array(await response.arrayBuffer()).length).toBe(100)
    })

    it('gives one strong ETag for one file, and another for another', async () => {
      const server = await serve()
      const etag = async (id: string | undefined): Promise<string | null> =>
        (
          await fetch(`${server.info.base}/file/${id}`, { headers: { Range: 'bytes=0-0' } })
        ).headers.get('etag')
      const [a, b] = server.info.files
      expect(await etag(a?.id)).toBe(await etag(a?.id))
      expect(await etag(a?.id)).not.toBe(await etag(b?.id))
    })

    it('answers no Range with a 200 and the whole file, read in place', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const response = await fetch(`${server.info.base}/file/${file?.id}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBeNull()
      expect(response.headers.get('content-length')).toBe(String(file?.size))
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
      // The bytes are those of the manifest's own path: nothing is copied anywhere.
      const body = new Uint8Array(await response.arrayBuffer())
      expect(Buffer.compare(body, readFileSync(synthetic[0]?.path ?? ''))).toBe(0)
    })

    it('serves the bytes of a range from the file at that offset', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const whole = readFileSync(synthetic[0]?.path ?? '')
      const start = Math.floor((file?.size ?? 0) / 2)
      const response = await fetch(`${server.info.base}/file/${file?.id}`, {
        headers: { Range: `bytes=${start}-` },
      })
      expect(response.status).toBe(206)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(Buffer.compare(body, whole.subarray(start))).toBe(0)
    })

    it('answers a range past the end with a 416', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const response = await fetch(`${server.info.base}/file/${file?.id}`, {
        headers: { Range: `bytes=${file?.size}-` },
      })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${file?.size}`)
    })

    it('answers an id it does not have with a 404', async () => {
      const server = await serve()
      expect((await fetch(`${server.info.base}/file/9999`)).status).toBe(404)
      expect((await fetch(`${server.info.base}/file/x`)).status).toBe(404)
    })
  })

  describe('the network', () => {
    it('limits the bandwidth to within 20% over a 2 MB read at 1 MB/s', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { bandwidthBytesPerSecond: 1_000_000 })
      const started = performance.now()
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-1999999' },
      })
      expect(await drain(response)).toBe(2_000_000)
      const seconds = (performance.now() - started) / 1000
      expect(seconds).toBeGreaterThan(1.6)
      expect(seconds).toBeLessThan(2.4)
    })

    it('shares one budget between the open responses, as a link does', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { bandwidthBytesPerSecond: 1_000_000 })
      const started = performance.now()
      const read = async (): Promise<number | 'broken'> =>
        drain(
          await fetch(`${server.info.base}/file/${file.id}`, {
            headers: { Range: 'bytes=0-999999' },
          }),
        )
      expect(await Promise.all([read(), read()])).toEqual([1_000_000, 1_000_000])
      const seconds = (performance.now() - started) / 1000
      expect(seconds).toBeGreaterThan(1.6)
      expect(seconds).toBeLessThan(2.4)
    })

    it('waits the latency before the headers', async () => {
      const server = await serve()
      await control(server, { latencyMs: 400 })
      const started = performance.now()
      await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(performance.now() - started).toBeGreaterThanOrEqual(380)
    })

    it('replaces the whole network with each control, so an empty one resets it', async () => {
      const server = await serve()
      await control(server, { latencyMs: 500, faults: [{ kind: 'status', status: 503 }] })
      await control(server, {})
      const started = performance.now()
      const response = await fetch(`${server.info.base}/file/0`, {
        headers: { Range: 'bytes=0-9' },
      })
      expect(performance.now() - started).toBeLessThan(300)
      expect(response.status).toBe(206)
      await response.arrayBuffer()
    })

    it('turns away a control it cannot read', async () => {
      const server = await serve()
      for (const body of [
        'not json',
        '{"bandwidthBytesPerSecond":0}',
        '{"latencyMs":-1}',
        '{"faults":[{"kind":"melt"}]}',
        '{"faults":[{"kind":"drop"}]}',
      ]) {
        const response = await fetch(`${server.info.controlBase}/control`, { method: 'POST', body })
        expect(response.status, body).toBe(400)
      }
    })
  })

  describe('the faults', () => {
    it('answers the next request with a status and an empty body, then serves as asked', async () => {
      const server = await serve()
      await control(server, { faults: [{ kind: 'status', status: 503 }] })
      const first = await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(first.status).toBe(503)
      expect(await drain(first)).toBe(0)
      const second = await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(second.status).toBe(206)
      await second.arrayBuffer()
    })

    it('gives each fault to one request, in order', async () => {
      const server = await serve()
      await control(server, {
        faults: [
          { kind: 'status', status: 500 },
          { kind: 'status', status: 429 },
        ],
      })
      const statuses: number[] = []
      for (let at = 0; at < 3; at += 1) {
        const response = await fetch(`${server.info.base}/file/0`, {
          headers: { Range: 'bytes=0-9' },
        })
        statuses.push(response.status)
        await response.arrayBuffer()
      }
      expect(statuses).toEqual([500, 429, 206])
    })

    it('drops the connection after the bytes it was told to send', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { faults: [{ kind: 'drop', afterBytes: 100_000 }] })
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-499999' },
      })
      expect(response.status).toBe(206)
      expect(await drain(response)).toBe('broken')
      const [entry] = await logOf(server)
      expect(entry).toMatchObject({ outcome: 'dropped', bytesSent: 100_000, status: 206 })
    })

    it('stalls after the bytes it was told to send, and goes on after the time', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { faults: [{ kind: 'stall', afterBytes: 50_000, ms: 600 }] })
      const started = performance.now()
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-199999' },
      })
      expect(await drain(response)).toBe(200_000)
      expect(performance.now() - started).toBeGreaterThanOrEqual(580)
    })

    it('stalls for ever with a null time, until the client gives up', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { faults: [{ kind: 'stall', afterBytes: 50_000, ms: null }] })
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-199999' },
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      let total = 0
      while (total < 50_000) total += ((await reader.read()).value ?? new Uint8Array()).length
      expect(total).toBe(50_000)
      // Another read stays pending across the wait.
      let settled = false
      const more = reader.read().then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await later(400)
      expect(settled).toBe(false)
      expect((await logOf(server))[0]).toMatchObject({ bytesSent: 50_000, outcome: 'open' })
      // The client leaves, and the stall ends with it.
      await reader.cancel()
      await more
      await later(100)
      expect((await logOf(server))[0]?.outcome).toBe('aborted')
    })

    it('breaks every open data connection at once on a switch, and refuses new ones for the time', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { faults: [{ kind: 'stall', afterBytes: 20_000, ms: null }] })
      const open = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-199999' },
      })
      const broke = expect(open.arrayBuffer()).rejects.toThrow()
      await later(100)
      const switched = performance.now()
      await switchNetwork(server, 700)
      await broke
      await expect(
        fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } }),
      ).rejects.toThrow()
      // The network comes back: requests are answered again.
      await later(Math.max(0, 750 - (performance.now() - switched)))
      const back = await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(back.status).toBe(206)
      await back.arrayBuffer()
      const outcomes = (await logOf(server)).map((entry) => entry.outcome)
      expect(outcomes).toContain('aborted')
      expect(outcomes).toContain('refused')
    })

    it('keeps the control plane up through a refusal: log, control and reset work, and only data is logged refused', async () => {
      const server = await serve()
      await switchNetwork(server, 1500)
      await expect(fetch(`${server.info.base}/file/0`)).rejects.toThrow()
      expect(await logOf(server)).toEqual([
        { id: null, range: null, status: 0, bytesSent: 0, outcome: 'refused' },
      ])
      const cleared = await fetch(`${server.info.controlBase}/log`, { method: 'DELETE' })
      expect(cleared.status).toBe(204)
      expect(await logOf(server)).toEqual([])
      await control(server, {})
    })

    it('ends the refusal when control replaces the network', async () => {
      const server = await serve()
      await switchNetwork(server, 60_000)
      await expect(fetch(`${server.info.base}/file/0`)).rejects.toThrow()
      await control(server, {})
      const back = await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(back.status).toBe(206)
      await back.arrayBuffer()
    })

    it('keeps the bandwidth, the latency and the queued faults through a switch', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, {
        bandwidthBytesPerSecond: 1_000_000,
        latencyMs: 200,
        faults: [{ kind: 'status', status: 503 }],
      })
      await switchNetwork(server, 100)
      await later(150)
      const started = performance.now()
      const failed = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-9' },
      })
      expect(failed.status).toBe(503)
      expect(performance.now() - started).toBeGreaterThanOrEqual(180)
      const read = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-999999' },
      })
      expect(await drain(read)).toBe(1_000_000)
      expect(performance.now() - started).toBeGreaterThan(1000)
    })

    it('turns away an afterBytes that is not a safe integer from 0', async () => {
      const server = await serve()
      for (const afterBytes of ['1.5', '-1', '1e300', '"7"', 'null']) {
        for (const kind of ['drop', 'stall']) {
          const body = `{"faults":[{"kind":"${kind}","afterBytes":${afterBytes},"ms":10}]}`
          const response = await fetch(`${server.info.controlBase}/control`, {
            method: 'POST',
            body,
          })
          expect(response.status, body).toBe(400)
        }
      }
    })

    it('sends Retry-After with a status fault, and lets the page read it', async () => {
      const server = await serve()
      await control(server, { faults: [{ kind: 'status', status: 429, retryAfter: '7' }] })
      const response = await fetch(`${server.info.base}/file/0`, {
        headers: { Range: 'bytes=0-9' },
      })
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('7')
      expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After')
    })

    it('answers a path that is not a URL with a 404, and goes on serving', async () => {
      const server = await serve()
      const { hostname, port } = new URL(server.info.base)
      const reply = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), hostname, () => {
          socket.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        })
        let text = ''
        socket.on('data', (part) => {
          text += String(part)
        })
        socket.on('close', () => {
          resolve(text)
        })
      })
      expect(reply).toMatch(/^HTTP\/1\.1 404 /)
      const next = await fetch(`${server.info.base}/file/0`, { headers: { Range: 'bytes=0-9' } })
      expect(next.status).toBe(206)
    })

    it('paces a slow link by what it can carry: 32 KiB at 64 KiB/s takes about half a second', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { bandwidthBytesPerSecond: 65_536 })
      const started = performance.now()
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-32767' },
      })
      expect(await drain(response)).toBe(32_768)
      const seconds = (performance.now() - started) / 1000
      expect(seconds).toBeGreaterThan(0.4)
      expect(seconds).toBeLessThan(0.6)
    })

    it('trickles a very slow link, with no gap between pieces above half a second', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { bandwidthBytesPerSecond: 2000 })
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-1499' },
      })
      const started = performance.now()
      let last = started
      let widest = 0
      let total = 0
      for await (const piece of response.body as AsyncIterable<Uint8Array>) {
        const now = performance.now()
        widest = Math.max(widest, now - last)
        last = now
        total += piece.length
      }
      expect(total).toBe(1500)
      expect(widest).toBeLessThan(500)
      // The first piece is paid for too: 1500 bytes at 2000 B/s take three quarters of a second.
      expect(last - started).toBeGreaterThan(600)
      expect(last - started).toBeLessThan(950)
    })
  })

  describe('the log', () => {
    it('gives the requests in order, and is cleared by a DELETE', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const get = async (range?: string): Promise<void> => {
        const response = await fetch(`${server.info.base}/file/${file?.id}`, {
          headers: range === undefined ? {} : { Range: range },
        })
        await response.arrayBuffer()
      }
      await get('bytes=0-99')
      await get('bytes=100-')
      await get()
      expect(await logOf(server)).toEqual([
        { id: file?.id, range: 'bytes=0-99', status: 206, bytesSent: 100, outcome: 'done' },
        {
          id: file?.id,
          range: 'bytes=100-',
          status: 206,
          bytesSent: (file?.size ?? 0) - 100,
          outcome: 'done',
        },
        { id: file?.id, range: null, status: 200, bytesSent: file?.size, outcome: 'done' },
      ])
      expect((await fetch(`${server.info.controlBase}/log`, { method: 'DELETE' })).status).toBe(204)
      expect(await logOf(server)).toEqual([])
    })

    it('says a request whose client left was aborted', async () => {
      const server = await serve()
      const file = biggest(server)
      await control(server, { bandwidthBytesPerSecond: 200_000 })
      const response = await fetch(`${server.info.base}/file/${file.id}`, {
        headers: { Range: 'bytes=0-1999999' },
      })
      await readSome(response, 30_000)
      await later(100)
      const [entry] = await logOf(server)
      expect(entry?.outcome).toBe('aborted')
      expect(entry?.bytesSent).toBeLessThan(2_000_000)
    })

    it('says a status fault as the status it gave', async () => {
      const server = await serve()
      await control(server, { faults: [{ kind: 'status', status: 404 }] })
      const response = await fetch(`${server.info.base}/file/0`)
      await response.arrayBuffer()
      expect(await logOf(server)).toEqual([
        { id: '0', range: null, status: 404, bytesSent: 0, outcome: 'done' },
      ])
    })
  })

  describe('the token', () => {
    it('serves nothing without the run token, or under another', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const origin = new URL(server.info.base).origin
      const controlOrigin = new URL(server.info.controlBase).origin
      const token = new URL(server.info.base).pathname
      expect(token).toMatch(/^\/[0-9a-f]{32}$/)
      expect((await fetch(`${origin}/file/${file?.id}`)).status).toBe(404)
      expect((await fetch(`${origin}/wrong${token}/file/${file?.id}`)).status).toBe(404)
      expect((await fetch(`${origin}/not-the-token/file/${file?.id}`)).status).toBe(404)
      expect((await fetch(`${controlOrigin}/not-the-token/log`)).status).toBe(404)
      expect(
        (await fetch(`${controlOrigin}/not-the-token/control`, { method: 'POST', body: '{}' }))
          .status,
      ).toBe(404)
    })

    it('has another token for every run', async () => {
      const [a, b] = [await serve(), await serve()]
      expect(a.info.base).not.toBe(b.info.base)
    })
  })

  describe('CORS', () => {
    it('allows any origin, Range, and reads of the range headers', async () => {
      const server = await serve()
      const file = server.info.files[0]
      const response = await fetch(`${server.info.base}/file/${file?.id}`, {
        headers: { Range: 'bytes=0-9' },
      })
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'Content-Range, Content-Length, ETag, Retry-After',
      )
      await response.arrayBuffer()
    })

    it('answers a preflight with a 204 and the headers', async () => {
      const server = await serve()
      const response = await fetch(`${server.info.base}/file/0`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:51000', 'Access-Control-Request-Headers': 'range' },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-headers')).toBe('Range')
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'Content-Range, Content-Length, ETag, Retry-After',
      )
      const methods = response.headers.get('access-control-allow-methods') ?? ''
      for (const method of ['GET', 'POST', 'DELETE']) expect(methods).toContain(method)
    })
  })
})

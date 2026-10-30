import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadError, openRead } from './read.ts'
import type { OpenReadOptions } from './read.ts'
import { byteAt, startRangeServer } from './testing/range-server.ts'
import type { Fault, RangeServer } from './testing/range-server.ts'

// One Range read, checked (DESIGN.md §10.4; the iron-clad spec §4.7): what the reader accepts,
// what is worth another try and what ends the play, and how a body ends. The tests read from
// the test server, which can answer as a network does, and from stubs of `fetch` for the
// answers that the server cannot give.

const CHUNK = 64 * 1024
const SIZE = 300_000
const SEED = 3
const MIB = 1024 * 1024

const servers: RangeServer[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** Starts a server that is closed at the end of the test, even when it fails. */
async function serve(
  options: { size?: number; faults?: Fault[]; chunkDelayMs?: number } = {},
): Promise<RangeServer> {
  const server = await startRangeServer({ size: SIZE, seed: SEED, ...options })
  servers.push(server)
  return server
}

type Read = Awaited<ReturnType<typeof openRead>>

/** Reads `from` to `to` of the file the server serves; `rest` overrides any option. */
function read(
  server: RangeServer,
  from: number,
  to: number | null = null,
  rest: Partial<OpenReadOptions> = {},
): Promise<Read> {
  return openRead({
    url: server.url,
    from,
    to,
    fileSize: null,
    signal: new AbortController().signal,
    ...rest,
  })
}

/** The bytes of the file from `start` up to, not including, `end`. */
function expected(start: number, end: number): Uint8Array {
  const bytes = new Uint8Array(end - start)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = byteAt(SEED, start + at)
  return bytes
}

/** What a body gave before it ended, and what it ended with (undefined when it ended well). */
async function drain(
  body: AsyncIterable<Uint8Array>,
): Promise<{ bytes: Uint8Array; error: unknown }> {
  const parts: Uint8Array[] = []
  let error: unknown
  try {
    for await (const part of body) parts.push(part)
  } catch (caught) {
    error = caught
  }
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return { bytes, error }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const { bytes, error } = await drain(body)
  if (error !== undefined) throw error as Error
  return bytes
}

/** The `ReadError` that a promise rejects with. */
async function readFailure(promise: Promise<unknown>): Promise<ReadError> {
  let error: unknown
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ReadError)
  if (!(error instanceof ReadError)) throw new Error('it did not reject with a ReadError')
  return error
}

/** What a promise rejects with, whatever it is. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  throw new Error('it did not reject')
}

/** A stub of `fetch` that answers with a response made by `make`, and records its calls. */
function stub(make: () => Response): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() => Promise.resolve(make()))
}

function stubbed(
  fetchStub: typeof fetch,
  from: number,
  to: number | null,
  rest: Partial<OpenReadOptions> = {},
): Promise<Read> {
  return openRead({
    url: 'http://stub.test/file.bin',
    from,
    to,
    fileSize: null,
    signal: new AbortController().signal,
    fetch: fetchStub,
    ...rest,
  })
}

/** A body of `count` bytes that ends well, in one piece. */
function bodyOf(count: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(count))
      controller.close()
    },
  })
}

describe('the ranges asked for', () => {
  it('bytes=0- gives the whole file, byte for byte, and its total', async () => {
    const server = await serve()
    const { total, body } = await read(server, 0)
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(0, SIZE))
    expect(server.requests).toEqual([{ range: 'bytes=0-' }])
  })

  it('bytes=5000- gives the file from 5000 to its end, and its total', async () => {
    const server = await serve()
    const { total, body } = await read(server, 5000)
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(5000, SIZE))
    expect(server.requests).toEqual([{ range: 'bytes=5000-' }])
  })

  it('bytes=5000-5999 gives those 1000 bytes, the last one included, and the file’s total', async () => {
    const server = await serve()
    const { total, body } = await read(server, 5000, 5999)
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(5000, 6000))
    expect(server.requests).toEqual([{ range: 'bytes=5000-5999' }])
  })

  it('reads one byte, the last of the file', async () => {
    const server = await serve()
    const { body } = await read(server, SIZE - 1, SIZE - 1)
    expect(await collect(body)).toEqual(expected(SIZE - 1, SIZE))
  })

  it('takes less than it asked for when the file ends first', async () => {
    const server = await serve()
    const { total, body } = await read(server, SIZE - 1000, SIZE + 5000)
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(SIZE - 1000, SIZE))
  })

  it('accepts a total that is the file size it was given', async () => {
    const server = await serve()
    const { total, body } = await read(server, 100, 199, { fileSize: SIZE })
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(100, 200))
  })

  it('accepts a 200 at 0, with the total from its Content-Length', async () => {
    const server = await serve({ faults: [{ kind: 'ignore-range' }] })
    const { total, body } = await read(server, 0)
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(0, SIZE))
  })

  it('accepts a 200 at 0 whose Content-Length is the file size it was given', async () => {
    const server = await serve({ faults: [{ kind: 'ignore-range' }] })
    const { total, body } = await read(server, 0, null, { fileSize: SIZE })
    expect(total).toBe(SIZE)
    expect(await collect(body)).toEqual(expected(0, SIZE))
  })

  it('cuts a 200 at the end it asked for, so that the rest of the file is not read', async () => {
    const server = await serve({
      size: 8 * 1024 * 1024,
      chunkDelayMs: 20,
      faults: [{ kind: 'ignore-range' }],
    })
    const { total, body } = await read(server, 0, 999)
    expect(total).toBe(8 * 1024 * 1024)
    const bytes = await collect(body)
    expect(bytes.length).toBe(1000)
    expect(bytes).toEqual(expected(0, 1000))
    await expect.poll(() => server.openResponses(), { timeout: 3000 }).toBe(0)
  })

  it('cuts a 206 that is longer than it asked for', async () => {
    const fetchStub = stub(
      () =>
        new Response(new Uint8Array(20), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-19/100' },
        }),
    )
    const { total, body } = await stubbed(fetchStub, 0, 9)
    expect(total).toBe(100)
    expect((await collect(body)).length).toBe(10)
  })

  it('sends the request as given: url, Range, and the signal', async () => {
    const controller = new AbortController()
    const fetchStub = stub(
      () =>
        new Response(new Uint8Array(10), {
          status: 206,
          headers: { 'Content-Range': 'bytes 10-19/100' },
        }),
    )
    await stubbed(fetchStub, 10, 19, { signal: controller.signal })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [input, init] = fetchStub.mock.calls[0] ?? []
    expect(input).toBe('http://stub.test/file.bin')
    expect(new Headers(init?.headers).get('Range')).toBe('bytes=10-19')
    expect(init?.signal).toBe(controller.signal)
  })

  it('keeps the answer out of the browser’s HTTP cache, so no plaintext is left on the disk', async () => {
    const fetchStub = stub(
      () =>
        new Response(new Uint8Array(10), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-9/100' },
        }),
    )
    await stubbed(fetchStub, 0, 9)
    const [, init] = fetchStub.mock.calls[0] ?? []
    expect(init?.cache).toBe('no-store')
  })

  it('calls the fetch it is given as a plain function, not as a method of its options', async () => {
    const thisValues: unknown[] = []
    const options: OpenReadOptions = {
      url: 'http://stub.test/file.bin',
      from: 0,
      to: 9,
      fileSize: null,
      signal: new AbortController().signal,
      fetch: function (this: unknown) {
        thisValues.push(this)
        return Promise.resolve(
          new Response(new Uint8Array(10), {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-9/100' },
          }),
        )
      },
    }
    await openRead(options)
    expect(thisValues.length).toBe(1)
    expect(thisValues[0]).not.toBe(options)
  })

  it('uses the global fetch when it is given none', async () => {
    const original = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(original)
    const server = await serve()
    const { body } = await read(server, 0, 9)
    await collect(body)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('an answer that ends the play', () => {
  it.each([400, 401, 403, 404, 410, 416, 418, 451])('a %i is fatal', async (status) => {
    const server = await serve({ faults: [{ kind: 'status', status }] })
    const error = await readFailure(read(server, 0))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(status)
    expect(error.retryAfterMs).toBeNull()
  })

  it('an answer that ignores Range, at a start past 0, is fatal', async () => {
    const server = await serve({ faults: [{ kind: 'ignore-range' }] })
    const error = await readFailure(read(server, 5000))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(200)
  })

  it('a total that is not the file size it was given is fatal, in a 206', async () => {
    const server = await serve()
    const error = await readFailure(read(server, 0, 99, { fileSize: SIZE + 1 }))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(206)
  })

  it('a total that is not the file size it was given is fatal, in a 200', async () => {
    const server = await serve({ faults: [{ kind: 'ignore-range' }] })
    const error = await readFailure(read(server, 0, null, { fileSize: SIZE - 1 }))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(200)
  })

  it('a 206 that starts elsewhere than it asked is fatal', async () => {
    const fetchStub = stub(
      () =>
        new Response(new Uint8Array(100), {
          status: 206,
          headers: { 'Content-Range': 'bytes 6000-6099/300000' },
        }),
    )
    const error = await readFailure(stubbed(fetchStub, 5000, 5099))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(206)
  })

  it.each([
    ['has no Content-Range', undefined],
    ['has a Content-Range that cannot be read', 'bytes abc'],
    ['has a total that is not known', 'bytes 5000-5099/*'],
    ['ends before it starts', 'bytes 5000-4999/300000'],
    ['ends past the end of the file', 'bytes 5000-5099/5050'],
    ['is not a byte range', 'items 5000-5099/300000'],
  ])('a 206 that %s is fatal', async (_name, contentRange) => {
    const fetchStub = stub(
      () =>
        new Response(new Uint8Array(100), {
          status: 206,
          headers: contentRange === undefined ? {} : { 'Content-Range': contentRange },
        }),
    )
    const error = await readFailure(stubbed(fetchStub, 5000, 5099))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(206)
  })

  it('a 200 with no Content-Length is fatal, whether the file size is known or not', async () => {
    for (const fileSize of [null, 100]) {
      const response = new Response(new Uint8Array(100), { status: 200 })
      expect(response.headers.get('Content-Length')).toBeNull()
      const error = await readFailure(
        stubbed(
          stub(() => response),
          0,
          null,
          { fileSize },
        ),
      )
      expect(error.fatal).toBe(true)
      expect(error.status).toBe(200)
    }
  })

  it.each([204, 202, 304])('a %i, which is not an answer to a Range, is fatal', async (status) => {
    const fetchStub = stub(() => new Response(null, { status }))
    const error = await readFailure(stubbed(fetchStub, 0, null))
    expect(error.fatal).toBe(true)
    expect(error.status).toBe(status)
  })

  it('cancels the body of an answer it refuses, so that a whole file is not left running', async () => {
    const server = await serve({
      size: 8 * 1024 * 1024,
      chunkDelayMs: 20,
      faults: [{ kind: 'ignore-range' }],
    })
    const error = await readFailure(read(server, 5000))
    expect(error.fatal).toBe(true)
    await expect.poll(() => server.openResponses(), { timeout: 3000 }).toBe(0)
  })
})

describe('an answer worth another try', () => {
  it.each([408, 429, 500, 502, 503, 504])('a %i is not fatal', async (status) => {
    const server = await serve({ faults: [{ kind: 'status', status }] })
    const error = await readFailure(read(server, 0))
    expect(error.fatal).toBe(false)
    expect(error.status).toBe(status)
    expect(error.retryAfterMs).toBeNull()
  })

  it('a 503 with Retry-After: 2 says to wait 2000 ms', async () => {
    const server = await serve({ faults: [{ kind: 'status', status: 503, retryAfter: '2' }] })
    const error = await readFailure(read(server, 0))
    expect(error.fatal).toBe(false)
    expect(error.status).toBe(503)
    expect(error.retryAfterMs).toBe(2000)
  })

  it('reads Retry-After: 0 as no wait', async () => {
    const server = await serve({ faults: [{ kind: 'status', status: 429, retryAfter: '0' }] })
    const error = await readFailure(read(server, 0))
    expect(error.retryAfterMs).toBe(0)
  })

  it('reads a Retry-After that is an HTTP date as the time until then', async () => {
    const now = Date.parse('2026-10-30T10:00:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetchStub = stub(
      () =>
        new Response(null, {
          status: 503,
          headers: { 'Retry-After': new Date(now + 7000).toUTCString() },
        }),
    )
    const error = await readFailure(stubbed(fetchStub, 0, null))
    expect(error.fatal).toBe(false)
    expect(error.retryAfterMs).toBe(7000)
  })

  it('reads a Retry-After date that has passed as no wait', async () => {
    const now = Date.parse('2026-10-30T10:00:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetchStub = stub(
      () =>
        new Response(null, {
          status: 503,
          headers: { 'Retry-After': new Date(now - 60_000).toUTCString() },
        }),
    )
    const error = await readFailure(stubbed(fetchStub, 0, null))
    expect(error.retryAfterMs).toBe(0)
  })

  it.each(['soon', '', '1.5', 'two seconds'])(
    'reads a Retry-After of "%s", which cannot be read, as none',
    async (retryAfter) => {
      const fetchStub = stub(
        () => new Response(null, { status: 503, headers: { 'Retry-After': retryAfter } }),
      )
      const error = await readFailure(stubbed(fetchStub, 0, null))
      expect(error.fatal).toBe(false)
      expect(error.retryAfterMs).toBeNull()
    },
  )

  it('returns a long Retry-After as given: the downloader caps it', async () => {
    const fetchStub = stub(
      () => new Response(null, { status: 429, headers: { 'Retry-After': '86400' } }),
    )
    const error = await readFailure(stubbed(fetchStub, 0, null))
    expect(error.retryAfterMs).toBe(86_400_000)
  })

  it('a network error from fetch is not fatal, and has no status', async () => {
    const cause = new TypeError('Failed to fetch')
    const fetchStub = vi.fn<typeof fetch>(() => Promise.reject(cause))
    const error = await readFailure(stubbed(fetchStub, 0, null))
    expect(error.fatal).toBe(false)
    expect(error.status).toBeNull()
    expect(error.retryAfterMs).toBeNull()
    expect(error.cause).toBe(cause)
  })

  it('a connection that is refused is not fatal', async () => {
    const server = await startRangeServer({ size: 100, seed: SEED })
    const url = server.url
    await server.close()
    const error = await readFailure(
      openRead({ url, from: 0, to: null, fileSize: null, signal: new AbortController().signal }),
    )
    expect(error.fatal).toBe(false)
    expect(error.status).toBeNull()
  })

  it('a drop after 1000 bytes gives those bytes and then a ReadError that is not fatal', async () => {
    const server = await serve({ faults: [{ kind: 'drop', afterBytes: 1000 }] })
    const { total, body } = await read(server, 0)
    expect(total).toBe(SIZE)
    const { bytes, error } = await drain(body)
    expect(bytes).toEqual(expected(0, 1000))
    expect(error).toBeInstanceOf(ReadError)
    if (!(error instanceof ReadError)) throw new Error('not a ReadError')
    expect(error.fatal).toBe(false)
    expect(error.status).toBe(206)
    expect(error.retryAfterMs).toBeNull()
  })

  it('a drop in the middle of a later chunk gives every byte before it', async () => {
    const server = await serve({ faults: [{ kind: 'drop', afterBytes: 2 * CHUNK + 777 }] })
    const { body } = await read(server, 100)
    const { bytes, error } = await drain(body)
    expect(bytes).toEqual(expected(100, 100 + 2 * CHUNK + 777))
    expect(error).toBeInstanceOf(ReadError)
    expect((error as ReadError).fatal).toBe(false)
  })

  it('a body that ends before its length gives what it had and then a ReadError that is not fatal', async () => {
    const fetchStub = stub(
      () =>
        new Response(bodyOf(40), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-99/1000' },
        }),
    )
    const { body } = await stubbed(fetchStub, 0, 99)
    const { bytes, error } = await drain(body)
    expect(bytes.length).toBe(40)
    expect(error).toBeInstanceOf(ReadError)
    expect((error as ReadError).fatal).toBe(false)
    expect((error as ReadError).status).toBe(206)
  })

  it('a body that ends before the length a 200 gave is the same', async () => {
    const fetchStub = stub(
      () => new Response(bodyOf(40), { status: 200, headers: { 'Content-Length': '100' } }),
    )
    const { total, body } = await stubbed(fetchStub, 0, null)
    expect(total).toBe(100)
    const { bytes, error } = await drain(body)
    expect(bytes.length).toBe(40)
    expect((error as ReadError).fatal).toBe(false)
  })

  it('a TypeError from reading the body is not fatal', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new Uint8Array(10))
        else controller.error(new TypeError('terminated'))
      },
    })
    const fetchStub = stub(
      () => new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-99/1000' } }),
    )
    const { body } = await stubbed(fetchStub, 0, 99)
    const { bytes, error } = await drain(body)
    expect(bytes.length).toBe(10)
    expect(error).toBeInstanceOf(ReadError)
    expect((error as ReadError).fatal).toBe(false)
    expect((error as ReadError).cause).toBeInstanceOf(TypeError)
  })
})

describe('the message of an error', () => {
  const SECRET = 'token=hunter2'

  it('names the bytes asked for and no part of the URL, its query and fragment included', async () => {
    const server = await serve({ faults: [{ kind: 'status', status: 404 }] })
    const error = await readFailure(read({ ...server, url: `${server.url}?${SECRET}#frag` }, 0))
    expect(error.message).toContain('404')
    expect(error.message).toContain('bytes 0-')
    expect(error.message).not.toContain('file.bin')
    expect(error.message).not.toContain('127.0.0.1')
    expect(error.message).not.toContain('hunter2')
    expect(error.message).not.toContain('?')
    expect(error.message).not.toContain('#')
  })

  it('says what happened and the range, as a sentence', async () => {
    const open = stubbed(
      stub(() => new Response(null, { status: 404 })),
      5 * MIB,
      null,
    )
    expect((await readFailure(open)).message).toBe('The server answered 404 for bytes 5242880-.')
    const bounded = stubbed(
      stub(() => new Response(null, { status: 503 })),
      0,
      MIB - 1,
    )
    expect((await readFailure(bounded)).message).toBe(
      'The server answered 503 for bytes 0-1048575.',
    )
  })

  // A share link has its token in the path (`/api/s/:token/files/:id/content`), and a message
  // reaches the timeline that the server keeps for 28 days: so no message names the URL.
  describe('of a share link', () => {
    const TOKEN = 'SECRETTOKEN123'
    const SHARE_URL = `https://x.test/api/s/${TOKEN}/files/f1/content?play=1`
    const NOT_BYTES = {
      read: () => Promise.resolve({ done: false, value: 'not bytes' }),
      cancel: () => Promise.resolve(),
    }

    /** One way for a read to fail, and the range it asked for. */
    interface Failing {
      from: number
      to: number | null
      fileSize?: number | null
      /** The `fetch` that answers; made when the read is, since a body is read once. */
      fetch: () => typeof fetch
      /** Whether the read fails in its body, after it was opened. */
      inBody?: boolean
    }

    const answer = (make: () => Response): (() => typeof fetch) => {
      return () => stub(make)
    }
    /** A 206 whose body is made by `body`; a stream is made once per read. */
    const partial = (
      contentRange: string | undefined,
      body: () => ConstructorParameters<typeof Response>[0],
    ) =>
      answer(
        () =>
          new Response(body(), {
            status: 206,
            headers: contentRange === undefined ? {} : { 'Content-Range': contentRange },
          }),
      )

    const failures: [string, Failing][] = [
      ...[400, 401, 403, 404, 410, 416, 418, 451].map((status): [string, Failing] => [
        `a fatal ${status}`,
        { from: 5 * MIB, to: null, fetch: answer(() => new Response(null, { status })) },
      ]),
      ...[408, 429, 500, 502, 503, 504].map((status): [string, Failing] => [
        `a ${status}, which is worth another try`,
        { from: 0, to: MIB - 1, fetch: answer(() => new Response(null, { status })) },
      ]),
      [
        'a request that failed before the server answered',
        {
          from: 0,
          to: 99,
          fetch: () => vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch'))),
        },
      ],
      [
        'a Content-Range that is missing',
        { from: 5000, to: 5099, fetch: partial(undefined, () => new Uint8Array(100)) },
      ],
      [
        'a Content-Range that cannot be read',
        { from: 5000, to: 5099, fetch: partial('bytes abc', () => new Uint8Array(100)) },
      ],
      [
        'a Content-Range that starts elsewhere',
        {
          from: 5000,
          to: 5099,
          fetch: partial('bytes 6000-6099/300000', () => new Uint8Array(100)),
        },
      ],
      [
        'a Content-Range that is not a range of the file',
        { from: 5000, to: 5099, fetch: partial('bytes 5000-5099/5050', () => new Uint8Array(100)) },
      ],
      [
        'a total that is not the size of the file, in a 206',
        {
          from: 0,
          to: 99,
          fileSize: 1001,
          fetch: partial('bytes 0-99/1000', () => new Uint8Array(100)),
        },
      ],
      [
        'a total that is not the size of the file, in a 200',
        {
          from: 0,
          to: null,
          fileSize: 99,
          fetch: answer(
            () =>
              new Response(new Uint8Array(100), {
                status: 200,
                headers: { 'Content-Length': '100' },
              }),
          ),
        },
      ],
      [
        'a 200 at a start past 0',
        {
          from: 5000,
          to: null,
          fetch: answer(
            () =>
              new Response(new Uint8Array(100), {
                status: 200,
                headers: { 'Content-Length': '100' },
              }),
          ),
        },
      ],
      [
        'a 200 with no Content-Length',
        {
          from: 0,
          to: null,
          fetch: answer(() => new Response(new Uint8Array(100), { status: 200 })),
        },
      ],
      ['a 206 with no body', { from: 0, to: 9, fetch: partial('bytes 0-9/100', () => null) }],
      [
        'a body that breaks',
        {
          from: 0,
          to: 99,
          inBody: true,
          fetch: partial('bytes 0-99/1000', () => {
            let pulls = 0
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1
                if (pulls === 1) controller.enqueue(new Uint8Array(10))
                else controller.error(new TypeError('terminated'))
              },
            })
          }),
        },
      ],
      [
        'a body that ends before its length',
        { from: 0, to: 99, inBody: true, fetch: partial('bytes 0-99/1000', () => bodyOf(40)) },
      ],
      [
        'a body that gives something other than bytes',
        {
          from: 0,
          to: 4,
          inBody: true,
          fetch: () =>
            vi.fn<typeof fetch>(() =>
              Promise.resolve({
                status: 206,
                headers: new Headers({ 'Content-Range': 'bytes 0-4/10' }),
                body: { getReader: () => NOT_BYTES },
              } as unknown as Response),
            ),
        },
      ],
    ]

    it.each(failures)('names nothing of the URL in the message of %s', async (_name, failing) => {
      const attempt = stubbed(failing.fetch(), failing.from, failing.to, {
        url: SHARE_URL,
        ...(failing.fileSize === undefined ? {} : { fileSize: failing.fileSize }),
      })
      let error: unknown
      if (failing.inBody === true) error = (await drain((await attempt).body)).error
      else error = await readFailure(attempt)
      expect(error).toBeInstanceOf(ReadError)
      const message = (error as ReadError).message
      // The message says which bytes: that is what it has in place of the address.
      expect(message).toContain(`bytes ${failing.from}-${failing.to ?? ''}`)
      for (const part of [TOKEN, '/api/', '/s/', 'files', 'content', 'x.test', 'https', 'play=1']) {
        expect(message).not.toContain(part)
      }
      expect(message).not.toContain('?')
      expect(message).not.toContain('#')
    })
  })

  it('does not name the query in a network error or in a body that breaks', async () => {
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch')))
    const network = await readFailure(stubbed(failing, 0, null, { url: `/x/y?${SECRET}` }))
    expect(network.message).not.toContain('hunter2')

    const server = await serve({ faults: [{ kind: 'drop', afterBytes: 10 }] })
    const { body } = await read({ ...server, url: `${server.url}?${SECRET}` }, 0)
    const { error } = await drain(body)
    expect(error).toBeInstanceOf(ReadError)
    expect((error as ReadError).message).not.toContain('hunter2')
  })

  it('does not name the user info of a URL', async () => {
    const fetchStub = stub(() => new Response(null, { status: 404 }))
    const error = await readFailure(
      stubbed(fetchStub, 0, null, { url: 'http://user:hunter2@stub.test/file.bin' }),
    )
    expect(error.message).not.toContain('hunter2')
  })
})

describe('aborting', () => {
  it('a signal that is aborted before the read rejects with an AbortError, not a ReadError', async () => {
    const server = await serve()
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(read(server, 0, null, { signal: controller.signal }))
    expect(error).not.toBeInstanceOf(ReadError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('a signal that is aborted while the request is out rejects with an AbortError', async () => {
    const server = await serve()
    const controller = new AbortController()
    const pending = read(server, 0, null, { signal: controller.signal })
    controller.abort()
    const error = await rejection(pending)
    expect(error).not.toBeInstanceOf(ReadError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('aborting during the body ends it with an AbortError, not a ReadError, and the server lets go', async () => {
    const server = await serve({ size: 8 * 1024 * 1024, chunkDelayMs: 20 })
    const controller = new AbortController()
    const { body } = await read(server, 0, null, { signal: controller.signal })
    const iterator = body[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort()
    const error = await rejection(iterator.next())
    expect(error).not.toBeInstanceOf(ReadError)
    expect(error).toMatchObject({ name: 'AbortError' })
    await expect.poll(() => server.openResponses(), { timeout: 3000 }).toBe(0)
  })

  it('whatever an abort is made with is what the read ends with', async () => {
    const server = await serve({ size: 8 * 1024 * 1024, chunkDelayMs: 20 })
    const controller = new AbortController()
    const { body } = await read(server, 0, null, { signal: controller.signal })
    const iterator = body[Symbol.asyncIterator]()
    await iterator.next()
    const reason = new Error('the viewer left')
    controller.abort(reason)
    expect(await rejection(iterator.next())).toBe(reason)
  })

  it('an abort is never a ReadError, whatever the fetch ends with', async () => {
    const reason = new Error('the viewer left')
    const controller = new AbortController()
    const fetchStub = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new TypeError('anything else a browser would say'))
          })
        }),
    )
    const pending = stubbed(fetchStub, 0, null, { signal: controller.signal })
    controller.abort(reason)
    const error = await rejection(pending)
    expect(error).not.toBeInstanceOf(ReadError)
  })

  it('an AbortError from a fetch whose signal is not aborted passes through too', async () => {
    const fetchStub = vi.fn<typeof fetch>(() =>
      Promise.reject(new DOMException('timed out', 'AbortError')),
    )
    const error = await rejection(stubbed(fetchStub, 0, null))
    expect(error).not.toBeInstanceOf(ReadError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('a body that is read after the abort throws at once, even with bytes in hand', async () => {
    const controller = new AbortController()
    const fetchStub = stub(
      () =>
        new Response(bodyOf(100), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-99/1000' },
        }),
    )
    const { body } = await stubbed(fetchStub, 0, 99, { signal: controller.signal })
    controller.abort()
    const error = await rejection(body[Symbol.asyncIterator]().next())
    expect(error).not.toBeInstanceOf(ReadError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })
})

describe('how the body is read', () => {
  it('a consumer that stops early cancels the body, and the server sees the connection close', async () => {
    const server = await serve({ size: 8 * 1024 * 1024, chunkDelayMs: 20 })
    const { body } = await read(server, 0)
    let count = 0
    for await (const part of body) {
      count += part.length
      break
    }
    expect(count).toBeGreaterThan(0)
    await expect.poll(() => server.openResponses(), { timeout: 3000 }).toBe(0)
  })

  it('reads with getReader and nothing else: Safari 17 and Chrome 120 have no async iteration', async () => {
    const reads: string[] = []
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
    const reader = {
      read: () => {
        reads.push('read')
        const value = chunks.shift()
        return Promise.resolve(
          value === undefined ? { done: true, value: undefined } : { done: false, value },
        )
      },
      cancel: () => {
        reads.push('cancel')
        return Promise.resolve()
      },
    }
    // Only `getReader`: a `for await` over this body, or over a stream, would find nothing to call.
    const response = {
      status: 206,
      headers: new Headers({ 'Content-Range': 'bytes 0-4/10' }),
      body: { getReader: () => reader },
    } as unknown as Response
    const { body } = await stubbed(
      vi.fn<typeof fetch>(() => Promise.resolve(response)),
      0,
      4,
    )
    expect(await collect(body)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(reads.slice(0, 3)).toEqual(['read', 'read', 'cancel'])
  })

  it('cancels the stream when the consumer stops early', async () => {
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10))
      },
      cancel() {
        cancelled += 1
      },
    })
    const fetchStub = stub(
      () => new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-999/1000' } }),
    )
    const { body } = await stubbed(fetchStub, 0, 999)
    for await (const part of body) {
      expect(part.length).toBe(10)
      break
    }
    expect(cancelled).toBe(1)
  })

  it('ends a body that has all its bytes without waiting for the stream to close', async () => {
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10))
      },
      cancel() {
        cancelled += 1
      },
    })
    const fetchStub = stub(
      () => new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-9/100' } }),
    )
    const { body } = await stubbed(fetchStub, 0, 9)
    expect((await collect(body)).length).toBe(10)
    expect(cancelled).toBe(1)
  })

  it('skips an empty piece', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(new Uint8Array(10))
        controller.close()
      },
    })
    const fetchStub = stub(
      () => new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-9/100' } }),
    )
    const { body } = await stubbed(fetchStub, 0, 9)
    const pieces: number[] = []
    for await (const part of body) pieces.push(part.length)
    expect(pieces).toEqual([10])
  })
})

describe('a call that is wrong', () => {
  it.each([
    ['a negative start', -1, null, null],
    ['a start that is not a whole number', 1.5, null, null],
    ['a start that is not a number', Number.NaN, null, null],
    ['an end before the start', 10, 9, null],
    ['an end that is not a whole number', 0, 9.5, null],
    ['a negative file size', 0, null, -1],
    ['a file size that is not a whole number', 0, null, 10.5],
  ])(
    'rejects %s with a RangeError, without asking the server',
    async (_name, from, to, fileSize) => {
      const fetchStub = vi.fn<typeof fetch>()
      const error = await rejection(stubbed(fetchStub, from, to, { fileSize }))
      expect(error).toBeInstanceOf(RangeError)
      expect(error).not.toBeInstanceOf(ReadError)
      expect(fetchStub).not.toHaveBeenCalled()
    },
  )
})

describe('ReadError', () => {
  it('is an Error with its name, its message and the facts of what happened', () => {
    const error = new ReadError('the server answered 503', {
      fatal: false,
      status: 503,
      retryAfterMs: 2000,
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ReadError')
    expect(error.message).toBe('the server answered 503')
    expect(error.fatal).toBe(false)
    expect(error.status).toBe(503)
    expect(error.retryAfterMs).toBe(2000)
  })

  it('has no status and no wait when it was not given them', () => {
    const error = new ReadError('the connection broke', { fatal: false })
    expect(error.status).toBeNull()
    expect(error.retryAfterMs).toBeNull()
  })
})

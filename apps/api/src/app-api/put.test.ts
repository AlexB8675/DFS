import http, { type IncomingHttpHeaders } from 'node:http'
import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { abandonIdleUploads } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { madeAppTokenSchema } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// `PUT /api/v1/files/{path}` (DESIGN.md §7.8), against a real database: whole
// uploads over `fetch`, streams held open over `node:http`, and refusals
// through `inject`.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let baseUrl: string
let owner: ApiClient
let rootId: string
let token: string
let otherToken: string
let readOnlyToken: string

interface Item {
  id: string
  name: string
  path: string
  kind: string
  size: number
  mimeType: string | null
  version: string | null
}
interface Failure {
  error: { code: string; message: string }
}

async function makeAppToken(
  client: ApiClient,
  folderId: string,
  canWrite: boolean,
): Promise<{ token: string; id: string }> {
  const made = await client.call('POST', '/app-tokens', madeAppTokenSchema, {
    json: { name: 'Put agent', folderId, canWrite },
  })
  return { token: made.token, id: made.appToken.id }
}

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'alice', password: 'the-alice-password' })
  owner = new ApiClient(baseUrl, setup.config.publicBaseUrl)
  await owner.signIn('alice', 'the-alice-password')
  const root = await workspace(owner)
  rootId = root.id
  const notes = await createFolder(owner, root.id, 'Notes')
  const other = await createFolder(owner, root.id, 'Other')
  await createFolder(owner, notes.id, 'Sub')
  await uploadFile(owner, notes.id, 'a.txt', text('hello'))
  token = (await makeAppToken(owner, notes.id, true)).token
  otherToken = (await makeAppToken(owner, other.id, true)).token
  readOnlyToken = (await makeAppToken(owner, notes.id, false)).token
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await database.drop()
})

function put(
  path: string,
  body: Uint8Array | undefined,
  headers: Record<string, string> = {},
  bearer = token,
) {
  return fetch(`${baseUrl}/api/v1/files/${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    body,
  })
}

function get(path: string, bearer = token) {
  return fetch(`${baseUrl}/api/v1/files/${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
}

async function stat(path: string, bearer = token): Promise<Item> {
  const response = await fetch(`${baseUrl}/api/v1/stat/${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Item
}

const bytes = (length: number, seed = 1) => new Uint8Array(length).map((_, i) => (i * seed) % 251)
const same = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right))

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  json: unknown
}

/** A `PUT` whose body the test sends, a piece at a time: `size` undefined sends it chunked. */
function rawPut(
  path: string,
  size: number | undefined,
  headers: Record<string, string> = {},
  bearer = token,
) {
  const request = http.request(`${baseUrl}/api/v1/files/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(size === undefined ? {} : { 'content-length': String(size) }),
      ...headers,
    },
  })
  const answer = new Promise<Answer>((resolve, reject) => {
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          json: raw === '' ? null : (JSON.parse(raw) as unknown),
        })
      })
    })
    request.on('error', reject)
  })
  answer.catch(() => undefined)
  // Headers go out now, whether or not a body follows.
  request.flushHeaders()
  return {
    answer,
    write: (data: Uint8Array) =>
      new Promise<void>((resolve) => {
        request.write(data, () => {
          resolve()
        })
      }),
    end: (data?: Uint8Array) => {
      request.end(data)
    },
    abort: () => {
      request.destroy()
    },
  }
}

async function sessionCount(): Promise<number> {
  const { rows } = await app.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM upload_sessions`,
  )
  return rows[0]?.n ?? 0
}

/** Waits until `count` sessions exist: the streams held open have started. */
async function sessionsReach(count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await sessionCount()).toBe(count)
    },
    { timeout: 10_000 },
  )
}

async function reservedBytes(username: string): Promise<number> {
  const { rows } = await app.db.execute<{ n: number }>(
    sql`SELECT reserved_bytes::float8 AS n FROM users WHERE username = ${username}`,
  )
  return rows[0]?.n ?? -1
}

async function stagingReserved(): Promise<number> {
  const { rows } = await app.db.execute<{ n: number }>(
    sql`SELECT coalesce(sum(staging_reserved_bytes), 0)::float8 AS n FROM upload_sessions`,
  )
  return rows[0]?.n ?? -1
}

async function nodesNamed(name: string): Promise<{ id: string; current: string | null }[]> {
  const { rows } = await app.db.execute<{ id: string; current: string | null }>(sql`
    SELECT id, current_version_id AS current FROM nodes /* tree: test, by name */
    WHERE name = ${name}`)
  return rows
}

async function versionsOf(nodeId: string): Promise<number> {
  const { rows } = await app.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM file_versions WHERE node_id = ${nodeId}`,
  )
  return rows[0]?.n ?? -1
}

describe('PUT /api/v1/files: new files', () => {
  it('makes a file, answers 201 with the item, and the bytes read back', async () => {
    const body = new TextEncoder().encode('first file')
    const response = await put('n1.txt', body, { 'content-type': 'text/plain' })
    expect(response.status).toBe(201)
    const item = (await response.json()) as Item
    expect(item).toMatchObject({
      name: 'n1.txt',
      path: 'n1.txt',
      kind: 'file',
      size: body.length,
      mimeType: 'text/plain',
    })
    expect(item.version).toEqual(expect.any(String))
    const read = await get('n1.txt')
    expect(same(new Uint8Array(await read.arrayBuffer()), body)).toBe(true)
  })

  it.each(['application/json', 'multipart/form-data; boundary=x'])(
    'stores a 2 MiB %s body byte for byte, with its type',
    async (type) => {
      const body = bytes(2 * 1024 * 1024, 7)
      const name = `typed-${type.slice(0, 5)}.bin`
      const response = await put(name, body, { 'content-type': type })
      expect(response.status).toBe(201)
      expect(((await response.json()) as Item).mimeType).toBe(type)
      const read = await get(name)
      expect(read.headers.get('content-type')).toContain(type.split(';')[0])
      expect(same(new Uint8Array(await read.arrayBuffer()), body)).toBe(true)
    },
  )

  it('keeps no type when none was sent, and serves the file as octet-stream', async () => {
    const response = await put('untyped.bin', bytes(10))
    expect(response.status).toBe(201)
    expect(((await response.json()) as Item).mimeType).toBeNull()
    expect((await get('untyped.bin')).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('stores a type that is not one as sent', async () => {
    const response = await put('odd.bin', bytes(10), { 'content-type': 'not a type' })
    expect(response.status).toBe(201)
    expect(((await response.json()) as Item).mimeType).toBe('not a type')
  })

  it('refuses a type over 255 characters', async () => {
    const response = await put('long-type.bin', bytes(3), {
      'content-type': `a/${'b'.repeat(255)}`,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Failure).error.code).toBe('invalid_request')
    expect(await nodesNamed('long-type.bin')).toHaveLength(0)
  })

  it('takes an empty body: a file of size 0, readable', async () => {
    const response = await put('empty.txt', new Uint8Array(0), { 'content-length': '0' })
    expect(response.status).toBe(201)
    expect(((await response.json()) as Item).size).toBe(0)
    const read = await get('empty.txt')
    expect(read.status).toBe(200)
    expect((await read.arrayBuffer()).byteLength).toBe(0)
  })

  it('takes a body of more than two parts', async () => {
    const body = bytes(2 * app.config.sizes.chunkSize + 5, 3)
    const response = await put('big.bin', body, { 'content-type': 'application/octet-stream' })
    expect(response.status).toBe(201)
    expect(((await response.json()) as Item).size).toBe(body.length)
    const read = await get('big.bin')
    expect(same(new Uint8Array(await read.arrayBuffer()), body)).toBe(true)
  })

  it('makes the folders the path needs', async () => {
    const response = await put('Sub/New/c.txt', text('deep'))
    expect(response.status).toBe(201)
    expect(((await response.json()) as Item).path).toBe('Sub/New/c.txt')
    expect((await stat('Sub/New')).kind).toBe('folder')
  })
})

describe('PUT /api/v1/files: replacing', () => {
  it('makes a new version, 200, and changes the type each time', async () => {
    const first = (await (
      await put('r.txt', bytes(5), { 'content-type': 'text/plain' })
    ).json()) as Item
    const csv = await put('r.txt', bytes(6), { 'content-type': 'text/csv' })
    expect(csv.status).toBe(200)
    const second = (await csv.json()) as Item
    expect(second.version).not.toBe(first.version)
    expect(second.mimeType).toBe('text/csv')
    expect(second.id).toBe(first.id)

    const none = await put('r.txt', bytes(7))
    expect(none.status).toBe(200)
    const third = (await none.json()) as Item
    expect(third.mimeType).toBeNull()
    expect(third.version).not.toBe(second.version)
  })

  it('replaces by the name’s key and answers the stored name', async () => {
    await put('Case.txt', bytes(4))
    const response = await put('CASE.TXT', bytes(5))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: 'Case.txt', path: 'Case.txt' })
    expect(await nodesNamed('Case.txt')).toHaveLength(1)
  })
})

describe('PUT /api/v1/files: requests that are refused', () => {
  async function inject(headers: Record<string, string>, url = '/api/v1/files/h.txt') {
    return app.inject({
      method: 'PUT',
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload: Buffer.alloc(0),
    })
  }

  it.each(['9007199254740993', '12abc', '-5', '1.5'])(
    'answers 400 invalid_request for a Content-Length of %s',
    async (length) => {
      const response = await inject({ 'content-length': length })
      expect(response.statusCode).toBe(400)
      expect(response.json<Failure>().error.code).toBe('invalid_request')
    },
  )

  it('answers 400 invalid_path for the bare route', async () => {
    const response = await put('', bytes(3))
    expect(response.status).toBe(400)
    expect(((await response.json()) as Failure).error.code).toBe('invalid_path')
  })

  it('answers 409 not_a_file for a folder at the path', async () => {
    const response = await put('Sub', bytes(3))
    expect(response.status).toBe(409)
    expect(((await response.json()) as Failure).error.code).toBe('not_a_file')
  })

  it('answers 409 not_a_folder for a file in a parent’s place', async () => {
    const response = await put('a.txt/x', bytes(3))
    expect(response.status).toBe(409)
    expect(((await response.json()) as Failure).error.code).toBe('not_a_folder')
  })

  it('answers 411 with CORS headers when the body has no length', async () => {
    const chunked = rawPut('chunked.txt', undefined, { 'transfer-encoding': 'chunked' })
    await chunked.write(bytes(4))
    chunked.end()
    const answer = await chunked.answer
    expect(answer.status).toBe(411)
    expect((answer.json as Failure).error.code).toBe('length_required')
    expect(answer.headers['access-control-allow-origin']).toBe('*')
  })

  it('answers 403 for a read-only token, and stores nothing', async () => {
    const before = await sessionCount()
    const response = await put('ro.txt', bytes(5), {}, readOnlyToken)
    expect(response.status).toBe(403)
    expect(((await response.json()) as Failure).error.code).toBe('read_only')
    expect(await sessionCount()).toBe(before)
    expect(await nodesNamed('ro.txt')).toHaveLength(0)
    expect((await get('ro.txt')).status).toBe(404)
  })
})

describe('PUT /api/v1/files: conditions', () => {
  it('If-None-Match: * refuses an existing file and lets a new one through', async () => {
    await put('c1.txt', bytes(3))
    const refused = await put('c1.txt', bytes(4), { 'if-none-match': '*' })
    expect(refused.status).toBe(412)
    expect(((await refused.json()) as Failure).error.code).toBe('exists')
    expect(await versionsOf((await stat('c1.txt')).id)).toBe(1)
    const fresh = await put('c2.txt', bytes(4), { 'if-none-match': '*' })
    expect(fresh.status).toBe(201)
  })

  it('answers 400 for an If-None-Match that is not *', async () => {
    const response = await put('c3.txt', bytes(2), { 'if-none-match': '"abc"' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Failure).error.code).toBe('invalid_request')
  })

  it('takes If-Match quoted, unquoted and *', async () => {
    await put('m.txt', bytes(3))
    for (const form of [(v: string) => `"${v}"`, (v: string) => v, () => '*']) {
      const current = (await stat('m.txt')).version ?? ''
      const response = await put('m.txt', bytes(4), { 'if-match': form(current) })
      expect(response.status).toBe(200)
      expect(((await response.json()) as Item).version).not.toBe(current)
    }
  })

  it('refuses a weak tag, another version, and a missing file with 412 version_changed', async () => {
    await put('w.txt', bytes(3))
    const before = await stat('w.txt')
    const weak = await put('w.txt', bytes(4), { 'if-match': `W/"${before.version ?? ''}"` })
    expect(weak.status).toBe(412)
    expect(((await weak.json()) as Failure).error.code).toBe('version_changed')
    const other = await put('w.txt', bytes(4), { 'if-match': `"${crypto.randomUUID()}"` })
    expect(other.status).toBe(412)
    expect(((await other.json()) as Failure).error.code).toBe('version_changed')
    expect(await stat('w.txt')).toEqual(before)
    expect(await versionsOf(before.id)).toBe(1)

    const missing = await put('nowhere.txt', bytes(4), { 'if-match': '*' })
    expect(missing.status).toBe(412)
    expect(((await missing.json()) as Failure).error.code).toBe('version_changed')
    expect(await nodesNamed('nowhere.txt')).toHaveLength(0)
  })

  it('lets one of two uploads at the same version win, and gives back the loser’s room', async () => {
    await put('race.txt', bytes(3))
    const v1 = (await stat('race.txt')).version ?? ''
    const reserved = await reservedBytes('alice')
    const base = await sessionCount()
    const headers = { 'if-match': `"${v1}"` }
    const first = rawPut('race.txt', 10, headers)
    const second = rawPut('race.txt', 10, headers)
    await first.write(bytes(5))
    await second.write(bytes(5))
    await sessionsReach(base + 2)
    first.end(bytes(5))
    second.end(bytes(5))
    const answers = await Promise.all([first.answer, second.answer])
    expect(answers.map((a) => a.status).sort()).toEqual([200, 412])
    const loser = answers.find((a) => a.status === 412)
    expect((loser?.json as Failure).error.code).toBe('version_changed')
    expect(await sessionCount()).toBe(base)
    expect(await reservedBytes('alice')).toBe(reserved)
    expect(await stagingReserved()).toBe(0)
  })

  it('lets one of two uploads of a new path win: the other is another version, refused at the end', async () => {
    const headers = { 'if-none-match': '*' }
    const base = await sessionCount()
    const reserved = await reservedBytes('alice')
    const first = rawPut('twin.txt', 10, headers)
    const second = rawPut('twin.txt', 10, headers)
    await first.write(bytes(5))
    await second.write(bytes(5))
    await sessionsReach(base + 2)
    first.end(bytes(5))
    second.end(bytes(5))
    const answers = await Promise.all([first.answer, second.answer])
    expect(answers.map((a) => a.status).sort()).toEqual([201, 412])
    const loser = answers.find((a) => a.status === 412)
    expect((loser?.json as Failure).error.code).toBe('exists')
    const files = await nodesNamed('twin.txt')
    expect(files).toHaveLength(1)
    expect(await versionsOf(files[0]?.id ?? '')).toBe(1)
    // The winner's session stays, completed; the loser's went with its version.
    expect(await sessionCount()).toBe(base + 1)
    // Only the winner's 10 bytes stay reserved-then-used: the loser's room went back.
    expect(await reservedBytes('alice')).toBe(reserved)
    expect(await stagingReserved()).toBe(0)
  })
})

describe('PUT /api/v1/files: limits', () => {
  it('answers 507 for a size over the quota', async () => {
    await seedUser(app.db, { username: 'tiny', password: 'the-tiny-password' })
    const tiny = new ApiClient(baseUrl, app.config.publicBaseUrl)
    await tiny.signIn('tiny', 'the-tiny-password')
    const folder = await createFolder(tiny, (await workspace(tiny)).id, 'Notes')
    const { token: tinyToken } = await makeAppToken(tiny, folder.id, true)
    await app.db.execute(sql`UPDATE users SET quota_bytes = 10 WHERE username = 'tiny'`)
    const response = await put('q.bin', bytes(100), {}, tinyToken)
    expect(response.status).toBe(507)
    expect(((await response.json()) as Failure).error.code).toBe('quota_exceeded')
  })

  it('answers 413 for a size over the staging limit', async () => {
    const size = app.config.stagingMaxBytes + 1
    const over = rawPut('huge.bin', size)
    const answer = await over.answer
    // It never sent the body it promised: leave, so the server can close.
    over.abort()
    expect(answer.status).toBe(413)
    expect((answer.json as Failure).error.code).toBe('file_too_large')
    expect(await nodesNamed('huge.bin')).toHaveLength(0)
  })

  it('answers 429 for a fourth stream of one token, and not for another token', async () => {
    const base = await sessionCount()
    const held = [1, 2, 3].map((n) => rawPut(`slot${String(n)}.bin`, 10))
    for (const stream of held) await stream.write(bytes(5))
    await sessionsReach(base + 3)

    const fourth = await put('slot4.bin', bytes(3))
    expect(fourth.status).toBe(429)
    expect(fourth.headers.get('retry-after')).toBe('5')
    expect(((await fourth.json()) as Failure).error.code).toBe('too_many_uploads')
    expect((await put('slot-other.bin', bytes(3), {}, otherToken)).status).toBe(201)

    for (const stream of held) stream.end(bytes(5))
    for (const stream of held) expect((await stream.answer).status).toBe(201)
    // The counter went down with them.
    expect((await put('slot5.bin', bytes(3))).status).toBe(201)
  })
})

describe('PUT /api/v1/files: a client that leaves', () => {
  it('cancels at once: no session, no file, its room given back', async () => {
    const reserved = await reservedBytes('alice')
    const base = await sessionCount()
    const stream = rawPut('cut.bin', 1000)
    await stream.write(bytes(400))
    await sessionsReach(base + 1)
    expect(await reservedBytes('alice')).toBe(reserved + 1000)
    stream.abort()
    await vi.waitFor(
      async () => {
        expect(await sessionCount()).toBe(base)
        expect(await nodesNamed('cut.bin')).toHaveLength(0)
        expect(await reservedBytes('alice')).toBe(reserved)
        expect(await stagingReserved()).toBe(0)
      },
      { timeout: 10_000 },
    )
  })
})

describe('PUT /api/v1/files: a slow stream', () => {
  it('keeps its session alive, so the idle sweep leaves it and it completes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const base = await sessionCount()
      const body = bytes(200)
      const stream = rawPut('slow.bin', 200)
      await stream.write(body.subarray(0, 50))
      await sessionsReach(base + 1)
      const { rows: made } = await app.db.execute<{ id: string }>(
        sql`SELECT id FROM upload_sessions ORDER BY id DESC LIMIT 1`,
      )
      const sessionId = made[0]?.id ?? ''
      // The stream's timer is set once its room is reserved. (`vi.waitFor`
      // polls on setInterval, which is faked here: poll with setTimeout.)
      const until = async (check: () => Promise<boolean>) => {
        for (let tries = 0; tries < 200 && !(await check()); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      await until(async () => (await stagingReserved()) > 0)
      await new Promise((resolve) => setImmediate(resolve))
      // The page has said nothing for 15 minutes, as far as the row knows.
      await app.db.execute(sql`
        UPDATE upload_sessions SET alive_at = now() - interval '15 minutes'
        WHERE id = ${sessionId}`)
      await vi.advanceTimersByTimeAsync(30_000)
      const fresh = async () => {
        const { rows } = await app.db.execute<{ fresh: boolean }>(sql`
          SELECT alive_at > now() - interval '1 minute' AS fresh
          FROM upload_sessions WHERE id = ${sessionId}`)
        return rows[0]?.fresh === true
      }
      await until(fresh)
      expect(await fresh()).toBe(true)
      await abandonIdleUploads(app.db, 10)
      const { rows: kept } = await app.db.execute(
        sql`SELECT 1 FROM upload_sessions WHERE id = ${sessionId}`,
      )
      expect(kept).toHaveLength(1)
      stream.end(body.subarray(50))
      expect((await stream.answer).status).toBe(201)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PUT /api/v1/files: checked again on completion', () => {
  /** A token of its own, on a folder of its own, so a scenario can wreck it. */
  async function scenario() {
    const name = `Scenario-${crypto.randomUUID().slice(0, 8)}`
    const folder = await createFolder(owner, rootId, name)
    const made = await makeAppToken(owner, folder.id, true)
    return { folder, ...made }
  }

  /** Starts a held `PUT`, runs `change` while its body is open, then ends it. */
  async function heldThrough(
    bearer: string,
    path: string,
    change: () => Promise<void>,
  ): Promise<Answer> {
    const base = await sessionCount()
    const stream = rawPut(path, 10, {}, bearer)
    await stream.write(bytes(5))
    await sessionsReach(base + 1)
    await change()
    stream.end(bytes(5))
    const answer = await stream.answer
    expect(await sessionCount()).toBe(base)
    expect(await stagingReserved()).toBe(0)
    return answer
  }

  it('refuses when the token’s folder was trashed', async () => {
    const { folder, token: bearer } = await scenario()
    const answer = await heldThrough(bearer, 'f.txt', () =>
      owner.send('POST', '/nodes/trash', { json: { ids: [folder.id] } }),
    )
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('folder_unavailable')
    expect(await nodesNamed('f.txt')).toHaveLength(0)
  })

  it('refuses when the token’s folder moved into the Backups drive', async () => {
    const { folder, token: bearer } = await scenario()
    const answer = await heldThrough(bearer, 'g.txt', async () => {
      await app.db.execute(sql`UPDATE nodes SET tree = 'backups' WHERE id = ${folder.id}`)
    })
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('folder_unavailable')
    expect(await nodesNamed('g.txt')).toHaveLength(0)
  })

  it('refuses when the target’s folder left the token’s reach', async () => {
    const { token: bearer } = await scenario()
    const answer = await heldThrough(bearer, 'Away/p.txt', async () => {
      const away = await stat('Away', bearer)
      await owner.send('PATCH', `/nodes/${away.id}`, { json: { parentId: rootId } })
    })
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('path_changed')
    expect(await nodesNamed('p.txt')).toHaveLength(0)
  })

  it('refuses when the file being replaced was trashed, and leaves it as it was', async () => {
    const { token: bearer } = await scenario()
    const before = (await (await put('t.txt', bytes(3), {}, bearer)).json()) as Item
    const answer = await heldThrough(bearer, 't.txt', () =>
      owner.send('POST', '/nodes/trash', { json: { ids: [before.id] } }),
    )
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('path_changed')
    const { rows } = await app.db.execute<{ current: string; trashed: boolean }>(sql`
      SELECT current_version_id AS current, deleted_at IS NOT NULL AS trashed
      FROM nodes /* tree: test, by id */ WHERE id = ${before.id}`)
    expect(rows[0]).toEqual({ current: before.version, trashed: true })
    expect(await versionsOf(before.id)).toBe(1)
  })

  it('refuses when the file being replaced was renamed, and leaves it as it was', async () => {
    const { token: bearer } = await scenario()
    const before = (await (await put('old.txt', bytes(3), {}, bearer)).json()) as Item
    const answer = await heldThrough(bearer, 'old.txt', () =>
      owner.send('PATCH', `/nodes/${before.id}`, { json: { name: 'renamed.txt' } }),
    )
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('path_changed')
    const { rows } = await app.db.execute<{ name: string; current: string }>(sql`
      SELECT name, current_version_id AS current FROM nodes /* tree: test, by id */
      WHERE id = ${before.id}`)
    expect(rows[0]).toEqual({ name: 'renamed.txt', current: before.version })
    expect(await versionsOf(before.id)).toBe(1)
  })

  it('refuses when the token was removed', async () => {
    const { token: bearer, id } = await scenario()
    const answer = await heldThrough(bearer, 'k.txt', () =>
      owner.send('DELETE', `/app-tokens/${id}`),
    )
    expect(answer.status).toBe(401)
    expect((answer.json as Failure).error.code).toBe('invalid_token')
    expect(await nodesNamed('k.txt')).toHaveLength(0)
  })

  it('answers not_a_file, never name_conflict, when a folder takes the name before the upload is made', async () => {
    const { folder, token: bearer } = await scenario()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // The web app's folder, made but not committed, with the user's row held: the
    // upload's start looks at the name (nothing there), then waits on that row.
    const holding = app.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE username = 'alice' FOR UPDATE`,
      )
      await tx.execute(sql`
        INSERT INTO nodes (owner_id, parent_id, kind, name, name_key)
        /* tree: test, inherits */
        VALUES (${rows[0]?.id}, ${folder.id}, 'folder', 'Taken', 'taken')`)
      await held
    })
    try {
      const pending = put('Taken', bytes(3), {}, bearer)
      await vi.waitFor(
        async () => {
          const { rows } = await app.db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM users WHERE id%FOR UPDATE%'`)
          expect(rows[0]?.n).toBeGreaterThan(0)
        },
        { timeout: 10_000 },
      )
      release()
      await holding
      const response = await pending
      expect(response.status).toBe(409)
      expect(((await response.json()) as Failure).error.code).toBe('not_a_file')
    } finally {
      release()
    }
  })
})

describe('PUT /api/v1/files: fix round 1', () => {
  async function scenario() {
    const folder = await createFolder(owner, rootId, `Fix-${crypto.randomUUID().slice(0, 8)}`)
    const made = await makeAppToken(owner, folder.id, true)
    return { folder, ...made }
  }

  it('answers each upload with its own version and size', async () => {
    const base = await sessionCount()
    const first = rawPut('own.txt', 10)
    const second = rawPut('own.txt', 12)
    await first.write(bytes(5))
    await second.write(bytes(5))
    await sessionsReach(base + 2)
    first.end(bytes(5))
    second.end(bytes(7))
    const answers = await Promise.all([first.answer, second.answer])
    const items = answers.map((a) => a.json as Item)
    expect(answers.map((a) => a.status).sort()).toEqual([200, 201])
    expect(items[0]?.size).toBe(10)
    expect(items[1]?.size).toBe(12)
    expect(items[0]?.version).not.toBe(items[1]?.version)
    // The later commit pruned the earlier version: the file's current one is one of the two.
    const current = (await stat('own.txt')).version
    expect(items.map((item) => item.version)).toContain(current)
  })

  it('refuses a file moved to another folder inside the token’s folder', async () => {
    const { folder, token: bearer } = await scenario()
    await put('Sub/a.txt', bytes(3), {}, bearer)
    const file = await stat('Sub/a.txt', bearer)
    const base = await sessionCount()
    const stream = rawPut('Sub/a.txt', 10, {}, bearer)
    await stream.write(bytes(5))
    await sessionsReach(base + 1)
    await owner.send('PATCH', `/nodes/${file.id}`, { json: { parentId: folder.id } })
    stream.end(bytes(5))
    const answer = await stream.answer
    expect(answer.status).toBe(409)
    expect((answer.json as Failure).error.code).toBe('path_changed')
    expect(await sessionCount()).toBe(base)
    expect(await versionsOf(file.id)).toBe(1)
  })

  it('answers 412 to an If-Match with missing folders, and makes none', async () => {
    const response = await put('Fresh/Deep/a.txt', bytes(3), { 'if-match': '"x"' })
    expect(response.status).toBe(412)
    expect(((await response.json()) as Failure).error.code).toBe('version_changed')
    expect(await nodesNamed('Fresh')).toHaveLength(0)
  })

  it('cancels a cut-off body of more than one part once a part is stored', async () => {
    const reserved = await reservedBytes('alice')
    const base = await sessionCount()
    const { chunkSize } = app.config.sizes
    const stream = rawPut('cut-big.bin', chunkSize + 100)
    await stream.write(bytes(chunkSize + 5))
    await sessionsReach(base + 1)
    const { rows } = await app.db.execute<{ version_id: string }>(
      sql`SELECT version_id FROM upload_sessions ORDER BY id DESC LIMIT 1`,
    )
    const versionId = rows[0]?.version_id ?? ''
    const chunksOf = async () =>
      (
        await app.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM chunks WHERE version_id = ${versionId}`,
        )
      ).rows[0]?.n
    await vi.waitFor(
      async () => {
        expect(await chunksOf()).toBeGreaterThan(0)
      },
      { timeout: 20_000 },
    )
    stream.abort()
    await vi.waitFor(
      async () => {
        expect(await sessionCount()).toBe(base)
        expect(await chunksOf()).toBe(0)
        const versions = await app.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM file_versions WHERE id = ${versionId}`,
        )
        expect(versions.rows[0]?.n).toBe(0)
        expect(await nodesNamed('cut-big.bin')).toHaveLength(0)
        expect(await reservedBytes('alice')).toBe(reserved)
        expect(await stagingReserved()).toBe(0)
      },
      { timeout: 10_000 },
    )
  })

  it('counts an upload out of the token’s three after an abort and after a refusal', async () => {
    const { token: bearer } = await scenario()
    const refused = (await (await put('r.txt', bytes(3), {}, bearer)).json()) as Item
    const base = await sessionCount()
    const aborted = rawPut('a.bin', 10, {}, bearer)
    const failing = rawPut('r.txt', 10, {}, bearer)
    const kept = rawPut('c.bin', 10, {}, bearer)
    for (const stream of [aborted, failing, kept]) await stream.write(bytes(5))
    await sessionsReach(base + 3)
    expect((await put('d.bin', bytes(3), {}, bearer)).status).toBe(429)
    aborted.abort()
    await sessionsReach(base + 2)
    await owner.send('PATCH', `/nodes/${refused.id}`, { json: { name: 'r2.txt' } })
    failing.end(bytes(5))
    expect((await failing.answer).status).toBe(409)
    expect((await put('d.bin', bytes(3), {}, bearer)).status).toBe(201)
    kept.end(bytes(5))
    expect((await kept.answer).status).toBe(201)
  })

  it('answers 409 folder_unavailable for a token whose folder is in the trash, using nothing', async () => {
    const { folder, token: bearer } = await scenario()
    await owner.send('POST', '/nodes/trash', { json: { ids: [folder.id] } })
    const reserved = await reservedBytes('alice')
    const base = await sessionCount()
    const response = await put('x.bin', bytes(50), {}, bearer)
    expect(response.status).toBe(409)
    expect(((await response.json()) as Failure).error.code).toBe('folder_unavailable')
    expect(await sessionCount()).toBe(base)
    expect(await reservedBytes('alice')).toBe(reserved)
    expect(await stagingReserved()).toBe(0)
  })

  it('leaves other routes’ content-type handling alone', async () => {
    const odd = await fetch(`${baseUrl}/api/v1/folders/x`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'not a type' },
      body: new Uint8Array(0),
    })
    expect(odd.status).toBe(415)
    await put('mv.txt', bytes(3))
    const moved = await fetch(`${baseUrl}/api/v1/move`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'mv.txt', to: 'mv2.txt' }),
    })
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as Item).path).toBe('mv2.txt')
  })
})

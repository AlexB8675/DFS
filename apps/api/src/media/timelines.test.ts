import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { sessionSchema, shareLinkSchema, TIMELINE_MAX_BYTES, type TimelineBatch } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'

// A play's timeline, as the page sends it in batches (DESIGN.md §16), over
// real HTTP: kept in the timeline store under the user or the share link,
// within bounds, and never in the log.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let apiUrl = ''
let client: ApiClient
let other: ApiClient
let folderId: string
let otherFolderId: string
let ownerId = ''
/** The log, a line each. */
const lines: Record<string, unknown>[] = []

/** What a viewer's requests come from here: the same address for every one. */
const ADDRESS = 'address:127.0.0.1'
/** The page's `Date.now()` at the start of every play here. */
const STARTED_AT = 1_760_000_000_000

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  const stream = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
  }
  app = await buildApp({ config: setup.config, logger: { level: 'info', stream } })
  apiUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  await seedUser(app.db, { username: 'other', password: 'the-other-password' })
  client = new ApiClient(apiUrl, setup.config.publicBaseUrl)
  ownerId = (await client.signIn('owner', 'the-owner-password')).user.id
  other = new ApiClient(apiUrl, setup.config.publicBaseUrl)
  await other.signIn('other', 'the-other-password')
  folderId = (await createFolder(client, (await workspace(client)).id, 'Videos')).id
  otherFolderId = (await createFolder(other, (await workspace(other)).id, 'Videos')).id
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

/** A video, as the user's own files hold it. */
function upload(who: ApiClient, parent: string, name: string) {
  return uploadFile(who, parent, name, text(`The video ${name}.`))
}

async function linkTo(nodeId: string): Promise<{ id: string; token: string }> {
  const link = await client.call('POST', '/shares', shareLinkSchema, {
    json: { nodeId, expiresAt: null, password: null, maxDownloads: null },
  })
  return { id: link.id, token: link.url?.split('/s/')[1] ?? '' }
}

/** A batch of a play's timeline: any valid events will do. */
function batch(playId: string, versionId: string, seq: number): TimelineBatch {
  return {
    playId,
    versionId,
    seq,
    startedAt: STARTED_AT,
    sentAt: 1000 * seq,
    events: [{ type: 'closed', t: 0 }],
  }
}

async function timelineOf(playId: string) {
  const { rows } = await app.db.execute<{
    kind: string
    via: string
    node_id: string
    user_id: string | null
    share_id: string | null
    batches: number
    client_started_ms: number | null
  }>(sql`
    SELECT kind, via, node_id, user_id, share_id, batches,
      (extract(epoch FROM client_started_at) * 1000)::float8 AS client_started_ms
    FROM timelines WHERE id = ${playId}`)
  return rows[0] ?? null
}

async function batchesOf(playId: string) {
  const { rows } = await app.db.execute<{ seq: number; sent_ms: number | null }>(sql`
    SELECT seq, sent_ms FROM timeline_batches WHERE timeline_id = ${playId} ORDER BY seq`)
  return rows
}

/** What the log says of refused batches. */
function refusals(playId: string) {
  return lines
    .filter((line) => line.msg === 'timeline batch refused')
    .map((line) => line.timeline as { playId: string; outcome: string })
    .filter((timeline) => timeline.playId === playId)
}

describe('a play’s timeline in the drive (§16)', () => {
  it('stores a drive play’s batches under the user', async () => {
    const video = await upload(client, folderId, 'drive.mp4')
    const playId = crypto.randomUUID()
    const path = `/files/${video.nodeId}/timeline`
    await client.send('POST', path, { json: batch(playId, video.versionId, 0) })
    await client.send('POST', path, { json: batch(playId, video.versionId, 1) })

    expect(await timelineOf(playId)).toEqual({
      kind: 'play',
      via: 'drive',
      node_id: video.nodeId,
      user_id: ownerId,
      share_id: null,
      batches: 2,
      client_started_ms: STARTED_AT,
    })
    expect(await batchesOf(playId)).toEqual([
      { seq: 0, sent_ms: 0 },
      { seq: 1, sent_ms: 1000 },
    ])
  })

  it('keeps a batch sent twice once', async () => {
    const video = await upload(client, folderId, 'twice.mp4')
    const playId = crypto.randomUUID()
    const path = `/files/${video.nodeId}/timeline`
    await client.send('POST', path, { json: batch(playId, video.versionId, 0) })
    await client.send('POST', path, { json: batch(playId, video.versionId, 0) })

    expect(await batchesOf(playId)).toEqual([{ seq: 0, sent_ms: 0 }])
    expect((await timelineOf(playId))?.batches).toBe(1)
  })

  it('refuses a batch for a play another user began', async () => {
    const mine = await upload(client, folderId, 'mine.mp4')
    const theirs = await upload(other, otherFolderId, 'theirs.mp4')
    const playId = crypto.randomUUID()
    await client.send('POST', `/files/${mine.nodeId}/timeline`, {
      json: batch(playId, mine.versionId, 0),
    })

    const intruding = {
      ...batch(playId, theirs.versionId, 1),
      events: [
        { type: 'error' as const, t: 5, from: 'page' as const, code: null, message: 'secret text' },
      ],
    }
    expect(
      await other.error('POST', `/files/${theirs.nodeId}/timeline`, { json: intruding }),
    ).toEqual({
      status: 409,
      code: 'not_your_play',
    })
    expect(refusals(playId)).toEqual([{ playId, outcome: 'not_yours' }])
    // Nothing of the events, here or anywhere, goes to the log.
    expect(JSON.stringify(lines)).not.toContain('secret text')
    expect((await timelineOf(playId))?.batches).toBe(1)
  })

  it('refuses a version of another file', async () => {
    const video = await upload(client, folderId, 'this.mp4')
    const another = await upload(client, folderId, 'that.mp4')
    const playId = crypto.randomUUID()
    const refused = await client.fetch('POST', `/files/${video.nodeId}/timeline`, {
      json: batch(playId, another.versionId, 0),
    })
    // By its message, so a missing route (also a 404) doesn't pass for it.
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({
      error: { code: 'not_found', message: 'This version isn’t this file’s.' },
    })
    expect(await timelineOf(playId)).toBeNull()
  })

  it('says a file isn’t media and a file isn’t the user’s, as every player route does', async () => {
    const notes = await uploadFile(client, folderId, 'notes.txt', text('Just notes.'))
    const mine = await upload(client, folderId, 'not-yours.mp4')
    expect(
      await client.error('POST', `/files/${notes.nodeId}/timeline`, {
        json: batch(crypto.randomUUID(), notes.versionId, 0),
      }),
    ).toEqual({ status: 422, code: 'not_media' })
    expect(
      await other.error('POST', `/files/${mine.nodeId}/timeline`, {
        json: batch(crypto.randomUUID(), mine.versionId, 0),
      }),
    ).toEqual({ status: 404, code: 'not_found' })
  })

  it('answers 413 once a play’s timeline is full', async () => {
    const video = await upload(client, folderId, 'full.mp4')
    const playId = crypto.randomUUID()
    const path = `/files/${video.nodeId}/timeline`
    await client.send('POST', path, { json: batch(playId, video.versionId, 0) })
    await app.db.execute(
      sql`UPDATE timelines SET bytes = ${TIMELINE_MAX_BYTES - 10} WHERE id = ${playId}`,
    )

    expect(await client.error('POST', path, { json: batch(playId, video.versionId, 1) })).toEqual({
      status: 413,
      code: 'timeline_full',
    })
    expect(refusals(playId)).toEqual([{ playId, outcome: 'full' }])
    expect((await timelineOf(playId))?.batches).toBe(1)
  })

  it('refuses a body past 64 KiB', async () => {
    const video = await upload(client, folderId, 'large.mp4')
    const playId = crypto.randomUUID()
    const events = Array.from({ length: 300 }, (_, index) => ({
      type: 'error' as const,
      t: index,
      from: 'page' as const,
      code: null,
      message: 'x'.repeat(280),
    }))
    const large = { ...batch(playId, video.versionId, 0), events }
    expect(JSON.stringify(large).length).toBeGreaterThan(64 * 1024)
    expect(
      (await client.fetch('POST', `/files/${video.nodeId}/timeline`, { json: large })).status,
    ).toBe(413)
    expect(await timelineOf(playId)).toBeNull()
  })

  it('refuses a start a Date can’t hold, as a bad request', async () => {
    const video = await upload(client, folderId, 'start.mp4')
    const playId = crypto.randomUUID()
    const late = { ...batch(playId, video.versionId, 0), startedAt: 8_640_000_000_000_001 }
    expect(await client.error('POST', `/files/${video.nodeId}/timeline`, { json: late })).toEqual({
      status: 400,
      code: 'invalid_request',
    })
    expect(await timelineOf(playId)).toBeNull()
  })

  it('counts a user’s batches against the user', async () => {
    const mine = await upload(other, otherFolderId, 'counted.mp4')
    const path = `/files/${mine.nodeId}/timeline`
    const { user } = await other.call('GET', '/auth/me', sessionSchema)
    await other.send('POST', path, { json: batch(crypto.randomUUID(), mine.versionId, 0) })
    for (let hit = 1; hit < 300; hit += 1) app.limits.timelines.hit(`user:${user.id}`)
    expect(
      await other.error('POST', path, { json: batch(crypto.randomUUID(), mine.versionId, 0) }),
    ).toEqual({ status: 429, code: 'rate_limited' })
    // The owner's are counted apart.
    const own = await upload(client, folderId, 'uncounted.mp4')
    await client.send('POST', `/files/${own.nodeId}/timeline`, {
      json: batch(crypto.randomUUID(), own.versionId, 0),
    })
  })
})

describe('a play’s timeline through share links (§7.5, §16)', () => {
  it('stores a link play under the link, without a user', async () => {
    const video = await upload(client, folderId, 'linked.mp4')
    const link = await linkTo(video.nodeId)
    const playId = crypto.randomUUID()
    const viewer = new ApiClient(apiUrl, client.origin)
    await viewer.send('POST', `/s/${link.token}/files/${video.nodeId}/timeline`, {
      json: batch(playId, video.versionId, 0),
    })

    expect(await timelineOf(playId)).toEqual({
      kind: 'play',
      via: 'link',
      node_id: video.nodeId,
      user_id: null,
      share_id: link.id,
      batches: 1,
      client_started_ms: STARTED_AT,
    })
  })

  it('takes a link viewer’s batches from DFS’s own pages alone', async () => {
    const video = await upload(client, folderId, 'own-pages.mp4')
    const path = `/s/${(await linkTo(video.nodeId)).token}/files/${video.nodeId}/timeline`
    const playId = crypto.randomUUID()
    const elsewhere = new ApiClient(apiUrl, 'https://elsewhere.example')
    expect(
      await elsewhere.error('POST', path, { json: batch(playId, video.versionId, 0) }),
    ).toEqual({ status: 403, code: 'forbidden_origin' })
    expect(await timelineOf(playId)).toBeNull()
  })

  it('counts a link viewer’s batches against their address', async () => {
    const video = await upload(client, folderId, 'busy.mp4')
    const path = `/s/${(await linkTo(video.nodeId)).token}/files/${video.nodeId}/timeline`
    const viewer = new ApiClient(apiUrl, client.origin)
    await viewer.send('POST', path, { json: batch(crypto.randomUUID(), video.versionId, 0) })
    for (let hit = 1; hit < 300; hit += 1) app.limits.timelines.hit(ADDRESS)
    expect(
      await viewer.error('POST', path, { json: batch(crypto.randomUUID(), video.versionId, 0) }),
    ).toEqual({ status: 429, code: 'rate_limited' })
  })
})

describe('a play’s report (§10.4, §16)', () => {
  it('logs a play report’s play ID', async () => {
    const video = await upload(client, folderId, 'reported.mp4')
    const playId = crypto.randomUUID()
    await client.send('POST', `/files/${video.nodeId}/playback-report`, {
      json: {
        versionId: video.versionId,
        playId,
        outcome: 'left',
        firstFrameMs: null,
        startMs: null,
        openMs: 1500,
        stalls: 0,
        stallMs: 0,
        seeks: 0,
        seekWaitMs: 0,
        frames: 0,
        droppedFrames: 0,
        arrivalBitsPerSecond: null,
        decoding: null,
        problem: null,
      },
    })
    const reported = lines.filter((line) => line.msg === 'video play reported')
    expect(reported.map((line) => (line.play as { playId?: string }).playId)).toContain(playId)
  })
})

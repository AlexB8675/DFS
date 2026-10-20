import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import {
  sessionSchema,
  shareLinkSchema,
  streamLinkSchema,
  TIMELINE_MAX_BYTES,
  type ServedEvent,
  type TimelineBatch,
} from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { mediaToken } from './token.ts'

// A play's timeline, as the page sends it in batches (DESIGN.md §16), over
// real HTTP: kept in the timeline store under the user or the share link,
// within bounds, and never in the log.
// The reads the API serves of a video are kept in the same store as stream
// sessions, tested at the end.

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

describe('stream sessions (§6.2, §16)', () => {
  /** The stream sessions kept for a file, oldest first. */
  async function sessionsOf(nodeId: string) {
    const { rows } = await app.db.execute<{
      id: string
      via: string
      play_id: string | null
      user_id: string | null
      share_id: string | null
      user_agent: string | null
    }>(sql`
      SELECT id, via, play_id, user_id, share_id, user_agent
      FROM timelines WHERE node_id = ${nodeId} AND kind = 'stream' ORDER BY started_at, id`)
    return rows
  }

  /** What a session's batches hold, in order. */
  async function servedBy(sessionId: string): Promise<ServedEvent[]> {
    const { rows } = await app.db.execute<{ events: ServedEvent[] }>(sql`
      SELECT events FROM timeline_batches WHERE timeline_id = ${sessionId} ORDER BY seq`)
    return rows.flatMap((row) => row.events)
  }

  /** Waits until the file's session has `reads` reads written, and gives it with them. */
  async function sessionWith(nodeId: string, reads: number) {
    let session: Awaited<ReturnType<typeof sessionsOf>>[number] | undefined
    let served: ServedEvent[] = []
    // A response closes on the server a moment after the client has its body.
    await vi.waitFor(async () => {
      await app.streamSessions.flush()
      session = (await sessionsOf(nodeId))[0]
      served = session ? await servedBy(session.id) : []
      expect(served).toHaveLength(reads)
    })
    return { session, served }
  }

  /** A read to its end. */
  async function read(who: ApiClient, path: string, range: string) {
    const response = await who.fetch('GET', path, { headers: { Range: range } })
    await response.arrayBuffer()
    return response
  }

  it('logs a page’s reads as a session under its play', async () => {
    const video = await upload(client, folderId, 'session.mp4')
    const playId = crypto.randomUUID()
    const path = `/files/${video.nodeId}/content?version=${video.versionId}&play=${playId}`
    // Two reads, the second where the first stopped.
    expect((await read(client, path, 'bytes=0-4')).status).toBe(206)
    expect((await read(client, path, 'bytes=5-9')).status).toBe(206)

    const { session, served } = await sessionWith(video.nodeId, 2)
    expect(await sessionsOf(video.nodeId)).toHaveLength(1)
    expect(session).toMatchObject({
      via: 'drive',
      play_id: playId,
      user_id: ownerId,
      share_id: null,
    })
    expect(served).toMatchObject([
      { type: 'served', from: 0, to: 4, status: 206, bytes: 5, finished: true, seek: false },
      { type: 'served', from: 5, to: 9, status: 206, bytes: 5, finished: true, seek: false },
    ])
    // Just uploaded, so still in staging.
    for (const event of served) {
      expect(event.sources.staging.bytes).toBe(5)
      expect(event.sources.cache.bytes).toBe(0)
      expect(event.sources.discord.bytes).toBe(0)
    }
  })

  it('calls a read a seek when no read stopped where it starts', async () => {
    const video = await upload(client, folderId, 'seeks.mp4')
    const play = `play=${crypto.randomUUID()}`
    const path = `/files/${video.nodeId}/content?version=${video.versionId}&${play}`
    await read(client, path, 'bytes=0-4')
    await read(client, path, 'bytes=12-')

    const { served } = await sessionWith(video.nodeId, 2)
    expect(served.map((event) => event.seek)).toEqual([false, true])
  })

  it('logs a stream link’s reads as a session of their own', async () => {
    const video = await upload(client, folderId, 'linked-session.mp4')
    const link = await client.call('POST', `/files/${video.nodeId}/stream-link`, streamLinkSchema, {
      json: { create: true },
    })
    const userAgent = 'VLC/3.0.21 LibVLC/3.0.21'
    const response = await fetch(`${apiUrl}${new URL(link.url).pathname}`, {
      headers: { 'User-Agent': userAgent },
    })
    await response.arrayBuffer()

    const { session, served } = await sessionWith(video.nodeId, 1)
    expect(await sessionsOf(video.nodeId)).toHaveLength(1)
    expect(session).toMatchObject({
      via: 'stream',
      play_id: null,
      user_id: null,
      user_agent: userAgent,
    })
    expect(session?.share_id).toEqual(expect.any(String))
    expect(served[0]).toMatchObject({ from: 0, status: 200, finished: true })
  })

  it('logs a link viewer’s reads under the link', async () => {
    const video = await upload(client, folderId, 'viewed.mp4')
    const link = await linkTo(video.nodeId)
    const viewer = new ApiClient(apiUrl, client.origin)
    const playId = crypto.randomUUID()
    const path = `/s/${link.token}/files/${video.nodeId}/content`
    await read(viewer, `${path}?version=${video.versionId}&play=${playId}`, 'bytes=0-4')

    const { session } = await sessionWith(video.nodeId, 1)
    expect(await sessionsOf(video.nodeId)).toHaveLength(1)
    expect(session).toMatchObject({
      via: 'link',
      play_id: playId,
      user_id: null,
      share_id: link.id,
    })
  })

  it('leaves out files that aren’t audio or video, and the media service’s reads', async () => {
    const notes = await uploadFile(client, folderId, 'session-notes.txt', text('Just notes.'))
    const play = `play=${crypto.randomUUID()}`
    const viewed = await client.fetch('GET', `/files/${notes.nodeId}/content?${play}`)
    expect(await viewed.text()).toBe('Just notes.')

    // The service reads a video through its own route, which no session follows.
    const video = await upload(client, folderId, 'service.mp4')
    const served = await fetch(`${apiUrl}/internal/media/${video.versionId}`, {
      headers: { Authorization: `Bearer ${await mediaToken(app.keys, video.versionId)}` },
    })
    expect(await served.text()).toBe('The video service.mp4.')

    // Both reads have been logged as sent, so any session of theirs would be written by now.
    const sentVersions = () =>
      lines
        .filter((line) => line.msg === 'file sent')
        .map((line) => (line.sent as { versionId: string }).versionId)
    await vi.waitFor(() => {
      expect(sentVersions()).toEqual(expect.arrayContaining([notes.versionId, video.versionId]))
    })
    await app.streamSessions.flush()
    expect(await sessionsOf(notes.nodeId)).toEqual([])
    expect(await sessionsOf(video.nodeId)).toEqual([])
  })

  it('writes the sessions out when the API closes', async () => {
    // An API of its own, closed here, over the same database. Its user is made first: its
    // 5-second flush starts with it, and must not come before the read.
    await seedUser(app.db, { username: 'closer', password: 'the-closer-password' })
    const setup = await testConfig({ DATABASE_URL: database.url })
    const closing = await buildApp({ config: setup.config, logger: false })
    try {
      const url = await closing.listen({ port: 0, host: '127.0.0.1' })
      const closer = new ApiClient(url, setup.config.publicBaseUrl)
      await closer.signIn('closer', 'the-closer-password')
      const video = await upload(closer, (await workspace(closer)).id, 'closing.mp4')
      await read(closer, `/files/${video.nodeId}/content?play=${crypto.randomUUID()}`, 'bytes=0-4')
      // Nothing has been written yet: a flush comes every 5 seconds.
      expect(await sessionsOf(video.nodeId)).toEqual([])

      await closing.close()
      const { session, served } = await sessionWith(video.nodeId, 1)
      expect(session?.via).toBe('drive')
      expect(served[0]).toMatchObject({ from: 0, to: 4, bytes: 5, finished: true })
    } finally {
      await closing.close()
      await setup.cleanup()
    }
  })

  it('refuses a play ID that isn’t one', async () => {
    const video = await upload(client, folderId, 'bad-play.mp4')
    expect(
      await client.error('GET', `/files/${video.nodeId}/content?play=abc`, {
        headers: { Range: 'bytes=0-4' },
      }),
    ).toMatchObject({ status: 400 })
  })

  it('names the play, the session and the sources in file sent', async () => {
    const video = await upload(client, folderId, 'logged.mp4')
    const playId = crypto.randomUUID()
    const path = `/files/${video.nodeId}/content?version=${video.versionId}&play=${playId}`
    await read(client, path, 'bytes=0-4')
    const { session } = await sessionWith(video.nodeId, 1)

    const sent = lines
      .filter((line) => line.msg === 'file sent')
      .map((line) => line.sent as Record<string, unknown>)
      .find((figures) => figures.playId === playId)
    expect(sent).toMatchObject({
      playId,
      sessionId: session?.id,
      sources: { staging: { bytes: 5 }, cache: { bytes: 0 }, discord: { bytes: 0 } },
    })
  })
})

import { randomUUID } from 'node:crypto'
import { TIMELINE_MAX_BYTES } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createDatabase, createPool, type Database } from './client.ts'
import { nodes, users } from './schema.ts'
import {
  appendTimelineBatch,
  listTimelines,
  pruneTimelines,
  readTimeline,
  type TimelineOwner,
} from './timelines.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'

describe('play timelines (DESIGN §16)', () => {
  let database: TestDatabase
  let db: Database
  let close: () => Promise<void>

  beforeAll(async () => {
    database = await createTestDatabase(inject('testPostgres'))
    const pool = createPool(database.url, {
      applicationName: 'dfs-tests',
      onError: () => undefined,
    })
    db = createDatabase(pool)
    close = () => pool.end()
  })

  afterAll(async () => {
    await close()
    await database.drop()
  })

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM timelines`)
  })

  /** A signed-in user's play of a file in their drive. */
  function owner(fields: Partial<TimelineOwner> = {}): TimelineOwner {
    return {
      kind: 'play',
      via: 'drive',
      nodeId: randomUUID(),
      versionId: randomUUID(),
      userId: randomUUID(),
      shareId: null,
      playId: null,
      address: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (tests)',
      clientStartedAt: null,
      startedAt: null,
      ...fields,
    }
  }

  const batch = (seq: number, events: readonly unknown[] = [{ type: 'opened', t: seq }]) => ({
    seq,
    events,
    address: '203.0.113.7',
    sentMs: seq * 1000,
  })

  async function timeline(id: string) {
    const { rows } = await db.execute<{
      kind: string
      via: string
      version_id: string
      play_id: string | null
      address: string
      user_agent: string | null
      started_ms: number
      updated_ms: number
      bytes: number
      batches: number
    }>(sql`
      SELECT kind, via, version_id, play_id, address, user_agent,
        (extract(epoch FROM started_at) * 1000)::float8 AS started_ms,
        (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms,
        bytes::float8 AS bytes, batches
      FROM timelines WHERE id = ${id}`)
    return rows[0]
  }

  async function batches(id: string) {
    const { rows } = await db.execute<{
      seq: number
      sent_ms: number | null
      address: string
      events: unknown
      bytes: number
    }>(sql`
      SELECT seq, sent_ms, address, events, bytes FROM timeline_batches
      WHERE timeline_id = ${id} ORDER BY seq`)
    return rows
  }

  it('stores a play’s batches in order and counts their bytes', async () => {
    const id = randomUUID()
    const play = owner()
    const first = [{ type: 'opened', t: 0 }]
    // Counted in UTF-8 bytes, not characters.
    const second = [{ type: 'ended', t: 1500, note: 'é — 動画' }]
    expect(await appendTimelineBatch(db, id, play, batch(0, first))).toBe('stored')
    expect(await appendTimelineBatch(db, id, play, batch(1, second))).toBe('stored')

    const row = await timeline(id)
    const size = (events: readonly unknown[]) => Buffer.byteLength(JSON.stringify(events))
    expect(row).toMatchObject({
      kind: 'play',
      via: 'drive',
      version_id: play.versionId,
      play_id: null,
      address: '203.0.113.7',
      user_agent: 'Mozilla/5.0 (tests)',
      batches: 2,
      bytes: size(first) + size(second),
    })
    expect(await batches(id)).toEqual([
      { seq: 0, sent_ms: 0, address: '203.0.113.7', events: first, bytes: size(first) },
      { seq: 1, sent_ms: 1000, address: '203.0.113.7', events: second, bytes: size(second) },
    ])
  })

  it('starts a stream session when the server says it began, or a page’s play now', async () => {
    const early = new Date('2026-10-19T08:30:00.000Z')
    const dated = randomUUID()
    await appendTimelineBatch(
      db,
      dated,
      owner({ startedAt: early, clientStartedAt: early, playId: randomUUID() }),
      batch(0),
    )
    const undated = randomUUID()
    const before = Date.now()
    await appendTimelineBatch(db, undated, owner({ kind: 'stream', via: 'stream' }), batch(0))
    expect((await timeline(dated))?.started_ms).toBe(early.getTime())
    expect((await timeline(dated))?.play_id).not.toBeNull()
    const started = (await timeline(undated))?.started_ms ?? 0
    expect(Math.abs(started - before)).toBeLessThan(60_000)
  })

  it('keeps a batch sent twice once', async () => {
    const id = randomUUID()
    const play = owner()
    expect(await appendTimelineBatch(db, id, play, batch(0))).toBe('stored')
    const stored = await timeline(id)
    // A resend with other events changes nothing: the first copy stands.
    expect(
      await appendTimelineBatch(
        db,
        id,
        play,
        batch(0, [{ type: 'other', t: 9, pad: 'x'.repeat(50) }]),
      ),
    ).toBe('duplicate')
    expect(await batches(id)).toHaveLength(1)
    expect(await batches(id)).toMatchObject([{ events: [{ type: 'opened', t: 0 }] }])
    expect(await timeline(id)).toEqual(stored)
  })

  it('refuses a batch from another owner', async () => {
    const id = randomUUID()
    const play = owner()
    await appendTimelineBatch(db, id, play, batch(0))
    const stored = await timeline(id)
    for (const other of [
      owner({ ...play, userId: randomUUID() }),
      owner({ ...play, userId: null }),
      owner({ ...play, nodeId: randomUUID() }),
      owner({ ...play, via: 'link' }),
      owner({ ...play, kind: 'stream' }),
    ]) {
      expect(await appendTimelineBatch(db, id, other, batch(1))).toBe('not_yours')
    }

    // A link's viewer has no user, only the link.
    const linkId = randomUUID()
    const shareId = randomUUID()
    const viewer = owner({ via: 'link', userId: null, shareId })
    await appendTimelineBatch(db, linkId, viewer, batch(0))
    expect(
      await appendTimelineBatch(db, linkId, { ...viewer, shareId: randomUUID() }, batch(1)),
    ).toBe('not_yours')
    expect(await appendTimelineBatch(db, linkId, { ...viewer, shareId: null }, batch(1))).toBe(
      'not_yours',
    )
    expect(
      await appendTimelineBatch(db, linkId, { ...viewer, userId: randomUUID() }, batch(1)),
    ).toBe('not_yours')
    // Nothing was written by the refusals, and the right owner still can.
    expect(await timeline(id)).toEqual(stored)
    expect(await batches(id)).toHaveLength(1)
    expect(await batches(linkId)).toHaveLength(1)
    expect(await appendTimelineBatch(db, linkId, viewer, batch(1))).toBe('stored')
  })

  it('takes a batch from a new address in the same play', async () => {
    const id = randomUUID()
    const play = owner()
    await appendTimelineBatch(db, id, play, batch(0))
    // A phone that moved from Wi-Fi to mobile data, and a file replaced meanwhile.
    const moved = { ...batch(1), address: '198.51.100.20' }
    expect(
      await appendTimelineBatch(
        db,
        id,
        { ...play, address: '198.51.100.20', versionId: randomUUID() },
        moved,
      ),
    ).toBe('stored')
    expect((await batches(id)).map((found) => found.address)).toEqual([
      '203.0.113.7',
      '198.51.100.20',
    ])
    // The timeline keeps the address and the version it began with.
    expect(await timeline(id)).toMatchObject({
      address: '203.0.113.7',
      version_id: play.versionId,
      batches: 2,
    })
  })

  it('refuses a batch past the timeline’s cap', async () => {
    const id = randomUUID()
    const play = owner()
    await appendTimelineBatch(db, id, play, batch(0))
    await db.execute(sql`UPDATE timelines SET bytes = ${TIMELINE_MAX_BYTES - 10} WHERE id = ${id}`)
    const before = await timeline(id)
    const events = [{ type: 'opened', t: 1 }]
    expect(Buffer.byteLength(JSON.stringify(events))).toBeGreaterThan(10)
    expect(await appendTimelineBatch(db, id, play, batch(1, events))).toBe('full')
    expect(await timeline(id)).toEqual(before)
    expect(await batches(id)).toHaveLength(1)

    // Exactly the room left fits; one byte more doesn't.
    const room = [{ t: 2 }]
    const size = Buffer.byteLength(JSON.stringify(room))
    await db.execute(
      sql`UPDATE timelines SET bytes = ${TIMELINE_MAX_BYTES - size} WHERE id = ${id}`,
    )
    expect(await appendTimelineBatch(db, id, play, batch(2, room))).toBe('stored')
    expect((await timeline(id))?.bytes).toBe(TIMELINE_MAX_BYTES)
    expect(await appendTimelineBatch(db, id, play, batch(3, [{ t: 3 }]))).toBe('full')
    expect(await batches(id)).toHaveLength(2)
  })

  it('answers a stored batch sent again as a duplicate, even once the timeline is full', async () => {
    const id = randomUUID()
    const play = owner()
    await appendTimelineBatch(db, id, play, batch(0))
    await db.execute(sql`UPDATE timelines SET bytes = ${TIMELINE_MAX_BYTES} WHERE id = ${id}`)
    expect(await appendTimelineBatch(db, id, play, batch(0))).toBe('duplicate')
    expect(await appendTimelineBatch(db, id, play, batch(1))).toBe('full')
  })

  it('adds up batches that arrive at the same time', async () => {
    const id = randomUUID()
    const play = owner()
    const outcomes = await Promise.all(
      [0, 1, 2, 3, 4, 5].flatMap((seq) => [
        appendTimelineBatch(db, id, play, batch(seq)),
        // Each also arrives twice.
        appendTimelineBatch(db, id, play, batch(seq)),
      ]),
    )
    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(6)
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(6)
    const sizes = (await batches(id)).reduce((sum, found) => sum + found.bytes, 0)
    expect(await timeline(id)).toMatchObject({ batches: 6, bytes: sizes })
  })

  /** A user with a file in their drive and another in their vault (§7.7). */
  async function userWithFiles() {
    const username = `viewer-${randomUUID().slice(0, 8)}`
    const [user] = await db
      .insert(users)
      .values({ username, displayName: username, passwordHash: 'x', quotaBytes: 1 })
      .returning()
    if (!user) throw new Error('no user')
    const folder = async (name: string, tree: 'drive' | 'vault') => {
      const [row] = await db
        .insert(nodes)
        .values({ ownerId: user.id, kind: 'folder', name, nameKey: name, tree })
        .returning()
      if (!row) throw new Error('no folder')
      return row
    }
    const file = async (parentId: string, name: string) => {
      const [row] = await db
        .insert(nodes)
        .values({ ownerId: user.id, parentId, kind: 'file', name, nameKey: name.toLowerCase() })
        .returning()
      if (!row) throw new Error('no file')
      return row
    }
    const drive = await file((await folder('My Drive', 'drive')).id, 'Holiday.mp4')
    const vault = await file((await folder('Vault', 'vault')).id, 'Private.mp4')
    return { user, drive, vault }
  }

  it('lists timelines newest first, with the user’s and the file’s name', async () => {
    const { user, drive, vault } = await userWithFiles()
    const [oldest, middle, newest] = [randomUUID(), randomUUID(), randomUUID()]
    const clock = new Date('2026-10-19T08:29:59.500Z')
    const began = (hour: number) => new Date(`2026-10-19T0${String(hour)}:30:00.123Z`)
    const played = owner({
      nodeId: drive.id,
      userId: user.id,
      startedAt: began(6),
      clientStartedAt: clock,
    })
    await appendTimelineBatch(db, oldest, played, batch(0, [{ type: 'opened', t: 0 }]))
    await appendTimelineBatch(db, oldest, played, batch(1, [{ type: 'opened', t: 1 }]))
    // A vault file's name stays out, the account is named; a link's viewer has no account.
    await appendTimelineBatch(
      db,
      middle,
      owner({ nodeId: vault.id, userId: user.id, startedAt: began(7) }),
      batch(0),
    )
    const shareId = randomUUID()
    await appendTimelineBatch(
      db,
      newest,
      owner({
        kind: 'stream',
        via: 'link',
        userId: null,
        shareId,
        playId: oldest,
        userAgent: null,
        startedAt: began(8),
      }),
      { ...batch(0), sentMs: null },
    )

    const listed = await listTimelines(db, 10)
    expect(listed.map((row) => row.id)).toEqual([newest, middle, oldest])
    expect(listed.map((row) => row.fileName)).toEqual([null, null, 'Holiday.mp4'])
    expect(listed.map((row) => row.username)).toEqual([null, user.username, user.username])
    expect(listed[2]).toMatchObject({
      id: oldest,
      kind: 'play',
      playId: null,
      via: 'drive',
      nodeId: drive.id,
      versionId: played.versionId,
      userId: user.id,
      shareId: null,
      address: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (tests)',
      clientStartedAt: clock,
      startedAt: began(6),
      batches: 2,
      bytes: Buffer.byteLength('[{"type":"opened","t":0}]') * 2,
    })
    expect(listed[0]).toMatchObject({
      kind: 'stream',
      playId: oldest,
      via: 'link',
      userId: null,
      shareId,
      userAgent: null,
      clientStartedAt: null,
      startedAt: began(8),
    })
    // Real dates, and a number for the bytes.
    expect(listed[2]?.updatedAt).toBeInstanceOf(Date)
    expect(Math.abs((listed[2]?.updatedAt.getTime() ?? 0) - Date.now())).toBeLessThan(60_000)
    expect(typeof listed[2]?.bytes).toBe('number')

    expect((await listTimelines(db, 2)).map((row) => row.id)).toEqual([newest, middle])
    expect(await listTimelines(db, 0)).toEqual([])
  })

  it('reads a play with its stream sessions', async () => {
    const play = randomUUID()
    const owned = owner({ startedAt: new Date('2026-10-19T08:30:00.000Z') })
    // Seq 1 arrives before seq 0, and comes back after it.
    const second = [{ type: 'ended', t: 900 }]
    const first = [{ type: 'opened', t: 0 }]
    await appendTimelineBatch(db, play, owned, { ...batch(1, second), address: '198.51.100.20' })
    await appendTimelineBatch(db, play, owned, batch(0, first))

    const session = (playId: string | null, startedAt: string) =>
      owner({
        kind: 'stream',
        via: 'stream',
        nodeId: owned.nodeId,
        versionId: owned.versionId,
        playId,
        startedAt: new Date(startedAt),
      })
    const later = randomUUID()
    const earlier = randomUUID()
    const strange = randomUUID()
    const elsewhere = randomUUID()
    const events = (type: string) => [{ type, t: 5 }]
    // Written first but begun later, so it comes second; two sessions of other plays stay out.
    await appendTimelineBatch(db, later, session(play, '2026-10-19T08:31:00.000Z'), {
      ...batch(0, events('read')),
      sentMs: null,
    })
    const earlierOwner = session(play, '2026-10-19T08:30:30.000Z')
    await appendTimelineBatch(db, earlier, earlierOwner, {
      ...batch(0, events('seek')),
      sentMs: null,
    })
    await appendTimelineBatch(db, earlier, earlierOwner, {
      ...batch(1, events('read')),
      sentMs: null,
    })
    await appendTimelineBatch(db, strange, session(null, '2026-10-19T08:30:40.000Z'), batch(0))
    await appendTimelineBatch(
      db,
      elsewhere,
      session(randomUUID(), '2026-10-19T08:30:50.000Z'),
      batch(0),
    )

    const received = expect.any(Date) as Date
    const read = await readTimeline(db, play)
    expect(read?.timeline).toMatchObject({ id: play, kind: 'play', batches: 2 })
    expect(read?.batches).toEqual([
      { seq: 0, receivedAt: received, sentMs: 0, address: '203.0.113.7', events: first },
      {
        seq: 1,
        receivedAt: received,
        sentMs: 1000,
        address: '198.51.100.20',
        events: second,
      },
    ])
    expect(read?.sessions.map((found) => found.timeline.id)).toEqual([earlier, later])
    expect(read?.sessions.map((found) => found.timeline.playId)).toEqual([play, play])
    expect(read?.sessions[0]?.batches).toEqual([
      {
        seq: 0,
        receivedAt: received,
        sentMs: null,
        address: '203.0.113.7',
        events: events('seek'),
      },
      {
        seq: 1,
        receivedAt: received,
        sentMs: null,
        address: '203.0.113.7',
        events: events('read'),
      },
    ])
    expect(read?.sessions[1]?.batches).toHaveLength(1)

    // A session is read on its own, without sessions of its own.
    const alone = await readTimeline(db, later)
    expect(alone?.timeline).toMatchObject({ id: later, kind: 'stream', playId: play })
    expect(alone?.batches).toHaveLength(1)
    expect(alone?.sessions).toEqual([])
    // A play nothing streamed for has none; an unknown ID is no timeline.
    const quiet = randomUUID()
    await appendTimelineBatch(db, quiet, owner(), batch(0))
    expect((await readTimeline(db, quiet))?.sessions).toEqual([])
    expect(await readTimeline(db, randomUUID())).toBeNull()
  })

  it('drops timelines older than the retention, with their batches', async () => {
    const old = randomUUID()
    const fresh = randomUUID()
    const play = owner()
    await appendTimelineBatch(db, old, play, batch(0))
    await appendTimelineBatch(db, old, play, batch(1))
    await appendTimelineBatch(db, fresh, owner(), batch(0))
    expect(await batches(old)).toHaveLength(2)
    await db.execute(
      sql`UPDATE timelines SET updated_at = now() - interval '29 days' WHERE id = ${old}`,
    )

    expect(await pruneTimelines(db)).toEqual({ expired: 1, trimmed: 0 })
    expect(await timeline(old)).toBeUndefined()
    expect(await batches(old)).toEqual([])
    expect(await timeline(fresh)).toBeDefined()
    expect(await batches(fresh)).toHaveLength(1)
  })

  it('drops the least recently written past the size cap, with their batches', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, id] of ids.entries()) {
      await appendTimelineBatch(db, id, owner(), batch(0))
      // Last written 3, 2 and 1 hours ago, each holding 100 bytes.
      await db.execute(sql`
        UPDATE timelines SET bytes = 100, updated_at = now() - make_interval(hours => ${3 - index})
        WHERE id = ${id}`)
    }

    expect(await pruneTimelines(db, { days: 28, maxBytes: 250 })).toEqual({
      expired: 0,
      trimmed: 1,
    })
    expect(await timeline(ids[0] ?? '')).toBeUndefined()
    expect(await batches(ids[0] ?? '')).toEqual([])
    expect(await timeline(ids[1] ?? '')).toBeDefined()
    expect(await batches(ids[1] ?? '')).toHaveLength(1)
    expect(await timeline(ids[2] ?? '')).toBeDefined()
    expect(await batches(ids[2] ?? '')).toHaveLength(1)
  })

  it('keeps a play still being written over an idle one that began later', async () => {
    const running = randomUUID()
    const idle = randomUUID()
    await appendTimelineBatch(db, running, owner(), batch(0))
    await appendTimelineBatch(db, idle, owner(), batch(0))
    // The long play began 3 hours ago and wrote just now; the other began later and has been quiet.
    await db.execute(sql`
      UPDATE timelines SET bytes = 100, started_at = now() - interval '3 hours', updated_at = now()
      WHERE id = ${running}`)
    await db.execute(sql`
      UPDATE timelines SET bytes = 100, started_at = now() - interval '1 hour',
        updated_at = now() - interval '50 minutes'
      WHERE id = ${idle}`)

    expect(await pruneTimelines(db, { days: 28, maxBytes: 150 })).toEqual({
      expired: 0,
      trimmed: 1,
    })
    expect(await timeline(idle)).toBeUndefined()
    expect(await batches(idle)).toEqual([])
    expect(await timeline(running)).toBeDefined()
    expect(await batches(running)).toHaveLength(1)
  })
})

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApiClient, createFolder, text, uploadFile, workspace } from '@dfs/contract'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { fileMediaSchema, systemHealthSchema, type MediaInfo, type ProbeResult } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { mediaToken } from './token.ts'

// Examining audio and video (DESIGN.md §6.7), over real HTTP, against a
// stand-in for the media service that reads each file back from the API's
// internal route with the token it was given, as ffprobe does, and answers
// what a test says.

let database: TestDatabase
let app: FastifyInstance
let cleanup: () => Promise<void>
let client: ApiClient
let apiUrl = ''
let standIn: http.Server
let folderId: string

/** What the stand-in answers next, and what it was asked and read. */
let answer: 'media' | 'not media' | 'down' = 'media'
const probes: { versionId: string; readStatus: number; firstBytes: string }[] = []

const SONG: MediaInfo = {
  kind: 'audio',
  container: 'mp3',
  durationMs: 2000,
  bitRate: 128_000,
  streams: [
    {
      index: 0,
      type: 'audio',
      codec: 'mp3',
      codecString: 'mp4a.6B',
      profile: null,
      width: null,
      height: null,
      frameRate: null,
      bitDepth: null,
      hdr: null,
      dolbyVision: null,
      rotation: null,
      channels: 2,
      channelLayout: 'stereo',
      sampleRate: 44_100,
      language: null,
      title: null,
      default: true,
      forced: false,
    },
  ],
  chapters: [],
  tags: {
    title: 'Song',
    artist: 'Artist',
    album: null,
    albumArtist: null,
    genre: null,
    track: 3,
    disc: null,
    year: null,
  },
  hasCover: false,
}

beforeAll(async () => {
  standIn = http.createServer((request, response) => {
    let body = ''
    request.on('data', (data: Buffer) => (body += data.toString()))
    request.on('end', () => {
      void (async () => {
        if (request.url === '/health') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              status: 'ok',
              release: 'dev',
              ffmpeg: 'ffprobe version 7.1.5-0+deb13u1',
            }),
          )
          return
        }
        const { versionId, token } = JSON.parse(body) as { versionId: string; token: string }
        const read = await fetch(`${apiUrl}/internal/media/${versionId}`, {
          headers: { authorization: `Bearer ${token}`, range: 'bytes=0-3' },
        })
        const firstBytes = read.ok ? Buffer.from(await read.arrayBuffer()).toString() : ''
        probes.push({ versionId, readStatus: read.status, firstBytes })
        if (answer === 'down') {
          response.writeHead(502).end()
          return
        }
        const result: ProbeResult =
          answer === 'media'
            ? { ok: true, info: SONG }
            : { ok: false, reason: 'It holds no audio or video.' }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
      })()
    })
  })
  await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve))
  const standInUrl = `http://127.0.0.1:${String((standIn.address() as AddressInfo).port)}`

  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url, MEDIA_INTERNAL_URL: standInUrl })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  apiUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password', role: 'admin' })
  client = new ApiClient(apiUrl, setup.config.publicBaseUrl)
  await client.signIn('owner', 'the-owner-password')
  folderId = (await createFolder(client, (await workspace(client)).id, 'Music')).id
})

afterAll(async () => {
  await app.close()
  await new Promise((resolve) => standIn.close(resolve))
  await database.drop()
  await cleanup()
})

beforeEach(() => {
  answer = 'media'
  probes.length = 0
})

async function media(nodeId: string) {
  return client.call('GET', `/files/${nodeId}/media`, fileMediaSchema)
}

async function kept(versionId: string) {
  const { rows } = await app.db.execute<{ problem: string | null; has_info: boolean }>(sql`
    SELECT problem, info IS NOT NULL AS has_info FROM media_info WHERE version_id = ${versionId}`)
  return rows[0] ?? null
}

describe('examining audio and video (§6.7)', () => {
  it('examines a file once its upload completes, reading it with a token for it alone', async () => {
    const song = await uploadFile(client, folderId, 'song.mp3', text('ID3 and the rest'))
    await vi.waitFor(async () => {
      expect(await kept(song.versionId)).toEqual({ problem: null, has_info: true })
    })
    expect(probes).toEqual([{ versionId: song.versionId, readStatus: 206, firstBytes: 'ID3 ' }])

    // Kept: the player's ask doesn't examine it again.
    expect(await media(song.nodeId)).toEqual({
      versionId: song.versionId,
      info: SONG,
      problem: null,
    })
    expect(probes).toHaveLength(1)
  })

  it('leaves other files alone, and says they aren’t media', async () => {
    const notes = await uploadFile(client, folderId, 'notes.txt', text('Just notes.'))
    // Long enough for an examination to have started, had there been one.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(probes).toHaveLength(0)
    expect(await client.error('GET', `/files/${notes.nodeId}/media`)).toEqual({
      status: 422,
      code: 'not_media',
    })
  })

  it('keeps that a file holds nothing ffmpeg reads, so it isn’t asked again', async () => {
    answer = 'not media'
    const fake = await uploadFile(client, folderId, 'fake.mp4', text('Not a video at all.'))
    await vi.waitFor(async () => {
      expect(await kept(fake.versionId)).toEqual({
        problem: 'It holds no audio or video.',
        has_info: false,
      })
    })
    expect(await media(fake.nodeId)).toEqual({
      versionId: fake.versionId,
      info: null,
      problem: 'It holds no audio or video.',
    })
    expect(probes).toHaveLength(1)
  })

  it('asks again later when the media service couldn’t say, keeping nothing', async () => {
    answer = 'down'
    const film = await uploadFile(client, folderId, 'film.mkv', text('Matroska, honestly.'))
    await vi.waitFor(() => {
      expect(probes).toHaveLength(1)
    })
    expect(await kept(film.versionId)).toBeNull()
    expect(await client.error('GET', `/files/${film.nodeId}/media`)).toEqual({
      status: 503,
      code: 'media_unavailable',
    })
    answer = 'media'
    expect((await media(film.nodeId)).info?.kind).toBe('audio')
    expect(probes).toHaveLength(3)
  })

  it('forgets what it found with the version, when a new one replaces it', async () => {
    const first = await uploadFile(client, folderId, 'replaced.flac', text('first'))
    await vi.waitFor(async () => {
      expect(await kept(first.versionId)).not.toBeNull()
    })
    const second = await uploadFile(client, folderId, 'replaced.flac', text('second'))
    await vi.waitFor(async () => {
      expect(await kept(second.versionId)).not.toBeNull()
    })
    // The first version was pruned, and its media info with it.
    expect(await kept(first.versionId)).toBeNull()
  })
})

describe('the internal route the media service reads from (§6.7)', () => {
  let versionId: string

  beforeAll(async () => {
    versionId = (await uploadFile(client, folderId, 'read.wav', text('RIFF and wave'))).versionId
  })

  it('serves a version with its token, with Range', async () => {
    const response = await fetch(`${apiUrl}/internal/media/${versionId}`, {
      headers: {
        authorization: `Bearer ${await mediaToken(app.keys, versionId)}`,
        range: 'bytes=5-8',
      },
    })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('and ')
  })

  it('serves nothing without a token for that version', async () => {
    const otherVersion = (await uploadFile(client, folderId, 'other.wav', text('other'))).versionId
    for (const authorization of [
      undefined,
      'Bearer nonsense',
      `Bearer ${await mediaToken(app.keys, otherVersion)}`,
      // Altered by one character.
      `Bearer ${await mediaToken(app.keys, versionId)}x`,
    ]) {
      const response = await fetch(`${apiUrl}/internal/media/${versionId}`, {
        headers: authorization ? { authorization } : {},
      })
      expect(response.status).toBe(401)
    }
  })

  it('isn’t under /api, where the edge forwards requests', async () => {
    const response = await client.fetch('GET', `/internal/media/${versionId}`, {
      headers: { authorization: `Bearer ${await mediaToken(app.keys, versionId)}` },
    })
    expect(response.status).toBe(404)
  })
})

describe('Admin → System (§16)', () => {
  it('shows the media service and the ffmpeg it runs', async () => {
    const health = await client.call('GET', '/admin/health', systemHealthSchema)
    expect(health.services).toContainEqual({ name: 'Media', status: 'ok', detail: 'ffmpeg 7.1.5' })
  })
})

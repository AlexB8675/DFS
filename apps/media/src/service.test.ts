import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { probeResultSchema, type MediaInfo } from '@dfs/shared'
import { GenericContainer, TestContainers, Wait, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The media service in its own image, with the ffmpeg production runs
// (DESIGN.md §6.7), against a stand-in for the API that serves test files
// the image makes (testing/make-fixtures.sh) with Range, as the API's
// internal route does, and only with the token for each.

const root = path.resolve(import.meta.dirname, '../../..')
const IMAGE = 'dfs-media:test'
const FIXTURES = [
  'film.mkv',
  'phone.mp4',
  'old.avi',
  'song.mp3',
  'track.flac',
  'notes.txt',
  'picture.png',
  'playlist.m3u8',
  'list.ffconcat',
]

let container: StartedTestContainer
let api: http.Server
let mediaUrl: string
/** Each test file, by the version ID it is served as. */
const files = new Map<string, { name: string; bytes: Buffer }>()
const ids = new Map<string, string>()
/** Every request the stand-in API had: `GET /path`. */
const requests: string[] = []

/** A token in the API's form (`<expiry>.<HMAC>`), different for each version. */
const tokenFor = (versionId: string) =>
  `4102444800000.${Buffer.from(versionId.replaceAll('-', ''), 'hex').toString('base64url').padEnd(43, 'A')}`

beforeAll(async () => {
  // Built from docker/media.Dockerfile, cached after the first time.
  await run('docker', ['build', '-q', '-f', 'docker/media.Dockerfile', '-t', IMAGE, '.'], root)

  api = http.createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
    const match = /^\/internal\/media\/([0-9a-f-]{36})$/.exec(request.url ?? '')
    const file = match?.[1] ? files.get(match[1]) : undefined
    if (!match?.[1] || !file) return response.writeHead(404).end()
    if (request.headers.authorization !== `Bearer ${tokenFor(match[1])}`) {
      return response.writeHead(401).end()
    }
    const size = file.bytes.length
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    if (!range) {
      response.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
      return response.end(file.bytes)
    }
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size) {
      return response.writeHead(416, { 'content-range': `bytes */${String(size)}` }).end()
    }
    response.writeHead(206, {
      'content-length': end - start + 1,
      'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
      'accept-ranges': 'bytes',
    })
    response.end(file.bytes.subarray(start, end + 1))
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  const { port } = api.address() as AddressInfo
  await TestContainers.exposeHostPorts(port)

  container = await new GenericContainer(IMAGE)
    .withEnvironment({
      API_INTERNAL_URL: `http://host.testcontainers.internal:${String(port)}`,
      LOG_LEVEL: 'warn',
    })
    .withCopyFilesToContainer([
      {
        source: path.join(import.meta.dirname, 'testing/make-fixtures.sh'),
        target: '/tmp/make-fixtures.sh',
      },
    ])
    .withExposedPorts(3002)
    .withWaitStrategy(Wait.forHttp('/health', 3002))
    .start()
  mediaUrl = `http://${container.getHost()}:${String(container.getMappedPort(3002))}`

  const made = await container.exec(['bash', '/tmp/make-fixtures.sh', '/tmp/fixtures'])
  if (made.exitCode !== 0) throw new Error(`Making the test files failed: ${made.output}`)
  for (const name of FIXTURES) {
    const read = await container.exec(['base64', '-w0', `/tmp/fixtures/${name}`])
    if (read.exitCode !== 0) throw new Error(`No ${name}: ${read.output}`)
    const versionId = randomUUID()
    files.set(versionId, { name, bytes: Buffer.from(read.stdout, 'base64') })
    ids.set(name, versionId)
  }
})

afterAll(async () => {
  await container.stop()
  await new Promise((resolve) => api.close(resolve))
})

async function probe(name: string, token?: string) {
  const versionId = ids.get(name) ?? randomUUID()
  return fetch(`${mediaUrl}/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ versionId, token: token ?? tokenFor(versionId) }),
  })
}

async function examined(name: string): Promise<MediaInfo> {
  const response = await probe(name)
  expect(response.status).toBe(200)
  const result = probeResultSchema.parse(await response.json())
  if (!result.ok) throw new Error(`${name} isn't media: ${result.reason}`)
  return result.info
}

describe('the media service (§6.7)', () => {
  it('answers its health check with the ffmpeg it runs', async () => {
    const health = (await (await fetch(`${mediaUrl}/health`)).json()) as Record<string, string>
    expect(health).toMatchObject({ status: 'ok', release: 'dev' })
    expect(health.ffmpeg).toMatch(/^ffprobe version 7\./)
  })

  it('examines video and audio, reading them from the API with their tokens', async () => {
    requests.length = 0
    const film = await examined('film.mkv')
    expect(film.streams.map((stream) => [stream.type, stream.codecString])).toEqual([
      ['video', 'hvc1.2.4.L60.B0'],
      ['audio', 'ac-3'],
      ['subtitle', null],
    ])
    expect(film.streams[0]?.hdr).toBe('pq')
    expect(film.chapters).toHaveLength(2)
    expect(
      requests.every((line) => line === `GET /internal/media/${ids.get('film.mkv') ?? ''}`),
    ).toBe(true)

    expect((await examined('phone.mp4')).streams[0]?.rotation).toBe(90)
    expect((await examined('old.avi')).streams[0]?.codec).toBe('mpeg4')
    const song = await examined('song.mp3')
    expect(song).toMatchObject({ kind: 'audio', hasCover: true })
    expect(song.tags).toMatchObject({ artist: 'Artist', track: 3 })
    expect((await examined('track.flac')).tags.title).toBe('Track')
  })

  it('says a file that isn’t audio or video isn’t, for good', async () => {
    const response = await probe('notes.txt')
    expect(response.status).toBe(200)
    expect(probeResultSchema.parse(await response.json())).toMatchObject({ ok: false })
  })

  it('opens no playlist or list of files, so their entries are never read', async () => {
    for (const name of ['playlist.m3u8', 'list.ffconcat']) {
      requests.length = 0
      const response = await probe(name)
      expect(response.status).toBe(200)
      expect(probeResultSchema.parse(await response.json()).ok).toBe(false)
      // Only the file itself was read, from the API.
      expect(new Set(requests)).toEqual(new Set([`GET /internal/media/${ids.get(name) ?? ''}`]))
    }
  })

  it('opens only the containers DFS plays: not a picture, which ffmpeg reads as video', async () => {
    const response = await probe('picture.png')
    const result = probeResultSchema.parse(await response.json())
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/not on whitelist/i)
  })

  it('says the API couldn’t be read, to be asked again, rather than calling the file bad', async () => {
    const response = await probe('film.mkv', tokenFor(randomUUID()))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'source_unavailable' } })
  })

  it('refuses a request without a version and a token', async () => {
    const response = await fetch(`${mediaUrl}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: 'not-a-version', token: '' }),
    })
    expect(response.status).toBe(400)
  })

  it('takes only a token in the API’s form, so no header reaches ffmpeg’s request', async () => {
    requests.length = 0
    const versionId = ids.get('film.mkv') ?? ''
    const response = await fetch(`${mediaUrl}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        versionId,
        token: `${tokenFor(versionId)}
Range: bytes=0-0`,
      }),
    })
    expect(response.status).toBe(400)
    expect(requests).toEqual([])
  })
})

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed:\n${stderr}`))
    })
  })
}

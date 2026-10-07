import type { DriveNode, SyncState, UploadSession } from '@dfs/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '@/app/query-client'
import { ApiError } from '@/lib/api/client'
import { DEFAULT_LIMITS, PAUSE_LIMIT_MS, UploadEngine } from './upload-engine'
import { useUploadStore } from './upload-store'
import type { OnProgress, UploadTransport } from './upload-transport'

/** Tiny parts, so a few bytes make a multi-part file. */
const CHUNK = 4

interface Put {
  uploadId: string
  index: number
  release: () => void
  fail: (error: Error) => void
}

interface Stream {
  uploadId: string
  from: number
  /** Bytes the stream carries: the file from part `from` on. */
  size: number
  /** Reports this many bytes sent, as the browser would. */
  progress: (sent: number) => void
  /** The server stores the next `parts` parts, whole, before the stream ends. */
  store: (parts: number) => void
  release: () => void
  fail: (error: Error) => void
}

/**
 * An in-memory upload API. Each PUT or stream waits until the test releases
 * it (or `autoRelease` is on), so tests can look at what is in flight.
 */
function fakeApi() {
  const sessions = new Map<string, UploadSession & { parts: Set<number> }>()
  const pending: Put[] = []
  const streams: Stream[] = []
  const sent: { uploadId: string; index: number }[] = []
  const streamed: { uploadId: string; from: number }[] = []
  let inFlight = 0
  const api = {
    autoRelease: true,
    maxInFlight: 0,
    /** Decides how a PUT ends; return an error to fail it. */
    failPart: (_uploadId: string, _index: number, _attempt: number): Error | null => null,
    /** Decides how a stream ends; return an error to fail it, with only the parts it stored. */
    failStream: (_uploadId: string, _attempt: number): Error | null => null,
    sessions,
    pending,
    streams,
    sent,
    streamed,
    attempts: new Map<string, number>(),
  }

  const held = <T extends { release: () => void }>(
    list: T[],
    signal: AbortSignal,
    make: (settle: (error: Error | null) => void) => T,
    onSuccess: () => void,
  ) => {
    inFlight += 1
    api.maxInFlight = Math.max(api.maxInFlight, inFlight)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error: Error | null) => {
        if (settled) return
        settled = true
        inFlight -= 1
        list.splice(list.indexOf(entry), 1)
        if (error) {
          reject(error)
          return
        }
        onSuccess()
        resolve()
      }
      const entry = make(settle)
      list.push(entry)
      signal.addEventListener('abort', () => {
        settle(new DOMException('Aborted', 'AbortError'))
      })
      if (api.autoRelease) setTimeout(entry.release, 1)
    })
  }

  const transport: UploadTransport = {
    ensureFolders: (_parentId, paths) =>
      Promise.resolve(Object.fromEntries(paths.map((path) => [path, crypto.randomUUID()]))),
    createSessions: vi.fn<UploadTransport['createSessions']>((uploads) =>
      Promise.resolve(
        uploads.map((upload) => {
          const session = {
            uploadId: crypto.randomUUID(),
            nodeId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            isNewVersion: false,
            chunkSize: CHUNK,
            chunkCount: Math.ceil(upload.sizeBytes / CHUNK),
          }
          sessions.set(session.uploadId, { ...session, parts: new Set() })
          return { ok: true as const, session }
        }),
      ),
    ),
    putPart: (uploadId, index, _body, _sha256, signal) => {
      const key = `${uploadId}:${String(index)}`
      const attempt = (api.attempts.get(key) ?? 0) + 1
      api.attempts.set(key, attempt)
      sent.push({ uploadId, index })
      return held(
        pending,
        signal,
        (settle) => ({
          uploadId,
          index,
          release: () => {
            settle(api.failPart(uploadId, index, attempt))
          },
          fail: settle,
        }),
        () => sessions.get(uploadId)?.parts.add(index),
      )
    },
    streamFile: (uploadId, from, body, signal, onProgress?: OnProgress) => {
      const attempt = (api.attempts.get(uploadId) ?? 0) + 1
      api.attempts.set(uploadId, attempt)
      streamed.push({ uploadId, from })
      const session = sessions.get(uploadId)
      let next = from
      return held(
        streams,
        signal,
        (settle) => ({
          uploadId,
          from,
          size: body.size,
          progress: (bytes) => onProgress?.(bytes),
          store: (parts) => {
            for (let stored = 0; stored < parts; stored += 1) session?.parts.add(next++)
          },
          release: () => {
            settle(api.failStream(uploadId, attempt))
          },
          fail: settle,
        }),
        () => {
          for (let index = from; index < (session?.chunkCount ?? 0); index += 1) {
            session?.parts.add(index)
          }
        },
      )
    },
    complete: vi.fn<UploadTransport['complete']>(() => Promise.resolve()),
    alive: vi.fn<UploadTransport['alive']>(() => Promise.resolve()),
    status: (uploadId) => {
      const session = sessions.get(uploadId)
      if (!session) return Promise.reject(new ApiError(404, 'upload_not_found', 'Gone'))
      const { parts, ...rest } = session
      const state = parts.size === rest.chunkCount ? 'completed' : 'receiving'
      return Promise.resolve({ ...rest, state, receivedParts: [...parts] })
    },
    cancel: vi.fn<UploadTransport['cancel']>(() => Promise.resolve()),
    nodes: vi.fn<UploadTransport['nodes']>(() => Promise.resolve([])),
  }
  return { api, transport }
}

function file(name: string, size: number) {
  return { file: new File([new Uint8Array(size).map((_, i) => i % 251)], name), relativeDir: '' }
}

function item(name: string) {
  const found = items().find((candidate) => candidate.file.name === name)
  if (!found) throw new Error(`No upload named ${name}`)
  return found
}

function items() {
  return useUploadStore.getState().items.map((entry) => entry.store.getState())
}

function stream(api: ReturnType<typeof fakeApi>['api']) {
  const [first] = api.streams
  if (!first) throw new Error('No stream in flight.')
  return first
}

const busy = () => new ApiError(503, 'staging_full', 'Staging is full', 0)

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function driveNode(id: string, syncState: SyncState): DriveNode {
  return {
    id,
    parentId: crypto.randomUUID(),
    kind: 'file',
    name: 'file.txt',
    mimeType: 'text/plain',
    sizeBytes: 3,
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    syncState,
    hasChildFolders: false,
  }
}

describe('UploadEngine', () => {
  beforeEach(() => {
    useUploadStore.getState().remove(new Set(items().map((upload) => upload.id)))
    useUploadStore.getState().apply(new Map(), 0)
  })

  it('streams a larger file in one request, then completes it with every part’s hash', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    const picked = file('big.bin', 10 * CHUNK + 1)
    await engine.enqueue('folder', [picked])

    await vi.waitFor(() => {
      expect(item('big.bin').status).toBe('done')
    })
    expect(api.streamed).toEqual([{ uploadId: expect.any(String) as string, from: 0 }])
    expect(api.sent).toEqual([])
    const bytes = new Uint8Array(await picked.file.arrayBuffer())
    const hashes = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        sha256Hex(bytes.slice(index * CHUNK, (index + 1) * CHUNK)),
      ),
    )
    expect(transport.complete).toHaveBeenCalledExactlyOnceWith(api.streamed[0]?.uploadId, hashes)
    expect(item('big.bin').uploadedBytes).toBe(10 * CHUNK + 1)
  })

  it('counts a stream’s bytes as they go, so its speed holds steady', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    try {
      await engine.enqueue('folder', [file('steady.bin', 100 * CHUNK)])
      await vi.waitFor(() => {
        expect(api.streams).toHaveLength(1)
      })
      const speeds: number[] = []
      const progress: number[] = []
      for (let sent = CHUNK; sent < 60 * CHUNK; sent += CHUNK) {
        stream(api).progress(sent)
        await new Promise((resolve) => setTimeout(resolve, 15))
        speeds.push(useUploadStore.getState().bytesPerSecond)
        progress.push(item('steady.bin').uploadedBytes)
      }
      // From the first publish on, the speed never falls to nothing between parts.
      expect(speeds.slice(speeds.findIndex((speed) => speed > 0)).every((speed) => speed > 0)).toBe(
        true,
      )
      expect(progress.at(-1)).toBeGreaterThan(40 * CHUNK)
      expect(
        progress.every((bytes, index) => index === 0 || bytes >= (progress[index - 1] ?? 0)),
      ).toBe(true)
    } finally {
      engine.cancelAll()
    }
  })

  it('starts a broken stream again after the parts the server kept', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('broken.bin', 8 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1)
    })
    stream(api).progress(4 * CHUNK)
    stream(api).store(3)
    api.autoRelease = true
    stream(api).fail(new TypeError('The connection dropped.'))

    await vi.waitFor(
      () => {
        expect(item('broken.bin').status).toBe('done')
      },
      { timeout: 5000 },
    )
    expect(api.streamed.map((sent) => sent.from)).toEqual([0, 3])
  })

  it('pauses a stream and resumes after the parts the server kept', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('movie.mkv', 8 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1)
    })
    stream(api).progress(3 * CHUNK)
    stream(api).store(2)
    engine.pause(item('movie.mkv').id)

    await vi.waitFor(() => {
      expect(item('movie.mkv')).toMatchObject({ status: 'paused', uploadedBytes: 3 * CHUNK })
    })
    expect(api.streams).toHaveLength(0)

    api.autoRelease = true
    engine.resume(item('movie.mkv').id)
    await vi.waitFor(() => {
      expect(item('movie.mkv').status).toBe('done')
    })
    expect(api.streamed.map((sent) => sent.from)).toEqual([0, 2])
    expect(transport.complete).toHaveBeenCalledOnce()
  })

  it('sends the parts that arrived damaged again, and completes', async () => {
    const { api, transport } = fakeApi()
    let checked = 0
    const complete = vi.fn<UploadTransport['complete']>((uploadId) => {
      checked += 1
      if (checked > 1) return Promise.resolve()
      // The server dropped part 1, whose bytes didn't match.
      api.sessions.get(uploadId)?.parts.delete(1)
      return Promise.reject(new ApiError(400, 'hash_mismatch', 'Damaged.'))
    })
    const engine = new UploadEngine({ ...transport, complete })
    await engine.enqueue('folder', [file('damaged.bin', 4 * CHUNK)])

    await vi.waitFor(
      () => {
        expect(item('damaged.bin').status).toBe('done')
      },
      { timeout: 5000 },
    )
    expect(api.streamed.map((sent) => sent.from)).toEqual([0, 1])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1]?.[1]).toEqual(complete.mock.calls[0]?.[1])
  })

  it('bounds memory across tiny files', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const picked = Array.from({ length: 30 }, (_, index) => file(`bounded-${String(index)}`, CHUNK))
    const slices = picked.map(({ file }) => vi.spyOn(file, 'slice'))
    const engine = new UploadEngine(transport, {
      ...DEFAULT_LIMITS,
      requests: 1,
      bufferedBytes: 2 * CHUNK,
    })
    const reads = () => slices.reduce((total, slice) => total + slice.mock.calls.length, 0)
    try {
      await engine.enqueue('folder', picked)
      await vi.waitFor(() => {
        expect(reads()).toBe(2)
        expect(api.pending).toHaveLength(1)
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      expect(reads()).toBe(2)
      api.pending[0]?.release()
      await vi.waitFor(() => {
        expect(api.sent).toHaveLength(2)
        expect(reads()).toBe(3)
      })
      expect(api.maxInFlight).toBe(1)
    } finally {
      engine.cancelAll()
      for (const slice of slices) slice.mockRestore()
    }
  })

  it('bounds prepared tiny files by count even when the byte budget has room', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const picked = Array.from({ length: 30 }, (_, index) => file(`tiny-${String(index)}`, 1))
    const slices = picked.map(({ file }) => vi.spyOn(file, 'slice'))
    const engine = new UploadEngine(transport, { ...DEFAULT_LIMITS, requests: 1 })
    try {
      await engine.enqueue('folder', picked)
      await vi.waitFor(() => {
        expect(slices.reduce((total, slice) => total + slice.mock.calls.length, 0)).toBe(3)
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      expect(slices.reduce((total, slice) => total + slice.mock.calls.length, 0)).toBe(3)
      expect(api.pending).toHaveLength(1)
    } finally {
      engine.cancelAll()
      for (const slice of slices) slice.mockRestore()
    }
  })

  it('discards canceled preparation and releases its budget for another file', async () => {
    const { api, transport } = fakeApi()
    const blocked = file('blocked.bin', CHUNK)
    const slice = blocked.file.slice.bind(blocked.file)
    const read = Promise.withResolvers<ArrayBuffer>()
    const reading = Promise.withResolvers<undefined>()
    const spy = vi.spyOn(blocked.file, 'slice').mockImplementation((start, end) => {
      const blob = slice(start, end)
      vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => {
        reading.resolve(undefined)
        return read.promise
      })
      return blob
    })
    const engine = new UploadEngine(transport, {
      ...DEFAULT_LIMITS,
      requests: 1,
      preparedParts: 1,
      bufferedBytes: CHUNK,
    })
    try {
      await engine.enqueue('folder', [blocked, file('after.bin', CHUNK)])
      await reading.promise
      engine.cancel(item('blocked.bin').id)
      read.resolve(new ArrayBuffer(CHUNK))
      await vi.waitFor(() => {
        expect(item('after.bin').status).toBe('done')
      })
      expect(api.sent).toHaveLength(1)
      expect(api.sent[0]?.uploadId).toBe(
        [...api.sessions.values()].find((session) => session.nodeId === item('after.bin').nodeId)
          ?.uploadId,
      )
      expect(item('blocked.bin').status).toBe('canceled')
    } finally {
      read.resolve(new ArrayBuffer(CHUNK))
      engine.cancelAll()
      spy.mockRestore()
    }
  })

  it('releases failed preparation so retries and other uploads can make progress', async () => {
    const { api, transport } = fakeApi()
    const broken = file('read-error.bin', CHUNK)
    const slice = broken.file.slice.bind(broken.file)
    const spy = vi.spyOn(broken.file, 'slice').mockImplementationOnce((start, end) => {
      const blob = slice(start, end)
      vi.spyOn(blob, 'arrayBuffer').mockRejectedValueOnce(new Error('Reading failed.'))
      return blob
    })
    const engine = new UploadEngine(transport, {
      ...DEFAULT_LIMITS,
      requests: 1,
      preparedParts: 1,
      bufferedBytes: CHUNK,
    })
    try {
      await engine.enqueue('folder', [broken, file('readable.bin', CHUNK)])
      await vi.waitFor(() => {
        expect(item('read-error.bin').status).toBe('failed')
        expect(item('readable.bin').status).toBe('done')
      })
      engine.retry(item('read-error.bin').id)
      await vi.waitFor(() => {
        expect(item('read-error.bin').status).toBe('done')
      })
      expect(api.sent).toHaveLength(2)
    } finally {
      engine.cancelAll()
      spy.mockRestore()
    }
  })

  it('resumes correctly when paused during hashing without sending the aborted preparation', async () => {
    const { api, transport } = fakeApi()
    const hashing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const spy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementationOnce(async (algorithm, bytes) => {
        hashing.resolve(undefined)
        await release.promise
        return digest(algorithm, bytes)
      })
    const engine = new UploadEngine(transport, {
      ...DEFAULT_LIMITS,
      requests: 1,
      bufferedBytes: CHUNK,
    })
    try {
      await engine.enqueue('folder', [file('hash-pause.bin', CHUNK)])
      await hashing.promise
      const upload = item('hash-pause.bin')
      engine.pause(upload.id)
      engine.resume(upload.id)
      release.resolve(undefined)
      await vi.waitFor(() => {
        expect(item('hash-pause.bin').status).toBe('done')
      })
      expect(api.sent.map((part) => part.index)).toEqual([0])
      expect(item('hash-pause.bin').uploadedBytes).toBe(CHUNK)
    } finally {
      release.resolve(undefined)
      engine.cancelAll()
      spy.mockRestore()
    }
  })

  it('rejects a missing upload folder instead of sending its files into the root', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine({ ...transport, ensureFolders: () => Promise.resolve({}) })

    await expect(
      engine.enqueue('folder', [{ ...file('photo.jpg', 2), relativeDir: 'photos' }]),
    ).rejects.toThrow('photos')

    expect(transport.createSessions).not.toHaveBeenCalled()
    expect(useUploadStore.getState().items).toEqual([])
  })

  it('queues nothing when a later folder preparation batch is incomplete', async () => {
    const { transport } = fakeApi()
    const ensureFolders = vi
      .fn(transport.ensureFolders)
      .mockImplementationOnce(transport.ensureFolders)
      .mockResolvedValueOnce({})
    const engine = new UploadEngine({ ...transport, ensureFolders })
    const files = Array.from({ length: 501 }, (_, index) => ({
      ...file(`photo-${String(index)}.jpg`, 2),
      relativeDir: `photos-${String(index)}`,
    }))

    await expect(engine.enqueue('folder', files)).rejects.toThrow('photos-500')

    expect(ensureFolders).toHaveBeenCalledTimes(2)
    expect(transport.createSessions).not.toHaveBeenCalled()
    expect(useUploadStore.getState().items).toEqual([])
  })

  it('shows a dropped folder in the folder it was dropped into, and in its parents', async () => {
    const { transport } = fakeApi()
    const ensureFolders = vi.fn(transport.ensureFolders)
    const engine = new UploadEngine({ ...transport, ensureFolders })
    const listing = (id: string) => ['nodes', id, 'children', { sort: 'name', order: 'asc' }]
    for (const id of ['folder', 'elsewhere']) queryClient.setQueryData(listing(id), { pages: [] })

    await engine.enqueue('folder', [{ ...file('photo.jpg', 2), relativeDir: 'trip/photos' }])

    // Every folder on the way is asked for, so an existing one that gains a subfolder refreshes.
    expect(ensureFolders).toHaveBeenCalledWith('folder', ['trip', 'trip/photos'])
    await vi.waitFor(
      () => {
        expect(queryClient.getQueryState(listing('folder'))?.isInvalidated).toBe(true)
      },
      { timeout: 3000 },
    )
    expect(queryClient.getQueryState(listing('elsewhere'))?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  it('uploads nested and loose files into their prepared folders', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine({
      ...transport,
      ensureFolders: () => Promise.resolve({ photos: 'photos-folder' }),
    })
    await engine.enqueue('folder', [
      { ...file('photo.jpg', 2), relativeDir: 'photos' },
      file('loose.txt', 2),
    ])

    await vi.waitFor(() => {
      expect(item('photo.jpg').status).toBe('done')
      expect(item('loose.txt').status).toBe('done')
    })
    expect(item('photo.jpg').parentId).toBe('photos-folder')
    expect(item('loose.txt').parentId).toBe('folder')
    expect(transport.createSessions).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'photo.jpg', parentId: 'photos-folder' }),
      expect.objectContaining({ name: 'loose.txt', parentId: 'folder' }),
    ])
  })

  it('creates sessions in batches and sends small files 8 at a time, with no complete call', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue(
      'folder',
      Array.from({ length: 20 }, (_, index) => file(`small-${String(index)}.txt`, 2)),
    )

    await vi.waitFor(() => {
      expect(items().every((upload) => upload.status === 'done')).toBe(true)
    })
    expect(transport.createSessions).toHaveBeenCalledTimes(1)
    expect(api.maxInFlight).toBe(DEFAULT_LIMITS.requests)
    // A single-part upload completes when its part arrives.
    expect(transport.complete).not.toHaveBeenCalled()
  })

  it('streams one larger file at a time while small files fill the other slots', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    try {
      await engine.enqueue('folder', [
        file('first.bin', 3 * CHUNK),
        file('second.bin', 3 * CHUNK),
        ...Array.from({ length: 10 }, (_, index) => file(`note-${String(index)}.txt`, 2)),
      ])
      await vi.waitFor(() => {
        expect(api.streams).toHaveLength(1)
        expect(api.pending).toHaveLength(DEFAULT_LIMITS.requests - 1)
      })
      expect(item('second.bin').status).toBe('queued')
    } finally {
      engine.cancelAll()
    }
  })

  it('works through a long file in work proportional to its part count', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    const parts = 1000
    const membership = vi.spyOn(Set.prototype, 'has')
    try {
      await engine.enqueue('folder', [file('long.bin', parts * CHUNK)])
      await vi.waitFor(
        () => {
          expect(item('long.bin').status).toBe('done')
        },
        { timeout: 5000 },
      )
      expect(api.streamed).toHaveLength(1)
      expect(vi.mocked(transport.complete).mock.calls[0]?.[1]).toHaveLength(parts)
      // Repeatedly scanning received parts makes this grow quadratically.
      const checks = membership.mock.calls.filter(([value]) => typeof value === 'number').length
      expect(checks).toBeLessThan(parts * 20)
    } finally {
      membership.mockRestore()
    }
  })

  it('keeps one session when paused and resumed while its batch is being created', async () => {
    const { transport } = fakeApi()
    const batch = Promise.withResolvers<Awaited<ReturnType<UploadTransport['createSessions']>>>()
    const createSessions = vi.fn<UploadTransport['createSessions']>(() => batch.promise)
    const engine = new UploadEngine({ ...transport, createSessions })
    await engine.enqueue('folder', [file('resumed.txt', 2)])
    const [upload] = useUploadStore.getState().items
    if (!upload) throw new Error('No upload queued.')

    engine.pause(upload.id)
    engine.resume(upload.id)
    batch.resolve(await transport.createSessions(createSessions.mock.calls[0]?.[0] ?? []))

    await vi.waitFor(() => {
      expect(item('resumed.txt').status).toBe('done')
    })
    expect(createSessions).toHaveBeenCalledTimes(1)
  })

  it('streams again when the server turns it away, as soon as Retry-After allows', async () => {
    const { api, transport } = fakeApi()
    api.failStream = (_uploadId, attempt) => (attempt <= 2 ? busy() : null)
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('flaky.bin', 3 * CHUNK)])

    await vi.waitFor(() => {
      expect(item('flaky.bin').status).toBe('done')
    })
    expect(api.streamed.map((sent) => sent.from)).toEqual([0, 0, 0])
  })

  it('gives up after repeated failures, cancelling its session at once; Retry starts afresh', async () => {
    const { api, transport } = fakeApi()
    let broken = true
    api.failStream = () => (broken ? busy() : null)
    const engine = new UploadEngine({
      ...transport,
      streamFile: (uploadId, from, body, signal, onProgress) => {
        // The first try stores two parts before it breaks; the rest store nothing.
        const sending = transport.streamFile(uploadId, from, body, signal, onProgress)
        if (api.streamed.length === 1) api.streams.at(-1)?.store(2)
        return sending
      },
    })
    await engine.enqueue('folder', [file('stuck.bin', 4 * CHUNK)])

    await vi.waitFor(
      () => {
        expect(item('stuck.bin').status).toBe('failed')
      },
      { timeout: 5000 },
    )
    // The first try, then six retries since the last that stored anything.
    expect(api.streamed.map((sent) => sent.from)).toEqual([0, 2, 2, 2, 2, 2, 2, 2])
    // Its half file goes from the server now, not when the page closes.
    const first = api.streamed[0]?.uploadId
    expect(transport.cancel).toHaveBeenCalledExactlyOnceWith(first)
    expect(item('stuck.bin')).toMatchObject({ nodeId: null, uploadedBytes: 0 })

    broken = false
    engine.retry(item('stuck.bin').id)
    await vi.waitFor(() => {
      expect(item('stuck.bin').status).toBe('done')
    })
    // A new session, sent from its start.
    expect(api.streamed.at(-1)?.from).toBe(0)
    expect(api.streamed.at(-1)?.uploadId).not.toBe(first)
  })

  it('retries a small file whose response was lost; the server accepts it again (§6.1)', async () => {
    const { api, transport } = fakeApi()
    api.failPart = (_uploadId, _index, attempt) => (attempt === 1 ? busy() : null)
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('note.txt', 3)])

    await vi.waitFor(() => {
      expect(item('note.txt').status).toBe('done')
    })
    expect(api.sent).toHaveLength(2)
  })

  it('fails an upload whose session expired', async () => {
    const { api, transport } = fakeApi()
    api.failPart = () => new ApiError(404, 'upload_not_found', 'Gone')
    api.failStream = () => new ApiError(404, 'upload_not_found', 'Gone')
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('late.txt', 3), file('late.bin', 3 * CHUNK)])

    await vi.waitFor(() => {
      expect(item('late.txt').status).toBe('failed')
      expect(item('late.bin').status).toBe('failed')
    })
  })

  it('cancelling deletes the upload on the server', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('oops.bin', 4 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1)
    })
    const { uploadId } = stream(api)

    engine.cancel(item('oops.bin').id)

    await vi.waitFor(() => {
      expect(item('oops.bin').status).toBe('canceled')
    })
    expect(transport.cancel).toHaveBeenCalledWith(uploadId)
    expect(api.streams).toHaveLength(0)
  })

  it('cancels every upload not complete when the page goes, in requests that outlive it', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('done.txt', 2)])
    await vi.waitFor(() => {
      expect(item('done.txt').status).toBe('done')
    })
    api.autoRelease = false
    await engine.enqueue('folder', [file('sending.bin', 4 * CHUNK), file('paused.bin', 4 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1)
    })
    engine.pause(item('paused.bin').id)
    const sessions = [...api.sessions.keys()]

    engine.cancelOnLeave()
    // The completed file stays; the one sending and the paused one, which has its session, go.
    expect(vi.mocked(transport.cancel).mock.calls).toEqual(
      sessions.slice(1).map((uploadId) => [uploadId, { keepalive: true }]),
    )
  })

  it('keeps files still syncing when the finished ones are cleared', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('stored.txt', 2), file('syncing.txt', 3)])
    await vi.waitFor(() => {
      expect(items().map((upload) => upload.status)).toEqual(['done', 'done'])
    })
    engine.markSyncStates(new Map([[item('stored.txt').nodeId ?? '', 'stored']]))
    engine.clearFinished()
    await vi.waitFor(() => {
      expect(items().map((upload) => upload.file.name)).toEqual(['syncing.txt'])
    })
  })

  it('says every minute that the page is open, while it holds an upload not complete', async () => {
    vi.useFakeTimers()
    try {
      const { api, transport } = fakeApi()
      api.autoRelease = false
      const engine = new UploadEngine(transport)
      await engine.enqueue('folder', [file('long.bin', 4 * CHUNK)])
      await vi.waitFor(() => {
        expect(api.streams).toHaveLength(1)
      })
      const { uploadId } = stream(api)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(transport.alive).toHaveBeenCalledExactlyOnceWith([uploadId])
      // Paused, it still holds its upload.
      engine.pause(item('long.bin').id)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(transport.alive).toHaveBeenCalledTimes(2)
      // Cancelled, there is nothing left to keep, and it stops.
      engine.cancel(item('long.bin').id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(transport.alive).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an upload paused for 5 hours, and says why', async () => {
    vi.useFakeTimers()
    try {
      const { api, transport } = fakeApi()
      api.autoRelease = false
      const engine = new UploadEngine(transport)
      await engine.enqueue('folder', [
        file('paused.bin', 4 * CHUNK),
        file('resumed.bin', 4 * CHUNK),
      ])
      await vi.waitFor(() => {
        expect(api.streams).toHaveLength(1)
      })
      const [pausedSession] = api.sessions.keys()
      engine.pause(item('paused.bin').id)
      engine.pause(item('resumed.bin').id)
      await vi.advanceTimersByTimeAsync(PAUSE_LIMIT_MS - 60_000)
      expect(item('paused.bin').pausedUntil).toBeGreaterThan(Date.now())
      engine.resume(item('resumed.bin').id)
      // Past the limit, and the panel's next update.
      await vi.advanceTimersByTimeAsync(61_000)

      expect(item('paused.bin')).toMatchObject({
        status: 'canceled',
        error: 'Canceled after 5 hours paused',
        pausedUntil: null,
      })
      expect(item('resumed.bin')).toMatchObject({ status: 'uploading', pausedUntil: null })
      expect(transport.cancel).toHaveBeenCalledExactlyOnceWith(pausedSession)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails only the uploads a batch rejected', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine({
      ...transport,
      createSessions: async (uploads) => {
        const results = await transport.createSessions(uploads)
        results[1] = { ok: false, error: { code: 'quota_exceeded', message: 'Not enough storage' } }
        return results
      },
    })
    await engine.enqueue('folder', [file('a.txt', 1), file('b.txt', 1), file('c.txt', 1)])

    await vi.waitFor(() => {
      expect(item('c.txt').status).toBe('done')
    })
    expect(item('a.txt').status).toBe('done')
    expect(item('b.txt')).toMatchObject({ status: 'failed', error: 'Not enough storage' })
  })

  it('ends the second phase with the sync state from live events, or a re-check', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('a.txt', 1), file('b.txt', 1)])
    await vi.waitFor(() => {
      expect(item('b.txt').status).toBe('done')
    })
    expect(item('a.txt').syncState).toBe('syncing')

    engine.markSyncStates(new Map([[item('a.txt').nodeId ?? '', 'stored']]))
    // After a reconnect, events may have been missed: the rest is asked for.
    vi.mocked(transport.nodes).mockImplementation((nodeIds) =>
      Promise.resolve(nodeIds.map((nodeId) => driveNode(nodeId, 'lost'))),
    )
    await engine.refreshSyncStates()

    await vi.waitFor(() => {
      expect(item('a.txt').syncState).toBe('stored')
      expect(item('b.txt').syncState).toBe('lost')
    })
    // Only the file still syncing is asked about.
    expect(transport.nodes).toHaveBeenCalledTimes(1)
    expect(transport.nodes).toHaveBeenCalledWith([item('b.txt').nodeId])
  })

  it('asks about 1,200 syncing files in three requests', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue(
      'folder',
      Array.from({ length: 1200 }, (_, index) => file(`many-${String(index)}.txt`, 1)),
    )
    await vi.waitFor(
      () => {
        expect(items().every((upload) => upload.status === 'done')).toBe(true)
      },
      { timeout: 10_000 },
    )
    vi.mocked(transport.nodes).mockImplementation((nodeIds) =>
      Promise.resolve(nodeIds.map((nodeId) => driveNode(nodeId, 'stored'))),
    )
    await engine.refreshSyncStates()
    expect(vi.mocked(transport.nodes).mock.calls.map(([ids]) => ids.length)).toEqual([
      500, 500, 200,
    ])
    await vi.waitFor(() => {
      expect(items().every((upload) => upload.syncState === 'stored')).toBe(true)
    })
  })

  it.each([1, 3])('keeps sync events received before a %i-part upload response', async (parts) => {
    const { api, transport } = fakeApi()
    vi.mocked(transport.nodes).mockImplementation((nodeIds) =>
      Promise.resolve(nodeIds.map((nodeId) => driveNode(nodeId, 'stored'))),
    )
    const stored = (uploadId: string) => {
      const session = api.sessions.get(uploadId)
      if (session) engine.markSyncStates(new Map([[session.nodeId, 'stored']]))
    }
    const engine = new UploadEngine({
      ...transport,
      putPart: async (uploadId, index, body, hash, signal) => {
        await transport.putPart(uploadId, index, body, hash, signal)
        stored(uploadId)
      },
      complete: async (uploadId, partSha256) => {
        await transport.complete(uploadId, partSha256)
        stored(uploadId)
      },
    })
    await engine.enqueue('folder', [file('quick.bin', parts * CHUNK)])

    await vi.waitFor(() => {
      expect(item('quick.bin')).toMatchObject({ status: 'done', syncState: 'stored' })
    })
    expect(transport.nodes).toHaveBeenCalledTimes(1)
  })

  it('checks the new version instead of accepting an early event for the old one', async () => {
    const { api, transport } = fakeApi()
    vi.mocked(transport.nodes).mockImplementation((nodeIds) =>
      Promise.resolve(nodeIds.map((nodeId) => driveNode(nodeId, 'syncing'))),
    )
    const engine = new UploadEngine({
      ...transport,
      putPart: async (uploadId, index, body, hash, signal) => {
        const session = api.sessions.get(uploadId)
        if (session) engine.markSyncStates(new Map([[session.nodeId, 'stored']]))
        await transport.putPart(uploadId, index, body, hash, signal)
      },
    })
    await engine.enqueue('folder', [file('new-version.bin', CHUNK)])
    await vi.waitFor(() => {
      expect(item('new-version.bin')).toMatchObject({ status: 'done', syncState: 'syncing' })
      expect(transport.nodes).toHaveBeenCalledTimes(1)
    })
  })

  it('checks an early sync event even if a refresh started before the upload completed', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine({
      ...transport,
      putPart: async (uploadId, index, body, hash, signal) => {
        await transport.putPart(uploadId, index, body, hash, signal)
        const session = api.sessions.get(uploadId)
        if (session) engine.markSyncStates(new Map([[session.nodeId, 'stored']]))
      },
    })
    await engine.enqueue('folder', [file('first.bin', CHUNK)])
    await vi.waitFor(() => {
      expect(item('first.bin').status).toBe('done')
    })
    const pending = Promise.withResolvers<DriveNode[]>()
    vi.mocked(transport.nodes)
      .mockClear()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation((nodeIds) =>
        Promise.resolve(nodeIds.map((nodeId) => driveNode(nodeId, 'stored'))),
      )
    const refreshing = engine.refreshSyncStates()
    await engine.enqueue('folder', [file('second.bin', CHUNK)])
    await vi.waitFor(() => {
      expect(item('second.bin').status).toBe('done')
    })
    expect(transport.nodes).toHaveBeenCalledTimes(1)
    pending.resolve([driveNode(item('first.bin').nodeId ?? '', 'stored')])
    await refreshing
    await vi.waitFor(() => {
      expect(item('second.bin').syncState).toBe('stored')
    })
    expect(transport.nodes).toHaveBeenCalledTimes(2)
  })

  it('resyncs every uploaded file in one lookup, shared by concurrent refreshes', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine(transport)
    const count = 205
    await engine.enqueue(
      'folder',
      Array.from({ length: count }, (_, index) => file(`sync-${String(index)}.txt`, 1)),
    )
    await vi.waitFor(() => {
      expect(items().every((upload) => upload.status === 'done')).toBe(true)
    })

    const gate = Promise.withResolvers<undefined>()
    let requests = 0
    let maximum = 0
    vi.mocked(transport.nodes).mockImplementation(async (nodeIds) => {
      requests += 1
      maximum = Math.max(maximum, requests)
      await gate.promise
      requests -= 1
      return nodeIds.map((nodeId) => driveNode(nodeId, 'stored'))
    })
    const first = engine.refreshSyncStates()
    const concurrent = engine.refreshSyncStates()
    gate.resolve(undefined)
    await Promise.all([first, concurrent])

    // One lookup covers them all, and the concurrent refresh shares it.
    expect(maximum).toBe(1)
    expect(transport.nodes).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(items().every((upload) => upload.syncState === 'stored')).toBe(true)
    })
  })

  it('keeps newer live sync states when a resync request returns a stale answer', async () => {
    const { transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('synced.txt', 1)])
    await vi.waitFor(() => {
      expect(item('synced.txt').status).toBe('done')
    })
    const pending = Promise.withResolvers<DriveNode[]>()
    vi.mocked(transport.nodes).mockReturnValueOnce(pending.promise)
    const refreshing = engine.refreshSyncStates()
    const nodeId = item('synced.txt').nodeId ?? ''
    engine.markSyncStates(new Map([[nodeId, 'stored']]))
    pending.resolve([driveNode(nodeId, 'syncing')])
    await refreshing

    await vi.waitFor(() => {
      expect(item('synced.txt').syncState).toBe('stored')
    })
  })
})

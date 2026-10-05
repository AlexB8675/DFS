import type { DriveNode, SyncState, UploadSession } from '@dfs/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/client'
import { DEFAULT_LIMITS, UploadEngine } from './upload-engine'
import { useUploadStore } from './upload-store'
import type { UploadTransport } from './upload-transport'

/** Tiny parts, so a few bytes make a multi-part file. */
const CHUNK = 4

interface Put {
  uploadId: string
  index: number
  release: () => void
  fail: (error: Error) => void
}

/**
 * An in-memory upload API. Each part PUT waits until the test releases it
 * (or `autoRelease` is on), so tests can look at what is in flight.
 */
function fakeApi() {
  const sessions = new Map<string, UploadSession & { parts: Set<number> }>()
  const pending: Put[] = []
  const sent: { uploadId: string; index: number }[] = []
  let inFlight = 0
  const api = {
    autoRelease: true,
    maxInFlight: 0,
    /** Decides how a PUT ends; return an error to fail it. */
    failPart: (_uploadId: string, _index: number, _attempt: number): Error | null => null,
    sessions,
    pending,
    sent,
    attempts: new Map<string, number>(),
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
      const key = `${uploadId}:${index}`
      const attempt = (api.attempts.get(key) ?? 0) + 1
      api.attempts.set(key, attempt)
      sent.push({ uploadId, index })
      inFlight += 1
      api.maxInFlight = Math.max(api.maxInFlight, inFlight)
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (error: Error | null) => {
          if (settled) return
          settled = true
          inFlight -= 1
          pending.splice(pending.indexOf(put), 1)
          if (error) {
            reject(error)
            return
          }
          sessions.get(uploadId)?.parts.add(index)
          resolve()
        }
        const put: Put = {
          uploadId,
          index,
          release: () => {
            settle(api.failPart(uploadId, index, attempt))
          },
          fail: settle,
        }
        pending.push(put)
        signal.addEventListener('abort', () => {
          settle(new DOMException('Aborted', 'AbortError'))
        })
        if (api.autoRelease) setTimeout(put.release, 1)
      })
    },
    complete: vi.fn<UploadTransport['complete']>(() => Promise.resolve()),
    status: (uploadId) => {
      const session = sessions.get(uploadId)
      if (!session) return Promise.reject(new ApiError(404, 'upload_not_found', 'Gone'))
      const { parts, ...rest } = session
      const state = parts.size === rest.chunkCount ? 'completed' : 'receiving'
      return Promise.resolve({ ...rest, state, receivedParts: [...parts] })
    },
    cancel: vi.fn<UploadTransport['cancel']>(() => Promise.resolve()),
    node: vi.fn<UploadTransport['node']>(() => Promise.resolve(null)),
  }
  return { api, transport }
}

function file(name: string, size: number) {
  return { file: new File([new Uint8Array(size)], name), relativeDir: '' }
}

function item(name: string) {
  const found = items().find((candidate) => candidate.file.name === name)
  if (!found) throw new Error(`No upload named ${name}`)
  return found
}

function items() {
  return useUploadStore.getState().items.map((entry) => entry.store.getState())
}

const busy = () => new ApiError(503, 'staging_full', 'Staging is full', 0)

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

  it('prepares ahead while a request waits, with a bounded number of buffered parts', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const picked = file('ahead.bin', 12 * CHUNK)
    const slices = vi.spyOn(picked.file, 'slice')
    const engine = new UploadEngine(transport, { ...DEFAULT_LIMITS, requests: 1, partsPerFile: 1 })
    try {
      await engine.enqueue('folder', [picked])
      await vi.waitFor(() => {
        expect(api.pending).toHaveLength(1)
        expect(slices).toHaveBeenCalledTimes(2)
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      expect(slices).toHaveBeenCalledTimes(2)
      const [first] = api.pending
      if (!first) throw new Error('No part sending.')
      first.release()
      await vi.waitFor(() => {
        expect(api.sent.map((part) => part.index)).toEqual([0, 1])
        expect(slices).toHaveBeenCalledTimes(3)
      })
      expect(api.maxInFlight).toBe(1)
    } finally {
      engine.cancelAll()
      slices.mockRestore()
    }
  })

  it('bounds memory across tiny files as well as large parts', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const picked = Array.from({ length: 30 }, (_, index) => file(`bounded-${index}`, CHUNK))
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
    const picked = Array.from({ length: 30 }, (_, index) => file(`tiny-${index}`, 1))
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
      await engine.retry(item('read-error.bin').id)
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
      await engine.enqueue('folder', [file('hash-pause.bin', 3 * CHUNK)])
      await hashing.promise
      const upload = item('hash-pause.bin')
      engine.pause(upload.id)
      engine.resume(upload.id)
      release.resolve(undefined)
      await vi.waitFor(() => {
        expect(item('hash-pause.bin').status).toBe('done')
      })
      expect(api.sent.map((part) => part.index)).toEqual([0, 1, 2])
      expect(item('hash-pause.bin').uploadedBytes).toBe(3 * CHUNK)
    } finally {
      release.resolve(undefined)
      engine.cancelAll()
      spy.mockRestore()
    }
  })

  it('does not count a late response again after retry reconciled its receipt', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const completed = Promise.withResolvers<undefined>()
    const putPart: UploadTransport['putPart'] = (uploadId, index, bytes, hash, signal) => {
      if (index === 0) {
        // The server accepted this part, but the response ignores cancellation.
        api.sessions.get(uploadId)?.parts.add(index)
        return transport.putPart(uploadId, index, bytes, hash, new AbortController().signal)
      }
      return transport.putPart(uploadId, index, bytes, hash, signal)
    }
    const complete = vi.fn(() => completed.promise)
    const engine = new UploadEngine(
      { ...transport, putPart, complete },
      { ...DEFAULT_LIMITS, requests: 2, partsPerFile: 2 },
    )
    try {
      await engine.enqueue('folder', [file('late.bin', 2 * CHUNK)])
      await vi.waitFor(() => {
        expect(api.pending).toHaveLength(2)
      })
      const late = api.pending.find((part) => part.index === 0)
      if (!late) throw new Error('Missing late response.')
      api.pending
        .find((part) => part.index === 1)
        ?.fail(new ApiError(400, 'test_failure', 'Try again.'))
      await vi.waitFor(() => {
        expect(item('late.bin').status).toBe('failed')
      })
      api.autoRelease = true
      await engine.retry(item('late.bin').id)
      await vi.waitFor(() => {
        expect(api.sent).toHaveLength(3)
      })
      late.release()
      await vi.waitFor(() => {
        expect(complete).toHaveBeenCalledOnce()
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 150)
      })
      expect(item('late.bin').uploadedBytes).toBe(2 * CHUNK)
      completed.resolve(undefined)
      await vi.waitFor(() => {
        expect(item('late.bin').status).toBe('done')
      })
    } finally {
      completed.resolve(undefined)
      engine.cancelAll()
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
      ...file(`photo-${index}.jpg`, 2),
      relativeDir: `photos-${index}`,
    }))

    await expect(engine.enqueue('folder', files)).rejects.toThrow('photos-500')

    expect(ensureFolders).toHaveBeenCalledTimes(2)
    expect(transport.createSessions).not.toHaveBeenCalled()
    expect(useUploadStore.getState().items).toEqual([])
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

  it('sends a large file’s parts in parallel, at most 4 at a time, then completes it', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('big.bin', 10 * CHUNK)])

    await vi.waitFor(() => {
      expect(item('big.bin').status).toBe('done')
    })
    expect(api.maxInFlight).toBe(DEFAULT_LIMITS.partsPerFile)
    expect(transport.complete).toHaveBeenCalledTimes(1)
    expect(item('big.bin').uploadedBytes).toBe(10 * CHUNK)
  })

  it('creates sessions in batches and sends small files 8 at a time, with no complete call', async () => {
    const { api, transport } = fakeApi()
    const engine = new UploadEngine(transport)
    await engine.enqueue(
      'folder',
      Array.from({ length: 20 }, (_, index) => file(`small-${index}.txt`, 2)),
    )

    await vi.waitFor(() => {
      expect(items().every((upload) => upload.status === 'done')).toBe(true)
    })
    expect(transport.createSessions).toHaveBeenCalledTimes(1)
    expect(api.maxInFlight).toBe(DEFAULT_LIMITS.requests)
    // A single-part upload completes when its part arrives.
    expect(transport.complete).not.toHaveBeenCalled()
  })

  it('schedules a long upload with work proportional to its part count', async () => {
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
      expect(api.sent).toHaveLength(parts)
      expect(new Set(api.sent.map((part) => part.index)).size).toBe(parts)
      // Repeatedly scanning completed parts makes this grow quadratically.
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

  it('retries a part the server turned away, as soon as Retry-After allows', async () => {
    const { api, transport } = fakeApi()
    api.failPart = (_uploadId, index, attempt) => (index === 1 && attempt <= 2 ? busy() : null)
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('flaky.bin', 3 * CHUNK)])

    await vi.waitFor(() => {
      expect(item('flaky.bin').status).toBe('done')
    })
    expect(api.sent.filter((put) => put.index === 1)).toHaveLength(3)
  })

  it('retries an early part that fails after all later parts have finished', async () => {
    const { api, transport } = fakeApi()
    const firstPart = Promise.withResolvers<undefined>()
    const sent: number[] = []
    let held = false
    const engine = new UploadEngine({
      ...transport,
      putPart: (uploadId, index, body, hash, signal) => {
        sent.push(index)
        if (index === 0 && !held) {
          held = true
          return firstPart.promise
        }
        return transport.putPart(uploadId, index, body, hash, signal)
      },
    })
    await engine.enqueue('folder', [file('out-of-order.bin', 10 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.sent).toHaveLength(9)
      expect(api.pending).toHaveLength(0)
    })
    firstPart.reject(busy())
    await vi.waitFor(() => {
      expect(item('out-of-order.bin').status).toBe('done')
    })
    expect(sent.toSorted((a, b) => a - b)).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(sent.at(-1)).toBe(0)
    expect(item('out-of-order.bin').uploadedBytes).toBe(10 * CHUNK)
  })

  it('gives up after repeated failures, then resumes with only the missing parts', async () => {
    const { api, transport } = fakeApi()
    let broken = true
    api.failPart = (_uploadId, index) => (broken && index === 2 ? busy() : null)
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('stuck.bin', 4 * CHUNK)])

    await vi.waitFor(() => {
      expect(item('stuck.bin').status).toBe('failed')
    })
    // The first try, then six retries.
    expect(api.sent.filter((put) => put.index === 2)).toHaveLength(7)

    broken = false
    const before = api.sent.length
    await engine.retry(item('stuck.bin').id)
    await vi.waitFor(() => {
      expect(item('stuck.bin').status).toBe('done')
    })
    expect(api.sent.slice(before).map((put) => put.index)).toEqual([2])
  })

  it('retries a part whose response was lost; the server accepts it again (§6.1)', async () => {
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
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('late.txt', 3)])

    await vi.waitFor(() => {
      expect(item('late.txt').status).toBe('failed')
    })
  })

  it('pauses without losing finished parts, and resumes from there', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('movie.mkv', 8 * CHUNK)])

    await vi.waitFor(() => {
      expect(api.pending).toHaveLength(4)
    })
    const finished = api.pending.slice(0, 2).map((put) => put.index)
    for (const put of api.pending.slice(0, 2)) put.release()
    engine.pause(item('movie.mkv').id)

    await vi.waitFor(() => {
      expect(item('movie.mkv')).toMatchObject({ status: 'paused', uploadedBytes: 2 * CHUNK })
    })
    expect(api.pending).toHaveLength(0)

    api.autoRelease = true
    const before = api.sent.length
    engine.resume(item('movie.mkv').id)
    await vi.waitFor(() => {
      expect(item('movie.mkv').status).toBe('done')
    })
    const resent = api.sent.slice(before).map((put) => put.index)
    expect(resent).toHaveLength(6)
    expect(resent).not.toContain(finished[0])
    expect(resent).not.toContain(finished[1])
  })

  it('cancelling deletes the upload on the server', async () => {
    const { api, transport } = fakeApi()
    api.autoRelease = false
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('oops.bin', 4 * CHUNK)])
    await vi.waitFor(() => {
      expect(api.pending.length).toBeGreaterThan(0)
    })
    const [put] = api.pending

    engine.cancel(item('oops.bin').id)

    await vi.waitFor(() => {
      expect(item('oops.bin').status).toBe('canceled')
    })
    expect(transport.cancel).toHaveBeenCalledWith(put?.uploadId)
    expect(api.pending).toHaveLength(0)
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
    vi.mocked(transport.node).mockImplementation((nodeId) =>
      Promise.resolve(driveNode(nodeId, 'lost')),
    )
    await engine.refreshSyncStates()

    await vi.waitFor(() => {
      expect(item('a.txt').syncState).toBe('stored')
      expect(item('b.txt').syncState).toBe('lost')
    })
    expect(transport.node).toHaveBeenCalledTimes(1)
  })

  it.each([1, 3])('keeps sync events received before a %i-part upload response', async (parts) => {
    const { api, transport } = fakeApi()
    vi.mocked(transport.node).mockImplementation((nodeId) =>
      Promise.resolve(driveNode(nodeId, 'stored')),
    )
    const stored = (uploadId: string) => {
      const session = api.sessions.get(uploadId)
      if (session) engine.markSyncStates(new Map([[session.nodeId, 'stored']]))
    }
    const engine = new UploadEngine({
      ...transport,
      putPart: async (uploadId, index, body, hash, signal) => {
        await transport.putPart(uploadId, index, body, hash, signal)
        if (parts === 1) stored(uploadId)
      },
      complete: async (uploadId) => {
        await transport.complete(uploadId)
        stored(uploadId)
      },
    })
    await engine.enqueue('folder', [file('quick.bin', parts * CHUNK)])

    await vi.waitFor(() => {
      expect(item('quick.bin')).toMatchObject({ status: 'done', syncState: 'stored' })
    })
    expect(transport.node).toHaveBeenCalledTimes(1)
  })

  it('checks the new version instead of accepting an early event for the old one', async () => {
    const { api, transport } = fakeApi()
    vi.mocked(transport.node).mockImplementation((nodeId) =>
      Promise.resolve(driveNode(nodeId, 'syncing')),
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
      expect(transport.node).toHaveBeenCalledTimes(1)
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
    const pending = Promise.withResolvers<DriveNode | null>()
    vi.mocked(transport.node)
      .mockClear()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation((nodeId) => Promise.resolve(driveNode(nodeId, 'stored')))
    const refreshing = engine.refreshSyncStates()
    await engine.enqueue('folder', [file('second.bin', CHUNK)])
    await vi.waitFor(() => {
      expect(item('second.bin').status).toBe('done')
    })
    expect(transport.node).toHaveBeenCalledTimes(1)
    pending.resolve(driveNode(item('first.bin').nodeId ?? '', 'stored'))
    await refreshing
    await vi.waitFor(() => {
      expect(item('second.bin').syncState).toBe('stored')
    })
    expect(transport.node).toHaveBeenCalledTimes(2)
  })

  it('waits for retry receipts when paused and resumed while checking the session', async () => {
    const { api, transport } = fakeApi()
    api.failPart = (_uploadId, index) =>
      index === 1 ? new ApiError(400, 'rejected', 'Part rejected') : null
    const receipt = Promise.withResolvers<Awaited<ReturnType<UploadTransport['status']>>>()
    const status = vi.fn<UploadTransport['status']>(() => receipt.promise)
    const engine = new UploadEngine({ ...transport, status })
    await engine.enqueue('folder', [file('retry.bin', 3 * CHUNK)])
    await vi.waitFor(() => {
      expect(item('retry.bin').status).toBe('failed')
    })
    const upload = item('retry.bin')
    const uploadId = api.sent[0]?.uploadId ?? ''
    const snapshot = await transport.status(uploadId)
    const before = api.sent.length
    api.failPart = () => null
    const retrying = engine.retry(upload.id)
    engine.pause(upload.id)
    engine.resume(upload.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.sent).toHaveLength(before)

    receipt.resolve(snapshot)
    await retrying
    await vi.waitFor(() => {
      expect(item('retry.bin')).toMatchObject({ status: 'done', uploadedBytes: 3 * CHUNK })
    })
    const missing = Array.from({ length: 3 }, (_, index) => index).filter(
      (index) => !snapshot.receivedParts.includes(index),
    )
    // Independent parts may finish preparation in any order.
    expect(
      api.sent
        .slice(before)
        .map((put) => put.index)
        .sort((left, right) => left - right),
    ).toEqual(missing)
    expect(transport.complete).toHaveBeenCalledTimes(1)
  })

  it('resyncs every uploaded file with bounded requests and shares concurrent refreshes', async () => {
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
    vi.mocked(transport.node).mockImplementation(async (nodeId) => {
      requests += 1
      maximum = Math.max(maximum, requests)
      await gate.promise
      requests -= 1
      return driveNode(nodeId, 'stored')
    })
    const first = engine.refreshSyncStates()
    const concurrent = engine.refreshSyncStates()
    gate.resolve(undefined)
    await Promise.all([first, concurrent])

    expect(maximum).toBeLessThanOrEqual(DEFAULT_LIMITS.requests)
    expect(transport.node).toHaveBeenCalledTimes(count)
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
    const pending = Promise.withResolvers<DriveNode | null>()
    vi.mocked(transport.node).mockReturnValueOnce(pending.promise)
    const refreshing = engine.refreshSyncStates()
    const nodeId = item('synced.txt').nodeId ?? ''
    engine.markSyncStates(new Map([[nodeId, 'stored']]))
    pending.resolve(driveNode(nodeId, 'syncing'))
    await refreshing

    await vi.waitFor(() => {
      expect(item('synced.txt').syncState).toBe('stored')
    })
  })
})

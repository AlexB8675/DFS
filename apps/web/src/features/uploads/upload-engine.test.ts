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
        const settle = (error: Error | null) => {
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
      return Promise.resolve({ ...rest, receivedParts: [...parts] })
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
  const found = useUploadStore.getState().items.find((candidate) => candidate.file.name === name)
  if (!found) throw new Error(`No upload named ${name}`)
  return found
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
    useUploadStore.setState({ items: [], bytesPerSecond: 0 })
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
      expect(useUploadStore.getState().items.every((upload) => upload.status === 'done')).toBe(true)
    })
    expect(transport.createSessions).toHaveBeenCalledTimes(1)
    expect(api.maxInFlight).toBe(DEFAULT_LIMITS.requests)
    // A single-part upload completes when its part arrives.
    expect(transport.complete).not.toHaveBeenCalled()
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

  it('counts a single-part upload as done when a retry finds it already completed', async () => {
    const { api, transport } = fakeApi()
    // The first response is lost; the retry finds the session gone because the part completed it.
    api.failPart = (_uploadId, _index, attempt) =>
      attempt === 1 ? busy() : new ApiError(404, 'upload_not_found', 'Gone')
    vi.mocked(transport.node).mockImplementation((nodeId) =>
      Promise.resolve(driveNode(nodeId, 'syncing')),
    )
    const engine = new UploadEngine(transport)
    await engine.enqueue('folder', [file('note.txt', 3)])

    await vi.waitFor(() => {
      expect(item('note.txt').status).toBe('done')
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
})

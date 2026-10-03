import { beforeEach, describe, expect, it, vi } from 'vitest'

// The mock database expects a browser: give it storage, timers and a location
// before it loads. Fake timers drive the simulated Discord sync.
vi.hoisted(() => {
  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    window: globalThis,
    location: { origin: 'http://localhost' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  vi.useFakeTimers()
})

const { db, MockApiError } = await import('./db')

// These tests double as a spec for the real API: they encode the rules of
// DESIGN.md §5–§6 that the mock imitates.

const rootId = () => db.session().user.rootFolderId

function list(parentId: string, limit = 500) {
  return db.children(parentId, { sort: 'name', order: 'asc', limit }).items
}

function child(parentId: string, name: string) {
  const node = list(parentId).find((candidate) => candidate.name === name)
  if (!node) throw new Error(`No “${name}” in ${parentId}`)
  return node
}

/** Runs `action` and returns the API error it throws. */
function apiError(action: () => unknown) {
  try {
    action()
  } catch (error) {
    if (error instanceof MockApiError) return { status: error.status, code: error.code }
    throw error
  }
  throw new Error('Expected an API error')
}

async function sha256Hex(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('mock API database', () => {
  beforeEach(() => {
    db.reset()
  })

  it('lists folders before files', () => {
    const kinds = list(rootId()).map((node) => node.kind)
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('folder'))
  })

  it('pages through a large folder without gaps or repeats (keyset pagination)', () => {
    const cameraRoll = child(rootId(), 'Camera Roll')
    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    do {
      const page = db.children(cameraRoll.id, { sort: 'name', order: 'asc', cursor, limit: 200 })
      for (const node of page.items) seen.add(node.id)
      cursor = page.nextCursor
      pages += 1
    } while (cursor)

    expect(seen.size).toBe(6000)
    expect(pages).toBe(30)
  })

  it('rejects a name that is taken, ignoring case', () => {
    expect(apiError(() => db.createFolder(rootId(), 'photos'))).toEqual({
      status: 409,
      code: 'name_conflict',
    })
  })

  it('rejects invalid names', () => {
    expect(apiError(() => db.createFolder(rootId(), 'a/b'))).toEqual({
      status: 400,
      code: 'invalid_name',
    })
  })

  it('refuses to move a folder into its own subtree', () => {
    const photos = child(rootId(), 'Photos')
    const year = child(photos.id, '2024')
    expect(
      apiError(() => {
        db.move([photos.id], year.id)
      }),
    ).toEqual({
      status: 400,
      code: 'invalid_move',
    })
  })

  it('hides a trashed folder’s subtree and restores it under a free name', () => {
    const photos = child(rootId(), 'Photos')
    db.trash([photos.id])

    expect(list(rootId()).some((node) => node.name === 'Photos')).toBe(false)
    expect(db.search('Tram ride', null, 50).items).toHaveLength(0)
    expect(db.trashItems(null, 50).items.map((item) => item.name)).toContain('Photos')

    // The name is free again while the original sits in the trash…
    db.createFolder(rootId(), 'Photos')
    // …so restoring it picks the next free name.
    expect(db.restore(photos.id).name).toBe('Photos (1)')
    expect(db.search('Tram ride', null, 50).items).toHaveLength(1)
  })

  it('deletes a trashed item forever, along with its share links', () => {
    const videos = child(rootId(), 'Videos')
    db.trash([videos.id])
    db.deleteForever(videos.id)

    expect(db.trashItems(null, 50).items.map((item) => item.name)).not.toContain('Videos')
    expect(db.shares().items.map((share) => share.nodeName)).not.toContain('Wedding highlights.mp4')
  })

  it('rejects a corrupted part, then completes and syncs a single-part upload', async () => {
    const bytes = new TextEncoder().encode('hello').buffer
    const upload = db.createUpload(rootId(), 'hello.txt', bytes.byteLength, 'text/plain')
    expect(upload.chunkCount).toBe(1)

    await expect(db.receivePart(upload.uploadId, 0, bytes, 'deadbeef')).rejects.toMatchObject({
      code: 'hash_mismatch',
    })

    await db.receivePart(upload.uploadId, 0, bytes, await sha256Hex(bytes))
    expect(db.node(upload.nodeId).syncState).toBe('syncing')

    vi.advanceTimersByTime(10_000)
    expect(db.node(upload.nodeId).syncState).toBe('stored')
  })
})

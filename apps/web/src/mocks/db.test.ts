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

const { MockApiError } = await import('./db')
const { AdminMockDb } = await import('./admin-db')
const db = new AdminMockDb()

// These tests double as a spec for the real API: they encode the rules of
// DESIGN.md §5–§6 that the mock imitates.

const DAY = 24 * 60 * 60_000

const rootId = () => db.session().user.rootFolderId

function signInAs(username: string, password: string) {
  db.signOut()
  return db.signIn({ username, password })
}

function userNamed(username: string) {
  const user = db.adminUsers().items.find((candidate) => candidate.username === username)
  if (!user) throw new Error(`No user ${username}`)
  return user
}

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

/** The entry names in a ZIP, read from its central directory. */
function zipNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.byteLength - 22
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50)
    expect(view.getUint16(offset + 8, true) & 0x0800).toBe(0x0800) // UTF-8 names
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    names.push(new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength)))
    offset += 46 + nameLength + extraLength
  }
  return names
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

  it('creates upload sessions in a batch, failing only the uploads that don’t fit', () => {
    const results = db.createUploads([
      { parentId: rootId(), name: 'small.txt', sizeBytes: 10, mimeType: 'text/plain' },
      { parentId: rootId(), name: 'huge.bin', sizeBytes: 10 * 1024 ** 4, mimeType: 'x/y' },
      { parentId: rootId(), name: 'bad/name', sizeBytes: 10, mimeType: 'text/plain' },
    ])
    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual([
      'ok',
      'quota_exceeded',
      'invalid_name',
    ])
  })

  it('reports the parts it has, so an upload can resume', async () => {
    const upload = db.createUpload(rootId(), 'movie.mkv', 25 * 1024 * 1024, 'video/x-matroska')
    expect(upload.chunkCount).toBe(3)
    const part = new Uint8Array(upload.chunkSize).buffer
    await db.receivePart(upload.uploadId, 2, part, null)
    await db.receivePart(upload.uploadId, 0, part, null)

    expect(db.uploadStatus(upload.uploadId).receivedParts).toEqual([0, 2])
    expect(
      apiError(() => {
        db.completeUpload(upload.uploadId)
      }),
    ).toEqual({
      status: 409,
      code: 'incomplete_upload',
    })
  })

  it('makes a new version when an upload’s name matches a file (D20)', async () => {
    const text = (value: string) => new TextEncoder().encode(value).buffer
    const usedBefore = db.session().user.usedBytes
    const first = db.createUpload(rootId(), 'Notes.txt', 5, 'text/plain')
    await db.receivePart(first.uploadId, 0, text('first'), null)

    const second = db.createUpload(rootId(), 'notes.TXT', 11, 'text/plain')
    expect(second).toMatchObject({ nodeId: first.nodeId, isNewVersion: true })
    expect(second.versionId).not.toBe(first.versionId)
    // Readers get the old version until the new one completes.
    expect(db.node(first.nodeId)).toMatchObject({ name: 'Notes.txt', sizeBytes: 5 })

    await db.receivePart(second.uploadId, 0, text('second take'), null)
    expect(db.node(first.nodeId)).toMatchObject({ name: 'Notes.txt', sizeBytes: 11 })
    // No share link serves the previous version, so it went, with its quota (D20, D24).
    expect(db.session().user.usedBytes - usedBefore).toBe(11)
    expect(list(rootId()).filter((node) => node.name === 'Notes.txt')).toHaveLength(1)
  })

  it('refuses an upload named like a folder', () => {
    db.createFolder(rootId(), 'Taken')
    expect(apiError(() => db.createUpload(rootId(), 'taken', 1, 'text/plain'))).toEqual({
      status: 409,
      code: 'name_conflict',
    })
  })

  it('keeps answering for a completed upload, and accepts a part sent again', async () => {
    const bytes = new TextEncoder().encode('once').buffer
    const hash = await sha256Hex(bytes)
    const upload = db.createUpload(rootId(), 'once.txt', bytes.byteLength, 'text/plain')
    await db.receivePart(upload.uploadId, 0, bytes, hash)

    expect(db.uploadStatus(upload.uploadId)).toMatchObject({
      state: 'completed',
      receivedParts: [0],
    })
    // The response was lost and the client sends the part again.
    await db.receivePart(upload.uploadId, 0, bytes, hash)
    db.completeUpload(upload.uploadId)
    expect(db.node(upload.nodeId).syncState).toBe('syncing')
  })

  it('zips a folder with its subfolders, empty ones included', async () => {
    const folder = db.createFolder(rootId(), 'Zip test')
    db.createFolder(folder.id, 'Empty')
    const bytes = new TextEncoder().encode('hi').buffer
    const upload = db.createUpload(folder.id, 'Grüße.txt', bytes.byteLength, 'text/plain')
    await db.receivePart(upload.uploadId, 0, bytes, null)

    const archive = db.folderArchive(folder.id)
    expect(archive.name).toBe('Zip test.zip')
    expect(zipNames(archive.body)).toEqual(['Zip test/', 'Zip test/Empty/', 'Zip test/Grüße.txt'])
  })

  it('serves an archive link once', () => {
    const ids = list(child(rootId(), 'Documents').id).map((node) => node.id)
    const token = db.createArchiveTicket(ids).url.split('/').at(-1) ?? ''

    expect(zipNames(db.takeArchive(token))).toContain('Taxes/')
    expect(apiError(() => db.takeArchive(token))).toEqual({ status: 404, code: 'archive_expired' })
  })

  it('keeps users apart, while admins see everyone’s metadata', () => {
    const sam = db.adminUsers().items.find((user) => user.displayName === 'Sam Rivera')
    if (!sam) throw new Error('Sam is missing from the seed')

    expect(
      apiError(() => db.children(sam.rootFolderId, { sort: 'name', order: 'asc', limit: 10 })),
    ).toEqual({ status: 404, code: 'not_found' })
    expect(db.search('cracked', null, 10).items).toHaveLength(0)
    const names = db
      .adminChildren(sam.rootFolderId, { sort: 'name', order: 'asc', limit: 10 })
      .items.map((node) => node.name)
    expect(names).toEqual(['Games', 'Photos', 'Work'])
  })

  it('moderation moves an item to its owner’s trash, with the reason, and logs it', () => {
    const sam = db.adminUsers().items.find((user) => user.displayName === 'Sam Rivera')
    if (!sam) throw new Error('Sam is missing from the seed')
    const options = { sort: 'name', order: 'asc', limit: 50 } as const
    const games = db.adminChildren(sam.rootFolderId, options).items.find((n) => n.name === 'Games')
    const exe = db.adminChildren(games?.id ?? '', options).items.find((n) => n.kind === 'file')
    if (!exe) throw new Error('No file to moderate')

    db.moderate(exe.id, 'No executables.')

    expect(db.adminChildren(games?.id ?? '', options).items.map((n) => n.id)).not.toContain(exe.id)
    expect(db.auditLog({ limit: 1 }).items[0]).toMatchObject({
      action: 'node.moderated',
      details: 'No executables.',
    })
  })

  it('doesn’t let admins demote or disable themselves', () => {
    signInAs('priya', 'priya-password')
    const me = db.session().user
    expect(apiError(() => db.updateUser(me.id, { role: 'user' }))).toEqual({
      status: 409,
      code: 'self_change',
    })
  })

  describe('accounts and sign-in (§7.1)', () => {
    it('signs in with a username and password, and answers alike for a wrong one or an unknown user', () => {
      db.signOut()
      expect(db.signIn({ username: 'demo', password: 'demo-password' })).toMatchObject({
        user: { username: 'demo' },
        passwordChange: null,
      })
      const wrong = { status: 401, code: 'invalid_credentials' }
      expect(apiError(() => db.signIn({ username: 'demo', password: 'nope' }))).toEqual(wrong)
      expect(apiError(() => db.signIn({ username: 'nobody', password: 'nope' }))).toEqual(wrong)
    })

    it('tells of a disabled account or an expired password only after the right password', () => {
      const attempt = (username: string, password: string) =>
        apiError(() => db.signIn({ username, password }))
      expect(attempt('jordan', 'wrong')).toEqual({ status: 401, code: 'invalid_credentials' })
      expect(attempt('jordan', 'jordan-password')).toEqual({
        status: 403,
        code: 'account_disabled',
      })
      expect(attempt('morgan', 'wrong')).toEqual({ status: 401, code: 'invalid_credentials' })
      expect(attempt('morgan', 'welcome-morgan')).toEqual({
        status: 403,
        code: 'password_expired',
      })
    })

    it('limits a first sign-in to choosing a password, which activates the account', () => {
      expect(signInAs('taylor', 'welcome-taylor').passwordChange).toBe('activate')
      expect(db.mustChangePassword).toBe(true)

      const session = db.changePassword({ newPassword: 'taylor’s own password' })
      expect(session.passwordChange).toBeNull()
      expect(db.mustChangePassword).toBe(false)

      signInAs('demo', 'demo-password')
      expect(userNamed('taylor')).toMatchObject({ temporaryPasswordExpiresAt: null })
      expect(userNamed('taylor').activatedAt).not.toBeNull()
    })

    it('needs the current password to change it, and refuses weak choices', () => {
      const change = (currentPassword: string, newPassword: string) =>
        apiError(() => db.changePassword({ currentPassword, newPassword }))
      expect(change('wrong', 'a fine new password')).toEqual({
        status: 403,
        code: 'wrong_password',
      })
      const rejected = { status: 400, code: 'password_rejected' }
      expect(change('demo-password', 'demo-password')).toEqual(rejected)
      expect(change('demo-password', 'password1234')).toEqual(rejected)

      db.changePassword({ currentPassword: 'demo-password', newPassword: 'a fine new password' })
      db.signOut()
      expect(signInAs('demo', 'a fine new password').passwordChange).toBeNull()
    })

    it('creates users with a temporary password, keeping usernames unique', () => {
      const casey = db.createUser({ username: 'casey', temporaryPassword: 'casey-temporary' })
      expect(casey).toMatchObject({
        displayName: 'casey',
        role: 'user',
        isOwner: false,
        activatedAt: null,
      })
      expect(casey).not.toHaveProperty('password')
      expect(Date.parse(casey.temporaryPasswordExpiresAt ?? '') - Date.now()).toBe(7 * DAY)
      expect(
        apiError(() => db.createUser({ username: 'sam', temporaryPassword: 'whatever-password' })),
      ).toEqual({ status: 409, code: 'username_taken' })

      db.signOut()
      expect(signInAs('casey', 'casey-temporary').passwordChange).toBe('activate')
      expect(list(rootId())).toEqual([])
    })

    it('resets a password, signing in to a session that must choose a new one', () => {
      const sam = userNamed('sam')
      db.resetPassword(sam.id, { temporaryPassword: 'sam-new-temporary' })
      expect(userNamed('sam').temporaryPasswordExpiresAt).not.toBeNull()

      db.signOut()
      expect(apiError(() => db.signIn({ username: 'sam', password: 'sam-password' }))).toEqual({
        status: 401,
        code: 'invalid_credentials',
      })
      expect(signInAs('sam', 'sam-new-temporary').passwordChange).toBe('reset')
    })

    it('never changes the owner from the app, and admins don’t reset themselves', () => {
      const owner = userNamed('demo')
      expect(owner.isOwner).toBe(true)
      signInAs('priya', 'priya-password')
      const protectedOwner = { status: 409, code: 'owner_protected' }
      expect(
        apiError(() => db.resetPassword(owner.id, { temporaryPassword: 'take-over-password' })),
      ).toEqual(protectedOwner)
      expect(apiError(() => db.updateUser(owner.id, { role: 'user' }))).toEqual(protectedOwner)
      expect(apiError(() => db.updateUser(owner.id, { disabled: true }))).toEqual(protectedOwner)

      const priya = userNamed('priya')
      expect(
        apiError(() => db.resetPassword(priya.id, { temporaryPassword: 'priya-temporary' })),
      ).toEqual({ status: 409, code: 'self_change' })
    })
  })

  it('keeps at least one channel taking new blobs', () => {
    const enabled = db.channels().filter((channel) => channel.enabled)
    const last = enabled.pop()
    for (const channel of enabled) db.updateChannel(channel.id, false)
    expect(
      apiError(() => {
        db.updateChannel(last?.id ?? '', false)
      }),
    ).toEqual({
      status: 409,
      code: 'last_channel',
    })
  })

  describe('public share links', () => {
    it('reveals nothing behind a password until it is unlocked', () => {
      expect(db.publicShare('demo-lisbon')).toEqual({ locked: true })
      expect(apiError(() => db.shareChildren('demo-lisbon', null, null, 50))).toEqual({
        status: 403,
        code: 'share_locked',
      })
      expect(
        apiError(() => {
          db.unlockShare('demo-lisbon', 'wrong')
        }),
      ).toEqual({ status: 403, code: 'wrong_password' })

      db.unlockShare('demo-lisbon', 'lisbon')
      expect(db.publicShare('demo-lisbon')).toMatchObject({
        locked: false,
        root: { name: 'Summer trip – Lisbon', parentId: null },
        sharedBy: 'Demo User',
      })
    })

    it('turns away expired, revoked and unknown links', () => {
      const error = (token: string) => apiError(() => db.publicShare(token))
      expect(error('demo-expired')).toEqual({ status: 410, code: 'share_expired' })
      expect(error('demo-revoked')).toEqual({ status: 410, code: 'share_revoked' })
      expect(error('nope')).toEqual({ status: 404, code: 'share_not_found' })
    })

    it('browses only inside the shared folder', () => {
      const root = db.shareChildren('demo-documents', null, null, 50)
      const taxes = root.items.find((node) => node.name === 'Taxes')
      if (!taxes) throw new Error('No Taxes folder')
      expect(
        db.shareChildren('demo-documents', taxes.id, null, 50).path.map((e) => e.name),
      ).toEqual(['Documents', 'Taxes'])
      // My Drive is above the shared folder: out of reach.
      expect(apiError(() => db.shareChildren('demo-documents', rootId(), null, 50))).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('counts downloads from byte 0 only, and stops at the limit', () => {
      const resume = db.publicShare('demo-resume')
      if (resume.locked) throw new Error('Unexpectedly locked')
      expect(resume.downloadsLeft).toBe(6)

      db.shareFileContent('demo-resume', resume.root.id, false)
      expect(db.publicShare('demo-resume')).toMatchObject({ downloadsLeft: 6 })
      for (let i = 0; i < 6; i += 1) db.shareFileContent('demo-resume', resume.root.id, true)
      expect(apiError(() => db.publicShare('demo-resume'))).toEqual({
        status: 410,
        code: 'share_used_up',
      })
    })

    it('locks the link again when its password changes, and never lists tokens', () => {
      db.unlockShare('demo-lisbon', 'lisbon')
      const link = db.shares().items.find((share) => share.hasPassword && !share.revokedAt)
      if (!link) throw new Error('No password-protected link')
      db.updateShare(link.id, { password: 'new-secret' })

      expect(db.publicShare('demo-lisbon')).toEqual({ locked: true })
      expect(JSON.stringify(db.shares())).not.toContain('demo-lisbon')
    })
  })
})

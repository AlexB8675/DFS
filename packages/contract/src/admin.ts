import {
  adminSessionListSchema,
  adminShareOwnerListSchema,
  adminSharePageSchema,
  adminUploadListSchema,
  adminTaskListSchema,
  auditPageSchema,
  databaseStatusSchema,
  METRICS,
  metricSeriesSchema,
  moderationResultSchema,
  nodePageSchema,
  nodeSchema,
  shareCountSchema,
  storageChannelListSchema,
  storageChannelSchema,
  shareLinkPageSchema,
  shareLinkSchema,
  storageStatusSchema,
  systemInfoSchema,
  systemHealthSchema,
  trashPageSchema,
  userUsageSchema,
} from '@dfs/shared'
import { chosenPassword, type SuiteContext } from './context.ts'
import { startUpload, text, uploadFile } from './files.ts'

/** The admin area: usage, the metadata browser, moderation, channels, audit (DESIGN.md §9, D4). */
export function adminTests({
  describe,
  it,
  expect,
  owner,
  newUser,
  activated,
  signIn,
}: SuiteContext): void {
  /** A user who chose their password, with nothing in their drive yet. */
  async function newUserWithFolder() {
    const { user, username, temporaryPassword } = await newUser(await owner())
    await activated(username, temporaryPassword)
    return { user, username }
  }

  /** A user with a photo and a text file in their root. */
  async function userWithFiles() {
    const { user, username, temporaryPassword } = await newUser(await owner())
    const client = await activated(username, temporaryPassword)
    const photo = await uploadFile(client, user.rootFolderId, 'beach.jpg', text('jpeg bytes'))
    const notes = await uploadFile(client, user.rootFolderId, 'notes.txt', text('hi'))
    return { user, username, photo, notes }
  }

  describe('admin (§9, D4)', () => {
    it('shows a user’s usage by kind, and their files without the contents', async () => {
      const { user, photo } = await userWithFiles()
      const admin = await owner()
      const usage = await admin.call('GET', `/admin/users/${user.id}/usage`, userUsageSchema)
      expect(usage.fileCount).toBe(2)
      expect(usage.categories.map((entry) => entry.category).sort()).toEqual(['document', 'image'])

      const listing = await admin.call(
        'GET',
        `/admin/nodes/${user.rootFolderId}/children`,
        nodePageSchema,
      )
      expect(listing.items.map((node) => node.name)).toEqual(['beach.jpg', 'notes.txt'])
      // Metadata only: an admin can't download another user's file.
      expect(await admin.error('GET', `/files/${photo.nodeId}/content`)).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('moderates an item into its owner’s trash, with the reason', async () => {
      const { username, photo } = await userWithFiles()
      const admin = await owner()
      await admin.send('DELETE', `/admin/nodes/${photo.nodeId}`, {
        json: { reason: 'Not allowed here.' },
      })
      const user = await signIn(username, chosenPassword(username))
      const trash = await user.call('GET', '/trash', trashPageSchema)
      expect(trash.items.find((item) => item.id === photo.nodeId)?.moderationReason).toBe(
        'Not allowed here.',
      )
    })

    it('deletes the share links to an item it removes, and says how many', async () => {
      const { user, username } = await newUserWithFolder()
      const client = await signIn(username, chosenPassword(username))
      const folder = await client.call('POST', '/folders', nodeSchema, {
        json: { parentId: user.rootFolderId, name: 'Shared stuff' },
      })
      const inside = await uploadFile(client, folder.id, 'flyer.pdf', text('pdf'))
      const share = (nodeId: string) =>
        client.call('POST', '/shares', shareLinkSchema, {
          json: { nodeId, expiresAt: null, password: null, maxDownloads: null },
        })
      const folderLink = await share(folder.id)
      const fileLink = await share(inside.nodeId)
      const admin = await owner()

      const counted = await admin.call('GET', `/admin/nodes/${folder.id}/links`, shareCountSchema)
      expect(counted.links).toBe(2)
      const result = await admin.call(
        'DELETE',
        `/admin/nodes/${folder.id}`,
        moderationResultSchema,
        {
          json: { reason: 'Not allowed here.' },
        },
      )
      expect(result.deletedLinks).toBe(2)

      // Restoring it brings none back.
      const again = await signIn(username, chosenPassword(username))
      await again.send('POST', `/nodes/${folder.id}/restore`)
      const { items } = await again.call('GET', '/shares', shareLinkPageSchema)
      const ids = items.map((item) => item.id)
      expect(ids).not.toContain(folderLink.id)
      expect(ids).not.toContain(fileLink.id)
    })

    it('adds storage channels, refuses one twice, and keeps one taking blobs', async () => {
      const admin = await owner()
      const discordId = () => String(10n ** 17n + BigInt(Math.floor(Math.random() * 1e15)))
      const kept = await admin.call('POST', '/admin/channels', storageChannelSchema, {
        json: { discordChannelId: discordId(), name: 'storage-kept' },
      })
      expect(kept).toMatchObject({ name: 'storage-kept', enabled: true, blobCount: 0 })
      expect(
        await admin.error('POST', '/admin/channels', {
          json: { discordChannelId: kept.discordChannelId, name: 'again' },
        }),
      ).toEqual({ status: 409, code: 'channel_exists' })

      const channels = await admin.call('GET', '/admin/channels', storageChannelListSchema)
      for (const channel of channels) {
        if (channel.enabled && channel.id !== kept.id) {
          await admin.call('PATCH', `/admin/channels/${channel.id}`, storageChannelSchema, {
            json: { enabled: false },
          })
        }
      }
      expect(
        await admin.error('PATCH', `/admin/channels/${kept.id}`, { json: { enabled: false } }),
      ).toEqual({ status: 409, code: 'last_channel' })
    })

    it('keeps an audit log, newest first', async () => {
      const { user } = await newUser(await owner())
      const admin = await owner()
      const log = await admin.call('GET', '/admin/audit?limit=20', auditPageSchema)
      const created = log.items.find((entry) => entry.action === 'user.created')
      expect(created?.target).toBe(user.displayName)
      const times = log.items.map((entry) => Date.parse(entry.at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
    })

    it('logs uploads, and moving to the trash, restoring and deleting for good (§7.5)', async () => {
      const { user, username, photo, notes } = await userWithFiles()
      const client = await signIn(username, chosenPassword(username))
      await uploadFile(client, user.rootFolderId, 'notes.txt', text('hello again'))
      await client.send('DELETE', `/nodes/${photo.nodeId}`)
      // Its name is taken by then, so it comes back renamed.
      await uploadFile(client, user.rootFolderId, 'beach.jpg', text('new'))
      await client.call('POST', `/nodes/${photo.nodeId}/restore`, nodeSchema)
      await client.send('DELETE', `/nodes/${notes.nodeId}`)
      await client.send('DELETE', `/trash/${notes.nodeId}`)
      await client.send('POST', '/nodes/trash', { json: { ids: [photo.nodeId] } })
      await client.send('DELETE', '/trash')

      const log = await (
        await owner()
      ).call('GET', `/admin/audit?actorId=${user.id}&actions=upload.,node.`, auditPageSchema)
      expect(log.items.map((entry) => [entry.action, entry.target, entry.details])).toEqual([
        ['node.purged', 'beach (1).jpg', 'emptied the trash'],
        ['node.trashed', 'beach (1).jpg', null],
        ['node.purged', 'notes.txt', null],
        ['node.trashed', 'notes.txt', null],
        ['node.restored', 'beach (1).jpg', 'renamed from beach.jpg'],
        ['upload.completed', 'beach.jpg', '3 B'],
        ['node.trashed', 'beach.jpg', null],
        ['upload.completed', 'notes.txt', '11 B, new version'],
        ['upload.completed', 'notes.txt', '2 B'],
        ['upload.completed', 'beach.jpg', '10 B'],
      ])
      expect(log.items.every((entry) => entry.actorName === user.displayName)).toBe(true)
    })

    it('reports the system’s health', async () => {
      const health = await (await owner()).call('GET', '/admin/health', systemHealthSchema)
      expect(health.services.length).toBeGreaterThan(0)
    })

    it('lists who is signed in, and won’t end the session asking (§9)', async () => {
      const admin = await owner()
      const sessions = await admin.call('GET', '/admin/sessions', adminSessionListSchema)
      const own = sessions.filter((session) => session.current)
      expect(own).toHaveLength(1)
      expect(own[0]?.canSignOut).toBe(false)
      expect(await admin.error('DELETE', `/admin/sessions/${own[0]?.key ?? ''}`)).toEqual({
        status: 409,
        code: 'self_change',
      })
      expect(await admin.error('DELETE', '/admin/sessions/0000000000000000')).toEqual({
        status: 404,
        code: 'not_found',
      })
      const { username, temporaryPassword } = await newUser(admin)
      const user = await activated(username, temporaryPassword)
      for (const path of ['/admin/sessions', '/admin/shares', '/admin/uploads']) {
        expect(await user.error('GET', path)).toEqual({ status: 403, code: 'forbidden' })
      }
    })

    it('lists any user’s share link without its token, and turns it off (§9, D4)', async () => {
      const { user, username, photo } = await userWithFiles()
      const client = await signIn(username, chosenPassword(username))
      const link = await client.call('POST', '/shares', shareLinkSchema, {
        json: { nodeId: photo.nodeId, expiresAt: null, password: null, maxDownloads: null },
      })
      const admin = await owner()
      const listed = await admin.call('GET', '/admin/shares?active=true', adminSharePageSchema)
      const found = listed.items.find((share) => share.id === link.id)
      expect(found).toMatchObject({
        nodeName: 'beach.jpg',
        ownerId: user.id,
        ownerName: user.displayName,
        state: 'active',
      })
      expect(JSON.stringify(found)).not.toContain(link.url?.split('/s/')[1] ?? 'no token')

      await admin.send('DELETE', `/admin/shares/${link.id}`)
      // Turned off, it is gone from its owner's links too.
      const own = await client.call('GET', '/shares', shareLinkPageSchema)
      expect(own.items.map((share) => share.id)).not.toContain(link.id)
      const active = await admin.call('GET', '/admin/shares?active=true', adminSharePageSchema)
      expect(active.items.map((share) => share.id)).not.toContain(link.id)
      const log = await admin.call('GET', '/admin/audit?actions=share.&limit=1', auditPageSchema)
      expect(log.items[0]).toMatchObject({ action: 'share.revoked', target: 'beach.jpg' })
      // It is gone: turning it off again finds nothing, and the log notes nothing more.
      expect(await admin.error('DELETE', `/admin/shares/${link.id}`)).toEqual({
        status: 404,
        code: 'not_found',
      })
      const again = await admin.call('GET', '/admin/audit?actions=share.&limit=1', auditPageSchema)
      expect(again.items[0]?.id).toBe(log.items[0]?.id)
    })

    it('lists links by owner, with their folders, and finds them by file, folder or person', async () => {
      const { user, username } = await newUserWithFolder()
      const client = await signIn(username, chosenPassword(username))
      const folder = (parentId: string, name: string) =>
        client.call('POST', '/folders', nodeSchema, { json: { parentId, name } })
      const trips = await folder(user.rootFolderId, 'Trips')
      const lisbon = await folder(trips.id, 'Lisbon 2024')
      const photo = await uploadFile(client, lisbon.id, 'tram.jpg', text('jpeg'))
      const link = await client.call('POST', '/shares', shareLinkSchema, {
        json: { nodeId: photo.nodeId, expiresAt: null, password: null, maxDownloads: null },
      })
      const admin = await owner()
      const query = (params: string) =>
        admin.call('GET', `/admin/shares?${params}`, adminSharePageSchema)
      const owners = (params: string) =>
        admin.call('GET', `/admin/shares/owners?${params}`, adminShareOwnerListSchema)

      const mine = await query(`ownerId=${user.id}`)
      expect(mine.items).toHaveLength(1)
      expect(mine.items[0]).toMatchObject({
        id: link.id,
        path: 'Trips / Lisbon 2024',
        ownerUsername: username,
        version: 'current',
        state: 'active',
      })
      expect((await owners('active=true')).find((entry) => entry.ownerId === user.id)).toEqual({
        ownerId: user.id,
        ownerName: user.displayName,
        ownerUsername: username,
        links: 1,
        working: 1,
      })
      // By a folder it is in, its own name, or its owner; never by anything else.
      for (const words of ['lisbon', 'TRAM', username]) {
        const found = await query(`q=${encodeURIComponent(words)}`)
        expect(found.items.map((share) => share.id)).toContain(link.id)
      }
      const none = await owners(`q=${encodeURIComponent('no such thing 9f1c')}`)
      expect(none).toEqual([])
    })

    it('lists uploads under way, and gives one up (§9)', async () => {
      const { user, username } = await userWithFiles()
      const client = await signIn(username, chosenPassword(username))
      const started = await startUpload(client, user.rootFolderId, 'half.bin', 3 * 1024 * 1024)
      const admin = await owner()
      const uploads = await admin.call('GET', '/admin/uploads', adminUploadListSchema)
      expect(uploads.find((upload) => upload.id === started.uploadId)).toMatchObject({
        fileName: 'half.bin',
        userName: user.displayName,
        sizeBytes: 3 * 1024 * 1024,
        receivedBytes: 0,
      })
      await admin.send('DELETE', `/admin/uploads/${started.uploadId}`)
      const after = await admin.call('GET', '/admin/uploads', adminUploadListSchema)
      expect(after.map((upload) => upload.id)).not.toContain(started.uploadId)
      expect(await admin.error('DELETE', `/admin/uploads/${started.uploadId}`)).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('filters the audit log by kind of action and by words (§9)', async () => {
      const { user } = await newUser(await owner())
      const admin = await owner()
      const accounts = await admin.call(
        'GET',
        `/admin/audit?actions=user.&q=${encodeURIComponent(user.displayName)}`,
        auditPageSchema,
      )
      expect(accounts.items.length).toBeGreaterThan(0)
      expect(accounts.items.every((entry) => entry.action.startsWith('user.'))).toBe(true)
      expect(accounts.items.every((entry) => entry.target === user.displayName)).toBe(true)
      const signIns = await admin.call('GET', '/admin/audit?actions=auth.', auditPageSchema)
      expect(signIns.items.every((entry) => entry.action.startsWith('auth.'))).toBe(true)
      expect(await admin.error('GET', '/admin/audit?actions=DROP%20TABLE')).toEqual({
        status: 400,
        code: 'invalid_request',
      })
    })

    it('shows the settings in effect, and only whether secrets are set (§15)', async () => {
      const admin = await owner()
      const system = await admin.call('GET', '/admin/system', systemInfoSchema)
      const keys = system.settings.map((setting) => setting.key)
      expect(keys).toContain('STAGING_MAX_BYTES')
      for (const secret of ['DATABASE_URL', 'INTERNAL_RPC_SECRET', 'DISCORD_BOT_TOKEN']) {
        expect(keys).not.toContain(secret)
      }
      expect(system.secrets.map((secret) => secret.key)).toContain('DATABASE_URL')
      expect(system.instanceId.length).toBeGreaterThan(0)

      // A frame cache is cleared; local storage has none.
      const cleared = await admin.fetch('POST', '/admin/system/cache/clear')
      expect([200, 409]).toContain(cleared.status)
      await cleared.body?.cancel()

      const { username, temporaryPassword } = await newUser(admin)
      const user = await activated(username, temporaryPassword)
      expect(await user.error('GET', '/admin/system')).toEqual({ status: 403, code: 'forbidden' })
    })

    it('vacuums a listed table, and no other (§16)', async () => {
      const admin = await owner()
      await admin.send('POST', '/admin/database/tables/nodes/vacuum')
      expect(await admin.error('POST', '/admin/database/tables/no_such_table/vacuum')).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('reports what is stuck in storage, and takes only known tasks (§9)', async () => {
      const admin = await owner()
      const status = await admin.call('GET', '/admin/storage', storageStatusSchema)
      expect(['discord', 'local', 'chaos']).toContain(status.blobStore)
      // Compaction merges two packs or more into one: those due now are among all it could.
      const { due, all } = status.compaction
      for (const figures of [due, all]) expect(figures.into * 2 <= figures.packs).toBe(true)
      expect(all.packs >= due.packs && all.freedBytes >= due.freedBytes).toBe(true)
      expect(Array.isArray(await admin.call('GET', '/admin/tasks', adminTaskListSchema))).toBe(true)
      for (const json of [{ kind: 'everything.delete' }, { kind: 'blob.recover' }]) {
        expect(await admin.error('POST', '/admin/tasks', { json })).toEqual({
          status: 400,
          code: 'invalid_request',
        })
      }
      expect(await admin.error('GET', `/admin/tasks/${crypto.randomUUID()}`)).toEqual({
        status: 404,
        code: 'not_found',
      })

      const { username, temporaryPassword } = await newUser(admin)
      const user = await activated(username, temporaryPassword)
      for (const path of ['/admin/storage', '/admin/tasks']) {
        expect(await user.error('GET', path)).toEqual({ status: 403, code: 'forbidden' })
      }
    })

    it('shows PostgreSQL as it is, and signals only its real connections (§16)', async () => {
      const admin = await owner()
      const status = await admin.call('GET', '/admin/database', databaseStatusSchema)
      expect(status.version).toMatch(/^PostgreSQL \d+/)
      expect(status.connections.used).toBeGreaterThan(0)
      expect(status.connections.max >= status.connections.used).toBe(true)
      expect(status.tables.map((table) => table.name)).toContain('nodes')
      expect(status.settings.map((setting) => setting.name)).toContain('max_connections')
      for (const how of ['cancel', 'terminate']) {
        expect(await admin.error('POST', `/admin/database/sessions/2147483647/${how}`)).toEqual({
          status: 404,
          code: 'not_found',
        })
      }

      const { username, temporaryPassword } = await newUser(admin)
      const user = await activated(username, temporaryPassword)
      expect(await user.error('GET', '/admin/database')).toEqual({
        status: 403,
        code: 'forbidden',
      })
    })

    it('reads metrics as series, one point per bucket of the range (§16)', async () => {
      const admin = await owner()
      const ids = ['http.requests:rate', 'http.ms:p95', 'storage.bytes:avg']
      const day = await admin.call(
        'GET',
        `/admin/metrics?range=24h&series=${ids.join(',')}`,
        metricSeriesSchema,
      )
      expect(day.bucketSeconds).toBe(300)
      expect(day.times).toHaveLength(288)
      const steps = day.times.slice(1).map((time, index) => time - (day.times[index] ?? 0))
      expect(new Set(steps)).toEqual(new Set([300_000]))
      // The figures end within the last bucket, at a whole minute.
      const lastStart = day.times.at(-1) ?? 0
      expect(day.until > lastStart && day.until <= lastStart + 300_000).toBe(true)
      expect(day.until % 60_000).toBe(0)
      expect(day.series.map((series) => series.id)).toEqual(ids)
      for (const series of day.series) expect(series.values).toHaveLength(288)

      // Unknown metrics, readings a metric doesn't offer, and too many series are refused.
      for (const series of ['nope:rate', 'http.requests:p95', 'http.requests']) {
        expect(await admin.error('GET', `/admin/metrics?series=${series}`)).toEqual({
          status: 400,
          code: 'invalid_request',
        })
      }
      const readings = { counter: 'rate', gauge: 'avg', timing: 'p95' } as const
      const all = Object.entries(METRICS).map(([name, info]) => `${name}:${readings[info.kind]}`)
      expect(
        await admin.error('GET', `/admin/metrics?series=${all.slice(0, 25).join(',')}`),
      ).toEqual({ status: 400, code: 'invalid_request' })
      // A series asked for twice comes once.
      const twice = await admin.call(
        'GET',
        '/admin/metrics?series=http.requests:rate,http.requests:rate',
        metricSeriesSchema,
      )
      expect(twice.series).toHaveLength(1)

      const { username, temporaryPassword } = await newUser(admin)
      const user = await activated(username, temporaryPassword)
      expect(await user.error('GET', '/admin/metrics?series=http.requests:rate')).toEqual({
        status: 403,
        code: 'forbidden',
      })
    })
  })
}

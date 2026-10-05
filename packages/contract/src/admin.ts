import {
  auditPageSchema,
  METRICS,
  metricSeriesSchema,
  nodePageSchema,
  storageChannelListSchema,
  storageChannelSchema,
  systemHealthSchema,
  trashPageSchema,
  userUsageSchema,
} from '@dfs/shared'
import { chosenPassword, type SuiteContext } from './context.ts'
import { text, uploadFile } from './files.ts'

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

    it('reports the system’s health', async () => {
      const health = await (await owner()).call('GET', '/admin/health', systemHealthSchema)
      expect(health.services.length).toBeGreaterThan(0)
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

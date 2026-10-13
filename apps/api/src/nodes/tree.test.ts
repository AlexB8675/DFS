import { expireTrash, nodes, shareLinks, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { anyVisibleNode, userUsage } from '../admin/browse.ts'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { createArchiveTicket } from '../content/archive.ts'
import { liveShareById, nodeInShare } from '../shares/public.ts'
import { countShareLinks, createShare, listShares } from '../shares/shares.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createUploads } from '../uploads/uploads.ts'
import { lookupNodes, NODE_COLUMNS, NODE_JOINS, visibleNode, type NodeRow } from './read.ts'
import { searchNodes } from './search.ts'
import { deleteForever, emptyTrash, listTrash } from './trash.ts'
import { createFolder, moveNodes, restoreNode, updateNode } from './write.ts'

let database: TestDatabase
let app: FastifyInstance
let auth: Auth
let cleanup: () => Promise<void>
let vaultRoot: typeof nodes.$inferSelect
let vaultFolder: typeof nodes.$inferSelect
let vaultFile: typeof nodes.$inferSelect
let trashedVaultFile: typeof nodes.$inferSelect
let driveFile: typeof nodes.$inferSelect

async function inserted(values: typeof nodes.$inferInsert) {
  const [row] = await app.db.insert(nodes).values(values).returning()
  if (!row) throw new Error('Inserting a node returned nothing.')
  return row
}

beforeAll(async () => {
  database = await createTestDatabase(inject('testPostgres'))
  const setup = await testConfig({ DATABASE_URL: database.url })
  cleanup = setup.cleanup
  app = await buildApp({ config: setup.config, logger: false })
  await seedUser(app.db, { username: 'owner', password: 'the-owner-password' })
  const [user] = await app.db.select().from(users).where(eq(users.username, 'owner'))
  if (!user) throw new Error('Missing test user.')
  auth = {
    user,
    sessionId: 'test',
    csrfToken: 'test',
    expiresAt: new Date(Date.now() + 60_000),
    seenAt: null,
    limited: false,
  }

  const ownerId = auth.user.id
  vaultRoot = await inserted({
    ownerId,
    kind: 'folder',
    name: 'Vault',
    nameKey: 'vault',
    tree: 'vault',
  })
  vaultFolder = await inserted({
    ownerId,
    parentId: vaultRoot.id,
    kind: 'folder',
    name: 'Inside',
    nameKey: 'inside',
  })
  vaultFile = await inserted({
    ownerId,
    parentId: vaultFolder.id,
    kind: 'file',
    name: 'secret.txt',
    nameKey: 'secret.txt',
  })
  trashedVaultFile = await inserted({
    ownerId,
    parentId: vaultFolder.id,
    kind: 'file',
    name: 'gone.txt',
    nameKey: 'gone.txt',
    deletedAt: new Date(),
  })
  driveFile = await inserted({
    ownerId,
    parentId: auth.user.rootNodeId,
    kind: 'file',
    name: 'plain.txt',
    nameKey: 'plain.txt',
  })
})

afterAll(async () => {
  await app.close()
  await database.drop()
  await cleanup()
})

const NOT_FOUND = { status: 404, code: 'not_found' }

async function stored(id: string) {
  const [row] = await app.db.select().from(nodes).where(eq(nodes.id, id))
  if (!row) throw new Error('Missing node.')
  return row
}

describe('the vault is out of reach of the drive’s gates (§7.7)', () => {
  it('finds no vault node by id', async () => {
    await expect(visibleNode(app.db, auth.user.id, vaultFolder.id)).rejects.toMatchObject(NOT_FOUND)
    await expect(visibleNode(app.db, auth.user.id, vaultFile.id)).rejects.toMatchObject(NOT_FOUND)
  })

  it('leaves vault nodes out of a lookup of several', async () => {
    const found = await lookupNodes(app.db, auth.user.id, [
      vaultFolder.id,
      vaultFile.id,
      driveFile.id,
    ])
    expect(found.map((node) => node.id)).toEqual([driveFile.id])
  })

  it('creates no folder in the vault', async () => {
    await expect(createFolder(app, auth, vaultFolder.id, 'New')).rejects.toMatchObject(NOT_FOUND)
  })

  it('moves nothing into the vault by updating it', async () => {
    await expect(
      updateNode(app, auth, driveFile.id, { parentId: vaultFolder.id }),
    ).rejects.toMatchObject(NOT_FOUND)
    expect((await stored(driveFile.id)).parentId).toBe(auth.user.rootNodeId)
  })

  it('moves nothing into the vault', async () => {
    await expect(moveNodes(app, auth, [driveFile.id], vaultFolder.id)).rejects.toMatchObject(
      NOT_FOUND,
    )
    expect((await stored(driveFile.id)).parentId).toBe(auth.user.rootNodeId)
  })

  it('starts no upload into the vault', async () => {
    const results = await createUploads(app, auth, [
      { parentId: vaultFolder.id, name: 'x.txt', sizeBytes: 3, mimeType: 'text/plain' },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('makes no share link to a vault node', async () => {
    await expect(
      createShare(app, auth, {
        nodeId: vaultFile.id,
        expiresAt: null,
        password: null,
        maxDownloads: null,
      }),
    ).rejects.toMatchObject(NOT_FOUND)
  })

  it('makes no ZIP of a vault folder', async () => {
    await expect(createArchiveTicket(app, auth, [vaultFolder.id])).rejects.toMatchObject(NOT_FOUND)
  })

  it('shows an admin no vault node', async () => {
    await expect(anyVisibleNode(app.db, vaultFolder.id)).rejects.toMatchObject(NOT_FOUND)
  })

  it('restores no vault node from the drive', async () => {
    await expect(restoreNode(app, auth, trashedVaultFile.id)).rejects.toMatchObject(NOT_FOUND)
    expect((await stored(trashedVaultFile.id)).deletedAt).not.toBeNull()
  })

  it('does not open a share link on a vault node', async () => {
    const [share] = await app.db
      .insert(shareLinks)
      .values({ nodeId: vaultFolder.id, tokenHash: Buffer.alloc(32, 7), passwordHash: null })
      .returning()
    if (!share) throw new Error('Inserting a share returned nothing.')
    await expect(liveShareById(app, share.id)).rejects.toMatchObject({
      status: 404,
      code: 'share_not_found',
    })
  })

  it('finds no vault node inside a share', async () => {
    const { rows } = await app.db.execute<NodeRow>(sql`
      SELECT ${NODE_COLUMNS} FROM nodes n /* tree: all trees: test */ ${NODE_JOINS}
      WHERE n.id = ${vaultRoot.id}`)
    const [vaultRootRow] = rows
    if (!vaultRootRow) throw new Error('Missing vault root.')
    await expect(nodeInShare(app, vaultRootRow, vaultFile.id)).rejects.toMatchObject(NOT_FOUND)
  })
})

describe('owner-wide lists and counts leave the vault out (§7.7)', () => {
  let findable: typeof nodes.$inferSelect
  let sharedFolder: typeof nodes.$inferSelect
  let trashedFolder: typeof nodes.$inferSelect
  let expiring: typeof nodes.$inferSelect
  let driveFindable: typeof nodes.$inferSelect

  beforeAll(async () => {
    const ownerId = auth.user.id
    findable = await inserted({
      ownerId,
      parentId: vaultRoot.id,
      kind: 'file',
      name: 'findme.txt',
      nameKey: 'findme.txt',
    })
    driveFindable = await inserted({
      ownerId,
      parentId: auth.user.rootNodeId,
      kind: 'file',
      name: 'findme-too.txt',
      nameKey: 'findme-too.txt',
    })
    sharedFolder = await inserted({
      ownerId,
      parentId: vaultRoot.id,
      kind: 'folder',
      name: 'Shared',
      nameKey: 'shared',
    })
    await app.db
      .insert(shareLinks)
      .values({ nodeId: sharedFolder.id, tokenHash: Buffer.alloc(32, 8), passwordHash: null })
    trashedFolder = await inserted({
      ownerId,
      parentId: vaultRoot.id,
      kind: 'folder',
      name: 'Old',
      nameKey: 'old',
      deletedAt: new Date(),
    })
    await app.db
      .insert(shareLinks)
      .values({ nodeId: trashedFolder.id, tokenHash: Buffer.alloc(32, 9), passwordHash: null })
    expiring = await inserted({
      ownerId,
      parentId: vaultRoot.id,
      kind: 'file',
      name: 'expiring.txt',
      nameKey: 'expiring.txt',
      deletedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
    })
  })

  async function exists(id: string) {
    const rows = await app.db.select().from(nodes).where(eq(nodes.id, id))
    return rows.length > 0
  }

  it('finds no vault node by name', async () => {
    const found = await searchNodes(app.db, auth, 'findme', undefined, 50)
    const ids = found.items.map((item) => item.id)
    expect(ids).toContain(driveFindable.id)
    expect(ids).not.toContain(findable.id)
  })

  it('lists no vault node in the Trash', async () => {
    const page = await listTrash(app.db, auth, undefined, 50, 30)
    const ids = page.items.map((item) => item.id)
    expect(ids).not.toContain(trashedVaultFile.id)
    expect(ids).not.toContain(trashedFolder.id)
    expect(ids).not.toContain(expiring.id)
  })

  it('deletes no vault node for good from the Trash', async () => {
    await expect(deleteForever(app, auth, trashedVaultFile.id)).rejects.toMatchObject(NOT_FOUND)
    await expect(stored(trashedVaultFile.id)).resolves.toBeDefined()
  })

  it('empties no vault node with the Trash', async () => {
    await emptyTrash(app, auth)
    expect(await exists(trashedVaultFile.id)).toBe(true)
    expect(await exists(trashedFolder.id)).toBe(true)
    expect(await exists(expiring.id)).toBe(true)
  })

  it('counts no vault node in a user’s usage', async () => {
    const before = await userUsage(app, auth, auth.user.id)
    await inserted({
      ownerId: auth.user.id,
      parentId: vaultRoot.id,
      kind: 'file',
      name: 'pic.png',
      nameKey: 'pic.png',
      mimeType: 'image/png',
      sizeBytes: 1000,
    })
    await inserted({
      ownerId: auth.user.id,
      parentId: vaultRoot.id,
      kind: 'folder',
      name: 'Sub',
      nameKey: 'sub',
    })
    await inserted({
      ownerId: auth.user.id,
      parentId: vaultRoot.id,
      kind: 'file',
      name: 'bin.png',
      nameKey: 'bin.png',
      mimeType: 'image/png',
      sizeBytes: 500,
      deletedAt: new Date(),
    })
    const after = await userUsage(app, auth, auth.user.id)
    expect(after.categories).toEqual(before.categories)
    expect(after.fileCount).toBe(before.fileCount)
    expect(after.folderCount).toBe(before.folderCount)
    expect(after.trashBytes).toBe(before.trashBytes)
  })

  it('lists no share link to a vault node', async () => {
    const page = await listShares(app, auth)
    const nodeIds = page.items.map((item) => item.nodeId)
    expect(nodeIds).not.toContain(sharedFolder.id)
    expect(nodeIds).not.toContain(trashedFolder.id)
  })

  it('counts no share link to a vault node', async () => {
    await expect(countShareLinks(app, auth, { ids: [sharedFolder.id] })).resolves.toEqual({
      links: 0,
    })
    await expect(countShareLinks(app, auth, { trash: true })).resolves.toEqual({ links: 0 })
  })

  // Pins existing behaviour: the vault's trash expires like the drive's (§7.7).
  it('still expires the vault’s trash', async () => {
    await expireTrash(app.db, 30)
    expect(await exists(expiring.id)).toBe(false)
  })
})

import { nodes, shareLinks, users } from '@dfs/db'
import { createTestDatabase, type TestDatabase } from '@dfs/db/testing'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { anyVisibleNode } from '../admin/browse.ts'
import { buildApp } from '../app.ts'
import type { Auth } from '../auth/sessions.ts'
import { createArchiveTicket } from '../content/archive.ts'
import { liveShareById, nodeInShare } from '../shares/public.ts'
import { createShare } from '../shares/shares.ts'
import { testConfig } from '../testing/config.ts'
import { seedUser } from '../testing/seed.ts'
import { createUploads } from '../uploads/uploads.ts'
import { lookupNodes, NODE_COLUMNS, NODE_JOINS, visibleNode, type NodeRow } from './read.ts'
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
  const inserted = async (values: typeof nodes.$inferInsert) => {
    const [row] = await app.db.insert(nodes).values(values).returning()
    if (!row) throw new Error('Inserting a node returned nothing.')
    return row
  }
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

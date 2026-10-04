import { nameKey, normalizeName, splitExtension, validateName, type DriveNode } from '@dfs/shared'
import {
  appendJournal,
  markFoldersDirty,
  nodeRecord,
  nodes,
  textArray,
  TREE_LOCK_NAMESPACE,
  uuidArray,
  type Executor,
} from '@dfs/db'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Auth } from '../auth/sessions.ts'
import { isUniqueViolation } from '../db-errors.ts'
import { ApiError } from '../errors.ts'
import {
  NODE_COLUMNS,
  NODE_JOINS,
  nodePath,
  notFound,
  toDriveNode,
  VISIBLE,
  visibleFolder,
  visibleNode,
  type NodeRow,
} from './read.ts'

// Changing the tree (DESIGN.md §6.3): plain SQL transactions, no storage
// traffic. The unique index on names is the guard against races; moves take a
// per-drive lock, so two crossing moves can't make a cycle.

type NodeState = typeof nodes.$inferSelect

export async function createFolder(
  app: FastifyInstance,
  auth: Auth,
  parentId: string,
  rawName: string,
): Promise<DriveNode> {
  const name = checkedName(rawName)
  const ownerId = auth.user.id
  const id = await app.db.transaction(async (tx) => {
    await visibleFolder(tx, ownerId, parentId)
    const folder = await insertFolder(tx, ownerId, parentId, name)
    await appendJournal(tx, [nodeRecord(folder)])
    return folder.id
  })
  return toDriveNode(await visibleNode(app.db, ownerId, id))
}

/**
 * `POST /folders/ensure`: `mkdir -p` for many paths in one transaction.
 * Returns the folder ID for each path as given.
 */
export async function ensureFolders(
  app: FastifyInstance,
  auth: Auth,
  parentId: string,
  paths: string[],
): Promise<Record<string, string>> {
  const ownerId = auth.user.id
  return app.db.transaction(async (tx) => {
    await visibleFolder(tx, ownerId, parentId)
    const resolved = new Map<string, string>()
    const created: NodeState[] = []
    const result: Record<string, string> = {}

    for (const path of paths) {
      let currentId = parentId
      let prefix = ''
      for (const segment of path.split('/').filter(Boolean)) {
        const name = checkedName(segment)
        prefix += `/${nameKey(name)}`
        const known = resolved.get(prefix)
        if (known) {
          currentId = known
          continue
        }
        const existing = await childByName(tx, currentId, name)
        if (existing?.kind === 'file') throw nameConflict(name)
        if (existing) {
          currentId = existing.id
        } else {
          const folder = await insertFolder(tx, ownerId, currentId, name)
          created.push(folder)
          currentId = folder.id
        }
        resolved.set(prefix, currentId)
      }
      result[path] = currentId
    }
    await appendJournal(tx, created.map(nodeRecord))
    return result
  })
}

/** `PATCH /nodes/:id`: renames and/or moves one item. */
export async function updateNode(
  app: FastifyInstance,
  auth: Auth,
  id: string,
  changes: { name?: string | undefined; parentId?: string | undefined },
): Promise<DriveNode> {
  const ownerId = auth.user.id
  await app.db.transaction(async (tx) => {
    if (changes.parentId) await lockDrive(tx, ownerId)
    const node = await visibleNode(tx, ownerId, id)
    if (node.parent_id === null) {
      throw new ApiError(403, 'forbidden', 'The root folder cannot be changed.')
    }
    const name = changes.name === undefined ? node.name : checkedName(changes.name)
    const parentId = changes.parentId ?? node.parent_id
    const moving = parentId !== node.parent_id
    if (moving) await assertCanMove(tx, ownerId, [node], parentId)
    if (!moving && name === node.name) return

    const [updated] = await guardName(name, () =>
      tx
        .update(nodes)
        .set({ name, nameKey: nameKey(name), parentId, updatedAt: new Date() })
        .where(eq(nodes.id, id))
        .returning(),
    )
    if (!updated) throw notFound()
    if (moving) await markFoldersDirty(tx, [node.parent_id, parentId])
    await appendJournal(tx, [nodeRecord(updated)])
  })
  return toDriveNode(await visibleNode(app.db, ownerId, id))
}

/** `POST /nodes/move`: moves several items into one folder. */
export async function moveNodes(
  app: FastifyInstance,
  auth: Auth,
  ids: string[],
  parentId: string,
): Promise<void> {
  const ownerId = auth.user.id
  await app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId)
    const moving = (await visibleNodes(tx, ownerId, ids)).filter(
      (node) => node.parent_id !== parentId,
    )
    if (moving.length === 0) return
    await assertCanMove(tx, ownerId, moving, parentId)

    // Name the clash, if any; the unique index still guards against races.
    const { rows: clashes } = await tx.execute<{ name: string }>(sql`
      SELECT name FROM nodes
      WHERE parent_id = ${parentId} AND deleted_at IS NULL
        AND name_key = ANY(${textArray(moving.map((node) => nameKey(node.name)))})
      LIMIT 1`)
    if (clashes[0]) throw nameConflict(clashes[0].name)

    const movingIds = moving.map((node) => node.id)
    const updated = await guardName(moving[0]?.name ?? '', () =>
      tx
        .update(nodes)
        .set({ parentId, updatedAt: new Date() })
        .where(sql`${nodes.id} = ANY(${uuidArray(movingIds)})`)
        .returning(),
    )
    await markFoldersDirty(tx, [parentId, ...moving.flatMap((node) => node.parent_id ?? [])])
    await appendJournal(tx, updated.map(nodeRecord))
  })
}

/**
 * Moves items to the trash: the item gets `deleted_at`, and everything below
 * it `trashed_via`, so lists and search skip the whole subtree (§6.3).
 */
export async function trashNodes(app: FastifyInstance, auth: Auth, ids: string[]): Promise<void> {
  const ownerId = auth.user.id
  await app.db.transaction(async (tx) => {
    const trashed = await visibleNodes(tx, ownerId, ids)
    if (trashed.some((node) => node.parent_id === null)) {
      throw new ApiError(403, 'forbidden', 'The root folder cannot be trashed.')
    }
    const updated = await tx
      .update(nodes)
      .set({ deletedAt: new Date() })
      .where(sql`${nodes.id} = ANY(${uuidArray(ids)})`)
      .returning()
    await tx.execute(sql`
      WITH RECURSIVE below AS (
        SELECT id, id AS via FROM nodes WHERE id = ANY(${uuidArray(ids)})
        UNION ALL
        SELECT child.id, below.via FROM nodes child JOIN below ON child.parent_id = below.id
      )
      UPDATE nodes SET trashed_via = below.via
      FROM below
      WHERE nodes.id = below.id AND nodes.id <> below.via AND nodes.trashed_via IS NULL`)
    await markFoldersDirty(
      tx,
      trashed.flatMap((node) => node.parent_id ?? []),
    )
    await appendJournal(tx, updated.map(nodeRecord))
  })
}

/**
 * Takes an item out of the trash, into its old folder if that is still
 * there and otherwise the root, renamed to `name (1)` if its name was taken.
 */
export async function restoreNode(
  app: FastifyInstance,
  auth: Auth,
  id: string,
): Promise<DriveNode> {
  const ownerId = auth.user.id
  const rootId = auth.user.rootNodeId
  if (!rootId) throw notFound()
  await app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId)
    const [node] = await tx.select().from(nodes).where(eq(nodes.id, id))
    if (!node?.deletedAt || node.ownerId !== ownerId || !node.parentId) throw notFound()

    const { rows: parents } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM nodes
      WHERE id = ${node.parentId} AND deleted_at IS NULL AND trashed_via IS NULL`)
    const parentId = parents[0] ? node.parentId : rootId
    const name = await freeName(tx, parentId, node.name)

    const [restored] = await tx
      .update(nodes)
      .set({ parentId, name, nameKey: nameKey(name), deletedAt: null, moderationReason: null })
      .where(eq(nodes.id, id))
      .returning()
    if (!restored) throw notFound()
    await tx.update(nodes).set({ trashedVia: null }).where(eq(nodes.trashedVia, id))
    await markFoldersDirty(tx, [parentId])
    await appendJournal(tx, [nodeRecord(restored)])
  })
  return toDriveNode(await visibleNode(app.db, ownerId, id))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A name as stored: NFC, trimmed, and valid (§5.1), or a 400. */
export function checkedName(raw: string): string {
  const name = normalizeName(raw)
  const problem = validateName(name)
  if (problem) throw new ApiError(400, 'invalid_name', problem)
  return name
}

export function nameConflict(name: string): ApiError {
  return new ApiError(409, 'name_conflict', `An item named “${name}” already exists here.`)
}

/** Runs a write that may break the unique name index, turning that into a 409. */
export async function guardName<T>(name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isUniqueViolation(error, 'nodes_unique_name')) throw nameConflict(name)
    throw error
  }
}

/** Serializes tree changes within one drive until the transaction ends. */
export async function lockDrive(tx: Executor, ownerId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${TREE_LOCK_NAMESPACE}, hashtext(${ownerId}))`)
}

async function insertFolder(
  tx: Executor,
  ownerId: string,
  parentId: string,
  name: string,
): Promise<NodeState> {
  const [folder] = await guardName(name, () =>
    tx
      .insert(nodes)
      .values({ ownerId, parentId, kind: 'folder', name, nameKey: nameKey(name) })
      .returning(),
  )
  if (!folder) throw new Error('Inserting a folder returned nothing.')
  return folder
}

async function childByName(tx: Executor, parentId: string, name: string) {
  const [child] = await tx
    .select({ id: nodes.id, kind: nodes.kind })
    .from(nodes)
    .where(
      sql`${nodes.parentId} = ${parentId} AND ${nodes.nameKey} = ${nameKey(name)} AND ${nodes.deletedAt} IS NULL`,
    )
  return child
}

/** All of these, owned and not in the trash, or a 404. */
async function visibleNodes(tx: Executor, ownerId: string, ids: string[]): Promise<NodeRow[]> {
  const unique = [...new Set(ids)]
  const { rows } = await tx.execute<NodeRow>(sql`
    SELECT ${NODE_COLUMNS} FROM nodes n ${NODE_JOINS}
    WHERE n.id = ANY(${uuidArray(unique)}) AND n.owner_id = ${ownerId} AND ${VISIBLE}`)
  if (rows.length !== unique.length) throw notFound()
  return rows
}

/** A move must go into a visible folder, never into the moved folder itself or below it. */
async function assertCanMove(
  tx: Executor,
  ownerId: string,
  moving: NodeRow[],
  parentId: string,
): Promise<void> {
  await visibleFolder(tx, ownerId, parentId)
  const ancestors = new Set((await nodePath(tx, parentId)).map((node) => node.id))
  if (moving.some((node) => node.parent_id === null || ancestors.has(node.id))) {
    throw new ApiError(400, 'invalid_move', 'A folder cannot be moved into itself.')
  }
}

/** `name`, or `name (1)`, `name (2)`, … whichever is free in the folder. */
async function freeName(tx: Executor, parentId: string, name: string): Promise<string> {
  const { base, extension } = splitExtension(name)
  const { rows } = await tx.execute<{ name_key: string }>(sql`
    SELECT name_key FROM nodes
    WHERE parent_id = ${parentId} AND deleted_at IS NULL
      AND name_key LIKE ${`${escapeLike(nameKey(base))}%`}`)
  const taken = new Set(rows.map((row) => row.name_key))
  let candidate = name
  for (let n = 1; taken.has(nameKey(candidate)); n += 1)
    candidate = `${base} (${String(n)})${extension}`
  return candidate
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

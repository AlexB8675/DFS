import { nameKey } from '@dfs/shared'
import type { AppItem } from '@dfs/shared'
import type { Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { AppTokenAuth } from '../app-tokens/tokens.ts'
import { ApiError } from '../errors.ts'
import { lookupNodes, notFound, type NodeRow } from '../nodes/read.ts'
import { ensureFoldersIn, lockDrive, moveIn, trashIn } from '../nodes/write.ts'
import { toAppItem } from './items.ts'
import { joinPath, resolvePath, resolvePrefix } from './paths.ts'

// Making folders, moving and trashing for an app token (DESIGN.md §7.8): each
// resolves its paths and acts in one transaction, under the drive's lock, so
// what it checked is what it changes.

function conflict(error: unknown, code: string, message: string): unknown {
  return error instanceof ApiError && error.code === 'name_conflict'
    ? new ApiError(409, code, message)
    : error
}

async function itemOf(tx: Executor, ownerId: string, id: string, path: string): Promise<AppItem> {
  const [row] = await lookupNodes(tx, ownerId, [id])
  if (!row) throw notFound()
  return toAppItem(row, path)
}

/** `mkdir -p` below the token's folder; `created` is false when it was all there. */
export async function makeFolders(
  app: FastifyInstance,
  token: AppTokenAuth,
  segments: readonly string[],
): Promise<{ item: AppItem; created: boolean }> {
  const ownerId = token.user.id
  return app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId, 'shared')
    const { deepest, path, rest } = await resolvePrefix(tx, token, segments)
    if (rest.length === 0) {
      return { item: await itemOf(tx, ownerId, deepest.id, path), created: false }
    }
    const id = await ensureBelow(tx, ownerId, deepest.id, rest)
    const full = rest.reduce(joinPath, path)
    return { item: await itemOf(tx, ownerId, id, full), created: true }
  })
}

/** Makes `names` below `parentId`; a file in the way is `not_a_folder`. */
async function ensureBelow(
  tx: Executor,
  ownerId: string,
  parentId: string,
  names: readonly string[],
): Promise<string> {
  const path = names.join('/')
  try {
    const made = await ensureFoldersIn(tx, ownerId, parentId, [path])
    const id = made[path]
    if (!id) throw new Error('Making folders returned nothing.')
    return id
  } catch (error) {
    throw conflict(
      error,
      'not_a_folder',
      `“${path}” cannot be made: a file has the name of one of its folders.`,
    )
  }
}

/** Moves or renames the item at `from` to `to`, making `to`'s missing folders. */
export async function moveItem(
  app: FastifyInstance,
  token: AppTokenAuth,
  from: readonly string[],
  to: readonly string[],
): Promise<AppItem> {
  const fromName = from.at(-1)
  if (fromName === undefined) {
    throw new ApiError(400, 'token_folder', 'The token’s folder cannot be moved.')
  }
  const toName = to.at(-1)
  if (toName === undefined) {
    throw new ApiError(400, 'invalid_path', '`to` needs a name: it is the new path of the item.')
  }
  const ownerId = token.user.id
  const parentSegments = to.slice(0, -1)
  return app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId)
    const { node } = await resolvePath(tx, token, from)
    if (node.kind === 'folder') {
      const fromKeys = from.map(nameKey)
      const parentKeys = parentSegments.map(nameKey)
      if (fromKeys.every((key, index) => parentKeys[index] === key)) {
        throw new ApiError(400, 'invalid_move', 'A folder cannot be moved into itself.')
      }
    }
    const { deepest, path, rest } = await resolvePrefix(tx, token, parentSegments)
    const parentId =
      rest.length === 0 ? deepest.id : await ensureBelow(tx, ownerId, deepest.id, rest)
    const parentPath = rest.reduce(joinPath, path)
    const taken = await takenBy(tx, ownerId, parentId, toName)
    const exists = (): ApiError =>
      new ApiError(409, 'exists', `“${joinPath(parentPath, toName)}” already exists.`)
    if (taken && taken.id !== node.id) throw exists()
    try {
      await moveIn(tx, ownerId, node, parentId, toName)
    } catch (error) {
      throw conflict(error, 'exists', exists().message)
    }
    return itemOf(tx, ownerId, node.id, joinPath(parentPath, toName))
  })
}

/** The item named `name` in a folder, an unfinished file included. */
async function takenBy(
  tx: Executor,
  ownerId: string,
  parentId: string,
  name: string,
): Promise<{ id: string } | undefined> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM nodes /* tree: by parent */
    WHERE parent_id = ${parentId} AND owner_id = ${ownerId} AND name_key = ${nameKey(name)}
      AND deleted_at IS NULL AND trashed_via IS NULL`)
  return rows[0]
}

/** Sends the item at `segments` to the trash, a folder with all it holds. */
export async function trashItem(
  app: FastifyInstance,
  token: AppTokenAuth,
  segments: readonly string[],
): Promise<void> {
  if (segments.length === 0) {
    throw new ApiError(400, 'token_folder', 'The token’s folder cannot be trashed.')
  }
  const ownerId = token.user.id
  await app.db.transaction(async (tx) => {
    await lockDrive(tx, ownerId)
    const { node }: { node: NodeRow } = await resolvePath(tx, token, segments)
    await trashIn(tx, ownerId, [node])
  })
}

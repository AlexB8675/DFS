import type { Executor } from '@dfs/db'
import { sql } from 'drizzle-orm'
import type { AppTokenAuth } from '../app-tokens/tokens.ts'
import { ApiError } from '../errors.ts'
import { NODE_COLUMNS, NODE_JOINS, type NodeRow } from '../nodes/read.ts'

/**
 * The token's folder, which every v1 request checks first: it must be visible
 * and in My drive, or the token reaches nothing (DESIGN.md §7.8).
 */
export async function appFolder(db: Executor, token: AppTokenAuth): Promise<NodeRow> {
  const { rows } = await db.execute<NodeRow & { tree: string }>(sql`
    SELECT ${NODE_COLUMNS}, n.tree FROM nodes n /* tree: by id, checked below */ ${NODE_JOINS}
    WHERE n.id = ${token.folderId} AND n.owner_id = ${token.user.id}`)
  const [folder] = rows
  if (folder?.tree !== 'drive') {
    const name = folder ? ` “${folder.name}”` : ''
    throw unavailable(`This token’s folder${name} is no longer in My drive.`)
  }
  if (folder.deleted_at !== null || folder.trashed_via !== null) {
    throw unavailable(
      `This token’s folder “${folder.name}” is in the trash. Restore it to use this token again.`,
    )
  }
  return folder
}

function unavailable(message: string): ApiError {
  return new ApiError(409, 'folder_unavailable', message)
}

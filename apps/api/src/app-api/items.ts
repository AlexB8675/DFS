import type { AppItem } from '@dfs/shared'
import { iso, type NodeRow } from '../nodes/read.ts'

/** A node as `/api/v1` shows it; `path` is relative to the token's folder, as stored. */
export function toAppItem(row: NodeRow, path: string): AppItem {
  return {
    id: row.id,
    name: row.name,
    path,
    kind: row.kind,
    size: row.size_bytes,
    mimeType: row.mime_type,
    modifiedAt: iso(row.updated_at),
    version: row.kind === 'file' ? row.current_version_id : null,
  }
}

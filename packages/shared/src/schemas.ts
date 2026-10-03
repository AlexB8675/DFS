import { z } from 'zod'

// Wire formats of the HTTP API (DESIGN.md §9). Shared by the web app, its
// mock API, and later the real API service.

const id = z.uuid()
const timestamp = z.iso.datetime()
const byteCount = z.number().int().min(0)

// ── Errors ───────────────────────────────────────────────────────────────────

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
export type ApiErrorBody = z.infer<typeof apiErrorSchema>

// ── Pagination ───────────────────────────────────────────────────────────────

/** Keyset pagination: pass `nextCursor` back as `cursor` until it is `null`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  })
}
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

// ── Users & session ──────────────────────────────────────────────────────────

export const roleSchema = z.enum(['admin', 'user'])
export type Role = z.infer<typeof roleSchema>

export const userSchema = z.object({
  id,
  discordUserId: z.string(),
  displayName: z.string(),
  avatarUrl: z.url().nullable(),
  role: roleSchema,
  rootFolderId: id,
  quotaBytes: byteCount,
  usedBytes: byteCount,
})
export type User = z.infer<typeof userSchema>

export const sessionSchema = z.object({
  user: userSchema,
  /** Sent back in the `X-CSRF-Token` header on every state-changing request (§7.1). */
  csrfToken: z.string(),
})
export type Session = z.infer<typeof sessionSchema>

// ── Nodes ────────────────────────────────────────────────────────────────────

export const nodeKindSchema = z.enum(['folder', 'file'])
export type NodeKind = z.infer<typeof nodeKindSchema>

/**
 * Where a file's bytes are, as shown in the UI: still uploading, readable from
 * staging while it syncs to Discord, stored, or broken.
 */
export const syncStateSchema = z.enum(['uploading', 'syncing', 'stored', 'failed', 'lost'])
export type SyncState = z.infer<typeof syncStateSchema>

export const nodeSchema = z.object({
  id,
  parentId: id.nullable(),
  kind: nodeKindSchema,
  name: z.string(),
  /** Files only. */
  mimeType: z.string().nullable(),
  /** Files: size of the current version. Folders: total of their subtree (eventually consistent). */
  sizeBytes: byteCount,
  createdAt: timestamp,
  updatedAt: timestamp,
  /** Files only. */
  syncState: syncStateSchema.nullable(),
  /** Folders only: lets the folder tree hide the expand arrow on leaves. */
  hasChildFolders: z.boolean(),
})
export type DriveNode = z.infer<typeof nodeSchema>

export const nodePageSchema = pageSchema(nodeSchema)
export type NodePage = z.infer<typeof nodePageSchema>

/** Ancestors from the root folder down to and including the node itself. */
export const nodePathSchema = z.array(nodeSchema.pick({ id: true, name: true }))
export type NodePath = z.infer<typeof nodePathSchema>

export const sortFieldSchema = z.enum(['name', 'updatedAt', 'size'])
export type SortField = z.infer<typeof sortFieldSchema>

export const sortOrderSchema = z.enum(['asc', 'desc'])
export type SortOrder = z.infer<typeof sortOrderSchema>

export const createFolderSchema = z.object({ parentId: id, name: z.string() })
export type CreateFolderInput = z.infer<typeof createFolderSchema>

export const ensureFoldersSchema = z.object({ parentId: id, paths: z.array(z.string()).max(500) })
export type EnsureFoldersInput = z.infer<typeof ensureFoldersSchema>

/** Maps each requested path to the ID of the folder at that path. */
export const ensureFoldersResultSchema = z.record(z.string(), id)

export const updateNodeSchema = z.object({
  name: z.string().optional(),
  parentId: id.optional(),
})
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>

export const nodeIdsSchema = z.object({ ids: z.array(id).min(1).max(1000) })
export const moveNodesSchema = nodeIdsSchema.extend({ parentId: id })
export type MoveNodesInput = z.infer<typeof moveNodesSchema>

// ── Search & trash ───────────────────────────────────────────────────────────

export const searchResultSchema = nodeSchema.extend({
  /** Human-readable location of the parent folder, e.g. `My Drive / Photos`. */
  location: z.string(),
})
export type SearchResult = z.infer<typeof searchResultSchema>
export const searchPageSchema = pageSchema(searchResultSchema)

export const trashItemSchema = nodeSchema.extend({
  deletedAt: timestamp,
  /** Where the item will be restored to. */
  location: z.string(),
  /** Set when an admin trashed the item for moderation (§7.2). */
  moderationReason: z.string().nullable(),
})
export type TrashItem = z.infer<typeof trashItemSchema>
export const trashPageSchema = pageSchema(trashItemSchema)

// ── Uploads ──────────────────────────────────────────────────────────────────

export const createUploadSchema = z.object({
  parentId: id,
  name: z.string(),
  sizeBytes: byteCount,
  mimeType: z.string(),
})
export type CreateUploadInput = z.infer<typeof createUploadSchema>

export const uploadSessionSchema = z.object({
  uploadId: id,
  nodeId: id,
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().min(0),
})
export type UploadSession = z.infer<typeof uploadSessionSchema>

// ── Share links ──────────────────────────────────────────────────────────────

export const shareLinkSchema = z.object({
  id,
  nodeId: id,
  nodeName: z.string(),
  nodeKind: nodeKindSchema,
  /** Full public URL. Only returned when the link is created, since only the token hash is stored (§7.5). */
  url: z.url().nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  hasPassword: z.boolean(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().min(0),
  revokedAt: timestamp.nullable(),
})
export type ShareLink = z.infer<typeof shareLinkSchema>
export const shareLinkPageSchema = pageSchema(shareLinkSchema)

export const createShareSchema = z.object({
  nodeId: id,
  expiresAt: timestamp.nullable(),
  password: z.string().min(4).nullable(),
  maxDownloads: z.number().int().positive().nullable(),
})
export type CreateShareInput = z.infer<typeof createShareSchema>

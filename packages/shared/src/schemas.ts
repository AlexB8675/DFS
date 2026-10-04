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

export const createUploadBatchSchema = z.object({
  uploads: z.array(createUploadSchema).min(1).max(500),
})
export type CreateUploadBatchInput = z.infer<typeof createUploadBatchSchema>

/**
 * `POST /uploads/batch` answers per upload, in request order, because a batch
 * can partly fail: a name may be invalid, or the quota may run out halfway.
 */
export const uploadBatchResultSchema = z.object({
  results: z.array(
    z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), session: uploadSessionSchema }),
      z.object({ ok: z.literal(false), error: apiErrorSchema.shape.error }),
    ]),
  ),
})
export type UploadBatchResult = z.infer<typeof uploadBatchResultSchema>

/** `GET /uploads/:id`: the parts the server already has, so a resumed upload sends only the rest. */
export const uploadStatusSchema = uploadSessionSchema.extend({
  receivedParts: z.array(z.number().int().min(0)),
})
export type UploadSessionStatus = z.infer<typeof uploadStatusSchema>

// ── Downloads ────────────────────────────────────────────────────────────────

/**
 * `POST /archive {ids}` answers with a short-lived, single-use link that
 * streams the ZIP. The browser then downloads it with a plain navigation, so
 * the download manager shows progress and nothing is buffered in memory.
 */
export const archiveTicketSchema = z.object({
  url: z.string().startsWith('/api/archive/'),
  fileName: z.string(),
  expiresAt: timestamp,
})
export type ArchiveTicket = z.infer<typeof archiveTicketSchema>

// ── Live events (`GET /events`, §6.1) ────────────────────────────────────────

/**
 * Server-sent events: the SSE `event` field is the key, `data` is the JSON
 * payload. Payloads carry enough to update the UI in place: which files
 * synced and where they are, which folders changed, the new quota use.
 */
export const liveEventSchemas = {
  /** Files whose sync state changed, e.g. a pack reached Discord. */
  'nodes.synced': z.object({
    nodes: z.array(z.object({ id, parentId: id, syncState: syncStateSchema })),
  }),
  /** Folders whose contents changed in the background; their listings are stale. */
  'nodes.changed': z.object({ parentIds: z.array(id) }),
  'quota.changed': z.object({ usedBytes: byteCount }),
  /** Sent every 25 s, so a silently dropped connection is noticed. */
  ping: z.object({}),
} as const
export type LiveEventType = keyof typeof liveEventSchemas
export type LiveEventPayload<T extends LiveEventType> = z.infer<(typeof liveEventSchemas)[T]>

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

// ── Admin (§9, read-only metadata per D4) ────────────────────────────────────

const count = z.number().int().min(0)

export const adminUserSchema = userSchema.extend({
  disabled: z.boolean(),
  fileCount: count,
  createdAt: timestamp,
  lastSeenAt: timestamp.nullable(),
})
export type AdminUser = z.infer<typeof adminUserSchema>
export const adminUserPageSchema = pageSchema(adminUserSchema)

export const updateUserSchema = z.object({
  quotaBytes: byteCount.optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
})
export type UpdateUserInput = z.infer<typeof updateUserSchema>

export const usageCategorySchema = z.enum([
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'other',
])
export type UsageCategory = z.infer<typeof usageCategorySchema>

export const userUsageSchema = z.object({
  usedBytes: byteCount,
  quotaBytes: byteCount,
  fileCount: count,
  folderCount: count,
  trashBytes: byteCount,
  categories: z.array(z.object({ category: usageCategorySchema, bytes: byteCount, count })),
})
export type UserUsage = z.infer<typeof userUsageSchema>

/** `DELETE /admin/nodes/:id`: moderation trash. The owner sees the reason in their trash. */
export const moderationSchema = z.object({ reason: z.string().trim().min(3).max(500) })
export type ModerationInput = z.infer<typeof moderationSchema>

export const serviceStatusSchema = z.enum(['ok', 'degraded', 'down'])
export type ServiceStatus = z.infer<typeof serviceStatusSchema>

export const systemHealthSchema = z.object({
  checkedAt: timestamp,
  services: z.array(
    z.object({ name: z.string(), status: serviceStatusSchema, detail: z.string() }),
  ),
  queue: z.object({ pendingJobs: count, failedJobs: count, oldestPendingSeconds: count }),
  sync: z.object({
    backlogFiles: count,
    backlogBytes: byteCount,
    /** Upload rate to Discord over the last minute. */
    bytesPerSecond: z.number().min(0),
  }),
  staging: z.object({ usedBytes: byteCount, maxBytes: byteCount }),
  cache: z.object({ usedBytes: byteCount, maxBytes: byteCount, hitRate: z.number().min(0).max(1) }),
  storage: z.object({
    blobCount: count,
    packCount: count,
    storedBytes: byteCount,
    liveBytes: byteCount,
  }),
  scrubber: z.object({
    lastRunAt: timestamp.nullable(),
    checkedBlobs: count,
    totalBlobs: count,
    problems: count,
  }),
  backups: z.object({
    lastBackupAt: timestamp.nullable(),
    lastJournalFlushAt: timestamp.nullable(),
  }),
  lostBlobs: z.array(
    z.object({ blobId: id, channelName: z.string(), detectedAt: timestamp, affectedFiles: count }),
  ),
})
export type SystemHealth = z.infer<typeof systemHealthSchema>

export const storageChannelSchema = z.object({
  id,
  discordChannelId: z.string(),
  name: z.string(),
  /** Disabled channels take no new blobs; existing ones stay readable. */
  enabled: z.boolean(),
  blobCount: count,
  storedBytes: byteCount,
  createdAt: timestamp,
})
export type StorageChannel = z.infer<typeof storageChannelSchema>
export const storageChannelListSchema = z.array(storageChannelSchema)

export const createChannelSchema = z.object({
  discordChannelId: z.string().regex(/^\d{17,20}$/, 'A Discord channel ID is 17–20 digits.'),
  name: z.string().trim().min(1).max(100),
})
export type CreateChannelInput = z.infer<typeof createChannelSchema>

export const updateChannelSchema = z.object({ enabled: z.boolean() })

export const auditEntrySchema = z.object({
  id,
  at: timestamp,
  actorName: z.string(),
  action: z.string(),
  target: z.string(),
  details: z.string().nullable(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>
export const auditPageSchema = pageSchema(auditEntrySchema)

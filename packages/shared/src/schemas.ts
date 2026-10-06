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

/** Password length limits (§7.1). The maximum also caps the work argon2 does per attempt. */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

/** Stored lowercase, so signing in ignores case (§5.1). */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'A username has at least 3 characters.')
  .max(32, 'A username has at most 32 characters.')
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'Use letters, digits, dots, dashes and underscores, starting with a letter or digit.',
  )

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(64, 'A name has at most 64 characters.')

/**
 * A new password (§7.1): any characters, no rules about character classes.
 * The API also refuses the username itself and the most common passwords.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`)

export const userSchema = z.object({
  id,
  username: z.string(),
  displayName: z.string(),
  role: roleSchema,
  rootFolderId: id,
  quotaBytes: byteCount,
  usedBytes: byteCount,
})
export type User = z.infer<typeof userSchema>

/** Why a session must choose a new password first (§7.1): a first sign-in, or an admin's reset. */
export const passwordChangeSchema = z.enum(['activate', 'reset'])
export type PasswordChange = z.infer<typeof passwordChangeSchema>

/** Answered by `GET /auth/me`, `POST /auth/login` and `POST /auth/password`. */
export const sessionSchema = z.object({
  user: userSchema,
  /** Sent back in the `X-CSRF-Token` header on every state-changing request (§7.1). */
  csrfToken: z.string(),
  /**
   * Set while the session was opened with a temporary password: it can only
   * choose a new one, and every other route answers `403 password_change_required`.
   */
  passwordChange: passwordChangeSchema.nullable(),
})
export type Session = z.infer<typeof sessionSchema>

/**
 * `POST /auth/login`. Not checked against `usernameSchema`: a malformed
 * username gets the same answer as a wrong one.
 */
export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})
export type LoginInput = z.infer<typeof loginSchema>

/**
 * `POST /auth/password`. `currentPassword` may only be left out by a session
 * that must choose a password; the change ends the user's other sessions.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: passwordSchema,
})
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

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

/** `POST /nodes/lookup`: the caller's visible nodes among these; the rest are left out. */
export const lookupNodesSchema = z.object({ ids: z.array(id).min(1).max(500) })
export type LookupNodesInput = z.infer<typeof lookupNodesSchema>
export const nodeListSchema = z.object({ items: z.array(nodeSchema) })
export type NodeList = z.infer<typeof nodeListSchema>

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
  /** The file version this upload creates (D20). */
  versionId: id,
  /** True when the name matched an existing file, which gets this as a new version. */
  isNewVersion: z.boolean(),
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

/**
 * `GET /uploads/:id`: the parts the server already has, so a resumed upload
 * sends only the rest. Answers until the session expires, also once completed.
 */
export const uploadStatusSchema = uploadSessionSchema.extend({
  state: z.enum(['receiving', 'completed']),
  receivedParts: z.array(z.number().int().min(0)),
})
export type UploadSessionStatus = z.infer<typeof uploadStatusSchema>

/**
 * `POST /uploads/:id/complete`, optionally with every part's SHA-256 as the
 * client read it: a streamed upload (`PUT /uploads/:id/content`) is checked
 * here, and parts that differ are dropped to be sent again.
 */
export const completeUploadSchema = z.object({
  partSha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
})
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>

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

/** `PATCH /shares/:id`: fields left out stay as they are; `password: null` removes it. */
export const updateShareSchema = z.object({
  expiresAt: timestamp.nullable().optional(),
  password: z.string().min(4).nullable().optional(),
  maxDownloads: z.number().int().positive().nullable().optional(),
})
export type UpdateShareInput = z.infer<typeof updateShareSchema>

// ── Public share access (`/api/s/:token/*`, no login, §7.5) ─────────────────

/**
 * A node as a share page sees it: what is needed to browse and download, and
 * nothing about the owner's drive. The shared node's `parentId` is `null`.
 */
export const sharedNodeSchema = nodeSchema.pick({
  id: true,
  parentId: true,
  kind: true,
  name: true,
  mimeType: true,
  sizeBytes: true,
  updatedAt: true,
})
export type SharedNode = z.infer<typeof sharedNodeSchema>

/**
 * `GET /s/:token`. A password-protected link reveals nothing until it is
 * unlocked (`POST /s/:token/unlock`, which sets a short-lived cookie for it).
 */
export const publicShareSchema = z.discriminatedUnion('locked', [
  z.object({ locked: z.literal(true) }),
  z.object({
    locked: z.literal(false),
    root: sharedNodeSchema,
    sharedBy: z.string(),
    expiresAt: timestamp.nullable(),
    /** `null` when the link has no download limit. */
    downloadsLeft: z.number().int().min(0).nullable(),
  }),
])
export type PublicShare = z.infer<typeof publicShareSchema>

export const unlockShareSchema = z.object({ password: z.string().min(1).max(200) })

/** `GET /s/:token/children?parentId`: a page of a shared folder, with its path inside the share. */
export const sharedFolderPageSchema = pageSchema(sharedNodeSchema).extend({
  path: z.array(sharedNodeSchema.pick({ id: true, name: true })),
})
export type SharedFolderPage = z.infer<typeof sharedFolderPageSchema>

// ── Admin (§9, read-only metadata per D4) ────────────────────────────────────

const count = z.number().int().min(0)

export const adminUserSchema = userSchema.extend({
  /** The account `dfs owner` made: always an admin, never changed from the app (D28). */
  isOwner: z.boolean(),
  disabled: z.boolean(),
  /** When they first chose their own password; `null` until their first sign-in (§7.1). */
  activatedAt: timestamp.nullable(),
  /** Set while their password is a temporary one from an admin, which stops working then. */
  temporaryPasswordExpiresAt: timestamp.nullable(),
  fileCount: count,
  createdAt: timestamp,
  lastSeenAt: timestamp.nullable(),
})
export type AdminUser = z.infer<typeof adminUserSchema>
export const adminUserPageSchema = pageSchema(adminUserSchema)

/** `POST /admin/users`: the admin hands the username and temporary password to the person (D27). */
export const createUserSchema = z.object({
  username: usernameSchema,
  /** Defaults to the username. */
  displayName: displayNameSchema.optional(),
  temporaryPassword: passwordSchema,
  quotaBytes: byteCount.optional(),
  role: roleSchema.optional(),
})
export type CreateUserInput = z.infer<typeof createUserSchema>

/** `POST /admin/users/:id/password`: a new temporary password. Ends the user's sessions. */
export const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema })
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

export const updateUserSchema = z.object({
  displayName: displayNameSchema.optional(),
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

/** Something that needs an admin's attention (§16). */
export const systemAlertSchema = z.object({
  /** Stable, for telling alerts apart: `bot_down`, `lost_blobs`, `staging_full`… */
  code: z.string(),
  level: z.enum(['warning', 'critical']),
  title: z.string(),
  detail: z.string(),
})
export type SystemAlert = z.infer<typeof systemAlertSchema>

export const systemHealthSchema = z.object({
  checkedAt: timestamp,
  /** What needs attention now, critical first. */
  alerts: z.array(systemAlertSchema),
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
    z.object({
      /** A bigint identity in the database, sent as a string so it stays exact. */
      blobId: z.string(),
      channelName: z.string(),
      detectedAt: timestamp,
      affectedFiles: count,
    }),
  ),
})
export type SystemHealth = z.infer<typeof systemHealthSchema>

// ── People and access (§9) ───────────────────────────────────────────────────

/**
 * A signed-in session. `key` names it: the start of the hash the database
 * keeps of its cookie, which can't sign anyone in.
 */
export const adminSessionSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{16}$/),
  userId: id,
  userName: z.string(),
  createdAt: timestamp,
  /** When it was last used, to within a few minutes. */
  lastSeenAt: timestamp.nullable(),
  expiresAt: timestamp,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Signed in with a temporary password: it can only choose a new one. */
  limited: z.boolean(),
  /** The session asking. */
  current: z.boolean(),
  /**
   * Whether the admin asking may sign it out: not the session asking, and
   * the owner's only when the owner asks.
   */
  canSignOut: z.boolean(),
})
export type AdminSession = z.infer<typeof adminSessionSchema>
export const adminSessionListSchema = z.array(adminSessionSchema)

/** Any user's share link, as an admin sees it: never its token or URL (D4). */
export const adminShareSchema = z.object({
  id,
  nodeId: id,
  nodeName: z.string(),
  nodeKind: nodeKindSchema,
  ownerId: id,
  ownerName: z.string(),
  /** The folder it is in, for the metadata browser; `null` for a root. */
  parentId: id.nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  hasPassword: z.boolean(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: count,
  revokedAt: timestamp.nullable(),
  state: z.enum(['active', 'expired', 'used_up', 'revoked']),
})
export type AdminShare = z.infer<typeof adminShareSchema>
export const adminSharePageSchema = pageSchema(adminShareSchema)

/** An upload still receiving its parts. */
export const adminUploadSchema = z.object({
  id,
  userId: id,
  userName: z.string(),
  nodeId: id,
  fileName: z.string(),
  parentId: id.nullable(),
  sizeBytes: byteCount,
  receivedBytes: byteCount,
  createdAt: timestamp,
  /** When it is given up if it doesn't finish. */
  expiresAt: timestamp,
})
export type AdminUpload = z.infer<typeof adminUploadSchema>
export const adminUploadListSchema = z.array(adminUploadSchema)

/** `GET /admin/audit`: newest first, narrowed to some kinds of action, an actor, or a word. */
export const auditQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Prefixes of actions, comma-separated: `auth.`, or `share.,node.`. */
  actions: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z_]+(\.[a-z_]*)?$/)).max(10))
    .optional(),
  actorId: id.optional(),
  /** Words in what the entry is about or its details. */
  q: z.string().trim().max(100).optional(),
})
export type AuditQuery = z.infer<typeof auditQuerySchema>

// ── Storage control (§9) ─────────────────────────────────────────────────────

/**
 * What an admin can have the leading bot do now. Those marked in
 * `DISCORD_TASKS` need Discord storage.
 */
export const adminTaskKindSchema = z.enum([
  'channel.create',
  'discord.setup',
  'packs.seal',
  'orphans.reconcile',
  'uploads.retry',
  'deletions.retry',
  'blob.recover',
])
export type AdminTaskKind = z.infer<typeof adminTaskKindSchema>

export const DISCORD_TASKS: readonly AdminTaskKind[] = [
  'channel.create',
  'discord.setup',
  'orphans.reconcile',
  'blob.recover',
]

/** What each task is called on the page and in the audit log. */
export const ADMIN_TASK_LABELS: Record<AdminTaskKind, string> = {
  'channel.create': 'Create a storage channel',
  'discord.setup': 'Check the Discord layout',
  'packs.seal': 'Seal packs now',
  'orphans.reconcile': 'Clean up orphan messages',
  'uploads.retry': 'Retry failed uploads',
  'deletions.retry': 'Retry failing deletions',
  'blob.recover': 'Recover a lost blob',
}

/** A blob ID: a bigint identity, sent as a string so it stays exact. */
const blobId = z.string().regex(/^\d{1,18}$/)

/** `POST /admin/tasks`. */
export const adminTaskRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel.create') }),
  z.object({ kind: z.literal('discord.setup') }),
  z.object({ kind: z.literal('packs.seal') }),
  z.object({ kind: z.literal('orphans.reconcile') }),
  z.object({ kind: z.literal('uploads.retry') }),
  z.object({ kind: z.literal('deletions.retry') }),
  z.object({ kind: z.literal('blob.recover'), blobId }),
])
export type AdminTaskRequest = z.infer<typeof adminTaskRequestSchema>

export const adminTaskSchema = z.object({
  id,
  kind: adminTaskKindSchema,
  /** The blob a recovery is about. */
  blobId: blobId.nullable(),
  requestedBy: z.string(),
  state: z.enum(['pending', 'running', 'done', 'failed']),
  /** What it did, or why it failed, in a sentence. */
  result: z.string().nullable(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
})
export type AdminTask = z.infer<typeof adminTaskSchema>
export const adminTaskListSchema = z.array(adminTaskSchema)

/** `GET /admin/storage`: what is stuck between staging and Discord, and what was lost. */
export const storageStatusSchema = z.object({
  blobStore: z.enum(['discord', 'local', 'chaos']),
  /** Blobs whose upload failed: retrying with backoff, or given up after every try. */
  uploads: z.array(
    z.object({
      jobId: id,
      blobId,
      kind: z.enum(['solo', 'pack']).nullable(),
      sizeBytes: byteCount.nullable(),
      state: z.enum(['retrying', 'failed']),
      attempts: count,
      maxAttempts: count,
      error: z.string().nullable(),
      since: timestamp,
    }),
  ),
  /** Released blobs whose message the bot failed to delete; it keeps trying. */
  deletions: z.array(
    z.object({
      blobId,
      channelName: z.string().nullable(),
      attempts: count,
      error: z.string().nullable(),
    }),
  ),
  /** Blobs whose message was deleted in Discord, newest first, with the files they held. */
  lost: z.array(
    z.object({
      blobId,
      channelName: z.string().nullable(),
      detectedAt: timestamp.nullable(),
      fileCount: count,
      /** The first few, for finding them in the metadata browser. */
      files: z.array(
        z.object({
          nodeId: id,
          name: z.string(),
          ownerId: id,
          ownerName: z.string(),
          parentId: id.nullable(),
          /** Whether the file's current version is lost, rather than only older ones. */
          current: z.boolean(),
        }),
      ),
    }),
  ),
})
export type StorageStatus = z.infer<typeof storageStatusSchema>

// ── System (§15) ─────────────────────────────────────────────────────────────

/** Which service reads a setting or a secret. */
export const settingUserSchema = z.enum(['api', 'bot', 'both'])

/** `GET /admin/system`: what this DFS is, how it is set up, and its disks. */
export const systemInfoSchema = z.object({
  environment: z.enum(['development', 'test', 'production']),
  /** This database's name for itself, which its Discord messages carry (§4). */
  instanceId: z.string(),
  node: z.string(),
  apiStartedAt: timestamp,
  /**
   * The settings in effect, from a fixed list of those safe to show. One
   * read by the bot alone is as the bot has it, once it answers.
   */
  settings: z.array(
    z.object({
      key: z.string(),
      group: z.enum(['General', 'Storage', 'Disks', 'Accounts', 'Durability']),
      value: z.string(),
      set: z.boolean(),
      usedBy: settingUserSchema,
      /** For a setting both read: the bot's value, when it differs from the API's. */
      botValue: z.string().nullable(),
    }),
  ),
  /** Whether the bot answered with its own settings. */
  botSettings: z.boolean(),
  /**
   * Only whether each is set, as the service using it has it: never a
   * value. `null` for the bot's while it doesn't answer.
   */
  secrets: z.array(
    z.object({ key: z.string(), usedBy: settingUserSchema, set: z.boolean().nullable() }),
  ),
  /** As the bot has them, once it answers: the API reads them only to show them. */
  discord: z.object({
    guildId: z.string().nullable(),
    categoryName: z.string(),
    gateway: z.boolean(),
    /** Every registered channel: data, and the journal, backup and log ones. */
    channels: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['data', 'journal', 'backup', 'log']),
        discordChannelId: z.string(),
        enabled: z.boolean(),
      }),
    ),
  }),
  staging: z.object({ dir: z.string(), usedBytes: byteCount, maxBytes: byteCount }),
  /** This API instance's frame cache; `null` with local storage, which needs none. */
  frameCache: z
    .object({ dir: z.string(), usedBytes: byteCount, maxBytes: byteCount, frames: count })
    .nullable(),
})
export type SystemInfo = z.infer<typeof systemInfoSchema>

// ── PostgreSQL (§16) ─────────────────────────────────────────────────────────

/** A connection doing something: running a query, or holding a transaction open. */
export const databaseSessionSchema = z.object({
  pid: z.number().int().positive(),
  /** `dfs-api`, `dfs-bot`, `dfs-bot-queue`… */
  application: z.string(),
  /** `active`, `idle in transaction`… */
  state: z.string(),
  /** What it waits for, such as `Lock: transactionid`; `null` while it works. */
  waitingFor: z.string().nullable(),
  /** How long its query, and its transaction, have run. */
  querySeconds: z.number().min(0),
  transactionSeconds: z.number().min(0).nullable(),
  /** The start of its SQL as sent: DFS's own queries carry placeholders, not values. */
  query: z.string(),
  /** Sessions holding the locks it waits for. */
  blockedBy: z.array(z.number().int()),
})
export type DatabaseSession = z.infer<typeof databaseSessionSchema>

/** `GET /admin/database`: PostgreSQL as it is now. */
export const databaseStatusSchema = z.object({
  checkedAt: timestamp,
  version: z.string(),
  startedAt: timestamp,
  sizeBytes: byteCount,
  /** When the counts below started; they grow until statistics are reset. */
  statsSince: timestamp.nullable(),
  connections: z.object({
    /** On the whole server, against `max_connections`. */
    used: count,
    max: count,
    byApplication: z.array(
      z.object({
        application: z.string(),
        total: count,
        active: count,
        idle: count,
        idleInTransaction: count,
      }),
    ),
  }),
  /** Blocks found in memory, of all blocks read; `null` before any read. */
  cacheHitRatio: z.number().min(0).max(1).nullable(),
  commits: count,
  rollbacks: count,
  deadlocks: count,
  tempBytes: byteCount,
  sessions: z.array(databaseSessionSchema),
  /** The largest tables, with their indexes. */
  tables: z.array(
    z.object({
      name: z.string(),
      totalBytes: byteCount,
      tableBytes: byteCount,
      indexBytes: byteCount,
      rows: count,
      deadRows: count,
      lastVacuumAt: timestamp.nullable(),
      lastAnalyzeAt: timestamp.nullable(),
      seqScans: count,
      indexScans: count,
    }),
  ),
  /** Indexes no query has used since statistics started, which only cost writes. */
  unusedIndexes: z.array(z.object({ table: z.string(), name: z.string(), bytes: byteCount })),
  /** The statements that took the most time, from `pg_stat_statements`. */
  statements: z.object({
    /** `null` when available; otherwise how to make them so. */
    unavailable: z.string().nullable(),
    items: z.array(
      z.object({
        query: z.string(),
        calls: count,
        totalMs: z.number().min(0),
        meanMs: z.number().min(0),
        rows: count,
      }),
    ),
  }),
  /** Settings worth knowing when tuning, as PostgreSQL shows them. */
  settings: z.array(z.object({ name: z.string(), value: z.string() })),
})
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>

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
  /** A bigint identity in the database, sent as a string so it stays exact; also the page cursor. */
  id: z.string(),
  at: timestamp,
  actorName: z.string(),
  action: z.string(),
  target: z.string(),
  details: z.string().nullable(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>
export const auditPageSchema = pageSchema(auditEntrySchema)

// ── Internal: api ↔ bot (§6.2, never public) ─────────────────────────────────

/** `POST /internal/urls/refresh`: blobs whose CDN URLs the API needs signed. */
export const refreshUrlsSchema = z.object({
  blobIds: z.array(z.number().int().positive()).min(1).max(200),
})
export type RefreshUrlsInput = z.infer<typeof refreshUrlsSchema>
export const refreshedUrlsSchema = z.object({
  urls: z.array(z.object({ blobId: z.number(), url: z.url(), expiresAt: z.iso.datetime() })),
})
export type RefreshedUrls = z.infer<typeof refreshedUrlsSchema>

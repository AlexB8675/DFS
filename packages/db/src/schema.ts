import type { MediaInfo } from '@dfs/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// The database of DESIGN.md §5: the logical file system (nodes → versions →
// chunks) over physical storage (blobs in Discord channels), plus accounts,
// sessions, shares, uploads, the audit log and the recovery journal (§8).
//
// Column names are spelled out so the SQL in migrations and hand-written
// queries reads the same. Byte counts are `bigint` read as JS numbers, exact
// up to 8 PiB.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const bytes = (name: string) => bigint(name, { mode: 'number' })
/** User-facing IDs: time-ordered UUIDs from PostgreSQL 18 (§5.1). */
const uuidv7 = (name: string) => uuid(name).default(sql`uuidv7()`)
/** High-volume internal tables use small identity keys instead (§5.1). */
const identity = (name: string) => bigint(name, { mode: 'number' }).generatedAlwaysAsIdentity()

// ── Enums ────────────────────────────────────────────────────────────────────

export const roleEnum = pgEnum('role', ['admin', 'user'])
export const nodeKindEnum = pgEnum('node_kind', ['folder', 'file'])
export const versionStateEnum = pgEnum('version_state', [
  'uploading',
  'syncing',
  'stored',
  'failed',
  'purging',
  'purged',
])
export const blobKindEnum = pgEnum('blob_kind', ['solo', 'pack'])
export const blobStateEnum = pgEnum('blob_state', [
  'building',
  'staged',
  'uploading',
  'stored',
  'deleting',
  'deleted',
])
export const channelKindEnum = pgEnum('channel_kind', ['data', 'journal', 'backup', 'log'])
export const journalBatchStateEnum = pgEnum('journal_batch_state', ['staged', 'stored'])
export const uploadStateEnum = pgEnum('upload_state', ['receiving', 'completed'])

// ── Accounts (§7.1) ──────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuidv7('id').primaryKey(),
    /** Stored lowercase, so sign-in ignores case. */
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /** argon2id. */
    passwordHash: text('password_hash').notNull(),
    /** Set while the password is a temporary one from an admin or `dfs owner`. */
    passwordExpiresAt: timestamptz('password_expires_at'),
    /** When the user first chose their own password. */
    activatedAt: timestamptz('activated_at'),
    /** The one account `dfs owner` made (D28). */
    isOwner: boolean('is_owner').notNull().default(false),
    role: roleEnum('role').notNull().default('user'),
    quotaBytes: bytes('quota_bytes').notNull(),
    usedBytes: bytes('used_bytes').notNull().default(0),
    /** Held by in-flight uploads (§5.1). */
    reservedBytes: bytes('reserved_bytes').notNull().default(0),
    /** Set in the transaction that creates the user, right after the root folder. */
    rootNodeId: uuid('root_node_id').references((): AnyPgColumn => nodes.id),
    disabledAt: timestamptz('disabled_at'),
    /** Sign-in failures in a row, and the wait they impose (§7.1). */
    failedSignIns: integer('failed_sign_ins').notNull().default(0),
    signInLockedUntil: timestamptz('sign_in_locked_until'),
    /**
     * When someone asked for a new password for this account from the
     * sign-in page; until an admin sets one, or they sign in (§7.1).
     */
    passwordResetRequestedAt: timestamptz('password_reset_requested_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at'),
  },
  (t) => [
    uniqueIndex('users_username_key').on(t.username),
    uniqueIndex('users_one_owner')
      .on(t.isOwner)
      .where(sql`${t.isOwner}`),
    check('users_username_lowercase', sql`${t.username} = lower(${t.username})`),
    check('users_owner_is_admin', sql`NOT ${t.isOwner} OR ${t.role} = 'admin'`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the cookie's token, so the table alone can't be used to sign in. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Slides forward with use; 15 minutes while the session can only choose a password. */
    expiresAt: timestamptz('expires_at').notNull(),
    /** Where and with what it signed in, and when it was last used (every few minutes at most). */
    ip: text('ip'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamptz('last_seen_at'),
  },
  (t) => [index('sessions_user_id').on(t.userId), index('sessions_expires_at').on(t.expiresAt)],
)

// ── The file system (§5, §5.1) ───────────────────────────────────────────────

export const nodes = pgTable(
  'nodes',
  {
    id: uuidv7('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references((): AnyPgColumn => users.id),
    /** `null` only for a user's root folder. */
    parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id),
    kind: nodeKindEnum('kind').notNull(),
    name: text('name').notNull(),
    /** NFC-normalized and case-folded name: what uniqueness and search use. */
    nameKey: text('name_key').notNull(),
    /** Files: the version readers get. Moves only when an upload completes (§6.1). */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => fileVersions.id),
    mimeType: text('mime_type'),
    /** Files: size of the current version. Folder totals live in `folder_stats`. */
    sizeBytes: bytes('size_bytes').notNull().default(0),
    /** Set on the node the user trashed. */
    deletedAt: timestamptz('deleted_at'),
    /** Set on descendants of a trashed folder: that folder's ID. */
    trashedVia: uuid('trashed_via'),
    /** Set when an admin trashed the node for moderation (§7.2). */
    moderationReason: text('moderation_reason'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * "Modified", as the drive shows and sorts it (§5). A file's is its
     * current version's own modification date, as the uploading browser read
     * it, or when it was uploaded; renaming or moving it leaves it. A
     * folder's is when it was made, renamed or moved.
     */
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('nodes_unique_name')
      .on(t.parentId, t.nameKey)
      .where(sql`${t.deletedAt} IS NULL`),
    // One index per sort order of a folder listing, so every page is an index
    // scan (§5.1). Names sort naturally: `file2` before `file10`.
    index('nodes_listing_by_name')
      .on(t.parentId, t.kind, sql`${t.nameKey} COLLATE "dfs_natural"`, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('nodes_listing_by_updated')
      .on(t.parentId, t.kind, t.updatedAt, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('nodes_listing_by_size')
      .on(t.parentId, t.kind, t.sizeBytes, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('nodes_one_root_per_owner')
      .on(t.ownerId)
      .where(sql`${t.parentId} IS NULL`),
    index('nodes_name_trgm').using('gin', t.nameKey.op('gin_trgm_ops')),
    index('nodes_trash')
      .on(t.ownerId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    index('nodes_trashed_via')
      .on(t.trashedVia)
      .where(sql`${t.trashedVia} IS NOT NULL`),
    check('nodes_root_is_folder', sql`${t.parentId} IS NOT NULL OR ${t.kind} = 'folder'`),
  ],
)

export const fileVersions = pgTable(
  'file_versions',
  {
    id: uuidv7('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references((): AnyPgColumn => nodes.id),
    versionNo: integer('version_no').notNull(),
    state: versionStateEnum('state').notNull().default('uploading'),
    sizeBytes: bytes('size_bytes').notNull(),
    chunkSize: integer('chunk_size').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    chunksStored: integer('chunks_stored').notNull().default(0),
    /** SHA-256 over the chunk hashes, set when the upload completes. */
    contentHash: bytea('content_hash'),
    /** The version's data key, wrapped with the master key `key_id` (§7.3). */
    wrappedDek: bytea('wrapped_dek').notNull(),
    keyId: text('key_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * The file's own modification date, as the uploading browser read it
     * (`File.lastModified`); `null` when it didn't say, as before 0017.
     */
    modifiedAt: timestamptz('modified_at'),
  },
  (t) => [
    uniqueIndex('file_versions_number').on(t.nodeId, t.versionNo),
    index('file_versions_in_flight')
      .on(t.state)
      .where(sql`${t.state} IN ('uploading', 'syncing', 'purging')`),
  ],
)

/** One encrypted frame: a piece of one file version (§7.3). */
export const chunks = pgTable(
  'chunks',
  {
    id: identity('id').primaryKey(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => fileVersions.id),
    idx: integer('idx').notNull(),
    plainSize: integer('plain_size').notNull(),
    frameSize: integer('frame_size').notNull(),
    plainSha256: bytea('plain_sha256').notNull(),
    frameSha256: bytea('frame_sha256').notNull(),
    /** `null` until the frame is in a blob (solo, or packed). */
    blobId: bigint('blob_id', { mode: 'number' }).references(() => blobs.id),
    blobOffset: integer('blob_offset'),
    /** The frame's file in staging, until its blob is stored. */
    stagedPath: text('staged_path'),
    purgedAt: timestamptz('purged_at'),
  },
  (t) => [
    uniqueIndex('chunks_version_idx').on(t.versionId, t.idx),
    index('chunks_blob_id').on(t.blobId),
    // What staging holds, summed often for backpressure (§6.1).
    index('chunks_staged')
      .on(t.frameSize)
      .where(sql`${t.stagedPath} IS NOT NULL`),
    index('chunks_waiting_for_pack')
      .on(t.id)
      .where(sql`${t.blobId} IS NULL AND ${t.purgedAt} IS NULL`),
    check('chunks_blob_offset', sql`(${t.blobId} IS NULL) = (${t.blobOffset} IS NULL)`),
  ],
)

// ── Physical storage (§4, §5) ────────────────────────────────────────────────

/**
 * A Discord channel this environment stores in (D25). Each environment
 * registers only its own channels, and only ever touches those.
 */
export const storageChannels = pgTable(
  'storage_channels',
  {
    id: uuidv7('id').primaryKey(),
    discordChannelId: text('discord_channel_id').notNull(),
    name: text('name').notNull(),
    kind: channelKindEnum('kind').notNull().default('data'),
    /** Disabled channels take no new blobs; their blobs stay readable. */
    enabled: boolean('enabled').notNull().default(true),
    blobCount: bigint('blob_count', { mode: 'number' }).notNull().default(0),
    bytesStored: bytes('bytes_stored').notNull().default(0),
    /** The newest message the orphan reconciler has looked at (§6.1). */
    reconciledThrough: text('reconciled_through'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('storage_channels_discord_id').on(t.discordChannelId)],
)

/**
 * This database's name for itself, one row made by its migration (§4). Every
 * message it posts carries it, so it never takes another database's messages
 * for orphans of its own, even in a channel both have registered.
 */
export const instance = pgTable('instance', {
  id: text('id').primaryKey(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
})

/** One Discord attachment: a solo frame or a pack of many (§5, §6.6). */
export const blobs = pgTable(
  'blobs',
  {
    id: identity('id').primaryKey(),
    kind: blobKindEnum('kind').notNull(),
    state: blobStateEnum('state').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Bytes of frames not yet purged; compaction looks at live / size. */
    liveBytes: integer('live_bytes').notNull().default(0),
    frameCount: integer('frame_count').notNull().default(0),
    sha256: bytea('sha256'),
    channelId: uuid('channel_id').references(() => storageChannels.id),
    messageId: text('message_id'),
    attachmentId: text('attachment_id'),
    cdnUrl: text('cdn_url'),
    cdnUrlExpiresAt: timestamptz('cdn_url_expires_at'),
    /** The blob's file in staging, until it is stored. */
    stagedPath: text('staged_path'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    storedAt: timestamptz('stored_at'),
    lastVerifiedAt: timestamptz('last_verified_at'),
    /**
     * When it went to `deleting`. Its message is deleted only once every
     * journal record written by then is on Discord (§6.4).
     */
    releasedAt: timestamptz('released_at'),
  },
  (t) => [
    index('blobs_queue')
      .on(t.state)
      .where(sql`${t.state} IN ('staged', 'uploading', 'deleting')`),
    index('blobs_channel_id').on(t.channelId),
    check('blobs_released', sql`${t.state} <> 'deleting' OR ${t.releasedAt} IS NOT NULL`),
  ],
)

// ── Folder sizes (§12.1) ─────────────────────────────────────────────────────

/** Subtree totals, folded up the tree in batches, so they are eventually consistent. */
export const folderStats = pgTable('folder_stats', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  fileCount: bigint('file_count', { mode: 'number' }).notNull().default(0),
  totalBytes: bytes('total_bytes').notNull().default(0),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})

/**
 * Folders whose direct contents changed, waiting for `folder_stats` to be
 * recomputed for them and their ancestors (§12.1). Recomputing from the tree
 * stays right when a folder with pending changes is moved or trashed.
 */
export const folderStatsDirty = pgTable('folder_stats_dirty', {
  nodeId: uuid('node_id').primaryKey(),
  markedAt: timestamptz('marked_at').notNull().defaultNow(),
})

// ── Sharing and uploads ──────────────────────────────────────────────────────

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuidv7('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    /**
     * A file link's version: the one current when the link was made, which
     * it serves however the file changes since, and which is kept while the
     * link is active (§7.5, D20). `null` for a folder link, which follows its
     * files; `null` on a file link once its version was deleted, and the
     * link no longer works.
     */
    versionId: uuid('version_id').references(() => fileVersions.id, { onDelete: 'set null' }),
    /** SHA-256 of the link's token; the token itself is shown once (§7.5). */
    tokenHash: bytea('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at'),
    /** argon2id. */
    passwordHash: text('password_hash'),
    /** Bumped when the password changes, which invalidates unlock cookies. */
    passwordVersion: integer('password_version').notNull().default(0),
    maxDownloads: integer('max_downloads'),
    downloadCount: integer('download_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('share_links_token_hash').on(t.tokenHash),
    index('share_links_node_id').on(t.nodeId),
    // Whether a version is still needed: a pruning looks it up (§6.4).
    index('share_links_version_id')
      .on(t.versionId)
      .where(sql`${t.versionId} IS NOT NULL`),
  ],
)

/**
 * A multipart upload (§6.1). Received parts are the version's chunk rows,
 * so they aren't stored twice.
 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuidv7('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => fileVersions.id),
    state: uploadStateEnum('state').notNull().default('receiving'),
    reservedBytes: bytes('reserved_bytes').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** 24 h after creation; answers `GET /uploads/:id` until then, also once completed. */
    expiresAt: timestamptz('expires_at').notNull(),
    /**
     * When its page last said it is still open, or a part last arrived. An
     * upload lives in its page (§6.1): one silent for long is given up.
     */
    aliveAt: timestamptz('alive_at').notNull().defaultNow(),
  },
  (t) => [
    index('upload_sessions_user_id').on(t.userId),
    index('upload_sessions_expires_at').on(t.expiresAt),
    index('upload_sessions_idle')
      .on(t.aliveAt)
      .where(sql`${t.state} = 'receiving'`),
  ],
)

/**
 * Single-use links for a ZIP of several items (D17): kept in the database so
 * any API instance can redeem them, and only once.
 */
export const archiveTickets = pgTable('archive_tickets', {
  /** SHA-256 of the link's token. */
  tokenHash: bytea('token_hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  nodeIds: uuid('node_ids').array().notNull(),
  fileName: text('file_name').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
})

// ── Audit and recovery ───────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: identity('id').primaryKey(),
    /** Who did it; `null` for the system. */
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    nodeId: uuid('node_id'),
    /** What the entry is about and its details, as the admin page shows them. */
    meta: jsonb('meta').notNull().default({}),
    at: timestamptz('at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_user_id').on(t.userId),
    // The janitor drops entries older than a year (§7.5).
    index('audit_log_at').on(t.at),
  ],
)

/**
 * The outbox of metadata changes (§8). Written last in the transaction that
 * makes the change, under an advisory lock, so `id` order is commit order.
 */
export const journal = pgTable(
  'journal',
  {
    id: identity('id').primaryKey(),
    kind: text('kind').notNull(),
    record: jsonb('record').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** The batch that carried it to Discord; `null` until flushed. */
    batchNo: bigint('batch_no', { mode: 'number' }),
  },
  (t) => [
    index('journal_unflushed')
      .on(t.id)
      .where(sql`${t.batchNo} IS NULL`),
  ],
)

/**
 * Journal batches (§8): unflushed records sealed together by the API, then
 * posted to `#dfs-journal` by the leading bot, in number order. Numbers are
 * contiguous, so recovery can tell a missing batch.
 */
export const journalBatches = pgTable(
  'journal_batches',
  {
    batchNo: bigint('batch_no', { mode: 'number' }).primaryKey(),
    /** The journal IDs it holds, first and last; IDs may have gaps. */
    firstId: bigint('first_id', { mode: 'number' }).notNull(),
    lastId: bigint('last_id', { mode: 'number' }).notNull(),
    recordCount: integer('record_count').notNull(),
    state: journalBatchStateEnum('state').notNull().default('staged'),
    /** The sealed object as posted; `null` once it is on Discord. */
    sealed: bytea('sealed'),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: bytea('sha256').notNull(),
    channelId: uuid('channel_id').references(() => storageChannels.id),
    messageId: text('message_id'),
    attachmentId: text('attachment_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    storedAt: timestamptz('stored_at'),
  },
  (t) => [
    index('journal_batches_staged')
      .on(t.batchNo)
      .where(sql`${t.state} = 'staged'`),
  ],
)

// ── Metrics (§16) ────────────────────────────────────────────────────────────

/**
 * What the processes recorded, summed per bucket of `step` seconds (a minute
 * or an hour) starting at `at`, across processes. Each flush adds to the
 * bucket's row; the leading bot drops old rows. Its migration leaves room in
 * each page, so those updates stay HOT.
 */
export const metrics = pgTable(
  'metrics',
  {
    name: text('name').notNull(),
    step: integer('step').notNull(),
    at: timestamptz('at').notNull(),
    sum: doublePrecision('sum').notNull(),
    count: doublePrecision('count').notNull(),
    max: doublePrecision('max').notNull(),
  },
  (t) => [primaryKey({ name: 'metrics_pkey', columns: [t.name, t.step, t.at] })],
)

// ── Media (§6.7) ─────────────────────────────────────────────────────────────

/**
 * What examining an audio or video version found: its media info, or why it
 * holds nothing ffmpeg reads (`problem`), so it isn't examined again. It is
 * derived, so not journaled: after a recovery, files are examined again as
 * they are played. It goes with its version.
 */
export const mediaInfo = pgTable(
  'media_info',
  {
    versionId: uuid('version_id')
      .primaryKey()
      .references(() => fileVersions.id, { onDelete: 'cascade' }),
    info: jsonb('info').$type<MediaInfo>(),
    problem: text('problem'),
    examinedAt: timestamptz('examined_at').notNull().defaultNow(),
  },
  (t) => [check('media_info_found', sql`(${t.info} IS NULL) <> (${t.problem} IS NULL)`)],
)

/**
 * Text subtitles extracted from inside a file as WebVTT (§6.7): right after
 * its upload, while it is in staging, or when first chosen. Each is sealed
 * as a journal object is (its own data key, bound to its version and
 * stream), since a stolen dump must hold no content (§7.4); or why it
 * couldn't be (`problem`), so it isn't extracted again. Derived, so not
 * journaled; it goes with its version.
 */
export const mediaSubtitles = pgTable(
  'media_subtitles',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => fileVersions.id, { onDelete: 'cascade' }),
    streamIndex: integer('stream_index').notNull(),
    sealed: bytea('sealed'),
    problem: text('problem'),
    extractedAt: timestamptz('extracted_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'media_subtitles_pkey', columns: [t.versionId, t.streamIndex] }),
    check('media_subtitles_found', sql`(${t.sealed} IS NULL) <> (${t.problem} IS NULL)`),
  ],
)

/**
 * Where each user stopped a video, or a long audio file, so it follows them
 * to another device (§10.4). Kept for the version they played: a new version
 * leaves it unused, and it goes once that version is pruned. Not journaled.
 */
export const playbackPositions = pgTable(
  'playback_positions',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => fileVersions.id, { onDelete: 'cascade' }),
    positionMs: integer('position_ms').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // By file first: deleting files is far more common than deleting users.
    primaryKey({ name: 'playback_positions_pkey', columns: [t.nodeId, t.userId] }),
    index('playback_positions_version').on(t.versionId),
    check('playback_positions_position', sql`${t.positionMs} >= 0`),
  ],
)

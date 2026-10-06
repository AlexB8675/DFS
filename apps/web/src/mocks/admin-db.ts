import {
  ADMIN_TASK_LABELS,
  type AdminSession,
  type AdminShare,
  type AdminUpload,
  type AuditQuery,
  type AdminTask,
  type AdminTaskRequest,
  type StorageStatus,
  type SystemInfo,
} from '@dfs/shared'
import type {
  AdminUser,
  AuditEntry,
  CreateChannelInput,
  CreateUserInput,
  DatabaseStatus,
  DriveNode,
  MetricSeries,
  MetricsQuery,
  NodePath,
  Page,
  ResetPasswordInput,
  StorageChannel,
  SystemHealth,
  UpdateUserInput,
  UsageCategory,
  UserUsage,
} from '@dfs/shared'
import { fileCategory, type FileCategory } from '@/lib/file-types'
import { formatBytes } from '@/lib/format'
import {
  CHUNK_SIZE,
  isVisible,
  MockApiError,
  MockDb,
  notFound,
  paginate,
  passwordProblem,
  sortNodes,
  type ListOptions,
  type MockNode,
  type MockUser,
} from './db'
import { mockDatabaseStatus } from './database'
import { mockMetrics } from './metrics'

const GB = 1024 ** 3
const DAY = 24 * 60 * 60_000
/** `DEFAULT_QUOTA_BYTES` and `TEMP_PASSWORD_DAYS` (§15). */
const DEFAULT_QUOTA_BYTES = 100 * GB
const TEMP_PASSWORD_DAYS = 7
const STAGING_MAX_BYTES = 100 * GB
const CACHE_MAX_BYTES = 5 * GB
/** How the seeded data is spread over the seeded channels, by name. */
const CHANNEL_SHARES: Record<string, number> = {
  'dfs-legacy': 0.1,
  'storage-00': 0.35,
  'storage-01': 0.35,
  'storage-02': 0.2,
}

const USAGE_CATEGORIES: Record<FileCategory, UsageCategory> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  pdf: 'document',
  text: 'document',
  code: 'document',
  spreadsheet: 'document',
  presentation: 'document',
  document: 'document',
  other: 'other',
}

/**
 * The admin side of the mock API (§9): users and quotas, a read-only view of
 * any user's metadata (D4: names, sizes and dates, never content), moderation,
 * system health, storage channels and the audit log.
 */
export class AdminMockDb extends MockDb {
  // ── Users ──────────────────────────────────────────────────────────────────

  adminUsers(): Page<AdminUser> {
    this.requireAdmin()
    const items = this.state.users
      .map((user) => this.adminUser(user))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
    return { items, nextCursor: null }
  }

  /** `POST /admin/users` (D27): the account and its root folder; active once they choose a password. */
  createUser(input: CreateUserInput): AdminUser {
    this.requireAdmin()
    if (this.state.users.some((user) => user.username === input.username)) {
      throw new MockApiError(409, 'username_taken', `The username “${input.username}” is taken.`)
    }
    const now = new Date()
    const id = crypto.randomUUID()
    const root = this.insert({ parentId: null, kind: 'folder', name: 'My Drive', ownerId: id })
    const user: MockUser = {
      id,
      username: input.username,
      password: input.temporaryPassword,
      displayName: input.displayName ?? input.username,
      role: input.role ?? 'user',
      isOwner: false,
      rootFolderId: root.id,
      quotaBytes: input.quotaBytes ?? DEFAULT_QUOTA_BYTES,
      disabled: false,
      activatedAt: null,
      temporaryPasswordExpiresAt: temporaryPasswordExpiry(now),
      createdAt: now.toISOString(),
      lastSeenAt: null,
    }
    this.state.users.push(user)
    this.audit(
      'user.created',
      user.displayName,
      `@${user.username} · ${formatBytes(user.quotaBytes)} · ${user.role === 'admin' ? 'Admin' : 'User'}`,
    )
    this.changed()
    return this.adminUser(user)
  }

  /**
   * `POST /admin/users/:id/password`: a new temporary password, which signs
   * them out everywhere. Never the owner, whose way back is `dfs owner` (D28).
   */
  resetPassword(id: string, { temporaryPassword }: ResetPasswordInput): AdminUser {
    const admin = this.requireAdmin()
    const user = this.findUser(id)
    if (user.isOwner) {
      throw new MockApiError(
        409,
        'owner_protected',
        'The owner’s password can only be reset on the server, with dfs owner.',
      )
    }
    if (user.id === admin.id) {
      throw new MockApiError(409, 'self_change', 'Change your own password in Settings.')
    }
    const problem = passwordProblem(temporaryPassword, user)
    if (problem) throw new MockApiError(400, 'password_rejected', problem)

    user.password = temporaryPassword
    user.temporaryPasswordExpiresAt = temporaryPasswordExpiry(new Date())
    this.audit('user.password_reset', user.displayName)
    this.save()
    return this.adminUser(user)
  }

  updateUser(id: string, changes: UpdateUserInput): AdminUser {
    const admin = this.requireAdmin()
    const user = this.findUser(id)
    const demotes = changes.role === 'user' || changes.disabled === true
    if (user.isOwner && demotes) {
      throw new MockApiError(
        409,
        'owner_protected',
        'The owner is always an admin and can’t be disabled.',
      )
    }
    if (id === admin.id && demotes) {
      throw new MockApiError(409, 'self_change', 'You can’t demote or disable your own account.')
    }

    const details: string[] = []
    if (changes.displayName !== undefined && changes.displayName !== user.displayName) {
      details.push(`Name ${user.displayName} → ${changes.displayName}`)
      user.displayName = changes.displayName
    }
    if (changes.quotaBytes !== undefined && changes.quotaBytes !== user.quotaBytes) {
      details.push(`Quota ${formatBytes(user.quotaBytes)} → ${formatBytes(changes.quotaBytes)}`)
      user.quotaBytes = changes.quotaBytes
    }
    if (changes.role !== undefined && changes.role !== user.role) {
      details.push(`Role ${user.role} → ${changes.role}`)
      user.role = changes.role
    }
    if (details.length > 0) this.audit('user.updated', user.displayName, details.join(', '))
    if (changes.disabled !== undefined && changes.disabled !== user.disabled) {
      user.disabled = changes.disabled
      this.audit(changes.disabled ? 'user.disabled' : 'user.enabled', user.displayName)
    }
    this.save()
    return this.adminUser(user)
  }

  userUsage(id: string): UserUsage {
    this.requireAdmin()
    const user = this.findUser(id)
    const categories = new Map<UsageCategory, { bytes: number; count: number }>()
    let fileCount = 0
    let folderCount = 0
    let trashBytes = 0
    for (const node of Object.values(this.state.nodes)) {
      if (node.ownerId !== id) continue
      if (node.kind === 'folder') {
        if (node.parentId !== null && isVisible(node)) folderCount += 1
        continue
      }
      if (!isVisible(node)) {
        trashBytes += node.sizeBytes
        continue
      }
      fileCount += 1
      const category = USAGE_CATEGORIES[fileCategory(node.name, node.mimeType)]
      const entry = categories.get(category) ?? { bytes: 0, count: 0 }
      entry.bytes += node.sizeBytes
      entry.count += 1
      categories.set(category, entry)
    }
    return {
      usedBytes: this.usedBytes(id),
      quotaBytes: user.quotaBytes,
      fileCount,
      folderCount,
      trashBytes,
      categories: [...categories]
        .map(([category, entry]) => ({ category, ...entry }))
        .sort((a, b) => b.bytes - a.bytes),
    }
  }

  // ── Read-only metadata browser ─────────────────────────────────────────────

  adminNode(id: string): DriveNode {
    this.requireAdmin()
    return this.toDto(this.anyVisibleNode(id))
  }

  adminPath(id: string): NodePath {
    this.requireAdmin()
    return this.ancestors(this.anyVisibleNode(id)).map(({ id, name }) => ({ id, name }))
  }

  adminChildren(parentId: string, options: ListOptions): Page<DriveNode> {
    this.requireAdmin()
    const parent = this.anyVisibleNode(parentId)
    if (parent.kind !== 'folder') throw notFound()
    const items = this.childrenOf(parentId).filter(
      (node) => !options.kind || node.kind === options.kind,
    )
    return paginate(sortNodes(items, options.sort, options.order), options, (node) =>
      this.toDto(node),
    )
  }

  /** Moderation trash: the owner finds the item in their trash, with the reason. */
  moderate(id: string, reason: string): void {
    this.requireAdmin()
    const node = this.anyVisibleNode(id)
    if (node.parentId === null) {
      throw new MockApiError(403, 'forbidden', 'A root folder cannot be removed.')
    }
    node.deletedAt = new Date().toISOString()
    node.moderationReason = reason
    for (const descendant of this.descendants(node.id)) descendant.trashedVia ??= node.id
    const owner = this.state.users.find((user) => user.id === node.ownerId)
    this.audit('node.moderated', `${node.name} (${owner?.displayName ?? 'unknown'})`, reason)
    this.changed()
    // Removed from under the signed-in user: their open folder updates live.
    if (node.ownerId === this.state.userId) {
      this.emit({ type: 'nodes.changed', parentIds: [node.parentId] })
    }
  }

  // ── System ─────────────────────────────────────────────────────────────────

  health(): SystemHealth {
    this.requireAdmin()
    const now = Date.now()
    const files = Object.values(this.state.nodes).filter((node) => node.kind === 'file')
    const syncing = files.filter((node) => node.syncState === 'syncing')
    const lost = files.filter((node) => node.syncState === 'lost')
    const backlogBytes = sum(syncing.map((node) => node.sizeBytes))
    const { blobCount, packCount, storedBytes } = storageStats(files)
    const jitter = (min: number, max: number) => min + Math.random() * (max - min)
    const ago = (ms: number) => new Date(now - ms).toISOString()
    const failed = files.filter((node) => node.syncState === 'failed').length
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
    // The same alerts the API raises for these figures (apps/api/src/admin/alerts.ts).
    const alerts: SystemHealth['alerts'] = []
    if (lost.length > 0) {
      alerts.push({
        code: 'lost_blobs',
        level: 'critical',
        title: plural(lost.length, 'lost blob'),
        detail: `${plural(lost.length, 'file')} can’t be downloaded: their messages were deleted in Discord.`,
      })
    }
    if (failed > 0) {
      alerts.push({
        code: 'uploads_failed',
        level: 'warning',
        title: 'Storing in Discord gave up',
        detail: `${plural(failed, 'blob')} failed every try and won’t be retried on their own.`,
      })
    }

    return {
      checkedAt: new Date(now).toISOString(),
      alerts,
      services: [
        { name: 'API', status: 'ok', detail: 'v0.5 · up 3 days' },
        { name: 'Bot', status: 'ok', detail: `Gateway ${Math.round(jitter(38, 95))} ms` },
        { name: 'Database', status: 'ok', detail: 'PostgreSQL 18 · 2.3 GB' },
        {
          name: 'Discord',
          status: lost.length > 0 ? 'degraded' : 'ok',
          detail:
            lost.length > 0
              ? `${lost.length} lost blob${lost.length === 1 ? '' : 's'}`
              : 'All blobs reachable',
        },
      ],
      queue: {
        pendingJobs: syncing.length,
        failedJobs: failed,
        oldestPendingSeconds: syncing.length > 0 ? Math.round(jitter(40, 140)) : 0,
      },
      sync: {
        backlogFiles: syncing.length,
        backlogBytes,
        bytesPerSecond: syncing.length > 0 ? jitter(3, 9) * 1024 ** 2 : 0,
      },
      staging: {
        usedBytes: Math.min(backlogBytes, STAGING_MAX_BYTES),
        maxBytes: STAGING_MAX_BYTES,
      },
      cache: {
        usedBytes: Math.round(3.4 * GB),
        maxBytes: CACHE_MAX_BYTES,
        hitRate: jitter(0.84, 0.9),
      },
      storage: { blobCount, packCount, storedBytes, liveBytes: Math.round(storedBytes * 0.96) },
      scrubber: {
        lastRunAt: ago(3 * 3_600_000),
        checkedBlobs: Math.round(blobCount * 0.62),
        totalBlobs: blobCount,
        problems: lost.length,
      },
      backups: { lastBackupAt: ago(2 * 3_600_000), lastJournalFlushAt: ago(40_000) },
      lostBlobs: this.lostFiles().map(({ blobId }) => ({
        blobId,
        channelName: 'storage-00',
        detectedAt: ago(9 * 24 * 3_600_000),
        affectedFiles: 1,
      })),
    }
  }

  // ── People and access ──────────────────────────────────────────────────────

  /** Made-up sessions an admin signed out, by key. */
  private readonly signedOutSessions = new Set<string>()

  /**
   * The mock has one real session, the signed-in one; every other active
   * user gets a made-up one, on another device, so the page has something
   * to show and to end.
   */
  adminSessions(userId?: string): AdminSession[] {
    const admin = this.requireAdmin()
    const now = Date.now()
    return this.state.users
      .filter((user) => !user.disabled && (user.id === admin.id || user.activatedAt))
      .filter((user) => !userId || user.id === userId)
      .map((user, index) => ({
        key: sessionKey(user.id),
        userId: user.id,
        userName: user.displayName,
        createdAt: new Date(now - (index + 1) * 3 * DAY).toISOString(),
        lastSeenAt: new Date(
          now - (user.id === admin.id ? 0 : (index + 1) * 2_700_000),
        ).toISOString(),
        expiresAt: new Date(now + 27 * DAY).toISOString(),
        ip: user.id === admin.id ? '127.0.0.1' : `192.168.1.${String(20 + index)}`,
        userAgent:
          index % 2 === 0
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
            : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        limited: user.temporaryPasswordExpiresAt !== null,
        current: user.id === admin.id,
      }))
      .filter((session) => !this.signedOutSessions.has(session.key))
  }

  endSession(key: string): void {
    const admin = this.requireAdmin()
    const session = this.adminSessions().find((candidate) => candidate.key === key)
    if (!session) throw new MockApiError(404, 'not_found', 'No such session.')
    if (session.current) {
      throw new MockApiError(409, 'self_change', 'That is this session: sign out instead.')
    }
    if (this.findUser(session.userId).isOwner && !admin.isOwner) {
      throw new MockApiError(409, 'owner_protected', 'Only the owner can sign the owner out.')
    }
    this.signedOutSessions.add(key)
    this.audit('session.ended', session.userName, session.ip)
    this.save()
  }

  signOutUser(userId: string): { ended: number } {
    const admin = this.requireAdmin()
    const user = this.findUser(userId)
    if (user.isOwner && !admin.isOwner) {
      throw new MockApiError(409, 'owner_protected', 'Only the owner can sign the owner out.')
    }
    const sessions = this.adminSessions(userId).filter((session) => !session.current)
    for (const session of sessions) this.signedOutSessions.add(session.key)
    this.audit('user.signed_out', user.displayName)
    this.save()
    return { ended: sessions.length }
  }

  adminShares(cursor: string | null, limit: number, active: boolean): Page<AdminShare> {
    this.requireAdmin()
    const now = Date.now()
    const all = [...this.state.shares]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .flatMap((share): AdminShare[] => {
        const node = this.state.nodes[share.nodeId]
        const owner = node && this.state.users.find((user) => user.id === node.ownerId)
        if (!node || !owner) return []
        const state = share.revokedAt
          ? 'revoked'
          : share.expiresAt && Date.parse(share.expiresAt) <= now
            ? 'expired'
            : share.maxDownloads !== null && share.downloadCount >= share.maxDownloads
              ? 'used_up'
              : 'active'
        return [
          {
            id: share.id,
            nodeId: node.id,
            nodeName: node.name,
            nodeKind: node.kind,
            ownerId: owner.id,
            ownerName: owner.displayName,
            parentId: node.parentId,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt,
            hasPassword: share.password !== null,
            maxDownloads: share.maxDownloads,
            downloadCount: share.downloadCount,
            revokedAt: share.revokedAt,
            state,
          },
        ]
      })
      .filter((share) => !active || share.state === 'active')
    const start = cursor ? all.findIndex((share) => share.id === cursor) + 1 : 0
    const items = all.slice(start, start + limit)
    const last = items.at(-1)
    return { items, nextCursor: start + limit < all.length && last ? last.id : null }
  }

  revokeShareAsAdmin(id: string): void {
    this.requireAdmin()
    const share = this.state.shares.find((candidate) => candidate.id === id)
    const node = share && this.state.nodes[share.nodeId]
    if (!share || !node) throw new MockApiError(404, 'not_found', 'No such link.')
    const owner = this.state.users.find((user) => user.id === node.ownerId)
    share.revokedAt ??= new Date().toISOString()
    this.audit('share.revoked', node.name, `${owner?.displayName ?? 'Someone'}’s link`)
    this.save()
  }

  adminUploads(): AdminUpload[] {
    this.requireAdmin()
    const now = Date.now()
    return Object.values(this.state.uploads).flatMap((upload): AdminUpload[] => {
      const node = this.state.nodes[upload.nodeId]
      const owner = node && this.state.users.find((user) => user.id === node.ownerId)
      if (upload.state !== 'receiving' || !node || !owner) return []
      const received = Object.keys(upload.receivedParts).length * upload.chunkSize
      return [
        {
          id: upload.id,
          userId: owner.id,
          userName: owner.displayName,
          nodeId: node.id,
          fileName: node.name,
          parentId: node.parentId,
          sizeBytes: upload.sizeBytes,
          receivedBytes: Math.min(received, upload.sizeBytes),
          createdAt: node.createdAt,
          expiresAt: new Date(now + DAY).toISOString(),
        },
      ]
    })
  }

  cancelUploadAsAdmin(id: string): void {
    this.requireAdmin()
    const upload = this.adminUploads().find((candidate) => candidate.id === id)
    if (!upload) throw new MockApiError(404, 'not_found', 'No such upload under way.')
    this.cancelUpload(id)
    this.audit('upload.cancelled', upload.fileName, `${upload.userName}’s upload`)
    this.save()
  }

  /** Tasks admins started, newest first; the mock finishes each at once. */
  private readonly tasks: AdminTask[] = []
  /** Whether the made-up failing deletion was tried again (and went). */
  private deletionsRetried = false

  /** What is stuck in storage, made up from the seeded failed and lost files (§9). */
  storageStatus(): StorageStatus {
    this.requireAdmin()
    const files = Object.values(this.state.nodes).filter((node) => node.kind === 'file')
    const owner = (node: MockNode) =>
      this.state.users.find((user) => user.id === node.ownerId)?.displayName ?? 'unknown'
    return {
      blobStore: 'discord',
      uploads: files
        .filter((node) => node.syncState === 'failed')
        .map((node, index) => ({
          jobId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          blobId: String(7100 + index),
          kind: node.sizeBytes < CHUNK_SIZE / 2 ? 'pack' : 'solo',
          sizeBytes: Math.min(node.sizeBytes, CHUNK_SIZE),
          state: 'failed',
          attempts: 11,
          maxAttempts: 11,
          error: 'Posting blob 7100: Discord answered 500 Internal Server Error.',
          since: node.updatedAt,
        })),
      deletions: this.deletionsRetried
        ? []
        : [
            {
              blobId: '6880',
              channelName: 'dfs-legacy',
              attempts: 4,
              error: 'Deleting blob 6880: The bot can’t see that server or channel.',
            },
          ],
      lost: this.lostFiles().map(({ blobId, node }) => ({
        blobId,
        channelName: 'storage-00',
        detectedAt: new Date(Date.now() - 9 * DAY).toISOString(),
        fileCount: 1,
        files: [
          {
            nodeId: node.id,
            name: node.name,
            ownerId: node.ownerId,
            ownerName: owner(node),
            parentId: node.parentId,
            current: true,
          },
        ],
      })),
    }
  }

  adminTasks(): AdminTask[] {
    this.requireAdmin()
    return this.tasks.slice(0, 20)
  }

  adminTask(id: string): AdminTask {
    this.requireAdmin()
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new MockApiError(404, 'not_found', 'No such task.')
    return task
  }

  /** Runs a task at once, as if the leading bot had taken it straight away. */
  startTask(request: AdminTaskRequest): AdminTask {
    const admin = this.requireAdmin()
    let result: string
    let failed = false
    switch (request.kind) {
      case 'channel.create': {
        const numbers = this.state.channels
          .map((channel) => /^storage-(\d+)$/.exec(channel.name)?.[1])
          .filter((digits) => digits !== undefined)
          .map(Number)
        const name = `storage-${String(Math.max(-1, ...numbers) + 1).padStart(2, '0')}`
        this.createChannel({ discordChannelId: String(10n ** 17n + BigInt(Date.now())), name })
        result = `Created #${name}; it takes new blobs within a minute.`
        break
      }
      case 'discord.setup':
        result = '“DFS” and its channels were already set up.'
        break
      case 'packs.seal':
        result = 'Nothing was waiting to be packed.'
        break
      case 'orphans.reconcile':
        result = 'Checked 412 messages and deleted 0 orphans.'
        break
      case 'uploads.retry': {
        const failedFiles = Object.values(this.state.nodes).filter(
          (node) => node.syncState === 'failed',
        )
        for (const node of failedFiles) {
          node.syncState = 'syncing'
          node.syncCompletesAt = Date.now() + 4000
        }
        result =
          failedFiles.length === 0
            ? 'No upload had given up.'
            : `Gave ${String(failedFiles.length)} uploads one more try, now. The failed count catches up within a minute.`
        break
      }
      case 'deletions.retry':
        result = this.deletionsRetried ? 'No deletion was failing.' : 'Deleted 1 blob.'
        this.deletionsRetried = true
        break
      case 'blob.recover': {
        const lost = this.lostFiles().find((entry) => entry.blobId === request.blobId)
        if (lost) {
          lost.node.syncState = 'stored'
          result = `Recovered blob ${request.blobId}: 1 version is readable again.`
        } else {
          failed = true
          result = `Blob ${request.blobId} isn’t lost.`
        }
        break
      }
    }
    const now = new Date().toISOString()
    const task: AdminTask = {
      id: crypto.randomUUID(),
      kind: request.kind,
      blobId: 'blobId' in request ? request.blobId : null,
      requestedBy: admin.displayName,
      state: failed ? 'failed' : 'done',
      result,
      createdAt: now,
      finishedAt: now,
    }
    this.tasks.unshift(task)
    this.audit(
      'task.started',
      ADMIN_TASK_LABELS[request.kind],
      'blobId' in request ? `blob ${request.blobId}` : undefined,
    )
    this.save()
    return task
  }

  /** Lost files, each in a blob of its own, with a blob ID like the API's. */
  private lostFiles(): { blobId: string; node: MockNode }[] {
    return Object.values(this.state.nodes)
      .filter((node) => node.kind === 'file' && node.syncState === 'lost')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node, index) => ({ blobId: String(6100 + index), node }))
  }

  /** Database connections an admin cancelled or ended, gone from the made-up list. */
  private readonly endedSessions = new Set<number>()

  /** Bytes in the made-up frame cache; clearing empties it. */
  private cachedBytes = Math.round(3.4 * GB)

  /** Made-up settings as a development stack would have them (§15). */
  systemInfo(): SystemInfo {
    this.requireAdmin()
    const setting = (
      group: SystemInfo['settings'][number]['group'],
      key: string,
      value: string,
      set = false,
    ) => ({ key, group, value, set, botValue: null })
    return {
      environment: 'development',
      instanceId: '2c750f2e9fd4',
      node: 'v24.14.1',
      apiStartedAt: new Date(Date.now() - 3 * DAY).toISOString(),
      settings: [
        setting('General', 'NODE_ENV', 'development'),
        setting('General', 'LOG_LEVEL', 'info'),
        setting('General', 'PUBLIC_BASE_URL', 'http://localhost:5173'),
        setting('Storage', 'BLOB_STORE', 'discord', true),
        setting('Storage', 'DISCORD_CATEGORY_NAME', 'DFS Dev', true),
        setting('Storage', 'DISCORD_GATEWAY', 'off', true),
        setting('Storage', 'UPLOAD_CHANNEL_CONCURRENCY', '2'),
        setting('Storage', 'PACK_MAX_WAIT_MS', '30000'),
        setting('Disks', 'STAGING_DIR', 'D:\\dfs\\.data\\staging'),
        setting('Disks', 'STAGING_MAX_BYTES', '100 GiB', true),
        setting('Disks', 'CACHE_DIR', 'D:\\dfs\\.data\\cache'),
        setting('Disks', 'CACHE_MAX_BYTES', '5 GiB'),
        setting('Accounts', 'DEFAULT_QUOTA_BYTES', '100 GiB'),
        setting('Accounts', 'VERSION_RETENTION', '3'),
        setting('Durability', 'SCRUB_REQUESTS_PER_HOUR', '600'),
      ],
      botSettings: true,
      secrets: [
        { key: 'DATABASE_URL', set: false },
        { key: 'INTERNAL_RPC_SECRET', set: false },
        { key: 'DISCORD_BOT_TOKEN', set: true },
        { key: 'MASTER_KEY_FILE', set: false },
      ],
      discord: {
        guildId: '100000000000000002',
        categoryName: 'DFS Dev',
        gateway: false,
        channels: this.state.channels.map((channel) => ({
          name: channel.name,
          kind: 'data' as const,
          discordChannelId: channel.discordChannelId,
          enabled: channel.enabled,
        })),
      },
      staging: { dir: 'D:\\dfs\\.data\\staging', usedBytes: 0, maxBytes: STAGING_MAX_BYTES },
      frameCache: {
        dir: 'D:\\dfs\\.data\\cache',
        usedBytes: this.cachedBytes,
        maxBytes: CACHE_MAX_BYTES,
        frames: Math.round(this.cachedBytes / (10 * 1024 * 1024)),
      },
    }
  }

  clearFrameCache(): { freedBytes: number } {
    this.requireAdmin()
    const freedBytes = this.cachedBytes
    this.cachedBytes = 0
    this.audit('system.cache_cleared', 'Frame cache', formatBytes(freedBytes))
    this.save()
    return { freedBytes }
  }

  vacuumTable(name: string): void {
    this.requireAdmin()
    if (!mockDatabaseStatus(this.endedSessions).tables.some((table) => table.name === name)) {
      throw new MockApiError(404, 'not_found', 'No such table.')
    }
    this.audit('database.vacuumed', name)
    this.save()
  }

  /** Made-up PostgreSQL figures (§16). */
  databaseStatus(): DatabaseStatus {
    this.requireAdmin()
    return mockDatabaseStatus(this.endedSessions)
  }

  signalSession(pid: number, how: 'cancel' | 'terminate'): void {
    this.requireAdmin()
    const session = mockDatabaseStatus(this.endedSessions).sessions.find(
      (candidate) => candidate.pid === pid,
    )
    if (!session) throw new MockApiError(404, 'not_found', 'No such database connection.')
    if (how === 'cancel' && session.state !== 'active') {
      throw new MockApiError(
        409,
        'not_running',
        'That connection isn’t running a query; end the connection to close its transaction.',
      )
    }
    this.endedSessions.add(pid)
    this.audit(
      how === 'cancel' ? 'database.query_cancelled' : 'database.session_ended',
      `${session.application} (${String(pid)})`,
    )
    this.save()
  }

  /** Made-up history that ends at the mock's figures today (§16). */
  metrics(query: MetricsQuery): MetricSeries {
    this.requireAdmin()
    const files = Object.values(this.state.nodes).filter((node) => node.kind === 'file')
    const syncing = files.filter((node) => node.syncState === 'syncing')
    const { blobCount, packCount, storedBytes } = storageStats(files)
    return mockMetrics(query, {
      'storage.bytes': storedBytes,
      'storage.live_bytes': Math.round(storedBytes * 0.96),
      'storage.blobs': blobCount,
      'storage.packs': packCount,
      'files.count': files.length,
      'files.bytes': sum(files.map((node) => node.sizeBytes)),
      'users.count': this.state.users.length,
      'sync.files': syncing.length,
      'sync.bytes': sum(syncing.map((node) => node.sizeBytes)),
      'staging.bytes': Math.min(sum(syncing.map((node) => node.sizeBytes)), STAGING_MAX_BYTES),
      'blobs.lost': files.filter((node) => node.syncState === 'lost').length,
      'queue.failed': files.filter((node) => node.syncState === 'failed').length,
    })
  }

  channels(): StorageChannel[] {
    this.requireAdmin()
    const files = Object.values(this.state.nodes).filter((node) => node.kind === 'file')
    const { blobCount, storedBytes } = storageStats(files)
    return this.state.channels.map((channel) => {
      const share = CHANNEL_SHARES[channel.name] ?? 0
      return {
        ...channel,
        blobCount: Math.round(blobCount * share),
        storedBytes: Math.round(storedBytes * share),
      }
    })
  }

  createChannel(input: CreateChannelInput): StorageChannel {
    this.requireAdmin()
    if (
      this.state.channels.some((channel) => channel.discordChannelId === input.discordChannelId)
    ) {
      throw new MockApiError(409, 'channel_exists', 'This channel is already in use.')
    }
    const channel = {
      id: crypto.randomUUID(),
      discordChannelId: input.discordChannelId,
      name: input.name.replace(/^#/, ''),
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    this.state.channels.push(channel)
    this.audit('channel.created', channel.name)
    this.save()
    return { ...channel, blobCount: 0, storedBytes: 0 }
  }

  updateChannel(id: string, enabled: boolean): StorageChannel {
    this.requireAdmin()
    const channel = this.state.channels.find((candidate) => candidate.id === id)
    if (!channel) throw notFound()
    const othersEnabled = this.state.channels.some(
      (candidate) => candidate.id !== id && candidate.enabled,
    )
    if (!enabled && !othersEnabled) {
      throw new MockApiError(409, 'last_channel', 'At least one channel must take new blobs.')
    }
    if (channel.enabled !== enabled) {
      channel.enabled = enabled
      this.audit(enabled ? 'channel.enabled' : 'channel.disabled', channel.name)
      this.save()
    }
    const listed = this.channels().find((candidate) => candidate.id === id)
    if (!listed) throw notFound()
    return listed
  }

  auditLog(query: AuditQuery): Page<AuditEntry> {
    this.requireAdmin()
    const { cursor, limit, actions, actorId, q } = query
    const actor = actorId ? this.findUser(actorId).displayName : null
    const words = q?.toLowerCase()
    const matching = this.state.audit.filter(
      (entry) =>
        (!actions?.length || actions.some((prefix) => entry.action.startsWith(prefix))) &&
        (actor === null || entry.actorName === actor) &&
        (!words ||
          entry.target.toLowerCase().includes(words) ||
          (entry.details ?? '').toLowerCase().includes(words)),
    )
    const start = cursor ? matching.findIndex((entry) => entry.id === cursor) + 1 : 0
    const items = matching.slice(start, start + limit)
    const last = items.at(-1)
    const hasMore = start + limit < matching.length
    return { items, nextCursor: hasMore && last ? last.id : null }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireAdmin(): MockUser {
    const user = this.currentUser()
    if (user.role !== 'admin') throw new MockApiError(403, 'forbidden', 'Admins only.')
    return user
  }

  private findUser(id: string): MockUser {
    const user = this.state.users.find((candidate) => candidate.id === id)
    if (!user) throw notFound()
    return user
  }

  private adminUser(user: MockUser): AdminUser {
    let fileCount = 0
    for (const node of Object.values(this.state.nodes)) {
      if (node.ownerId === user.id && node.kind === 'file' && isVisible(node)) fileCount += 1
    }
    const { password: _password, ...fields } = user
    return { ...fields, usedBytes: this.usedBytes(user.id), fileCount }
  }
}

/** A made-up session's key: 16 hex digits from the user's ID. */
function sessionKey(userId: string): string {
  return userId.replaceAll('-', '').slice(-16)
}

function temporaryPasswordExpiry(from: Date): string {
  return new Date(from.getTime() + TEMP_PASSWORD_DAYS * DAY).toISOString()
}

/** Blob and pack counts as the real store would have them: big files solo, small ones packed (§6.6). */
function storageStats(files: MockNode[]) {
  const stored = files.filter((node) => node.syncState === 'stored')
  let soloBlobs = 0
  let packedBytes = 0
  for (const node of stored) {
    if (node.sizeBytes >= CHUNK_SIZE / 2) soloBlobs += Math.ceil(node.sizeBytes / CHUNK_SIZE)
    else packedBytes += node.sizeBytes
  }
  const packCount = Math.ceil(packedBytes / CHUNK_SIZE)
  return {
    blobCount: soloBlobs + packCount,
    packCount,
    storedBytes: sum(stored.map((node) => node.sizeBytes)),
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

import type {
  AdminUser,
  AuditEntry,
  CreateChannelInput,
  CreateUserInput,
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
      lostBlobs: lost.map((node) => ({
        blobId: node.id,
        channelName: 'storage-00',
        detectedAt: ago(9 * 24 * 3_600_000),
        affectedFiles: 1,
      })),
    }
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

  auditLog(cursor: string | null, limit: number): Page<AuditEntry> {
    this.requireAdmin()
    const start = cursor ? this.state.audit.findIndex((entry) => entry.id === cursor) + 1 : 0
    const items = this.state.audit.slice(start, start + limit)
    const last = items.at(-1)
    const hasMore = start + limit < this.state.audit.length
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

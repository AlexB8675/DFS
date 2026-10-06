import {
  formatBytes,
  nameKey,
  normalizeName,
  splitExtension,
  validateName,
  type AdminUser,
  type ArchiveTicket,
  type AuditEntry,
  type ChangePasswordInput,
  type CreateUploadInput,
  type DriveNode,
  type LoginInput,
  type NodeKind,
  type NodePath,
  type Page,
  type PasswordChange,
  type PublicShare,
  type SearchResult,
  type Session,
  type SharedFolderPage,
  type SharedNode,
  type ShareLink,
  type SortField,
  type SortOrder,
  type SyncState,
  type StorageChannel,
  type TrashItem,
  type UpdateShareInput,
  type UnfinishedUpload,
  type UploadBatchResult,
  type UploadSession,
  type UploadSessionStatus,
  type User,
} from '@dfs/shared'
import { createSeed } from './seed'
import { createZip, type ZipEntry } from './zip'

// An in-memory stand-in for the API's database, persisted to localStorage so
// changes survive a reload. It follows the rules of DESIGN.md §5–§6 closely
// enough to exercise the UI: unique names per folder, cycle checks on moves,
// trash and restore, keyset pagination, quotas, uploads that sync after a
// delay, ZIP archives, and the admin views of other users (read-only, D4).

export interface MockNode {
  id: string
  /** The user whose drive this is. */
  ownerId: string
  parentId: string | null
  kind: NodeKind
  name: string
  mimeType: string | null
  sizeBytes: number
  createdAt: string
  updatedAt: string
  syncState: SyncState | null
  /** When a simulated sync finishes; `null` keeps a `syncing` file syncing forever. */
  syncCompletesAt: number | null
  /** Set on the node the user trashed. */
  deletedAt: string | null
  /** Set on descendants of a trashed folder: the ID of that folder. */
  trashedVia: string | null
  moderationReason: string | null
  /** Sizes of the previous versions kept (D20); they count toward the quota (D24). */
  previousVersionBytes?: number[]
}

export interface MockShare {
  id: string
  nodeId: string
  /**
   * The link's token and password, kept in the clear because this is a mock.
   * The real API stores only the token's SHA-256 and an argon2id hash (§7.5).
   */
  token: string
  password: string | null
  createdAt: string
  expiresAt: string | null
  hasPassword: boolean
  maxDownloads: number | null
  downloadCount: number
  revokedAt: string | null
}

interface MockUpload {
  id: string
  nodeId: string
  versionId: string
  /** The upload makes a new version of an existing file (D20). */
  isNewVersion: boolean
  sizeBytes: number
  mimeType: string
  chunkSize: number
  chunkCount: number
  /** Part index → the SHA-256 it arrived with, so a part sent again is recognized. */
  /** Each received part's SHA-256, so a part sent again can be checked. */
  receivedParts: Record<number, string>
  state: 'receiving' | 'completed'
}

export type MockUser = Omit<AdminUser, 'usedBytes' | 'fileCount'> & {
  /** In the clear because this is a mock; the real API keeps an argon2id hash (§7.1). */
  password: string
}

export type MockChannel = Pick<
  StorageChannel,
  'id' | 'discordChannelId' | 'name' | 'enabled' | 'createdAt'
>

export type MockAuditEntry = AuditEntry

export interface MockFileContent {
  name: string
  mimeType: string
  body: Uint8Array
}

export interface MockState {
  version: number
  /** The signed-in user, or the last one while signed out. */
  userId: string
  users: MockUser[]
  signedIn: boolean
  nodes: Record<string, MockNode>
  shares: MockShare[]
  uploads: Record<string, MockUpload>
  channels: MockChannel[]
  audit: MockAuditEntry[]
}

/** Live events (§6.1), as the SSE stream sends them. */
export type MockEvent =
  | { type: 'nodes.synced'; nodes: { id: string; parentId: string; syncState: SyncState }[] }
  | { type: 'nodes.changed'; parentIds: string[] }
  | { type: 'quota.changed'; usedBytes: number }

export class MockApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const STATE_VERSION = 9
const STORAGE_KEY = 'dfs.mock-db'
/** `CHUNK_SIZE` at the 10 MiB attachment limit (§7.3). */
export const CHUNK_SIZE = 10 * 1024 * 1024 - 128 * 1024
const CSRF_TOKEN = 'mock-csrf-token'
/** Archive links from `POST /archive` work once, for a minute (§9). */
const ARCHIVE_TICKET_MS = 60_000
/** Upload sessions are given up a day after they start (§6.1). */
const UPLOAD_LIFETIME_MS = 24 * 60 * 60_000
/** `VERSION_RETENTION` (§15): previous versions kept after a new one completes. */
const VERSION_RETENTION = 3

export interface ListOptions {
  kind?: NodeKind
  sort: SortField
  order: SortOrder
  cursor?: string | null
  limit: number
}

interface Derived {
  folderSizes: Map<string, number>
  parentsOfFolders: Set<string>
}

export class MockDb {
  protected state: MockState
  private derived: Derived | null = null
  private readonly listeners = new Set<(event: MockEvent) => void>()
  private readonly archiveTickets = new Map<string, { ids: string[]; expiresAt: number }>()
  /** Share tokens unlocked with their password; the real API uses a short-lived cookie. */
  private readonly unlockedShares = new Set<string>()
  /**
   * What uploads sent, kept in memory only: parts by upload, then whole files
   * by node. After a reload a file reads as placeholder text again.
   */
  private readonly receivedBytes = new Map<string, Map<number, Uint8Array>>()
  private readonly fileBytes = new Map<string, Uint8Array>()

  constructor() {
    this.state = loadState() ?? createSeed(STATE_VERSION)
    this.expireUploads()
    this.scheduleSyncCompletions()
  }

  /**
   * Upload sessions don't survive a reload here: nothing could resume them.
   * Drops them with their half-uploaded files, as the real API's janitor
   * does after 24 h (§6.1).
   */
  private expireUploads(): void {
    const uploads = Object.values(this.state.uploads)
    if (uploads.length === 0) return
    for (const upload of uploads) {
      const node = this.state.nodes[upload.nodeId]
      if (upload.state === 'receiving' && !upload.isNewVersion && node?.syncState === 'uploading') {
        Reflect.deleteProperty(this.state.nodes, node.id)
      }
    }
    this.state.uploads = {}
    this.save()
  }

  // ── Session (§7.1) ─────────────────────────────────────────────────────────

  get signedIn(): boolean {
    return this.state.signedIn
  }

  get csrfToken(): string {
    return CSRF_TOKEN
  }

  /** Signed in with a temporary password: the session can only choose a new one. */
  get mustChangePassword(): boolean {
    return this.state.signedIn && this.currentUser().temporaryPasswordExpiresAt !== null
  }

  signIn({ username, password }: LoginInput): Session {
    const user = this.state.users.find((candidate) => candidate.username === username)
    if (user?.password !== password) {
      this.audit('auth.login_failed', `@${username}`, null, 'Unknown')
      this.save()
      throw new MockApiError(401, 'invalid_credentials', 'Wrong username or password.')
    }
    // Only someone with the right password learns these.
    if (user.disabled) {
      throw new MockApiError(
        403,
        'account_disabled',
        'This account is disabled. Ask an admin if you need it back.',
      )
    }
    const expiresAt = user.temporaryPasswordExpiresAt
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      throw new MockApiError(
        403,
        'password_expired',
        'This temporary password has expired. Ask an admin for a new one.',
      )
    }
    this.state.userId = user.id
    this.state.signedIn = true
    user.lastSeenAt = new Date().toISOString()
    this.audit('auth.login', user.displayName)
    this.save()
    return this.session()
  }

  signOut(): void {
    this.state.signedIn = false
    this.save()
  }

  /**
   * `POST /auth/password`. A session opened with a temporary password needs
   * no current password; choosing one activates a new account (§7.1).
   */
  changePassword({ currentPassword, newPassword }: ChangePasswordInput): Session {
    const user = this.currentUser()
    const temporary = user.temporaryPasswordExpiresAt !== null
    if (!temporary && currentPassword !== user.password) {
      throw new MockApiError(403, 'wrong_password', 'Your current password isn’t right.')
    }
    const problem = passwordProblem(newPassword, user)
    if (problem) throw new MockApiError(400, 'password_rejected', problem)

    user.password = newPassword
    user.temporaryPasswordExpiresAt = null
    user.activatedAt ??= new Date().toISOString()
    this.audit('auth.password_changed', user.displayName)
    this.save()
    return this.session()
  }

  session(): Session {
    const user = this.currentUser()
    return {
      user: this.publicUser(user),
      csrfToken: CSRF_TOKEN,
      passwordChange: pendingPasswordChange(user),
    }
  }

  protected currentUser(): MockUser {
    const user = this.state.users.find((candidate) => candidate.id === this.state.userId)
    if (!user) throw new MockApiError(401, 'unauthenticated', 'Sign in to continue.')
    return user
  }

  protected publicUser(user: MockUser): User {
    const { id, username, displayName, role, rootFolderId, quotaBytes } = user
    return {
      id,
      username,
      displayName,
      role,
      rootFolderId,
      quotaBytes,
      usedBytes: this.usedBytes(id),
    }
  }

  protected audit(
    action: string,
    target: string,
    details: string | null = null,
    actorName = this.currentUser().displayName,
  ): void {
    this.state.audit.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actorName,
      action,
      target,
      details,
    })
  }

  reset(): void {
    localStorage.removeItem(STORAGE_KEY)
    this.state = createSeed(STATE_VERSION)
    this.state.signedIn = true
    this.changed()
    this.scheduleSyncCompletions()
  }

  /** Tests only: every file still syncing is stored now, as the real bot would get to. */
  finishSyncs(): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.syncState === 'syncing') {
        node.syncState = 'stored'
        node.syncCompletesAt = null
      }
    }
    this.save()
  }

  // ── Events (feeds the mocked SSE stream) ───────────────────────────────────

  subscribe(listener: (event: MockEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected emit(event: MockEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  node(id: string): DriveNode {
    return this.toDto(this.visibleNode(id))
  }

  /** The visible ones among `ids`; the rest are left out. */
  lookupNodes(ids: readonly string[]): DriveNode[] {
    return [...new Set(ids)].flatMap((id) => {
      try {
        return [this.toDto(this.visibleNode(id))]
      } catch (error) {
        if (error instanceof MockApiError && error.status === 404) return []
        throw error
      }
    })
  }

  path(id: string): NodePath {
    return this.ancestors(this.visibleNode(id)).map(({ id, name }) => ({ id, name }))
  }

  children(parentId: string, options: ListOptions): Page<DriveNode> {
    const parent = this.visibleNode(parentId)
    if (parent.kind !== 'folder') throw notFound()
    const items = this.childrenOf(parentId).filter(
      (node) => !options.kind || node.kind === options.kind,
    )
    return paginate(sortNodes(items, options.sort, options.order), options, (node) =>
      this.toDto(node),
    )
  }

  search(query: string, cursor: string | null, limit: number): Page<SearchResult> {
    const needle = nameKey(query)
    if (needle.length === 0) return { items: [], nextCursor: null }
    const matches = Object.values(this.state.nodes).filter(
      (node) =>
        node.ownerId === this.state.userId &&
        node.parentId !== null &&
        isVisible(node) &&
        nameKey(node.name).includes(needle),
    )
    return paginate(sortNodes(matches, 'name', 'asc'), { cursor, limit }, (node) => ({
      ...this.toDto(node),
      location: this.location(node),
    }))
  }

  trashItems(cursor: string | null, limit: number): Page<TrashItem> {
    const trashed = Object.values(this.state.nodes)
      .filter((node) => node.ownerId === this.state.userId && node.deletedAt !== null)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    return paginate(trashed, { cursor, limit }, (node) => ({
      ...this.toDto(node),
      // A trashed folder's contents are hidden, so add them up directly.
      sizeBytes:
        node.kind === 'folder'
          ? this.descendants(node.id).reduce((total, child) => total + child.sizeBytes, 0)
          : node.sizeBytes,
      deletedAt: node.deletedAt ?? node.updatedAt,
      location: this.location(node),
      moderationReason: node.moderationReason,
    }))
  }

  fileContent(id: string): MockFileContent {
    const node = this.visibleNode(id)
    if (node.kind !== 'file') throw notFound()
    return this.contentOf(node)
  }

  /** What a file holds: the bytes uploaded in this page's lifetime, or placeholder text. */
  protected contentOf(node: MockNode): MockFileContent {
    const bytes = this.fileBytes.get(node.id)
    if (bytes)
      return { name: node.name, mimeType: node.mimeType ?? 'application/octet-stream', body: bytes }
    return {
      name: node.name,
      mimeType: 'text/plain',
      body: new TextEncoder().encode(mockContent(node)),
    }
  }

  // ── Archives (§6.2) ────────────────────────────────────────────────────────

  /** `GET /folders/:id/archive`: the folder and everything in it. */
  folderArchive(id: string): { name: string; body: Uint8Array<ArrayBuffer> } {
    const folder = this.requireFolder(id)
    return { name: `${folder.name}.zip`, body: createZip(this.zipEntries([folder])) }
  }

  /** `POST /archive`: a one-time link for a ZIP of several items. */
  createArchiveTicket(ids: string[]): ArchiveTicket {
    const nodes = ids.map((id) => this.visibleNode(id))
    const token = crypto.randomUUID().replaceAll('-', '')
    const expiresAt = Date.now() + ARCHIVE_TICKET_MS
    this.archiveTickets.set(token, { ids: nodes.map((node) => node.id), expiresAt })
    const [first] = nodes
    const parent = first?.parentId ? this.state.nodes[first.parentId] : undefined
    const prefix = parent && parent.parentId !== null ? parent.name : 'DFS'
    return {
      url: `/api/archive/${token}`,
      fileName: `${prefix} (${nodes.length} items).zip`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  /** `GET /archive/:token`: redeems the link. */
  takeArchive(token: string): Uint8Array<ArrayBuffer> {
    const ticket = this.archiveTickets.get(token)
    this.archiveTickets.delete(token)
    if (!ticket || ticket.expiresAt < Date.now()) {
      throw new MockApiError(404, 'archive_expired', 'This download link has expired.')
    }
    return createZip(this.zipEntries(ticket.ids.map((id) => this.visibleNode(id))))
  }

  private zipEntries(roots: MockNode[]): ZipEntry[] {
    const entries: ZipEntry[] = []
    const add = (node: MockNode, prefix: string) => {
      const path = `${prefix}${node.name}`
      const modifiedAt = new Date(node.updatedAt)
      if (node.kind === 'file') {
        entries.push({ path, data: this.contentOf(node).body, modifiedAt })
        return
      }
      // Folders get their own entry, so empty ones survive.
      entries.push({ path: `${path}/`, modifiedAt })
      for (const child of sortNodes(this.childrenOf(node.id), 'name', 'asc')) add(child, `${path}/`)
    }
    for (const root of roots) add(root, '')
    return entries
  }

  // ── Folder and node changes ────────────────────────────────────────────────

  createFolder(parentId: string, rawName: string): DriveNode {
    const name = checkedName(rawName)
    this.requireFolder(parentId)
    this.assertNameFree(parentId, name)
    const folder = this.insert({ parentId, kind: 'folder', name })
    this.changed()
    return this.toDto(folder)
  }

  /** `mkdir -p` for many paths at once (`POST /folders/ensure`). */
  ensureFolders(parentId: string, paths: string[]): Record<string, string> {
    this.requireFolder(parentId)
    const result: Record<string, string> = {}
    for (const path of paths) {
      let currentId = parentId
      for (const segment of path.split('/').filter(Boolean)) {
        const name = checkedName(segment)
        const existing = this.childrenOf(currentId).find(
          (node) => nameKey(node.name) === nameKey(name),
        )
        if (existing?.kind === 'file') throw nameConflict(name)
        currentId = existing?.id ?? this.insert({ parentId: currentId, kind: 'folder', name }).id
      }
      result[path] = currentId
    }
    this.changed()
    return result
  }

  update(
    id: string,
    changes: { name?: string | undefined; parentId?: string | undefined },
  ): DriveNode {
    const node = this.visibleNode(id)
    if (node.parentId === null)
      throw new MockApiError(403, 'forbidden', 'The root folder cannot be changed.')

    const name = changes.name === undefined ? node.name : checkedName(changes.name)
    const parentId = changes.parentId ?? node.parentId
    if (parentId !== node.parentId) this.assertCanMove(node, parentId)
    if (parentId !== node.parentId || nameKey(name) !== nameKey(node.name)) {
      this.assertNameFree(parentId, name, node.id)
    }

    Object.assign(node, { name, parentId, updatedAt: new Date().toISOString() })
    this.changed()
    return this.toDto(node)
  }

  move(ids: string[], parentId: string): void {
    const nodes = ids.map((id) => this.visibleNode(id))
    for (const node of nodes) {
      this.assertCanMove(node, parentId)
      if (node.parentId !== parentId) this.assertNameFree(parentId, node.name, node.id)
    }
    const now = new Date().toISOString()
    for (const node of nodes) Object.assign(node, { parentId, updatedAt: now })
    this.changed()
  }

  trash(ids: string[]): void {
    const now = new Date().toISOString()
    for (const id of ids) {
      const node = this.visibleNode(id)
      if (node.parentId === null)
        throw new MockApiError(403, 'forbidden', 'The root folder cannot be trashed.')
      node.deletedAt = now
      for (const descendant of this.descendants(node.id)) descendant.trashedVia ??= node.id
      this.audit('node.trashed', node.name)
    }
    this.changed()
  }

  restore(id: string): DriveNode {
    const node = this.state.nodes[id]
    if (!node?.deletedAt || node.ownerId !== this.state.userId) throw notFound()
    const parent = node.parentId ? this.state.nodes[node.parentId] : undefined
    const { rootFolderId } = this.currentUser()
    // Restore into the original folder if it still exists, otherwise into the root.
    if (!parent || !isVisible(parent)) node.parentId = rootFolderId
    const trashedName = node.name
    node.name = this.freeName(node.parentId ?? rootFolderId, node.name)
    this.audit(
      'node.restored',
      node.name,
      node.name === trashedName ? null : `renamed from ${trashedName}`,
    )
    node.deletedAt = null
    node.moderationReason = null
    for (const descendant of this.descendants(node.id)) {
      if (descendant.trashedVia === node.id) descendant.trashedVia = null
    }
    this.changed()
    return this.toDto(node)
  }

  deleteForever(id: string): void {
    const node = this.state.nodes[id]
    if (!node?.deletedAt || node.ownerId !== this.state.userId) throw notFound()
    this.audit('node.purged', node.name)
    this.remove(node)
    this.changed()
  }

  emptyTrash(): void {
    const trashed = Object.values(this.state.nodes).filter(
      (node) => node.ownerId === this.state.userId && node.deletedAt,
    )
    for (const node of trashed) this.audit('node.purged', node.name, 'emptied the trash')
    for (const node of trashed) {
      if (this.state.nodes[node.id]) this.remove(node)
    }
    this.changed()
  }

  // ── Uploads (§6.1) ─────────────────────────────────────────────────────────

  /** `POST /uploads/batch`: answers per upload, so one bad name doesn't sink the rest. */
  createUploads(inputs: CreateUploadInput[]): UploadBatchResult['results'] {
    return inputs.map((input) => {
      try {
        const session = this.createUpload(
          input.parentId,
          input.name,
          input.sizeBytes,
          input.mimeType,
        )
        return { ok: true as const, session }
      } catch (error) {
        if (!(error instanceof MockApiError)) throw error
        return { ok: false as const, error: { code: error.code, message: error.message } }
      }
    })
  }

  /**
   * `POST /uploads`. A name that matches a file in the folder makes a new
   * version of it (D20): the node keeps its ID and name, and readers get the
   * old version until the upload completes. A matching folder is a conflict.
   */
  createUpload(
    parentId: string,
    rawName: string,
    sizeBytes: number,
    mimeType: string,
  ): UploadSession {
    this.requireFolder(parentId)
    const name = checkedName(rawName)
    const existing = this.childrenOf(parentId).find((node) => nameKey(node.name) === nameKey(name))
    if (existing?.kind === 'folder') throw nameConflict(name)
    const user = this.currentUser()
    if (this.usedBytes(user.id) + sizeBytes > user.quotaBytes) {
      throw new MockApiError(507, 'quota_exceeded', `Not enough storage left for “${rawName}”.`)
    }
    const node =
      existing ??
      this.insert({ parentId, kind: 'file', name, mimeType, sizeBytes, syncState: 'uploading' })
    const upload: MockUpload = {
      id: crypto.randomUUID(),
      nodeId: node.id,
      versionId: crypto.randomUUID(),
      isNewVersion: existing !== undefined,
      sizeBytes,
      mimeType,
      chunkSize: CHUNK_SIZE,
      chunkCount: Math.ceil(sizeBytes / CHUNK_SIZE),
      receivedParts: {},
      state: 'receiving',
    }
    this.state.uploads[upload.id] = upload
    this.changed()
    return this.uploadSession(upload)
  }

  /** `GET /uploads/:id`: which parts arrived, for resuming; also after completion. */
  uploadStatus(uploadId: string): UploadSessionStatus {
    const upload = this.upload(uploadId)
    return {
      ...this.uploadSession(upload),
      state: upload.state,
      receivedParts: Object.keys(upload.receivedParts)
        .map(Number)
        .toSorted((a, b) => a - b),
    }
  }

  /**
   * `GET /uploads`: what a closed or reloaded page left behind, oldest first.
   * Uploads still receiving, and completed ones still syncing to Discord.
   */
  unfinishedUploads(): UnfinishedUpload[] {
    const now = Date.now()
    return Object.values(this.state.uploads)
      .flatMap((upload): UnfinishedUpload[] => {
        const node = this.state.nodes[upload.nodeId]
        if (node?.ownerId !== this.state.userId || !isVisible(node) || !node.parentId) return []
        const expiresAt = Date.parse(node.createdAt) + UPLOAD_LIFETIME_MS
        const syncing = upload.state === 'completed' && node.syncState === 'syncing'
        if (expiresAt <= now || (upload.state !== 'receiving' && !syncing)) return []
        const receivedBytes = Object.keys(upload.receivedParts).reduce(
          (total, index) =>
            total + Math.min(upload.chunkSize, upload.sizeBytes - Number(index) * upload.chunkSize),
          0,
        )
        return [
          {
            ...this.uploadSession(upload),
            state: upload.state,
            name: node.name,
            parentId: node.parentId,
            location: this.location(node),
            sizeBytes: upload.sizeBytes,
            mimeType: upload.mimeType,
            receivedBytes,
            expiresAt: new Date(expiresAt).toISOString(),
          },
        ]
      })
      .toSorted((a, b) => a.expiresAt.localeCompare(b.expiresAt))
  }

  /**
   * `PUT /uploads/:id/parts/:index`. Sending a part again is harmless, also
   * after completion, so a client whose response was lost can simply retry.
   */
  async receivePart(
    uploadId: string,
    index: number,
    body: ArrayBuffer,
    sha256: string | null,
  ): Promise<void> {
    const upload = this.upload(uploadId)
    if (!Number.isInteger(index) || index < 0 || index >= upload.chunkCount) {
      throw new MockApiError(400, 'invalid_part', 'Part index out of range.')
    }
    const hash = await sha256Hex(body)
    if (sha256 && sha256 !== hash) {
      throw new MockApiError(400, 'hash_mismatch', 'The part was corrupted in transit.')
    }
    // A part sent again is accepted with the same bytes, also after completion.
    const received = upload.receivedParts[index]
    if (received !== undefined) {
      if (received !== hash) {
        throw new MockApiError(
          409,
          'part_conflict',
          'This part was already received with other bytes.',
        )
      }
      if (upload.chunkCount === 1) this.completeUpload(uploadId)
      return
    }
    if (upload.state === 'completed') {
      throw new MockApiError(409, 'upload_completed', 'This upload is already complete.')
    }
    upload.receivedParts[index] = hash
    const parts = this.receivedBytes.get(uploadId) ?? new Map<number, Uint8Array>()
    parts.set(index, new Uint8Array(body))
    this.receivedBytes.set(uploadId, parts)
    // A single-part upload completes on its own (§6.1), saving a request per small file.
    if (upload.chunkCount === 1) this.completeUpload(uploadId)
    else this.save()
  }

  /**
   * `PUT /uploads/:id/content?from=`: every part from `from` to the end of
   * the file in one body, each taken as `receivePart` takes one. The stream
   * carries no hashes: completing the upload checks them.
   */
  async receiveStream(uploadId: string, from: number, body: ArrayBuffer): Promise<void> {
    const upload = this.upload(uploadId)
    if (!Number.isInteger(from) || from < 0 || from >= upload.chunkCount) {
      throw new MockApiError(400, 'invalid_part', 'The stream starts past the end of the file.')
    }
    if (body.byteLength !== upload.sizeBytes - from * upload.chunkSize) {
      throw new MockApiError(400, 'invalid_part', 'The stream has the wrong length.')
    }
    for (let index = from; index < upload.chunkCount; index += 1) {
      const start = (index - from) * upload.chunkSize
      await this.receivePart(uploadId, index, body.slice(start, start + upload.chunkSize), null)
    }
  }

  /**
   * `POST /uploads/:id/complete`. With `partSha256`, every part's SHA-256 as
   * the client read it, the parts are checked first: those that differ are
   * dropped, to be sent again.
   */
  completeUpload(uploadId: string, partSha256?: readonly string[]): void {
    const upload = this.upload(uploadId)
    if (partSha256) this.checkParts(uploadId, upload, partSha256)
    if (upload.state === 'completed') return
    if (Object.keys(upload.receivedParts).length !== upload.chunkCount) {
      throw new MockApiError(409, 'incomplete_upload', 'Some parts have not been uploaded yet.')
    }
    const node = this.state.nodes[upload.nodeId]
    if (node) {
      if (upload.isNewVersion) {
        node.previousVersionBytes = [node.sizeBytes, ...(node.previousVersionBytes ?? [])].slice(
          0,
          VERSION_RETENTION,
        )
        node.sizeBytes = upload.sizeBytes
        node.mimeType = upload.mimeType
      }
      node.syncState = 'syncing'
      node.syncCompletesAt = Date.now() + 2000 + Math.random() * 4000
      node.updatedAt = new Date().toISOString()
      this.scheduleSyncCompletion(node)
    }
    upload.state = 'completed'
    if (node) {
      const size = formatBytes(upload.sizeBytes)
      this.audit('upload.completed', node.name, upload.isNewVersion ? `${size}, new version` : size)
    }
    const parts = this.receivedBytes.get(uploadId)
    this.receivedBytes.delete(uploadId)
    if (parts) {
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes)
      const whole = new Uint8Array(ordered.reduce((total, bytes) => total + bytes.length, 0))
      let at = 0
      for (const bytes of ordered) {
        whole.set(bytes, at)
        at += bytes.length
      }
      this.fileBytes.set(upload.nodeId, whole)
    }
    this.changed()
  }

  private checkParts(uploadId: string, upload: MockUpload, partSha256: readonly string[]): void {
    if (partSha256.length !== upload.chunkCount) {
      throw new MockApiError(400, 'invalid_request', 'There must be a hash for every part.')
    }
    const corrupted = Object.entries(upload.receivedParts)
      .filter(([index, hash]) => partSha256[Number(index)] !== hash)
      .map(([index]) => Number(index))
    if (corrupted.length === 0) return
    if (upload.state === 'completed') {
      throw new MockApiError(409, 'part_conflict', 'This upload was completed with other bytes.')
    }
    for (const index of corrupted) {
      Reflect.deleteProperty(upload.receivedParts, index)
      this.receivedBytes.get(uploadId)?.delete(index)
    }
    this.save()
    throw new MockApiError(400, 'hash_mismatch', 'Some parts were corrupted in transit.')
  }

  /** `DELETE /uploads/:id`. A completed upload stays: its file is in the drive now. */
  cancelUpload(uploadId: string): void {
    const upload = this.state.uploads[uploadId]
    if (!upload || upload.state === 'completed') return
    const node = this.state.nodes[upload.nodeId]
    if (node && !upload.isNewVersion) this.remove(node)
    Reflect.deleteProperty(this.state.uploads, uploadId)
    this.changed()
  }

  private uploadSession(upload: MockUpload): UploadSession {
    const { id, nodeId, versionId, isNewVersion, chunkSize, chunkCount } = upload
    return { uploadId: id, nodeId, versionId, isNewVersion, chunkSize, chunkCount }
  }

  // ── Share links ────────────────────────────────────────────────────────────

  shares(): Page<ShareLink> {
    const items = [...this.state.shares]
      .filter((share) => this.state.nodes[share.nodeId]?.ownerId === this.state.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((share) => this.shareDto(share, null))
    return { items, nextCursor: null }
  }

  createShare(input: {
    nodeId: string
    expiresAt: string | null
    password: string | null
    maxDownloads: number | null
  }): ShareLink {
    this.visibleNode(input.nodeId)
    const share: MockShare = {
      id: crypto.randomUUID(),
      nodeId: input.nodeId,
      // 128 random bits, as hex (§7.5).
      token: crypto.randomUUID().replaceAll('-', ''),
      password: input.password,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      hasPassword: input.password !== null,
      maxDownloads: input.maxDownloads,
      downloadCount: 0,
      revokedAt: null,
    }
    this.state.shares.push(share)
    this.save()
    return this.shareDto(share, `${window.location.origin}/s/${share.token}`)
  }

  updateShare(id: string, changes: UpdateShareInput): ShareLink {
    const share = this.ownShare(id)
    if (share.revokedAt) {
      throw new MockApiError(409, 'share_revoked', 'A revoked link can’t be changed.')
    }
    if (changes.expiresAt !== undefined) share.expiresAt = changes.expiresAt
    if (changes.maxDownloads !== undefined) share.maxDownloads = changes.maxDownloads
    if (changes.password !== undefined) {
      share.password = changes.password
      share.hasPassword = changes.password !== null
      // A new password locks out everyone who unlocked the old one.
      this.unlockedShares.delete(share.token)
    }
    this.save()
    return this.shareDto(share, null)
  }

  revokeShare(id: string): void {
    const share = this.ownShare(id)
    share.revokedAt ??= new Date().toISOString()
    this.save()
  }

  private ownShare(id: string): MockShare {
    const share = this.state.shares.find((candidate) => candidate.id === id)
    if (!share || this.state.nodes[share.nodeId]?.ownerId !== this.state.userId) throw notFound()
    return share
  }

  // ── Public share access (§7.5, no login) ───────────────────────────────────

  /** `GET /s/:token`: nothing but "locked" until a password-protected link is unlocked. */
  publicShare(token: string): PublicShare {
    const { share, root } = this.liveShare(token, { requireUnlocked: false })
    if (share.password !== null && !this.unlockedShares.has(token)) return { locked: true }
    const owner = this.state.users.find((user) => user.id === root.ownerId)
    return {
      locked: false,
      root: { ...this.sharedNode(root), parentId: null },
      sharedBy: owner?.displayName ?? 'Someone',
      expiresAt: share.expiresAt,
      downloadsLeft:
        share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
    }
  }

  unlockShare(token: string, password: string): void {
    const { share } = this.liveShare(token, { requireUnlocked: false })
    if (share.password !== null && share.password !== password) {
      throw new MockApiError(403, 'wrong_password', 'That password isn’t right.')
    }
    this.unlockedShares.add(token)
  }

  /** `GET /s/:token/children`: a folder inside the share, with its path from the shared folder. */
  shareChildren(
    token: string,
    parentId: string | null,
    cursor: string | null,
    limit: number,
  ): SharedFolderPage {
    const { root } = this.liveShare(token)
    const folder = parentId ? this.nodeInShare(root, parentId) : root
    if (folder.kind !== 'folder') throw notFound()
    const page = paginate(
      sortNodes(this.childrenOf(folder.id), 'name', 'asc'),
      { cursor, limit },
      (node) => this.sharedNode(node),
    )
    const path = this.ancestors(folder)
    const start = path.findIndex((node) => node.id === root.id)
    return { ...page, path: path.slice(start).map(({ id, name }) => ({ id, name })) }
  }

  /**
   * `GET /s/:token/files/:id/content`. Counts toward the download limit only
   * when the request starts at byte 0, so seeking in a video doesn't use it up.
   */
  shareFileContent(token: string, id: string, fromStart: boolean): MockFileContent {
    const { share, root } = this.liveShare(token)
    const node = this.nodeInShare(root, id)
    if (node.kind !== 'file') throw notFound()
    if (fromStart) this.countDownload(share)
    return this.contentOf(node)
  }

  /** `GET /s/:token/archive?nodeId`: the shared folder, or a folder inside it, as a ZIP. */
  shareArchive(
    token: string,
    nodeId: string | null,
  ): { name: string; body: Uint8Array<ArrayBuffer> } {
    const { share, root } = this.liveShare(token)
    const folder = nodeId ? this.nodeInShare(root, nodeId) : root
    this.countDownload(share)
    return { name: `${folder.name}.zip`, body: createZip(this.zipEntries([folder])) }
  }

  /** The share behind a token, if it still works: not revoked, expired or used up. */
  private liveShare(
    token: string,
    { requireUnlocked = true } = {},
  ): { share: MockShare; root: MockNode } {
    const share = this.state.shares.find((candidate) => candidate.token === token)
    const root = share ? this.state.nodes[share.nodeId] : undefined
    if (!share || !root || !isVisible(root)) {
      throw new MockApiError(404, 'share_not_found', 'This link doesn’t exist.')
    }
    if (share.revokedAt) {
      throw new MockApiError(410, 'share_revoked', 'The owner turned this link off.')
    }
    if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
      throw new MockApiError(410, 'share_expired', 'This link has expired.')
    }
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
      throw new MockApiError(410, 'share_used_up', 'This link has reached its download limit.')
    }
    if (requireUnlocked && share.password !== null && !this.unlockedShares.has(token)) {
      throw new MockApiError(403, 'share_locked', 'Enter the password to open this link.')
    }
    return { share, root }
  }

  /** A node the share reaches: the shared node itself or something below it, not in the trash. */
  private nodeInShare(root: MockNode, id: string): MockNode {
    const node = this.state.nodes[id]
    if (!node || !isVisible(node) || !this.ancestors(node).some((n) => n.id === root.id)) {
      throw notFound()
    }
    return node
  }

  private countDownload(share: MockShare): void {
    share.downloadCount += 1
    this.save()
  }

  private sharedNode(node: MockNode): SharedNode {
    const { id, parentId, kind, name, mimeType, updatedAt } = node
    return { id, parentId, kind, name, mimeType, updatedAt, sizeBytes: this.toDto(node).sizeBytes }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  protected insert(
    fields: Pick<MockNode, 'parentId' | 'kind' | 'name'> & Partial<MockNode>,
  ): MockNode {
    const now = new Date().toISOString()
    const parent = fields.parentId ? this.state.nodes[fields.parentId] : undefined
    const node: MockNode = {
      id: crypto.randomUUID(),
      ownerId: parent?.ownerId ?? this.state.userId,
      mimeType: null,
      sizeBytes: 0,
      createdAt: now,
      updatedAt: now,
      syncState: fields.kind === 'file' ? 'stored' : null,
      syncCompletesAt: null,
      deletedAt: null,
      trashedVia: null,
      moderationReason: null,
      ...fields,
    }
    this.state.nodes[node.id] = node
    return node
  }

  private remove(node: MockNode): void {
    const doomed = new Set([
      node.id,
      ...this.descendants(node.id).map((descendant) => descendant.id),
    ])
    for (const id of doomed) Reflect.deleteProperty(this.state.nodes, id)
    this.state.shares = this.state.shares.filter((share) => !doomed.has(share.nodeId))
  }

  /** A node of the signed-in user that is not in the trash. */
  protected visibleNode(id: string): MockNode {
    const node = this.anyVisibleNode(id)
    if (node.ownerId !== this.state.userId) throw notFound()
    return node
  }

  /** Any user's node that is not in the trash (admin views). */
  protected anyVisibleNode(id: string): MockNode {
    const node = this.state.nodes[id]
    if (!node || !isVisible(node)) throw notFound()
    return node
  }

  protected requireFolder(id: string): MockNode {
    const node = this.visibleNode(id)
    if (node.kind !== 'folder')
      throw new MockApiError(400, 'not_a_folder', 'The target is not a folder.')
    return node
  }

  private upload(id: string): MockUpload {
    const upload = this.state.uploads[id]
    if (!upload) throw new MockApiError(404, 'upload_not_found', 'This upload has expired.')
    return upload
  }

  protected childrenOf(parentId: string): MockNode[] {
    return Object.values(this.state.nodes).filter(
      (node) => node.parentId === parentId && isVisible(node),
    )
  }

  /** Every node below `id`, trashed or not. */
  protected descendants(id: string): MockNode[] {
    const byParent = new Map<string, MockNode[]>()
    for (const node of Object.values(this.state.nodes)) {
      if (!node.parentId) continue
      const siblings = byParent.get(node.parentId)
      if (siblings) siblings.push(node)
      else byParent.set(node.parentId, [node])
    }

    const result: MockNode[] = []
    const pending = [id]
    for (let parentId = pending.pop(); parentId !== undefined; parentId = pending.pop()) {
      for (const child of byParent.get(parentId) ?? []) {
        result.push(child)
        if (child.kind === 'folder') pending.push(child.id)
      }
    }
    return result
  }

  protected ancestors(node: MockNode): MockNode[] {
    const chain = [node]
    let current = node
    while (current.parentId) {
      const parent = this.state.nodes[current.parentId]
      if (!parent) break
      chain.unshift(parent)
      current = parent
    }
    return chain
  }

  /** "My Drive / Photos / 2024" for the folder that contains `node`. */
  protected location(node: MockNode): string {
    const parent = node.parentId ? this.state.nodes[node.parentId] : undefined
    return parent
      ? this.ancestors(parent)
          .map((ancestor) => ancestor.name)
          .join(' / ')
      : ''
  }

  private assertNameFree(parentId: string, name: string, exceptId?: string): void {
    const key = nameKey(name)
    const clash = this.childrenOf(parentId).some(
      (node) => node.id !== exceptId && nameKey(node.name) === key,
    )
    if (clash) throw nameConflict(name)
  }

  private assertCanMove(node: MockNode, parentId: string): void {
    const target = this.requireFolder(parentId)
    if (this.ancestors(target).some((ancestor) => ancestor.id === node.id)) {
      throw new MockApiError(400, 'invalid_move', 'A folder cannot be moved into itself.')
    }
  }

  /** `name`, or `name (1)`, `name (2)`, … if it is taken in `parentId`. */
  private freeName(parentId: string, name: string): string {
    const taken = new Set(this.childrenOf(parentId).map((node) => nameKey(node.name)))
    const { base, extension } = splitExtension(name)
    let candidate = name
    for (let n = 1; taken.has(nameKey(candidate)); n += 1) candidate = `${base} (${n})${extension}`
    return candidate
  }

  protected usedBytes(userId: string): number {
    // Trashed files and previous versions count until they are purged (§6.4, D24).
    let total = 0
    for (const node of Object.values(this.state.nodes)) {
      if (node.ownerId !== userId || node.kind !== 'file') continue
      total += node.sizeBytes
      for (const bytes of node.previousVersionBytes ?? []) total += bytes
    }
    // A new version reserves its full size while it uploads.
    for (const upload of Object.values(this.state.uploads)) {
      if (upload.isNewVersion && upload.state === 'receiving') {
        if (this.state.nodes[upload.nodeId]?.ownerId === userId) total += upload.sizeBytes
      }
    }
    return total
  }

  protected toDto(node: MockNode): DriveNode {
    const derived = this.getDerived()
    const syncState =
      node.syncState === 'syncing' &&
      node.syncCompletesAt !== null &&
      node.syncCompletesAt <= Date.now()
        ? 'stored'
        : node.syncState
    return {
      id: node.id,
      parentId: node.parentId,
      kind: node.kind,
      name: node.name,
      mimeType: node.mimeType,
      sizeBytes: node.kind === 'folder' ? (derived.folderSizes.get(node.id) ?? 0) : node.sizeBytes,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      syncState,
      hasChildFolders: derived.parentsOfFolders.has(node.id),
    }
  }

  private shareDto(share: MockShare, url: string | null): ShareLink {
    const node = this.state.nodes[share.nodeId]
    // The token and password never leave the server.
    const { token: _token, password: _password, ...fields } = share
    return {
      ...fields,
      nodeName: node?.name ?? 'Deleted item',
      nodeKind: node?.kind ?? 'file',
      url,
    }
  }

  /** Folder sizes and leaf flags, recomputed lazily after changes. */
  private getDerived(): Derived {
    if (this.derived) return this.derived
    const folderSizes = new Map<string, number>()
    const parentsOfFolders = new Set<string>()
    for (const node of Object.values(this.state.nodes)) {
      if (!isVisible(node)) continue
      if (node.kind === 'folder' && node.parentId) parentsOfFolders.add(node.parentId)
      if (node.kind !== 'file') continue
      for (
        let parentId = node.parentId;
        parentId;
        parentId = this.state.nodes[parentId]?.parentId ?? null
      ) {
        folderSizes.set(parentId, (folderSizes.get(parentId) ?? 0) + node.sizeBytes)
      }
    }
    this.derived = { folderSizes, parentsOfFolders }
    return this.derived
  }

  private scheduleSyncCompletions(): void {
    for (const node of Object.values(this.state.nodes)) this.scheduleSyncCompletion(node)
  }

  private scheduleSyncCompletion(node: MockNode): void {
    if (node.syncState !== 'syncing' || node.syncCompletesAt === null) return
    const nodeId = node.id
    window.setTimeout(
      () => {
        const current = this.state.nodes[nodeId]
        if (current?.syncState !== 'syncing') return
        current.syncState = 'stored'
        current.syncCompletesAt = null
        this.save()
        if (current.ownerId === this.state.userId && current.parentId) {
          this.emit({
            type: 'nodes.synced',
            nodes: [{ id: current.id, parentId: current.parentId, syncState: 'stored' }],
          })
        }
      },
      Math.max(0, node.syncCompletesAt - Date.now()),
    )
  }

  /**
   * Call after a client-initiated change. No event is pushed: the client
   * refreshes its own data, and events are for background changes (syncs).
   */
  protected changed(): void {
    this.derived = null
    this.save()
  }

  protected save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // Quota exceeded or storage disabled: keep working in memory.
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** What a mock file contains: a line of text, since the mock stores no bytes. */
function mockContent(node: MockNode): string {
  return `Mock content of “${node.name}” (${node.sizeBytes} bytes in the real file).\n`
}

export function isVisible(node: MockNode): boolean {
  return node.deletedAt === null && node.trashedVia === null
}

function checkedName(raw: string): string {
  const name = normalizeName(raw)
  const problem = validateName(name)
  if (problem) throw new MockApiError(400, 'invalid_name', problem)
  return name
}

/** Why a session must choose a password before anything else, if it must. */
function pendingPasswordChange(user: MockUser): PasswordChange | null {
  if (user.temporaryPasswordExpiresAt === null) return null
  return user.activatedAt === null ? 'activate' : 'reset'
}

/** A small stand-in for the API's list of about 30,000 common passwords (§7.1). */
const COMMON_PASSWORDS = new Set([
  '123456789012',
  'password1234',
  'qwertyuiopas',
  'iloveyou1234',
  'passwordpassword',
  'letmein12345',
  'welcome12345',
])

/** The API's rules for a new password beyond its length (§7.1). */
export function passwordProblem(password: string, user: MockUser): string | null {
  if (password === user.password) return 'That’s the current password. Choose a new one.'
  if (password.toLowerCase() === user.username) return 'A password can’t be the username.'
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common. Choose another.'
  }
  return null
}

export function notFound(): MockApiError {
  return new MockApiError(404, 'not_found', 'This item no longer exists.')
}

function nameConflict(name: string): MockApiError {
  return new MockApiError(409, 'name_conflict', `An item named “${name}” already exists here.`)
}

/** Folders first, then by the chosen field, with name and ID as tie-breakers (§5.1). */
export function sortNodes(nodes: MockNode[], sort: SortField, order: SortOrder): MockNode[] {
  const direction = order === 'asc' ? 1 : -1
  const byName = (a: MockNode, b: MockNode) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    if (sort === 'updatedAt')
      return direction * a.updatedAt.localeCompare(b.updatedAt) || byName(a, b)
    if (sort === 'size') return direction * (a.sizeBytes - b.sizeBytes) || byName(a, b)
    return direction * byName(a, b)
  })
}

/** Keyset-style pagination: the cursor names the last item of the previous page. */
export function paginate<T>(
  sorted: MockNode[],
  options: { cursor?: string | null | undefined; limit: number },
  toItem: (node: MockNode) => T,
): Page<T> {
  const afterId = options.cursor ? decodeCursor(options.cursor) : null
  const start = afterId ? sorted.findIndex((node) => node.id === afterId) + 1 : 0
  const slice = sorted.slice(start, start + options.limit)
  const last = slice.at(-1)
  const hasMore = start + options.limit < sorted.length
  return { items: slice.map(toItem), nextCursor: hasMore && last ? encodeCursor(last.id) : null }
}

function encodeCursor(id: string): string {
  return btoa(JSON.stringify({ after: id }))
}

function decodeCursor(cursor: string): string | null {
  try {
    const parsed: unknown = JSON.parse(atob(cursor))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'after' in parsed &&
      typeof parsed.after === 'string'
    ) {
      return parsed.after
    }
  } catch {
    // Fall through.
  }
  throw new MockApiError(400, 'invalid_cursor', 'Invalid pagination cursor.')
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function loadState(): MockState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const state = JSON.parse(raw) as MockState
    return state.version === STATE_VERSION ? state : null
  } catch {
    return null
  }
}

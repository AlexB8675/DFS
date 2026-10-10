import {
  decodeSubtitles,
  fileCategory,
  formatBytes,
  isTextSubtitles,
  coverFileRank,
  MAX_AUDIO_QUEUE,
  MAX_COVER_BYTES,
  MAX_SUBTITLE_FILE_BYTES,
  mediaKind,
  nameKey,
  playOrder,
  normalizeName,
  splitExtension,
  subtitleFileOf,
  subtitleFormat,
  toWebVtt,
  validateName,
  type AdminUser,
  type ArchiveTicket,
  type AudioQueue,
  type AudioTrack,
  type AuditEntry,
  type ChangePasswordInput,
  type CreateUploadInput,
  type Delivery,
  type DriveNode,
  type ExistingFile,
  type FileMedia,
  type LoginInput,
  type MediaInfo,
  type NodeKind,
  type NodePath,
  type Page,
  type PasswordChange,
  type PasswordResetRequest,
  type Playback,
  type PublicShare,
  type SearchResult,
  type Session,
  type SharedFolderPage,
  type SharedNode,
  type ShareCount,
  type ShareCountInput,
  type ShareLink,
  type SavePositionInput,
  type SubtitleFile,
  type SortField,
  type SortOrder,
  type SyncState,
  type StorageChannel,
  type StreamLink,
  type TrashItem,
  type UpdateShareInput,
  type UploadBatchResult,
  type UploadSession,
  type UploadSessionStatus,
  type User,
} from '@dfs/shared'
import { previewKind } from '@/lib/preview-kind'
import { SAMPLE_SUBTITLES, sampleMediaInfo } from './media'
import {
  sampleAudio,
  sampleCover,
  sampleImage,
  samplePdf,
  sampleText,
  sampleVideo,
} from './samples'
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
  /** A file's current version, counting from 1 (D20). */
  versionNo?: number
  /** Its ID, as an upload names it; made up from the file's for the demo's files. */
  versionId?: string
  /** Earlier versions a share link still serves (§7.5); they count toward the quota (D24). */
  earlierVersions?: MockVersion[]
}

/** An earlier version of a file, kept for a share link. */
export interface MockVersion {
  no: number
  /** Its ID while it was the file's, for a player through the link. */
  id?: string
  sizeBytes: number
  mimeType: string | null
  updatedAt: string
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
  /** A file link's version, which it serves however the file changes (§7.5); `null` for a folder. */
  versionNo: number | null
}

/** Where a player finds a file: the drive (`token: null`), or a share link. */
export interface MockPlace {
  token: string | null
  id: string
}

/** What a player plays, as `playedFile` finds it. */
interface PlayedFile {
  node: MockNode
  kind: 'video' | 'audio'
  /** The version served: a file link's own, or the file's current one. */
  versionId: string
  sizeBytes: number
  /** Subtitle files beside it are offered: in the drive and in a shared folder. */
  besideOffered: boolean
}

interface MockUpload {
  id: string
  nodeId: string
  versionId: string
  /** The upload makes a new version of an existing file (D20). */
  isNewVersion: boolean
  sizeBytes: number
  mimeType: string
  /** The file's own modification date, its "Modified" once complete. */
  modifiedAt: string | null
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
  /** The version's ETag, as the API's names its version (§6.2). */
  etag: string
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
  /** Where each user stopped a video, by `userId:nodeId` (§10.4). */
  positions?: Record<string, { versionId: string; positionMs: number }>
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

/** An upload that asked first (`ifExists: 'ask'`) found its name taken by a file. */
export class MockFileExists extends MockApiError {
  readonly existing: ExistingFile

  constructor(name: string, existing: ExistingFile) {
    super(409, 'file_exists', `“${name}” already exists here.`)
    this.existing = existing
  }
}

const STATE_VERSION = 16
const STORAGE_KEY = 'dfs.mock-db'
/** `CHUNK_SIZE` at the 20 MiB attachment limit (§7.3). */
export const CHUNK_SIZE = 20 * 1024 * 1024 - 128 * 1024
const CSRF_TOKEN = 'mock-csrf-token'
/** Archive links from `POST /archive` work once, for a minute (§9). */
const ARCHIVE_TICKET_MS = 60_000

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
  /** Earlier versions' bytes, by `${nodeId}#${versionNo}`, kept for share links. */
  private readonly versionBytes = new Map<string, Uint8Array>()

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
    // Back in: a request for a new password is moot.
    user.passwordResetRequestedAt = null
    this.audit('auth.login', user.displayName)
    this.save()
    return this.session()
  }

  /**
   * `POST /auth/password-reset`: asks the admins for a new password, by
   * username (§7.1). Answers alike whether or not the account exists, and
   * records an account's request once a quarter hour.
   */
  requestPasswordReset({ username }: PasswordResetRequest): void {
    const user = this.state.users.find((candidate) => candidate.username === username)
    if (!user || user.disabled) return
    const last = user.passwordResetRequestedAt
    if (last !== null && Date.now() - Date.parse(last) < 15 * 60_000) return
    user.passwordResetRequestedAt = new Date().toISOString()
    this.audit('auth.password_reset_requested', user.displayName, null, 'Unknown')
    this.save()
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
    user.passwordResetRequestedAt = null
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

  /**
   * Tests only: every file still syncing is stored now, and earlier versions
   * no link serves any more are gone, as the real bot would get to.
   */
  finishSyncs(): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.syncState === 'syncing') {
        node.syncState = 'stored'
        node.syncCompletesAt = null
      }
      this.dropUnneededVersions(node)
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

  /** `GET /files/:id/content`, of the version a player names if it does (`?version=`, §10.4). */
  fileContent(id: string, versionId: string | null = null): MockFileContent {
    const node = this.visibleNode(id)
    if (node.kind !== 'file') throw notFound()
    if (versionId !== null && versionId !== versionIdOf(node)) throw versionChanged()
    return this.contentOf(node)
  }

  /** What a file holds: the bytes uploaded in this page's lifetime, or made-up content. */
  protected contentOf(node: MockNode): MockFileContent {
    const bytes = this.fileBytes.get(node.id)
    const etag = versionTag(node, node.versionNo ?? 1)
    if (bytes) {
      const mimeType = node.mimeType ?? 'application/octet-stream'
      return { name: node.name, mimeType, body: bytes, etag }
    }
    return { name: node.name, ...mockContent(node, node.mimeType), etag }
  }

  // ── Audio and video (§6.7, §10.4) ──────────────────────────────────────────

  /** `GET …/media`: what the media service would find, made up. */
  media(place: MockPlace): FileMedia {
    const { node, kind, versionId, sizeBytes } = this.playedFile(place)
    if (sizeBytes === 0) return { versionId, info: null, problem: 'It’s empty.' }
    return { versionId, info: this.infoOf(node, kind), problem: null }
  }

  /**
   * What examining a file finds, made up: the sample's, with its cover, for
   * a demo file, which plays the sample; no cover for one uploaded, whose
   * bytes are its own.
   */
  private infoOf(node: MockNode, kind: 'video' | 'audio'): MediaInfo {
    const folder = node.parentId === null ? null : (this.state.nodes[node.parentId]?.name ?? null)
    const info = sampleMediaInfo(kind, node.name, folder)
    return this.fileBytes.has(node.id) ? { ...info, hasCover: false } : info
  }

  /**
   * `POST …/stream-link`: a share link's address for VLC (§6.7), made up; in
   * the drive, through the file's plain link, made when `create` says so.
   * Nothing outside this page reaches the mock, so no player could open it.
   */
  streamLink(place: MockPlace, create: boolean): { link: StreamLink; created: boolean } {
    const { node } = this.playedFile(place)
    const address = (shareId: string) => ({
      url: `${location.origin}/api/stream/s.${shareId}.0.${node.id}.mock/${encodeURIComponent(node.name)}`,
    })
    if (place.token !== null) {
      const share = this.state.shares.find((candidate) => candidate.token === place.token)
      return { link: address(share?.id ?? place.token), created: false }
    }
    const plain = this.state.shares.find(
      (share) =>
        share.nodeId === node.id && !share.hasPassword && share.versionNo === (node.versionNo ?? 1),
    )
    if (plain) return { link: address(plain.id), created: false }
    if (!create) {
      throw new MockApiError(
        404,
        'no_share_link',
        'This file has no share link for another player to play it through.',
      )
    }
    const made = this.createShare({
      nodeId: node.id,
      expiresAt: null,
      password: null,
      maxDownloads: null,
    })
    return { link: address(made.id), created: true }
  }

  /**
   * `GET …/playback`: the version, where this user stopped (a link's viewer
   * keeps theirs in the browser), the subtitle files beside it.
   */
  playback(place: MockPlace): Playback {
    const { node, versionId, besideOffered } = this.playedFile(place)
    const saved = place.token === null ? this.state.positions?.[this.positionKey(node)] : undefined
    return {
      versionId,
      positionMs: saved?.versionId === versionId ? saved.positionMs : null,
      subtitleFiles: besideOffered ? this.subtitleFilesBeside(node) : [],
    }
  }

  /** Bytes sent of a version to a player, by reader and version (§10.4). */
  private readonly deliveries = new Map<string, number>()

  /** A player's read of the version it names, through the drive (a user's) or a link. */
  recordDelivery(place: MockPlace, versionId: string, bytes: number): void {
    const key = `${this.readerOf(place)}:${versionId}`
    this.deliveries.set(key, (this.deliveries.get(key) ?? 0) + bytes)
  }

  /** `GET …/media/:versionId/delivery`: the mock sends at once, so it never waits. */
  delivery(place: MockPlace, versionId: string): Delivery {
    this.playedFile(place)
    return {
      bytes: this.deliveries.get(`${this.readerOf(place)}:${versionId}`) ?? 0,
      waitedForSourceMs: 0,
      waitedForClientMs: 0,
      running: 0,
    }
  }

  /** `PUT /files/:id/position` */
  savePosition(id: string, { versionId, positionMs }: SavePositionInput): void {
    const { node } = this.playedFile({ token: null, id })
    if (versionId !== versionIdOf(node)) throw versionChanged()
    this.state.positions = {
      ...this.state.positions,
      [this.positionKey(node)]: { versionId, positionMs },
    }
    this.save()
  }

  /** `DELETE /files/:id/position` */
  clearPosition(id: string): void {
    const { node } = this.playedFile({ token: null, id })
    if (this.state.positions) Reflect.deleteProperty(this.state.positions, this.positionKey(node))
    this.save()
  }

  /**
   * `GET …/media/:versionId/subtitles/:track`: a text stream inside the
   * video, or a subtitle file beside it, as WebVTT; none beside it through a
   * file link, which shares that file alone.
   */
  subtitles(place: MockPlace, versionId: string, track: string): string {
    const played = this.playedFile(place)
    const { node, kind } = played
    if (versionId !== played.versionId) throw versionChanged()
    const index = /^(\d+)\.vtt$/.exec(track)?.[1]
    if (index !== undefined) {
      const stream = this.infoOf(node, kind).streams.find((found) => found.index === Number(index))
      if (stream && isTextSubtitles(stream)) return SAMPLE_SUBTITLES
      throw new MockApiError(404, 'not_found', 'There are no such subtitles.')
    }
    const fileId = track.replace(/\.vtt$/i, '').toLowerCase()
    const offered = played.besideOffered ? this.subtitleFilesBeside(node) : []
    const beside = offered.find((file) => file.id === fileId)
    const subtitle = beside && this.state.nodes[beside.id]
    const format = beside && subtitleFormat(beside.name)
    if (!beside || !subtitle || !format) {
      throw new MockApiError(404, 'not_found', 'There are no such subtitles.')
    }
    return toWebVtt(decodeSubtitles(this.contentOf(subtitle).body, beside.language), format)
  }

  /**
   * `GET …/media/:versionId/cover`: the picture in an audio file's tags, else
   * one beside it (not through a file link, which shares that file alone).
   */
  cover(place: MockPlace, versionId: string): { body: Uint8Array; type: string } {
    const played = this.playedFile(place)
    if (versionId !== played.versionId) throw versionChanged()
    const inside = played.sizeBytes > 0 && this.infoOf(played.node, played.kind).hasCover
    const sample = inside ? sampleCover() : null
    if (sample) return { body: sample, type: 'image/jpeg' }
    const parentId = played.node.parentId
    const beside = played.besideOffered && parentId !== null ? this.coverBeside(parentId) : null
    if (!beside) throw new MockApiError(404, 'not_found', 'This file has no cover.')
    const { extension } = splitExtension(beside.name.toLowerCase())
    const type =
      extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return { body: this.contentOf(beside).body, type }
  }

  /** `GET /folders/:id/audio?deep=`: a folder's audio files, or everything below it, in play order. */
  audioQueue(folderId: string, deep: boolean): AudioQueue {
    return this.queueIn(this.requireFolder(folderId), deep)
  }

  /** `GET /s/:token/audio?folderId=&deep=`: the same, in the shared folder or one inside it. */
  shareAudioQueue(token: string, folderId: string | null, deep: boolean): AudioQueue {
    const { root } = this.liveShare(token)
    const folder = folderId ? this.nodeInShare(root, folderId) : root
    if (folder.kind !== 'folder') throw notFound()
    return this.queueIn(folder, deep)
  }

  private queueIn(folder: MockNode, deep: boolean): AudioQueue {
    const found: {
      node: MockNode
      name: string
      path: string[]
      disc: number | null
      track: number | null
    }[] = []
    const walk = (parent: MockNode, path: string[]) => {
      for (const child of this.childrenOf(parent.id)) {
        if (child.kind === 'folder') {
          if (deep) walk(child, [...path, child.name])
        } else if (mediaKind(child.name, child.mimeType) === 'audio' && isReady(child)) {
          const { tags } = this.infoOf(child, 'audio')
          found.push({ node: child, name: child.name, path, disc: tags.disc, track: tags.track })
        }
      }
    }
    walk(folder, [])
    const ordered = playOrder(found)
    return {
      items: ordered.slice(0, MAX_AUDIO_QUEUE).map(({ node }) => this.audioTrack(node)),
      truncated: ordered.length > MAX_AUDIO_QUEUE,
    }
  }

  /** A queued file as the media info made up for it says; an empty one has none. */
  private audioTrack(node: MockNode): AudioTrack {
    const info = node.sizeBytes > 0 ? this.infoOf(node, 'audio') : null
    return {
      id: node.id,
      name: node.name,
      versionId: versionIdOf(node),
      durationMs: info?.durationMs ?? null,
      title: info?.tags.title ?? null,
      artist: info?.tags.artist ?? null,
      album: info?.tags.album ?? null,
      hasCover:
        info?.hasCover === true ||
        (node.parentId !== null && this.coverBeside(node.parentId) !== null),
    }
  }

  /** The best picture in a folder to show as a cover beside an audio file (§6.7). */
  private coverBeside(folderId: string): MockNode | null {
    const ranked = this.childrenOf(folderId)
      .filter((node) => node.kind === 'file' && isReady(node) && node.sizeBytes > 0)
      .filter((node) => node.sizeBytes <= MAX_COVER_BYTES)
      .map((node) => ({ node, rank: coverFileRank(node.name) }))
      .filter((found): found is { node: MockNode; rank: number } => found.rank !== null)
      .sort((a, b) => a.rank - b.rank)
    return ranked[0]?.node ?? null
  }

  /** The file a player's route names: the user's, or, under a token, one the link reaches. */
  private playedFile(place: MockPlace): PlayedFile {
    if (place.token === null) {
      const node = this.visibleNode(place.id)
      return {
        node,
        kind: mediaKindOf(node),
        versionId: versionIdOf(node),
        sizeBytes: node.sizeBytes,
        besideOffered: true,
      }
    }
    const { share, root } = this.liveShare(place.token)
    const node = this.nodeInShare(root, place.id)
    const kind = mediaKindOf(node)
    // A file link plays its own version, which may be an earlier one (§7.5).
    const earlier = node.id === root.id ? this.sharedVersion(share, root) : undefined
    return {
      node,
      kind,
      versionId: earlier ? earlierVersionId(node, earlier) : versionIdOf(node),
      sizeBytes: earlier?.sizeBytes ?? node.sizeBytes,
      besideOffered: root.kind === 'folder',
    }
  }

  /** Whose reads a player's are: the user's, or a link's viewer's (one per link here; the API tells them apart by address too). */
  private readerOf(place: MockPlace): string {
    return place.token === null ? this.state.userId : `link:${this.liveShare(place.token).share.id}`
  }

  private positionKey(node: MockNode): string {
    return `${this.state.userId}:${node.id}`
  }

  private subtitleFilesBeside(video: MockNode): SubtitleFile[] {
    if (video.parentId === null) return []
    return this.childrenOf(video.parentId)
      .filter(
        (node) =>
          node.kind === 'file' &&
          (node.syncState === 'syncing' || node.syncState === 'stored') &&
          node.sizeBytes <= MAX_SUBTITLE_FILE_BYTES,
      )
      .flatMap((node) => {
        const said = subtitleFileOf(video.name, node.name)
        return said ? [{ id: node.id, name: node.name, ...said }] : []
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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

    // A file's "Modified" is its content's: a rename or move leaves it.
    Object.assign(node, { name, parentId })
    if (node.kind === 'folder') node.updatedAt = new Date().toISOString()
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
    for (const node of nodes) {
      node.parentId = parentId
      if (node.kind === 'folder') node.updatedAt = now
    }
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
          input.modifiedAt,
          input.ifExists,
        )
        return { ok: true as const, session }
      } catch (error) {
        if (!(error instanceof MockApiError)) throw error
        return {
          ok: false as const,
          error: { code: error.code, message: error.message },
          ...(error instanceof MockFileExists && { existing: error.existing }),
        }
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
    modifiedAt?: string,
    ifExists: 'ask' | 'replace' = 'replace',
  ): UploadSession {
    this.requireFolder(parentId)
    const name = checkedName(rawName)
    const existing = this.childrenOf(parentId).find((node) => nameKey(node.name) === nameKey(name))
    if (existing?.kind === 'folder') throw nameConflict(name)
    if (existing && ifExists === 'ask') {
      // A file still on its first upload has had no version yet.
      const versions = existing.syncState === 'uploading' ? 0 : (existing.versionNo ?? 1)
      const links = this.state.shares.filter(
        (share) => share.versionNo === (existing.versionNo ?? 1) && share.nodeId === existing.id,
      )
      throw new MockFileExists(name, {
        nodeId: existing.id,
        versions,
        links: links.filter((share) => isWorking(share, Date.now())).length,
      })
    }
    const user = this.currentUser()
    if (this.usedBytes(user.id) + sizeBytes > user.quotaBytes) {
      throw new MockApiError(507, 'quota_exceeded', `Not enough storage left for “${rawName}”.`)
    }
    const node =
      existing ??
      this.insert({
        parentId,
        kind: 'file',
        name,
        mimeType,
        sizeBytes,
        syncState: 'uploading',
        ...(modifiedAt && { updatedAt: modifiedAt }),
      })
    const upload: MockUpload = {
      id: crypto.randomUUID(),
      nodeId: node.id,
      versionId: crypto.randomUUID(),
      isNewVersion: existing !== undefined,
      sizeBytes,
      mimeType,
      modifiedAt: modifiedAt ?? null,
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
        // The replaced version stays while a share link serves it (§7.5).
        const replaced = node.versionNo ?? 1
        node.earlierVersions = [
          ...(node.earlierVersions ?? []),
          {
            no: replaced,
            id: versionIdOf(node),
            sizeBytes: node.sizeBytes,
            mimeType: node.mimeType,
            updatedAt: node.updatedAt,
          },
        ]
        const bytes = this.fileBytes.get(node.id)
        if (bytes) this.versionBytes.set(`${node.id}#${String(replaced)}`, bytes)
        node.versionNo = replaced + 1
        node.sizeBytes = upload.sizeBytes
        node.mimeType = upload.mimeType
        this.dropUnneededVersions(node)
      }
      node.versionId = upload.versionId
      node.syncState = 'syncing'
      node.syncCompletesAt = Date.now() + 2000 + Math.random() * 4000
      node.updatedAt = upload.modifiedAt ?? new Date().toISOString()
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
      .map((share) => this.shareDto(share))
    return { items, nextCursor: null }
  }

  /** Links to this node or anything below it, which removing it would delete (§7.2). */
  protected linksBelow(node: MockNode): MockShare[] {
    const below = new Set([
      node.id,
      ...this.descendants(node.id).map((descendant) => descendant.id),
    ])
    return this.state.shares.filter((share) => below.has(share.nodeId))
  }

  /** `POST /shares/count`: outstanding links to these items or below them, or to anything in the trash. */
  shareCount(input: ShareCountInput): ShareCount {
    const userId = this.state.userId
    const ids = 'ids' in input ? new Set(input.ids) : null
    const inScope = (node: MockNode) =>
      node.ownerId === userId &&
      (ids
        ? this.ancestors(node).some((ancestor) => ids.has(ancestor.id))
        : this.ancestors(node).some((ancestor) => ancestor.deletedAt !== null))
    const now = Date.now()
    const links = this.state.shares.filter((share) => {
      const node = this.state.nodes[share.nodeId]
      return (
        node !== undefined &&
        inScope(node) &&
        isWorking(share, now) &&
        this.shareVersion(share) !== 'deleted'
      )
    })
    return { links: links.length }
  }

  createShare(input: {
    nodeId: string
    expiresAt: string | null
    password: string | null
    maxDownloads: number | null
  }): ShareLink {
    const node = this.visibleNode(input.nodeId)
    if (node.syncState === 'uploading') {
      throw new MockApiError(409, 'not_ready', 'This file hasn’t finished uploading.')
    }
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
      versionNo: node.kind === 'file' ? (node.versionNo ?? 1) : null,
    }
    this.state.shares.push(share)
    this.save()
    return this.shareDto(share)
  }

  updateShare(id: string, changes: UpdateShareInput): ShareLink {
    const share = this.ownShare(id)
    if (this.shareVersion(share) === 'deleted') {
      throw new MockApiError(
        409,
        'share_version_deleted',
        'The version this link shared was deleted. Make a new link to share the file as it is now.',
      )
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
    return this.shareDto(share)
  }

  /** `DELETE /shares/:id`: turning a link off deletes it. */
  deleteShare(id: string): void {
    const share = this.ownShare(id)
    this.state.shares = this.state.shares.filter((candidate) => candidate !== share)
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
    const earlier = this.sharedVersion(share, root)
    return {
      locked: false,
      root: {
        ...this.sharedNode(root),
        ...(earlier && { sizeBytes: earlier.sizeBytes, updatedAt: earlier.updatedAt }),
        parentId: null,
      },
      sharedBy: owner?.displayName ?? 'Someone',
      expiresAt: share.expiresAt,
      downloadsLeft:
        share.maxDownloads === null ? null : Math.max(0, share.maxDownloads - share.downloadCount),
    }
  }

  /** A link that works and is unlocked, for a route under it that gives nothing of its own. */
  openShare(token: string): void {
    this.liveShare(token)
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
   * `GET /s/:token/files/:id/content`, which counts toward the download limit
   * only when it is a download (`countShareDownload`, §7.5).
   */
  shareFileContent(token: string, id: string, versionId: string | null = null): MockFileContent {
    const { share, root } = this.liveShare(token)
    const node = this.nodeInShare(root, id)
    if (node.kind !== 'file') throw notFound()
    // A file link serves its own version, which may be an earlier one.
    const earlier = node.id === root.id ? this.sharedVersion(share, root) : undefined
    // A player names the version it plays (§10.4).
    const served = earlier ? earlierVersionId(node, earlier) : versionIdOf(node)
    if (versionId !== null && versionId !== served) throw versionChanged()
    if (!earlier) return this.contentOf(node)
    const bytes = this.versionBytes.get(`${node.id}#${String(earlier.no)}`)
    const etag = versionTag(node, earlier.no)
    if (!bytes) return { name: node.name, ...mockContent(node, earlier.mimeType), etag }
    const mimeType = earlier.mimeType ?? 'application/octet-stream'
    return { name: node.name, mimeType, body: bytes, etag }
  }

  /** A download through a link: one less left. */
  countShareDownload(token: string): void {
    this.countDownload(this.liveShare(token).share)
  }

  /** A file link's version when it is an earlier one than the file's. */
  private sharedVersion(share: MockShare, node: MockNode): MockVersion | undefined {
    if (share.versionNo === null || share.versionNo === (node.versionNo ?? 1)) return undefined
    return node.earlierVersions?.find((version) => version.no === share.versionNo)
  }

  /** Which version a link serves, as its owner's list says (§7.5). */
  protected shareVersion(share: MockShare): ShareLink['version'] {
    const node = this.state.nodes[share.nodeId]
    if (share.versionNo === null || !node) return null
    if (share.versionNo === (node.versionNo ?? 1)) return 'current'
    return node.earlierVersions?.some((version) => version.no === share.versionNo)
      ? 'earlier'
      : 'deleted'
  }

  /** Earlier versions go once no working link serves them (§7.5, D20). */
  private dropUnneededVersions(node: MockNode): void {
    if (!node.earlierVersions?.length) return
    const now = Date.now()
    const served = new Set(
      this.state.shares
        .filter((share) => share.nodeId === node.id && isWorking(share, now))
        .map((share) => share.versionNo),
    )
    for (const version of node.earlierVersions) {
      if (!served.has(version.no)) this.versionBytes.delete(`${node.id}#${String(version.no)}`)
    }
    node.earlierVersions = node.earlierVersions.filter((version) => served.has(version.no))
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

  /** The share behind a token, if it still works: not expired or used up. */
  private liveShare(
    token: string,
    { requireUnlocked = true } = {},
  ): { share: MockShare; root: MockNode } {
    const share = this.state.shares.find((candidate) => candidate.token === token)
    const root = share ? this.state.nodes[share.nodeId] : undefined
    if (!share || !root || !isVisible(root)) {
      throw new MockApiError(404, 'share_not_found', 'This link doesn’t exist.')
    }
    if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
      throw new MockApiError(410, 'share_expired', 'This link has expired.')
    }
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
      throw new MockApiError(410, 'share_used_up', 'This link has reached its download limit.')
    }
    if (this.shareVersion(share) === 'deleted') {
      throw new MockApiError(
        410,
        'share_version_deleted',
        'The version of this file that was shared is gone.',
      )
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
      for (const version of node.earlierVersions ?? []) total += version.sizeBytes
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

  /** A link as its owner sees it, to copy again (§7.5); its password never leaves the server. */
  private shareDto(share: MockShare): ShareLink {
    const node = this.state.nodes[share.nodeId]
    const { token, password: _password, versionNo: _version, ...fields } = share
    return {
      ...fields,
      nodeName: node?.name ?? 'Deleted item',
      nodeKind: node?.kind ?? 'file',
      url: `${window.location.origin}/s/${token}`,
      version: this.shareVersion(share),
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

/**
 * What a mock file holds, since the mock keeps no bytes but those uploaded:
 * a made-up image or text for those the viewer shows (§10.3), and otherwise
 * a line of text.
 */
function mockContent(
  node: MockNode,
  mimeType: string | null,
): Pick<MockFileContent, 'mimeType' | 'body'> {
  const kind =
    fileCategory(node.name, mimeType) === 'image' ? 'image' : previewKind(node.name, mimeType)
  const video = kind === 'video' ? sampleVideo() : null
  if (video) return { mimeType: 'video/mp4', body: video }
  const audio = mediaKind(node.name, mimeType) === 'audio' ? sampleAudio() : null
  if (audio) return { mimeType: 'audio/mpeg', body: audio }
  const sample =
    kind === 'image'
      ? sampleImage(node.id, node.name)
      : kind === 'pdf'
        ? samplePdf(node.name)
        : kind === 'text'
          ? sampleText(node.id, node.name, node.sizeBytes)
          : null
  const { mimeType: type, body } = sample ?? {
    mimeType: 'text/plain',
    body: `Mock content of “${node.name}” (${node.sizeBytes} bytes in the real file).\n`,
  }
  return { mimeType: type, body: new TextEncoder().encode(body) }
}

/**
 * A file's version, by its ID: the upload's, or for the demo's files one made
 * from the file's own ID and its version's number.
 */
/** Uploaded, so it can be read: syncing or stored. */
function isReady(node: MockNode): boolean {
  return node.syncState === 'syncing' || node.syncState === 'stored'
}

function versionIdOf(node: MockNode): string {
  return node.versionId ?? madeUpVersionId(node, node.versionNo ?? 1)
}

/** An earlier version's ID, as it was while it was the file's. */
function earlierVersionId(node: MockNode, version: MockVersion): string {
  return version.id ?? madeUpVersionId(node, version.no)
}

/** A version's ID for the demo's files, made up from the file's and its number. */
function madeUpVersionId(node: MockNode, versionNo: number): string {
  return `${node.id.slice(0, 24)}${String(versionNo).padStart(12, '0')}`
}

/** A file's kind as a player has it, or `422 not_media`. */
function mediaKindOf(node: MockNode): 'video' | 'audio' {
  const kind = node.kind === 'file' ? mediaKind(node.name, node.mimeType) : null
  if (!kind) throw new MockApiError(422, 'not_media', 'This file isn’t audio or video.')
  return kind
}

/** The version a player named is no longer the file's (§10.4). */
function versionChanged(): MockApiError {
  return new MockApiError(412, 'version_changed', 'This file has been replaced since.')
}

/** A version's ETag: the API's is the version's ID, the mock's its file and number. */
function versionTag(node: MockNode, versionNo: number): string {
  return `"${node.id}.${String(versionNo)}"`
}

/** A share link that still works: not expired or used up (§7.5). */
function isWorking(share: MockShare, now: number): boolean {
  return (
    !(share.expiresAt && new Date(share.expiresAt).getTime() <= now) &&
    !(share.maxDownloads !== null && share.downloadCount >= share.maxDownloads)
  )
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

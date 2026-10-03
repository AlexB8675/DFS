import {
  nameKey,
  normalizeName,
  splitExtension,
  validateName,
  type DriveNode,
  type NodeKind,
  type NodePath,
  type Page,
  type SearchResult,
  type Session,
  type ShareLink,
  type SortField,
  type SortOrder,
  type SyncState,
  type TrashItem,
  type UploadSession,
  type User,
} from '@dfs/shared'
import { createSeed } from './seed'

// An in-memory stand-in for the API's database, persisted to localStorage so
// changes survive a reload. It follows the rules of DESIGN.md §5–§6 closely
// enough to exercise the UI: unique names per folder, cycle checks on moves,
// trash and restore, keyset pagination, and uploads that sync after a delay.

export interface MockNode {
  id: string
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
}

export interface MockShare {
  id: string
  nodeId: string
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
  chunkSize: number
  chunkCount: number
  receivedParts: number[]
}

export interface MockState {
  version: number
  user: Omit<User, 'usedBytes'>
  signedIn: boolean
  nodes: Record<string, MockNode>
  shares: MockShare[]
  uploads: Record<string, MockUpload>
}

export type MockEvent = { type: 'nodes.changed' } | { type: 'quota.changed' }

export class MockApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const STATE_VERSION = 2
const STORAGE_KEY = 'dfs.mock-db'
/** `CHUNK_SIZE` at the 10 MiB attachment limit (§7.3). */
const CHUNK_SIZE = 10 * 1024 * 1024 - 128 * 1024
const CSRF_TOKEN = 'mock-csrf-token'

interface ListOptions {
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

class MockDb {
  private state: MockState
  private derived: Derived | null = null
  private readonly listeners = new Set<(event: MockEvent) => void>()

  constructor() {
    this.state = loadState() ?? createSeed(STATE_VERSION)
    this.scheduleSyncCompletions()
  }

  // ── Session ────────────────────────────────────────────────────────────────

  get signedIn(): boolean {
    return this.state.signedIn
  }

  get csrfToken(): string {
    return CSRF_TOKEN
  }

  signIn(): void {
    this.state.signedIn = true
    this.save()
  }

  signOut(): void {
    this.state.signedIn = false
    this.save()
  }

  session(): Session {
    return { user: { ...this.state.user, usedBytes: this.usedBytes() }, csrfToken: CSRF_TOKEN }
  }

  reset(): void {
    localStorage.removeItem(STORAGE_KEY)
    this.state = createSeed(STATE_VERSION)
    this.state.signedIn = true
    this.changed()
    this.scheduleSyncCompletions()
  }

  // ── Events (feeds the mocked SSE stream) ───────────────────────────────────

  subscribe(listener: (event: MockEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: MockEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  node(id: string): DriveNode {
    return this.toDto(this.visibleNode(id))
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
      (node) => node.parentId !== null && isVisible(node) && nameKey(node.name).includes(needle),
    )
    return paginate(sortNodes(matches, 'name', 'asc'), { cursor, limit }, (node) => ({
      ...this.toDto(node),
      location: this.location(node),
    }))
  }

  trashItems(cursor: string | null, limit: number): Page<TrashItem> {
    const trashed = Object.values(this.state.nodes)
      .filter((node) => node.deletedAt !== null)
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

  fileContent(id: string): { name: string; mimeType: string; body: string } {
    const node = this.visibleNode(id)
    if (node.kind !== 'file') throw notFound()
    return {
      name: node.name,
      mimeType: 'text/plain',
      body: `Mock content of “${node.name}” (${node.sizeBytes} bytes in the real file).\n`,
    }
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
    }
    this.changed()
  }

  restore(id: string): DriveNode {
    const node = this.state.nodes[id]
    if (!node?.deletedAt) throw notFound()
    const parent = node.parentId ? this.state.nodes[node.parentId] : undefined
    // Restore into the original folder if it still exists, otherwise into the root.
    if (!parent || !isVisible(parent)) node.parentId = this.state.user.rootFolderId
    node.name = this.freeName(node.parentId ?? this.state.user.rootFolderId, node.name)
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
    if (!node?.deletedAt) throw notFound()
    this.remove(node)
    this.changed()
  }

  emptyTrash(): void {
    for (const node of Object.values(this.state.nodes)) {
      if (node.deletedAt && this.state.nodes[node.id]) this.remove(node)
    }
    this.changed()
  }

  // ── Uploads (§6.1) ─────────────────────────────────────────────────────────

  createUpload(
    parentId: string,
    rawName: string,
    sizeBytes: number,
    mimeType: string,
  ): UploadSession {
    this.requireFolder(parentId)
    const name = this.freeName(parentId, checkedName(rawName))
    const node = this.insert({
      parentId,
      kind: 'file',
      name,
      mimeType,
      sizeBytes,
      syncState: 'uploading',
    })
    const upload: MockUpload = {
      id: crypto.randomUUID(),
      nodeId: node.id,
      chunkSize: CHUNK_SIZE,
      chunkCount: Math.ceil(sizeBytes / CHUNK_SIZE),
      receivedParts: [],
    }
    this.state.uploads[upload.id] = upload
    this.changed()
    return {
      uploadId: upload.id,
      nodeId: node.id,
      chunkSize: upload.chunkSize,
      chunkCount: upload.chunkCount,
    }
  }

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
    if (sha256 && sha256 !== (await sha256Hex(body))) {
      throw new MockApiError(400, 'hash_mismatch', 'The part was corrupted in transit.')
    }
    if (!upload.receivedParts.includes(index)) upload.receivedParts.push(index)
    // A single-part upload completes on its own (§6.1), saving a request per small file.
    if (upload.chunkCount === 1) this.completeUpload(uploadId)
    else this.save()
  }

  completeUpload(uploadId: string): void {
    const upload = this.upload(uploadId)
    if (upload.receivedParts.length !== upload.chunkCount) {
      throw new MockApiError(409, 'incomplete_upload', 'Some parts have not been uploaded yet.')
    }
    const node = this.state.nodes[upload.nodeId]
    if (node) {
      node.syncState = 'syncing'
      node.syncCompletesAt = Date.now() + 2000 + Math.random() * 4000
      node.updatedAt = new Date().toISOString()
      this.scheduleSyncCompletion(node)
    }
    Reflect.deleteProperty(this.state.uploads, uploadId)
    this.changed()
  }

  cancelUpload(uploadId: string): void {
    const upload = this.state.uploads[uploadId]
    if (!upload) return
    const node = this.state.nodes[upload.nodeId]
    if (node) this.remove(node)
    Reflect.deleteProperty(this.state.uploads, uploadId)
    this.changed()
  }

  // ── Share links ────────────────────────────────────────────────────────────

  shares(): Page<ShareLink> {
    const items = [...this.state.shares]
      .filter((share) => this.state.nodes[share.nodeId])
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
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      hasPassword: input.password !== null,
      maxDownloads: input.maxDownloads,
      downloadCount: 0,
      revokedAt: null,
    }
    this.state.shares.push(share)
    this.save()
    const token = crypto.randomUUID().replaceAll('-', '')
    return this.shareDto(share, `${window.location.origin}/s/${token}`)
  }

  revokeShare(id: string): void {
    const share = this.state.shares.find((candidate) => candidate.id === id)
    if (!share) throw notFound()
    share.revokedAt ??= new Date().toISOString()
    this.save()
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private insert(
    fields: Pick<MockNode, 'parentId' | 'kind' | 'name'> & Partial<MockNode>,
  ): MockNode {
    const now = new Date().toISOString()
    const node: MockNode = {
      id: crypto.randomUUID(),
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

  private visibleNode(id: string): MockNode {
    const node = this.state.nodes[id]
    if (!node || !isVisible(node)) throw notFound()
    return node
  }

  private requireFolder(id: string): MockNode {
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

  private childrenOf(parentId: string): MockNode[] {
    return Object.values(this.state.nodes).filter(
      (node) => node.parentId === parentId && isVisible(node),
    )
  }

  /** Every node below `id`, trashed or not. */
  private descendants(id: string): MockNode[] {
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

  private ancestors(node: MockNode): MockNode[] {
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
  private location(node: MockNode): string {
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

  private usedBytes(): number {
    // Trashed files still count until they are purged (§6.4).
    return Object.values(this.state.nodes).reduce(
      (total, node) => total + (node.kind === 'file' ? node.sizeBytes : 0),
      0,
    )
  }

  private toDto(node: MockNode): DriveNode {
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
    return {
      ...share,
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
        this.emit({ type: 'nodes.changed' })
      },
      Math.max(0, node.syncCompletesAt - Date.now()),
    )
  }

  /**
   * Call after a client-initiated change. No event is pushed: the client
   * refreshes its own data, and events are for background changes (syncs).
   */
  private changed(): void {
    this.derived = null
    this.save()
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // Quota exceeded or storage disabled: keep working in memory.
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isVisible(node: MockNode): boolean {
  return node.deletedAt === null && node.trashedVia === null
}

function checkedName(raw: string): string {
  const name = normalizeName(raw)
  const problem = validateName(name)
  if (problem) throw new MockApiError(400, 'invalid_name', problem)
  return name
}

function notFound(): MockApiError {
  return new MockApiError(404, 'not_found', 'This item no longer exists.')
}

function nameConflict(name: string): MockApiError {
  return new MockApiError(409, 'name_conflict', `An item named “${name}” already exists here.`)
}

/** Folders first, then by the chosen field, with name and ID as tie-breakers (§5.1). */
function sortNodes(nodes: MockNode[], sort: SortField, order: SortOrder): MockNode[] {
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
function paginate<T>(
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

export const db = new MockDb()

import { RecoveryError, type JournalEntry } from './read-journal.ts'

// Replaying the journal (DESIGN.md §8) into the state it describes, in
// memory: each record carries its entity's full state after the change, so
// applying them in order leaves what the database held. A few things the
// database did on its own were never journaled, and are done here too:
// purging a folder takes everything below it, purging a version unpins the
// links that served it, and a link turned off before links were deleted
// (0019) was journaled with its `revokedAt`.

type Row = Record<string, unknown>

/** A version as `version.stored` records it, with its chunks. */
export interface VersionState extends Row {
  id: string
  nodeId: string
  versionNo: number
  chunks: ChunkState[] | null
  /** When it was journaled as stored: its creation time, for records older than `createdAt`. */
  journaledAt: string
}

export interface ChunkState {
  idx: number
  blobId: number
  offset: number
  plainSize: number
  frameSize: number
  plainSha256: string
  frameSha256: string
}

export interface BlobState extends Row {
  id: number
  /** When it was journaled as stored, for `stored_at`. */
  storedAt: string
  /** The garbage collector deleted its message (`blob.deleted`). */
  deleted: boolean
}

/** What replaying the journal leaves. */
export interface FoldedState {
  users: Map<string, Row>
  nodes: Map<string, Row>
  versions: Map<string, VersionState>
  blobs: Map<number, BlobState>
  shares: Map<string, Row>
  audit: Map<number, Row>
  /** The highest record ID read: new records continue after it. */
  lastRecordId: number
}

/** Applies every record in order. */
export function foldJournal(entries: readonly JournalEntry[]): FoldedState {
  const state: FoldedState = {
    users: new Map(),
    nodes: new Map(),
    versions: new Map(),
    blobs: new Map(),
    shares: new Map(),
    audit: new Map(),
    lastRecordId: 0,
  }
  const children = new Map<string, Set<string>>()
  const link = (node: Row) => {
    const parentId = node.parentId as string | null
    if (!parentId) return
    const set = children.get(parentId) ?? new Set()
    set.add(node.id as string)
    children.set(parentId, set)
  }
  const unlink = (node: Row | undefined) => {
    const parentId = node?.parentId as string | null | undefined
    if (parentId) children.get(parentId)?.delete(node?.id as string)
  }

  for (const entry of entries) {
    const record = entry.record
    const id = record.id as string
    switch (entry.kind) {
      case 'user.upsert':
        state.users.set(id, record)
        break
      case 'node.upsert':
        unlink(state.nodes.get(id))
        state.nodes.set(id, record)
        link(record)
        break
      case 'node.purge': {
        // The record names the item purged; everything below it went too.
        const purged = new Set<string>()
        const walk = (nodeId: string) => {
          purged.add(nodeId)
          for (const child of children.get(nodeId) ?? []) walk(child)
        }
        walk(id)
        for (const nodeId of purged) {
          unlink(state.nodes.get(nodeId))
          state.nodes.delete(nodeId)
          children.delete(nodeId)
        }
        for (const [versionId, version] of state.versions) {
          if (purged.has(version.nodeId)) state.versions.delete(versionId)
        }
        for (const [shareId, share] of state.shares) {
          if (purged.has(share.nodeId as string)) state.shares.delete(shareId)
        }
        break
      }
      case 'version.stored':
        state.versions.set(id, { ...record, journaledAt: entry.at } as unknown as VersionState)
        break
      case 'version.purged':
        state.versions.delete(id)
        // Links that served it lose it (`ON DELETE SET NULL`), and work no more.
        for (const share of state.shares.values()) {
          if (share.versionId === id) share.versionId = null
        }
        break
      case 'blob.stored':
        state.blobs.set(record.id as number, {
          ...record,
          id: record.id as number,
          storedAt: entry.at,
          deleted: false,
        })
        break
      case 'blob.deleted': {
        const blob = state.blobs.get(record.id as number)
        if (blob) blob.deleted = true
        break
      }
      case 'share.upsert':
        // Before 0019, turning a link off kept it, revoked.
        if (record.revokedAt) state.shares.delete(id)
        else {
          const { revokedAt: _revoked, ...share } = record
          state.shares.set(id, share)
        }
        break
      case 'share.deleted':
        state.shares.delete(id)
        break
      case 'audit.added':
        state.audit.set(record.id as number, record)
        break
      default:
        throw new RecoveryError(
          `Journal record ${String(entry.id)} is a “${entry.kind}”, which this version of dfs can’t replay.`,
        )
    }
    state.lastRecordId = Math.max(state.lastRecordId, entry.id)
  }
  return state
}

/** What recovery couldn't bring back, or brought back differently, and why. */
export interface Settled {
  /** Files whose current version never reached Discord: their bytes were only in staging. */
  droppedFiles: { id: string; ownerId: string; name: string }[]
  /** Files that fell back to an earlier version, their current one never having reached Discord. */
  rolledBack: { id: string; name: string; versionNo: number }[]
  /** Versions with a frame in a blob the journal doesn't have, marked `lost`. */
  lostVersions: string[]
  /** Items whose folder is gone, dropped with what is below them. */
  orphans: string[]
}

/**
 * Makes the folded state whole: every file has a version that can be read,
 * every item a folder, every link an item. What can't be is dropped and
 * listed; nothing is made up.
 */
export function settle(state: FoldedState): Settled {
  const settled: Settled = { droppedFiles: [], rolledBack: [], lostVersions: [], orphans: [] }
  const versionsOf = Map.groupBy(state.versions.values(), (version) => version.nodeId)

  for (const node of [...state.nodes.values()]) {
    if (node.kind !== 'file') continue
    const current = node.currentVersionId as string | null
    if (current && state.versions.has(current)) continue
    // An upload journaled before uploads in progress were left out, or a
    // version still syncing when the database was lost.
    const kept = (versionsOf.get(node.id as string) ?? []).toSorted(
      (a, b) => b.versionNo - a.versionNo,
    )[0]
    if (current && kept) {
      node.currentVersionId = kept.id
      node.sizeBytes = kept.sizeBytes
      settled.rolledBack.push({
        id: node.id as string,
        name: node.name as string,
        versionNo: kept.versionNo,
      })
      continue
    }
    state.nodes.delete(node.id as string)
    if (current) {
      settled.droppedFiles.push({
        id: node.id as string,
        ownerId: node.ownerId as string,
        name: node.name as string,
      })
    }
  }

  // Items whose folder is gone; whatever was below them goes with them.
  let removed = true
  while (removed) {
    removed = false
    for (const node of [...state.nodes.values()]) {
      const parentId = node.parentId as string | null
      if (parentId && !state.nodes.has(parentId)) {
        state.nodes.delete(node.id as string)
        settled.orphans.push(node.id as string)
        removed = true
      }
    }
  }

  for (const [versionId, version] of state.versions) {
    if (!state.nodes.has(version.nodeId)) {
      state.versions.delete(versionId)
      continue
    }
    const readable = (version.chunks ?? []).every((chunk) => {
      const blob = state.blobs.get(chunk.blobId)
      return blob !== undefined && !blob.deleted
    })
    if (!readable) settled.lostVersions.push(versionId)
  }
  for (const [shareId, share] of state.shares) {
    if (!state.nodes.has(share.nodeId as string)) state.shares.delete(shareId)
    else if (share.versionId && !state.versions.has(share.versionId as string)) {
      share.versionId = null
    }
  }
  for (const user of state.users.values()) {
    if (user.rootNodeId && !state.nodes.has(user.rootNodeId as string)) user.rootNodeId = null
  }
  return settled
}

/** The nearest proper ancestor in the trash, as `markTrashed` marks what is below. */
export function trashedVia(state: FoldedState, node: Row): string | null {
  let parentId = node.parentId as string | null
  while (parentId) {
    const parent = state.nodes.get(parentId)
    if (!parent) return null
    if (parent.deletedAt) return parentId
    parentId = parent.parentId as string | null
  }
  return null
}

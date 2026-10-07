import { describe, expect, it } from 'vitest'
import { foldJournal, settle } from './fold.ts'
import { RecoveryError, type JournalEntry } from './read-journal.ts'

// Settling a journal cut short (DESIGN.md §8 step 4): what recovery can't
// read is dropped and listed, and nothing is made up.

const at = '2026-10-07T12:00:00.000Z'

function entries(records: [kind: string, record: Record<string, unknown>][]): JournalEntry[] {
  return records.map(([kind, record], index) => ({ id: index + 1, kind, at, record }))
}

const chunk = (blobId: number) => ({
  idx: 0,
  blobId,
  offset: 0,
  plainSize: 1,
  frameSize: 29,
  plainSha256: '00',
  frameSha256: '00',
})

const file = (id: string, currentVersionId: string) => ({
  id,
  kind: 'file',
  parentId: 'root',
  ownerId: 'owner',
  name: `${id}.txt`,
  currentVersionId,
})

const version = (id: string, nodeId: string, versionNo: number, blobId: number) => ({
  id,
  nodeId,
  versionNo,
  sizeBytes: versionNo,
  chunks: [chunk(blobId)],
})

describe('settling the journal (§8)', () => {
  it('drops a version whose blob the journal lacks or deleted, and falls back from it', () => {
    const state = foldJournal(
      entries([
        ['user.upsert', { id: 'owner', rootNodeId: 'root' }],
        ['node.upsert', { id: 'root', kind: 'folder', parentId: null, ownerId: 'owner' }],
        ['node.upsert', file('kept', 'kept-2')],
        ['node.upsert', file('gone', 'gone-1')],
        ['blob.stored', { id: 1, kind: 'pack' }],
        ['blob.stored', { id: 3, kind: 'solo' }],
        ['blob.deleted', { id: 3 }],
        ['version.stored', version('kept-1', 'kept', 1, 1)],
        // Blob 2 never reached the journal; blob 3's message was deleted.
        ['version.stored', version('kept-2', 'kept', 2, 2)],
        ['version.stored', version('gone-1', 'gone', 1, 3)],
      ]),
    )
    expect(settle(state)).toEqual({
      droppedFiles: [{ id: 'gone', ownerId: 'owner', name: 'gone.txt' }],
      rolledBack: [{ id: 'kept', name: 'kept.txt', versionNo: 1 }],
      unreadableVersions: ['kept-2', 'gone-1'],
      orphans: [],
    })
    expect(state.nodes.get('kept')).toMatchObject({ currentVersionId: 'kept-1', sizeBytes: 1 })
    expect([...state.versions.keys()]).toEqual(['kept-1'])
  })
})

describe('compaction in the journal (§6.6)', () => {
  const owner: [string, Record<string, unknown>][] = [
    ['user.upsert', { id: 'owner', rootNodeId: 'root' }],
    ['node.upsert', { id: 'root', kind: 'folder', parentId: null, ownerId: 'owner' }],
    ['node.upsert', file('a', 'a-1')],
  ]
  const twoChunks = {
    ...version('a-1', 'a', 1, 1),
    chunks: [
      { ...chunk(1), idx: 0 },
      { ...chunk(2), idx: 1, offset: 300 },
    ],
  }
  const relocated = (id: number, chunks: { versionId: string; idx: number; offset: number }[]) =>
    ['blob.relocated', { id, chunks }] as [string, Record<string, unknown>]
  const where = (state: ReturnType<typeof foldJournal>) =>
    state.versions.get('a-1')?.chunks?.map(({ idx, blobId, offset }) => ({ idx, blobId, offset }))

  it('reads a frame where it was moved to, the old pack deleted', () => {
    const state = foldJournal(
      entries([
        ...owner,
        ['blob.stored', { id: 1, kind: 'solo' }],
        ['blob.stored', { id: 2, kind: 'pack' }],
        ['version.stored', twoChunks],
        ['blob.stored', { id: 5, kind: 'pack' }],
        relocated(5, [{ versionId: 'a-1', idx: 1, offset: 77 }]),
        ['blob.deleted', { id: 2 }],
      ]),
    )
    expect(settle(state)).toMatchObject({ unreadableVersions: [], droppedFiles: [] })
    // Only the chunk listed moved; the solo blob's stayed.
    expect(where(state)).toEqual([
      { idx: 0, blobId: 1, offset: 0 },
      { idx: 1, blobId: 5, offset: 77 },
    ])
  })

  it('follows a pack merged twice, the last move winning', () => {
    const state = foldJournal(
      entries([
        ...owner,
        ['blob.stored', { id: 1, kind: 'solo' }],
        ['blob.stored', { id: 2, kind: 'pack' }],
        ['version.stored', twoChunks],
        ['blob.stored', { id: 5, kind: 'pack' }],
        relocated(5, [{ versionId: 'a-1', idx: 1, offset: 77 }]),
        ['blob.deleted', { id: 2 }],
        ['blob.stored', { id: 9, kind: 'pack' }],
        relocated(9, [{ versionId: 'a-1', idx: 1, offset: 4 }]),
        ['blob.deleted', { id: 5 }],
      ]),
    )
    expect(settle(state).unreadableVersions).toEqual([])
    expect(where(state)?.[1]).toEqual({ idx: 1, blobId: 9, offset: 4 })
  })

  it('leaves a version journaled after the move as its record says', () => {
    // Its pack was compacted while its other frames were still being posted:
    // the move names it first, and its record, written later, where it is now.
    const state = foldJournal(
      entries([
        ...owner,
        ['blob.stored', { id: 1, kind: 'solo' }],
        ['blob.stored', { id: 2, kind: 'pack' }],
        ['blob.stored', { id: 5, kind: 'pack' }],
        relocated(5, [{ versionId: 'a-1', idx: 1, offset: 77 }]),
        ['blob.deleted', { id: 2 }],
        [
          'version.stored',
          { ...twoChunks, chunks: [twoChunks.chunks[0], { ...chunk(5), idx: 1, offset: 77 }] },
        ],
      ]),
    )
    expect(settle(state).unreadableVersions).toEqual([])
    expect(where(state)?.[1]).toEqual({ idx: 1, blobId: 5, offset: 77 })
  })

  it('doesn’t bring back a version purged before its frame moved', () => {
    const state = foldJournal(
      entries([
        ...owner,
        ['node.upsert', file('b', 'b-1')],
        ['blob.stored', { id: 2, kind: 'pack' }],
        ['version.stored', version('a-1', 'a', 1, 2)],
        ['version.stored', version('b-1', 'b', 1, 2)],
        ['version.purged', { id: 'b-1' }],
        ['node.purge', { id: 'b' }],
        ['blob.stored', { id: 5, kind: 'pack' }],
        relocated(5, [{ versionId: 'a-1', idx: 0, offset: 0 }]),
        ['blob.deleted', { id: 2 }],
      ]),
    )
    expect(settle(state).unreadableVersions).toEqual([])
    expect([...state.versions.keys()]).toEqual(['a-1'])
    expect(where(state)).toEqual([{ idx: 0, blobId: 5, offset: 0 }])
  })

  it('refuses a move of a chunk the version doesn’t have', () => {
    expect(() =>
      foldJournal(
        entries([
          ...owner,
          ['blob.stored', { id: 2, kind: 'pack' }],
          ['version.stored', version('a-1', 'a', 1, 2)],
          ['blob.stored', { id: 5, kind: 'pack' }],
          relocated(5, [{ versionId: 'a-1', idx: 3, offset: 0 }]),
        ]),
      ),
    ).toThrow(RecoveryError)
  })
})

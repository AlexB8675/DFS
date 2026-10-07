import { describe, expect, it } from 'vitest'
import { foldJournal, settle } from './fold.ts'
import type { JournalEntry } from './read-journal.ts'

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

import type { DriveNode } from '@dfs/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { queryClient } from '@/app/query-client'
import { childFoldersQuery } from '@/features/drive/api'
import { useTreeStore } from './tree-store'

function folder(id: string, parentId: string): DriveNode {
  return {
    id,
    parentId,
    kind: 'folder',
    name: id,
    mimeType: null,
    sizeBytes: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    syncState: null,
    hasChildFolders: true,
  }
}

/** Loads the subfolders of `parentId`, as the tree does when it opens a folder. */
function load(parentId: string, ...ids: string[]): void {
  queryClient.setQueryData(childFoldersQuery(parentId).queryKey, {
    pages: [{ items: ids.map((id) => folder(id, parentId)), nextCursor: null }],
    pageParams: [null],
  })
}

const open = () => [...useTreeStore.getState().expanded].sort()

describe('folder tree expansion', () => {
  beforeEach(() => {
    queryClient.clear()
    useTreeStore.setState({ expanded: new Set() })
    // root ─ a ─ c ─ d
    //      └ b
    load('root', 'a', 'b')
    load('a', 'c')
    load('c', 'd')
  })

  it('opens and closes a folder', () => {
    useTreeStore.getState().toggle('a')
    expect(open()).toEqual(['a'])
    useTreeStore.getState().toggle('a')
    expect(open()).toEqual([])
  })

  it('closes every folder opened inside a folder when it closes', () => {
    useTreeStore.getState().expand(['root', 'a', 'c', 'b'])

    useTreeStore.getState().toggle('a')

    // `c` was open inside `a`: gone with it. `b` is a sibling: left alone.
    expect(open()).toEqual(['b', 'root'])
  })

  it('shows its subfolders closed when it opens again', () => {
    useTreeStore.getState().expand(['root', 'a', 'c'])
    useTreeStore.getState().toggle('a')

    useTreeStore.getState().toggle('a')

    expect(open()).toEqual(['a', 'root'])
  })

  it('closes folders deeper than the one closing', () => {
    useTreeStore.getState().expand(['root', 'a', 'c', 'd'])

    useTreeStore.getState().toggle('root')

    expect(open()).toEqual([])
  })

  it('leaves the folders it has no listing of alone', () => {
    useTreeStore.getState().expand(['root', 'a', 'elsewhere'])

    useTreeStore.getState().toggle('a')

    expect(open()).toEqual(['elsewhere', 'root'])
  })
})

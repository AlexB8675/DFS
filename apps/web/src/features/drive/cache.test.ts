import type { DriveNode } from '@dfs/shared'
import { QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateListings, invalidateNodes, patchNodes, removeFromListings } from './cache'

function node(id: string, parentId = 'folder'): DriveNode {
  return {
    id,
    parentId,
    kind: 'file',
    name: `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    syncState: 'syncing',
    hasChildFolders: false,
  }
}

function listing(...pages: DriveNode[][]): InfiniteData<{ items: DriveNode[]; nextCursor: null }> {
  return {
    pages: pages.map((items) => ({ items, nextCursor: null })),
    pageParams: pages.map(() => null),
  }
}

const byName = ['nodes', 'folder', 'children', { sort: 'name', order: 'asc' }]
const bySize = ['nodes', 'folder', 'children', { sort: 'size', order: 'desc' }]
const other = ['nodes', 'other', 'children', { sort: 'name', order: 'asc' }]

describe('drive cache updates', () => {
  let client: QueryClient

  beforeEach(() => {
    client = new QueryClient()
    client.setQueryData(byName, listing([node('a'), node('b')], [node('c')]))
    client.setQueryData(bySize, listing([node('c'), node('b'), node('a')]))
    client.setQueryData(other, listing([node('x', 'other')]))
  })

  it('removes nodes from every listing they appear in, in every sort order', () => {
    removeFromListings(new Set(['b']), client)
    const ids = (key: unknown[]) =>
      client
        .getQueryData<ReturnType<typeof listing>>(key)
        ?.pages.flatMap((page) => page.items.map((item) => item.id))
    expect(ids(byName)).toEqual(['a', 'c'])
    expect(ids(bySize)).toEqual(['c', 'a'])
  })

  it('patches nodes in place and keeps untouched pages and listings as they were', () => {
    const before = client.getQueryData<ReturnType<typeof listing>>(byName)
    const untouched = client.getQueryData(other)
    patchNodes(new Map([['c', { syncState: 'stored' }]]), client)
    const after = client.getQueryData<ReturnType<typeof listing>>(byName)

    expect(after?.pages[1]?.items[0]?.syncState).toBe('stored')
    // Page 1 had no match, so React can skip its rows.
    expect(after?.pages[0]).toBe(before?.pages[0])
    expect(client.getQueryData(other)).toBe(untouched)
  })

  it('refetches only the listings of the folders that changed', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await invalidateListings(['folder', null, 'folder'], client)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(client.getQueryState(byName)?.isInvalidated).toBe(true)
    expect(client.getQueryState(bySize)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  })

  it('scans cached queries a fixed number of times for a batch of changed folders', async () => {
    const folders = Array.from({ length: 16 }, (_, index) => `folder-${index}`)
    for (const id of folders)
      client.setQueryData(['nodes', id, 'children'], listing([node(`${id}-file`, id)]))
    const scans = vi.spyOn(client.getQueryCache(), 'findAll')
    await invalidateListings(['folder'], client)
    const single = scans.mock.calls.length
    scans.mockClear()

    await invalidateListings(folders, client)

    expect(scans.mock.calls.length).toBeLessThanOrEqual(single)
    for (const id of folders)
      expect(client.getQueryState(['nodes', id, 'children'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  })

  it('invalidates a batch of single nodes without touching their listings or paths', async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `node-${index}`)
    for (const id of ids) {
      client.setQueryData(['nodes', id], node(id))
      client.setQueryData(['nodes', id, 'path'], [{ id, name: id }])
      client.setQueryData(['nodes', id, 'children'], listing([node(`${id}-child`, id)]))
    }
    const scans = vi.spyOn(client.getQueryCache(), 'findAll')
    await invalidateNodes([ids[0] ?? ''], client)
    const single = scans.mock.calls.length
    scans.mockClear()

    await invalidateNodes(ids, client)

    expect(scans.mock.calls.length).toBeLessThanOrEqual(single)
    for (const id of ids) {
      expect(client.getQueryState(['nodes', id])?.isInvalidated).toBe(true)
      expect(client.getQueryState(['nodes', id, 'path'])?.isInvalidated).toBe(false)
      expect(client.getQueryState(['nodes', id, 'children'])?.isInvalidated).toBe(false)
    }
  })

  it('does no cache work for an empty set of changed folders or nodes', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    await invalidateListings([null], client)
    await invalidateNodes([], client)

    expect(invalidate).not.toHaveBeenCalled()
    expect(client.getQueryState(byName)?.isInvalidated).toBe(false)
  })

  it('waits for active listings to refetch once while leaving other folders alone', async () => {
    const fetch = vi.fn(() => Promise.resolve(listing([node('fresh')])))
    const observer = new QueryObserver(client, {
      queryKey: byName,
      queryFn: fetch,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      await invalidateListings(['folder', null, 'folder'], client)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(byName)).toEqual(listing([node('fresh')]))
      expect(client.getQueryState(other)?.isInvalidated).toBe(false)
    } finally {
      unsubscribe()
    }
  })
})

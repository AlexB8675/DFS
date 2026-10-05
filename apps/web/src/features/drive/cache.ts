import type { DriveNode, Page } from '@dfs/shared'
import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query'
import { queryClient as defaultClient } from '@/app/query-client'

// Targeted updates of cached nodes. Changes patch the cache in place, or
// refetch only the folders they touch, instead of refetching every loaded
// page of every folder: a 6,000-file folder is 30 pages.

type Listing = InfiniteData<Page<DriveNode>>

/** Caches that list nodes: folder listings (every sort and filter) and search results. */
function isListing(query: Query): boolean {
  const [scope, , kind] = query.queryKey
  return (scope === 'nodes' && kind === 'children') || scope === 'search'
}

/**
 * Runs `update` over every listed node. It returns the node unchanged, a
 * changed copy, or `null` to drop it. Untouched pages keep their identity, so
 * React skips them.
 */
function updateListings(client: QueryClient, update: (node: DriveNode) => DriveNode | null): void {
  client.setQueriesData<Listing>({ predicate: isListing }, (data) => {
    if (!data) return data
    const pages = data.pages.map((page) => {
      let pageChanged = false
      const items: DriveNode[] = []
      for (const node of page.items) {
        const next = update(node)
        if (next !== node) pageChanged = true
        if (next) items.push(next)
      }
      return pageChanged ? { ...page, items } : page
    })
    return pages.some((page, index) => page !== data.pages[index]) ? { ...data, pages } : data
  })
}

/** Drops nodes from every listing, e.g. right after they are moved or trashed. */
export function removeFromListings(ids: ReadonlySet<string>, client = defaultClient): void {
  updateListings(client, (node) => (ids.has(node.id) ? null : node))
}

/** Applies field changes to nodes wherever they are cached: listings and single-node queries. */
export function patchNodes(
  patches: ReadonlyMap<string, Partial<DriveNode>>,
  client = defaultClient,
): void {
  if (patches.size === 0) return
  updateListings(client, (node) => {
    const patch = patches.get(node.id)
    return patch ? { ...node, ...patch } : node
  })
  for (const [id, patch] of patches) {
    client.setQueryData<DriveNode>(['nodes', id], (node) => node && { ...node, ...patch })
  }
}

/** Refetches the listings of these folders (in every sort order), if they are on screen. */
export async function invalidateListings(
  folderIds: Iterable<string | null>,
  client = defaultClient,
): Promise<void> {
  const unique = new Set([...folderIds].filter((id) => id !== null))
  if (unique.size === 0) return
  await client.invalidateQueries({
    predicate: (query) => {
      const [scope, id, kind] = query.queryKey
      return scope === 'nodes' && kind === 'children' && typeof id === 'string' && unique.has(id)
    },
  })
}

/** Refetches single nodes (not their listings or paths). */
export async function invalidateNodes(
  ids: Iterable<string>,
  client = defaultClient,
): Promise<void> {
  const unique = new Set(ids)
  if (unique.size === 0) return
  await client.invalidateQueries({
    predicate: (query) => {
      const [scope, id] = query.queryKey
      return (
        query.queryKey.length === 2 && scope === 'nodes' && typeof id === 'string' && unique.has(id)
      )
    },
  })
}

/** Refetches breadcrumbs, after a rename or move that may change a folder path. */
export async function invalidatePaths(client = defaultClient): Promise<void> {
  await client.invalidateQueries({ predicate: (query) => query.queryKey[2] === 'path' })
}

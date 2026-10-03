import {
  nodePageSchema,
  nodePathSchema,
  nodeSchema,
  type CreateFolderInput,
  type DriveNode,
  type NodeKind,
  type SortField,
  type SortOrder,
} from '@dfs/shared'
import { infiniteQueryOptions, queryOptions, useMutation } from '@tanstack/react-query'
import { queryClient } from '@/app/query-client'
import { apiFetch, apiGet, apiSend } from '@/lib/api/client'
import { mocksEnabled } from '@/lib/env'
import { usePreferences } from '@/lib/preferences'

const PAGE_SIZE = 200

export interface ChildrenParams {
  kind?: NodeKind
  sort: SortField
  order: SortOrder
}

export const nodeKeys = {
  all: ['nodes'] as const,
  node: (id: string) => [...nodeKeys.all, id] as const,
  path: (id: string) => [...nodeKeys.all, id, 'path'] as const,
  children: (id: string, params: ChildrenParams) =>
    [...nodeKeys.all, id, 'children', params] as const,
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function nodeQuery(id: string) {
  return queryOptions({
    queryKey: nodeKeys.node(id),
    queryFn: ({ signal }) => apiGet(`/nodes/${id}`, nodeSchema, { signal }),
  })
}

export function pathQuery(id: string) {
  return queryOptions({
    queryKey: nodeKeys.path(id),
    queryFn: ({ signal }) => apiGet(`/nodes/${id}/path`, nodePathSchema, { signal }),
  })
}

/** A folder's children, folders first, loaded page by page (keyset pagination). */
export function childrenQuery(id: string, params: ChildrenParams) {
  return infiniteQueryOptions({
    queryKey: nodeKeys.children(id, params),
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/nodes/${id}/children`, nodePageSchema, {
        query: { ...params, cursor: pageParam, limit: PAGE_SIZE },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
}

/** Subfolders only, A→Z: what the folder tree and the move dialog show. */
export function childFoldersQuery(id: string) {
  return childrenQuery(id, { kind: 'folder', sort: 'name', order: 'asc' })
}

/**
 * Warms the cache for a folder the user is about to open, so it appears
 * instantly: its first page in the current sort order and its path. The
 * folder itself is already known from the list it was shown in. Fresh data
 * (within `staleTime`) is not fetched again.
 */
export function prefetchFolder(folder: DriveNode): void {
  if (folder.kind !== 'folder') return
  const { sortField: sort, sortOrder: order } = usePreferences.getState()
  if (queryClient.getQueryData(nodeKeys.node(folder.id)) === undefined) {
    queryClient.setQueryData(nodeKeys.node(folder.id), folder)
  }
  // Prefetch failures are harmless: opening the folder fetches again.
  queryClient.infiniteQuery(childrenQuery(folder.id, { sort, order })).catch(ignore)
  queryClient.query(pathQuery(folder.id)).catch(ignore)
}

function ignore(): void {
  // Intentionally empty.
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Refetches everything a change to the tree can affect, including the quota. */
export async function invalidateDriveData(): Promise<void> {
  await Promise.all(
    [['nodes'], ['trash'], ['search'], ['session']].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  )
}

export function useCreateFolder() {
  return useMutation({
    mutationFn: (input: CreateFolderInput) => apiSend('POST', '/folders', input, nodeSchema),
    onSettled: invalidateDriveData,
  })
}

export function useRenameNode() {
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiSend('PATCH', `/nodes/${id}`, { name }, nodeSchema),
    onSettled: invalidateDriveData,
  })
}

export function useMoveNodes() {
  return useMutation({
    mutationFn: ({ ids, parentId }: { ids: string[]; parentId: string }) =>
      apiSend('POST', '/nodes/move', { ids, parentId }),
    onSettled: invalidateDriveData,
  })
}

export function useTrashNodes() {
  return useMutation({
    mutationFn: (ids: string[]) => apiSend('POST', '/nodes/trash', { ids }),
    onSettled: invalidateDriveData,
  })
}

export function useRestoreNodes() {
  return useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiSend('POST', `/nodes/${id}/restore`, undefined, nodeSchema))),
    onSettled: invalidateDriveData,
  })
}

// ── Downloads ────────────────────────────────────────────────────────────────

/**
 * Downloads a file. The real API streams it with `Content-Disposition:
 * attachment` (§7.5). The mock API cannot intercept a download navigation, so
 * mock mode fetches the bytes and saves them from memory.
 */
export async function downloadFile(node: DriveNode): Promise<void> {
  if (!mocksEnabled) {
    saveAs(`/api/files/${node.id}/content`, node.name)
    return
  }
  const response = await apiFetch(`/files/${node.id}/content`)
  const objectUrl = URL.createObjectURL(await response.blob())
  saveAs(objectUrl, node.name)
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 10_000)
}

function saveAs(href: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
}

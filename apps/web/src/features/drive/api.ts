import {
  archiveTicketSchema,
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
import { apiGet, apiSend } from '@/lib/api/client'
import { downloadFromApi } from '@/lib/download'
import { usePreferences } from '@/lib/preferences'
import {
  invalidateListings,
  invalidateNodes,
  invalidatePaths,
  patchNodes,
  removeFromListings,
} from './cache'
import { markFresh, settleLeaving } from './list-motion'

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
 * instantly: its first page in the current sort order, its path, and its
 * subfolders for the tree. The
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
  // What the folder tree shows when it is expanded.
  if (folder.hasChildFolders) queryClient.infiniteQuery(childFoldersQuery(folder.id)).catch(ignore)
}

function ignore(): void {
  // Intentionally empty.
}

// ── Mutations ────────────────────────────────────────────────────────────────
//
// Each change updates the cache right away (removing moved or trashed rows,
// patching a renamed one), then refetches only the folders it touched.

export function useCreateFolder() {
  return useMutation({
    mutationFn: (input: CreateFolderInput) => apiSend('POST', '/folders', input, nodeSchema),
    onSuccess: (folder) => {
      markFresh([folder.id])
    },
    onSettled: (_folder, _error, input) => invalidateListings([input.parentId]),
  })
}

export function useRenameNode() {
  return useMutation({
    mutationFn: ({ node, name }: { node: DriveNode; name: string }) =>
      apiSend('PATCH', `/nodes/${node.id}`, { name }, nodeSchema),
    onMutate: ({ node, name }) => {
      patchNodes(new Map([[node.id, { name }]]))
    },
    onSettled: (_node, _error, { node }) =>
      Promise.all([
        invalidateListings([node.parentId]),
        invalidateNodes([node.id]),
        invalidatePaths(),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
      ]),
  })
}

export interface MoveInput {
  nodes: DriveNode[]
  parentId: string
}

export function useMoveNodes() {
  return useMutation({
    mutationFn: ({ nodes, parentId }: MoveInput) =>
      apiSend('POST', '/nodes/move', { ids: nodes.map((node) => node.id), parentId }),
    onMutate: ({ nodes }) => {
      removeFromListings(new Set(nodes.map((node) => node.id)))
    },
    onSuccess: (_result, { nodes }) => {
      markFresh(nodes.map((node) => node.id))
    },
    onSettled: (_result, _error, { nodes, parentId }) => {
      settleLeaving(nodes.map((node) => node.id))
      return Promise.all([
        invalidateListings([...nodes.map((node) => node.parentId), parentId]),
        invalidateNodes(nodes.map((node) => node.id)),
        invalidatePaths(),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
      ])
    },
  })
}

export function useTrashNodes() {
  return useMutation({
    mutationFn: (nodes: DriveNode[]) =>
      apiSend('POST', '/nodes/trash', { ids: nodes.map((node) => node.id) }),
    onMutate: (nodes) => {
      removeFromListings(new Set(nodes.map((node) => node.id)))
    },
    onSettled: (_result, _error, nodes) => {
      settleLeaving(nodes.map((node) => node.id))
      return Promise.all([
        invalidateListings(nodes.map((node) => node.parentId)),
        queryClient.invalidateQueries({ queryKey: ['trash'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
      ])
    },
  })
}

export function useRestoreNodes() {
  return useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => apiSend('POST', `/nodes/${id}/restore`, undefined, nodeSchema))),
    onSuccess: (nodes) => {
      markFresh(nodes.map((node) => node.id))
    },
    onSettled: (nodes) =>
      Promise.all([
        invalidateListings(nodes?.map((node) => node.parentId) ?? []),
        queryClient.invalidateQueries({ queryKey: ['trash'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['session'] }),
      ]),
  })
}

// ── Downloads ────────────────────────────────────────────────────────────────

/**
 * Downloads nodes: one file as itself, a folder or several items as a ZIP
 * (§6.2). The real API streams both with `Content-Disposition: attachment`,
 * so the browser's download manager takes over. Several items first get a
 * short-lived link from `POST /archive`, which keeps every state-changing
 * request on JSON with a CSRF header.
 */
export async function downloadNodes(nodes: DriveNode[]): Promise<void> {
  const [first] = nodes
  if (!first) return
  if (nodes.length === 1 && first.kind === 'file') {
    await downloadFromApi(`/files/${first.id}/content`, first.name)
  } else if (nodes.length === 1) {
    await downloadFromApi(`/folders/${first.id}/archive`, `${first.name}.zip`)
  } else {
    const ticket = await apiSend(
      'POST',
      '/archive',
      { ids: nodes.map((node) => node.id) },
      archiveTicketSchema,
    )
    await downloadFromApi(ticket.url.slice('/api'.length), ticket.fileName)
  }
}

/** Whether downloading these nodes builds a ZIP. */
export function isArchiveDownload(nodes: DriveNode[]): boolean {
  return nodes.length > 1 || nodes[0]?.kind === 'folder'
}

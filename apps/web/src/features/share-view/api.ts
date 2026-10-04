import { publicShareSchema, sharedFolderPageSchema, type SharedNode } from '@dfs/shared'
import { infiniteQueryOptions, queryOptions, useMutation } from '@tanstack/react-query'
import { queryClient } from '@/app/query-client'
import { ApiError, apiGet, apiSend } from '@/lib/api/client'
import { downloadFromApi } from '@/lib/download'

// Public share access (`/api/s/:token/*`, §7.5). No session is involved: an
// unlocked password-protected link is remembered by a cookie for that share.

/** A dead or locked link won't come back by asking again; only server hiccups are retried. */
function retryServerErrors(failureCount: number, error: Error): boolean {
  return !(error instanceof ApiError && error.status < 500) && failureCount < 2
}

const shareKeys = {
  share: (token: string) => ['share', token] as const,
  folder: (token: string, folderId: string | null) =>
    ['share', token, 'children', folderId] as const,
}

export function publicShareQuery(token: string) {
  return queryOptions({
    queryKey: shareKeys.share(token),
    queryFn: ({ signal }) => apiGet(`/s/${token}`, publicShareSchema, { signal }),
    retry: retryServerErrors,
    // Share errors are for the share page to show, not a reason to sign in.
    meta: { skipAuthRedirect: true },
  })
}

/** A folder in the share; `null` is the shared folder itself. */
export function sharedFolderQuery(token: string, folderId: string | null) {
  return infiniteQueryOptions({
    queryKey: shareKeys.folder(token, folderId),
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/s/${token}/children`, sharedFolderPageSchema, {
        query: { parentId: folderId, cursor: pageParam, limit: 200 },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: retryServerErrors,
    meta: { skipAuthRedirect: true },
  })
}

export function useUnlockShare(token: string) {
  return useMutation({
    mutationFn: (password: string) => apiSend('POST', `/s/${token}/unlock`, { password }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shareKeys.share(token) }),
  })
}

export async function downloadSharedFile(token: string, file: SharedNode): Promise<void> {
  await downloadFromApi(`/s/${token}/files/${file.id}/content`, file.name)
  await refreshDownloadsLeft(token)
}

/** The shared folder, or a folder inside it, as a ZIP. */
export async function downloadSharedFolder(
  token: string,
  folder: { id: string; name: string },
  isRoot: boolean,
): Promise<void> {
  const query = isRoot ? '' : `?nodeId=${folder.id}`
  await downloadFromApi(`/s/${token}/archive${query}`, `${folder.name}.zip`)
  await refreshDownloadsLeft(token)
}

/** Downloads count toward the link's limit, which the page shows. */
async function refreshDownloadsLeft(token: string): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: shareKeys.share(token), exact: true })
}

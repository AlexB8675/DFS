import {
  adminUserPageSchema,
  adminUserSchema,
  auditPageSchema,
  nodePageSchema,
  nodePathSchema,
  storageChannelListSchema,
  storageChannelSchema,
  systemHealthSchema,
  userUsageSchema,
  type CreateChannelInput,
  type StorageChannel,
  type UpdateUserInput,
} from '@dfs/shared'
import { infiniteQueryOptions, queryOptions, useMutation } from '@tanstack/react-query'
import type { LoaderFunctionArgs } from 'react-router'
import { queryClient } from '@/app/query-client'
import { sessionQuery } from '@/features/auth/session'
import { apiGet, apiSend } from '@/lib/api/client'

// The admin API (§9). Admins see other users' metadata, never content (D4).

/** How often the overview refreshes while it is on screen. */
const HEALTH_REFRESH_MS = 5000

/** Route loader: the admin pages are a 404 for everyone else. */
export async function requireAdmin(_args: LoaderFunctionArgs): Promise<null> {
  // The parent route handles a missing session; only the role matters here.
  const session = await queryClient
    .query({ ...sessionQuery, staleTime: 'static' })
    .catch(() => null)
  if (session && session.user.role !== 'admin') {
    throw new Response('Not found', { status: 404, statusText: 'Not found' })
  }
  return null
}

export const healthQuery = queryOptions({
  queryKey: ['admin', 'health'],
  queryFn: ({ signal }) => apiGet('/admin/health', systemHealthSchema, { signal }),
  refetchInterval: HEALTH_REFRESH_MS,
  staleTime: 0,
})

export const adminUsersQuery = queryOptions({
  queryKey: ['admin', 'users'],
  queryFn: ({ signal }) => apiGet('/admin/users', adminUserPageSchema, { signal }),
})

export function userUsageQuery(userId: string) {
  return queryOptions({
    queryKey: ['admin', 'users', userId, 'usage'],
    queryFn: ({ signal }) => apiGet(`/admin/users/${userId}/usage`, userUsageSchema, { signal }),
  })
}

export function adminPathQuery(nodeId: string) {
  return queryOptions({
    queryKey: ['admin', 'nodes', nodeId, 'path'],
    queryFn: ({ signal }) => apiGet(`/admin/nodes/${nodeId}/path`, nodePathSchema, { signal }),
  })
}

export function adminChildrenQuery(nodeId: string) {
  return infiniteQueryOptions({
    queryKey: ['admin', 'nodes', nodeId, 'children'],
    queryFn: ({ pageParam, signal }) =>
      apiGet(`/admin/nodes/${nodeId}/children`, nodePageSchema, {
        query: { sort: 'name', order: 'asc', cursor: pageParam, limit: 200 },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
}

export const channelsQuery = queryOptions({
  queryKey: ['admin', 'channels'],
  queryFn: ({ signal }) => apiGet('/admin/channels', storageChannelListSchema, { signal }),
})

export const auditQuery = infiniteQueryOptions({
  queryKey: ['admin', 'audit'],
  queryFn: ({ pageParam, signal }) =>
    apiGet('/admin/audit', auditPageSchema, { query: { cursor: pageParam, limit: 100 }, signal }),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.nextCursor,
})

export function useUpdateUser() {
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: UpdateUserInput }) =>
      apiSend('PATCH', `/admin/users/${id}`, changes, adminUserSchema),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
        // An admin may have changed their own quota.
        queryClient.invalidateQueries({ queryKey: ['session'] }),
      ]),
  })
}

export function useModerateNode() {
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiSend('DELETE', `/admin/nodes/${id}`, { reason }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin'] }),
        queryClient.invalidateQueries({ queryKey: ['trash'] }),
      ]),
  })
}

export function useCreateChannel() {
  return useMutation({
    mutationFn: (input: CreateChannelInput) =>
      apiSend('POST', '/admin/channels', input, storageChannelSchema),
    onSettled: invalidateChannels,
  })
}

/** Toggles a channel. The switch flips at once; a refusal flips it back. */
export function useSetChannelEnabled() {
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiSend('PATCH', `/admin/channels/${id}`, { enabled }, storageChannelSchema),
    onMutate: ({ id, enabled }) => {
      queryClient.setQueryData<StorageChannel[]>(channelsQuery.queryKey, (channels) =>
        channels?.map((channel) => (channel.id === id ? { ...channel, enabled } : channel)),
      )
    },
    onSettled: invalidateChannels,
  })
}

async function invalidateChannels(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: channelsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ])
}

import {
  adminSessionListSchema,
  adminSharePageSchema,
  adminUploadListSchema,
  adminTaskListSchema,
  adminTaskSchema,
  adminUserPageSchema,
  adminUserSchema,
  auditPageSchema,
  databaseStatusSchema,
  nodePageSchema,
  nodePathSchema,
  storageChannelListSchema,
  storageChannelSchema,
  storageStatusSchema,
  systemHealthSchema,
  systemInfoSchema,
  userUsageSchema,
  type CreateChannelInput,
  type AdminTask,
  type AdminTaskRequest,
  type CreateUserInput,
  type StorageChannel,
  type UpdateUserInput,
} from '@dfs/shared'
import { infiniteQueryOptions, queryOptions, useMutation } from '@tanstack/react-query'
import type { LoaderFunctionArgs } from 'react-router'
import { queryClient } from '@/app/query-client'
import { sessionQuery } from '@/features/auth/session'
import { z } from 'zod'
import { apiGet, apiSend } from '@/lib/api/client'

// The admin API (§9). Admins see other users' metadata, never content (D4).

const signedOutSchema = z.object({ ended: z.number() })

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

/** Admin → Storage (§9): what is stuck between staging and Discord, and what was lost. */
export const storageQuery = queryOptions({
  queryKey: ['admin', 'storage'],
  queryFn: ({ signal }) => apiGet('/admin/storage', storageStatusSchema, { signal }),
  refetchInterval: 30_000,
})

/** The latest tasks; while one is under way, they are checked every second. */
export const tasksQuery = queryOptions({
  queryKey: ['admin', 'tasks'],
  queryFn: ({ signal }) => apiGet('/admin/tasks', adminTaskListSchema, { signal }),
  refetchInterval: (query) =>
    query.state.data?.some((task) => task.state === 'pending' || task.state === 'running')
      ? 1000
      : 30_000,
})

export function isFinished(task: AdminTask): boolean {
  return task.state === 'done' || task.state === 'failed'
}

/** Asks the leading bot to do something now; the tasks list follows it. */
export function useStartTask() {
  return useMutation({
    mutationFn: (request: AdminTaskRequest) =>
      apiSend('POST', '/admin/tasks', request, adminTaskSchema),
    onSuccess: (task) => {
      queryClient.setQueryData<AdminTask[]>(tasksQuery.queryKey, (tasks) => [
        task,
        ...(tasks ?? []).filter((other) => other.id !== task.id),
      ])
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  })
}

/** What a finished task may have changed. */
export async function afterTask(): Promise<void> {
  await Promise.all(
    ['storage', 'channels', 'health', 'system'].map((key) =>
      queryClient.invalidateQueries({ queryKey: ['admin', key] }),
    ),
  )
}

/** Admin → System (§15): the settings in effect, the Discord layout, the disks. */
export const systemQuery = queryOptions({
  queryKey: ['admin', 'system'],
  queryFn: ({ signal }) => apiGet('/admin/system', systemInfoSchema, { signal }),
})

const clearedSchema = z.object({ freedBytes: z.number() })

export function useClearFrameCache() {
  return useMutation({
    mutationFn: () => apiSend('POST', '/admin/system/cache/clear', undefined, clearedSchema),
    onSettled: () =>
      Promise.all(
        ['system', 'health', 'audit'].map((key) =>
          queryClient.invalidateQueries({ queryKey: ['admin', key] }),
        ),
      ),
  })
}

/** Vacuums and analyzes a table of the Database page's list. */
export function useVacuumTable() {
  return useMutation({
    mutationFn: (name: string) =>
      apiSend('POST', `/admin/database/tables/${encodeURIComponent(name)}/vacuum`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'database'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
      ]),
  })
}

/** PostgreSQL now (§16): connections, running queries, tables. */
export const databaseQuery = queryOptions({
  queryKey: ['admin', 'database'],
  queryFn: ({ signal }) => apiGet('/admin/database', databaseStatusSchema, { signal }),
  refetchInterval: 10_000,
  staleTime: 0,
})

/** Cancels a connection's query, or ends the connection (audited). */
export function useSignalSession() {
  return useMutation({
    mutationFn: ({ pid, how }: { pid: number; how: 'cancel' | 'terminate' }) =>
      apiSend('POST', `/admin/database/sessions/${String(pid)}/${how}`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: databaseQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
      ]),
  })
}

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

/** What the audit log shows: some kinds of action (by prefix), and words. */
export interface AuditFilters {
  actions: string[]
  q: string
}

export function auditQuery({ actions, q }: AuditFilters) {
  return infiniteQueryOptions({
    queryKey: ['admin', 'audit', actions, q],
    queryFn: ({ pageParam, signal }) =>
      apiGet('/admin/audit', auditPageSchema, {
        query: {
          cursor: pageParam,
          limit: 100,
          actions: actions.length > 0 ? actions.join(',') : undefined,
          q: q || undefined,
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // A new filter keeps the list on screen until it arrives.
    placeholderData: (previous) => previous,
  })
}

// ── People and access ────────────────────────────────────────────────────────

/** Signed-in sessions: everyone's, or one user's. */
export function adminSessionsQuery(userId?: string) {
  return queryOptions({
    queryKey: ['admin', 'sessions', userId ?? 'everyone'],
    queryFn: ({ signal }) =>
      apiGet('/admin/sessions', adminSessionListSchema, { query: { userId }, signal }),
    refetchInterval: 30_000,
  })
}

export function adminSharesQuery(active: boolean) {
  return infiniteQueryOptions({
    queryKey: ['admin', 'shares', active],
    queryFn: ({ pageParam, signal }) =>
      apiGet('/admin/shares', adminSharePageSchema, {
        query: { cursor: pageParam, limit: 100, active: String(active) },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
}

export const adminUploadsQuery = queryOptions({
  queryKey: ['admin', 'uploads'],
  queryFn: ({ signal }) => apiGet('/admin/uploads', adminUploadListSchema, { signal }),
  refetchInterval: 10_000,
})

/** What ending someone's access may have changed. */
async function afterAccessChange(key: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin', key] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ])
}

export function useEndSession() {
  return useMutation({
    mutationFn: (key: string) => apiSend('DELETE', `/admin/sessions/${key}`),
    onSettled: () => afterAccessChange('sessions'),
  })
}

export function useSignOutUser() {
  return useMutation({
    mutationFn: (userId: string) =>
      apiSend('POST', `/admin/users/${userId}/sign-out`, undefined, signedOutSchema),
    onSettled: () => afterAccessChange('sessions'),
  })
}

export function useRevokeShareAsAdmin() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/admin/shares/${id}`),
    onSettled: () => afterAccessChange('shares'),
  })
}

export function useCancelUploadAsAdmin() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/admin/uploads/${id}`),
    onSettled: () => afterAccessChange('uploads'),
  })
}

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

/** `POST /admin/users` (D27). The caller shows the temporary password once. */
export function useCreateUser() {
  return useMutation({
    mutationFn: (input: CreateUserInput) => apiSend('POST', '/admin/users', input, adminUserSchema),
    onSettled: invalidateUsers,
  })
}

/** A new temporary password, which signs the user out everywhere (§7.1). */
export function useResetPassword() {
  return useMutation({
    mutationFn: ({ id, temporaryPassword }: { id: string; temporaryPassword: string }) =>
      apiSend('POST', `/admin/users/${id}/password`, { temporaryPassword }, adminUserSchema),
    onSettled: invalidateUsers,
  })
}

async function invalidateUsers(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ])
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

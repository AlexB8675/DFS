import {
  appTokenListSchema,
  deviceListSchema,
  madeAppTokenSchema,
  type MakeAppTokenInput,
} from '@dfs/shared'
import { queryOptions, useMutation } from '@tanstack/react-query'
import { queryClient } from '@/app/query-client'
import { apiGet, apiSend } from '@/lib/api/client'

/** The signed-in user's paired backup apps, newest first (§7.6). */
export function devicesQuery() {
  return queryOptions({
    queryKey: ['devices'],
    queryFn: ({ signal }) => apiGet('/devices', deviceListSchema, { signal }),
  })
}

/** Removing a device ends its token at once, so the app stops until it is paired again. */
export function useRemoveDevice() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/devices/${id}`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['devices'] }),
        // An admin's own device is also in Admin → Access, and removing it is in the audit log.
        queryClient.invalidateQueries({ queryKey: ['admin', 'devices'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
      ]),
  })
}

/** The signed-in user's app tokens, newest first: what lets an AI agent reach one folder. */
export function appTokensQuery() {
  return queryOptions({
    queryKey: ['app-tokens'],
    queryFn: ({ signal }) => apiGet('/app-tokens', appTokenListSchema, { signal }),
  })
}

/** Makes a token; the answer holds it, the only time it is ever shown. */
export function useMakeAppToken() {
  return useMutation({
    mutationFn: (input: MakeAppTokenInput) =>
      apiSend('POST', '/app-tokens', input, madeAppTokenSchema),
    // The answer holds the token: keep it in no cache, the dialog holds it alone.
    gcTime: 0,
    onSettled: invalidateAppTokens,
  })
}

/** Removing a token ends it at once. */
export function useRemoveAppToken() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/app-tokens/${id}`),
    onSettled: invalidateAppTokens,
  })
}

function invalidateAppTokens() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['app-tokens'] }),
    // The admin's view of everyone's tokens, and the audit log's entry for this one.
    queryClient.invalidateQueries({ queryKey: ['admin', 'app-tokens'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ])
}

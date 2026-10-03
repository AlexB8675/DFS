import {
  shareLinkPageSchema,
  shareLinkSchema,
  type CreateShareInput,
  type ShareLink,
} from '@dfs/shared'
import { queryOptions, useMutation } from '@tanstack/react-query'
import { queryClient } from '@/app/query-client'
import { apiGet, apiSend } from '@/lib/api/client'

export const sharesQuery = queryOptions({
  queryKey: ['shares'],
  queryFn: ({ signal }) => apiGet('/shares', shareLinkPageSchema, { signal }),
})

const refreshShares = () => queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey })

export function useCreateShare() {
  return useMutation({
    mutationFn: (input: CreateShareInput) => apiSend('POST', '/shares', input, shareLinkSchema),
    onSettled: refreshShares,
  })
}

export function useRevokeShare() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/shares/${id}`),
    onSettled: refreshShares,
  })
}

export type ShareStatus = 'active' | 'expired' | 'revoked' | 'used-up'

export function shareStatus(share: ShareLink, now: Date = new Date()): ShareStatus {
  if (share.revokedAt) return 'revoked'
  if (share.expiresAt && new Date(share.expiresAt) <= now) return 'expired'
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return 'used-up'
  return 'active'
}

import { deviceListSchema } from '@dfs/shared'
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
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  })
}

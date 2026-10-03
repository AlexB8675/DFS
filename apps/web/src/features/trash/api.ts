import { trashPageSchema } from '@dfs/shared'
import { infiniteQueryOptions, useMutation } from '@tanstack/react-query'
import { invalidateDriveData } from '@/features/drive/api'
import { apiGet, apiSend } from '@/lib/api/client'

export const trashQuery = infiniteQueryOptions({
  queryKey: ['trash'],
  queryFn: ({ pageParam, signal }) =>
    apiGet('/trash', trashPageSchema, { query: { cursor: pageParam, limit: 100 }, signal }),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.nextCursor,
})

export function useDeleteForever() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/trash/${id}`),
    onSettled: invalidateDriveData,
  })
}

export function useEmptyTrash() {
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/trash'),
    onSettled: invalidateDriveData,
  })
}

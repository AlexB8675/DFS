import {
  shareCountSchema,
  shareLinkPageSchema,
  shareLinkSchema,
  type CreateShareInput,
  type ShareCountInput,
  type ShareLink,
  type UpdateShareInput,
} from '@dfs/shared'
import { queryOptions, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { queryClient } from '@/app/query-client'
import { apiGet, apiSend } from '@/lib/api/client'
import { formatFullDate } from '@/lib/format'

export const sharesQuery = queryOptions({
  queryKey: ['shares'],
  queryFn: ({ signal }) => apiGet('/shares', shareLinkPageSchema, { signal }),
})

/** Outstanding links to these items or what's inside them, or to anything in the trash (§7.5). */
export async function countShareLinks(input: ShareCountInput): Promise<number> {
  return (await apiSend('POST', '/shares/count', input, shareCountSchema)).links
}

/** “1 share link” or “3 share links”. */
export function linkCount(links: number): string {
  return `${String(links)} share ${links === 1 ? 'link' : 'links'}`
}

const refreshShares = () => queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey })

export function useCreateShare() {
  return useMutation({
    mutationFn: (input: CreateShareInput) => apiSend('POST', '/shares', input, shareLinkSchema),
    onSettled: refreshShares,
  })
}

export function useUpdateShare() {
  return useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: UpdateShareInput }) =>
      apiSend('PATCH', `/shares/${id}`, changes, shareLinkSchema),
    onSettled: refreshShares,
  })
}

/** Expiry choices for a link, in days from now. */
export const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
] as const

/** The expiry timestamp for one of the choices above. */
export function expiryFromChoice(choice: string, now = Date.now()): string | null {
  return choice === 'never' ? null : new Date(now + Number(choice) * 86_400_000).toISOString()
}

/** Turns a link off, which deletes it. */
export function useDeleteShare() {
  return useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/shares/${id}`),
    onSettled: refreshShares,
  })
}

/** Copies a link to the clipboard, saying so; `false` if the browser refused. */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Link copied')
    return true
  } catch {
    toast.error('Could not copy. Select the link and copy it manually.')
    return false
  }
}

/** A link made before DFS kept links has no address to show again (§7.5). */
export const NOT_KEPT =
  'This link was made before DFS kept links, so it can’t be shown again. To share the item, make a new one.'

/** What a link allows, in a few words: its expiry, password and downloads. */
export function linkTerms(share: ShareLink): string {
  return [
    share.expiresAt ? `Until ${formatFullDate(share.expiresAt)}` : 'Never expires',
    share.hasPassword && 'password',
    share.maxDownloads !== null &&
      `${String(share.downloadCount)} of ${String(share.maxDownloads)} downloads`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export type ShareStatus = 'active' | 'expired' | 'used-up' | 'version-deleted'

export function shareStatus(share: ShareLink, now: Date = new Date()): ShareStatus {
  // The version a file link served was deleted: it works no more (§7.5).
  if (share.version === 'deleted') return 'version-deleted'
  if (share.expiresAt && new Date(share.expiresAt) <= now) return 'expired'
  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) return 'used-up'
  return 'active'
}

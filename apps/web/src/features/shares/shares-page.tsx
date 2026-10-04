import type { ShareLink } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { Link2, Lock, Pencil, Unlink } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { NodeIcon } from '@/components/node-icon'
import { PageHeader } from '@/components/page-header'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ListSkeleton } from '@/components/list-skeleton'
import { errorMessage } from '@/lib/api/client'
import { formatDate, formatFullDate } from '@/lib/format'
import { shareStatus, sharesQuery, useRevokeShare, type ShareStatus } from './api'
import { EditShareDialog } from './edit-share-dialog'

const STATUS_BADGES: Record<
  ShareStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  active: { label: 'Active', variant: 'default' },
  expired: { label: 'Expired', variant: 'secondary' },
  'used-up': { label: 'Limit reached', variant: 'secondary' },
  revoked: { label: 'Revoked', variant: 'outline' },
}

/** `/shared`: the user's public share links (§7.5). */
export function SharesPage() {
  const shares = useQuery(sharesQuery)
  const revoke = useRevokeShare()
  const [revoking, setRevoking] = useState<ShareLink | null>(null)
  const [editing, setEditing] = useState<ShareLink | null>(null)
  const links = shares.data?.items ?? []

  async function confirmRevoke() {
    if (!revoking) return
    try {
      await revoke.mutateAsync(revoking.id)
      toast.success(`Link to “${revoking.nodeName}” revoked`)
    } catch (error) {
      toast.error('Could not revoke the link', { description: errorMessage(error) })
    }
    setRevoking(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Shared links – DFS</title>
      <PageHeader
        title="Shared links"
        description="Links you created. To share something new, right-click it and choose Share link."
      />

      {shares.isPending ? (
        <ListSkeleton />
      ) : links.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Link2 />
            </EmptyMedia>
            <EmptyTitle>No shared links</EmptyTitle>
            <EmptyDescription>
              Right-click a file or folder and choose Share link to create one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-2 pl-5 font-medium">Item</th>
                <th className="w-32 py-2 pl-4 font-medium">Status</th>
                <th className="hidden w-32 py-2 pl-4 font-medium md:table-cell">Created</th>
                <th className="hidden w-48 py-2 pl-4 font-medium md:table-cell">Expires</th>
                <th className="hidden w-28 py-2 pl-4 text-right font-medium sm:table-cell">
                  Downloads
                </th>
                <th className="w-24 py-2 pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => {
                const status = shareStatus(link)
                const badge = STATUS_BADGES[status]
                return (
                  <tr key={link.id} className="border-b border-border/50 hover:bg-muted/40">
                    <td className="py-2.5 pl-5">
                      <span className="flex min-w-0 items-center gap-3">
                        <NodeIcon
                          node={{ kind: link.nodeKind, name: link.nodeName, mimeType: null }}
                          className="size-5 shrink-0"
                        />
                        <span className="min-w-0 truncate" title={link.nodeName}>
                          {link.nodeName}
                        </span>
                        {link.hasPassword && (
                          <Lock
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-label="Password protected"
                          />
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 pl-4">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td
                      className="hidden truncate py-2.5 pl-4 text-muted-foreground md:table-cell"
                      title={formatFullDate(link.createdAt)}
                    >
                      {formatDate(link.createdAt)}
                    </td>
                    <td className="hidden truncate py-2.5 pl-4 text-muted-foreground md:table-cell">
                      {link.expiresAt ? formatFullDate(link.expiresAt) : 'Never'}
                    </td>
                    <td className="hidden py-2.5 pl-4 text-right text-muted-foreground tabular-nums sm:table-cell">
                      {link.downloadCount}
                      {link.maxDownloads !== null && ` / ${link.maxDownloads}`}
                    </td>
                    <td className="py-2.5 pr-5 text-right">
                      {status !== 'revoked' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Edit link to “${link.nodeName}”`}
                              onClick={() => {
                                setEditing(link)
                              }}
                            >
                              <Pencil />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit expiry, password and limit</TooltipContent>
                        </Tooltip>
                      )}
                      {status !== 'revoked' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Revoke link to “${link.nodeName}”`}
                              onClick={() => {
                                setRevoking(link)
                              }}
                            >
                              <Unlink />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Revoke link</TooltipContent>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditShareDialog
          link={editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone who has the link to “{revoking?.nodeName}” will lose access right away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmRevoke()}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

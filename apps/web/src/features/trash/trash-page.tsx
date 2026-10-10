import type { TrashItem } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { RotateCcw, ShieldAlert, Trash2 } from 'lucide-react'
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
import { useRestoreNodes } from '@/features/drive/api'
import { ListSkeleton } from '@/components/list-skeleton'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { countShareLinks, linkCount } from '@/features/shares/api'
import { LinkWarning } from '@/features/shares/link-warning'
import { trashQuery, useDeleteForever, useEmptyTrash } from './api'

type Confirmation = { kind: 'delete'; item: TrashItem } | { kind: 'empty' }

/** `/trash`: trashed items, restorable until they are purged (§6.4). */
export function TrashPage() {
  const trash = useInfiniteQuery(trashQuery)
  const restore = useRestoreNodes()
  const deleteForever = useDeleteForever()
  const emptyTrash = useEmptyTrash()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  // The share links deleting forever would delete with it (§7.5).
  const links = useQuery({
    queryKey: ['share-count', confirmation?.kind === 'delete' ? confirmation.item.id : 'trash'],
    queryFn: () =>
      countShareLinks(
        confirmation?.kind === 'delete' ? { ids: [confirmation.item.id] } : { trash: true },
      ),
    enabled: confirmation !== null,
    staleTime: 0,
  })
  const items = trash.data?.pages.flatMap((page) => page.items) ?? []
  const retentionDays = trash.data?.pages[0]?.retentionDays

  async function handleRestore(item: TrashItem) {
    try {
      await restore.mutateAsync([item.id])
      toast.success(`Restored “${item.name}”`, {
        description: `Back in ${item.location || 'My Drive'}`,
      })
    } catch (error) {
      toast.error('Could not restore', { description: errorMessage(error) })
    }
  }

  async function handleConfirm() {
    if (!confirmation) return
    try {
      if (confirmation.kind === 'empty') {
        await emptyTrash.mutateAsync()
        toast.success('Trash emptied')
      } else {
        await deleteForever.mutateAsync(confirmation.item.id)
        toast.success(`Deleted “${confirmation.item.name}” forever`)
      }
    } catch (error) {
      toast.error('Could not delete', { description: errorMessage(error) })
    }
    setConfirmation(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Trash – DFS</title>
      <PageHeader
        title="Trash"
        description={
          retentionDays === undefined
            ? 'Items in the trash still count toward your storage.'
            : `Items in the trash still count toward your storage and are deleted forever after ${String(retentionDays)} ${retentionDays === 1 ? 'day' : 'days'}.`
        }
        actions={
          <Button
            variant="outline"
            disabled={items.length === 0}
            onClick={() => {
              setConfirmation({ kind: 'empty' })
            }}
          >
            <Trash2 /> Empty trash
          </Button>
        }
      />

      {trash.isPending ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Trash2 />
            </EmptyMedia>
            <EmptyTitle>Trash is empty</EmptyTitle>
            <EmptyDescription>Items you move to the trash will show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Fixed layout: the name column takes the remaining width and truncates. */}
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr className="border-b text-left">
                <th className="py-2 pl-5 font-medium">Name</th>
                <th className="hidden w-56 py-2 pl-4 font-medium @min-[52rem]:table-cell">
                  Original location
                </th>
                <th className="hidden w-32 py-2 pl-4 font-medium @min-[38rem]:table-cell">
                  Deleted
                </th>
                <th className="hidden w-24 py-2 pl-4 text-right font-medium @min-[38rem]:table-cell">
                  Size
                </th>
                <th className="w-40 py-2 pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border/50 hover:bg-muted/40">
                  <td className="py-2 pl-5">
                    <span className="flex min-w-0 items-center gap-3">
                      <NodeIcon node={item} className="size-5 shrink-0" />
                      {/* The badge goes under the name when it doesn't fit beside it. */}
                      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="max-w-full truncate" title={item.name}>
                          {item.name}
                        </span>
                        {item.moderationReason && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="destructive" className="shrink-0">
                                <ShieldAlert /> Removed by admin
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>{item.moderationReason}</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </span>
                  </td>
                  <td
                    className="hidden truncate py-2 pl-4 text-muted-foreground @min-[52rem]:table-cell"
                    title={item.location}
                  >
                    {item.location}
                  </td>
                  <td
                    className="hidden truncate py-2 pl-4 text-muted-foreground @min-[38rem]:table-cell"
                    title={formatFullDate(item.deletedAt)}
                  >
                    {formatDate(item.deletedAt)}
                  </td>
                  <td className="hidden py-2 pl-4 text-right whitespace-nowrap text-muted-foreground tabular-nums @min-[38rem]:table-cell">
                    {formatBytes(item.sizeBytes)}
                  </td>
                  <td className="py-2 pr-5">
                    <span className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void handleRestore(item)}>
                        <RotateCcw /> Restore
                      </Button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete “${item.name}” forever`}
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              setConfirmation({ kind: 'delete', item })
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete forever</TooltipContent>
                      </Tooltip>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trash.hasNextPage && (
            <div className="flex justify-center p-3">
              <Button
                variant="outline"
                disabled={trash.isFetchingNextPage}
                onClick={() => void trash.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === 'delete'
                ? `Delete “${confirmation.item.name}” forever?`
                : 'Empty the trash?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === 'delete'
                ? 'It will be deleted immediately and cannot be recovered.'
                : 'Everything in the trash will be deleted immediately and cannot be recovered.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {links.data !== undefined && links.data > 0 && (
            <LinkWarning>
              {confirmation?.kind === 'delete'
                ? `${linkCount(links.data)} to ${confirmation.item.kind === 'folder' ? 'it or what’s inside it' : 'it'} will be deleted too, and stop working for good.`
                : `${linkCount(links.data)} to items in the trash will be deleted too, and stop working for good.`}
            </LinkWarning>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleConfirm()}>
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

import type { DriveNode } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Folder, HardDrive } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useCurrentUser } from '@/features/auth/session'
import { errorMessage } from '@/lib/api/client'
import { childFoldersQuery, pathQuery, useMoveNodes } from '../api'

interface MoveDialogProps {
  nodes: DriveNode[]
  onClose: () => void
}

/** Picks a destination folder by browsing, then moves the nodes there. */
export function MoveDialog({ nodes, onClose }: MoveDialogProps) {
  const { rootFolderId } = useCurrentUser()
  const [folderId, setFolderId] = useState(nodes[0]?.parentId ?? rootFolderId)
  const path = useQuery(pathQuery(folderId))
  const subfolders = useInfiniteQuery(childFoldersQuery(folderId))
  const move = useMoveNodes()

  const movingIds = new Set(nodes.map((node) => node.id))
  const current = path.data?.at(-1)
  const parent = path.data?.at(-2)
  const alreadyThere = nodes.every((node) => node.parentId === folderId)
  const folders = subfolders.data?.pages.flatMap((page) => page.items) ?? []
  const [first] = nodes
  const subject = nodes.length === 1 && first ? `“${first.name}”` : `${nodes.length} items`

  async function confirm() {
    try {
      await move.mutateAsync({ ids: [...movingIds], parentId: folderId })
      toast.success(`Moved ${subject} to “${current?.name ?? 'folder'}”`)
      onClose()
    } catch (error) {
      toast.error('Could not move', { description: errorMessage(error) })
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Move {subject}</DialogTitle>
          <DialogDescription>
            Open the folder you want to move to, then choose Move here.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-hidden rounded-lg border">
          <div className="flex h-11 items-center gap-1 border-b bg-muted/30 px-2 text-sm">
            {parent ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Back to ${parent.name}`}
                onClick={() => {
                  setFolderId(parent.id)
                }}
              >
                <ArrowLeft />
              </Button>
            ) : (
              <HardDrive className="mx-1.5 size-4 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate font-medium">{current?.name ?? '…'}</span>
          </div>
          <ul className="h-64 overflow-y-auto p-1" aria-label="Folders">
            {subfolders.isPending &&
              Array.from({ length: 4 }, (_, index) => (
                <li key={index} className="flex h-9 items-center px-2">
                  <Skeleton className="h-4 w-40" />
                </li>
              ))}
            {!subfolders.isPending && folders.length === 0 && (
              <li className="px-2 py-8 text-center text-sm text-muted-foreground">
                No folders here.
              </li>
            )}
            {folders.map((folder) => {
              const isMoving = movingIds.has(folder.id)
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    disabled={isMoving}
                    title={isMoving ? 'A folder cannot be moved into itself' : undefined}
                    className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      setFolderId(folder.id)
                    }}
                  >
                    <Folder className="size-4 shrink-0 fill-sky-500/25 text-sky-500" aria-hidden />
                    <span className="truncate">{folder.name}</span>
                    <ChevronRight
                      className="ml-auto size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  </button>
                </li>
              )
            })}
            {subfolders.hasNextPage && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => void subfolders.fetchNextPage()}
                >
                  Show more
                </Button>
              </li>
            )}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={alreadyThere || move.isPending || !current}
            onClick={() => void confirm()}
          >
            {move.isPending && <Spinner />} Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

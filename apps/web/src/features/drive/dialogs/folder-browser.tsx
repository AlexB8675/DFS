import type { DriveNode } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Folder, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { childFoldersQuery, pathQuery } from '../api'

interface FolderBrowserProps {
  folderId: DriveNode['id']
  onFolderChange: (folderId: string) => void
  /** Folders that can be seen but not opened (a folder cannot be moved into itself). */
  disabledIds?: ReadonlySet<string>
}

/** A pane for browsing down the folders, one level at a time, with a way back up. */
export function FolderBrowser({ folderId, onFolderChange, disabledIds }: FolderBrowserProps) {
  const path = useQuery(pathQuery(folderId))
  const subfolders = useInfiniteQuery(childFoldersQuery(folderId))
  const current = path.data?.at(-1)
  const parent = path.data?.at(-2)
  const folders = subfolders.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex h-11 items-center gap-1 border-b bg-muted/30 px-2 text-sm">
        {parent ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Back to ${parent.name}`}
            onClick={() => {
              onFolderChange(parent.id)
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
          <li className="px-2 py-8 text-center text-sm text-muted-foreground">No folders here.</li>
        )}
        {folders.map((folder) => {
          const isMoving = disabledIds?.has(folder.id) ?? false
          return (
            <li key={folder.id}>
              <button
                type="button"
                disabled={isMoving}
                title={isMoving ? 'A folder cannot be moved into itself' : undefined}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  onFolderChange(folder.id)
                }}
              >
                <Folder
                  className="size-4 shrink-0 fill-sky-600/25 text-sky-600 dark:fill-sky-500/25 dark:text-sky-500"
                  aria-hidden
                />
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
              type="button"
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
  )
}

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { FolderOpen, FolderPlus, FolderX, Upload } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { ListSkeleton } from '@/components/list-skeleton'
import { useCurrentUser } from '@/features/auth/session'
import { DropZone } from '@/features/uploads/drop-zone'
import { ApiError } from '@/lib/api/client'
import { transitionLinkProps, useTransitionNavigate } from '@/lib/navigation'
import { usePreferences } from '@/lib/preferences'
import { childrenQuery, nodeQuery, pathQuery } from './api'
import { Breadcrumbs } from './breadcrumbs'
import { DriveToolbar } from './drive-toolbar'
import { NodeList } from './node-list'
import { SelectionProvider } from './selection-provider'
import { StatusBar } from './status-bar'
import { folderUrl, useNodeActions } from './use-node-actions'

/** `/drive` and `/drive/:folderId`: the contents of one folder. */
export function DrivePage() {
  const { folderId } = useParams()
  const { rootFolderId } = useCurrentUser()
  const id = folderId ?? rootFolderId
  // Keyed by folder, so selection and scroll position start fresh in each one.
  return <FolderView key={id} folderId={id} />
}

function FolderView({ folderId }: { folderId: string }) {
  const navigate = useTransitionNavigate()
  const [searchParams] = useSearchParams()
  const { rootFolderId } = useCurrentUser()
  const sort = usePreferences((state) => state.sortField)
  const order = usePreferences((state) => state.sortOrder)
  const actions = useNodeActions()

  const path = useQuery(pathQuery(folderId))
  const folder = useQuery(nodeQuery(folderId))
  const children = useInfiniteQuery({
    ...childrenQuery(folderId, { sort, order }),
    // Keep showing the old order while a new sort loads.
    placeholderData: keepPreviousData,
  })

  const error = path.error ?? children.error
  if (error) return <FolderError error={error} />

  const nodes = children.data?.pages.flatMap((page) => page.items) ?? []
  const name = path.data?.at(-1)?.name ?? ''
  const parent = path.data?.at(-2)

  return (
    <SelectionProvider initialId={searchParams.get('select')}>
      {name && <title>{`${name} – DFS`}</title>}
      <DropZone folderId={folderId} folderName={name}>
        <DriveToolbar
          nodes={nodes}
          title={
            path.data ? (
              <Breadcrumbs path={path.data} folder={folder.data} />
            ) : (
              <Skeleton className="h-5 w-48" />
            )
          }
        />
        {children.isPending ? (
          <ListSkeleton />
        ) : (
          <NodeList
            nodes={nodes}
            folderId={folderId}
            label={`Contents of ${name}`}
            hasMore={children.hasNextPage}
            isLoadingMore={children.isFetchingNextPage}
            onLoadMore={() => void children.fetchNextPage()}
            onBack={
              parent
                ? () => {
                    navigate(folderUrl(parent.id, rootFolderId), 'back')
                  }
                : undefined
            }
            empty={
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpen />
                  </EmptyMedia>
                  <EmptyTitle>This folder is empty</EmptyTitle>
                  <EmptyDescription>
                    Drag files or folders here, or use the buttons below.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="flex-row justify-center">
                  <Button
                    onClick={() => {
                      actions.newFolder(folderId)
                    }}
                  >
                    <FolderPlus /> New folder
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      actions.uploadFiles(folderId)
                    }}
                  >
                    <Upload /> Upload files
                  </Button>
                </EmptyContent>
              </Empty>
            }
          />
        )}
        <StatusBar nodes={nodes} hasMore={children.hasNextPage} />
      </DropZone>
    </SelectionProvider>
  )
}

function FolderError({ error }: { error: Error }) {
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderX />
        </EmptyMedia>
        <EmptyTitle>{notFound ? 'Folder not found' : 'Could not load this folder'}</EmptyTitle>
        <EmptyDescription>
          {notFound ? 'It may have been moved to the trash or deleted.' : error.message}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/drive" {...transitionLinkProps('section')}>
            Go to My Drive
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

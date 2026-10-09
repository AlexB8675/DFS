import type { DriveNode, NodePath } from '@dfs/shared'
import { ChevronDown, ChevronRight, Ellipsis, HardDrive } from 'lucide-react'
import { Fragment } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCurrentUser } from '@/features/auth/session'
import { dropTargetProps, useDragFeedback } from '@/features/drag/drag-store'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { DropdownMenuActions } from './menu-actions'
import { useNodeMenu } from './node-menu'
import { folderUrl } from './use-node-actions'

/**
 * Ancestors beyond this many collapse into a "…" menu. On a phone, only the
 * parent shows, as the way up: the width holds no more, and the navigation
 * menu has the whole tree.
 */
const MAX_VISIBLE_ANCESTORS = 3

interface BreadcrumbsProps {
  path: NodePath
  /** The current folder, once loaded; enables rename/move/share on it. */
  folder: DriveNode | undefined
}

/** The folder path, with a menu of folder actions on the last segment. */
export function Breadcrumbs({ path, folder }: BreadcrumbsProps) {
  const { rootFolderId } = useCurrentUser()
  const current = path.at(-1)
  const ancestors = path.slice(0, -1)
  const collapse = ancestors.length > MAX_VISIBLE_ANCESTORS
  const hidden = collapse ? ancestors.slice(1, -1) : []
  const shown = collapse
    ? [ancestors[0], ancestors.at(-1)].filter((entry) => entry !== undefined)
    : ancestors

  const folderActions = useNodeMenu([], current?.id ?? null)
  const isRoot = current?.id === rootFolderId
  const nodeActions = useNodeMenu(folder && !isRoot ? [folder] : [], null).filter(
    (action) => action.key !== 'open',
  )

  if (!current) return null

  return (
    <nav aria-label="Folder path" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        {shown.map((entry, index) => {
          // On a phone, the parent alone.
          const phone = index === shown.length - 1 ? undefined : 'max-sm:hidden'
          return (
            <Fragment key={entry.id}>
              {index === 1 && hidden.length > 0 && (
                <>
                  <li className="max-sm:hidden">
                    <HiddenSegments segments={hidden} />
                  </li>
                  <Separator className="max-sm:hidden" />
                </>
              )}
              <li className={cn('min-w-0', phone)}>
                <AncestorLink entry={entry} isRoot={entry.id === rootFolderId} />
              </li>
              <Separator className={phone} />
            </Fragment>
          )
        })}
        {/* The folder you are in first: up to most of the width, the path above taking the rest. */}
        <li className="max-w-[60%] min-w-0 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="max-w-full text-base font-semibold">
                {isRoot && <HardDrive />}
                <span className="truncate" title={current.name}>
                  {current.name}
                </span>
                <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuActions actions={folderActions} />
              {nodeActions.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuActions actions={nodeActions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ol>
    </nav>
  )
}

/** The "…" for folders up the path that aren't shown, as a menu of them. */
function HiddenSegments({ segments }: { segments: NodePath }) {
  const { rootFolderId } = useCurrentUser()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Show hidden path segments">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {segments.map((segment) => (
          <DropdownMenuItem key={segment.id} asChild>
            <Link to={folderUrl(segment.id, rootFolderId)} {...transitionLinkProps('back')}>
              {segment.id === rootFolderId && <HardDrive />}
              {segment.name}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A folder up the path. Items can be dropped on it to move them there. */
function AncestorLink({ entry, isRoot }: { entry: NodePath[number]; isRoot: boolean }) {
  const { rootFolderId } = useCurrentUser()
  const drag = useDragFeedback(entry.id)
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        // Within its place in the path, which shrinks: the name truncates.
        'max-w-[min(12rem,100%)] text-muted-foreground',
        drag.over && 'scale-105 bg-(--drop-target) text-foreground ring-1 ring-primary/60',
        drag.springing && 'animate-[spring-load_450ms_ease-in-out]',
      )}
      asChild
    >
      <Link
        to={folderUrl(entry.id, rootFolderId)}
        {...transitionLinkProps('back')}
        draggable={false}
        {...dropTargetProps(entry)}
      >
        {isRoot && <HardDrive />}
        <span className="truncate">{entry.name}</span>
      </Link>
    </Button>
  )
}

function Separator({ className }: { className?: string | undefined }) {
  return (
    <li aria-hidden className={cn('text-muted-foreground/60', className)}>
      <ChevronRight className="size-4" />
    </li>
  )
}

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
import { DropdownMenuActions } from './menu-actions'
import { useNodeMenu } from './node-menu'
import { folderUrl } from './use-node-actions'

/** Ancestors beyond this many collapse into a "…" menu. */
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
        {shown.map((entry, index) => (
          <Fragment key={entry.id}>
            {index === 1 && hidden.length > 0 && (
              <>
                <li>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Show hidden path segments">
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {hidden.map((segment) => (
                        <DropdownMenuItem key={segment.id} asChild>
                          <Link to={folderUrl(segment.id, rootFolderId)}>{segment.name}</Link>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
                <Separator />
              </>
            )}
            <li className="min-w-0">
              <Button variant="ghost" size="sm" className="max-w-48 text-muted-foreground" asChild>
                <Link to={folderUrl(entry.id, rootFolderId)}>
                  {entry.id === rootFolderId && <HardDrive />}
                  <span className="truncate">{entry.name}</span>
                </Link>
              </Button>
            </li>
            <Separator />
          </Fragment>
        ))}
        <li className="min-w-0">
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

function Separator() {
  return (
    <li aria-hidden className="text-muted-foreground/60">
      <ChevronRight className="size-4" />
    </li>
  )
}

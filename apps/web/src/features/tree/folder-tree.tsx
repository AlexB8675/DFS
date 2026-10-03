import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronRight, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { useEffect, type KeyboardEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/features/auth/session'
import { childFoldersQuery, pathQuery } from '@/features/drive/api'
import { folderUrl } from '@/features/drive/use-node-actions'
import { cn } from '@/lib/utils'
import { useTreeStore } from './tree-store'

const INDENT_PX = 14

/**
 * The expandable folder tree in the sidebar. Children load lazily when a
 * folder is expanded, and the ancestors of the open folder expand on their
 * own. It follows the WAI-ARIA navigation treeview pattern: links are the tree
 * items, and the arrow keys move between them.
 */
export function FolderTree({ onNavigate }: { onNavigate?: () => void }) {
  const { rootFolderId } = useCurrentUser()
  const { folderId } = useParams()
  const { pathname } = useLocation()
  const currentId = folderId ?? (pathname === '/drive' ? rootFolderId : null)

  const expand = useTreeStore((state) => state.expand)
  const toggle = useTreeStore((state) => state.toggle)
  const path = useQuery({ ...pathQuery(currentId ?? rootFolderId), enabled: currentId !== null })
  const trail = path.data

  useEffect(() => {
    expand([rootFolderId, ...(trail?.slice(0, -1).map((entry) => entry.id) ?? [])])
  }, [trail, rootFolderId, expand])

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (!(event.target instanceof HTMLElement)) return
    const item = event.target.closest<HTMLElement>('[role="treeitem"]')
    if (!item) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const index = items.indexOf(item)
    const expanded = item.getAttribute('aria-expanded')
    const id = item.dataset.folderId

    const focus = (target: HTMLElement | null | undefined) => {
      if (!target) return
      event.preventDefault()
      target.focus()
    }

    switch (event.key) {
      case 'ArrowDown':
        focus(items[index + 1])
        break
      case 'ArrowUp':
        focus(items[index - 1])
        break
      case 'Home':
        focus(items[0])
        break
      case 'End':
        focus(items.at(-1))
        break
      case 'ArrowRight':
        if (expanded === 'false' && id) {
          event.preventDefault()
          toggle(id)
        } else if (expanded === 'true') {
          focus(items[index + 1])
        }
        break
      case 'ArrowLeft':
        if (expanded === 'true' && id) {
          event.preventDefault()
          toggle(id)
        } else {
          focus(parentItem(item))
        }
        break
    }
  }

  return (
    <ul role="tree" aria-label="Folders" className="text-sm" onKeyDown={handleKeyDown}>
      <TreeItem
        id={rootFolderId}
        name="My Drive"
        level={1}
        hasChildren
        currentId={currentId}
        onNavigate={onNavigate}
      />
    </ul>
  )
}

interface TreeItemProps {
  id: string
  name: string
  level: number
  hasChildren: boolean
  currentId: string | null
  onNavigate: (() => void) | undefined
}

function TreeItem({ id, name, level, hasChildren, currentId, onNavigate }: TreeItemProps) {
  const { rootFolderId } = useCurrentUser()
  const expanded = useTreeStore((state) => state.expanded.has(id))
  const toggle = useTreeStore((state) => state.toggle)
  const children = useInfiniteQuery({ ...childFoldersQuery(id), enabled: expanded && hasChildren })

  const isRoot = level === 1
  const isCurrent = id === currentId
  const Icon = isRoot ? HardDrive : expanded && hasChildren ? FolderOpen : Folder
  const folders = children.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <li role="none">
      <Link
        ref={(element) => {
          // Keep the open folder in view, e.g. after jumping deep from a search result.
          if (isCurrent) element?.scrollIntoView({ block: 'nearest' })
        }}
        to={folderUrl(id, rootFolderId)}
        role="treeitem"
        aria-level={level}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-current={isCurrent ? 'page' : undefined}
        tabIndex={isRoot ? 0 : -1}
        data-folder-id={id}
        title={name}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md pr-2 transition-colors outline-none select-none',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          isCurrent && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
        )}
        style={{ paddingLeft: (level - 1) * INDENT_PX + 4 }}
        onClick={onNavigate}
      >
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10"
          onClick={(event) => {
            // The arrow toggles; the rest of the row navigates.
            event.preventDefault()
            event.stopPropagation()
            if (hasChildren) toggle(id)
          }}
        >
          {hasChildren && (
            <ChevronRight
              className={cn('size-3.5 transition-transform duration-200', expanded && 'rotate-90')}
              aria-hidden
            />
          )}
        </span>
        <Icon
          className={cn(
            'size-4 shrink-0',
            isRoot ? 'text-muted-foreground' : 'fill-sky-500/25 text-sky-500',
          )}
          aria-hidden
        />
        <span className="truncate">{name}</span>
      </Link>

      {expanded && hasChildren && (
        // Subfolders ease in when a folder opens.
        <ul
          role="group"
          className="animate-in duration-200 ease-smooth fade-in-0 slide-in-from-top-1"
        >
          {children.isPending && (
            <li
              role="none"
              className="flex h-8 items-center"
              style={{ paddingLeft: level * INDENT_PX + 28 }}
            >
              <Skeleton className="h-3.5 w-24" />
            </li>
          )}
          {folders.map((folder) => (
            <TreeItem
              key={folder.id}
              id={folder.id}
              name={folder.name}
              level={level + 1}
              hasChildren={folder.hasChildFolders}
              currentId={currentId}
              onNavigate={onNavigate}
            />
          ))}
          {children.hasNextPage && (
            <li role="none" style={{ paddingLeft: level * INDENT_PX + 28 }}>
              <button
                type="button"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => void children.fetchNextPage()}
              >
                Show more folders
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

/** The tree item that contains `item`'s group. */
function parentItem(item: HTMLElement): HTMLElement | null {
  return (
    item.closest('[role="group"]')?.parentElement?.querySelector(':scope > [role="treeitem"]') ??
    null
  )
}

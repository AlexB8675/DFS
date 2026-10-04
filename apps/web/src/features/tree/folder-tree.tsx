import type { DriveNode } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronRight, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useCurrentUser } from '@/features/auth/session'
import { dropTargetProps, useDragFeedback } from '@/features/drag/drag-store'
import { childFoldersQuery, pathQuery } from '@/features/drive/api'
import { folderUrl } from '@/features/drive/use-node-actions'
import { usePrefetchOnHover } from '@/features/drive/use-prefetch-on-hover'
import { transitionLinkProps } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { useTreeStore } from './tree-store'

const INDENT_PX = 14

/**
 * The expandable folder tree in the sidebar. Children load lazily when a
 * folder is expanded, and the ancestors of the open folder expand on their
 * own. It follows the WAI-ARIA navigation treeview pattern: links are the tree
 * items, and the arrow keys move between them. Folders accept drag-to-move
 * drops, and a collapsed one springs open when a drag rests on it.
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
  const trailIds = new Set(trail?.map((entry) => entry.id))

  useEffect(() => {
    expand([rootFolderId, ...(trail?.slice(0, -1).map((entry) => entry.id) ?? [])])
  }, [trail, rootFolderId, expand])

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (!(event.target instanceof HTMLElement)) return
    const item = event.target.closest<HTMLElement>('[role="treeitem"]')
    if (!item) return
    // Items of a group that is still animating closed are inert; skip them.
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).filter((candidate) => !candidate.closest('[inert]'))
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
        trailIds={trailIds}
        onNavigate={onNavigate}
      />
    </ul>
  )
}

interface TreeItemProps {
  id: string
  /** The folder as listed by its parent; absent for the root. */
  node?: DriveNode
  name: string
  level: number
  hasChildren: boolean
  currentId: string | null
  /** The open folder and its ancestors, to tell going up from going down. */
  trailIds: ReadonlySet<string>
  onNavigate: (() => void) | undefined
}

function TreeItem({
  id,
  node,
  name,
  level,
  hasChildren,
  currentId,
  trailIds,
  onNavigate,
}: TreeItemProps) {
  const { rootFolderId } = useCurrentUser()
  const expanded = useTreeStore((state) => state.expanded.has(id))
  const toggle = useTreeStore((state) => state.toggle)
  const children = useInfiniteQuery({ ...childFoldersQuery(id), enabled: expanded && hasChildren })
  const prefetch = usePrefetchOnHover(node)
  const drag = useDragFeedback(id)

  // The group opens once its subfolders are loaded, in one motion to its
  // full height; opening it empty and then growing again would jump. Hovering
  // a folder prefetches them, so this is usually immediate.
  const loaded = children.data !== undefined || children.isError
  const open = expanded && hasChildren && loaded
  // Subfolders stay mounted while they animate closed, then unmount.
  const [showGroup, setShowGroup] = useState(open)
  if (open && !showGroup) setShowGroup(true)

  const isRoot = level === 1
  const isCurrent = id === currentId
  const waiting = expanded && hasChildren && !loaded
  const folders = children.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <li role="none" data-folder-scope={id}>
      <Link
        ref={(element) => {
          // Keep the open folder in view, e.g. after jumping deep from a search result.
          if (isCurrent) element?.scrollIntoView({ block: 'nearest' })
        }}
        to={folderUrl(id, rootFolderId)}
        {...transitionLinkProps(trailIds.has(id) ? 'back' : 'forward')}
        role="treeitem"
        aria-level={level}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-current={isCurrent ? 'page' : undefined}
        tabIndex={isRoot ? 0 : -1}
        draggable={false}
        data-folder-id={id}
        {...dropTargetProps({ id, name }, hasChildren && !expanded ? 'expand' : null)}
        {...prefetch}
        title={name}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md pr-2 transition-colors outline-none select-none',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          isCurrent && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
          drag.over && 'bg-(--drop-target) ring-1 ring-primary/60 ring-inset',
          drag.springing && 'animate-[spring-load_450ms_ease-in-out]',
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
              className={cn(
                'size-3.5 transition-transform motion-spring',
                expanded && 'rotate-90',
                waiting && 'animate-pulse',
              )}
              aria-hidden
            />
          )}
        </span>
        {isRoot ? (
          <HardDrive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FolderIcon open={expanded && hasChildren} />
        )}
        <span className="truncate">{name}</span>
      </Link>

      {hasChildren && showGroup && (
        // Animating the grid track from 0fr to 1fr opens the group to its
        // natural height and back; @starting-style plays it on first mount.
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] motion-glide starting:grid-rows-[0fr] starting:opacity-0',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
          inert={!open}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && !open) setShowGroup(false)
          }}
        >
          <ul role="group" className="min-h-0 overflow-hidden">
            {children.isError && (
              <li
                role="none"
                className="flex h-8 items-center gap-2 text-xs text-muted-foreground"
                style={{ paddingLeft: level * INDENT_PX + 28 }}
              >
                Couldn’t load folders
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => void children.refetch()}
                >
                  Retry
                </button>
              </li>
            )}
            {folders.map((folder) => (
              <TreeItem
                key={folder.id}
                id={folder.id}
                node={folder}
                name={folder.name}
                level={level + 1}
                hasChildren={folder.hasChildFolders}
                currentId={currentId}
                trailIds={trailIds}
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
        </div>
      )}
    </li>
  )
}

/**
 * A folder that opens when expanded. Both shapes are drawn on top of each
 * other and crossfade with a little scale, instead of one swapping for the other.
 */
function FolderIcon({ open }: { open: boolean }) {
  const shape =
    'absolute inset-0 size-4 fill-sky-500/25 text-sky-500 transition-[opacity,scale] motion-spring'
  return (
    <span className="relative size-4 shrink-0" aria-hidden>
      <Folder className={cn(shape, open ? 'scale-75 opacity-0' : 'scale-100 opacity-100')} />
      <FolderOpen className={cn(shape, open ? 'scale-100 opacity-100' : 'scale-75 opacity-0')} />
    </span>
  )
}

/** The tree item that contains `item`'s group. */
function parentItem(item: HTMLElement): HTMLElement | null {
  const parentScope = item
    .closest('[data-folder-scope]')
    ?.parentElement?.closest('[data-folder-scope]')
  return parentScope?.querySelector<HTMLElement>(':scope > [role="treeitem"]') ?? null
}

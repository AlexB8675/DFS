import type { DriveNode } from '@dfs/shared'
import type { MouseEvent, PointerEvent, ReactNode } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { VirtualList } from '@/components/virtual-list'
import { beginPointerDrag } from '@/features/drag/drag-controller'
import { DrivePreview } from '@/features/preview/drive-preview'
import { useElementWidth } from '@/lib/use-element-width'
import { usePreferences } from '@/lib/preferences'
import { ListHeader } from './list-header'
import { optionId, ROW_HEIGHT, TILE_HEIGHT, TILE_MIN_WIDTH, type ListedNode } from './list-layout'
import { ContextMenuActions } from './menu-actions'
import { useNodeMenu } from './node-menu'
import { NodeRow } from './node-row'
import { NodeTile } from './node-tile'
import { useSelection, useSelectionStore } from './selection'
import { useListKeyboard } from './use-list-keyboard'
import { useNodeActions } from './use-node-actions'

interface NodeListProps {
  nodes: ListedNode[]
  /** The folder being shown, for "New folder" and uploads on the background. `null` in search results. */
  folderId: string | null
  label: string
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  /** Goes to the parent folder (Backspace). */
  onBack?: () => void
  showLocation?: boolean
  sortable?: boolean
  /** Shown instead of the list when there are no nodes. */
  empty: ReactNode
}

/**
 * Files and folders as a virtualized list or grid, with mouse and keyboard
 * selection and a context menu, like a desktop file manager; files open in
 * the viewer over it (§10.3).
 */
export function NodeList({
  nodes,
  folderId,
  label,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onBack,
  showLocation = false,
  sortable = true,
  empty,
}: NodeListProps) {
  const viewMode = usePreferences((state) => state.viewMode)
  const store = useSelectionStore()
  const selected = useSelection((state) => state.selected)
  const activeId = useSelection((state) => state.activeId)
  const actions = useNodeActions()
  const [measureRef, width] = useElementWidth<HTMLDivElement>()

  const columns = viewMode === 'grid' ? Math.max(1, Math.floor(width / TILE_MIN_WIDTH)) : 1
  const menu = useNodeMenu(
    nodes.filter((node) => selected.has(node.id)),
    folderId,
    { reveal: showLocation },
  )
  const handleKeyDown = useListKeyboard(nodes, columns, onBack)
  const activeIndex = nodes.findIndex((node) => node.id === activeId)

  function handleSelect(event: MouseEvent, node: DriveNode) {
    const state = store.getState()
    if (event.shiftKey) {
      state.selectRange(
        nodes.map((candidate) => candidate.id),
        node.id,
      )
    } else if (event.ctrlKey || event.metaKey) {
      state.toggle(node.id)
    } else {
      state.select(node.id)
    }
  }

  function handleContextMenu(node: DriveNode) {
    // Right-clicking outside the selection acts on that item alone, as in file managers.
    if (!store.getState().selected.has(node.id)) store.getState().select(node.id)
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>, node: DriveNode) {
    beginPointerDrag(event, () => {
      // Dragging an unselected item drags it alone, as in file managers.
      const state = store.getState()
      if (!state.selected.has(node.id)) state.select(node.id)
      const { selected: dragged } = store.getState()
      return nodes.filter((candidate) => dragged.has(candidate.id))
    })
  }

  function handleBackgroundClick(event: MouseEvent<HTMLElement>) {
    if (event.target instanceof Element && !event.target.closest('[data-node-id]'))
      store.getState().clear()
  }

  const itemProps = {
    onSelect: handleSelect,
    onOpen: actions.open,
    onContextMenu: handleContextMenu,
    onPointerDown: handlePointerDown,
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={menu.length === 0}>
        <div
          ref={measureRef}
          // Fades in when the content replaces the loading skeleton.
          className="flex min-h-0 flex-1 flex-col animate-in duration-200 ease-smooth fade-in-0"
          onClick={handleBackgroundClick}
          onContextMenu={handleBackgroundClick}
        >
          {viewMode === 'list' && nodes.length > 0 && (
            <ListHeader showLocation={showLocation} sortable={sortable} />
          )}
          {nodes.length === 0 ? (
            empty
          ) : (
            <VirtualList
              // A new list per view mode, so switching list/grid fades too.
              key={viewMode}
              role="listbox"
              aria-label={label}
              aria-multiselectable
              aria-activedescendant={
                activeId && activeIndex !== -1 ? optionId(activeId) : undefined
              }
              tabIndex={0}
              data-drag-scroll
              className="group/list flex-1 animate-in py-1 duration-200 ease-smooth outline-none fade-in-0"
              onKeyDown={handleKeyDown}
              items={nodes}
              getKey={(node) => node.id}
              itemHeight={viewMode === 'list' ? ROW_HEIGHT : TILE_HEIGHT}
              lanes={columns}
              scrollToIndex={activeIndex}
              animateMoves
              onEndReached={hasMore && !isLoadingMore ? onLoadMore : undefined}
              renderItem={(node) =>
                viewMode === 'list' ? (
                  <NodeRow node={node} showLocation={showLocation} {...itemProps} />
                ) : (
                  <NodeTile node={node} {...itemProps} />
                )
              }
              footer={
                isLoadingMore && (
                  <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner /> Loading more…
                  </div>
                )
              }
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuActions actions={menu} />
      </ContextMenuContent>
      <DrivePreview
        nodes={nodes}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={onLoadMore}
      />
    </ContextMenu>
  )
}

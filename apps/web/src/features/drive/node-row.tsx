import type { DriveNode } from '@dfs/shared'
import type { MouseEvent } from 'react'
import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { listColumns, optionId, type ListedNode } from './list-layout'
import { useSelection } from './selection'

export interface NodeItemProps {
  node: ListedNode
  onSelect: (event: MouseEvent, node: DriveNode) => void
  onOpen: (node: DriveNode) => void
  onContextMenu: (node: DriveNode) => void
}

/** One row of the list view. */
export function NodeRow({
  node,
  showLocation,
  onSelect,
  onOpen,
  onContextMenu,
}: NodeItemProps & { showLocation: boolean }) {
  const selected = useSelection((state) => state.selected.has(node.id))
  const active = useSelection((state) => state.activeId === node.id)

  return (
    <div
      id={optionId(node.id)}
      role="option"
      aria-selected={selected}
      data-node-id={node.id}
      className={cn(
        'mx-2 grid h-full cursor-default items-center gap-4 rounded-md px-3 text-sm transition-[background-color,box-shadow] select-none',
        listColumns(showLocation),
        selected ? 'bg-primary/15' : 'hover:bg-muted/60',
        active &&
          'group-focus-visible/list:ring-1 group-focus-visible/list:ring-ring group-focus-visible/list:ring-inset',
      )}
      onClick={(event) => {
        onSelect(event, node)
      }}
      onDoubleClick={() => {
        onOpen(node)
      }}
      onContextMenu={() => {
        onContextMenu(node)
      }}
    >
      <span className="flex min-w-0 items-center gap-3">
        <NodeIcon node={node} className="size-5 shrink-0" />
        <span className="truncate" title={node.name}>
          {node.name}
        </span>
      </span>
      {showLocation && (
        <span className="hidden truncate text-muted-foreground lg:block" title={node.location}>
          {node.location}
        </span>
      )}
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={formatFullDate(node.updatedAt)}
      >
        {formatDate(node.updatedAt)}
      </span>
      <span className="hidden text-right text-muted-foreground tabular-nums sm:block">
        {node.kind === 'folder' && node.sizeBytes === 0 ? '—' : formatBytes(node.sizeBytes)}
      </span>
      <span className="flex justify-center">
        {node.syncState && <SyncStatus state={node.syncState} />}
      </span>
    </div>
  )
}

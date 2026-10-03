import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { optionId } from './list-layout'
import type { NodeItemProps } from './node-row'
import { useSelection } from './selection'

/** One tile of the grid view. */
export function NodeTile({ node, onSelect, onOpen, onContextMenu }: NodeItemProps) {
  const selected = useSelection((state) => state.selected.has(node.id))
  const active = useSelection((state) => state.activeId === node.id)

  return (
    <div
      id={optionId(node.id)}
      role="option"
      aria-selected={selected}
      data-node-id={node.id}
      className="h-full p-1.5 select-none"
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
      <div
        className={cn(
          'flex h-full flex-col gap-1 rounded-lg border p-3 transition-[background-color,border-color,box-shadow]',
          selected ? 'border-primary/60 bg-primary/10' : 'bg-card hover:bg-muted/60',
          active && 'group-focus-visible/list:ring-2 group-focus-visible/list:ring-ring',
        )}
      >
        <div className="flex flex-1 items-center justify-center">
          <NodeIcon node={node} className="size-12" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={node.name}>
            {node.name}
          </span>
          {node.syncState && node.syncState !== 'stored' && (
            <SyncStatus state={node.syncState} className="ml-auto shrink-0" />
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {node.kind === 'folder' ? 'Folder' : formatBytes(node.sizeBytes)}
        </div>
      </div>
    </div>
  )
}

import { NodeIcon } from '@/components/node-icon'
import { SyncStatus } from '@/components/sync-status'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { optionId } from './list-layout'
import { itemDropProps, useItemState } from './item-state'
import type { NodeItemProps } from './node-row'
import { usePrefetchOnHover } from './use-prefetch-on-hover'

/** One tile of the grid view. */
export function NodeTile({ node, onSelect, onOpen, onContextMenu, onPointerDown }: NodeItemProps) {
  const state = useItemState(node)
  const prefetch = usePrefetchOnHover(node)

  return (
    <div
      id={optionId(node.id)}
      role="option"
      aria-selected={state.selected}
      data-node-id={node.id}
      {...itemDropProps(node)}
      {...prefetch}
      className={cn(
        'h-full p-1.5 select-none',
        state.fresh && 'animate-in fade-in-0 zoom-in-75 motion-bounce',
        state.leaving && 'animate-out fill-mode-forwards fade-out-0 zoom-out-75 motion-exit',
      )}
      onPointerDown={(event) => {
        onPointerDown(event, node)
      }}
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
      {/* Presses shrink a little and spring back; a folder under a drag swells to say "drop here". */}
      <div
        className={cn(
          'pressable flex h-full flex-col gap-1 rounded-lg border p-3',
          state.selected ? 'border-primary/60 bg-primary/10' : 'bg-card hover:bg-muted/60',
          state.active && 'group-focus-visible/list:ring-2 group-focus-visible/list:ring-ring',
          state.dragged && 'opacity-40',
          state.over && 'scale-105 border-primary bg-(--drop-target) shadow-lg',
          state.springing && 'animate-[spring-load_450ms_ease-in-out]',
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

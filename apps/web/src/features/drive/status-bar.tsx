import type { DriveNode } from '@dfs/shared'
import { formatBytes, formatCount } from '@/lib/format'
import { useSelection } from './selection'

interface StatusBarProps {
  nodes: DriveNode[]
  /** More pages exist, so the count is a lower bound. */
  hasMore: boolean
  /** The listing hasn't arrived: no count yet, rather than "0 items". */
  loading?: boolean
}

/** Item count and the size of the selection, like a file manager's status bar. */
export function StatusBar({ nodes, hasMore, loading = false }: StatusBarProps) {
  const selected = useSelection((state) => state.selected)
  const selectedNodes = nodes.filter((node) => selected.has(node.id))
  const selectedBytes = selectedNodes.reduce((total, node) => total + node.sizeBytes, 0)

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2 border-t px-4 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span>
        {!loading && formatCount(nodes.length, 'item')}
        {!loading && hasMore && '+'}
      </span>
      {selectedNodes.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {selectedNodes.length} selected ({formatBytes(selectedBytes)})
          </span>
        </>
      )}
    </div>
  )
}

import type { DriveNode } from '@dfs/shared'
import { dropTargetProps, useDragFeedback } from '@/features/drag/drag-store'
import { useIsCut } from './clipboard'
import { useListMotion } from './list-motion'
import { useSelection } from './selection'

/** Selection, keyboard focus, enter/exit, drag and cut state of one list item. */
export function useItemState(node: DriveNode) {
  const selected = useSelection((state) => state.selected.has(node.id))
  const active = useSelection((state) => state.activeId === node.id)
  const leaving = useListMotion((state) => state.leaving.has(node.id))
  const fresh = useListMotion((state) => state.fresh.has(node.id))
  const drag = useDragFeedback(node.id)
  const cut = useIsCut(node.id)
  return { selected, active, leaving, fresh, cut, ...drag }
}

/** Folders accept drops; files don't. */
export function itemDropProps(node: DriveNode) {
  return node.kind === 'folder' ? dropTargetProps(node) : {}
}

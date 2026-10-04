import type { DriveNode } from '@dfs/shared'
import { create } from 'zustand'

interface DragState {
  /** What is being dragged; empty when nothing is. */
  nodes: readonly DriveNode[]
  ids: ReadonlySet<string>
  /** The folder under the pointer that would accept the drop. */
  overId: string | null
  overName: string | null
  /** The folder about to spring open (it blinks first). */
  springId: string | null
}

/**
 * The state of a drag-to-move, for rendering only. It lives outside any one
 * list because a drag outlives the list it started in: hovering a folder
 * opens it mid-drag, which mounts a new list. The pointer tracking itself is
 * in drag-controller.ts and doesn't go through React.
 */
export const useDragStore = create<DragState>()(() => ({
  nodes: [],
  ids: new Set(),
  overId: null,
  overName: null,
  springId: null,
}))

/** How a node renders during a drag: dimmed if it is being dragged, highlighted if it is the target. */
export function useDragFeedback(id: string) {
  const dragged = useDragStore((state) => state.ids.has(id))
  const over = useDragStore((state) => state.overId === id)
  const springing = useDragStore((state) => state.springId === id)
  return { dragged, over, springing }
}

/**
 * Marks an element as a folder that accepts drops. `spring` is what happens
 * when the pointer rests on it: `open` navigates into it, `expand` opens it in
 * the tree. (The tree also marks each folder's subtree with
 * `data-folder-scope`, so a folder can't be dropped into its own descendants.)
 */
export function dropTargetProps(
  folder: { id: string; name: string },
  spring: 'open' | 'expand' | null = 'open',
) {
  return {
    'data-drop-folder-id': folder.id,
    'data-drop-folder-name': folder.name,
    ...(spring ? { 'data-drop-spring': spring } : {}),
  }
}

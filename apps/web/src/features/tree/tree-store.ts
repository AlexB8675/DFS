import { create } from 'zustand'
import { queryClient } from '@/app/query-client'
import { childFoldersQuery } from '@/features/drive/api'

interface TreeState {
  expanded: ReadonlySet<string>
  /** Opens a folder, or closes it together with every folder opened inside it. */
  toggle: (id: string) => void
  /** Expands all of `ids`, e.g. the ancestors of the folder being viewed. */
  expand: (ids: readonly string[]) => void
}

/**
 * Every folder below `id` whose subfolders have been loaded. A folder is only
 * ever opened after its subfolders load, so these are all the open ones there
 * can be below it.
 */
function loadedDescendants(id: string): string[] {
  const found: string[] = []
  const seen = new Set([id])
  const queue = [id]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const listing = queryClient.getQueryData(childFoldersQuery(next).queryKey)
    for (const page of listing?.pages ?? []) {
      for (const folder of page.items) {
        if (seen.has(folder.id)) continue
        seen.add(folder.id)
        found.push(folder.id)
        queue.push(folder.id)
      }
    }
  }
  return found
}

/** Which folders are open in the sidebar tree. */
export const useTreeStore = create<TreeState>()((set) => ({
  expanded: new Set(),
  toggle: (id) => {
    set((state) => {
      const expanded = new Set(state.expanded)
      if (expanded.delete(id)) {
        // Closing a folder forgets what was open inside it: opening it again
        // shows its subfolders closed.
        for (const below of loadedDescendants(id)) expanded.delete(below)
      } else {
        expanded.add(id)
      }
      return { expanded }
    })
  },
  expand: (ids) => {
    set((state) =>
      ids.every((id) => state.expanded.has(id))
        ? state
        : { expanded: new Set([...state.expanded, ...ids]) },
    )
  },
}))

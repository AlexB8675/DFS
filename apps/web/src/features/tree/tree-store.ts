import { create } from 'zustand'

interface TreeState {
  expanded: ReadonlySet<string>
  toggle: (id: string) => void
  /** Expands all of `ids`, e.g. the ancestors of the folder being viewed. */
  expand: (ids: readonly string[]) => void
}

/** Which folders are open in the sidebar tree. */
export const useTreeStore = create<TreeState>()((set) => ({
  expanded: new Set(),
  toggle: (id) => {
    set((state) => {
      const expanded = new Set(state.expanded)
      if (!expanded.delete(id)) expanded.add(id)
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

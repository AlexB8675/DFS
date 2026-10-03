import { createContext, useContext } from 'react'
import { createStore, useStore, type StoreApi } from 'zustand'

/**
 * Selection in a node list. It is kept as a set of IDs rather than in the DOM,
 * so it survives virtualization, and every list view gets its own store.
 */
export interface SelectionState {
  selected: ReadonlySet<string>
  /** Where a shift-click range starts. */
  anchorId: string | null
  /** The keyboard cursor. */
  activeId: string | null
  select: (id: string) => void
  toggle: (id: string) => void
  /** Selects everything between the anchor and `id`, in display order. */
  selectRange: (orderedIds: readonly string[], id: string) => void
  selectAll: (ids: readonly string[]) => void
  setActive: (id: string | null) => void
  clear: () => void
}

export type SelectionStore = StoreApi<SelectionState>

export function createSelectionStore(initialId: string | null = null): SelectionStore {
  return createStore<SelectionState>()((set, get) => ({
    selected: new Set(initialId ? [initialId] : []),
    anchorId: initialId,
    activeId: initialId,
    select: (id) => {
      set({ selected: new Set([id]), anchorId: id, activeId: id })
    },
    toggle: (id) => {
      const selected = new Set(get().selected)
      if (!selected.delete(id)) selected.add(id)
      set({ selected, anchorId: id, activeId: id })
    },
    selectRange: (orderedIds, id) => {
      const anchorId = get().anchorId ?? id
      const from = orderedIds.indexOf(anchorId)
      const to = orderedIds.indexOf(id)
      if (from === -1 || to === -1) {
        get().select(id)
        return
      }
      const [start, end] = from < to ? [from, to] : [to, from]
      set({ selected: new Set(orderedIds.slice(start, end + 1)), anchorId, activeId: id })
    },
    selectAll: (ids) => {
      set({ selected: new Set(ids) })
    },
    setActive: (id) => {
      set({ activeId: id })
    },
    clear: () => {
      set({ selected: new Set(), anchorId: null })
    },
  }))
}

export const SelectionContext = createContext<SelectionStore | null>(null)

export function useSelectionStore(): SelectionStore {
  const store = useContext(SelectionContext)
  if (!store) throw new Error('useSelectionStore must be used inside a SelectionProvider')
  return store
}

export function useSelection<T>(selector: (state: SelectionState) => T): T {
  return useStore(useSelectionStore(), selector)
}

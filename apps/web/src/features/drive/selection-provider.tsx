import { useState, type ReactNode } from 'react'
import { createSelectionStore, SelectionContext } from './selection'

interface SelectionProviderProps {
  /** Pre-selects one item, e.g. when arriving from a search result. */
  initialId?: string | null
  children: ReactNode
}

export function SelectionProvider({ initialId = null, children }: SelectionProviderProps) {
  const [store] = useState(() => createSelectionStore(initialId))
  return <SelectionContext value={store}>{children}</SelectionContext>
}

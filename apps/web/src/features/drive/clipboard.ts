import type { DriveNode } from '@dfs/shared'
import { create } from 'zustand'

/**
 * What Cut or Copy put aside for Paste, in this page (not the system
 * clipboard). A cut is pasted once, as a move; a copy as often as wanted.
 */
export interface DriveClipboard {
  mode: 'cut' | 'copy'
  nodes: DriveNode[]
}

interface ClipboardState {
  clipboard: DriveClipboard | null
  put: (mode: DriveClipboard['mode'], nodes: DriveNode[]) => void
  clear: () => void
}

export const useClipboard = create<ClipboardState>()((set) => ({
  clipboard: null,
  put: (mode, nodes) => {
    set({ clipboard: { mode, nodes } })
  },
  clear: () => {
    set({ clipboard: null })
  },
}))

/** Whether `id` waits to be moved by a paste: shown faded, as in file managers. */
export function useIsCut(id: string): boolean {
  return useClipboard(
    (state) =>
      state.clipboard?.mode === 'cut' && state.clipboard.nodes.some((node) => node.id === id),
  )
}

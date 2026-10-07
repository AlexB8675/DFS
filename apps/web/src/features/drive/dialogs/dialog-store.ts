import type { DriveNode } from '@dfs/shared'
import { create } from 'zustand'

export type DriveDialog =
  | { type: 'new-folder'; parentId: string }
  | { type: 'rename'; node: DriveNode }
  | { type: 'move'; nodes: DriveNode[] }
  | { type: 'share'; node: DriveNode }
  /** Moving to the trash items share links reach: they would stop working. */
  | { type: 'trash'; nodes: DriveNode[]; links: number }

interface DialogState {
  dialog: DriveDialog | null
  open: (dialog: DriveDialog) => void
  close: () => void
}

/** The one drive dialog that is open, so menus, shortcuts and toolbars can all open them. */
export const useDialogStore = create<DialogState>()((set) => ({
  dialog: null,
  open: (dialog) => {
    set({ dialog })
  },
  close: () => {
    set({ dialog: null })
  },
}))

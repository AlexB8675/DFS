import type { DriveNode } from '@dfs/shared'
import {
  Download,
  FileUp,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderUp,
  Pencil,
  Share2,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useNodeActions } from './use-node-actions'

export interface MenuAction {
  key: string
  label: string
  icon: LucideIcon
  shortcut?: string
  destructive?: boolean
  /** Draws a divider above this action. */
  separated?: boolean
  onSelect: () => void
}

/**
 * The actions for a selection, in menu order. With nothing selected, the
 * actions for the folder itself (when `folderId` is given). One list feeds the
 * context menu, dropdown menus and the selection toolbar.
 */
export function useNodeMenu(
  targets: DriveNode[],
  folderId: string | null,
  { reveal = false }: { /** Adds "Show in folder", for search results. */ reveal?: boolean } = {},
): MenuAction[] {
  const actions = useNodeActions()

  if (targets.length === 0) {
    if (!folderId) return []
    return [
      {
        key: 'new-folder',
        label: 'New folder',
        icon: FolderPlus,
        onSelect: () => {
          actions.newFolder(folderId)
        },
      },
      {
        key: 'upload-files',
        label: 'Upload files',
        icon: FileUp,
        separated: true,
        onSelect: () => {
          actions.uploadFiles(folderId)
        },
      },
      {
        key: 'upload-folder',
        label: 'Upload folder',
        icon: FolderUp,
        onSelect: () => {
          actions.uploadFolder(folderId)
        },
      },
    ]
  }

  const single = targets.length === 1 ? targets[0] : undefined
  const hasFiles = targets.some((node) => node.kind === 'file')
  const menu: MenuAction[] = []

  if (single?.kind === 'folder') {
    menu.push({
      key: 'open',
      label: 'Open',
      icon: FolderOpen,
      shortcut: 'Enter',
      onSelect: () => {
        actions.open(single)
      },
    })
  }
  if (reveal && single) {
    menu.push({
      key: 'reveal',
      label: 'Show in folder',
      icon: FolderSearch,
      onSelect: () => {
        actions.reveal(single)
      },
    })
  }
  if (hasFiles) {
    menu.push({
      key: 'download',
      label: 'Download',
      icon: Download,
      onSelect: () => {
        actions.download(targets)
      },
    })
  }
  if (single) {
    menu.push(
      {
        key: 'share',
        label: 'Share link…',
        icon: Share2,
        separated: true,
        onSelect: () => {
          actions.share(single)
        },
      },
      {
        key: 'rename',
        label: 'Rename…',
        icon: Pencil,
        shortcut: 'F2',
        onSelect: () => {
          actions.rename(single)
        },
      },
    )
  }
  menu.push(
    {
      key: 'move',
      label: 'Move to…',
      icon: FolderInput,
      separated: !single,
      onSelect: () => {
        actions.move(targets)
      },
    },
    {
      key: 'trash',
      label: 'Move to trash',
      icon: Trash2,
      shortcut: 'Del',
      destructive: true,
      separated: true,
      onSelect: () => {
        actions.moveToTrash(targets)
      },
    },
  )
  return menu
}

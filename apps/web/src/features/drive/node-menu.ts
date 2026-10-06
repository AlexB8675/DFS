import type { DriveNode } from '@dfs/shared'
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FileArchive,
  Files,
  FileUp,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderUp,
  Pencil,
  Scissors,
  Share2,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useClipboard } from './clipboard'
import { useNodeActions } from './use-node-actions'

/** The modifier shortcuts are shown with: ⌘ on Apple devices, Ctrl elsewhere. */
const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+'

export interface MenuAction {
  key: string
  label: string
  icon: LucideIcon
  shortcut?: string
  destructive?: boolean
  /** Draws a divider above this action. */
  separated?: boolean
  /** Left out of the selection toolbar, which has room for the main actions only. */
  menuOnly?: boolean
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
  const clipboard = useClipboard((state) => state.clipboard)
  const pasteLabel = clipboard?.mode === 'cut' ? 'Paste (move here)' : 'Paste'

  if (targets.length === 0) {
    if (!folderId) return []
    const paste: MenuAction[] = clipboard
      ? [
          {
            key: 'paste',
            label: pasteLabel,
            icon: ClipboardPaste,
            shortcut: `${MOD}V`,
            separated: true,
            onSelect: () => {
              actions.paste(folderId)
            },
          },
        ]
      : []
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
      ...paste,
    ]
  }

  const single = targets.length === 1 ? targets[0] : undefined
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
  menu.push({
    key: 'download',
    label: single?.kind === 'file' ? 'Download' : 'Download as ZIP',
    icon: single?.kind === 'file' ? Download : FileArchive,
    onSelect: () => {
      actions.download(targets)
    },
  })
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
      key: 'cut',
      label: 'Cut',
      icon: Scissors,
      shortcut: `${MOD}X`,
      separated: true,
      menuOnly: true,
      onSelect: () => {
        actions.cut(targets)
      },
    },
    {
      key: 'copy',
      label: 'Copy',
      icon: Copy,
      shortcut: `${MOD}C`,
      menuOnly: true,
      onSelect: () => {
        actions.copy(targets)
      },
    },
  )
  if (clipboard && single?.kind === 'folder') {
    menu.push({
      key: 'paste-into',
      label: clipboard.mode === 'cut' ? 'Paste into folder (move)' : 'Paste into folder',
      icon: ClipboardPaste,
      menuOnly: true,
      onSelect: () => {
        actions.paste(single.id, single.name)
      },
    })
  }
  menu.push(
    {
      key: 'duplicate',
      label: 'Make a copy',
      icon: CopyPlus,
      menuOnly: true,
      onSelect: () => {
        actions.duplicate(targets)
      },
    },
    {
      key: 'copy-to',
      label: 'Copy to…',
      icon: Files,
      onSelect: () => {
        actions.copyTo(targets)
      },
    },
    {
      key: 'move',
      label: 'Move to…',
      icon: FolderInput,
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

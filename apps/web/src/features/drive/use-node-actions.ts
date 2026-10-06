import type { DriveNode } from '@dfs/shared'
import { toast } from 'sonner'
import { useCurrentUser } from '@/features/auth/session'
import { pickFiles } from '@/features/uploads/picked-files'
import { enqueueUploads } from '@/features/uploads/upload-engine'
import { queryClient } from '@/app/query-client'
import { errorMessage } from '@/lib/api/client'
import { formatCount } from '@/lib/format'
import { useTransitionNavigate } from '@/lib/navigation'
import {
  downloadNodes,
  isArchiveDownload,
  nodeKeys,
  useCopyNodes,
  useMoveNodes,
  useRestoreNodes,
  useTrashNodes,
} from './api'
import { useClipboard } from './clipboard'
import { useDialogStore } from './dialogs/dialog-store'
import { animateOut } from './list-motion'

/** The URL of a folder; the root folder lives at `/drive`. */
export function folderUrl(folderId: string, rootFolderId: string): string {
  return folderId === rootFolderId ? '/drive' : `/drive/${folderId}`
}

/** A folder to move into: its ID and name, for the confirmation. */
export interface MoveTarget {
  id: string
  name: string
}

/** Everything a user can do to files and folders, shared by menus, toolbars, shortcuts and drag and drop. */
export function useNodeActions() {
  const navigate = useTransitionNavigate()
  const { rootFolderId } = useCurrentUser()
  const openDialog = useDialogStore((state) => state.open)
  const moveNodes = useMoveNodes()
  const copyNodes = useCopyNodes()
  const trashNodes = useTrashNodes()
  const restoreNodes = useRestoreNodes()
  const putAside = useClipboard((state) => state.put)
  const clearClipboard = useClipboard((state) => state.clear)

  /** A folder to paste into, named for the confirmation: as given, or as far as the cache knows it. */
  function folderTarget(folderId: string, name?: string): MoveTarget {
    if (name) return { id: folderId, name }
    if (folderId === rootFolderId) return { id: folderId, name: 'My Drive' }
    const node = queryClient.getQueryData<DriveNode>(nodeKeys.node(folderId))
    const path = queryClient.getQueryData<{ id: string; name: string }[]>(nodeKeys.path(folderId))
    return { id: folderId, name: node?.name ?? path?.at(-1)?.name ?? 'this folder' }
  }

  async function download(nodes: DriveNode[]) {
    if (!isArchiveDownload(nodes)) {
      try {
        await downloadNodes(nodes)
      } catch (error) {
        toast.error('Could not download', { description: errorMessage(error) })
      }
      return
    }
    toast.promise(downloadNodes(nodes), {
      loading: 'Preparing the ZIP…',
      success: 'Download started',
      error: (error: unknown) => ({
        message: 'Could not download',
        description: errorMessage(error),
      }),
    })
  }

  async function upload(parentId: string, directory: boolean) {
    const files = await pickFiles({ directory })
    try {
      await enqueueUploads(parentId, files)
    } catch (error) {
      toast.error('Could not start the upload', { description: errorMessage(error) })
    }
  }

  /** Moves into a folder; whether anything moved. */
  async function moveTo(nodes: DriveNode[], target: MoveTarget): Promise<boolean> {
    const moving = nodes.filter((node) => node.parentId !== target.id && node.id !== target.id)
    if (moving.length === 0) return false
    await animateOut(moving.map((node) => node.id))
    try {
      await moveNodes.mutateAsync({ nodes: moving, parentId: target.id })
    } catch (error) {
      toast.error('Could not move', { description: errorMessage(error) })
      return false
    }
    toast.success(`Moved ${subject(moving)} to “${target.name}”`, {
      action: {
        label: 'Undo',
        onClick: () => void moveBack(moving, target.id),
      },
    })
    return true
  }

  /** Undoes a move: each node goes back to the folder it came from. */
  async function moveBack(moved: DriveNode[], fromId: string) {
    const byParent = Map.groupBy(moved, (node) => node.parentId)
    try {
      for (const [parentId, group] of byParent) {
        if (!parentId) continue
        await moveNodes.mutateAsync({
          nodes: group.map((node) => ({ ...node, parentId: fromId })),
          parentId,
        })
      }
    } catch (error) {
      toast.error('Could not undo the move', { description: errorMessage(error) })
    }
  }

  /** Copies into a folder (D31); `made` words the confirmation. */
  async function copyInto(
    nodes: DriveNode[],
    target: MoveTarget,
    made = `Copied ${subject(nodes)} to “${target.name}”`,
  ) {
    try {
      const { items, skipped } = await copyNodes.mutateAsync({ nodes, parentId: target.id })
      const leftOut =
        skipped > 0
          ? `${formatCount(skipped, 'file')} couldn’t be read and ${skipped === 1 ? 'was' : 'were'} left out.`
          : undefined
      if (items.length === 0) toast.error('Nothing was copied', { description: leftOut })
      else toast.success(made, { description: leftOut })
    } catch (error) {
      toast.error('Could not copy', { description: errorMessage(error) })
    }
  }

  /** "Make a copy": each item copied into its own folder, as `name (1)`. */
  async function duplicate(nodes: DriveNode[]) {
    const byParent = Map.groupBy(nodes, (node) => node.parentId)
    for (const [parentId, group] of byParent) {
      if (!parentId) continue
      await copyInto(group, { id: parentId, name: '' }, `Made a copy of ${subject(group)}`)
    }
  }

  /** Pastes what Cut or Copy put aside: a cut moves (once), a copy copies (again and again). */
  async function paste(folderId: string, name?: string) {
    const { clipboard } = useClipboard.getState()
    if (!clipboard) return
    const target = folderTarget(folderId, name)
    if (clipboard.mode === 'copy') {
      await copyInto(clipboard.nodes, target)
      return
    }
    // A cut stays until it moves: after a name clash, it can go elsewhere.
    const moved = await moveTo(clipboard.nodes, target)
    if (moved && useClipboard.getState().clipboard === clipboard) clearClipboard()
  }

  async function moveToTrash(nodes: DriveNode[]) {
    const ids = nodes.map((node) => node.id)
    await animateOut(ids)
    try {
      await trashNodes.mutateAsync(nodes)
    } catch (error) {
      toast.error('Could not move to trash', { description: errorMessage(error) })
      return
    }
    toast.success(`${capitalize(subject(nodes))} moved to trash`, {
      action: {
        label: 'Undo',
        onClick: () => {
          restoreNodes.mutate(ids, {
            onError: (error) =>
              toast.error('Could not restore', { description: errorMessage(error) }),
          })
        },
      },
    })
  }

  return {
    /** Folders open in place; files download (previews are a later milestone). */
    open: (node: DriveNode) => {
      if (node.kind === 'folder') navigate(folderUrl(node.id, rootFolderId), 'forward')
      else void download([node])
    },
    /** Opens the folder that contains `node`, with `node` selected. */
    reveal: (node: DriveNode) => {
      if (node.parentId)
        navigate(`${folderUrl(node.parentId, rootFolderId)}?select=${node.id}`, 'section')
    },
    download: (nodes: DriveNode[]) => void download(nodes),
    rename: (node: DriveNode) => {
      openDialog({ type: 'rename', node })
    },
    move: (nodes: DriveNode[]) => {
      openDialog({ type: 'move', nodes })
    },
    moveTo: (nodes: DriveNode[], target: MoveTarget) => void moveTo(nodes, target),
    copyTo: (nodes: DriveNode[]) => {
      openDialog({ type: 'copy', nodes })
    },
    copyInto: (nodes: DriveNode[], target: MoveTarget) => void copyInto(nodes, target),
    duplicate: (nodes: DriveNode[]) => void duplicate(nodes),
    cut: (nodes: DriveNode[]) => {
      putAside('cut', nodes)
      toast(
        `${capitalize(subject(nodes))} cut: paste to move ${nodes.length === 1 ? 'it' : 'them'}`,
      )
    },
    copy: (nodes: DriveNode[]) => {
      putAside('copy', nodes)
      toast(`${capitalize(subject(nodes))} copied: paste to make a copy`)
    },
    /** Into `folderId`; its `name` for the confirmation, if at hand. */
    paste: (folderId: string, name?: string) => void paste(folderId, name),
    /** Forgets a cut, so its items stop looking faded. */
    cancelCut: () => {
      if (useClipboard.getState().clipboard?.mode === 'cut') clearClipboard()
    },
    share: (node: DriveNode) => {
      openDialog({ type: 'share', node })
    },
    moveToTrash: (nodes: DriveNode[]) => void moveToTrash(nodes),
    newFolder: (parentId: string) => {
      openDialog({ type: 'new-folder', parentId })
    },
    uploadFiles: (parentId: string) => void upload(parentId, false),
    uploadFolder: (parentId: string) => void upload(parentId, true),
  }
}

/** “Report.pdf” or “3 items”. */
function subject(nodes: DriveNode[]): string {
  const [first] = nodes
  return nodes.length === 1 && first ? `“${first.name}”` : `${nodes.length} items`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

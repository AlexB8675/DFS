import type { DriveNode } from '@dfs/shared'
import { toast } from 'sonner'
import { useCurrentUser } from '@/features/auth/session'
import { pickFiles } from '@/features/uploads/picked-files'
import { enqueueUploads } from '@/features/uploads/upload-engine'
import { errorMessage } from '@/lib/api/client'
import { useTransitionNavigate } from '@/lib/navigation'
import {
  downloadNodes,
  isArchiveDownload,
  useMoveNodes,
  useRestoreNodes,
  useTrashNodes,
} from './api'
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
  const trashNodes = useTrashNodes()
  const restoreNodes = useRestoreNodes()

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

  async function moveTo(nodes: DriveNode[], target: MoveTarget) {
    const moving = nodes.filter((node) => node.parentId !== target.id && node.id !== target.id)
    if (moving.length === 0) return
    await animateOut(moving.map((node) => node.id))
    try {
      await moveNodes.mutateAsync({ nodes: moving, parentId: target.id })
    } catch (error) {
      toast.error('Could not move', { description: errorMessage(error) })
      return
    }
    toast.success(`Moved ${subject(moving)} to “${target.name}”`, {
      action: {
        label: 'Undo',
        onClick: () => void moveBack(moving, target.id),
      },
    })
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

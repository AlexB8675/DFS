import type { DriveNode } from '@dfs/shared'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useCurrentUser } from '@/features/auth/session'
import { pickFiles } from '@/features/uploads/picked-files'
import { enqueueUploads } from '@/features/uploads/upload-engine'
import { errorMessage } from '@/lib/api/client'
import { downloadFile, useRestoreNodes, useTrashNodes } from './api'
import { useDialogStore } from './dialogs/dialog-store'

/** The URL of a folder; the root folder lives at `/drive`. */
export function folderUrl(folderId: string, rootFolderId: string): string {
  return folderId === rootFolderId ? '/drive' : `/drive/${folderId}`
}

/** Everything a user can do to files and folders, shared by menus, toolbars and shortcuts. */
export function useNodeActions() {
  const navigate = useNavigate()
  const { rootFolderId } = useCurrentUser()
  const openDialog = useDialogStore((state) => state.open)
  const trashNodes = useTrashNodes()
  const restoreNodes = useRestoreNodes()

  async function download(nodes: DriveNode[]) {
    for (const node of nodes) {
      if (node.kind !== 'file') continue
      try {
        await downloadFile(node)
      } catch (error) {
        toast.error(`Could not download “${node.name}”`, { description: errorMessage(error) })
      }
    }
  }

  async function upload(parentId: string, directory: boolean) {
    const files = await pickFiles({ directory })
    try {
      await enqueueUploads(parentId, files)
    } catch (error) {
      toast.error('Could not start the upload', { description: errorMessage(error) })
    }
  }

  async function moveToTrash(nodes: DriveNode[]) {
    const ids = nodes.map((node) => node.id)
    try {
      await trashNodes.mutateAsync(ids)
    } catch (error) {
      toast.error('Could not move to trash', { description: errorMessage(error) })
      return
    }
    const [first] = nodes
    const message =
      nodes.length === 1 && first
        ? `“${first.name}” moved to trash`
        : `${nodes.length} items moved to trash`
    toast.success(message, {
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
      if (node.kind === 'folder') void navigate(folderUrl(node.id, rootFolderId))
      else void download([node])
    },
    /** Opens the folder that contains `node`, with `node` selected. */
    reveal: (node: DriveNode) => {
      if (node.parentId)
        void navigate(`${folderUrl(node.parentId, rootFolderId)}?select=${node.id}`)
    },
    download: (nodes: DriveNode[]) => void download(nodes),
    rename: (node: DriveNode) => {
      openDialog({ type: 'rename', node })
    },
    move: (nodes: DriveNode[]) => {
      openDialog({ type: 'move', nodes })
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

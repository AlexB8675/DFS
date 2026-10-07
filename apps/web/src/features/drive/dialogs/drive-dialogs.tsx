import { useDialogStore } from './dialog-store'
import { MoveDialog } from './move-dialog'
import { NewFolderDialog } from './new-folder-dialog'
import { RenameDialog } from './rename-dialog'
import { ShareDialog } from './share-dialog'
import { TrashDialog } from './trash-dialog'

/** Renders whichever drive dialog is open. Mounted once, in the app shell. */
export function DriveDialogs() {
  const dialog = useDialogStore((state) => state.dialog)
  const close = useDialogStore((state) => state.close)

  switch (dialog?.type) {
    case 'new-folder':
      return <NewFolderDialog parentId={dialog.parentId} onClose={close} />
    case 'rename':
      return <RenameDialog node={dialog.node} onClose={close} />
    case 'move':
      return <MoveDialog nodes={dialog.nodes} onClose={close} />
    case 'share':
      return <ShareDialog node={dialog.node} onClose={close} />
    case 'trash':
      return <TrashDialog nodes={dialog.nodes} links={dialog.links} onClose={close} />
    case undefined:
      return null
  }
}

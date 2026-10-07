import type { DriveNode } from '@dfs/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { linkCount } from '@/features/shares/api'
import { LinkWarning } from '@/features/shares/link-warning'
import { useNodeActions } from '../use-node-actions'

interface TrashDialogProps {
  nodes: DriveNode[]
  /** Outstanding share links to them or to what's inside them. */
  links: number
  onClose: () => void
}

/**
 * Asks before moving items to the trash when share links reach them: the
 * links stop working while they are there (§7.5). Without links, items go
 * to the trash at once, with an Undo.
 */
export function TrashDialog({ nodes, links, onClose }: TrashDialogProps) {
  const actions = useNodeActions()
  const [first] = nodes
  const one = nodes.length === 1
  const subject = one && first ? `“${first.name}”` : `${String(nodes.length)} items`
  const reach = one
    ? first?.kind === 'folder'
      ? 'this folder or what’s inside it'
      : 'this file'
    : 'these items or what’s inside them'

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Move {subject} to the trash?</AlertDialogTitle>
          <AlertDialogDescription>
            You can restore {one ? 'it' : 'them'} from the trash until it’s emptied.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <LinkWarning>
          {linkCount(links)} to {reach} will stop working while {one ? 'it’s' : 'they’re'} in the
          trash. Restoring brings {links === 1 ? 'it' : 'them'} back; deleting forever deletes{' '}
          {links === 1 ? 'it' : 'them'}.
        </LinkWarning>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              actions.moveToTrash(nodes, true)
              onClose()
            }}
          >
            Move to trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

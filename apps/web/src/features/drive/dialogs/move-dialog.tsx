import type { DriveNode } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCurrentUser } from '@/features/auth/session'
import { pathQuery } from '../api'
import { useNodeActions } from '../use-node-actions'
import { FolderBrowser } from './folder-browser'

interface MoveDialogProps {
  nodes: DriveNode[]
  onClose: () => void
}

/** Picks a destination folder by browsing, then moves the nodes there. */
export function MoveDialog({ nodes, onClose }: MoveDialogProps) {
  const { rootFolderId } = useCurrentUser()
  const [folderId, setFolderId] = useState(nodes[0]?.parentId ?? rootFolderId)
  const path = useQuery(pathQuery(folderId))
  const actions = useNodeActions()

  const movingIds = new Set(nodes.map((node) => node.id))
  const current = path.data?.at(-1)
  const alreadyThere = nodes.every((node) => node.parentId === folderId)
  const [first] = nodes
  const subject = nodes.length === 1 && first ? `“${first.name}”` : `${nodes.length} items`

  function confirm() {
    if (!current) return
    onClose()
    actions.moveTo(nodes, current)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move {subject}</DialogTitle>
          <DialogDescription>
            Open the folder you want to move to, then choose Move here.
          </DialogDescription>
        </DialogHeader>

        <FolderBrowser folderId={folderId} onFolderChange={setFolderId} disabledIds={movingIds} />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={alreadyThere || !current} onClick={confirm}>
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

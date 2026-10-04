import { FolderInput } from 'lucide-react'
import { useEffect, useEffectEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { NodeIcon } from '@/components/node-icon'
import { useCurrentUser } from '@/features/auth/session'
import { folderUrl, useNodeActions } from '@/features/drive/use-node-actions'
import { registerDragHandlers, registerOverlay } from './drag-controller'
import { useDragStore } from './drag-store'

/**
 * The floating preview that follows the pointer during a drag-to-move, and
 * the glue between the drag controller and the app. Mounted once, in the
 * app shell. The controller positions the outer element directly; React
 * only renders what it shows.
 */
export function DragLayer() {
  const nodes = useDragStore((state) => state.nodes)
  const overName = useDragStore((state) => state.overName)
  const actions = useNodeActions()
  const navigate = useNavigate()
  const { rootFolderId } = useCurrentUser()

  const drop = useEffectEvent((...args: Parameters<typeof actions.moveTo>) => {
    actions.moveTo(...args)
  })
  const open = useEffectEvent((folderId: string) => {
    // No View Transition: its snapshot would freeze the preview mid-drag.
    void navigate(folderUrl(folderId, rootFolderId))
  })

  useEffect(
    () =>
      registerDragHandlers({
        drop: (dragged, target) => {
          drop([...dragged], target)
        },
        open: (folderId) => {
          open(folderId)
        },
      }),
    [],
  )

  const [first] = nodes
  if (!first) return null
  const count = nodes.length

  return createPortal(
    <div ref={registerOverlay} aria-hidden className="pointer-events-none fixed top-0 left-0 z-100">
      {/* Lifts off the list with a bounce; the controller animates it away on drop. */}
      <div data-drag-card className="mt-3 ml-3 w-max animate-in fade-in-0 zoom-in-75 motion-bounce">
        <div className="relative">
          {count > 1 && (
            <div className="absolute inset-0 translate-x-1 translate-y-1 rotate-3 rounded-lg border bg-popover shadow-md" />
          )}
          <div className="relative flex max-w-64 items-center gap-2.5 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-xl">
            <NodeIcon node={first} className="size-5 shrink-0" />
            <span className="truncate font-medium">{first.name}</span>
          </div>
          {count > 1 && (
            <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-sm tabular-nums">
              {count}
            </span>
          )}
        </div>
        {overName && (
          // Keyed by target, so the hint pops again for each new folder.
          <div
            key={overName}
            className="mt-2 flex w-max max-w-64 animate-in items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-md fade-in-0 zoom-in-50 motion-bounce"
          >
            <FolderInput className="size-3.5 shrink-0" />
            <span className="truncate">Move to {overName}</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

import { Upload } from 'lucide-react'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { dropTargetProps, useDragStore } from '@/features/drag/drag-store'
import { errorMessage } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { collectDroppedFiles } from './picked-files'
import { enqueueUploads } from './upload-engine'

interface DropZoneProps {
  folderId: string
  folderName: string
  children: ReactNode
}

interface Destination {
  id: string
  name: string
}

/**
 * Accepts files and folders dragged in from the desktop and uploads them into
 * `folderId`, or into a subfolder when they are dropped right on one. It is
 * also a drag-to-move target, so items can be dropped anywhere in a folder
 * that sprang open mid-drag.
 */
export function DropZone({ folderId, folderName, children }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const movingHere = useDragStore((state) => state.overId === folderId)
  const [subfolder, setSubfolder] = useState<Destination | null>(null)
  // dragenter/dragleave fire for every child element, so count them.
  const depth = useRef(0)
  const destination = subfolder ?? { id: folderId, name: folderName }

  async function upload(dataTransfer: DataTransfer, parentId: string) {
    try {
      await enqueueUploads(parentId, await collectDroppedFiles(dataTransfer))
    } catch (error) {
      toast.error('Could not start the upload', { description: errorMessage(error) })
    }
  }

  /** Highlights the folder row under the pointer, the same way drag-to-move does. */
  function trackSubfolder(event: DragEvent) {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-drop-folder-id]')
        : null
    const found = row?.dataset.dropFolderId ?? null
    // The zone itself is a target too; over it, files go into this folder.
    const id = found === folderId ? null : found
    if (id === (subfolder?.id ?? null)) return
    setSubfolder(id ? { id, name: row?.dataset.dropFolderName ?? 'folder' } : null)
    useDragStore.setState({ overId: id })
  }

  function reset() {
    depth.current = 0
    setDragging(false)
    setSubfolder(null)
    useDragStore.setState({ overId: null })
  }

  return (
    <div
      {...dropTargetProps({ id: folderId, name: folderName || 'this folder' }, null)}
      className={cn(
        'relative flex min-h-0 flex-1 flex-col transition-shadow',
        movingHere && 'shadow-[inset_0_0_0_2px_var(--color-primary)]',
      )}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        trackSubfolder(event)
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) reset()
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        const { id } = destination
        reset()
        void upload(event.dataTransfer, id)
      }}
    >
      {children}
      {dragging && (
        <div
          className={
            subfolder
              ? 'pointer-events-none absolute inset-x-2 bottom-4 z-20 flex justify-center'
              : 'pointer-events-none absolute inset-2 z-20 flex animate-in flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary bg-background/80 fade-in-0 motion-glide'
          }
        >
          {subfolder ? (
            // Over a folder: the row itself lights up, with a small hint below.
            <p
              key={subfolder.id}
              className="flex max-w-full animate-in items-center gap-2 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-lg fade-in-0 zoom-in-75 motion-bounce"
            >
              <Upload className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Upload to {subfolder.name}</span>
            </p>
          ) : (
            <>
              <Upload
                className="size-8 animate-in text-primary zoom-in-50 motion-bounce"
                aria-hidden
              />
              <p className="font-medium">
                Drop to upload to <span className="text-primary">{folderName}</span>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

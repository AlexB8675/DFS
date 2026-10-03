import { Upload } from 'lucide-react'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/api/client'
import { collectDroppedFiles } from './picked-files'
import { enqueueUploads } from './upload-engine'

interface DropZoneProps {
  folderId: string
  folderName: string
  children: ReactNode
}

/** Accepts files and folders dragged in from the desktop and uploads them into `folderId`. */
export function DropZone({ folderId, folderName, children }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element, so count them.
  const depth = useRef(0)

  async function upload(dataTransfer: DataTransfer) {
    try {
      await enqueueUploads(folderId, await collectDroppedFiles(dataTransfer))
    } catch (error) {
      toast.error('Could not start the upload', { description: errorMessage(error) })
    }
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
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
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setDragging(false)
        void upload(event.dataTransfer)
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex animate-in flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm duration-150 ease-smooth fade-in-0">
          <Upload className="size-8 text-primary" aria-hidden />
          <p className="font-medium">
            Drop to upload to <span className="text-primary">{folderName}</span>
          </p>
        </div>
      )}
    </div>
  )
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

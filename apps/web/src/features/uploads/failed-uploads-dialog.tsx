import { Copy, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { VirtualList } from '@/components/virtual-list'
import { formatCount } from '@/lib/format'
import { uploadEngine } from './upload-engine'
import { useUploadStore, wentWrong, type UploadEntry, type UploadItem } from './upload-store'

const ROW_HEIGHT = 64

/**
 * The uploads that went wrong in this page, each with its name, where it was
 * on disk and why: those that failed, and those uploaded that couldn't be
 * stored on Discord. Found among thousands, which the panel can't show at once.
 */
export function FailedUploadsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Asked again whenever the panel's figures change, so it follows retries.
  const failed = useUploadStore(
    useShallow((state) => state.items.filter((entry) => wentWrong(entry.store.getState()))),
  )
  const retryable = failed.filter((entry) => entry.store.getState().status === 'failed')

  async function copy() {
    const lines = failed.map((entry) => {
      const item = entry.store.getState()
      return `${item.path} — ${reason(item)}`
    })
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success(`Copied ${formatCount(lines.length, 'line')}`)
    } catch {
      toast.error('Could not copy the list.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {failed.length === 0
              ? 'Nothing went wrong'
              : `${formatCount(failed.length, 'upload')} went wrong`}
          </DialogTitle>
          <DialogDescription>
            Each file’s path is inside the folder you dropped or picked: browsers don’t tell a page
            the rest of where it is on your disk.
          </DialogDescription>
        </DialogHeader>
        {failed.length > 0 && (
          <VirtualList
            role="list"
            aria-label="Uploads that went wrong"
            className="max-h-[min(24rem,50dvh)] rounded-md border"
            items={failed}
            getKey={(entry) => entry.id}
            itemHeight={ROW_HEIGHT}
            renderItem={(entry) => <FailedRow entry={entry} />}
          />
        )}
        <DialogFooter>
          {failed.length > 0 && (
            <Button variant="outline" onClick={() => void copy()}>
              <Copy />
              Copy list
            </Button>
          )}
          {retryable.length > 0 && (
            <Button
              onClick={() => {
                for (const entry of retryable) uploadEngine.retry(entry.id)
              }}
            >
              <RotateCcw />
              {retryable.length === 1
                ? 'Retry it'
                : `Retry ${formatCount(retryable.length, 'upload')}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FailedRow({ entry }: { entry: UploadEntry }) {
  const item = useStore(entry.store)
  const why = reason(item)
  return (
    <div
      role="listitem"
      className="flex h-full min-w-0 flex-col justify-center border-b px-3 text-sm last:border-b-0"
    >
      <p className="truncate font-medium" title={item.name}>
        {item.name}
      </p>
      <p className="truncate font-mono text-xs text-muted-foreground" title={item.path}>
        {item.path}
      </p>
      <p className="truncate text-xs text-destructive" title={why}>
        {why}
      </p>
    </div>
  )
}

function reason(item: UploadItem): string {
  if (item.status === 'failed') return item.error ?? 'Upload failed'
  return 'Uploaded, but it couldn’t be stored on Discord'
}

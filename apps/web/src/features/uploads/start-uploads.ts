import { toast } from 'sonner'
import { errorMessage } from '@/lib/api/client'
import type { Dropped } from './picked-files'
import { reportUnreadable, tellNoFiles, whileWaiting } from './reading-feedback'
import { enqueueUploads } from './upload-engine'

/**
 * Reads what was dropped or picked, tells what it could not read, and queues
 * the rest into `parentId`, with a toast for the wait if it lasts.
 *
 * `read` is called before anything is awaited, which a drop needs: its
 * entries must be taken from the `DataTransfer` in the drop handler itself.
 */
export async function startUploads(
  parentId: string,
  read: (onProgress: (found: number) => void) => Promise<Dropped>,
): Promise<void> {
  const waiting = whileWaiting('Reading what you chose…')
  try {
    const { files, unreadable } = await read((found) => {
      waiting.say(`Reading what you chose… ${found.toLocaleString()} files`)
    })
    reportUnreadable(unreadable, files.length)
    if (files.length === 0) {
      if (unreadable.length === 0) tellNoFiles('drop')
      return
    }
    waiting.say(`Preparing ${files.length.toLocaleString()} files…`, true)
    await enqueueUploads(parentId, files)
  } catch (error) {
    couldNotStart(error)
  } finally {
    waiting.end()
  }
}

/** The toast for an upload that did not begin, with the whole error in the console. */
export function couldNotStart(error: unknown): void {
  console.error('Could not start the upload', error)
  toast.error('Could not start the upload', { description: errorMessage(error) })
}

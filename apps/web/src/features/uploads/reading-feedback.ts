import { toast } from 'sonner'
import type { Unreadable } from './picked-files'

/** A wait shorter than this isn't worth a toast. */
const SHOW_AFTER_MS = 400
/** The toast's text changes this often at most, however fast the count climbs. */
const UPDATE_EVERY_MS = 200
/** Unreadable entries named in the toast; the console has the first ones in full. */
const NAMED = 3

export interface Waiting {
  /**
   * Changes what the toast says, once it is showing. A count climbing fast is
   * said only so often; `now` says a change of step at once.
   */
  say: (text: string, now?: boolean) => void
  /** Takes the toast away. */
  end: () => void
}

/**
 * A toast for the wait between choosing or dropping files and their showing in
 * the upload panel (listing a big folder, making its folders), so the page
 * never sits silent. It appears only if the wait lasts.
 */
export function whileWaiting(first: string): Waiting {
  const id = crypto.randomUUID()
  let text = first
  let shown = false
  let lastUpdate = 0
  const timer = setTimeout(() => {
    shown = true
    lastUpdate = Date.now()
    toast.loading(text, { id })
  }, SHOW_AFTER_MS)
  return {
    say(next, now = false) {
      text = next
      const at = Date.now()
      if (!shown || (!now && at - lastUpdate < UPDATE_EVERY_MS)) return
      lastUpdate = at
      toast.loading(next, { id })
    },
    end() {
      clearTimeout(timer)
      if (shown) toast.dismiss(id)
    },
  }
}

/** Says what the browser would not give up, with its own words for the first few. */
export function reportUnreadable(unreadable: Unreadable[], readable: number): void {
  if (unreadable.length === 0) return
  const count = unreadable.length
  const named = unreadable
    .slice(0, NAMED)
    .map(({ path, operation, reason }) => `Could not ${operation} ${path}: ${reason}`)
  if (count > NAMED) named.push(`…and ${String(count - NAMED)} more (the console lists the first).`)
  // Browsers can't list a link to another folder (a Python venv's lib64, say).
  if (unreadable.some(({ operation }) => operation === 'list the folder')) {
    named.push('A folder the browser can’t list is often a symbolic link, which it can’t follow.')
  }
  const items = `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`
  const options = {
    description: named.join('\n'),
    duration: 20_000,
    closeButton: true,
    classNames: { description: 'whitespace-pre-line' },
  }
  if (readable === 0) toast.error(`Nothing could be read: ${items} failed`, options)
  else
    toast.warning(`${items} could not be read and ${count === 1 ? 'was' : 'were'} skipped`, options)
}

/** What was picked or dropped holds no file, which `enqueue` would take for nothing to do. */
export function tellNoFiles(): void {
  toast.info('No files to upload', {
    description: 'What was chosen has no files in it, or the browser listed none.',
  })
}

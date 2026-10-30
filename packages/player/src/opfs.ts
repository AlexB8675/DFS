// The browser's private file system and the lock of a play (DESIGN.md §10.4; the
// iron-clad spec §4.7). A play keeps its sealed blocks in one file, `slots`, in a
// directory of its own under `dfs-play`, and holds a Web Lock of the same name for as
// long as the play lasts. The directory is deleted when the play ends; one that a crash
// left is deleted at the next start of the app, by `cleanLeftovers`, and only when no
// other tab holds its lock. The browser's own types are not used, because this file is
// checked in the Node project as well, which has none: what it needs of the browser is
// said below by what it does, and the browser is asked for it at run time.

import { StoreError } from './errors.ts'
import type { PlayDirectory } from './protocol.ts'
import type { SlotFile } from './store.ts'

/** The directory of the private file system that holds a directory for each play. */
export const PLAYS_DIRECTORY = 'dfs-play'

/** The file that holds a play's sealed blocks, in the play's directory. */
const SLOT_FILE = 'slots'

/** A file of the private file system. */
interface FileHandleLike {
  /**
   * A file gives a synchronous handle to a dedicated worker only, so that a page, and a
   * browser that lacks it, has none. What the handle gives is what `SlotFile` says: the
   * handle of the browser has exactly those calls.
   */
  createSyncAccessHandle?(): Promise<SlotFile>
}

/** A directory of the private file system. */
interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  /** The names of what the directory holds. */
  keys(): AsyncIterable<string>
}

/** The browser's `navigator.storage`. */
interface StorageLike {
  getDirectory(): Promise<DirectoryHandleLike>
}

/** The browser's `navigator.locks`. */
interface LocksLike {
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStorage(value: unknown): value is StorageLike {
  return isRecord(value) && typeof value.getDirectory === 'function'
}

function isLocks(value: unknown): value is LocksLike {
  return isRecord(value) && typeof value.request === 'function'
}

/** What `navigator` has under this name, or undefined: a page, a worker and a server render have different ones, and some have none. */
function fromNavigator(name: 'storage' | 'locks'): unknown {
  const navigatorValue: unknown = Reflect.get(globalThis, 'navigator')
  return isRecord(navigatorValue) ? navigatorValue[name] : undefined
}

/** The browser's private file system, or null when it has none: an insecure page has no `navigator.storage`, and an old browser no `getDirectory`. */
function storageManager(): StorageLike | null {
  const storage = fromNavigator('storage')
  return isStorage(storage) ? storage : null
}

/** The browser's Web Locks, or null when it has none. */
function lockManager(): LocksLike | null {
  const locks = fromNavigator('locks')
  return isLocks(locks) ? locks : null
}

/** The name of the lock of a play: the one that its worker holds, and that a clean-up asks for before it removes the play's directory. */
export function lockName(playId: string): string {
  return `${PLAYS_DIRECTORY}:${playId}`
}

/**
 * Opens the directory of a play, `dfs-play/<playId>` in the private file system, creating
 * it if it is not there. Its file is opened for synchronous access, which the browser
 * gives to a dedicated worker only. A browser with no private file system, or with no
 * synchronous access to it, is `no-opfs`; any other failure is the browser's and is
 * passed on as it is.
 */
export async function opfsDirectory(playId: string): Promise<PlayDirectory> {
  const storage = storageManager()
  if (storage === null) {
    throw new StoreError('no-opfs', 'this browser has no private file system')
  }
  const root = await storage.getDirectory()
  const plays = await root.getDirectoryHandle(PLAYS_DIRECTORY, { create: true })
  const directory = await plays.getDirectoryHandle(playId, { create: true })
  return {
    async openSlotFile() {
      const handle = await directory.getFileHandle(SLOT_FILE, { create: true })
      if (typeof handle.createSyncAccessHandle !== 'function') {
        throw new StoreError(
          'no-opfs',
          'this browser gives no synchronous access to a file of the private file system here (only a dedicated worker has it)',
        )
      }
      return await handle.createSyncAccessHandle()
    },
    async remove() {
      await plays.removeEntry(playId, { recursive: true })
    },
  }
}

/**
 * Takes the Web Lock of a play, waiting for it if another tab holds it, and answers the
 * function that lets it go. The lock is held for as long as a request for it is
 * pending, so the request is made with a callback that waits for the release; a worker
 * that ends releases it with the rest of what it held. Without Web Locks this is `no-opfs`.
 */
export function playLock(playId: string): Promise<() => void> {
  const locks = lockManager()
  if (locks === null) {
    return Promise.reject(new StoreError('no-opfs', 'this browser has no Web Locks'))
  }
  return new Promise((resolve, reject) => {
    // The executor of a promise runs at once, so the release is the promise's own by the time the lock is granted.
    let release = (): void => undefined
    const held = new Promise<void>((done) => {
      release = done
    })
    locks
      .request(lockName(playId), () => {
        // Granted: only now does the caller have the lock.
        resolve(release)
        return held
      })
      .catch(reject)
  })
}

/** Removes the directory of a play if nobody holds its lock, with the lock held while it does, and says whether it did. */
async function removeIfUnheld(
  locks: LocksLike,
  plays: DirectoryHandleLike,
  playId: string,
): Promise<boolean> {
  try {
    return await locks.request(lockName(playId), { ifAvailable: true }, async (lock) => {
      // No lock is given when another tab has it: the play is live there.
      if (lock === null) return false
      await plays.removeEntry(playId, { recursive: true })
      return true
    })
  } catch {
    // Whatever stopped it (a file that a dying worker still has open, a refused lock), the next start of the app tries again.
    return false
  }
}

/**
 * Removes the directories that crashed plays left, and answers how many it removed. A
 * play is a leftover when nobody holds its lock, which the browser has released when
 * its worker ended; the lock is taken for the removal, so that a play that starts in
 * another tab meanwhile waits for it. It is meant to run at the start of the app and
 * it never fails: a browser with no private file system or no locks, and a directory it
 * cannot list or remove, count as nothing removed.
 */
export async function cleanLeftovers(): Promise<number> {
  try {
    const storage = storageManager()
    const locks = lockManager()
    if (storage === null || locks === null) return 0
    const root = await storage.getDirectory()
    const plays = await root.getDirectoryHandle(PLAYS_DIRECTORY)
    // The names are taken first: a directory that is changed while it is listed gives no promise about what the listing holds.
    const playIds: string[] = []
    for await (const name of plays.keys()) playIds.push(name)
    let removed = 0
    for (const playId of playIds) {
      if (await removeIfUnheld(locks, plays, playId)) removed += 1
    }
    return removed
  } catch {
    // No directory of plays (the browser has never kept one), or nothing to list it with: nothing is left over.
    return 0
  }
}

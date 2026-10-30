// The store on the browser's own private file system, in a real worker, under a real
// lock (DESIGN.md §10.4; the iron-clad spec §4.7). What the Node tests can only fake is
// here the thing itself: what a crashed play leaves behind in the file system, that the
// file holds only sealed bytes, and that a play that is alive is not touched by the
// clean-up of the ones that are not. The file system and the locks belong to the origin,
// which every test shares, so each test starts from a file system with nothing in it.

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  BLOCK_BYTES,
  PLAYS_DIRECTORY,
  SEAL_OVERHEAD,
  StoreError,
  WorkerStore,
  cleanLeftovers,
  lockName,
  opfsDirectory,
  playLock,
} from '../index.ts'
import type { StoreErrorKind } from '../index.ts'

const MIB = BLOCK_BYTES

/** How long the browser is given to let go of what a worker held: it does so after the worker is gone, not with it. */
const GIVE_UP_MS = 5_000
const POLL_MS = 50

/** The slot file's name in a play's directory (the file system is read directly here, as a crash would leave it). */
const SLOT_FILE = 'slots'

const workers: Worker[] = []
const playIds: string[] = []

/** A worker that serves stores, which the test ends. */
function startWorker(): Worker {
  const worker = new Worker(new URL('./store-worker.ts', import.meta.url), { type: 'module' })
  workers.push(worker)
  return worker
}

/** A play id that no other test has used. */
function newPlayId(): string {
  const playId = crypto.randomUUID()
  playIds.push(playId)
  return playId
}

/** `length` random bytes. */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  // `getRandomValues` fills 64 KiB at most in a call.
  for (let at = 0; at < length; at += 65_536)
    crypto.getRandomValues(bytes.subarray(at, at + 65_536))
  return bytes
}

/** Whether two runs of bytes are the same (compared here so that a failure does not print megabytes). */
function same(actual: Uint8Array | null, expected: Uint8Array): boolean {
  if (actual?.length !== expected.length) return false
  for (let at = 0; at < expected.length; at += 1) {
    if (actual[at] !== expected[at]) return false
  }
  return true
}

/** Where `needle` first is in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0]
  for (
    let at = haystack.indexOf(first ?? 0);
    at !== -1;
    at = haystack.indexOf(first ?? 0, at + 1)
  ) {
    if (at + needle.length > haystack.length) return -1
    let matches = true
    for (let n = 1; n < needle.length && matches; n += 1) matches = haystack[at + n] === needle[n]
    if (matches) return at
  }
  return -1
}

/** Calls `attempt` every 50 ms until it answers something, and fails with `what` if it has not in 5 s. */
async function until<T>(what: string, attempt: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + GIVE_UP_MS
  for (;;) {
    const answer = await attempt()
    if (answer !== null) return answer
    if (Date.now() >= deadline) {
      throw new Error(`the browser did not ${what} in ${GIVE_UP_MS / 1000} s`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Whether the lock of a play is held, by any worker or page of the origin. */
async function lockHeld(playId: string): Promise<boolean> {
  const { held } = await navigator.locks.query()
  return (held ?? []).some((lock) => lock.name === lockName(playId))
}

/** Waits for the browser to release the lock of a play, which it does for a worker that was terminated some time after. */
async function untilReleased(playId: string): Promise<void> {
  await until(`release the lock of the play ${playId}`, async () =>
    (await lockHeld(playId)) ? null : true,
  )
}

/** Whether `error` is the DOMException that the browser gives for a name that is not there. */
function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

/** The directory that holds the plays' directories, or null when there is none. */
async function playsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(PLAYS_DIRECTORY)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** Whether the directory of a play is in the file system. */
async function directoryExists(playId: string): Promise<boolean> {
  const plays = await playsDirectory()
  if (plays === null) return false
  try {
    await plays.getDirectoryHandle(playId)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** The slot file of a play as the file system keeps it, once the browser has let go of the handle that the worker had. */
async function slotFile(playId: string): Promise<File> {
  return await until(`let the page read the file of the play ${playId}`, async () => {
    try {
      const plays = await playsDirectory()
      const directory = await plays?.getDirectoryHandle(playId)
      const handle = await directory?.getFileHandle(SLOT_FILE)
      return (await handle?.getFile()) ?? null
    } catch (error) {
      if (isNotFound(error)) throw error
      return null
    }
  })
}

/** Removes everything of the plays from the origin, trying again while a handle of a worker that is going is still open. */
async function clearPlays(): Promise<void> {
  await until('let go of the files of the plays', async () => {
    try {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry(PLAYS_DIRECTORY, { recursive: true })
    } catch (error) {
      return isNotFound(error) ? true : null
    }
    return true
  })
}

/** The kind of the `StoreError` that `attempt` fails with, and a failure of the test if it fails with anything else or does not fail. */
async function failureKind(attempt: Promise<unknown>): Promise<StoreErrorKind> {
  try {
    await attempt
  } catch (error) {
    if (error instanceof StoreError) return error.kind
    throw error
  }
  throw new Error('the attempt was expected to fail and did not')
}

beforeEach(async () => {
  await clearPlays()
})

afterEach(async () => {
  // Every worker ends, and the browser lets go of what each held before the next test looks at the file system.
  for (const worker of workers.splice(0)) worker.terminate()
  for (const playId of playIds.splice(0)) await untilReleased(playId)
})

describe('a play on the private file system, in a worker', () => {
  test('keeps 3.5 MiB through a real worker and gives it back unchanged', async () => {
    const playId = newPlayId()
    const size = 3.5 * MIB
    const content = randomBytes(size)
    const expected = content.slice()

    const store = await WorkerStore.open(startWorker(), {
      playId,
      fileSize: size,
      capBytes: 8 * MIB,
    })
    expect(store.backend).toBe('disk')
    expect(await lockHeld(playId)).toBe(true)

    // The write gives its buffer to the worker.
    await store.write(0, content)
    expect(same(await store.read(0, size), expected)).toBe(true)
    // And a part that starts and ends in the middle of blocks.
    expect(
      same(await store.read(MIB - 10, 2 * MIB + 10), expected.subarray(MIB - 10, 2 * MIB + 10)),
    ).toBe(true)

    await store.close()
  })

  test('leaves only sealed bytes at rest, and a crashed play for the next start to clean up', async () => {
    const playId = newPlayId()
    // A block of nothing but the marker: any piece of it that was written as it is would hold the whole marker.
    const marker = randomBytes(64)
    const block = new Uint8Array(MIB)
    for (let at = 0; at < MIB; at += marker.length) block.set(marker, at)
    expect(indexOfBytes(block, marker)).toBe(0)

    const worker = startWorker()
    const store = await WorkerStore.open(worker, {
      playId,
      fileSize: 2 * MIB,
      capBytes: 4 * MIB,
    })
    await store.write(0, block)
    expect(await lockHeld(playId)).toBe(true)

    // A crash: the worker is gone with no close, so nothing removes the directory.
    worker.terminate()
    await untilReleased(playId)

    // The file is there, with the block in it, and the marker is not.
    const file = await slotFile(playId)
    expect(file.size).toBeGreaterThanOrEqual(MIB + SEAL_OVERHEAD)
    expect(indexOfBytes(new Uint8Array(await file.arrayBuffer()), marker)).toBe(-1)

    // The next start of the app removes it, as the lock is not held any more.
    expect(await cleanLeftovers()).toBe(1)
    expect(await directoryExists(playId)).toBe(false)
  })

  test('cleans up a crashed play and leaves a live one alone, with the two in different workers', async () => {
    const live = newPlayId()
    const crashed = newPlayId()
    const liveContent = randomBytes(MIB)
    const liveExpected = liveContent.slice()

    const liveWorker = startWorker()
    const crashedWorker = startWorker()
    const liveStore = await WorkerStore.open(liveWorker, {
      playId: live,
      fileSize: 2 * MIB,
      capBytes: 4 * MIB,
    })
    const crashedStore = await WorkerStore.open(crashedWorker, {
      playId: crashed,
      fileSize: 2 * MIB,
      capBytes: 4 * MIB,
    })
    await liveStore.write(0, liveContent)
    await crashedStore.write(0, randomBytes(MIB))

    crashedWorker.terminate()
    await untilReleased(crashed)

    // Only the play that nobody holds is removed.
    expect(await cleanLeftovers()).toBe(1)
    expect(await directoryExists(crashed)).toBe(false)
    expect(await directoryExists(live)).toBe(true)
    expect(await lockHeld(live)).toBe(true)

    // The live play did not notice: it reads what it wrote, and its close removes it.
    expect(same(await liveStore.read(0, MIB), liveExpected)).toBe(true)
    await liveStore.close()
    expect(await directoryExists(live)).toBe(false)
  })

  test('leaves no directory after a close, and no lock', async () => {
    const playId = newPlayId()
    const store = await WorkerStore.open(startWorker(), {
      playId,
      fileSize: MIB,
      capBytes: 4 * MIB,
    })
    await store.write(0, randomBytes(MIB))
    expect(await directoryExists(playId)).toBe(true)

    await store.close()
    expect(await directoryExists(playId)).toBe(false)
    // The lock is released by the worker, in the close, and not by its end.
    await untilReleased(playId)
  })

  test('leaves a play that is held by a lock alone, and removes it once the lock is let go of', async () => {
    const playId = newPlayId()
    // A directory that a play has made and holds, here held by this page.
    const release = await playLock(playId)
    await opfsDirectory(playId)
    expect(await lockHeld(playId)).toBe(true)
    expect(await directoryExists(playId)).toBe(true)

    expect(await cleanLeftovers()).toBe(0)
    expect(await directoryExists(playId)).toBe(true)

    release()
    await untilReleased(playId)
    expect(await cleanLeftovers()).toBe(1)
    expect(await directoryExists(playId)).toBe(false)
  })

  test('has a play wait for the lock of another worker with the same play, until it closes', async () => {
    const playId = newPlayId()
    const first = await WorkerStore.open(startWorker(), {
      playId,
      fileSize: MIB,
      capBytes: 4 * MIB,
    })

    let secondOpen = false
    const second = WorkerStore.open(startWorker(), { playId, fileSize: MIB, capBytes: 4 * MIB })
    void second.then(() => {
      secondOpen = true
    })
    // The browser says that the lock has a request waiting for it.
    await until('list the second request for the lock', async () => {
      const { pending } = await navigator.locks.query()
      return (pending ?? []).some((lock) => lock.name === lockName(playId)) ? true : null
    })
    expect(secondOpen).toBe(false)

    await first.close()
    const opened = await second
    expect(opened.backend).toBe('disk')
    await opened.close()
  })

  test('has the first request for a lock hold it until released, and the second wait for it', async () => {
    const playId = newPlayId()
    const release = await playLock(playId)
    let granted = false
    const waiting = playLock(playId).then((releaseSecond) => {
      granted = true
      return releaseSecond
    })
    await until('list the second request for the lock', async () => {
      const { pending } = await navigator.locks.query()
      return (pending ?? []).some((lock) => lock.name === lockName(playId)) ? true : null
    })
    expect(granted).toBe(false)

    release()
    const releaseSecond = await waiting
    expect(granted).toBe(true)
    expect(await lockHeld(playId)).toBe(true)
    releaseSecond()
  })

  test('says that the page cannot write the file itself, which only a worker can', async () => {
    const playId = newPlayId()
    const directory = await opfsDirectory(playId)
    expect(await directoryExists(playId)).toBe(true)
    expect(await failureKind(directory.openSlotFile())).toBe('no-opfs')
    await directory.remove()
    expect(await directoryExists(playId)).toBe(false)
  })
})

describe('the clean-up of what plays left', () => {
  test('removes nothing, and creates nothing, where there is no directory of plays', async () => {
    expect(await playsDirectory()).toBeNull()
    expect(await cleanLeftovers()).toBe(0)
    expect(await playsDirectory()).toBeNull()
  })

  test('removes nothing from an empty directory of plays', async () => {
    const root = await navigator.storage.getDirectory()
    await root.getDirectoryHandle(PLAYS_DIRECTORY, { create: true })
    expect(await cleanLeftovers()).toBe(0)
  })
})

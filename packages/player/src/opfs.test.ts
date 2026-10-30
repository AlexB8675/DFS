import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoreError } from './errors.ts'
import { PLAYS_DIRECTORY, cleanLeftovers, lockName, opfsDirectory, playLock } from './opfs.ts'
import type { StoreErrorKind } from './errors.ts'

// The private file system and the locks are the browser's, so the browser suite is what
// tries them for real. These tests are for what a stand-in can prove at no cost: the names,
// the order of what the clean-up does, and that it never throws (DESIGN.md §10.4; the
// iron-clad spec §4.7).

/** What the fakes did, in order. */
type Log = string[]

type Entry = FakeDirectory | FakeFile

/** A file handle that has, or has not, a sync access handle to give. */
interface FakeFile {
  createSyncAccessHandle?: () => Promise<unknown>
}

function notFound(name: string): DOMException {
  return new DOMException(`${name} is not there`, 'NotFoundError')
}

/** A directory of the private file system, in memory, that logs what is done to it. */
class FakeDirectory {
  readonly entries = new Map<string, Entry>()
  /** The names whose removal fails, with what it fails with. */
  readonly removalFailures = new Map<string, Error>()
  /** What listing the directory fails with, when it is to fail. */
  listFailure: Error | null = null
  readonly #path: string
  readonly #log: Log
  readonly #makeFile: () => FakeFile

  constructor(path: string, log: Log, makeFile: () => FakeFile = () => ({})) {
    this.#path = path
    this.#log = log
    this.#makeFile = makeFile
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    this.#log.push(`directory ${this.#path}/${name}${options?.create === true ? ' (create)' : ''}`)
    const entry = this.entries.get(name)
    if (entry instanceof FakeDirectory) return Promise.resolve(entry)
    if (options?.create !== true) return Promise.reject(notFound(name))
    const made = new FakeDirectory(`${this.#path}/${name}`, this.#log, this.#makeFile)
    this.entries.set(name, made)
    return Promise.resolve(made)
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    this.#log.push(`file ${this.#path}/${name}${options?.create === true ? ' (create)' : ''}`)
    const entry = this.entries.get(name)
    if (entry !== undefined && !(entry instanceof FakeDirectory)) return Promise.resolve(entry)
    if (options?.create !== true) return Promise.reject(notFound(name))
    const made = this.#makeFile()
    this.entries.set(name, made)
    return Promise.resolve(made)
  }

  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const recursive = options?.recursive === true ? ' (recursive)' : ''
    this.#log.push(`remove ${this.#path}/${name}${recursive}`)
    const failure = this.removalFailures.get(name)
    if (failure !== undefined) return Promise.reject(failure)
    if (!this.entries.delete(name)) return Promise.reject(notFound(name))
    return Promise.resolve()
  }

  async *keys(): AsyncGenerator<string> {
    if (this.listFailure !== null) throw this.listFailure
    // A directory that is changed while it is listed gives no promise about what the listing holds.
    for (const name of [...this.entries.keys()]) {
      await Promise.resolve()
      yield name
    }
  }
}

type LockCallback = (lock: { name: string } | null) => unknown

/** A lock manager that grants a lock to one request at a time, and logs when it does and when it lets go. */
class FakeLocks {
  /** The names that are held now. */
  readonly held = new Set<string>()
  /** The names that `request` fails for. */
  readonly refused = new Set<string>()
  readonly #log: Log
  readonly #waiting = new Map<string, (() => void)[]>()

  constructor(log: Log) {
    this.#log = log
  }

  async request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean } | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (callback === undefined) throw new TypeError('no callback')
    if (this.refused.has(name)) throw new DOMException(`${name} is refused`, 'SecurityError')
    if (options.ifAvailable === true) {
      this.#log.push(`lock ${name} (if available)`)
      if (this.held.has(name)) {
        this.#log.push(`lock ${name} was not available`)
        return await callback(null)
      }
    } else {
      this.#log.push(`lock ${name}`)
      while (this.held.has(name)) {
        await new Promise<void>((resolve) => {
          this.#waiting.set(name, [...(this.#waiting.get(name) ?? []), resolve])
        })
      }
    }
    this.held.add(name)
    this.#log.push(`lock ${name} granted`)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
      this.#log.push(`lock ${name} released`)
      for (const wake of this.#waiting.get(name) ?? []) wake()
      this.#waiting.delete(name)
    }
  }
}

/** What a navigator has, as far as the private file system and the locks go. */
interface FakeNavigator {
  storage?: { getDirectory?: () => Promise<FakeDirectory> }
  locks?: FakeLocks
}

function install(fake: FakeNavigator | undefined): void {
  vi.stubGlobal('navigator', fake)
}

/** A private file system with a directory of plays that has these entries in it. */
function fileSystemWith(names: string[], log: Log): { root: FakeDirectory; plays: FakeDirectory } {
  const root = new FakeDirectory('', log)
  const plays = new FakeDirectory(`/${PLAYS_DIRECTORY}`, log)
  for (const name of names)
    plays.entries.set(name, new FakeDirectory(`/${PLAYS_DIRECTORY}/${name}`, log))
  root.entries.set(PLAYS_DIRECTORY, plays)
  return { root, plays }
}

async function kindOf(attempt: Promise<unknown>): Promise<StoreErrorKind> {
  try {
    await attempt
  } catch (error) {
    if (error instanceof StoreError) return error.kind
    throw error
  }
  throw new Error('the attempt was expected to fail and did not')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the names', () => {
  it('keeps the plays in one directory, and gives a play a lock of its own name', () => {
    expect(PLAYS_DIRECTORY).toBe('dfs-play')
    expect(lockName('abc')).toBe('dfs-play:abc')
    expect(lockName('abc')).not.toBe(lockName('abd'))
  })
})

describe('cleanLeftovers', () => {
  it('removes each play whose lock it is given, inside the lock, and counts them', async () => {
    const log: Log = []
    const { root, plays } = fileSystemWith(['one', 'two', 'three'], log)
    const locks = new FakeLocks(log)
    // Play `two` is live in another tab.
    locks.held.add(lockName('two'))
    install({ storage: { getDirectory: () => Promise.resolve(root) }, locks })

    expect(await cleanLeftovers()).toBe(2)
    expect([...plays.entries.keys()]).toEqual(['two'])
    // Each is removed while its lock is held, and the one whose lock is held elsewhere is not touched.
    expect(log).toEqual([
      `directory /${PLAYS_DIRECTORY}`,
      'lock dfs-play:one (if available)',
      'lock dfs-play:one granted',
      `remove /${PLAYS_DIRECTORY}/one (recursive)`,
      'lock dfs-play:one released',
      'lock dfs-play:two (if available)',
      'lock dfs-play:two was not available',
      'lock dfs-play:three (if available)',
      'lock dfs-play:three granted',
      `remove /${PLAYS_DIRECTORY}/three (recursive)`,
      'lock dfs-play:three released',
    ])
  })

  it('does not create the directory of plays when there is none', async () => {
    const log: Log = []
    const root = new FakeDirectory('', log)
    install({
      storage: { getDirectory: () => Promise.resolve(root) },
      locks: new FakeLocks(log),
    })

    expect(await cleanLeftovers()).toBe(0)
    expect(root.entries.size).toBe(0)
  })

  it('skips a play that cannot be removed, and does not try it again', async () => {
    const log: Log = []
    const { root, plays } = fileSystemWith(['one', 'two', 'three'], log)
    plays.removalFailures.set('two', new DOMException('still open', 'NoModificationAllowedError'))
    install({
      storage: { getDirectory: () => Promise.resolve(root) },
      locks: new FakeLocks(log),
    })

    expect(await cleanLeftovers()).toBe(2)
    expect([...plays.entries.keys()]).toEqual(['two'])
    expect(
      log.filter((line) => line === `remove /${PLAYS_DIRECTORY}/two (recursive)`),
    ).toHaveLength(1)
  })

  it('skips a play whose lock is refused, and goes on to the next', async () => {
    const log: Log = []
    const { root, plays } = fileSystemWith(['one', 'two'], log)
    const locks = new FakeLocks(log)
    locks.refused.add(lockName('one'))
    install({ storage: { getDirectory: () => Promise.resolve(root) }, locks })

    expect(await cleanLeftovers()).toBe(1)
    expect([...plays.entries.keys()]).toEqual(['one'])
  })

  it('gives 0, and does not throw, when the directory cannot be listed', async () => {
    const log: Log = []
    const { root, plays } = fileSystemWith(['one'], log)
    plays.listFailure = new DOMException('no', 'SecurityError')
    install({
      storage: { getDirectory: () => Promise.resolve(root) },
      locks: new FakeLocks(log),
    })

    expect(await cleanLeftovers()).toBe(0)
  })

  it('gives 0, and does not throw, when the private file system fails', async () => {
    install({
      storage: { getDirectory: () => Promise.reject(new DOMException('no', 'SecurityError')) },
      locks: new FakeLocks([]),
    })

    expect(await cleanLeftovers()).toBe(0)
  })

  it('gives 0, and does not throw, when the browser has no private file system', async () => {
    install({ locks: new FakeLocks([]) })
    expect(await cleanLeftovers()).toBe(0)

    install({ storage: {}, locks: new FakeLocks([]) })
    expect(await cleanLeftovers()).toBe(0)
  })

  it('gives 0, removes nothing, and does not throw, when the browser has no locks', async () => {
    const log: Log = []
    const { root, plays } = fileSystemWith(['one', 'two'], log)
    install({ storage: { getDirectory: () => Promise.resolve(root) } })

    expect(await cleanLeftovers()).toBe(0)
    expect([...plays.entries.keys()]).toEqual(['one', 'two'])
  })

  it('gives 0, and does not throw, when there is no navigator at all', async () => {
    install(undefined)
    expect(await cleanLeftovers()).toBe(0)
  })
})

describe('playLock', () => {
  it('resolves once the lock is granted, holds it until released, and then lets another have it', async () => {
    const log: Log = []
    const locks = new FakeLocks(log)
    install({ locks })

    const release = await playLock('abc')
    expect(locks.held.has(lockName('abc'))).toBe(true)

    let second = false
    const waiting = playLock('abc').then((releaseSecond) => {
      second = true
      return releaseSecond
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(second).toBe(false)

    release()
    const releaseSecond = await waiting
    expect(second).toBe(true)
    expect(locks.held.has(lockName('abc'))).toBe(true)
    releaseSecond()
    await vi.waitFor(() => {
      expect(locks.held.size).toBe(0)
    })
  })

  it('can be released twice without harm', async () => {
    const locks = new FakeLocks([])
    install({ locks })

    const release = await playLock('abc')
    release()
    release()
    await vi.waitFor(() => {
      expect(locks.held.size).toBe(0)
    })
  })

  it('does not take another play`s lock', async () => {
    const locks = new FakeLocks([])
    install({ locks })

    const first = await playLock('abc')
    const second = await playLock('abd')
    expect([...locks.held].sort()).toEqual([lockName('abc'), lockName('abd')])
    first()
    second()
  })

  it('says `no-opfs` when the browser has no locks, and passes on a refusal as it is', async () => {
    install({})
    expect(await kindOf(playLock('abc'))).toBe('no-opfs')

    const locks = new FakeLocks([])
    locks.refused.add(lockName('abc'))
    install({ locks })
    await expect(playLock('abc')).rejects.toMatchObject({ name: 'SecurityError' })
  })
})

describe('opfsDirectory', () => {
  it('opens the directory of the play in the directory of plays, creating both', async () => {
    const log: Log = []
    const root = new FakeDirectory('', log)
    install({ storage: { getDirectory: () => Promise.resolve(root) } })

    await opfsDirectory('abc')

    const plays = root.entries.get(PLAYS_DIRECTORY)
    expect(plays).toBeInstanceOf(FakeDirectory)
    expect(plays instanceof FakeDirectory && plays.entries.get('abc')).toBeInstanceOf(FakeDirectory)
    expect(log).toEqual([
      `directory /${PLAYS_DIRECTORY} (create)`,
      `directory /${PLAYS_DIRECTORY}/abc (create)`,
    ])
  })

  it('opens the one file of the play with a sync access handle, and gives that handle as it is', async () => {
    const log: Log = []
    const handle = { id: 'the handle' }
    const root = new FakeDirectory('', log, () => ({
      createSyncAccessHandle: () => Promise.resolve(handle),
    }))
    install({ storage: { getDirectory: () => Promise.resolve(root) } })

    const directory = await opfsDirectory('abc')
    log.length = 0
    expect(await directory.openSlotFile()).toBe(handle)
    expect(log).toEqual([`file /${PLAYS_DIRECTORY}/abc/slots (create)`])
  })

  it('removes the directory of the play from the directory of plays, with what is in it', async () => {
    const log: Log = []
    const root = new FakeDirectory('', log)
    install({ storage: { getDirectory: () => Promise.resolve(root) } })

    const directory = await opfsDirectory('abc')
    await opfsDirectory('abd')
    log.length = 0
    await directory.remove()

    const plays = root.entries.get(PLAYS_DIRECTORY)
    expect(plays instanceof FakeDirectory && [...plays.entries.keys()]).toEqual(['abd'])
    expect(log).toEqual([`remove /${PLAYS_DIRECTORY}/abc (recursive)`])
  })

  it('says `no-opfs` when the browser has no private file system', async () => {
    install({})
    expect(await kindOf(opfsDirectory('abc'))).toBe('no-opfs')

    install({ storage: {} })
    expect(await kindOf(opfsDirectory('abc'))).toBe('no-opfs')

    install(undefined)
    expect(await kindOf(opfsDirectory('abc'))).toBe('no-opfs')
  })

  it('says `no-opfs` when the file cannot be opened for sync access, as on a page and not in a worker', async () => {
    const root = new FakeDirectory('', [])
    install({ storage: { getDirectory: () => Promise.resolve(root) } })

    const directory = await opfsDirectory('abc')
    expect(await kindOf(directory.openSlotFile())).toBe('no-opfs')
  })

  it('passes on the other failures of the browser as they are', async () => {
    install({
      storage: { getDirectory: () => Promise.reject(new DOMException('no', 'SecurityError')) },
    })
    await expect(opfsDirectory('abc')).rejects.toMatchObject({ name: 'SecurityError' })

    const refused = new DOMException('full', 'QuotaExceededError')
    const root = new FakeDirectory('', [], () => ({
      createSyncAccessHandle: () => Promise.reject(refused),
    }))
    install({ storage: { getDirectory: () => Promise.resolve(root) } })
    const directory = await opfsDirectory('abc')
    await expect(directory.openSlotFile()).rejects.toBe(refused)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectDroppedFiles, pickFiles, WALK_CONCURRENCY } from './picked-files'

// Entries that behave as a browser's do: a directory lists 100 at a time and
// ends on an empty batch, and every request to the file system answers later.

const BATCH = 100

/** Requests to the file system under way, and the most there have been at once. */
const traffic = { now: 0, most: 0 }

function request<T>(answer: () => T): Promise<T> {
  traffic.now += 1
  traffic.most = Math.max(traffic.most, traffic.now)
  // Answers after the walk has asked for what it can, in microtasks: timers
  // tick every 15 ms on Windows, and a deep tree needs hundreds of answers.
  return Promise.resolve().then(() => {
    traffic.now -= 1
    return answer()
  })
}

interface Tree {
  [name: string]: Tree | 'file' | 'fails'
}

function entry(name: string, tree: Tree[string], failing: string): FileSystemEntry {
  if (typeof tree === 'string') return fileEntry(name, tree === 'fails', failing)
  return directoryEntry(name, tree, failing)
}

function fileEntry(name: string, fails: boolean, failing: string): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success: FileCallback, failure?: ErrorCallback) {
      void request(() => {
        if (fails) throw new DOMException(failing, 'InvalidStateError')
        return new File(['x'], name)
      }).then(success, (error: unknown) => failure?.(error as DOMException))
    },
  } as FileSystemFileEntry
}

function directoryEntry(name: string, tree: Tree, failing: string): FileSystemDirectoryEntry {
  const children = Object.entries(tree)
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let next = 0
      return {
        readEntries(success: FileSystemEntriesCallback, failure?: ErrorCallback) {
          void request(() => {
            const batch = children.slice(next, next + BATCH)
            next += BATCH
            return batch.map(([childName, child]) => entry(childName, child, failing))
          }).then(success, (error: unknown) => failure?.(error as DOMException))
        },
      }
    },
  } as FileSystemDirectoryEntry
}

function drop(tree: Tree, failing = 'not usable'): DataTransfer {
  const items = Object.entries(tree).map(([name, child]) => ({
    webkitGetAsEntry: () => entry(name, child, failing),
  }))
  return { items, files: [] } as unknown as DataTransfer
}

function names(files: { file: File; relativeDir: string }[]): string[] {
  return files.map(({ file, relativeDir }) => `${relativeDir}/${file.name}`).sort()
}

afterEach(() => {
  traffic.now = 0
  traffic.most = 0
  vi.restoreAllMocks()
})

describe('collectDroppedFiles', () => {
  it('walks a tree with the folder each file came from', async () => {
    const { files, unreadable } = await collectDroppedFiles(
      drop({ Holiday: { 'a.jpg': 'file', 'Day 1': { 'b.jpg': 'file' } }, 'loose.txt': 'file' }),
    )
    expect(names(files)).toEqual(['Holiday/Day 1/b.jpg', 'Holiday/a.jpg', '/loose.txt'].sort())
    expect(files.find(({ file }) => file.name === 'b.jpg')?.relativeDir).toBe('Holiday/Day 1')
    expect(unreadable).toEqual([])
  })

  it('reads a folder in batches until an empty one', async () => {
    const photos: Tree = {}
    for (let index = 0; index < 250; index += 1) photos[`${String(index)}.jpg`] = 'file'
    const { files } = await collectDroppedFiles(drop({ Photos: photos }))
    expect(files).toHaveLength(250)
  })

  it('leaves out a file it cannot open, says so, and keeps the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { files, unreadable } = await collectDroppedFiles(
      drop(
        { Big: { good: 'file', bad: 'fails', Inner: { alsoGood: 'file', 'worse.bin': 'fails' } } },
        'An attempt was made to use an object that is not, or is no longer, usable.',
      ),
    )
    expect(names(files)).toEqual(['Big/Inner/alsoGood', 'Big/good'])
    expect(unreadable.map(({ path }) => path).sort()).toEqual(['Big/Inner/worse.bin', 'Big/bad'])
    expect(unreadable[0]).toMatchObject({
      operation: 'open the file',
      reason: expect.stringMatching(/^InvalidStateError: An attempt was made/) as string,
    })
    // In the console too, where the browser's own error shows with its stack.
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('keeps what a folder listed before a later batch failed, and reports the folder', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const folder: Tree = {}
    for (let index = 0; index < 150; index += 1) folder[`${String(index)}.dat`] = 'file'
    const reader = directoryEntry('Folder', folder, 'not usable').createReader()
    let reads = 0
    // The second read fails, as a folder that changes under the walk would.
    const failing = {
      isFile: false,
      isDirectory: true,
      name: 'Folder',
      createReader: () => ({
        readEntries(success: FileSystemEntriesCallback, failure?: ErrorCallback) {
          reads += 1
          if (reads === 2) failure?.(new DOMException('gone', 'NotFoundError'))
          else reader.readEntries(success, failure)
        },
      }),
    } as unknown as FileSystemDirectoryEntry
    const { files, unreadable } = await collectDroppedFiles({
      items: [{ webkitGetAsEntry: () => failing }],
      files: [],
    } as unknown as DataTransfer)
    expect(files).toHaveLength(BATCH)
    expect(unreadable).toEqual([
      { path: 'Folder', operation: 'list the folder', reason: 'NotFoundError: gone' },
    ])
  })

  it('never has more than a dozen requests to the file system at once', async () => {
    const tree: Tree = {}
    for (let folder = 0; folder < 40; folder += 1) {
      const files: Tree = {}
      for (let file = 0; file < 25; file += 1) files[`${String(file)}.bin`] = 'file'
      tree[`folder ${String(folder)}`] = files
    }
    const { files } = await collectDroppedFiles(drop(tree))
    expect(files).toHaveLength(1000)
    expect(traffic.most).toBeGreaterThan(1)
    expect(traffic.most).toBeLessThanOrEqual(WALK_CONCURRENCY)
  })

  it('walks a deep tree', async () => {
    let tree: Tree = { 'deep.txt': 'file' }
    for (let depth = 0; depth < 200; depth += 1) tree = { d: tree }
    const { files } = await collectDroppedFiles(drop(tree))
    expect(files).toHaveLength(1)
    expect(files[0]?.relativeDir.split('/')).toHaveLength(200)
  })

  it('tells how many files it has found as it goes', async () => {
    const found: number[] = []
    await collectDroppedFiles(drop({ F: { a: 'file', b: 'file', c: 'file' } }), (count) =>
      found.push(count),
    )
    expect(found).toEqual([1, 2, 3])
  })

  it('takes the plain files when nothing is an entry', async () => {
    const file = new File(['x'], 'plain.txt')
    const { files } = await collectDroppedFiles({
      items: [{ webkitGetAsEntry: () => null }],
      files: [file],
    } as unknown as DataTransfer)
    expect(files).toEqual([{ file, relativeDir: '' }])
  })
})

describe('pickFiles', () => {
  class FakeInput extends EventTarget {
    type = ''
    multiple = false
    webkitdirectory = false
    hidden = false
    files: File[] = []
    attached = false
    click = vi.fn()
    remove() {
      this.attached = false
    }
  }

  function pageWith(input: FakeInput) {
    vi.stubGlobal('document', {
      createElement: () => input,
      body: {
        append: () => {
          input.attached = true
        },
      },
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps its input in the page until the browser answers', async () => {
    const input = new FakeInput()
    pageWith(input)
    const picked = pickFiles({ directory: true })
    expect(input.attached).toBe(true)
    expect(input.webkitdirectory).toBe(true)
    expect(input.click).toHaveBeenCalledOnce()
    const file = new File(['x'], 'a.txt')
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Folder/Sub/a.txt' })
    input.files = [file]
    input.dispatchEvent(new Event('change'))
    expect(await picked).toEqual([{ file, relativeDir: 'Folder/Sub' }])
    expect(input.attached).toBe(false)
  })

  it('answers nothing when the picker is dismissed, and no files for an empty folder', async () => {
    const dismissed = new FakeInput()
    pageWith(dismissed)
    const first = pickFiles()
    dismissed.dispatchEvent(new Event('cancel'))
    expect(await first).toBeNull()
    expect(dismissed.attached).toBe(false)

    const empty = new FakeInput()
    pageWith(empty)
    const second = pickFiles({ directory: true })
    empty.dispatchEvent(new Event('change'))
    expect(await second).toEqual([])
  })
})

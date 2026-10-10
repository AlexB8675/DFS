/** A file to upload, with the folder path it came from relative to what was picked or dropped. */
export interface PickedFile {
  file: File
  /** `""` for a loose file, `"Holiday/Day 1"` for a file inside a dropped folder. */
  relativeDir: string
}

/** A file or folder in a dropped tree that the browser would not give up. */
export interface Unreadable {
  /** Relative to what was dropped: `"Holiday/Day 1/IMG_0001.jpg"`. */
  path: string
  /** What was asked of the browser: opening a file, or listing a folder. */
  operation: 'open the file' | 'list the folder'
  /** The browser's own words: `"InvalidStateError: An attempt was made…"`. */
  reason: string
}

/** What a dropped tree held: the files, and whatever could not be read. */
export interface Dropped {
  files: PickedFile[]
  unreadable: Unreadable[]
}

/** Requests to the browser's file system at once while walking a dropped tree. */
export const WALK_CONCURRENCY = 12
/** Unreadable entries logged to the console one by one; the rest are only counted. */
const LOGGED_FAILURES = 25

/** What was picked, not yet read: listing a big folder takes a while, and is told as it goes. */
export interface Chosen {
  /** `onProgress` hears the files found so far. */
  read: (onProgress?: (found: number) => void) => Promise<Dropped>
}

/**
 * Opens the browser's file picker. Resolves with `null` if it is dismissed. If
 * the browser fails it rejects, saying at which step. (An error thrown in a
 * listener would only reach the console, and the page would wait for ever.)
 *
 * A folder is read as a dropped one is, through the entries the input gives
 * (`webkitEntries`), so what the browser won't list, a symbolic link say, is
 * left out and reported, not fatal. Where it gives none for a folder (Chrome
 * lists the files themselves), or nothing comes of them, the plain list of
 * files serves.
 */
export function pickFiles({ directory = false } = {}): Promise<Chosen | null> {
  return new Promise((resolve, reject) => {
    let picker: HTMLInputElement | undefined
    const failed = (error: unknown) => {
      picker?.remove()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    try {
      atStep('opening the picker', () => {
        const input = document.createElement('input')
        picker = input
        input.type = 'file'
        input.multiple = true
        input.webkitdirectory = directory
        input.hidden = true
        input.addEventListener(
          'change',
          () => {
            try {
              resolve(chosenFrom(input, directory))
            } catch (error) {
              failed(error)
            }
          },
          { once: true },
        )
        input.addEventListener(
          'cancel',
          () => {
            input.remove()
            resolve(null)
          },
          { once: true },
        )
        // A large folder takes the browser a while to list before it says `change`,
        // and an input only a variable holds can be collected meanwhile, taking the
        // answer with it: the page would never hear. In the page, it stays, until
        // what was chosen has been read.
        document.body.append(input)
        input.click()
      })
    } catch (error) {
      failed(error)
    }
  })
}

function chosenFrom(picker: HTMLInputElement, directory: boolean): Chosen {
  const entries = directory ? entriesOf(picker) : []
  if (!entries.some(isDirectoryEntry)) {
    const files = listedBy(picker)
    picker.remove()
    return { read: () => Promise.resolve({ files, unreadable: [] }) }
  }
  return {
    read: async (onProgress) => {
      try {
        const walked = await walkEntries(entries, onProgress)
        // Nothing found and nothing to say: ask for the plain list instead.
        if (walked.files.length > 0 || walked.unreadable.length > 0) return walked
        return { files: listedBy(picker), unreadable: [] }
      } finally {
        picker.remove()
      }
    },
  }
}

/** The entries the browser gives for what was picked; none if it gives none, or fails. */
function entriesOf(picker: HTMLInputElement): FileSystemEntry[] {
  try {
    return Array.from(picker.webkitEntries)
  } catch (error) {
    console.warn('The browser gave no entries for the folder; using its list of files', error)
    return []
  }
}

function listedBy(picker: HTMLInputElement): PickedFile[] {
  return atStep('reading the files the browser listed', () =>
    Array.from(picker.files ?? [], fromInputFile),
  )
}

/** Runs `work`; if it throws, the error says which step it was, and the console has it in full. */
function atStep<T>(step: string, work: () => T): T {
  try {
    return work()
  } catch (error) {
    console.error(`The file picker failed while ${step}`, error)
    throw new Error(`While ${step}: ${describe(error)}`, { cause: error })
  }
}

function fromInputFile(file: File): PickedFile {
  const path = file.webkitRelativePath
  return { file, relativeDir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }
}

/**
 * Collects the files from a drop, walking into dropped folders. The entries
 * must be read synchronously in the drop handler, before the browser clears
 * the `DataTransfer`, which is why this reads them before awaiting anything.
 *
 * What the browser will not give up (a file it can't open, a folder it can't
 * list) is left out and reported, rather than failing the whole drop: a big
 * folder is the likeliest to hold one. `onProgress` hears the files found so far.
 */
export async function collectDroppedFiles(
  dataTransfer: DataTransfer,
  onProgress?: (found: number) => void,
): Promise<Dropped> {
  const entries = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry()).filter(
    (entry) => entry !== null,
  )
  if (entries.length === 0) {
    const files = Array.from(dataTransfer.files, (file) => ({ file, relativeDir: '' }))
    return { files, unreadable: [] }
  }
  return walkEntries(entries, onProgress)
}

async function walkEntries(
  entries: FileSystemEntry[],
  onProgress: ((found: number) => void) | undefined,
): Promise<Dropped> {
  const walking: Walking = {
    files: [],
    unreadable: [],
    limited: limit(WALK_CONCURRENCY),
    onProgress,
  }
  await Promise.all(entries.map((entry) => walk(entry, '', walking)))
  return { files: walking.files, unreadable: walking.unreadable }
}

interface Walking extends Dropped {
  /** Runs a request to the browser's file system, a few at a time. */
  limited: <T>(request: () => Promise<T>) => Promise<T>
  onProgress: ((found: number) => void) | undefined
}

async function walk(entry: FileSystemEntry, dir: string, walking: Walking): Promise<void> {
  const path = dir ? `${dir}/${entry.name}` : entry.name
  if (isFileEntry(entry)) {
    try {
      const file = await walking.limited(() => openFile(entry))
      walking.files.push({ file, relativeDir: dir })
      walking.onProgress?.(walking.files.length)
    } catch (error) {
      leaveOut(walking, path, 'open the file', error)
    }
    return
  }
  if (!isDirectoryEntry(entry)) return

  const reader = entry.createReader()
  // readEntries returns results in batches; an empty batch means done.
  for (;;) {
    let batch: FileSystemEntry[]
    try {
      batch = await walking.limited(() => readBatch(reader))
    } catch (error) {
      leaveOut(walking, path, 'list the folder', error)
      return
    }
    if (batch.length === 0) return
    await Promise.all(batch.map((child) => walk(child, path, walking)))
  }
}

function leaveOut(
  walking: Walking,
  path: string,
  operation: Unreadable['operation'],
  error: unknown,
): void {
  walking.unreadable.push({ path, operation, reason: describe(error) })
  // In the console, in red, with the browser's own error: the toast says less.
  if (walking.unreadable.length <= LOGGED_FAILURES) {
    console.error(`Could not ${operation} “${path}”`, error)
  }
}

/** The browser's own words: `"InvalidStateError: An attempt was made…"`. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function openFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })
}

/** Lets `max` requests run at once; the others wait their turn, in order. */
function limit(max: number): Walking['limited'] {
  let running = 0
  const waiting: (() => void)[] = []
  return async (request) => {
    if (running < max) running += 1
    else await new Promise<void>((resolve) => waiting.push(resolve)) // a place handed over
    try {
      return await request()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running -= 1
    }
  }
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory
}

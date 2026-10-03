/** A file to upload, with the folder path it came from relative to what was picked or dropped. */
export interface PickedFile {
  file: File
  /** `""` for a loose file, `"Holiday/Day 1"` for a file inside a dropped folder. */
  relativeDir: string
}

/** Opens the browser's file picker. Resolves with nothing if it is dismissed. */
export function pickFiles({ directory = false } = {}): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.webkitdirectory = directory
    input.addEventListener(
      'change',
      () => {
        resolve(Array.from(input.files ?? [], fromInputFile))
      },
      { once: true },
    )
    input.addEventListener(
      'cancel',
      () => {
        resolve([])
      },
      { once: true },
    )
    input.click()
  })
}

function fromInputFile(file: File): PickedFile {
  const path = file.webkitRelativePath
  return { file, relativeDir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }
}

/**
 * Collects the files from a drop, walking into dropped folders. The entries
 * must be read synchronously in the drop handler, before the browser clears
 * the `DataTransfer`, which is why this reads them before awaiting anything.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry()).filter(
    (entry) => entry !== null,
  )
  if (entries.length === 0) {
    return Array.from(dataTransfer.files, (file) => ({ file, relativeDir: '' }))
  }
  const files: PickedFile[] = []
  await Promise.all(entries.map((entry) => walk(entry, '', files)))
  return files
}

async function walk(entry: FileSystemEntry, dir: string, out: PickedFile[]): Promise<void> {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject)
    })
    out.push({ file, relativeDir: dir })
    return
  }
  if (!isDirectoryEntry(entry)) return

  const path = dir ? `${dir}/${entry.name}` : entry.name
  const reader = entry.createReader()
  // readEntries returns results in batches; an empty batch means done.
  for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
    await Promise.all(batch.map((child) => walk(child, path, out)))
  }
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory
}

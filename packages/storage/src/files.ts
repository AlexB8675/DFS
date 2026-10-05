import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes `data` so that, once this resolves, it is on disk under `file` in
 * full or not at all: a temporary file is synced, then renamed into place.
 * A crash can't leave a half-written file behind a name.
 */
export async function writeFileDurably(file: string, data: Uint8Array): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Reads exactly `length` bytes at `offset`, or throws if the file is shorter. */
export async function readRange(file: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buffer = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
      if (bytesRead === 0) {
        throw new Error(`${file} ends before byte ${String(offset + length)}.`)
      }
      filled += bytesRead
    }
    return buffer
  } finally {
    await handle.close()
  }
}

/** Makes a rename durable on POSIX systems; Windows can't open a directory to sync it. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

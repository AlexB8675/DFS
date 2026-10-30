// An in-memory directory and lock for the store worker's tests (DESIGN.md §10.4;
// the iron-clad spec §4.7). The directory hands out a `SlotFile` that the test can
// reach, so that it can tell the file to fail, and it can be told to fail itself.
// Everything the worker does to the directory, the file and the lock is written to
// one log that the test shares, so that it can check the order of the steps. It is
// for tests only, so the package does not export it.

import type { PlayDirectory, PlayLock } from '../protocol.ts'
import { TestSlotFile } from './slot-file.ts'

/** A `TestSlotFile` that logs its close, remembers where it was written, and can garble a read. */
export class LoggedSlotFile extends TestSlotFile {
  /** Every write that was asked of the file, in order. */
  readonly writes: { at: number; length: number }[] = []
  readonly #log: string[]
  #garbleNextRead = false

  constructor(log: string[]) {
    super()
    this.#log = log
  }

  /** Makes the next `read` change a byte of what it returns, as a disk that returns what was not written would. */
  garbleNextRead(): void {
    this.#garbleNextRead = true
  }

  override read(buffer: Uint8Array, options: { at: number }): number {
    const count = super.read(buffer, options)
    if (this.#garbleNextRead && count > 100) {
      this.#garbleNextRead = false
      buffer[100] = (buffer[100] ?? 0) ^ 0xff
    }
    return count
  }

  override write(buffer: Uint8Array, options: { at: number }): number {
    this.writes.push({ at: options.at, length: buffer.length })
    return super.write(buffer, options)
  }

  override close(): void {
    this.#log.push('file closed')
    super.close()
  }
}

/** A play's directory in memory: it holds one file, and logs when the file is opened and when the directory is removed. */
export class TestPlayDirectory implements PlayDirectory {
  /** The file that `openSlotFile` hands out: a new one once the last has closed, as a new handle would be. */
  file: LoggedSlotFile
  /** What `openSlotFile` fails with, when it is to fail. */
  openFailure: Error | null = null
  /** What `remove` fails with, when it is to fail. */
  removeFailure: Error | null = null
  /** How many times `remove` was called. */
  removals = 0
  readonly #log: string[]

  constructor(log: string[]) {
    this.#log = log
    this.file = new LoggedSlotFile(log)
  }

  openSlotFile(): Promise<LoggedSlotFile> {
    if (this.openFailure !== null) return Promise.reject(this.openFailure)
    if (this.file.closed) this.file = new LoggedSlotFile(this.#log)
    this.#log.push('file opened')
    return Promise.resolve(this.file)
  }

  remove(): Promise<void> {
    this.removals += 1
    this.#log.push('directory removed')
    if (this.removeFailure !== null) return Promise.reject(this.removeFailure)
    return Promise.resolve()
  }
}

/** A lock that is always granted, and logs when it is taken and when it is released. */
export function testLock(log: string[]): PlayLock {
  return (playId) => {
    log.push(`lock taken ${playId}`)
    return Promise.resolve(() => {
      log.push(`lock released ${playId}`)
    })
  }
}

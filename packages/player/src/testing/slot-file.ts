// An in-memory file for the store's tests (DESIGN.md §10.4; the iron-clad spec
// §4.7). It has the synchronous calls of a private file's sync access handle, and
// grows as it is written, so that the store can be tried on its slots without a
// browser. A test can tell it to fail its next write or read with a given
// `DOMException` name (`QuotaExceededError` for a full disk, `InvalidStateError`
// for a handle that is gone), and can ask for the bytes it holds, to see what is
// at rest. It is for tests only, so the package does not export it.

import type { SlotFile } from '../store.ts'

/** An in-memory `SlotFile`: it grows as it is written, and fails on request. */
export class TestSlotFile implements SlotFile {
  /** The bytes that the file has room for: at least `#size` of them are its own. */
  #bytes = new Uint8Array(0)
  #size = 0
  #writeFailure: string | undefined
  #readFailure: string | undefined

  /** Whether `close()` was called. */
  closed = false

  /** Makes the next `write` throw a `DOMException` of this name, once. */
  failNextWrite(name: string): void {
    this.#writeFailure = name
  }

  /** Makes the next `read` throw a `DOMException` of this name, once. */
  failNextRead(name: string): void {
    this.#readFailure = name
  }

  /** A copy of the bytes the file holds, for a test that looks at what is at rest. It answers after the file is closed. */
  raw(): Uint8Array<ArrayBuffer> {
    return this.#bytes.slice(0, this.#size)
  }

  /** Throws what a handle throws once it is closed. */
  #assertOpen(): void {
    if (this.closed) throw new DOMException('the file is closed', 'InvalidStateError')
  }

  /** Makes room for `size` bytes, keeping the bytes there are. */
  #grow(size: number): void {
    if (size <= this.#bytes.length) return
    const grown = new Uint8Array(Math.max(size, this.#bytes.length * 2))
    grown.set(this.#bytes.subarray(0, this.#size))
    this.#bytes = grown
  }

  read(buffer: Uint8Array, options: { at: number }): number {
    this.#assertOpen()
    if (this.#readFailure !== undefined) {
      const name = this.#readFailure
      this.#readFailure = undefined
      throw new DOMException(`the next read was told to fail with ${name}`, name)
    }
    const count = Math.max(0, Math.min(buffer.length, this.#size - options.at))
    buffer.set(this.#bytes.subarray(options.at, options.at + count))
    return count
  }

  write(buffer: Uint8Array, options: { at: number }): number {
    this.#assertOpen()
    if (this.#writeFailure !== undefined) {
      const name = this.#writeFailure
      this.#writeFailure = undefined
      throw new DOMException(`the next write was told to fail with ${name}`, name)
    }
    const end = options.at + buffer.length
    this.#grow(end)
    // A write past the end leaves the bytes between the end and the write as zeros, as a file does.
    if (options.at > this.#size) this.#bytes.fill(0, this.#size, options.at)
    this.#bytes.set(buffer, options.at)
    this.#size = Math.max(this.#size, end)
    return buffer.length
  }

  truncate(size: number): void {
    this.#assertOpen()
    this.#grow(size)
    // Growing makes zeros of the new bytes, and shrinking lets go of the old ones.
    if (size > this.#size) this.#bytes.fill(0, this.#size, size)
    this.#size = size
  }

  getSize(): number {
    this.#assertOpen()
    return this.#size
  }

  flush(): void {
    this.#assertOpen()
  }

  close(): void {
    this.closed = true
  }
}

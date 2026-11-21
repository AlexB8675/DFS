// A file held whole in memory, as a `ByteSource` (DESIGN.md §10.4): the browser suites fetch a file
// of the play server once and feed it through a `Feeder` with no store and no downloader between.

import type { ByteRange } from '@dfs/mp4'
import type { ByteSource } from '../engine/source.ts'

export class MemorySource implements ByteSource {
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get fileSize(): number {
    return this.bytes.length
  }

  // An aborted signal gives a rejected promise, never a throw.
  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error)
    return Promise.resolve(this.bytes.subarray(range.start, Math.min(range.end, this.bytes.length)))
  }

  /** Everything is held already. */
  fetchNow(): Promise<void> {
    return Promise.resolve()
  }

  /** Nothing is downloaded, so there is no position to keep. */
  setPosition(): void {
    // Nothing to keep.
  }
}

/** Fetches the whole file at `url` into memory. */
export async function fetchMemorySource(url: string): Promise<MemorySource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The play server answered ${response.status} for ${url}.`)
  return new MemorySource(new Uint8Array(await response.arrayBuffer()))
}

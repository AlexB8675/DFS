// What the feeder reads a file through (DESIGN.md §10.4): the part of the downloader
// that it needs, so that a test can give it a file held in memory. The `Downloader`
// is one.

import type { ByteRange } from '@dfs/mp4'

export interface ByteSource {
  /** The size of the file, in bytes. */
  readonly fileSize: number
  /** The bytes of the range once they are held, as a priority read that does not move the position; rejects with the signal's reason when it aborts. */
  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array>
  /** Starts reading the range at once, alongside the onward reads, and resolves when it is held. */
  fetchNow(range: ByteRange, signal?: AbortSignal): Promise<void>
  /** Tells the downloader where the play is, so that its onward reads go on from there. */
  setPosition(offset: number): void
}

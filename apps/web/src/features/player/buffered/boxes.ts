// Where an MP4's index is and which bytes hold its samples (DESIGN.md §10.4).
// Phone recordings put the index (the `moov` box) after the samples (the
// `mdat`), at the very end of the file, so the player must find it before
// mp4box can split the file. This reads only box headers, from a file's first
// bytes, and never the boxes' contents.

/** A top-level MP4 box's header: where it starts and how long it is. */
export interface TopBox {
  type: string
  start: number
  /** The whole box, header included; `null` for a box that runs to the end of the file (size 0). */
  size: number | null
}

/**
 * The boxes at the top of `bytes`, whose first byte is file offset `fileStart`.
 * A box is listed when its header is complete, even if its body runs past
 * `bytes`; the walk stops at a box with no size, or at a damaged one.
 */
export function topLevelBoxes(bytes: Uint8Array, fileStart: number): TopBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: TopBox[] = []
  let at = 0
  while (bytes.length - at >= 8) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    let size: number | null = view.getUint32(at)
    let header = 8
    if (size === 1) {
      if (bytes.length - at < 16) break
      size = Number(view.getBigUint64(at + 8))
      header = 16
    } else if (size === 0) {
      size = null
    }
    if (size !== null && size < header) break
    boxes.push({ type, start: fileStart + at, size })
    if (size === null) break
    at += size
  }
  return boxes
}

/** Where the moov is, and which bytes still have to be streamed for the samples. */
export interface MediaLayout {
  moov: { start: number; end: number }
  /** The bytes after the head that hold samples: streamed in order, from `from` up to (not including) `to`. */
  stream: { from: number; to: number }
}

/**
 * Where the moov is in a file of `fileSize` bytes, given its first bytes
 * `head`: in the head (an index up front) or right after an `mdat` that runs
 * past it (an index at the end). `null` for a file that is neither.
 */
export function mediaLayout(head: Uint8Array, fileSize: number): MediaLayout | null {
  const boxes = topLevelBoxes(head, 0)
  const found = boxes.find((entry) => entry.type === 'moov')
  if (found) {
    const moov = { start: found.start, end: found.start + (found.size ?? fileSize - found.start) }
    if (moov.start >= fileSize) return null
    return { moov, stream: { from: Math.max(head.length, moov.end), to: fileSize } }
  }

  const open = boxes.find((entry) => entry.size === null || entry.start + entry.size > head.length)
  if (open?.type !== 'mdat' || open.size === null) return null
  const moov = { start: open.start + open.size, end: fileSize }
  if (moov.start >= fileSize) return null
  return { moov, stream: { from: head.length, to: moov.start } }
}

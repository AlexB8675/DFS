import type { Box } from './boxes.ts'
import { Mp4Error } from './errors.ts'

// Where a file's index (its `moov` box) is, from the first bytes of the file
// (DESIGN.md §10.4, D45). Phone recordings put the index after the samples (the
// `mdat`), at the very end of the file, so the player has to know where it is
// before it can read it: this reads only box headers, and never the contents of
// a box. It takes over what `mediaLayout` in the web app does, and refuses a
// file that is already in fragments.

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * The boxes at the top of `head`, which starts at the first byte of the file. A
 * box is listed when its header is complete, even if its body runs past `head`;
 * the walk stops at a box of size 0 (which runs to the end of the file, and is
 * listed with that end) or at a damaged header: one cut short, one with a size
 * smaller than itself, or a 64-bit size that no file has.
 */
function topLevelBoxes(head: Uint8Array, fileSize: number): Box[] {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const boxes: Box[] = []
  let at = 0
  while (head.length - at >= 8) {
    const type = String.fromCharCode(...head.subarray(at + 4, at + 8))
    let size = view.getUint32(at)
    let header = 8
    if (size === 1) {
      if (head.length - at < 16) break
      const wide = view.getBigUint64(at + 8)
      if (wide > MAX_SAFE) break
      size = Number(wide)
      header = 16
    } else if (size === 0) {
      boxes.push({ type, start: at, body: at + header, end: fileSize })
      break
    }
    if (size < header) break
    boxes.push({ type, start: at, body: at + header, end: at + size })
    at += size
  }
  return boxes
}

/**
 * Where the moov is in a file of `fileSize` bytes, given its first bytes
 * `head`: in them (an index up front), whole or only its header, or right after
 * an `mdat` that runs past them (an index at the end), in which case it is
 * taken to run to the end of the file. The caller reads that range and gives it
 * to `readMovie`, which reads only its first box, and that must be the moov.
 * `null` for a file with neither: no moov in `head` and no open `mdat` at its
 * end, an `mdat` that has no size or ends at or past the end of the file (so no
 * moov can follow it), or a head too short to hold a header.
 *
 * A moov of size 0 runs to the end of the file. One that claims more than the
 * file holds is refused as `Mp4Error('damaged')`, and a `moof` among the boxes
 * of the head, wherever, as `Mp4Error('fragmented')`: a file in fragments has
 * nothing to split. A `fileSize` that isn't a count of bytes is a RangeError,
 * the caller's mistake and not the file's.
 */
export function locateMoov(
  head: Uint8Array,
  fileSize: number,
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new RangeError(`${fileSize} is not a size that a file has.`)
  }
  const boxes = topLevelBoxes(head, fileSize)

  const moof = boxes.find((entry) => entry.type === 'moof')
  if (moof) {
    throw new Mp4Error(
      'fragmented',
      `The file is already in fragments (it has a 'moof' box at offset ${moof.start}), so there is nothing to split.`,
    )
  }

  const moov = boxes.find((entry) => entry.type === 'moov')
  if (moov) {
    if (moov.start >= fileSize || moov.end > fileSize) {
      throw new Mp4Error(
        'damaged',
        `The 'moov' box at offset ${moov.start} claims to end at ${moov.end}, but the file has ${fileSize} bytes.`,
      )
    }
    return { start: moov.start, end: moov.end }
  }

  // An index at the end: the last box of the head is the mdat, which goes on past it, and the box after it is the moov. QuickTime writes a `wide` or a `free` before the mdat, and they are boxes of the head like any other.
  const last = boxes.at(-1)
  if (last?.type === 'mdat' && last.end > head.length && last.end < fileSize) {
    return { start: last.end, end: fileSize }
  }
  return null
}

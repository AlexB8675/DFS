import { child } from './boxes.ts'
import type { Box } from './boxes.ts'
import { Mp4Error } from './errors.ts'

// Where a file's index (its `moov` box) is, from the first bytes of the file
// (DESIGN.md §10.4, D45). Phone recordings put the index after the samples (the
// `mdat`), at the very end of the file, so the player has to know where it is
// before it can read it: this reads only box headers, and never the contents of
// a box. It takes over what `mediaLayout` in the web app does, and refuses a
// file that is already in fragments.

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** The most a `moov` may hold: a larger one is damage, not an index (§10.4). The longest of the user's files has a few MB. */
export const MAX_MOOV_BYTES = 256 * 1024 * 1024

/** A `moov` of this many bytes is refused if it is past the bound. */
function checkMoovSize(start: number, end: number): void {
  const size = end - start
  if (size > MAX_MOOV_BYTES) {
    throw new Mp4Error(
      'damaged',
      `The 'moov' box at offset ${start} is ${size} bytes, which is more than the ${MAX_MOOV_BYTES} bytes that an index may hold.`,
    )
  }
}

/** The shortest box there is: a header of 8 bytes and nothing in it. A range of the file shorter than this holds no box. */
const MIN_BOX = 8

/** The boxes at the top of a head, and whether the head ended before the walk could go on. */
interface TopLevel {
  boxes: Box[]
  /** True when the walk stopped because the next header isn't whole in the head: what follows the last box is not damaged, only not there. */
  cutOff: boolean
}

/**
 * The boxes at the top of `head`, which starts at the first byte of the file. A
 * box is listed when its header is complete, even if its body runs past `head`;
 * the walk stops at a box of size 0 (which runs to the end of the file, and is
 * listed with that end) or at a damaged header: one with a size smaller than
 * itself, or a 64-bit size that no file has. The walk is also over when the
 * head is, which is told apart from damage: the header of the next box may be
 * cut short by the head's end (or the head end exactly there), and then the
 * next box is simply not seen.
 */
function topLevelBoxes(head: Uint8Array, fileSize: number): TopLevel {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const boxes: Box[] = []
  let at = 0
  while (head.length - at >= MIN_BOX) {
    const type = String.fromCharCode(...head.subarray(at + 4, at + 8))
    let size = view.getUint32(at)
    let header = 8
    if (size === 1) {
      if (head.length - at < 16) break
      const wide = view.getBigUint64(at + 8)
      if (wide > MAX_SAFE) return { boxes, cutOff: false }
      size = Number(wide)
      header = 16
    } else if (size === 0) {
      boxes.push({ type, start: at, body: at + header, end: fileSize })
      return { boxes, cutOff: false }
    }
    if (size < header) return { boxes, cutOff: false }
    boxes.push({ type, start: at, body: at + header, end: at + size })
    at += size
  }
  return { boxes, cutOff: true }
}

/**
 * Where the moov is in a file of `fileSize` bytes, given its first bytes
 * `head` (of which no more than the file's size is looked at): in them (an
 * index up front), whole or only its header, or right after an `mdat` that is
 * the last box of the head, which goes on past it, or ends at it, or so near
 * its end that the next header isn't whole (an index at the end). In that case
 * it is taken to run to the end of the file. The caller reads that range and
 * gives it to `moovIn`, which walks past whatever the writer left between the
 * `mdat` and the moov (a `free` box, say).
 *
 * `null` for a file with neither: no moov in `head`, and no `mdat` at its end
 * with a header's worth of the file after it. That leaves out an `mdat` of no
 * size, one that ends at or past the end of the file or less than a header
 * before it, and one followed by a damaged header; a head too short to hold a
 * header; and a `free`, `skip` or `wide` at the end of the head, which a writer
 * puts before the `mdat` and not instead of it, so that what follows them is not
 * known to be the moov (and if it is the `mdat`, the range to the end of the
 * file is the whole of the samples).
 *
 * A moov of size 0 runs to the end of the file. One that claims more than the
 * file holds, or more than `MAX_MOOV_BYTES`, is refused as `Mp4Error('damaged')`, and a `moof` among the boxes
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
  // A head longer than the file is the caller's to explain, but nothing past the file's end is a box of it.
  const seen = head.subarray(0, Math.min(head.length, fileSize))
  const { boxes, cutOff } = topLevelBoxes(seen, fileSize)

  const moof = boxes.find((entry) => entry.type === 'moof')
  if (moof) {
    throw new Mp4Error(
      'fragmented',
      `The file is already in fragments (it has a 'moof' box at offset ${moof.start}), so there is nothing to split.`,
    )
  }

  const moov = boxes.find((entry) => entry.type === 'moov')
  if (moov) {
    if (moov.end > fileSize) {
      throw new Mp4Error(
        'damaged',
        `The 'moov' box at offset ${moov.start} claims to end at ${moov.end}, but the file has ${fileSize} bytes.`,
      )
    }
    checkMoovSize(moov.start, moov.end)
    return { start: moov.start, end: moov.end }
  }

  // An index at the end: the last box of the head is the mdat, and the head ends in it or just after it, so the box after it is the moov, to the end of the file. QuickTime's `wide` and `free` before the mdat are boxes of the head like any other.
  const last = boxes.at(-1)
  if (last?.type === 'mdat' && cutOff && fileSize - last.end >= MIN_BOX) {
    checkMoovSize(last.end, fileSize)
    return { start: last.end, end: fileSize }
  }
  return null
}

/**
 * The first top-level `moov` box in `bytes`, header included, as a view onto
 * them: `bytes` being the range of the file that `locateMoov` gave, as read.
 * The boxes before it, whatever they are (`free`, `skip`, `wide`, `udta`, or
 * anything else a writer puts between the samples and the index), are walked
 * past, and what follows it is not looked at. A range with no moov, or with a
 * box before it that can't be walked, is refused as `Mp4Error('damaged')`.
 * What it gives is what `readMovie` takes.
 */
export function moovIn(bytes: Uint8Array): Uint8Array {
  const whole: Box = { type: '', start: 0, body: 0, end: bytes.length }
  const moov = child(bytes, whole, 'moov')
  if (!moov) throw new Mp4Error('damaged', `The bytes read for the index hold no 'moov' box.`)
  return bytes.subarray(moov.start, moov.end)
}

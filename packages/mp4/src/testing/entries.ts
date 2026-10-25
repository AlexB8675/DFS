// The sample entry that a writer wrote, against the one it was made from
// (DESIGN.md §10.4): the corpus suite checks that each codec's configuration box
// is carried byte for byte, because a decoder that takes what it needs from the
// frames (ffmpeg's for AAC and for AC-3) does not show that it is. Tests and
// scripts only.

import { child, childBoxes, firstBox } from '../boxes.ts'
import type { Box } from '../boxes.ts'
import { Mp4Error } from '../errors.ts'
import type { SampleEntry } from '../movie.ts'

/** The boxes that a picture codec is set up from: H.264, HEVC, AV1, VP9 and VP8, and Dolby Vision's, by profile. */
const PICTURE_CONFIGS = ['avcC', 'hvcC', 'av1C', 'vpcC', 'dvcC', 'dvvC', 'dvwC']

/** The boxes that a sound codec is set up from: AAC and the other `mp4a`, AC-3, E-AC-3, ALAC, FLAC, Opus and IAMF. */
const SOUND_CONFIGS = ['esds', 'dac3', 'dec3', 'alac', 'dfLa', 'dOps', 'iacb']

/**
 * The `esds` that a sound entry of MPEG audio layer 3 is given in place of
 * QuickTime's `.mp3`, which has none: an ES_Descriptor (stream 0, no flags) with a
 * DecoderConfigDescriptor of object type 0x6B (MPEG-1 audio) for an audio stream,
 * no buffer size, no bit rates and no DecoderSpecificInfo, then an
 * SLConfigDescriptor of 2. It is written out here, byte by byte, and not taken
 * from the module.
 */
export const MP3_ESDS = Uint8Array.of(
  ...[0x00, 0x00, 0x00, 0x23], // the size of the box
  ...[0x65, 0x73, 0x64, 0x73], // 'esds'
  ...[0x00, 0x00, 0x00, 0x00], // version and flags
  ...[0x03, 0x15], // the ES_Descriptor, of 21 bytes
  ...[0x00, 0x00, 0x00], // its ID, and no flags
  ...[0x04, 0x0d], // the DecoderConfigDescriptor, of 13 bytes
  ...[0x6b, 0x15], // MPEG-1 audio, an audio stream
  ...[0x00, 0x00, 0x00], // the size of the buffer
  ...[0x00, 0x00, 0x00, 0x00], // the highest bit rate
  ...[0x00, 0x00, 0x00, 0x00], // the average bit rate
  ...[0x06, 0x01, 0x02], // the SLConfigDescriptor
)

/**
 * The first sample entry of the `stsd` of an init segment (`moov`, `trak`,
 * `mdia`, `minf`, `stbl`, `stsd`), as the reader would give it: its type, its
 * bytes (a view onto the init segment) and the version of the `stsd`. Throws an
 * `Error` naming the box that is not there.
 */
export function writtenEntry(init: Uint8Array): SampleEntry {
  let parent: Box = { type: '', start: 0, body: 0, end: init.length }
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
    const found = child(init, parent, type)
    if (!found) throw new Error(`The init segment has no '${type}' box where it is looked for.`)
    parent = found
  }
  // The version and flags, then the count of entries.
  const entry = firstBox(init, parent.body + 8, parent.end)
  if (!entry) throw new Error(`The 'stsd' box of the init segment holds no entry.`)
  return {
    type: entry.type,
    bytes: init.subarray(entry.start, entry.end),
    stsdVersion: init[parent.body] ?? 0,
  }
}

/**
 * Where the boxes of an entry begin, after the fields of its version, as the
 * module reads them. A picture has 78 after its header; a sound has 28, to which
 * QuickTime's version 1 adds 16 and its version 2 adds 36 (ISO's version 1,
 * in an `stsd` of version 1, adds none).
 */
function insideOf(entry: SampleEntry, picture: boolean): Box {
  const whole = firstBox(entry.bytes, 0, entry.bytes.length)
  if (!whole) throw new Mp4Error('damaged', `The '${entry.type}' entry holds no box.`)
  if (picture) return { ...whole, body: whole.body + 78 }
  if (whole.end - whole.body < 28) {
    throw new Mp4Error(
      'damaged',
      `The '${entry.type}' entry holds ${whole.end - whole.body} bytes.`,
    )
  }
  const version = new DataView(
    entry.bytes.buffer,
    entry.bytes.byteOffset + whole.body + 8,
    2,
  ).getUint16(0)
  const quickTime = version === 1 && entry.stsdVersion !== 1
  return { ...whole, body: whole.body + 28 + (quickTime ? 16 : 0) + (version === 2 ? 36 : 0) }
}

/** Each configuration box that an entry holds, by type: whole, header included. A sound's is directly in the entry or, in QuickTime's, inside its `wave` box. */
function configBoxes(entry: SampleEntry, picture: boolean): Map<string, Uint8Array> {
  const inside = insideOf(entry, picture)
  const wrapper = picture ? null : child(entry.bytes, inside, 'wave')
  const found = new Map<string, Uint8Array>()
  for (const type of picture ? PICTURE_CONFIGS : SOUND_CONFIGS) {
    const box =
      child(entry.bytes, inside, type) ?? (wrapper ? child(entry.bytes, wrapper, type) : null)
    if (box) found.set(type, entry.bytes.subarray(box.start, box.end))
  }
  // Reading the rest of the entry is what shows that it is whole.
  childBoxes(entry.bytes, inside.body, inside.end)
  return found
}

/** The offset of the first byte at which two boxes of the same length differ. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const at = a.findIndex((byte, index) => byte !== b[index])
  return at === -1 ? 0 : at
}

/**
 * What is wrong with the entry a writer wrote, as sentences, against the entry
 * it was made from: each codec configuration box that the source holds must be
 * in the written entry, byte for byte. QuickTime's `.mp3` holds none, and is
 * written with the `esds` that is made for it (`MP3_ESDS`). A source that holds
 * no configuration box this knows is a problem too: nothing would be proved. An
 * entry that can't be read is a problem, never an exception.
 */
export function configProblems(
  source: SampleEntry,
  written: SampleEntry,
  picture: boolean,
): string[] {
  let wanted: Map<string, Uint8Array>
  try {
    wanted = configBoxes(source, picture)
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    return [`the source entry can't be read: ${error.message}`]
  }
  if (source.type === '.mp3' && !wanted.has('esds')) wanted.set('esds', MP3_ESDS)
  if (wanted.size === 0) {
    return [
      `the source entry '${source.type}' holds no codec configuration box (${(picture ? PICTURE_CONFIGS : SOUND_CONFIGS).join(', ')}) to compare`,
    ]
  }
  let got: Map<string, Uint8Array>
  try {
    got = configBoxes(written, picture)
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    return [`the written init entry can't be read: ${error.message}`]
  }
  const problems: string[] = []
  for (const [type, expected] of wanted) {
    const actual = got.get(type)
    if (!actual) {
      problems.push(
        `the written init entry has no '${type}' box (the source's has ${expected.length} bytes)`,
      )
    } else if (actual.length !== expected.length) {
      problems.push(
        `the '${type}' box of the written init entry has ${actual.length} bytes, and the source's ${expected.length}`,
      )
    } else if (actual.some((byte, index) => byte !== expected[index])) {
      problems.push(
        `the '${type}' box of the written init entry differs from the source's, first at its byte ${firstDifference(actual, expected)}`,
      )
    }
  }
  return problems
}

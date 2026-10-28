// What the corpus suites share in comparing the reader with ffprobe (DESIGN.md
// §10.4): the differences of a track's frames with the packets ffprobe lists,
// counted per field and said once with the first of them, and the rotation of a
// picture as its matrix says it and as ffprobe says it. Tests and scripts only.

import type { FrameTable } from '../frames.ts'
import { presentationSeconds } from '../timing.ts'
import type { TrackTiming } from '../timing.ts'
import type { ProbeStream } from './ffprobe.ts'

/** A description of a difference that is too long for a line is cut. A value JSON has no text for (undefined, which a time ffprobe has none of is) is said as `String` says it. */
export function shown(value: unknown): string {
  // JSON.stringify gives undefined for undefined, a function or a symbol, though its type says a string.
  const text =
    typeof value === 'string'
      ? value
      : ((JSON.stringify(value) as string | undefined) ?? String(value))
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

interface Difference {
  count: number
  frame: number
  ours: unknown
  theirs: unknown
}

/** The differences between a track's frames and the packets ffprobe lists, per field: how many, and the first. */
export class Differences {
  readonly byField = new Map<string, Difference>()

  note(field: string, frame: number, ours: unknown, theirs: unknown): void {
    if (ours === theirs) return
    this.record(field, frame, ours, theirs)
  }

  /** The same for numbers that are the same when they are within `tolerance`. */
  noteNear(
    field: string,
    frame: number,
    ours: number,
    theirs: number | undefined,
    tolerance: number,
  ): void {
    if (theirs !== undefined && Math.abs(ours - theirs) <= tolerance) return
    this.record(field, frame, ours, theirs)
  }

  private record(field: string, frame: number, ours: unknown, theirs: unknown): void {
    const seen = this.byField.get(field)
    if (seen) seen.count += 1
    else this.byField.set(field, { count: 1, frame, ours, theirs })
  }

  /** One line for each field that differs, naming the first frame that does. */
  report(label: string): string[] {
    return [...this.byField].map(
      ([field, { count, frame, ours, theirs }]) =>
        `${label}: ${field} differs in ${count} frames, first at frame ${frame}: ours ${shown(ours)}, ffprobe ${shown(theirs)}`,
    )
  }
}

/** The display rotation a `tkhd` matrix says, in degrees counter-clockwise, as FFmpeg's `av_display_rotation_get` reads it. */
export function rotationOf(matrix: Uint8Array): number {
  const view = new DataView(matrix.buffer, matrix.byteOffset, matrix.byteLength)
  const m = Array.from({ length: 9 }, (_, k) => view.getInt32(k * 4))
  const across = Math.hypot(m[0] ?? 0, m[3] ?? 0)
  const down = Math.hypot(m[1] ?? 0, m[4] ?? 0)
  if (across === 0 || down === 0) return 0
  return -Math.atan2((m[1] ?? 0) / down, (m[0] ?? 0) / across) * (180 / Math.PI)
}

/** The rotation that ffprobe reads from a stream's display matrix, 0 for a stream that has none. */
export function rotationIn(stream: ProbeStream): number {
  const matrix = stream.side_data_list?.find((data) => data.side_data_type === 'Display Matrix')
  return matrix?.rotation ?? 0
}

/** The difference of two angles, in degrees, from -180 to 180. */
export function turn(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180
}

/**
 * The first moment at which a track shows anything, in seconds of the movie
 * with the edit list applied. A SourceBuffer's timeline starts at 0: a frame that
 * ends by then is dropped and one that crosses it is cut, which is how FFmpeg
 * trims an encoder's priming (an AAC sound's first 1024 samples, an Opus
 * sound's pre-skip) when it reports where a stream starts. So this is the least
 * presentation time among the frames that end after 0, and not before 0.
 */
export function firstShown(track: { table: FrameTable; timing: TrackTiming }): number {
  const { table, timing } = track
  let first = Infinity
  for (let i = 0; i < table.count; i += 1) {
    const begins = presentationSeconds(table, timing, i)
    const ends = begins + (table.durations[i] ?? 0) / table.timescale
    if (ends > 1e-9) first = Math.min(first, begins)
  }
  return Math.max(first, 0)
}

/** What an `esds` box (whole, header included) says of its stream: the object type, and the DecoderSpecificInfo (null when it has none). Written out here, from ISO/IEC 14496-1, and not taken from the module. Null where the descriptors are not as that, or are cut short. */
export function esdsParts(
  esds: Uint8Array,
): { objectType: number; specific: Uint8Array | null } | null {
  /** The tag of the descriptor at `at`, where its body begins, and its length (up to four bytes of 7 bits). */
  const header = (at: number): { tag: number; body: number; length: number } | null => {
    const tag = esds[at]
    if (tag === undefined) return null
    let length = 0
    for (let index = 1; index <= 4; index += 1) {
      const next = esds[at + index]
      if (next === undefined) return null
      length = length * 128 + (next & 0x7f)
      if ((next & 0x80) === 0) return { tag, body: at + index + 1, length }
    }
    return null
  }
  // After the box's header and its version and flags: the ES_Descriptor.
  const stream = header(12)
  if (stream?.tag !== 0x03) return null
  // The ES_ID and the flags, then the stream it depends on, a URL after its length, and the stream that clocks it.
  const flags = esds[stream.body + 2]
  if (flags === undefined) return null
  let at = stream.body + 3
  if (flags & 0x80) at += 2
  if (flags & 0x40) at += 1 + (esds[at] ?? 0)
  if (flags & 0x20) at += 2
  const decoder = header(at)
  const objectType = decoder === null ? undefined : esds[decoder.body]
  if (decoder?.tag !== 0x04 || objectType === undefined) return null
  // The object type, the stream type, the buffer size (3), and the two bit rates (4 each), then the DecoderSpecificInfo if there is one.
  const specificAt = decoder.body + 13
  if (specificAt >= decoder.body + decoder.length) return { objectType, specific: null }
  const specific = header(specificAt)
  if (specific?.tag !== 0x05) return { objectType, specific: null }
  return { objectType, specific: esds.subarray(specific.body, specific.body + specific.length) }
}

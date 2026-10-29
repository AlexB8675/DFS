import type { ByteRange } from '../source.ts'

// A Matroska file of many clusters that is never built, used by tests only
// (DESIGN.md §10.4): a seek in a file of several gigabytes is checked by the reads
// it asks for, and the bytes of a range are written when the range is asked for. The
// head is real bytes (the EBML header, the Segment, Info and Tracks, built by
// `matroskaFile`); every cluster after it is generated, of the size and the Timestamp
// it is given, with a picture keyframe block first, which is `KEY_BYTES` long and
// begins as a VP9 keyframe does, and one block of the rest after it, whose bytes are
// zeros. The sizes are written as 8 bytes each, as a writer that fills them in later
// does, so that a header takes the same room in every cluster.

/** The bytes of a VP9 keyframe's uncompressed header (profile 0, 8 bits): a keyframe's first 5 bytes. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

/** How long the first block's frame is: 200 KiB, a keyframe of an ordinary recording. */
const KEY_BYTES = 200 * 1024

/** The least a cluster takes: the two pieces, the key block and a rest block of its header only. */
export const LEAST_CLUSTER = 12 + 6 + 9 + 4 + KEY_BYTES + 9 + 4

/** One cluster of a virtual file: how long it is in bytes, and its Timestamp in ticks (it must fit 4 bytes). */
export interface VirtualCluster {
  size: number
  timestamp: number
}

/** A file that is a real head and generated clusters. */
export interface VirtualFile {
  /** Where the first cluster starts, which is where the head ends. */
  first: number
  /** The file's length: the head and every cluster. */
  total: number
  /** Where each cluster starts in the file. */
  starts: readonly number[]
  /** The bytes from `start` to `end`: a fresh array that the caller may keep. */
  bytes(range: ByteRange): Uint8Array
}

/** The bytes of `value` as a number of `width` bytes, big-endian. */
function big(value: number, width: number): number[] {
  const out: number[] = []
  for (let at = width - 1; at >= 0; at -= 1) out.push(Math.floor(value / 2 ** (8 * at)) & 0xff)
  return out
}

/** A size of 8 bytes, the way a writer pads one. */
function size8(value: number): number[] {
  return [0x01, ...big(value, 7)]
}

/** The bytes of a cluster that are not zeros: where each starts counted from the cluster, and what they are. */
function pieces(cluster: VirtualCluster): { at: number; bytes: number[] }[] {
  const key = 4 + KEY_BYTES
  const rest = cluster.size - 12 - 6 - 9 - key - 9
  return [
    {
      at: 0,
      bytes: [
        ...[0x1f, 0x43, 0xb6, 0x75],
        ...size8(cluster.size - 12),
        ...[0xe7, 0x84, ...big(cluster.timestamp, 4)],
        ...[0xa3, ...size8(key), 0x81, 0x00, 0x00, 0x80],
        ...VP9_KEYFRAME,
      ],
    },
    { at: 12 + 6 + 9 + key, bytes: [0xa3, ...size8(rest), 0x81, 0x00, 0x00, 0x00] },
  ]
}

/**
 * The virtual file whose head is `head` and whose clusters follow it, one after
 * the other, from the first byte after the head.
 */
export function virtualFile(head: Uint8Array, clusters: readonly VirtualCluster[]): VirtualFile {
  const starts: number[] = []
  let total = head.length
  for (const cluster of clusters) {
    if (!Number.isInteger(cluster.size) || cluster.size < LEAST_CLUSTER) {
      throw new RangeError(`A cluster of ${cluster.size} bytes is shorter than ${LEAST_CLUSTER}.`)
    }
    starts.push(total)
    total += cluster.size
  }

  /** The index of the last cluster that starts at or before `at` (or 0). */
  const clusterAt = (at: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((starts[middle] ?? Infinity) <= at) low = middle
      else high = middle - 1
    }
    return low
  }

  return {
    first: head.length,
    total,
    starts,
    bytes({ start, end }) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > total) {
        throw new RangeError(`The range from ${start} to ${end} is not inside the file.`)
      }
      const out = new Uint8Array(Math.max(0, end - start))
      if (start < head.length) out.set(head.subarray(start, Math.min(head.length, end)))
      for (
        let which = clusterAt(Math.max(start, head.length));
        which < clusters.length;
        which += 1
      ) {
        const at = starts[which] ?? total
        if (at >= end) break
        const cluster = clusters[which]
        if (cluster === undefined) break
        for (const piece of pieces(cluster)) {
          for (const [offset, byte] of piece.bytes.entries()) {
            const place = at + piece.at + offset
            if (place >= start && place < end) out[place - start] = byte
          }
        }
      }
      return out
    },
  }
}

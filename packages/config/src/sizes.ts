// Byte sizes in settings, and the sizes derived from Discord's attachment
// limit (DESIGN.md §7.3, §15).

export const KiB = 1024
export const MiB = 1024 * KiB
export const GiB = 1024 * MiB
export const TiB = 1024 * GiB

/** Header and GCM tag of one DFS1 frame (§7.3). */
export const FRAME_OVERHEAD_BYTES = 38
/** Every attachment stays this far under Discord's limit. */
const ATTACHMENT_HEADROOM = 64 * KiB
/** Chunks are a multiple of this, so byte offsets map to chunks cheaply. */
const CHUNK_ALIGNMENT = 64 * KiB
/** `PACK_TARGET_BYTES` defaults to this much under `BLOB_MAX_BYTES`. */
const PACK_TARGET_HEADROOM = 256 * KiB

const UNITS: Record<string, number> = { '': 1, B: 1, KiB, MiB, GiB, TiB }

/**
 * Reads a byte size such as `10485760`, `512 MiB` or `20GiB`. Only binary
 * units, so `GB` is refused rather than guessed at.
 */
export function parseByteSize(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(text.trim())
  if (!match) return null
  const [, amount = '', unit = ''] = match
  const factor = UNITS[unit]
  if (factor === undefined) return null
  const bytes = Number(amount) * factor
  return Number.isSafeInteger(bytes) ? bytes : null
}

export interface DerivedSizes {
  /** Hard cap on every attachment: the limit minus 64 KiB. */
  blobMaxBytes: number
  /** The largest multiple of 64 KiB whose frame fits under `blobMaxBytes`. */
  chunkSize: number
  /** Default soft target for sealing a pack. */
  defaultPackTargetBytes: number
}

export function deriveSizes(attachmentLimit: number): DerivedSizes {
  const blobMaxBytes = attachmentLimit - ATTACHMENT_HEADROOM
  const chunkSize =
    Math.floor((blobMaxBytes - FRAME_OVERHEAD_BYTES) / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT
  return { blobMaxBytes, chunkSize, defaultPackTargetBytes: blobMaxBytes - PACK_TARGET_HEADROOM }
}

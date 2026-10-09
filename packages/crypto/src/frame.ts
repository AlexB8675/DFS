import type { AesKey } from './keys.ts'

// DFS1 frames (DESIGN.md §7.3): encrypted objects, self-delimiting so a pack
// can be split without the database. Two formats share the magic.
//
// Format 1, for journal batches and files stored before format 2: one GCM
// seal over the whole plaintext.
//
//   magic "DFS1" (4) | format version 1 (1) | flags (1) | ciphertext length (4, BE)
//   | nonce (12) | ciphertext | GCM tag (16)
//
// The GCM additional data is the first 10 header bytes followed by a typed
// context (chunk, journal batch, …), so the tag authenticates every header
// field and binds the frame to what it is and where it belongs.
//
// Format 2, for file chunks (D37): the plaintext sealed in segments of 256
// KiB, each with its own nonce and tag, so a reader can check and pass on
// part of a chunk, read from Discord by Range, before the rest has arrived
// (§6.2). Its flags are 0, and its segment size is the format's, so a reader
// knows a chunk's layout from its sizes alone (`chunkFrameLayout`).
//
//   magic "DFS1" (4) | format version 2 (1) | flags (1) | plaintext length (4, BE)
//   | segment size (4, BE) | segments
//   segment: nonce (12) | ciphertext (up to the segment size) | GCM tag (16)
//
// Each segment's additional data is the 14 header bytes, its index (4, BE),
// whether it is the last (1), then the context: a segment can't be moved,
// dropped or passed off as the end, and a changed header fails every one.

const MAGIC = new Uint8Array([0x44, 0x46, 0x53, 0x31]) // "DFS1"
const FORMAT_VERSION = 1
const HEADER_BYTES = 10
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Bytes a format 1 frame adds to its plaintext: 38. */
export const FRAME_OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES

const SEGMENTED_VERSION = 2
const SEGMENTED_HEADER_BYTES = 14
/** Plaintext per segment of a format 2 frame: the format's, never another. */
export const SEGMENT_BYTES = 256 * 1024
/** Bytes each segment adds: its nonce and tag. */
const SEGMENT_OVERHEAD = NONCE_BYTES + TAG_BYTES

export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

export interface FrameHeader {
  flags: number
  ciphertextLength: number
  /** The whole frame, header and tag included. */
  frameLength: number
}

/** Reads the header at the start of `bytes`, e.g. to walk the frames of a pack. */
export function readFrameHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < HEADER_BYTES) throw new FrameError('Truncated frame header.')
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new FrameError('Not a DFS1 frame.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  // Format 1's ciphertext is as long as its plaintext; format 2 counts plaintext.
  const ciphertextLength = view.getUint32(6)
  if (bytes[4] === FORMAT_VERSION) {
    return {
      flags: view.getUint8(5),
      ciphertextLength,
      frameLength: FRAME_OVERHEAD + ciphertextLength,
    }
  }
  if (bytes[4] === SEGMENTED_VERSION) {
    if (bytes.length < SEGMENTED_HEADER_BYTES) throw new FrameError('Truncated frame header.')
    if (view.getUint32(10) !== SEGMENT_BYTES) {
      throw new FrameError(`Format 2 frames have ${String(SEGMENT_BYTES)}-byte segments.`)
    }
    return {
      flags: view.getUint8(5),
      ciphertextLength,
      frameLength: chunkFrameLength(ciphertextLength),
    }
  }
  throw new FrameError(`Unsupported frame format ${String(bytes[4])}.`)
}

/** How long a format 2 frame of `plaintextLength` bytes is. */
export function chunkFrameLength(plaintextLength: number): number {
  return SEGMENTED_HEADER_BYTES + plaintextLength + segmentCount(plaintextLength) * SEGMENT_OVERHEAD
}

/** Segments of a format 2 frame: an empty plaintext still has one, so it is sealed too. */
function segmentCount(plaintextLength: number): number {
  return Math.max(1, Math.ceil(plaintextLength / SEGMENT_BYTES))
}

/**
 * Where each segment of a format 2 chunk frame is, worked out from the
 * plaintext and frame sizes alone, so a reader can ask for some of them
 * without reading the header first.
 */
export class ChunkFrameLayout {
  readonly plaintextLength: number
  readonly segments: number
  /** The header a segment's additional data starts with, as the frame must hold it. */
  readonly header: Uint8Array

  constructor(plaintextLength: number) {
    this.plaintextLength = plaintextLength
    this.segments = segmentCount(plaintextLength)
    this.header = segmentedHeader(plaintextLength)
  }

  /** The segment holding plaintext byte `offset`. */
  segmentOf(offset: number): number {
    return Math.min(this.segments - 1, Math.floor(offset / SEGMENT_BYTES))
  }

  /** Where segment `index` starts in the frame. */
  segmentStart(index: number): number {
    return SEGMENTED_HEADER_BYTES + index * (SEGMENT_BYTES + SEGMENT_OVERHEAD)
  }

  /** Bytes segment `index` takes in the frame. */
  segmentLength(index: number): number {
    return this.plaintextSize(index) + SEGMENT_OVERHEAD
  }

  /** Where segment `index`'s plaintext starts in the chunk. */
  plaintextStart(index: number): number {
    return index * SEGMENT_BYTES
  }

  /** Bytes of plaintext segment `index` holds. */
  plaintextSize(index: number): number {
    return Math.max(0, Math.min(SEGMENT_BYTES, this.plaintextLength - index * SEGMENT_BYTES))
  }
}

/**
 * The layout of a chunk's frame given its sizes: format 2's, or `null` for a
 * format 1 frame, which is read whole. Sizes that fit neither are refused.
 */
export function chunkFrameLayout(
  plaintextSize: number,
  frameSize: number,
): ChunkFrameLayout | null {
  if (frameSize === plaintextSize + FRAME_OVERHEAD) return null
  if (frameSize === chunkFrameLength(plaintextSize)) return new ChunkFrameLayout(plaintextSize)
  throw new FrameError(
    `A ${String(frameSize)}-byte frame can't hold a ${String(plaintextSize)}-byte chunk.`,
  )
}

/**
 * Encrypts a file chunk into a format 2 frame bound to `context`: segments
 * sealed on the thread pool, each with its own random nonce.
 */
export async function sealChunkFrame(
  key: AesKey,
  plaintext: Uint8Array,
  context: Uint8Array,
): Promise<Uint8Array> {
  const layout = new ChunkFrameLayout(plaintext.length)
  const sealed = await Promise.all(
    Array.from({ length: layout.segments }, async (_, index) => {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
      const start = layout.plaintextStart(index)
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: segmentData(layout, index, context),
        },
        key,
        plaintext.subarray(start, start + layout.plaintextSize(index)),
      )
      return { nonce, ciphertext: new Uint8Array(ciphertext) }
    }),
  )
  // Every byte is overwritten below.
  const frame = Buffer.allocUnsafe(chunkFrameLength(plaintext.length))
  frame.set(layout.header, 0)
  sealed.forEach(({ nonce, ciphertext }, index) => {
    const start = layout.segmentStart(index)
    frame.set(nonce, start)
    frame.set(ciphertext, start + NONCE_BYTES)
  })
  return frame
}

/**
 * Checks and decrypts one segment of a format 2 chunk frame: `bytes` are
 * exactly its bytes in the frame. Fails for a changed byte, another segment,
 * another chunk, or a wrong key.
 */
export async function openSegment(
  key: AesKey,
  layout: ChunkFrameLayout,
  index: number,
  bytes: Uint8Array,
  context: Uint8Array,
): Promise<Uint8Array> {
  if (index < 0 || index >= layout.segments || bytes.length !== layout.segmentLength(index)) {
    throw new FrameError(`Segment ${String(index)} has the wrong size.`)
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(0, NONCE_BYTES),
        additionalData: segmentData(layout, index, context),
      },
      key,
      bytes.subarray(NONCE_BYTES),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new FrameError('Segment failed authentication: tampered, misplaced or wrong key.')
  }
}

function segmentedHeader(plaintextLength: number): Uint8Array {
  const header = new Uint8Array(SEGMENTED_HEADER_BYTES)
  header.set(MAGIC, 0)
  header[4] = SEGMENTED_VERSION
  header[5] = 0
  const view = new DataView(header.buffer)
  view.setUint32(6, plaintextLength)
  view.setUint32(10, SEGMENT_BYTES)
  return header
}

/** A segment's additional data: the header, its index, whether it is the last, the context. */
function segmentData(layout: ChunkFrameLayout, index: number, context: Uint8Array): Uint8Array {
  const data = new Uint8Array(SEGMENTED_HEADER_BYTES + 5 + context.length)
  data.set(layout.header, 0)
  new DataView(data.buffer).setUint32(SEGMENTED_HEADER_BYTES, index)
  data[SEGMENTED_HEADER_BYTES + 4] = index === layout.segments - 1 ? 1 : 0
  data.set(context, SEGMENTED_HEADER_BYTES + 5)
  return data
}

async function openSegmentedFrame(
  key: AesKey,
  frame: Uint8Array,
  context: Uint8Array,
  plaintextLength: number,
): Promise<Uint8Array> {
  const layout = new ChunkFrameLayout(plaintextLength)
  // The header is in every segment's additional data, so a changed one fails
  // them all; this says so sooner, and plainly.
  if (!Buffer.from(frame.subarray(0, SEGMENTED_HEADER_BYTES)).equals(layout.header)) {
    throw new FrameError('Frame failed authentication: its header isn’t a chunk’s.')
  }
  const segments = await Promise.all(
    Array.from({ length: layout.segments }, (_, index) => {
      const start = layout.segmentStart(index)
      return openSegment(
        key,
        layout,
        index,
        frame.subarray(start, start + layout.segmentLength(index)),
        context,
      )
    }),
  )
  const plaintext = new Uint8Array(plaintextLength)
  segments.forEach((segment, index) => {
    plaintext.set(segment, layout.plaintextStart(index))
  })
  return plaintext
}

/** Encrypts `plaintext` into a frame bound to `context`. Runs on the thread pool. */
export async function sealFrame(
  key: AesKey,
  plaintext: Uint8Array,
  context: Uint8Array,
  flags = 0,
): Promise<Uint8Array> {
  const header = new Uint8Array(HEADER_BYTES + NONCE_BYTES)
  header.set(MAGIC, 0)
  header[4] = FORMAT_VERSION
  header[5] = flags
  new DataView(header.buffer).setUint32(6, plaintext.length)
  const nonce = crypto.getRandomValues(header.subarray(HEADER_BYTES))

  // WebCrypto returns the ciphertext followed by the tag: the frame's tail.
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(header, context) },
    key,
    plaintext,
  )
  // Every byte is overwritten below. Allocate only after encryption finishes,
  // avoiding zeroing and holding another part-sized buffer while it runs.
  const frame = Buffer.allocUnsafe(header.length + sealed.byteLength)
  frame.set(header)
  frame.set(new Uint8Array(sealed), header.length)
  return frame
}

/**
 * Checks and decrypts a frame. Any change to the header, nonce, ciphertext
 * or tag, a wrong key, or a frame from another context fails here.
 */
export async function openFrame(
  key: AesKey,
  frame: Uint8Array,
  context: Uint8Array,
): Promise<Uint8Array> {
  const header = readFrameHeader(frame)
  if (frame.length !== header.frameLength) {
    throw new FrameError(
      `Frame is ${String(frame.length)} bytes; its header says ${String(header.frameLength)}.`,
    )
  }
  if (frame[4] === SEGMENTED_VERSION) {
    return openSegmentedFrame(key, frame, context, header.ciphertextLength)
  }
  const nonce = frame.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: additionalData(frame, context) },
      key,
      frame.subarray(HEADER_BYTES + NONCE_BYTES),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new FrameError('Frame failed authentication: tampered, misplaced or wrong key.')
  }
}

function additionalData(frame: Uint8Array, context: Uint8Array): Uint8Array {
  const aad = new Uint8Array(HEADER_BYTES + context.length)
  aad.set(frame.subarray(0, HEADER_BYTES), 0)
  aad.set(context, HEADER_BYTES)
  return aad
}

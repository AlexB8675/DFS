import type { AesKey } from './keys.ts'

// DFS1 frames (DESIGN.md §7.3): one encrypted object, self-delimiting so a
// pack can be split without the database.
//
//   magic "DFS1" (4) | format version (1) | flags (1) | ciphertext length (4, BE)
//   | nonce (12) | ciphertext | GCM tag (16)
//
// The GCM additional data is the first 10 header bytes followed by a typed
// context (chunk, journal batch, …), so the tag authenticates every header
// field and binds the frame to what it is and where it belongs.

const MAGIC = new Uint8Array([0x44, 0x46, 0x53, 0x31]) // "DFS1"
const FORMAT_VERSION = 1
const HEADER_BYTES = 10
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Bytes a frame adds to its plaintext: 38. */
export const FRAME_OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES

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
  if (bytes[4] !== FORMAT_VERSION) {
    throw new FrameError(`Unsupported frame format ${String(bytes[4])}.`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES)
  const ciphertextLength = view.getUint32(6)
  return {
    flags: view.getUint8(5),
    ciphertextLength,
    frameLength: FRAME_OVERHEAD + ciphertextLength,
  }
}

/** Encrypts `plaintext` into a frame bound to `context`. Runs on the thread pool. */
export async function sealFrame(
  key: AesKey,
  plaintext: Uint8Array,
  context: Uint8Array,
  flags = 0,
): Promise<Uint8Array> {
  const frame = new Uint8Array(FRAME_OVERHEAD + plaintext.length)
  frame.set(MAGIC, 0)
  frame[4] = FORMAT_VERSION
  frame[5] = flags
  new DataView(frame.buffer).setUint32(6, plaintext.length)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  frame.set(nonce, HEADER_BYTES)

  // WebCrypto returns the ciphertext followed by the tag: the frame's tail.
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(frame, context) },
    key,
    plaintext,
  )
  frame.set(new Uint8Array(sealed), HEADER_BYTES + NONCE_BYTES)
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

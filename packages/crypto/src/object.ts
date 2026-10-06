import { FrameError, openFrame, readFrameHeader, sealFrame } from './frame.ts'
import { generateDek, importAesKey, type MasterKeys } from './keys.ts'

// Objects without a file version (DESIGN.md §7.3): journal batches, and later
// backup manifests. Each has its own random data key, carried in front of its
// frame, so recovery needs nothing but the object and the master key file:
//
//   key_id length (1) | key_id (ASCII) | wrapped DEK (60) | frame
//
// The DEK's wrap and the frame both use the object's context (a journal
// batch's number, say), so an object passed off as another fails to open.

const WRAPPED_DEK_BYTES = 12 + 32 + 16

/** Seals `plaintext` under a fresh data key, wrapped with the current master key. */
export async function sealObject(
  keys: MasterKeys,
  plaintext: Uint8Array,
  context: Uint8Array,
  flags = 0,
): Promise<Uint8Array> {
  const dek = generateDek()
  const wrapped = await keys.wrapDek(dek, context)
  const frame = await sealFrame(await importAesKey(dek), plaintext, context, flags)
  dek.fill(0)
  const keyId = new TextEncoder().encode(keys.currentId)
  const bytes = new Uint8Array(1 + keyId.length + wrapped.length + frame.length)
  bytes[0] = keyId.length
  bytes.set(keyId, 1)
  bytes.set(wrapped, 1 + keyId.length)
  bytes.set(frame, 1 + keyId.length + wrapped.length)
  return bytes
}

/**
 * Opens an object sealed for `context`, with whichever master key sealed it.
 * `flags` are the frame's, which say how the plaintext is encoded.
 */
export async function openObject(
  keys: MasterKeys,
  bytes: Uint8Array,
  context: Uint8Array,
): Promise<{ plaintext: Uint8Array; flags: number }> {
  const keyIdLength = bytes[0] ?? 0
  const frameStart = 1 + keyIdLength + WRAPPED_DEK_BYTES
  if (keyIdLength === 0 || bytes.length < frameStart) {
    throw new FrameError('Not a sealed object: too short for its key.')
  }
  const keyId = new TextDecoder().decode(bytes.subarray(1, 1 + keyIdLength))
  let key
  try {
    key = await keys.unwrapDek(bytes.subarray(1 + keyIdLength, frameStart), keyId, context)
  } catch (error) {
    if (error instanceof Error && error.message.includes('not in the key file')) throw error
    throw new FrameError('The object’s key failed to unwrap: tampered, misplaced or wrong key.')
  }
  const frame = bytes.subarray(frameStart)
  const plaintext = await openFrame(key, frame, context)
  return { plaintext, flags: readFrameHeader(frame).flags }
}

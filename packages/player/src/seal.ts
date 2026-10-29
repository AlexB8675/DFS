// The sealing of each block the store keeps (DESIGN.md §10.4; the iron-clad spec
// §4.7). A block is encrypted with AES-GCM under a key made for the play and held
// only in memory, and it is sealed before it touches the disk, so what the disk
// holds is never the video. Web Crypto's key cannot be exported, so the key leaves
// the page only by being lost: a leftover file from a crash is bytes nobody can
// read. The block's index is the additional data of the seal, so a sealed block
// that is moved to another place in the file fails to open there.

import { StoreError } from './errors.ts'

/** The bytes that sealing adds to a block: a 12-byte IV before it and a 16-byte tag after it. */
export const SEAL_OVERHEAD = 28

/** The length of the IV, which AES-GCM takes at 12 bytes. */
const IV_BYTES = 12

/**
 * A key of Web Crypto. It is named from `subtle.encrypt` and not as `CryptoKey`
 * because Node's types declare that name as a value only, while the browser's
 * types declare it as a type, and this file is checked under Node's project now and
 * under the browser's once the worker imports it.
 */
export type PlayKey = Parameters<typeof globalThis.crypto.subtle.encrypt>[1]

/** A key for AES-GCM, of 256 bits, that Web Crypto will not export. */
export async function newPlayKey(): Promise<PlayKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** A block's index as 8 bytes, big-endian. An index that is negative or not a whole number is a `RangeError`. */
function additionalData(index: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`${index} is not the index of a block`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(index))
  return bytes
}

/**
 * Seals the bytes of block `index` under `key`, and returns the IV followed by the
 * ciphertext and its tag, `SEAL_OVERHEAD` bytes longer than `plain`. The IV is
 * drawn at random for every call and is never derived from the index: AES-GCM
 * under one key must not meet the same IV twice, and a block is sealed again each
 * time the store writes it.
 */
export async function sealBlock(
  key: PlayKey,
  index: number,
  plain: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const aad = additionalData(index)
  const sealed = new Uint8Array(plain.length + SEAL_OVERHEAD)
  const iv = sealed.subarray(0, IV_BYTES)
  globalThis.crypto.getRandomValues(iv)
  const body = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    plain,
  )
  sealed.set(new Uint8Array(body), IV_BYTES)
  return sealed
}

/**
 * Opens a block that `sealBlock` sealed as block `index`, and returns its bytes. A
 * block that doesn't open (a byte changed, the IV or the index not those it was
 * sealed with, another key, or too short to hold an IV and a tag) is a
 * `StoreError` of kind `sealed`; no byte of it is returned.
 */
export async function openBlock(
  key: PlayKey,
  index: number,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const aad = additionalData(index)
  if (sealed.length < SEAL_OVERHEAD) {
    throw new StoreError(
      'sealed',
      `block ${index} is ${sealed.length} bytes, too short to hold an IV and a tag`,
    )
  }
  try {
    const body = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, IV_BYTES), additionalData: aad },
      key,
      sealed.subarray(IV_BYTES),
    )
    return new Uint8Array(body)
  } catch (error) {
    // Web Crypto fails an open that does not authenticate with an `OperationError`; any other failure is not about the block.
    if (error instanceof Error && error.name === 'OperationError') {
      throw new StoreError(
        'sealed',
        `block ${index} did not open: its tag, IV, index or key do not match`,
      )
    }
    throw error
  }
}

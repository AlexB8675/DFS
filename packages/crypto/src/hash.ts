/** SHA-256 on the thread pool, so hashing a 10 MiB part doesn't block the event loop. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
}

/** `null` unless `text` is exactly the hex of 32 bytes. */
export function fromSha256Hex(text: string): Uint8Array | null {
  return /^[0-9a-f]{64}$/i.test(text) ? Uint8Array.from(Buffer.from(text, 'hex')) : null
}

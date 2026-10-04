/**
 * Reads the stored (uncompressed) entries of a ZIP through its central
 * directory, which works whichever way the writer did the local headers.
 * For tests: ZIP64 fields aren't read, so archives must stay small.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error('No end of central directory.')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)

  const entries = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Bad central directory entry.')
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    const localName = view.getUint16(offset + 26, true)
    const localExtra = view.getUint16(offset + 28, true)
    const start = offset + 30 + localName + localExtra
    entries.set(name, bytes.slice(start, start + size))
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

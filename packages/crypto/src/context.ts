// The typed contexts frames are bound to (DESIGN.md §7.3). A leading type
// byte keeps one kind of object from passing as another.

const TYPE = {
  chunk: 0x01,
  thumbnail: 0x02,
  journalBatch: 0x03,
  backupManifest: 0x04,
  subtitles: 0x05,
} as const

/** A file chunk: `0x01 | version_id (16) | chunk index (4, BE)`. */
export function chunkContext(versionId: string, index: number): Uint8Array {
  const context = new Uint8Array(1 + 16 + 4)
  context[0] = TYPE.chunk
  context.set(uuidBytes(versionId), 1)
  new DataView(context.buffer).setUint32(17, index)
  return context
}

/**
 * Subtitles extracted from a file, kept in the database (§6.7):
 * `0x05 | version_id (16) | stream index (4, BE)`.
 */
export function subtitlesContext(versionId: string, streamIndex: number): Uint8Array {
  const context = chunkContext(versionId, streamIndex)
  context[0] = TYPE.subtitles
  return context
}

/** A journal batch: `0x03 | batch number (8, BE)`. */
export function journalBatchContext(batchNo: number): Uint8Array {
  return numbered(TYPE.journalBatch, batchNo)
}

/** A backup manifest: `0x04 | snapshot number (8, BE)`. */
export function backupManifestContext(snapshotNo: number): Uint8Array {
  return numbered(TYPE.backupManifest, snapshotNo)
}

function numbered(type: number, value: number): Uint8Array {
  const context = new Uint8Array(1 + 8)
  context[0] = type
  new DataView(context.buffer).setBigUint64(1, BigInt(value))
  return context
}

/** The 16 bytes of a UUID in its canonical text form. */
export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a UUID: ${uuid}`)
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

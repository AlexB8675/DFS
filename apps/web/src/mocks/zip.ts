// A minimal ZIP writer for the mock API's archive downloads (§6.2): stored
// entries (no compression), like the real API, which streams files that are
// mostly already compressed. Names are UTF-8 (general-purpose flag bit 11),
// so non-ASCII names survive on every OS. No ZIP64: mock archives are small.
// Times are local, as the browser running the mock is the downloader, and
// also in UTC as Info-ZIP's extended timestamp, as the real API writes them.

export interface ZipEntry {
  /** Path inside the archive, `/`-separated; folders end with `/`. */
  path: string
  data?: Uint8Array
  modifiedAt?: Date
}

const UTF8_FLAG = 0x0800
const encoder = new TextEncoder()

export function createZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const data = entry.data ?? new Uint8Array()
    const crc = crc32(data)
    const modifiedAt = entry.modifiedAt ?? new Date()
    const [time, date] = dosDateTime(modifiedAt)
    const extra = extendedTimestamp(modifiedAt)

    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true) // local file header signature
    header.setUint16(4, 20, true) // version needed: 2.0
    header.setUint16(6, UTF8_FLAG, true)
    header.setUint16(8, 0, true) // method: stored
    header.setUint16(10, time, true)
    header.setUint16(12, date, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, data.length, true) // compressed size
    header.setUint32(22, data.length, true) // uncompressed size
    header.setUint16(26, name.length, true)
    header.setUint16(28, extra.length, true)
    local.push(new Uint8Array(header.buffer), name, extra, data)

    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true) // central directory signature
    record.setUint16(4, 20, true) // version made by
    record.setUint16(6, 20, true) // version needed
    record.setUint16(8, UTF8_FLAG, true)
    record.setUint16(10, 0, true)
    record.setUint16(12, time, true)
    record.setUint16(14, date, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, data.length, true)
    record.setUint32(24, data.length, true)
    record.setUint16(28, name.length, true)
    record.setUint16(30, extra.length, true)
    // Comment, disk number and internal attributes stay 0.
    record.setUint32(38, entry.path.endsWith('/') ? 0x10 : 0, true) // MS-DOS directory attribute
    record.setUint32(42, offset, true) // where the local header starts
    central.push(new Uint8Array(record.buffer), name, extra)

    offset += 30 + name.length + extra.length + data.length
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory signature
  end.setUint16(8, entries.length, true) // entries on this disk
  end.setUint16(10, entries.length, true) // entries in total
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true) // where the central directory starts

  return concat([...local, ...central, new Uint8Array(end.buffer)])
}

let crcTable: Uint32Array | undefined

/** CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(data: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return value >>> 0
  })
  let crc = 0xffffffff
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Info-ZIP's extended timestamp: the modification time in UTC seconds, 1901 to 2038. */
function extendedTimestamp(date: Date): Uint8Array {
  const seconds = Math.floor(date.getTime() / 1000)
  if (!(seconds >= -0x80000000 && seconds <= 0x7fffffff)) return new Uint8Array()
  const extra = new DataView(new ArrayBuffer(9))
  extra.setUint16(0, 0x5455, true)
  extra.setUint16(2, 5, true)
  extra.setUint8(4, 0x01) // the modification time, alone
  extra.setInt32(5, seconds, true)
  return new Uint8Array(extra.buffer)
}

/** MS-DOS time and date, in local time, with two-second precision. */
function dosDateTime(date: Date): [number, number] {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return [time, day]
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let position = 0
  for (const part of parts) {
    result.set(part, position)
    position += part.length
  }
  return result
}

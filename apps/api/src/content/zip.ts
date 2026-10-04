import { crc32 } from 'node:zlib'

// A streaming ZIP writer (DESIGN.md §6.2): entries are stored, not
// compressed, and written as their data arrives, so a folder of any size
// streams with constant memory. Sizes are known up front, but the CRC only
// after the data, so each file is followed by a data descriptor. ZIP64
// fields appear only where a size or an offset needs them.

export interface ZipEntry {
  /** The path inside the archive; folders end with `/`. */
  path: string
  modifiedAt: Date
  /** Files only: the exact size and the data. */
  size?: number
  data?: () => AsyncIterable<Uint8Array>
}

const UTF8_NAMES = 0x0800
const DATA_DESCRIPTOR = 0x0008
const ZIP64_LIMIT = 0xffffffff

interface Written {
  name: Buffer
  modifiedAt: Date
  isFolder: boolean
  crc: number
  size: number
  offset: number
}

/** The archive as a stream of buffers. `limit` exists to test ZIP64 with small files. */
export async function* writeZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  { limit = ZIP64_LIMIT } = {},
): AsyncGenerator<Buffer> {
  const written: Written[] = []
  let offset = 0

  for await (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const isFolder = entry.path.endsWith('/')
    const size = isFolder ? 0 : (entry.size ?? 0)
    const zip64 = size >= limit || offset >= limit
    const header = localHeader(name, entry.modifiedAt, isFolder, zip64)
    const record: Written = { name, modifiedAt: entry.modifiedAt, isFolder, crc: 0, size, offset }
    yield header
    offset += header.length

    if (!isFolder) {
      let crc = 0
      let received = 0
      for await (const chunk of entry.data?.() ?? []) {
        crc = crc32(chunk, crc)
        received += chunk.length
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      }
      if (received !== size) {
        throw new Error(`${entry.path}: expected ${String(size)} bytes, got ${String(received)}.`)
      }
      record.crc = crc
      const descriptor = dataDescriptor(crc, size, zip64)
      yield descriptor
      offset += size + descriptor.length
    }
    written.push(record)
  }

  const directoryOffset = offset
  for (const record of written) {
    const header = centralHeader(record, limit)
    yield header
    offset += header.length
  }
  yield* endRecords(written.length, directoryOffset, offset - directoryOffset, offset, limit)
}

function localHeader(name: Buffer, modifiedAt: Date, isFolder: boolean, zip64: boolean): Buffer {
  const extra = zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(zip64 ? 45 : 20, 4)
  header.writeUInt16LE(UTF8_NAMES | (isFolder ? 0 : DATA_DESCRIPTOR), 6)
  header.writeUInt16LE(0, 8) // stored
  writeDosTime(header, 10, modifiedAt)
  // CRC and sizes follow in the data descriptor; ZIP64 marks the sizes as "in the extra field".
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(zip64 ? ZIP64_LIMIT : 0, 18)
  header.writeUInt32LE(zip64 ? ZIP64_LIMIT : 0, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, name, extra])
}

function dataDescriptor(crc: number, size: number, zip64: boolean): Buffer {
  const descriptor = Buffer.alloc(zip64 ? 24 : 16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(crc, 4)
  if (zip64) {
    descriptor.writeBigUInt64LE(BigInt(size), 8)
    descriptor.writeBigUInt64LE(BigInt(size), 16)
  } else {
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
  }
  return descriptor
}

function centralHeader(record: Written, limit: number): Buffer {
  const bigSize = record.size >= limit
  const bigOffset = record.offset >= limit
  // ZIP64 extra values, in order: uncompressed size, compressed size, offset.
  const values = [
    ...(bigSize ? [record.size, record.size] : []),
    ...(bigOffset ? [record.offset] : []),
  ]
  const extra = values.length > 0 ? zip64Extra(values) : Buffer.alloc(0)
  const zip64 = values.length > 0
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(45, 4)
  header.writeUInt16LE(zip64 ? 45 : 20, 6)
  header.writeUInt16LE(UTF8_NAMES | (record.isFolder ? 0 : DATA_DESCRIPTOR), 8)
  header.writeUInt16LE(0, 10)
  writeDosTime(header, 12, record.modifiedAt)
  header.writeUInt32LE(record.crc, 16)
  header.writeUInt32LE(bigSize ? ZIP64_LIMIT : record.size, 20)
  header.writeUInt32LE(bigSize ? ZIP64_LIMIT : record.size, 24)
  header.writeUInt16LE(record.name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32) // comment
  header.writeUInt16LE(0, 34) // disk
  header.writeUInt16LE(0, 36) // internal attributes
  header.writeUInt32LE(record.isFolder ? 0x10 : 0, 38) // MS-DOS directory flag
  header.writeUInt32LE(bigOffset ? ZIP64_LIMIT : record.offset, 42)
  return Buffer.concat([header, record.name, extra])
}

function* endRecords(
  count: number,
  directoryOffset: number,
  directorySize: number,
  endOffset: number,
  limit: number,
): Generator<Buffer> {
  const zip64 = count >= 0xffff || directoryOffset >= limit || directorySize >= limit
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeUInt32LE(0, 16)
    record.writeUInt32LE(0, 20)
    record.writeBigUInt64LE(BigInt(count), 24)
    record.writeBigUInt64LE(BigInt(count), 32)
    record.writeBigUInt64LE(BigInt(directorySize), 40)
    record.writeBigUInt64LE(BigInt(directoryOffset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeUInt32LE(0, 4)
    locator.writeBigUInt64LE(BigInt(endOffset), 8)
    locator.writeUInt32LE(1, 16)
    yield record
    yield locator
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Math.min(count, 0xffff), 8)
  end.writeUInt16LE(Math.min(count, 0xffff), 10)
  end.writeUInt32LE(Math.min(directorySize, ZIP64_LIMIT), 12)
  end.writeUInt32LE(zip64 ? ZIP64_LIMIT : directoryOffset, 16)
  yield end
}

function zip64Extra(values: number[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8)
  extra.writeUInt16LE(0x0001, 0)
  extra.writeUInt16LE(values.length * 8, 2)
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8))
  return extra
}

/** MS-DOS time and date, in local time, two-second precision, from 1980. */
function writeDosTime(buffer: Buffer, at: number, date: Date): void {
  const year = Math.max(1980, date.getFullYear())
  buffer.writeUInt16LE(
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    at,
  )
  buffer.writeUInt16LE(((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(), at + 2)
}

/**
 * The exact size `writeZip` will produce for these entries, worked out the
 * same way, so the response can say its length and browsers show progress.
 */
export function zipLength(entries: readonly ZipEntry[], { limit = ZIP64_LIMIT } = {}): number {
  let offset = 0
  let directory = 0
  for (const entry of entries) {
    const nameLength = Buffer.byteLength(entry.path, 'utf8')
    const isFolder = entry.path.endsWith('/')
    const size = isFolder ? 0 : (entry.size ?? 0)
    const zip64 = size >= limit || offset >= limit
    const entryOffset = offset
    offset += 30 + nameLength + (zip64 ? 20 : 0)
    if (!isFolder) offset += size + (zip64 ? 24 : 16)
    const values = (size >= limit ? 2 : 0) + (entryOffset >= limit ? 1 : 0)
    directory += 46 + nameLength + (values > 0 ? 4 + values * 8 : 0)
  }
  const zip64End = entries.length >= 0xffff || offset >= limit || directory >= limit
  return offset + directory + (zip64End ? 56 + 20 : 0) + 22
}

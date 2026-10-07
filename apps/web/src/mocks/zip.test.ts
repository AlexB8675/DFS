import { describe, expect, it } from 'vitest'
import { crc32, createZip } from './zip'

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('createZip', () => {
  it('stores entries with sizes, CRCs and an end record that counts them', () => {
    const data = new TextEncoder().encode('hello')
    const zip = createZip([{ path: 'folder/' }, { path: 'folder/hello.txt', data }])
    const view = new DataView(zip.buffer)

    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint32(14, true)).toBe(0) // the folder entry is empty
    const end = zip.byteLength - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)

    // The second local header: stored, with the file's CRC and size.
    const second = 30 + 'folder/'.length + view.getUint16(28, true)
    expect(view.getUint16(second + 8, true)).toBe(0)
    expect(view.getUint32(second + 14, true)).toBe(crc32(data))
    expect(view.getUint32(second + 18, true)).toBe(5)
  })

  it('writes the modification time in UTC beside the local DOS time', () => {
    const modifiedAt = new Date('2024-03-05T06:07:08Z')
    const zip = createZip([{ path: 'dated.txt', data: new Uint8Array(), modifiedAt }])
    const view = new DataView(zip.buffer)
    // Info-ZIP's extended timestamp, right after the name: tag, size, flags, seconds.
    const extra = 30 + 'dated.txt'.length
    expect(view.getUint16(28, true)).toBe(9)
    expect(view.getUint16(extra, true)).toBe(0x5455)
    expect(view.getInt32(extra + 5, true)).toBe(modifiedAt.getTime() / 1000)
  })
})

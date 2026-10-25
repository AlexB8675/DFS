import { describe, expect, it } from 'vitest'
import {
  binary,
  element,
  elementSized,
  float,
  idBytes,
  sizeBytes,
  string,
  uint,
  unknownSize,
} from './ebml.ts'

// The builder writes the bytes that RFC 8794 gives, and these tests hold it to
// them, so that the reader's tests are checked against the standard and not
// against what the builder happens to write (DESIGN.md §10.4).

/** The bytes as numbers, which show in a failure as the values they are. */
function bytes(value: Uint8Array | number[]): number[] {
  return Array.from(value)
}

describe('the EBML builder (§10.4)', () => {
  it('writes an ID as its bytes, from 1 to 4', () => {
    expect(idBytes(0xa3)).toEqual([0xa3])
    expect(idBytes(0x4286)).toEqual([0x42, 0x86])
    expect(idBytes(0x2ad7b1)).toEqual([0x2a, 0xd7, 0xb1])
    expect(idBytes(0x1a45dfa3)).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  })

  it('refuses an ID whose first byte does not say how wide it is', () => {
    expect(() => idBytes(0)).toThrow(RangeError)
    expect(() => idBytes(0x7f)).toThrow(RangeError)
    // 2 bytes whose first byte is 0x3F, where 2 bytes start with 0x40 to 0x7F.
    expect(() => idBytes(0x3fff)).toThrow(RangeError)
    expect(() => idBytes(0x1fffff)).toThrow(RangeError)
    expect(() => idBytes(0x0fffffff)).toThrow(RangeError)
    expect(() => idBytes(2 ** 32)).toThrow(RangeError)
    expect(() => idBytes(1.5)).toThrow(RangeError)
  })

  it('writes the shortest size, which leaves all 1 bits for an unknown one', () => {
    expect(sizeBytes(0)).toEqual([0x80])
    expect(sizeBytes(1)).toEqual([0x81])
    expect(sizeBytes(126)).toEqual([0xfe])
    // 127 in one byte would be 0xFF, which is unknown.
    expect(sizeBytes(127)).toEqual([0x40, 0x7f])
    expect(sizeBytes(16382)).toEqual([0x7f, 0xfe])
    expect(sizeBytes(16383)).toEqual([0x20, 0x3f, 0xff])
    // 5 bytes hold 35 bits, the marker being the 36th: 2^32 is bit 32 of them.
    expect(sizeBytes(2 ** 32)).toEqual([0x09, 0x00, 0x00, 0x00, 0x00])
    expect(sizeBytes(2 ** 53 - 1)).toEqual([0x01, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  })

  it('writes a size in the width asked for', () => {
    expect(sizeBytes(2, 8)).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0x02])
    expect(sizeBytes(1, 1)).toEqual([0x81])
    expect(sizeBytes(1, 4)).toEqual([0x10, 0, 0, 0x01])
    // 3 bytes hold 21 bits: the marker is the 22nd, so 0x123456 is written as 0x323456.
    expect(sizeBytes(0x123456, 3)).toEqual([0x32, 0x34, 0x56])
  })

  it('refuses a size that does not fit its width, and a width that is not 1 to 8', () => {
    // 127 and above do not fit in a byte, as 0xFF would be unknown.
    expect(() => sizeBytes(127, 1)).toThrow(RangeError)
    expect(() => sizeBytes(2 ** 14 - 1, 2)).toThrow(RangeError)
    expect(() => sizeBytes(-1)).toThrow(RangeError)
    expect(() => sizeBytes(1.5)).toThrow(RangeError)
    expect(() => sizeBytes(1, 0)).toThrow(RangeError)
    expect(() => sizeBytes(1, 9)).toThrow(RangeError)
  })

  it('writes an unknown size, of 8 bytes unless asked for others', () => {
    expect(unknownSize()).toEqual([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    expect(unknownSize(1)).toEqual([0xff])
    expect(unknownSize(2)).toEqual([0x7f, 0xff])
    expect(unknownSize(4)).toEqual([0x1f, 0xff, 0xff, 0xff])
    expect(() => unknownSize(0)).toThrow(RangeError)
    expect(() => unknownSize(9)).toThrow(RangeError)
  })

  it('writes an element as its ID, its size and its parts', () => {
    expect(bytes(element(0x1a45dfa3, [1, 2]))).toEqual([0x1a, 0x45, 0xdf, 0xa3, 0x82, 0x01, 0x02])
    expect(bytes(element(0xec))).toEqual([0xec, 0x80])
    // Parts that are bytes and parts that are numbers, joined.
    expect(bytes(element(0xa0, new Uint8Array([1, 2]), [3], new Uint8Array([4])))).toEqual([
      0xa0, 0x84, 1, 2, 3, 4,
    ])
    // An element in an element.
    expect(bytes(element(0xa0, element(0xe7, [5])))).toEqual([0xa0, 0x83, 0xe7, 0x81, 5])
    // Past 126 bytes the size takes 2.
    const long = element(0x63a2, new Array<number>(127).fill(7))
    expect(bytes(long.subarray(0, 4))).toEqual([0x63, 0xa2, 0x40, 0x7f])
    expect(long.length).toBe(2 + 2 + 127)
  })

  it('writes an element with the size it is given, which need not be its length', () => {
    expect(bytes(elementSized(0x18538067, unknownSize(), [1]))).toEqual([
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ])
    expect(bytes(elementSized(0xe7, sizeBytes(1, 4), [5]))).toEqual([0xe7, 0x10, 0, 0, 0x01, 5])
    // A size that claims more than the parts hold.
    expect(bytes(elementSized(0xe7, [0x88], [5]))).toEqual([0xe7, 0x88, 5])
  })

  it('writes an unsigned integer in the fewest whole bytes, and at least one', () => {
    expect(bytes(uint(0xe7, 0))).toEqual([0xe7, 0x81, 0x00])
    expect(bytes(uint(0xe7, 1))).toEqual([0xe7, 0x81, 0x01])
    expect(bytes(uint(0xe7, 255))).toEqual([0xe7, 0x81, 0xff])
    expect(bytes(uint(0xe7, 256))).toEqual([0xe7, 0x82, 0x01, 0x00])
    expect(bytes(uint(0x2ad7b1, 1_000_000))).toEqual([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])
    expect(bytes(uint(0xe7, 2 ** 53 - 1))).toEqual([
      0xe7, 0x87, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ])
    expect(bytes(uint(0xe7, 2n ** 56n))).toEqual([0xe7, 0x88, 0x01, 0, 0, 0, 0, 0, 0, 0])
    expect(bytes(uint(0xe7, 2n ** 64n - 1n))).toEqual([
      0xe7, 0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ])
  })

  it('refuses an unsigned integer that is negative, fractional or wider than 8 bytes', () => {
    expect(() => uint(0xe7, -1)).toThrow(RangeError)
    expect(() => uint(0xe7, -1n)).toThrow(RangeError)
    expect(() => uint(0xe7, 1.5)).toThrow(RangeError)
    expect(() => uint(0xe7, 2n ** 64n)).toThrow(RangeError)
  })

  it('writes a float as 4 bytes or 8, big-endian', () => {
    // 48000 is 0x473B8000 as a single and 0x40E7700000000000 as a double.
    expect(bytes(float(0xb5, 48000, 4))).toEqual([0xb5, 0x84, 0x47, 0x3b, 0x80, 0x00])
    expect(bytes(float(0xb5, 48000))).toEqual([
      0xb5, 0x88, 0x40, 0xe7, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    expect(bytes(float(0xb5, 48000, 8))).toEqual(bytes(float(0xb5, 48000)))
  })

  it('writes a string as its UTF-8 bytes, with no 0 byte of its own', () => {
    expect(bytes(string(0x4282, 'webm'))).toEqual([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
    expect(bytes(string(0x4282, 'é'))).toEqual([0x42, 0x82, 0x82, 0xc3, 0xa9])
    expect(bytes(string(0x4282, ''))).toEqual([0x42, 0x82, 0x80])
  })

  it('writes binary data from bytes or numbers', () => {
    expect(bytes(binary(0x63a2, [1, 2, 3]))).toEqual([0x63, 0xa2, 0x83, 1, 2, 3])
    expect(bytes(binary(0x63a2, new Uint8Array([9])))).toEqual([0x63, 0xa2, 0x81, 9])
  })
})

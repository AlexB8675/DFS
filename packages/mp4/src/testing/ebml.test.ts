import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ID } from '../matroska/ids.ts'
import type { MatroskaFile } from './ebml.ts'
import {
  binary,
  blockGroup,
  cluster,
  cues,
  ebmlHeader,
  element,
  elementSized,
  float,
  idBytes,
  info,
  int,
  matroskaFile,
  matroskaMovie,
  seekEntry,
  seekHead,
  segment,
  simpleBlock,
  sizeBytes,
  string,
  trackEntry,
  tracksElement,
  uint,
  unknownSize,
} from './ebml.ts'

// The builder writes the bytes that RFC 8794 gives, and these tests hold it to
// them, so that the reader's tests are checked against the standard and not
// against what the builder happens to write (DESIGN.md §10.4).

/** The offset of a part of a laid-out file, which must be there. */
function where(file: MatroskaFile, index: number): number {
  const at = file.offsets[index]
  if (at === undefined) throw new Error(`There is no part ${index}.`)
  return at
}

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

describe('the Matroska shapes of the builder (§10.4)', () => {
  it('writes the EBML header as ffmpeg writes it, with the DocType and the read version asked for', () => {
    const header = ebmlHeader({ docType: 'webm' })
    // The header's own size is the 31 bytes of its 7 children.
    expect(bytes(header)).toEqual([
      ...[0x1a, 0x45, 0xdf, 0xa3, 0x9f],
      // Version 1, read version 1, an ID of 4 bytes at most and a size of 8,
      ...[0x42, 0x86, 0x81, 1],
      ...[0x42, 0xf7, 0x81, 1],
      ...[0x42, 0xf2, 0x81, 4],
      ...[0x42, 0xf3, 0x81, 8],
      // the DocType, its version 4 and its read version 2.
      ...[0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d],
      ...[0x42, 0x87, 0x81, 4],
      ...[0x42, 0x85, 0x81, 2],
    ])
    // The default DocType is matroska (8 letters, 4 more than webm), and the read version can be asked for.
    const other = ebmlHeader({ readVersion: 5 })
    expect(other.length).toBe(header.length + 4)
    expect(bytes(other.subarray(5, 9))).toEqual([0x42, 0x86, 0x81, 1])
    expect(bytes(other.subarray(-4))).toEqual([0x42, 0x85, 0x81, 5])
    expect(bytes(other.subarray(21, 32))).toEqual([
      ...[0x42, 0x82, 0x88],
      ...Array.from('matroska', (letter) => letter.charCodeAt(0)),
    ])
  })

  it('writes a SeekHead whose positions are 8 bytes wide, so that its length does not depend on them', () => {
    // A Seek of 18 bytes: the ID's 4 bytes in a SeekID, and the position's 8 in a SeekPosition.
    expect(bytes(seekEntry(ID.Cues, 0x0102))).toEqual([
      ...[0x4d, 0xbb, 0x92],
      ...[0x53, 0xab, 0x84, 0x1c, 0x53, 0xbb, 0x6b],
      ...[0x53, 0xac, 0x88, 0, 0, 0, 0, 0, 0, 0x01, 0x02],
    ])
    // Two of them are 2 x 21 bytes.
    const head = seekHead([
      [ID.Tracks, 10],
      [ID.Cues, 2 ** 40],
    ])
    expect(bytes(head.subarray(0, 5))).toEqual([0x11, 0x4d, 0x9b, 0x74, 0xaa])
    expect(head.length).toBe(5 + 42)
    expect(seekHead([[ID.Tracks, 0]]).length).toBe(seekHead([[ID.Tracks, 2 ** 40]]).length)
    expect(bytes(seekHead([]))).toEqual([0x11, 0x4d, 0x9b, 0x74, 0x80])
  })

  it('writes Info with the scale and the duration it is given, and neither when it is given none', () => {
    expect(bytes(info({}))).toEqual([0x15, 0x49, 0xa9, 0x66, 0x80])
    expect(bytes(info({ scale: 1_000_000 }))).toEqual([
      ...[0x15, 0x49, 0xa9, 0x66, 0x87],
      ...[0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40],
    ])
    // A scale of 0 is written as it is: a test uses it to show it is refused.
    expect(bytes(info({ scale: 0 }).subarray(5))).toEqual([0x2a, 0xd7, 0xb1, 0x81, 0x00])
    // 4021 as a double is 0x40AF6A0000000000.
    expect(bytes(info({ duration: 4021 }))).toEqual([
      ...[0x15, 0x49, 0xa9, 0x66, 0x8b],
      ...[0x44, 0x89, 0x88, 0x40, 0xaf, 0x6a, 0, 0, 0, 0, 0],
    ])
  })

  it('writes a Segment of the size of its children, or of an unknown one', () => {
    const child = Uint8Array.from([0xec, 0x80])
    expect(bytes(segment([child]))).toEqual([0x18, 0x53, 0x80, 0x67, 0x82, 0xec, 0x80])
    expect(bytes(segment([child], { unknown: true }))).toEqual([
      ...[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      ...[0xec, 0x80],
    ])
  })

  it('lays a file out and says where each of its parts is, so that a test can name exact positions', () => {
    const tags = element(ID.Tags, new Array<number>(200).fill(1))
    const cues = element(ID.Cues)
    const inf = info({ duration: 5 })
    const file = matroskaFile([inf, tags, cues])
    expect(file.offsets).toHaveLength(3)
    for (const [index, id] of [ID.Info, ID.Tags, ID.Cues].entries()) {
      // Each offset is the file's own, and where the part's ID starts.
      const at = where(file, index)
      expect(bytes(file.bytes.subarray(at, at + 4))).toEqual(idBytes(id))
    }
    expect(where(file, 1)).toBe(where(file, 0) + inf.length)
    expect(where(file, 2)).toBe(where(file, 1) + tags.length)
    // The Segment's data is where its first part is, and the file ends with the last.
    expect(file.segmentData).toBe(where(file, 0))
    expect(file.bytes.length).toBe(where(file, 2) + cues.length)
    // The EBML header comes first, and the Segment follows it.
    const header = ebmlHeader({})
    expect(bytes(file.bytes.subarray(0, 4))).toEqual(idBytes(ID.EBML))
    expect(bytes(file.bytes.subarray(header.length, header.length + 4))).toEqual(
      idBytes(ID.Segment),
    )
  })

  it('lets a part say where the others are, which a SeekHead needs, without changing its length', () => {
    const tracks = element(ID.Tracks, [1, 2, 3])
    const cues = element(ID.Cues, [4])
    const file = matroskaFile([
      (at) =>
        seekHead([
          [ID.Tracks, at[1] ?? -1],
          [ID.Cues, at[2] ?? -1],
        ]),
      tracks,
      cues,
    ])
    // The positions in the SeekHead count from the Segment's data: the SeekHead is 47 bytes, and the Tracks (8 bytes) follow it.
    expect(file.segmentData).toBe(where(file, 0))
    expect(where(file, 1) - file.segmentData).toBe(47)
    expect(where(file, 2) - file.segmentData).toBe(47 + 8)
    expect(bytes(file.bytes.subarray(where(file, 0), where(file, 1)))).toEqual(
      bytes(
        seekHead([
          [ID.Tracks, 47],
          [ID.Cues, 55],
        ]),
      ),
    )
    // A part that is not as long the second time as the first is the test's mistake, and the builder says so.
    let calls = 0
    expect(() => matroskaFile([() => new Uint8Array((calls += 1))])).toThrow(RangeError)
  })

  it('can leave the Segment of unknown size, and take another EBML header', () => {
    const header = element(ID.EBML, string(ID.DocType, 'avi'))
    const file = matroskaFile([element(ID.Void, [0])], { header, unknown: true })
    expect(file.segmentData).toBe(header.length + 4 + 8)
    expect(bytes(file.bytes.subarray(header.length + 4, header.length + 12))).toEqual(unknownSize())
  })
})

describe('the track builder (§10.4)', () => {
  it('writes a TrackEntry of the fields it is given, in the order a file has them, and none it is not', () => {
    expect(bytes(trackEntry({}))).toEqual([0xae, 0x80])
    // The number (and the UID of the same value), the type, the flag and the codec: 3 + 4 + 3 + 3 + 7 bytes.
    expect(bytes(trackEntry({ number: 3, type: 1, default: false, codecId: 'V_AV1' }))).toEqual([
      ...[0xae, 0x94],
      ...[0xd7, 0x81, 3],
      ...[0x73, 0xc5, 0x81, 3],
      ...[0x83, 0x81, 1],
      ...[0x88, 0x81, 0],
      ...[0x86, 0x85, 0x56, 0x5f, 0x41, 0x56, 0x31],
    ])
    // The extra elements are the last, whatever they are.
    expect(bytes(trackEntry({ type: 2, extra: [element(ID.Void, [9])] }))).toEqual([
      ...[0xae, 0x86],
      ...[0x83, 0x81, 2],
      ...[0xec, 0x81, 9],
    ])
  })

  it('writes a Video element with its Colour and the Projection that holds the roll, and an Audio element with its floats', () => {
    // 1920 is 0x0780 and 1080 is 0x0438; -90 as a double is 0xC056800000000000.
    expect(
      bytes(
        trackEntry({
          video: { pixelWidth: 1920, pixelHeight: 1080, colour: {}, rollDegrees: -90 },
        }),
      ),
    ).toEqual([
      ...[0xae, 0x9f],
      ...[0xe0, 0x9d],
      ...[0xb0, 0x82, 0x07, 0x80],
      ...[0xba, 0x82, 0x04, 0x38],
      ...[0x55, 0xb0, 0x80],
      ...[0x76, 0x70, 0x8f],
      ...[0x76, 0x71, 0x81, 0],
      ...[0x76, 0x75, 0x88, 0xc0, 0x56, 0x80, 0, 0, 0, 0, 0],
    ])
    // 48000 as a double is 0x40E7700000000000.
    expect(bytes(trackEntry({ audio: { samplingFrequency: 48000, channels: 2 } }))).toEqual([
      ...[0xae, 0x8f],
      ...[0xe1, 0x8d],
      ...[0xb5, 0x88, 0x40, 0xe7, 0x70, 0, 0, 0, 0, 0],
      ...[0x9f, 0x81, 2],
    ])
    // The nine fields of a Colour, each in its own ID.
    expect(
      bytes(
        trackEntry({
          video: {
            colour: {
              matrix: 1,
              primaries: 2,
              transfer: 3,
              range: 4,
              bitsPerChannel: 5,
              chromaSubsamplingHorz: 6,
              chromaSubsamplingVert: 7,
              chromaSitingHorz: 8,
              chromaSitingVert: 9,
            },
          },
        }),
      ),
    ).toEqual([
      ...[0xae, 0xa9],
      ...[0xe0, 0xa7],
      ...[0x55, 0xb0, 0xa4],
      ...[0x55, 0xb1, 0x81, 1],
      ...[0x55, 0xb2, 0x81, 5],
      ...[0x55, 0xb3, 0x81, 6],
      ...[0x55, 0xb4, 0x81, 7],
      ...[0x55, 0xb7, 0x81, 8],
      ...[0x55, 0xb8, 0x81, 9],
      ...[0x55, 0xb9, 0x81, 4],
      ...[0x55, 0xba, 0x81, 3],
      ...[0x55, 0xbb, 0x81, 2],
    ])
  })

  it('writes ContentEncodings, none when it is not given and an empty one when it is given none', () => {
    expect(bytes(trackEntry({ encodings: [] }))).toEqual([0xae, 0x83, 0x6d, 0x80, 0x80])
    // Header stripping: an order, a compression of algorithm 3 with its settings, in an encoding of 16 bytes.
    expect(
      bytes(
        trackEntry({
          encodings: [{ compression: { algo: 3, settings: new Uint8Array([0x0b, 0x77]) } }],
        }),
      ),
    ).toEqual([
      ...[0xae, 0x96],
      ...[0x6d, 0x80, 0x93],
      ...[0x62, 0x40, 0x90],
      ...[0x50, 0x31, 0x81, 0],
      ...[0x50, 0x34, 0x89],
      ...[0x42, 0x54, 0x81, 3],
      ...[0x42, 0x55, 0x82, 0x0b, 0x77],
    ])
    // An empty compression, and a scope, a type and an encryption (of AES, 5).
    expect(
      bytes(trackEntry({ encodings: [{ scope: 2, type: 1, compression: {}, encryption: true }] })),
    ).toEqual([
      ...[0xae, 0x9c],
      ...[0x6d, 0x80, 0x99],
      ...[0x62, 0x40, 0x96],
      ...[0x50, 0x31, 0x81, 0],
      ...[0x50, 0x32, 0x81, 2],
      ...[0x50, 0x33, 0x81, 1],
      ...[0x50, 0x34, 0x80],
      ...[0x50, 0x35, 0x84, 0x47, 0xe1, 0x81, 5],
    ])
  })

  it('writes a BlockAdditionMapping with the type and the extra data it is given', () => {
    expect(
      bytes(
        trackEntry({ blockAdditions: [{ type: 0x64766343, extraData: new Uint8Array([1, 2]) }] }),
      ),
    ).toEqual([
      ...[0xae, 0x8f],
      ...[0x41, 0xe4, 0x8c],
      ...[0x41, 0xe7, 0x84, 0x64, 0x76, 0x63, 0x43],
      ...[0x41, 0xed, 0x82, 1, 2],
    ])
    expect(bytes(trackEntry({ blockAdditions: [{}] }))).toEqual([0xae, 0x83, 0x41, 0xe4, 0x80])
  })

  it('writes the Tracks element around the entries it is given', () => {
    const entry = trackEntry({ number: 1 })
    expect(bytes(tracksElement([entry, entry]))).toEqual([
      ...[0x16, 0x54, 0xae, 0x6b, 0x92],
      ...bytes(entry),
      ...bytes(entry),
    ])
    expect(bytes(tracksElement([]))).toEqual([0x16, 0x54, 0xae, 0x6b, 0x80])
  })
})

describe('the block builder (§10.4)', () => {
  it("writes a signed integer in the fewest whole bytes of two's complement, and at least one", () => {
    expect(bytes(int(0xfb, 0))).toEqual([0xfb, 0x81, 0x00])
    expect(bytes(int(0xfb, 127))).toEqual([0xfb, 0x81, 0x7f])
    expect(bytes(int(0xfb, 128))).toEqual([0xfb, 0x82, 0x00, 0x80])
    expect(bytes(int(0xfb, -1))).toEqual([0xfb, 0x81, 0xff])
    expect(bytes(int(0xfb, -33))).toEqual([0xfb, 0x81, 0xdf])
    expect(bytes(int(0xfb, -128))).toEqual([0xfb, 0x81, 0x80])
    expect(bytes(int(0xfb, -129))).toEqual([0xfb, 0x82, 0xff, 0x7f])
    expect(bytes(int(0xfb, -(2n ** 63n)))).toEqual([0xfb, 0x88, 0x80, 0, 0, 0, 0, 0, 0, 0])
    expect(() => int(0xfb, 2n ** 63n)).toThrow(RangeError)
    expect(() => int(0xfb, 1.5)).toThrow(RangeError)
  })

  it('writes a SimpleBlock as the track number, the timecode, the flags and the frame', () => {
    // Track 1 is the vint 0x81; the timecode -5 is 0xFFFB; the flags 0x80 are the keyframe.
    expect(
      bytes(simpleBlock({ track: 1, timecode: -5, keyframe: true, frames: [[9, 8, 7]] })),
    ).toEqual([0xa3, 0x87, 0x81, 0xff, 0xfb, 0x80, 9, 8, 7])
    expect(bytes(simpleBlock({ track: 1, timecode: 300, frames: [new Uint8Array([9])] }))).toEqual([
      0xa3, 0x85, 0x81, 0x01, 0x2c, 0x00, 9,
    ])
    // Track 200 does not fit the 7 bits of one byte: it is the vint 0x40C8.
    expect(bytes(simpleBlock({ track: 200, timecode: 0, frames: [[9]] }))).toEqual([
      0xa3, 0x86, 0x40, 0xc8, 0x00, 0x00, 0x00, 9,
    ])
  })

  it('writes Xiph lacing as the count less one, then each size but the last as runs of 255 and a last byte', () => {
    const frames = [
      new Uint8Array(300).fill(1),
      new Uint8Array(255).fill(2),
      new Uint8Array(10).fill(3),
    ]
    const block = simpleBlock({ track: 1, timecode: 0, lacing: 'xiph', frames })
    // The element is 9 bytes of head and sizes and 565 of frames: 574 bytes, a size of 2 bytes.
    expect(bytes(block.subarray(0, 3))).toEqual([0xa3, 0x42, 0x3e])
    // The flags say Xiph (0x02); the count is 3 less 1; 300 is 255 and then 45; 255 is 255 and
    // then 0, as a size ends with a byte below 255; the last size is not written.
    expect(bytes(block.subarray(3, 12))).toEqual([0x81, 0x00, 0x00, 0x02, 2, 255, 45, 255, 0])
    expect(block.length).toBe(12 + 565)
    expect(block[12]).toBe(1)
    expect(block[12 + 300]).toBe(2)
    expect(block[12 + 555]).toBe(3)
  })

  it('writes EBML lacing as the first size and then the differences, each in the fewest bytes', () => {
    // RFC 9559 §10.3's sizes: 800 is the vint 0x4320; 500 less 800 is -300, which with the
    // 8191 that a 2-byte difference is offset by is 7891 = 0x1ED3, so 0x5ED3; 1000 less 500 is
    // 500, which is 8691 = 0x21F3, so 0x61F3. The last size (20) is not written.
    const frames = [800, 500, 1000, 20].map((size, index) => new Uint8Array(size).fill(index + 1))
    const block = simpleBlock({ track: 1, timecode: 0, lacing: 'ebml', frames })
    // 11 bytes of head and sizes and 2320 of frames: 2331 = 0x091B, a size of 2 bytes.
    expect(bytes(block.subarray(0, 3))).toEqual([0xa3, 0x49, 0x1b])
    expect(bytes(block.subarray(3, 14))).toEqual([
      ...[0x81, 0x00, 0x00, 0x06, 3],
      ...[0x43, 0x20, 0x5e, 0xd3, 0x61, 0xf3],
    ])
    expect(block.length).toBe(3 + 11 + 2320)

    // Sizes of 100, 90, 95 and 5: the first is 0xE4; the differences -10 and 5 fit one byte,
    // which is offset by 63: 53 is 0xB5 and 68 is 0xC4.
    const small = [100, 90, 95, 5].map((size) => new Uint8Array(size))
    expect(
      bytes(simpleBlock({ track: 1, timecode: 0, lacing: 'ebml', frames: small }).subarray(0, 11)),
    ).toEqual([...[0xa3, 0x41, 0x2a], ...[0x81, 0x00, 0x00, 0x06, 3, 0xe4, 0xb5, 0xc4]])
  })

  it('writes fixed lacing as the count less one and no sizes', () => {
    const frames = [1, 2, 3, 4].map((fill) => new Uint8Array(192).fill(fill))
    const block = simpleBlock({ track: 1, timecode: 0, lacing: 'fixed', frames })
    // 5 bytes of head and 768 of frames: 773 = 0x0305.
    expect(bytes(block.subarray(0, 8))).toEqual([0xa3, 0x43, 0x05, 0x81, 0x00, 0x00, 0x04, 3])
    expect(block.length).toBe(8 + 768)
    expect(block[8]).toBe(1)
    expect(block[8 + 192]).toBe(2)
    expect(block[8 + 768 - 1]).toBe(4)
  })

  it('writes a laced block of one frame as the count 0 and no sizes, in every lacing', () => {
    expect(bytes(simpleBlock({ track: 1, timecode: 0, lacing: 'xiph', frames: [[7]] }))).toEqual([
      0xa3, 0x86, 0x81, 0x00, 0x00, 0x02, 0x00, 7,
    ])
    expect(bytes(simpleBlock({ track: 1, timecode: 0, lacing: 'ebml', frames: [[7]] }))).toEqual([
      0xa3, 0x86, 0x81, 0x00, 0x00, 0x06, 0x00, 7,
    ])
    expect(bytes(simpleBlock({ track: 1, timecode: 0, lacing: 'fixed', frames: [[7]] }))).toEqual([
      0xa3, 0x86, 0x81, 0x00, 0x00, 0x04, 0x00, 7,
    ])
  })

  it('refuses blocks that no file holds', () => {
    // No frame, and two frames with no lacing to tell them apart.
    expect(() => simpleBlock({ track: 1, timecode: 0, frames: [] })).toThrow(RangeError)
    expect(() => simpleBlock({ track: 1, timecode: 0, frames: [[1], [2]] })).toThrow(RangeError)
    // Fixed lacing is of frames of one size; a lace holds at most 256 frames.
    expect(() =>
      simpleBlock({ track: 1, timecode: 0, lacing: 'fixed', frames: [[1], [2, 3]] }),
    ).toThrow(RangeError)
    const many = Array.from({ length: 257 }, () => [1])
    expect(() => simpleBlock({ track: 1, timecode: 0, lacing: 'xiph', frames: many })).toThrow(
      RangeError,
    )
    expect(() => simpleBlock({ track: 1, timecode: 40000, frames: [[1]] })).toThrow(RangeError)
    expect(() => simpleBlock({ track: -1, timecode: 0, frames: [[1]] })).toThrow(RangeError)
  })

  it('writes a BlockGroup as a Block, then the duration and the reference when it is given them', () => {
    // The Block is the track, the timecode, flags of 0 (a keyframe is a BlockGroup with no reference)
    // and the frame.
    expect(bytes(blockGroup({ track: 1, timecode: 0, frames: [[1]] }))).toEqual([
      ...[0xa0, 0x87],
      ...[0xa1, 0x85, 0x81, 0x00, 0x00, 0x00, 1],
    ])
    expect(
      bytes(blockGroup({ track: 1, timecode: 0, duration: 60, reference: -33, frames: [[1]] })),
    ).toEqual([
      ...[0xa0, 0x8d],
      ...[0xa1, 0x85, 0x81, 0x00, 0x00, 0x00, 1],
      ...[0x9b, 0x81, 60],
      ...[0xfb, 0x81, 0xdf],
    ])
    // A reference of 0 is still a reference, and a duration of 0 a duration.
    expect(
      bytes(blockGroup({ track: 1, timecode: 0, duration: 0, reference: 0, frames: [[1]] })),
    ).toEqual([
      ...[0xa0, 0x8d],
      ...[0xa1, 0x85, 0x81, 0x00, 0x00, 0x00, 1],
      ...[0x9b, 0x81, 0],
      ...[0xfb, 0x81, 0],
    ])
    // Its Block is laced as a SimpleBlock is.
    expect(
      bytes(blockGroup({ track: 1, timecode: 0, lacing: 'xiph', frames: [[1], [2, 3]] })),
    ).toEqual([...[0xa0, 0x8b], ...[0xa1, 0x89, 0x81, 0x00, 0x00, 0x02, 1, 1, 1, 2, 3]])
  })
})

describe('the cluster builder (§10.4)', () => {
  it('writes a Cluster as its Timestamp and then the children it is given', () => {
    // The Timestamp 7 is the element E7 81 07; the Cluster's size is the 3 bytes of that and the 3 of the Void.
    expect(bytes(cluster(7, [element(ID.Void, [0])]))).toEqual([
      ...[0x1f, 0x43, 0xb6, 0x75, 0x86],
      ...[0xe7, 0x81, 0x07],
      ...[0xec, 0x81, 0x00],
    ])
    // A Timestamp past one byte is as wide as it needs to be.
    expect(bytes(cluster(300, []))).toEqual([
      ...[0x1f, 0x43, 0xb6, 0x75, 0x84],
      ...[0xe7, 0x82, 0x01, 0x2c],
    ])
  })

  it('writes the size of a live writer as the unknown size, which runs on to what ends it', () => {
    expect(bytes(cluster(7, [], { unknown: true }))).toEqual([
      ...[0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      ...[0xe7, 0x81, 0x07],
    ])
  })

  it('writes the CRC-32 that ffmpeg writes first, over everything that follows it, little-endian', () => {
    const block = simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [[1, 2, 3]] })
    const whole = cluster(5, [block], { crc: true })
    // The Cluster's data is the CRC-32 (6 bytes), the Timestamp (3) and the block (9).
    expect(bytes(whole.subarray(0, 6))).toEqual([0x1f, 0x43, 0xb6, 0x75, 0x80 | 18, 0xbf])
    expect(whole[6]).toBe(0x84)
    const covered = whole.subarray(11)
    expect(bytes(covered)).toEqual([...[0xe7, 0x81, 0x05], ...bytes(block)])
    const sum = crc32(covered)
    expect(bytes(whole.subarray(7, 11))).toEqual([
      sum & 0xff,
      (sum >>> 8) & 0xff,
      (sum >>> 16) & 0xff,
      sum >>> 24,
    ])
  })

  it('refuses a Timestamp that no file holds', () => {
    expect(() => cluster(-1, [])).toThrow(RangeError)
    expect(() => cluster(1.5, [])).toThrow(RangeError)
  })
})

describe('the Cues builder (§10.4)', () => {
  it('writes a CuePoint as the time and then the track, the Cluster and the block it is at', () => {
    // CueTime 5000 is B3 82 13 88 (4 bytes); the CueTrackPositions are the track (F7 81 02, 3 bytes), the Cluster (F1 82 12 34, 4) and the block (F0 81 04, 3), 10 bytes in all, so 12 with their header; the CuePoint's 16 bytes are 18 with theirs.
    expect(bytes(cues([{ time: 5000, track: 2, cluster: 0x1234, relative: 4 }]))).toEqual([
      ...[0x1c, 0x53, 0xbb, 0x6b, 0x80 | 18],
      ...[0xbb, 0x80 | 16],
      ...[0xb3, 0x82, 0x13, 0x88],
      ...[0xb7, 0x80 | 10],
      ...[0xf7, 0x81, 0x02],
      ...[0xf1, 0x82, 0x12, 0x34],
      ...[0xf0, 0x81, 0x04],
    ])
  })

  it('writes track 1 unless it is given another, and no block position unless it is given one', () => {
    expect(bytes(cues([{ time: 0, cluster: 7 }]))).toEqual([
      ...[0x1c, 0x53, 0xbb, 0x6b, 0x80 | 13],
      ...[0xbb, 0x80 | 11],
      ...[0xb3, 0x81, 0x00],
      ...[0xb7, 0x80 | 6],
      ...[0xf7, 0x81, 0x01],
      ...[0xf1, 0x81, 0x07],
    ])
    // No points is an empty Cues element.
    expect(bytes(cues([]))).toEqual([0x1c, 0x53, 0xbb, 0x6b, 0x80])
  })

  it("writes the Cluster's position in the width asked for, so that the element is as long whatever it is", () => {
    const near = cues([{ time: 1, cluster: 3 }], { positionWidth: 8 })
    const far = cues([{ time: 1, cluster: 2 ** 40 }], { positionWidth: 8 })
    expect(near.length).toBe(far.length)
    expect(bytes(near.subarray(near.length - 10))).toEqual([0xf1, 0x88, 0, 0, 0, 0, 0, 0, 0, 3])
    expect(() => cues([{ time: 1, cluster: 256 }], { positionWidth: 1 })).toThrow(RangeError)
  })

  it('writes the CRC-32 first, over everything that follows it, little-endian', () => {
    const plain = cues([
      { time: 5000, cluster: 9 },
      { time: 6000, cluster: 99 },
    ])
    const summed = cues(
      [
        { time: 5000, cluster: 9 },
        { time: 6000, cluster: 99 },
      ],
      { crc: true },
    )
    // The body after the Cues' header (5 bytes, one of them the size).
    const body = plain.subarray(5)
    const sum = crc32(body)
    expect(bytes(summed.subarray(0, 5))).toEqual([0x1c, 0x53, 0xbb, 0x6b, 0x80 | (6 + body.length)])
    expect(bytes(summed.subarray(5, 7))).toEqual([0xbf, 0x84])
    expect(bytes(summed.subarray(7, 11))).toEqual([
      sum & 0xff,
      (sum >>> 8) & 0xff,
      (sum >>> 16) & 0xff,
      sum >>> 24,
    ])
    expect(bytes(summed.subarray(11))).toEqual(bytes(body))
  })

  it('refuses a time or a position that no file holds', () => {
    expect(() => cues([{ time: -1, cluster: 0 }])).toThrow(RangeError)
    expect(() => cues([{ time: 0, cluster: 1.5 }])).toThrow(RangeError)
  })

  it("lets a movie point its Cues at its Clusters, counted from the Segment's data, 8 bytes wide, and names them in the SeekHead", () => {
    const track = { number: 1, type: 1, codecId: 'V_VP9' }
    const made = matroskaMovie({
      scale: 1_000_000,
      seek: true,
      tracks: [track],
      clusters: [
        { timestamp: 0, frames: [{ track: 1, time: 0, keyframe: true }] },
        { timestamp: 1000, frames: [{ track: 1, time: 1000, keyframe: true }] },
      ],
      cuePoints: (at) => [
        { time: 0, cluster: at[0] ?? -1, relative: 4 },
        { time: 1000, cluster: at[1] ?? -1, relative: 4 },
      ],
    })
    const at = made.cues ?? -1
    expect(at).toBe(made.clusters[1]?.end)
    const second = (made.clusters[1]?.start ?? 0) - made.segmentData
    // The second point's Cluster position is its last-but-one field: F1 88 and the 8 bytes, then F0 81 04.
    const end = at + (made.bytes.length - at)
    expect(bytes(made.bytes.subarray(end - 13, end))).toEqual([
      ...[0xf1, 0x88],
      ...[0, 0, 0, 0, 0, 0, second >> 8, second & 0xff],
      ...[0xf0, 0x81, 0x04],
    ])
    // The SeekHead names the Cues where they are.
    const seeks = bytes(made.bytes.subarray(made.segmentData, made.segmentData + 100))
    const cuesPosition = at - made.segmentData
    expect(seeks.join(',')).toContain(
      [
        0x53,
        0xab,
        0x84,
        0x1c,
        0x53,
        0xbb,
        0x6b,
        0x53,
        0xac,
        0x88,
        0,
        0,
        0,
        0,
        0,
        0,
        cuesPosition >> 8,
        cuesPosition & 0xff,
      ].join(','),
    )
  })
})

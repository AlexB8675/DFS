import { describe, expect, it } from 'vitest'
import { ID } from '../matroska/ids.ts'
import type { MatroskaFile } from './ebml.ts'
import {
  binary,
  ebmlHeader,
  element,
  elementSized,
  float,
  idBytes,
  info,
  matroskaFile,
  seekEntry,
  seekHead,
  segment,
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

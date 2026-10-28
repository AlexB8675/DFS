import { describe, expect, it } from 'vitest'
import type { FrameTable } from '../frames.ts'
import { audioSpecificConfig, esds, IDENTITY_MATRIX } from './build.ts'
import { Differences, esdsParts, firstShown, rotationIn, rotationOf, turn } from './compare.ts'

// What the corpus suites share in comparing the reader with ffprobe (DESIGN.md
// §10.4): the differences counted per field, the rotation of a picture, where a
// track first shows anything, and what an `esds` box says of its stream.

describe('Differences', () => {
  it('counts the frames that differ in each field and names the first of them', () => {
    const found = new Differences()
    found.note('size', 0, 10, 10)
    found.note('size', 1, 11, 12)
    found.note('size', 2, 13, 14)
    found.note('pos', 5, 1, 2)
    expect(found.report('picture')).toEqual([
      'picture: size differs in 2 frames, first at frame 1: ours 11, ffprobe 12',
      'picture: pos differs in 1 frames, first at frame 5: ours 1, ffprobe 2',
    ])
  })

  it('takes numbers within a tolerance as the same, and a number that ffprobe does not have as different', () => {
    const found = new Differences()
    found.noteNear('pts', 0, 1.0004, 1, 0.001)
    found.noteNear('pts', 1, 1.002, 1, 0.001)
    found.noteNear('pts', 2, 1, undefined, 0.001)
    expect(found.report('sound')).toEqual([
      'sound: pts differs in 2 frames, first at frame 1: ours 1.002, ffprobe 1',
    ])
  })

  it('says a value that is undefined (a time that ffprobe has none of) as undefined, and does not throw on it', () => {
    const found = new Differences()
    found.noteNear('pts', 3, 1, undefined, 0.001)
    found.note('size', 4, undefined, 12)
    expect(found.report('sound')).toEqual([
      'sound: pts differs in 1 frames, first at frame 3: ours 1, ffprobe undefined',
      'sound: size differs in 1 frames, first at frame 4: ours undefined, ffprobe 12',
    ])
  })

  it('says nothing when nothing differs', () => {
    expect(new Differences().report('picture')).toEqual([])
  })
})

describe('rotation', () => {
  /** A `tkhd` matrix in 16.16 fixed point (and 2.30 for its last column), as the module writes it. */
  const matrix = (values: readonly number[]): Uint8Array => {
    const out = new Uint8Array(36)
    const view = new DataView(out.buffer)
    values.forEach((value, index) => {
      view.setInt32(index * 4, value)
    })
    return out
  }

  it('is 0 for the identity and for a matrix that scales to nothing', () => {
    expect(rotationOf(matrix(IDENTITY_MATRIX))).toBeCloseTo(0, 9)
    expect(rotationOf(new Uint8Array(36))).toBe(0)
  })

  it('reads a quarter turn counter-clockwise as FFmpeg does', () => {
    // a = 0, b = 1, c = -1, d = 0: the matrix of a 90 degree turn.
    expect(rotationOf(matrix([0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]))).toBeCloseTo(
      -90,
      9,
    )
    expect(rotationOf(matrix([0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000]))).toBeCloseTo(90, 9)
  })

  it("takes ffprobe's rotation from the display matrix in the side data, and 0 where there is none", () => {
    expect(
      rotationIn({
        index: 0,
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      }),
    ).toBe(-90)
    expect(rotationIn({ index: 0, side_data_list: [{ side_data_type: 'Other' }] })).toBe(0)
    expect(rotationIn({ index: 0 })).toBe(0)
  })

  it('tells the difference of two angles from -180 to 180', () => {
    expect(turn(90, 90)).toBe(0)
    expect(turn(350, 10)).toBe(-20)
    expect(turn(10, 350)).toBe(20)
    expect(turn(-90, 270)).toBe(0)
  })
})

describe('firstShown', () => {
  /** A table of frames of 1000 ticks a second, decoded at `dts` for `duration` ticks, each presented `cts` after it. */
  const table = (frames: [dts: number, duration: number, cts: number][]): FrameTable => ({
    count: frames.length,
    timescale: 1000,
    offsets: new Float64Array(frames.length),
    sizes: new Uint32Array(frames.length),
    dts: Float64Array.from(frames, ([dts]) => dts),
    durations: Uint32Array.from(frames, ([, duration]) => duration),
    cts: Int32Array.from(frames, ([, , cts]) => cts),
    sync: new Uint8Array(frames.length).fill(1),
  })

  it('is the least presentation time, with the offset applied', () => {
    expect(
      firstShown({
        table: table([
          [0, 33, 67],
          [33, 33, 100],
          [67, 33, 0],
        ]),
        timing: { offsetSeconds: -0.067, endSeconds: null },
      }),
    ).toBeCloseTo(0, 9)
  })

  it('leaves out a frame that ends by 0, which a SourceBuffer drops, and starts a frame that crosses it at 0', () => {
    // An AAC sound with its priming: the first frame is shown from -21 ms to 0, the second from -0.3 ms to 20.7 ms.
    const priming = table([
      [0, 21, 0],
      [21, 21, 0],
    ])
    expect(
      firstShown({ table: priming, timing: { offsetSeconds: -0.021333, endSeconds: null } }),
    ).toBe(0)
  })

  it('is infinite for a track none of whose frames ends after 0', () => {
    expect(
      firstShown({ table: table([[0, 10, 0]]), timing: { offsetSeconds: -1, endSeconds: null } }),
    ).toBe(Infinity)
  })
})

describe('esdsParts', () => {
  it('gives the object type and the DecoderSpecificInfo of an esds, past the buffer size and the bit rates', () => {
    const config = audioSpecificConfig(2)
    const parts = esdsParts(esds({ objectType: 0x40, config }))
    expect(parts?.objectType).toBe(0x40)
    expect(Array.from(parts?.specific ?? [])).toEqual(config)
  })

  it('has no DecoderSpecificInfo for a stream with none, as MP3 has', () => {
    expect(esdsParts(esds({ objectType: 0x6b, config: null }))).toEqual({
      objectType: 0x6b,
      specific: null,
    })
  })

  it('reads lengths of four bytes, and the fields that an ES_Descriptor has by its flags', () => {
    const config = audioSpecificConfig(2, { frequencyIndex: 3, channels: 1 })
    const parts = esdsParts(esds({ config, wide: true, dependsOn: 7, url: 'x', clock: 9 }))
    expect(parts?.objectType).toBe(0x40)
    expect(Array.from(parts?.specific ?? [])).toEqual(config)
  })

  it('is null where the descriptors are not an esds, or are cut short', () => {
    expect(esdsParts(new Uint8Array(0))).toBeNull()
    expect(esdsParts(esds().subarray(0, 14))).toBeNull()
    const wrongTag = Uint8Array.from(esds())
    wrongTag[12] = 0x09
    expect(esdsParts(wrongTag)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { Mp4Error } from '../errors.ts'
import { concat, hvcC, u16 } from '../testing/build.ts'
import { reorderDepth } from './reorder.ts'
import type { MatroskaTrack } from './tracks.ts'

// How far a picture's decode runs ahead of its presentation, as its codec's
// configuration states it (DESIGN.md §10.4, D45), which is what ffprobe reports as
// `has_b_frames`. The configuration records of x264 and x265 are the bytes that
// ffmpeg wrote for generated 320x240 pictures (2026-10-25), with the depth its
// `trace_headers` and ffprobe gave for each; every other input is built in code,
// bit by bit, as ITU-T H.264 §7.3.2.1.1, Annex E.1.1 and ITU-T H.265 §7.3.2.2 lay
// the fields out, so that the expected values come from the standards and not from
// the module.

/** The `avcC` records of x264, as the CodecPrivate of a Matroska file holds them: the high profile with B-frames (`has_b_frames` 2), the high profile with `-bf 0`, and Baseline. */
const X264_B_FRAMES =
  '0164000dffe100196764000dacd94141fb0110000003001000000303c0f142996001000668ebe3cb22c0fdf8f800'
const X264_NO_B_FRAMES =
  '0164000dffe100176764000dacb20283f60220000003002000000781e2854901000668ebc3cb22c0fdf8f800'
const X264_BASELINE =
  '0142c00dffe100186742c00dd90141fb0110000003001000000303c0f142a48001000568cb83cb20'

/** The parameter sets of x265's defaults (`has_b_frames` 2), a NAL unit each, 2 header bytes first. */
const X265_VPS = '40010c01ffff01600000030090000003000003003c959809'
const X265_SPS =
  '42010101600000030090000003000003003ca00a080f165959a4932bc05a020000030002000003003c10'
const X265_PPS = '4401c172b46240'

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

/** Bytes as a view onto a longer array, which is how the reader gives them, so that a read that forgets where a view begins reads the wrong bytes. */
function view(bytes: Uint8Array): Uint8Array {
  return concat([9, 9, 9], bytes, [7, 7]).subarray(3, 3 + bytes.length)
}

/** A track as the reader gives it, of this CodecID and CodecPrivate; reordering is read from the configuration alone, so the rest is what a track that says nothing has. */
function track(codecId: string, codecPrivate: Uint8Array | null): MatroskaTrack {
  return {
    number: 1,
    kind: 'video',
    enabled: true,
    default: true,
    forced: false,
    language: 'eng',
    codecId,
    codecPrivate: codecPrivate === null ? null : view(codecPrivate),
    codecDelay: 0,
    seekPreRoll: 0,
    defaultDuration: null,
    video: null,
    audio: null,
    stripped: new Uint8Array(0),
    blockAdditions: [],
    refusal: null,
    problem: null,
  }
}

const AVC = 'V_MPEG4/ISO/AVC'
const HEVC = 'V_MPEGH/ISO/HEVC'

/** What `run` throws, which must be an `Mp4Error` of the reason 'damaged' and a sentence that reads after "The picture track can't be played: ". */
function damaged(run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe('damaged')
    expect((error as Mp4Error).message).toMatch(/^[a-z]/)
    return error as Mp4Error
  }
  throw new Error('expected an Mp4Error (damaged)')
}

/** A writer of bits, most significant first, with the exp-Golomb codes of H.264 §9.1; its bytes end as an RBSP does (a 1 bit, then 0 bits to the byte) and have the emulation prevention bytes put in. */
class Bits {
  private readonly all: number[] = []

  u(width: number, value: number): this {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      this.all.push(Math.floor(value / 2 ** shift) % 2)
    }
    return this
  }

  flag(on: boolean): this {
    return this.u(1, on ? 1 : 0)
  }

  fill(width: number, bit: 0 | 1): this {
    for (let index = 0; index < width; index += 1) this.all.push(bit)
    return this
  }

  ue(value: number): this {
    const code = value + 1
    let zeros = 0
    while (2 ** (zeros + 1) <= code) zeros += 1
    return this.fill(zeros, 0).u(zeros + 1, code)
  }

  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value)
  }

  bytes(): Uint8Array {
    const padded = [...this.all, 1]
    while (padded.length % 8 !== 0) padded.push(0)
    const out: number[] = []
    let zeros = 0
    for (let at = 0; at < padded.length; at += 8) {
      let byte = 0
      for (let bit = 0; bit < 8; bit += 1) byte = byte * 2 + (padded[at + bit] ?? 0)
      if (zeros >= 2 && byte <= 3) {
        out.push(3)
        zeros = 0
      }
      out.push(byte)
      zeros = byte === 0 ? zeros + 1 : 0
    }
    return Uint8Array.from(out)
  }
}

/** The profiles whose SPS holds the chroma format, bit depths and scaling matrix (H.264 §7.3.2.1.1). */
const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]

interface Vui {
  /** aspect_ratio_idc; 255 is Extended_SAR, which has a width and a height after it. */
  aspect?: number
  overscan?: boolean
  signal?: boolean
  chromaLoc?: boolean
  timing?: boolean
  /** The number of CPBs in the NAL HRD parameters, when it has them. */
  nalHrd?: number
  /** The number of CPBs in the VCL HRD parameters. */
  vclHrd?: number
  picStruct?: boolean
  /** The bitstream restriction, when it has one: max_num_reorder_frames, and max_dec_frame_buffering. */
  restriction?: { reorder: number; buffering?: number }
}

function hrd(w: Bits, cpbs: number): void {
  w.ue(cpbs - 1)
    .u(4, 3)
    .u(4, 7)
  for (let cpb = 0; cpb < cpbs; cpb += 1)
    w.ue(1000 + cpb)
      .ue(2000 + cpb)
      .flag(cpb % 2 === 0)
  w.u(5, 23).u(5, 23).u(5, 23).u(5, 24)
}

function vui(w: Bits, spec: Vui): void {
  w.flag(spec.aspect !== undefined)
  if (spec.aspect !== undefined) {
    w.u(8, spec.aspect)
    if (spec.aspect === 255) w.u(16, 4).u(16, 3)
  }
  w.flag(spec.overscan === true)
  if (spec.overscan === true) w.flag(true)
  w.flag(spec.signal === true)
  if (spec.signal === true) w.u(3, 5).flag(false).flag(true).u(8, 1).u(8, 1).u(8, 1)
  w.flag(spec.chromaLoc === true)
  if (spec.chromaLoc === true) w.ue(1).ue(2)
  w.flag(spec.timing === true)
  // Zero ticks in 32 bits, so that the emulation prevention is put in here.
  if (spec.timing === true) w.u(32, 0).u(32, 50).flag(true)
  w.flag(spec.nalHrd !== undefined)
  if (spec.nalHrd !== undefined) hrd(w, spec.nalHrd)
  w.flag(spec.vclHrd !== undefined)
  if (spec.vclHrd !== undefined) hrd(w, spec.vclHrd)
  if (spec.nalHrd !== undefined || spec.vclHrd !== undefined) w.flag(true) // low_delay_hrd_flag
  w.flag(spec.picStruct === true)
  w.flag(spec.restriction !== undefined)
  if (spec.restriction !== undefined) {
    w.flag(true) // motion_vectors_over_pic_boundaries_flag
    w.ue(2).ue(1).ue(15).ue(15) // the denominators and the longest vectors
    w.ue(spec.restriction.reorder).ue(spec.restriction.buffering ?? spec.restriction.reorder + 1)
  }
}

interface AvcSps {
  profile?: number
  level?: number
  chroma?: number
  /** The scaling lists of a high profile: null for one that is not present, else the delta_scale values it is written with. */
  scaling?: readonly (readonly number[] | null)[]
  pocType?: 0 | 1 | 2
  refs?: number
  /** pic_width_in_mbs, and pic_height_in_map_units. */
  widthMbs?: number
  heightUnits?: number
  frameMbsOnly?: boolean
  cropping?: boolean
  vui?: Vui
}

/** An SPS NAL unit (1 header byte, then the RBSP with its emulation prevention bytes). */
function avcSps({
  profile = 100,
  level = 40,
  chroma = 1,
  scaling,
  pocType = 0,
  refs = 1,
  widthMbs = 20,
  heightUnits = 15,
  frameMbsOnly = true,
  cropping = false,
  vui: vuiSpec,
}: AvcSps = {}): Uint8Array {
  const w = new Bits().u(8, profile).u(8, 0).u(8, level).ue(0)
  if (HIGH_PROFILES.includes(profile)) {
    w.ue(chroma)
    if (chroma === 3) w.flag(false) // separate_colour_plane_flag
    w.ue(0).ue(0).flag(false) // the bit depths, and qpprime_y_zero_transform_bypass_flag
    w.flag(scaling !== undefined)
    scaling?.forEach((list) => {
      w.flag(list !== null)
      list?.forEach((delta) => w.se(delta))
    })
  }
  w.ue(0) // log2_max_frame_num_minus4
  w.ue(pocType)
  if (pocType === 0) w.ue(2)
  if (pocType === 1) w.flag(false).se(-1).se(2).ue(3).se(4).se(-5).se(6)
  w.ue(refs).flag(false) // max_num_ref_frames, and gaps_in_frame_num_value_allowed_flag
  w.ue(widthMbs - 1).ue(heightUnits - 1)
  w.flag(frameMbsOnly)
  if (!frameMbsOnly) w.flag(true)
  w.flag(true) // direct_8x8_inference_flag
  w.flag(cropping)
  if (cropping) w.ue(0).ue(1).ue(0).ue(2)
  w.flag(vuiSpec !== undefined)
  if (vuiSpec !== undefined) vui(w, vuiSpec)
  return concat([0x60 | 7], w.bytes())
}

/** An `avcC` record around these SPS NAL units, and a PPS, as the CodecPrivate holds it. */
function avcRecord(spsList: readonly Uint8Array[]): Uint8Array {
  return concat(
    [1, 100, 0, 40, 0xfc | 3, 0xe0 | spsList.length],
    ...spsList.map((sps) => concat(u16(sps.length), sps)),
    [1],
    u16(4),
    [0x68, 0xeb, 0xe3, 0xcb],
  )
}

/** The reorder depth of an SPS built here, in its `avcC`. */
function avcDepth(spec: AvcSps): number {
  return reorderDepth(track(AVC, avcRecord([avcSps(spec)])))
}

interface HevcSps {
  /** sps_max_sub_layers_minus1. */
  subLayers?: number
  /** For each sub-layer but the highest, whether it has a profile, and whether it has a level. */
  subProfile?: readonly boolean[]
  subLevel?: readonly boolean[]
  chroma?: number
  conformance?: boolean
  /** sps_sub_layer_ordering_info_present_flag; when false only the highest sub-layer's info is written. */
  ordering?: boolean
  /** max_num_reorder_pics for each sub-layer that the ordering info is written for. */
  reorder: readonly number[]
}

/** An SPS NAL unit (2 header bytes, then the RBSP with its emulation prevention bytes). */
function hevcSps({
  subLayers = 0,
  subProfile = [],
  subLevel = [],
  chroma = 1,
  conformance = false,
  ordering = true,
  reorder,
}: HevcSps): Uint8Array {
  const w = new Bits().u(4, 0).u(3, subLayers).flag(true)
  // profile_tier_level: 88 bits of general profile, then the general level.
  w.u(2, 0).flag(false).u(5, 1).u(32, 0x60000000).u(4, 9).fill(43, 0).flag(false).u(8, 93)
  for (let layer = 0; layer < subLayers; layer += 1) {
    w.flag(subProfile[layer] === true).flag(subLevel[layer] === true)
  }
  if (subLayers > 0) for (let layer = subLayers; layer < 8; layer += 1) w.u(2, 0)
  for (let layer = 0; layer < subLayers; layer += 1) {
    if (subProfile[layer] === true) w.fill(88, 1)
    if (subLevel[layer] === true) w.u(8, 0xff)
  }
  w.ue(0).ue(chroma) // sps_seq_parameter_set_id, chroma_format_idc
  if (chroma === 3) w.flag(false)
  w.ue(320).ue(240) // the size in luma samples
  w.flag(conformance)
  if (conformance) w.ue(0).ue(1).ue(0).ue(2)
  w.ue(0).ue(0).ue(4) // the bit depths, log2_max_pic_order_cnt_lsb_minus4
  w.flag(ordering)
  for (const value of reorder)
    w.ue(value + 2)
      .ue(value)
      .ue(0) // max_dec_pic_buffering_minus1, max_num_reorder_pics, max_latency_increase_plus1
  w.ue(3) // log2_min_luma_coding_block_size_minus3: fields that follow the ones read
  return concat([0x42, 0x01], w.bytes())
}

/** An `hvcC` record with these arrays, each of a NAL unit type and the NAL units it holds. */
function hevcRecord(arrays: readonly { type: number; units: readonly Uint8Array[] }[]): Uint8Array {
  return concat(
    hvcC().subarray(8, 8 + 22), // the fields before the number of arrays
    [arrays.length],
    ...arrays.map(({ type, units }) =>
      concat(
        [0x80 | type],
        u16(units.length),
        ...units.map((unit) => concat(u16(unit.length), unit)),
      ),
    ),
  )
}

/** The record of one picture: its VPS, this SPS and a PPS. */
function hevcRecordOf(sps: Uint8Array): Uint8Array {
  return hevcRecord([
    { type: 32, units: [fromHex(X265_VPS)] },
    { type: 33, units: [sps] },
    { type: 34, units: [fromHex(X265_PPS)] },
  ])
}

/** The reorder depth of an SPS built here, in its `hvcC`. */
function hevcDepth(spec: HevcSps): number {
  return reorderDepth(track(HEVC, hevcRecordOf(hevcSps(spec))))
}

describe('the reorder depth of an AVC picture', () => {
  it('is max_num_reorder_frames of the SPS that x264 wrote for a high profile with B-frames, as ffprobe reports has_b_frames', () => {
    expect(reorderDepth(track(AVC, fromHex(X264_B_FRAMES)))).toBe(2)
  })

  it('is 0 for x264 with no B-frames', () => {
    expect(reorderDepth(track(AVC, fromHex(X264_NO_B_FRAMES)))).toBe(0)
  })

  it('is 0 for x264 Baseline', () => {
    expect(reorderDepth(track(AVC, fromHex(X264_BASELINE)))).toBe(0)
  })

  it('reads the first SPS of the record, and no other', () => {
    const first = avcSps({ vui: { restriction: { reorder: 3 } } })
    const second = avcSps({ vui: { restriction: { reorder: 6 } } })
    expect(reorderDepth(track(AVC, avcRecord([first, second])))).toBe(3)
    expect(reorderDepth(track(AVC, avcRecord([second, first])))).toBe(6)
  })

  describe('when the SPS gives it (bitstream_restriction_flag 1)', () => {
    it('is max_num_reorder_frames, whatever the level and the references say', () => {
      for (const reorder of [0, 1, 4, 16]) {
        expect(avcDepth({ vui: { restriction: { reorder } } }), `reorder ${reorder}`).toBe(reorder)
        expect(
          avcDepth({ level: 51, refs: 0, vui: { restriction: { reorder } } }),
          `reorder ${reorder}, no references`,
        ).toBe(reorder)
      }
    })

    it('is read past every field of the VUI that comes before it', () => {
      const everything: Vui = {
        aspect: 255,
        overscan: true,
        signal: true,
        chromaLoc: true,
        timing: true,
        nalHrd: 2,
        vclHrd: 3,
        picStruct: true,
        restriction: { reorder: 5 },
      }
      expect(avcDepth({ vui: everything })).toBe(5)
      // Each field on its own, and its absence, so that no skip is balanced by another that is wrong.
      expect(avcDepth({ vui: { aspect: 1, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { aspect: 255, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { overscan: true, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { signal: true, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { chromaLoc: true, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { timing: true, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { nalHrd: 1, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { vclHrd: 1, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { nalHrd: 4, vclHrd: 1, restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ vui: { picStruct: true, restriction: { reorder: 3 } } })).toBe(3)
    })

    it('is read past the fields of every profile, and of every picture order count type', () => {
      for (const profile of HIGH_PROFILES) {
        expect(
          avcDepth({ profile, vui: { timing: true, restriction: { reorder: 3 } } }),
          `profile ${profile}`,
        ).toBe(3)
        expect(
          avcDepth({ profile, chroma: 3, vui: { restriction: { reorder: 3 } } }),
          `profile ${profile}, 4:4:4`,
        ).toBe(3)
      }
      for (const profile of [66, 77, 88]) {
        expect(
          avcDepth({ profile, vui: { restriction: { reorder: 3 } } }),
          `profile ${profile}`,
        ).toBe(3)
      }
      for (const pocType of [0, 1, 2] as const) {
        expect(avcDepth({ pocType, vui: { restriction: { reorder: 3 } } }), `type ${pocType}`).toBe(
          3,
        )
      }
      expect(avcDepth({ frameMbsOnly: false, vui: { restriction: { reorder: 3 } } })).toBe(3)
      expect(avcDepth({ cropping: true, vui: { restriction: { reorder: 3 } } })).toBe(3)
    })

    it('is read past the scaling lists, those that are skipped and those that end early', () => {
      const flat16 = new Array<number>(16).fill(0)
      const flat64 = new Array<number>(64).fill(0)
      // A list ends when nextScale is 0: -8 from the first lastScale of 8 is such a delta.
      const lists = (kind: 'none' | 'ends' | 'full'): (readonly number[] | null)[] =>
        Array.from({ length: 8 }, (_, index) => {
          if (kind === 'none') return null
          if (kind === 'ends') return index % 2 === 0 ? [-8] : null
          return index < 6 ? flat16 : flat64
        })
      for (const kind of ['none', 'ends', 'full'] as const) {
        expect(avcDepth({ scaling: lists(kind), vui: { restriction: { reorder: 3 } } }), kind).toBe(
          3,
        )
      }
      // A list that has some entries, then ends at a delta that brings nextScale to 0 (8 + 3 - 11): the rest of its entries are not written.
      const endsLate = [...new Array<number>(5).fill(0), 3, -11]
      expect(
        avcDepth({
          scaling: [endsLate, null, flat16, null, null, null, endsLate, flat64],
          vui: { restriction: { reorder: 3 } },
        }),
      ).toBe(3)
      // 4:4:4 has 12 lists.
      expect(
        avcDepth({
          chroma: 3,
          scaling: Array.from({ length: 12 }, (_, index) => (index < 6 ? flat16 : flat64)),
          vui: { restriction: { reorder: 3 } },
        }),
      ).toBe(3)
    })

    it('is read from an SPS of which the emulation prevention bytes are taken out', () => {
      const sps = avcSps({ vui: { timing: true, restriction: { reorder: 3 } } })
      // The 32 zero bits of num_units_in_tick hold a run of zero bytes, which comes out with a 03 in it.
      expect(Array.from(sps).join(',')).toMatch(/(^|,)0,0,3(,|$)/)
      expect(avcDepth({ vui: { timing: true, restriction: { reorder: 3 } } })).toBe(3)
    })

    it('is damaged when it is more than 16', () => {
      const error = damaged(() => avcDepth({ vui: { restriction: { reorder: 17 } } }))
      expect(error.message).toContain('17')
      expect(avcDepth({ vui: { restriction: { reorder: 16 } } })).toBe(16)
    })
  })

  describe('when the SPS leaves it out', () => {
    it('is 0 when it has no reference frames, or the profile is Baseline', () => {
      expect(avcDepth({ refs: 0 })).toBe(0)
      expect(avcDepth({ refs: 0, vui: { timing: true } })).toBe(0)
      expect(avcDepth({ profile: 66 })).toBe(0)
      expect(avcDepth({ profile: 66, level: 40, vui: { timing: true } })).toBe(0)
    })

    it('is the DPB of the level in frames of the picture, at most 15', () => {
      // 320x240 is 300 macroblocks: min(floor(8100 / 300), 15).
      expect(avcDepth({ level: 30, widthMbs: 20, heightUnits: 15 })).toBe(15)
      // 1920x1088 is 8160 macroblocks: floor(32768 / 8160).
      expect(avcDepth({ level: 40, widthMbs: 120, heightUnits: 68 })).toBe(4)
    })

    it('is the same with a VUI that has no bitstream restriction, and for every profile that has references', () => {
      const plain = { level: 40, widthMbs: 120, heightUnits: 68 }
      expect(avcDepth({ ...plain, vui: { timing: true, nalHrd: 1 } })).toBe(4)
      expect(avcDepth({ ...plain, vui: { aspect: 255, signal: true } })).toBe(4)
      expect(avcDepth({ ...plain, profile: 77 })).toBe(4)
      expect(avcDepth({ ...plain, profile: 88 })).toBe(4)
      for (const profile of HIGH_PROFILES) {
        expect(avcDepth({ ...plain, profile }), `profile ${profile}`).toBe(4)
      }
    })

    it('counts the height of a picture that may have fields in frames: its map units are 2 macroblocks high', () => {
      // 34 map units of 32 lines are 1088 lines, 68 macroblocks: 8160 in all, as the frames of a progressive picture are.
      expect(avcDepth({ level: 40, widthMbs: 120, heightUnits: 34, frameMbsOnly: false })).toBe(4)
      // 68 map units are 136 macroblocks: 16320 in all, floor(32768 / 16320).
      expect(avcDepth({ level: 40, widthMbs: 120, heightUnits: 68, frameMbsOnly: false })).toBe(2)
    })

    // The frames that each level holds (MaxDpbMbs of Table A-1 over the macroblocks of the picture) of a picture of 300, 8160 and 32400 macroblocks.
    it.each([
      [10, 1, 0, 0],
      [11, 3, 0, 0],
      [12, 7, 0, 0],
      [13, 7, 0, 0],
      [20, 7, 0, 0],
      [21, 15, 0, 0],
      [22, 15, 0, 0],
      [30, 15, 0, 0],
      [31, 15, 2, 0],
      [32, 15, 2, 0],
      [40, 15, 4, 1],
      [41, 15, 4, 1],
      [42, 15, 4, 1],
      [50, 15, 13, 3],
      [51, 15, 15, 5],
      [52, 15, 15, 5],
    ])('is as the table has it for level_idc %i: %i, %i and %i frames', (level, small, hd, uhd) => {
      expect(avcDepth({ level, widthMbs: 20, heightUnits: 15 }), '320x240').toBe(small)
      expect(avcDepth({ level, widthMbs: 120, heightUnits: 68 }), '1920x1088').toBe(hd)
      expect(avcDepth({ level, widthMbs: 240, heightUnits: 135 }), '3840x2160').toBe(uhd)
    })

    it('is 15 for a level that is not in the table', () => {
      for (const level of [0, 60, 62, 255]) {
        expect(avcDepth({ level, widthMbs: 240, heightUnits: 135 }), `level ${level}`).toBe(15)
      }
    })
  })

  describe('when the record is damaged', () => {
    it('is damaged with no CodecPrivate, or an empty one', () => {
      const error = damaged(() => reorderDepth(track(AVC, null)))
      expect(error.message).toContain('CodecPrivate')
      damaged(() => reorderDepth(track(AVC, new Uint8Array(0))))
    })

    it('is damaged with no SPS', () => {
      const none = concat([1, 100, 0, 40, 0xff, 0xe0], [1], u16(4), [0x68, 1, 2, 3])
      const error = damaged(() => reorderDepth(track(AVC, none)))
      expect(error.message).toContain('SPS')
    })

    it('is damaged when the record is cut short before the end of its first SPS', () => {
      const record = fromHex(X264_B_FRAMES)
      const whole = 6 + 2 + 0x19 // the fields, the length, the SPS
      for (let length = 0; length < whole; length += 1) {
        damaged(() => reorderDepth(track(AVC, record.subarray(0, length))))
      }
    })

    it('is damaged when the first NAL unit is no SPS', () => {
      const pps = fromHex('68ebe3cb22c0')
      damaged(() => reorderDepth(track(AVC, avcRecord([pps]))))
    })

    it('is damaged when the SPS is cut off in its VUI', () => {
      const sps = avcSps({
        vui: { aspect: 255, timing: true, nalHrd: 2, restriction: { reorder: 3 } },
      })
      for (let length = 1; length < sps.length - 3; length += 1) {
        damaged(() => reorderDepth(track(AVC, avcRecord([sps.subarray(0, length)]))))
      }
    })

    it('is damaged when the SPS that x264 wrote is cut off before the end of its VUI', () => {
      const record = fromHex(X264_B_FRAMES)
      // The SPS is bytes 8 to 32 of the record, 25 bytes with the NAL header. Its VUI ends with the bitstream restriction, whose max_num_reorder_frames is whole in the first 24 bytes (the last holds the rest); a cut of fewer ends before it.
      for (let sps = 1; sps <= 23; sps += 1) {
        const cut = concat(
          record.subarray(0, 6),
          u16(sps),
          record.subarray(8, 8 + sps),
          [1],
          u16(1),
          [0x68],
        )
        damaged(() => reorderDepth(track(AVC, cut)))
      }
    })

    it('is damaged when an exp-Golomb code has more than 31 leading zeros', () => {
      // seq_parameter_set_id as 32 zeros and a 1.
      const bytes = new Bits().u(8, 100).u(8, 0).u(8, 40).fill(32, 0).flag(true).bytes()
      damaged(() => reorderDepth(track(AVC, avcRecord([concat([0x67], bytes)]))))
    })

    it('is damaged when a field is past its range', () => {
      damaged(() => avcDepth({ chroma: 4 }))
      damaged(() => avcDepth({ refs: 17 }))
    })
  })
})

describe('the reorder depth of an HEVC picture', () => {
  it('is sps_max_num_reorder_pics of the SPS that x265 wrote with its defaults, as ffprobe reports has_b_frames', () => {
    const record = hevcRecord([
      { type: 32, units: [fromHex(X265_VPS)] },
      { type: 33, units: [fromHex(X265_SPS)] },
      { type: 34, units: [fromHex(X265_PPS)] },
    ])
    expect(reorderDepth(track(HEVC, record))).toBe(2)
  })

  it('is the reorder depth of the first SPS, wherever the arrays put it', () => {
    const one = hevcSps({ reorder: [1] })
    const two = hevcSps({ reorder: [2] })
    const spsFirst = hevcRecord([
      { type: 33, units: [one, two] },
      { type: 32, units: [fromHex(X265_VPS)] },
    ])
    expect(reorderDepth(track(HEVC, spsFirst))).toBe(1)
    // An array of SPSs that holds none comes before one that does.
    const emptyFirst = hevcRecord([
      { type: 32, units: [fromHex(X265_VPS)] },
      { type: 33, units: [] },
      { type: 34, units: [fromHex(X265_PPS)] },
      { type: 33, units: [two, one] },
    ])
    expect(reorderDepth(track(HEVC, emptyFirst))).toBe(2)
  })

  it('is the depth of the highest sub-layer, the last that the ordering info gives', () => {
    expect(hevcDepth({ reorder: [0] })).toBe(0)
    expect(hevcDepth({ reorder: [4] })).toBe(4)
    expect(hevcDepth({ subLayers: 2, reorder: [1, 2, 3] })).toBe(3)
    expect(hevcDepth({ subLayers: 6, reorder: [0, 1, 2, 3, 4, 5, 6] })).toBe(6)
  })

  it('is the one value of the highest sub-layer when the ordering info is given for it alone', () => {
    expect(hevcDepth({ subLayers: 2, ordering: false, reorder: [4] })).toBe(4)
    expect(hevcDepth({ subLayers: 6, ordering: false, reorder: [5] })).toBe(5)
  })

  it('is read past the profiles and levels of the sub-layers below the highest', () => {
    expect(
      hevcDepth({
        subLayers: 3,
        subProfile: [true, false, true],
        subLevel: [false, true, true],
        reorder: [0, 1, 2, 3],
      }),
    ).toBe(3)
    expect(hevcDepth({ subLayers: 1, subProfile: [true], subLevel: [true], reorder: [2, 5] })).toBe(
      5,
    )
    expect(
      hevcDepth({
        subLayers: 2,
        subProfile: [true, true],
        subLevel: [true, true],
        ordering: false,
        reorder: [2],
      }),
    ).toBe(2)
  })

  it('is read past the chroma format, the conformance window and the other fields before the ordering info', () => {
    expect(hevcDepth({ chroma: 3, reorder: [3] })).toBe(3)
    expect(hevcDepth({ chroma: 0, reorder: [3] })).toBe(3)
    expect(hevcDepth({ conformance: true, reorder: [3] })).toBe(3)
    expect(hevcDepth({ chroma: 3, conformance: true, subLayers: 1, reorder: [1, 3] })).toBe(3)
  })

  it('is read from an SPS of which the emulation prevention bytes are taken out', () => {
    // The 43 zero bits and the compatibility flags of the general profile hold a run of zero bytes.
    const sps = hevcSps({ reorder: [3] })
    expect(Array.from(sps).join(',')).toMatch(/(^|,)0,0,3(,|$)/)
    expect(hevcDepth({ reorder: [3] })).toBe(3)
  })

  it('is damaged when it is more than 16', () => {
    damaged(() => hevcDepth({ reorder: [17] }))
    expect(hevcDepth({ reorder: [16] })).toBe(16)
    // The depth is the highest sub-layer's, but the value of every sub-layer has the range.
    damaged(() => hevcDepth({ subLayers: 1, reorder: [20, 2] }))
    damaged(() => hevcDepth({ subLayers: 1, reorder: [2, 17] }))
    expect(hevcDepth({ subLayers: 1, reorder: [16, 2] })).toBe(2)
  })

  it('is damaged when a chroma_format_idc is past its range', () => {
    damaged(() => hevcDepth({ chroma: 4, reorder: [2] }))
  })

  it('is damaged without a CodecPrivate, or with one too short for its arrays', () => {
    damaged(() => reorderDepth(track(HEVC, null)))
    damaged(() => reorderDepth(track(HEVC, new Uint8Array(0))))
    damaged(() => reorderDepth(track(HEVC, new Uint8Array(22))))
  })

  it('is damaged with no SPS in the record', () => {
    const none = hevcRecord([
      { type: 32, units: [fromHex(X265_VPS)] },
      { type: 34, units: [fromHex(X265_PPS)] },
    ])
    const error = damaged(() => reorderDepth(track(HEVC, none)))
    expect(error.message).toContain('SPS')
    damaged(() => reorderDepth(track(HEVC, hevcRecord([]))))
    damaged(() => reorderDepth(track(HEVC, hevcRecord([{ type: 33, units: [] }]))))
  })

  it('is damaged when the first NAL unit of the SPS array is no SPS', () => {
    const pps = fromHex(X265_PPS)
    damaged(() => reorderDepth(track(HEVC, hevcRecord([{ type: 33, units: [pps] }]))))
  })

  it('is damaged when the record is cut short before the end of its SPS', () => {
    const record = hevcRecordOf(fromHex(X265_SPS))
    // The fields, the number of arrays, the VPS array, then the SPS array and its SPS.
    const end = 22 + 1 + (3 + 2 + fromHex(X265_VPS).length) + (3 + 2 + fromHex(X265_SPS).length)
    for (let length = 0; length < end; length += 1) {
      damaged(() => reorderDepth(track(HEVC, record.subarray(0, length))))
    }
  })

  it('is damaged when the SPS is cut off before the ordering info', () => {
    const sps = hevcSps({
      subLayers: 2,
      subProfile: [true, true],
      subLevel: [true, true],
      reorder: [1, 2, 3],
    })
    for (let length = 1; length < sps.length - 3; length += 1) {
      damaged(() => reorderDepth(track(HEVC, hevcRecordOf(sps.subarray(0, length)))))
    }
  })

  it('is damaged when the SPS says it has 8 sub-layers, a value that is reserved', () => {
    damaged(() => hevcDepth({ subLayers: 7, reorder: [0, 1, 2, 3, 4, 5, 6, 7] }))
  })

  it('is damaged when an exp-Golomb code has more than 31 leading zeros', () => {
    // sps_seq_parameter_set_id as 32 zeros and a 1, after the profile, tier and level.
    const w = new Bits().u(4, 0).u(3, 0).flag(true)
    w.u(2, 0).flag(false).u(5, 1).u(32, 0x60000000).u(4, 9).fill(43, 0).flag(false).u(8, 93)
    w.fill(32, 0).flag(true)
    const sps = concat([0x42, 0x01], w.bytes())
    damaged(() => reorderDepth(track(HEVC, hevcRecordOf(sps))))
  })
})

describe('the reorder depth of other pictures', () => {
  it('is 0 for AV1 and VP9, whatever their CodecPrivate holds', () => {
    for (const codecId of ['V_AV1', 'V_VP9']) {
      expect(reorderDepth(track(codecId, null)), codecId).toBe(0)
      expect(reorderDepth(track(codecId, new Uint8Array(0))), codecId).toBe(0)
      expect(reorderDepth(track(codecId, Uint8Array.of(0x81, 0x04, 0x0c, 0x00))), codecId).toBe(0)
      expect(reorderDepth(track(codecId, fromHex(X264_B_FRAMES))), codecId).toBe(0)
    }
  })

  it('is 0 for a codec that is refused elsewhere', () => {
    expect(reorderDepth(track('V_VP8', null))).toBe(0)
    expect(reorderDepth(track('V_MPEG4/ISO/ASP', fromHex(X264_B_FRAMES)))).toBe(0)
    expect(reorderDepth(track('V_UNKNOWN', null))).toBe(0)
  })
})

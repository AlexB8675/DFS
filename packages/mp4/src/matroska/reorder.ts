import { Mp4Error } from '../errors.ts'
import type { MatroskaTrack } from './tracks.ts'

// How far a picture's decode runs ahead of its presentation (DESIGN.md §10.4, D45),
// which is what ffprobe reports as `has_b_frames`. Matroska keeps only the times a
// frame is presented at, and an MP4 fragment wants the times it is decoded at, so
// the timing of a track delays its sorted presentation times by this many frames.
// It is read from the codec's own configuration, in the CodecPrivate, as ffmpeg
// reads it, and not measured from the frames: a measure can fall short later in a
// film than where it was taken, and a frame that is given no decode duration
// stalls Media Source. AVC and HEVC state it in their first sequence parameter set
// (SPS); AV1 and VP9 have no frames that are decoded out of order in this sense,
// so theirs is 0. An H.264 SPS may leave it out, and then the depth is the most
// that an H.264 decoder holds back, 15: a depth too small stalls Media Source, one
// too large only delays the decode times, and the level of a stream is no sure
// bound on how far it reorders. `stated` says which of the two a depth is, for the
// checks that hold only where the configuration gives the depth. A configuration
// that can't be read is `damaged`, with a sentence that reads after "The picture
// track can't be played: ".

/** A picture's reorder depth, and whether its configuration states it (`stated`) or it is the most the codec can hold back (an H.264 SPS that leaves it out). */
export interface ReorderDepth {
  depth: number
  stated: boolean
}

/** The most that a picture's reorder depth can be: no codec's DPB holds more than 16 frames, and a depth past it is a field that was read wrong. */
const MAX_DEPTH = 16

/** The NAL unit types of an SPS: in H.264 (ITU-T H.264 Table 7-1) and in H.265 (ITU-T H.265 Table 7-1). */
const AVC_SPS = 7
const HEVC_SPS = 33

/** The offset of the number of SPSs in an `avcC` record, after the version, the profile, its compatibility flags, the level and the length of a NAL unit's length (ISO/IEC 14496-15); the first SPS follows it. */
const AVC_SETS = 5

/** The offset of the number of arrays in an `hvcC` record, after the 22 bytes of fields before it (ISO/IEC 14496-15), as in pictures.ts. */
const HEVC_ARRAYS = 22

/** The most reference frames an H.264 SPS can state (ITU-T H.264 §7.4.2.1.1), and the most in the cycle of a picture order count of type 1. */
const MAX_REFERENCE_FRAMES = 16
const MAX_POC_CYCLE = 255

/** The most CPBs an HRD can have (ITU-T H.264 Annex E.2.2, `cpb_cnt_minus1` of 0 to 31). */
const MAX_CPB = 32

/** The profiles whose SPS holds the chroma format, the bit depths and the scaling matrix before the rest (ITU-T H.264 §7.3.2.1.1). */
const HIGH_PROFILES: ReadonlySet<number> = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
])

/** Baseline: it has no B-frames, so a stream that states nothing of its reordering has none (the same holds for a stream with no reference frames). */
const BASELINE_PROFILE = 66

/** The most leading zeros that an exp-Golomb code can have (ITU-T H.264 §9.1): with 31 the value is 2^32 - 2 at most, the most that 32 bits hold. */
const MAX_ZEROS = 31

/** The most frames an H.264 decoder holds back, which is the depth of an SPS that states none: ffmpeg's `MAX_DELAYED_PIC_COUNT` (16) less one. */
const UNSTATED_DEPTH = 15

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** The bits of an RBSP, from its first, as ITU-T H.264 §7.2 and §9.1 read them. */
interface BitReader {
  /** The next `count` bits (at most 32) as a number. */
  bits: (count: number) => number
  /** Past the next `count` bits. */
  skip: (count: number) => void
  /** The next bit, as whether it is set. */
  flag: () => boolean
  /** An unsigned exp-Golomb code, ue(v). */
  ue: () => number
  /** A signed exp-Golomb code, se(v). */
  se: () => number
}

/** The bytes of a NAL unit's payload with its emulation prevention bytes taken out: every 03 that follows 00 00 (ITU-T H.264 §7.4.1). */
function rbspOf(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length)
  let length = 0
  let zeros = 0
  for (const byte of payload) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    out[length] = byte
    length += 1
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, length)
}

/**
 * A reader of the bits of `rbsp`. Reading past the end of it, and an exp-Golomb
 * code of more than 31 leading zeros, throw `damaged` with `what` (the SPS that is
 * read, as the sentence names it) in the sentence. The values are built by
 * multiplying, so that a code of 31 leading zeros is not cut to 32 bits.
 */
function bitReader(rbsp: Uint8Array, what: string): BitReader {
  const total = rbsp.length * 8
  let position = 0

  const skip = (count: number): void => {
    if (position + count > total) {
      throw damaged(`${what} ends before it states the picture's reorder depth.`)
    }
    position += count
  }
  const bits = (count: number): number => {
    skip(count)
    let value = 0
    for (let at = position - count; at < position; at += 1) {
      value = value * 2 + (((rbsp[at >> 3] ?? 0) >> (7 - (at & 7))) & 1)
    }
    return value
  }
  const ue = (): number => {
    let zeros = 0
    while (bits(1) === 0) {
      zeros += 1
      if (zeros > MAX_ZEROS) {
        throw damaged(`${what} has an exp-Golomb code of more than ${MAX_ZEROS} leading zeros.`)
      }
    }
    return 2 ** zeros - 1 + bits(zeros)
  }
  const se = (): number => {
    const code = ue()
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2)
  }
  return { bits, skip, flag: () => bits(1) === 1, ue, se }
}

/** A depth that is past what a picture buffer can hold is damage. */
function checked(depth: number, what: string): number {
  if (depth > MAX_DEPTH) {
    throw damaged(
      `${what} states a reorder depth of ${depth}, which is more than the ${MAX_DEPTH} frames that a picture buffer holds.`,
    )
  }
  return depth
}

/** The scaling lists of an H.264 SPS, which are only skipped: a list of 16 or 64 entries, each a delta_scale (ITU-T H.264 §7.3.2.1.1.1) until the scale that the deltas reach is 0, which ends the list there. */
function skipScalingLists(r: BitReader, chromaFormat: number): void {
  const lists = chromaFormat === 3 ? 12 : 8
  for (let list = 0; list < lists; list += 1) {
    if (!r.flag()) continue
    const size = list < 6 ? 16 : 64
    let last = 8
    let next = 8
    for (let entry = 0; entry < size && next !== 0; entry += 1) {
      // A delta wraps in 8 bits, as ffmpeg's does.
      next = (((last + r.se()) % 256) + 256) % 256
      if (next !== 0) last = next
    }
  }
}

/** The HRD parameters of a VUI (ITU-T H.264 Annex E.1.2), which are only skipped. */
function skipHrd(r: BitReader, what: string): void {
  const cpbs = r.ue() + 1
  if (cpbs > MAX_CPB) {
    throw damaged(`${what} has ${cpbs} CPBs in its HRD parameters, where 32 are the most.`)
  }
  r.skip(8) // bit_rate_scale, cpb_size_scale
  for (let cpb = 0; cpb < cpbs; cpb += 1) {
    r.ue() // bit_rate_value_minus1
    r.ue() // cpb_size_value_minus1
    r.skip(1) // cbr_flag
  }
  r.skip(20) // the lengths of the delays and of the time offset
}

/**
 * The reorder depth that the first SPS of an `avcC` gives (ITU-T H.264
 * §7.3.2.1.1 and Annex E.1.1): `max_num_reorder_frames` of its VUI's bitstream
 * restriction, which is stated. An SPS with no restriction (no VUI, or the flag
 * 0) states none: the depth is then 0 for a stream with no reference frames or of
 * the Baseline profile, which has no B-frames, and for any other 15, the most that
 * an H.264 decoder holds back, and neither is stated. The level and the size of
 * the picture are not used to bound it: the level a stream is labelled with can
 * be too low for how it is coded, and a count of frames from it falls short then,
 * where a depth that is too large only delays the decode times.
 */
function avcDepth(config: Uint8Array): ReorderDepth {
  const whole = `the sequence parameter set in its 'avcC' record`
  if (config.length < AVC_SETS + 1) {
    throw damaged(
      `the 'avcC' record in its CodecPrivate holds ${config.length} bytes, which are too few for the sequence parameter sets that it says it has.`,
    )
  }
  if (((config[AVC_SETS] ?? 0) & 0x1f) === 0) {
    throw damaged(
      `the 'avcC' record in its CodecPrivate holds no SPS, so it can't state a reorder depth.`,
    )
  }
  const at = AVC_SETS + 1
  if (at + 2 > config.length) {
    throw damaged(`the 'avcC' record in its CodecPrivate is cut short before its first SPS.`)
  }
  const length = ((config[at] ?? 0) << 8) | (config[at + 1] ?? 0)
  const nal = config.subarray(at + 2, at + 2 + length)
  if (nal.length < length) {
    throw damaged(
      `the first SPS in the 'avcC' record of its CodecPrivate is ${length} bytes long, and the record is cut short before its end.`,
    )
  }
  if (((nal[0] ?? 0) & 0x1f) !== AVC_SPS) {
    throw damaged(`the first NAL unit in the 'avcC' record of its CodecPrivate is no SPS.`)
  }

  const r = bitReader(rbspOf(nal.subarray(1)), whole)
  const profile = r.bits(8)
  r.skip(8) // the constraint flags and the reserved bits
  r.skip(8) // level_idc
  r.ue() // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chromaFormat = r.ue()
    if (chromaFormat > 3) throw damaged(`${whole} has a chroma_format_idc of ${chromaFormat}.`)
    if (chromaFormat === 3) r.skip(1) // separate_colour_plane_flag
    r.ue() // bit_depth_luma_minus8
    r.ue() // bit_depth_chroma_minus8
    r.skip(1) // qpprime_y_zero_transform_bypass_flag
    if (r.flag()) skipScalingLists(r, chromaFormat)
  }
  r.ue() // log2_max_frame_num_minus4
  const pocType = r.ue()
  if (pocType === 0) {
    r.ue() // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.skip(1) // delta_pic_order_always_zero_flag
    r.se() // offset_for_non_ref_pic
    r.se() // offset_for_top_to_bottom_field
    const cycle = r.ue()
    if (cycle > MAX_POC_CYCLE) {
      throw damaged(
        `${whole} has ${cycle} frames in its picture order count cycle, where ${MAX_POC_CYCLE} are the most.`,
      )
    }
    for (let frame = 0; frame < cycle; frame += 1) r.se() // offset_for_ref_frame
  } else if (pocType !== 2) {
    throw damaged(`${whole} has a pic_order_cnt_type of ${pocType}.`)
  }
  const references = r.ue() // max_num_ref_frames
  if (references > MAX_REFERENCE_FRAMES) {
    throw damaged(
      `${whole} says it has ${references} reference frames, where ${MAX_REFERENCE_FRAMES} are the most.`,
    )
  }
  r.skip(1) // gaps_in_frame_num_value_allowed_flag
  r.ue() // pic_width_in_mbs_minus1
  r.ue() // pic_height_in_map_units_minus1
  if (!r.flag()) r.skip(1) // frame_mbs_only_flag, then mb_adaptive_frame_field_flag
  r.skip(1) // direct_8x8_inference_flag
  if (r.flag()) {
    // frame_cropping_flag: the offsets of the left, right, top and bottom.
    for (let side = 0; side < 4; side += 1) r.ue()
  }

  if (r.flag()) {
    // vui_parameters_present_flag: the VUI, to its bitstream restriction.
    if (r.flag() && r.bits(8) === 255) r.skip(32) // aspect_ratio_info_present_flag, aspect_ratio_idc, and the sample aspect ratio of Extended_SAR
    if (r.flag()) r.skip(1) // overscan_info_present_flag, overscan_appropriate_flag
    if (r.flag()) {
      // video_signal_type_present_flag: the format and range, then the colour description when it has one.
      r.skip(4)
      if (r.flag()) r.skip(24)
    }
    if (r.flag()) {
      // chroma_loc_info_present_flag
      r.ue()
      r.ue()
    }
    if (r.flag()) r.skip(65) // timing_info_present_flag: the ticks, the time scale and the fixed frame rate flag
    const nalHrd = r.flag() // nal_hrd_parameters_present_flag
    if (nalHrd) skipHrd(r, whole)
    const vclHrd = r.flag() // vcl_hrd_parameters_present_flag
    if (vclHrd) skipHrd(r, whole)
    if (nalHrd || vclHrd) r.skip(1) // low_delay_hrd_flag
    r.skip(1) // pic_struct_present_flag
    if (r.flag()) {
      // bitstream_restriction_flag: the depth is stated.
      r.skip(1) // motion_vectors_over_pic_boundaries_flag
      for (let field = 0; field < 4; field += 1) r.ue() // the denominators and the longest vectors
      return { depth: checked(r.ue(), whole), stated: true }
    }
  }

  if (references === 0 || profile === BASELINE_PROFILE) return { depth: 0, stated: false }
  return { depth: UNSTATED_DEPTH, stated: false }
}

/**
 * The reorder depth that the first SPS (NAL unit type 33) of an `hvcC` states
 * (ITU-T H.265 §7.3.2.2 and §7.3.3): `sps_max_num_reorder_pics` of the highest
 * sub-layer, which is the last that the sub-layer ordering info gives. It is read
 * through the profile, tier and level, whose fields for the sub-layers below the
 * highest are 88 bits for a profile and 8 for a level, and through the picture's
 * size, bit depths and picture order count, none of which it needs.
 */
function hevcDepth(config: Uint8Array): ReorderDepth {
  const cut = () =>
    damaged(
      `the 'hvcC' record in its CodecPrivate holds ${config.length} bytes, which are too few for the arrays of parameter sets that it says it has.`,
    )
  if (config.length <= HEVC_ARRAYS) throw cut()
  const view = new DataView(config.buffer, config.byteOffset, config.length)
  const arrays = view.getUint8(HEVC_ARRAYS)
  let at = HEVC_ARRAYS + 1
  let nal: Uint8Array | null = null
  for (let array = 0; array < arrays && nal === null; array += 1) {
    if (at + 3 > config.length) throw cut()
    const type = view.getUint8(at) & 0x3f
    const units = view.getUint16(at + 1)
    at += 3
    for (let unit = 0; unit < units; unit += 1) {
      if (at + 2 > config.length) throw cut()
      const length = view.getUint16(at)
      at += 2
      if (at + length > config.length) throw cut()
      if (type === HEVC_SPS && nal === null) nal = config.subarray(at, at + length)
      at += length
    }
  }
  if (nal === null) {
    throw damaged(
      `the 'hvcC' record in its CodecPrivate holds no SPS, so it can't state a reorder depth.`,
    )
  }
  if (nal.length < 2 || (((nal[0] ?? 0) >> 1) & 0x3f) !== HEVC_SPS) {
    throw damaged(
      `the first NAL unit in the SPS array of the 'hvcC' record of its CodecPrivate is no SPS.`,
    )
  }

  const whole = `the sequence parameter set in its 'hvcC' record`
  const r = bitReader(rbspOf(nal.subarray(2)), whole)
  r.skip(4) // sps_video_parameter_set_id
  const subLayers = r.bits(3) // sps_max_sub_layers_minus1
  if (subLayers > 6)
    throw damaged(`${whole} says it has ${subLayers + 1} sub-layers, where 7 are the most.`)
  r.skip(1) // sps_temporal_id_nesting_flag
  // profile_tier_level: the general profile (88 bits) and level (8), then which sub-layers have a profile and a level of their own.
  r.skip(96)
  const hasProfile: boolean[] = []
  const hasLevel: boolean[] = []
  for (let layer = 0; layer < subLayers; layer += 1) {
    hasProfile.push(r.flag())
    hasLevel.push(r.flag())
  }
  if (subLayers > 0) r.skip(2 * (8 - subLayers)) // reserved_zero_2bits, up to 8 sub-layers
  for (let layer = 0; layer < subLayers; layer += 1) {
    if (hasProfile[layer] === true) r.skip(88)
    if (hasLevel[layer] === true) r.skip(8)
  }
  r.ue() // sps_seq_parameter_set_id
  const chromaFormat = r.ue()
  if (chromaFormat > 3) throw damaged(`${whole} has a chroma_format_idc of ${chromaFormat}.`)
  if (chromaFormat === 3) r.skip(1) // separate_colour_plane_flag
  r.ue() // pic_width_in_luma_samples
  r.ue() // pic_height_in_luma_samples
  if (r.flag()) {
    // conformance_window_flag: the offsets of the left, right, top and bottom.
    for (let side = 0; side < 4; side += 1) r.ue()
  }
  r.ue() // bit_depth_luma_minus8
  r.ue() // bit_depth_chroma_minus8
  r.ue() // log2_max_pic_order_cnt_lsb_minus4
  const ordering = r.flag() // sps_sub_layer_ordering_info_present_flag
  let depth = 0
  for (let layer = ordering ? 0 : subLayers; layer <= subLayers; layer += 1) {
    r.ue() // sps_max_dec_pic_buffering_minus1
    depth = checked(r.ue(), whole) // sps_max_num_reorder_pics
    r.ue() // sps_max_latency_increase_plus1
  }
  return { depth, stated: true }
}

/** The CodecPrivate of a track: a track that has none (or an empty one) can't state its reorder depth. */
function privateOf(track: MatroskaTrack): Uint8Array {
  if (track.codecPrivate === null || track.codecPrivate.length === 0) {
    throw damaged(
      `it has no CodecPrivate, which holds the configuration that a ${track.codecId} picture states its reorder depth in.`,
    )
  }
  return track.codecPrivate
}

/**
 * How many frames a picture's decode runs ahead of its presentation, as its
 * codec's configuration gives it, and whether the configuration states it.
 * AVC and HEVC are read from the first SPS of the CodecPrivate (`avcDepth`,
 * `hevcDepth`): an HEVC SPS always states it, and an H.264 SPS does when it has a
 * bitstream restriction, else the depth is 15 (0 for a stream with no reference
 * frames, or of the Baseline profile) and not stated. AV1 and VP9 are 0 and
 * stated whatever their CodecPrivate holds, as they don't reorder; so is any
 * other CodecID, which is refused elsewhere. An SPS that is missing or can't be
 * read, or states a value past its field's range, is `damaged`.
 */
export function reorderDepth(track: MatroskaTrack): ReorderDepth {
  switch (track.codecId) {
    case 'V_MPEG4/ISO/AVC':
      return avcDepth(privateOf(track))
    case 'V_MPEGH/ISO/HEVC':
      return hevcDepth(privateOf(track))
    default:
      return { depth: 0, stated: true }
  }
}

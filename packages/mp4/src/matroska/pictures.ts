import { Mp4Error } from '../errors.ts'
import type { MatroskaColour, MatroskaTrack, MatroskaVideo } from './tracks.ts'

// The sample entry that a Matroska picture track stands for (DESIGN.md §10.4,
// D45): the `stsd` entry that `codecNames` names and the writer carries as it is,
// so that a Matroska file plays through the same init segments as an MP4. Matroska
// keeps a codec's configuration in its CodecPrivate, which for AVC, HEVC and AV1
// is exactly the body of the MP4 box (`avcC`, `hvcC`, `av1C`); VP9 has none that
// ffmpeg writes in WebM, so its `vpcC` is made from what the track says of itself
// and from the header of its first keyframe. Dolby Vision's configuration record
// is a BlockAdditionMapping of the track, and goes in the entry as MP4 puts it. A
// codec that no browser plays as MP4 is refused as `unsupported-codec` with its
// CodecID in the sentence, and a track that lacks what its entry is made of is
// `damaged`; each sentence reads after "The picture track can't be played: " (see
// `choose.ts`), so it begins in lowercase and says what the track is.

/** The 8 bytes of a box header, and the 78 that a VisualSampleEntry holds before its child boxes (ISO/IEC 14496-12), as `VISUAL_FIELDS` has them in codecs.ts. */
const BOX_HEADER = 8
const VISUAL_FIELDS = 78

/** The most that a picture entry's width or height can be, as it has 16 bits for each; and that of a size in `tkhd`, which has 16 bits for its whole part. */
const MAX_SIZE = 0xffff

/** The BlockAddIDType of each Dolby Vision configuration record, which is the type of the MP4 box that holds it, as a number: `dvcC`, `dvvC` and `dvwC`. */
const DOLBY_VISION_TYPES: ReadonlySet<number> = new Set([0x64766343, 0x64767643, 0x64767743])

/** The least that a Dolby Vision record holds for its profile (byte 2) and its compatibility ID (byte 4) to be in it. */
const DOLBY_VISION_RECORD = 5

/** The Dolby Vision profile that has no base layer a player without Dolby Vision could play, whatever the compatibility ID says. */
const DOLBY_VISION_PROFILE_5 = 5

/** The offset of the number of arrays in an `hvcC` record, after the 22 bytes of fields before it (ISO/IEC 14496-15). */
const HEVC_ARRAYS = 22

/** The NAL unit types of a VPS, an SPS and a PPS, the parameter sets that an `hvc1` entry holds. */
const HEVC_PARAMETER_SETS: readonly number[] = [32, 33, 34]

/** What a track's colour codes are in `vpcC` when the file gives none: unspecified (ITU-T H.273). */
const UNSPECIFIED = 2

/** The matrix of ISO/IEC 14496-12: a, b and u, c, d and v, x, y and w, a to d and x, y in 16.16 and u, v and w in 2.30. */
const IDENTITY_MATRIX: readonly number[] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]

/** The matrices for the quarter turns, as ffprobe reads them in an MP4's `tkhd` and in a Matroska file's ProjectionPoseRoll alike: [cos R, -sin R, 0, sin R, cos R, 0, 0, 0, 1] for a roll R. */
const ROTATIONS: ReadonlyMap<number, readonly number[]> = new Map([
  [90, [0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000]],
  [180, [-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000]],
  [270, [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]],
])

/**
 * The levels of VP9 (Annex A of the VP9 bitstream specification): the largest
 * picture in luma samples that each takes, and the most luma samples per second.
 * The third limit that the table has, on the width or height, is left out, as
 * ffmpeg's `get_vp9_level` (libavformat/vpcc.c) leaves it out, so that the level
 * of a track is the one that ffmpeg gives the same stream.
 */
const VP9_LEVELS: readonly (readonly [level: number, pictureSize: number, sampleRate: number])[] = [
  [10, 36864, 829440],
  [11, 73728, 2764800],
  [20, 122880, 4608000],
  [21, 245760, 9216000],
  [30, 552960, 20736000],
  [31, 983040, 36864000],
  [40, 2228224, 83558400],
  [41, 2228224, 160432128],
  [50, 8912896, 311951360],
  [51, 8912896, 588251136],
  [52, 8912896, 1176502272],
  [60, 35651584, 1176502272],
  [61, 35651584, 2353004544],
  [62, 35651584, 4706009088],
]

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

function unsupported(message: string): Mp4Error {
  return new Mp4Error('unsupported-codec', message)
}

/** The four characters of a four-character code held as a number, as a BlockAddIDType holds a box type. */
function fourcc(code: number): string {
  return String.fromCharCode(
    (code >>> 24) & 0xff,
    (code >>> 16) & 0xff,
    (code >>> 8) & 0xff,
    code & 0xff,
  )
}

/** The parts one after the other, as new bytes. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A box of this type around the bytes, which are copied. */
function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(BOX_HEADER + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(body, BOX_HEADER)
  return out
}

/** A picture's sample entry (ISO/IEC 14496-12): the 8 bytes every entry has, the fields of a VisualSampleEntry, then its child boxes. */
function visualEntry(type: string, video: MatroskaVideo, boxes: readonly Uint8Array[]): Uint8Array {
  if (video.pixelWidth > MAX_SIZE || video.pixelHeight > MAX_SIZE) {
    throw unsupported(
      `its size, ${video.pixelWidth} by ${video.pixelHeight}, is more than the 16 bits for each side that a picture entry has.`,
    )
  }
  const children = concat(boxes)
  const out = new Uint8Array(BOX_HEADER + VISUAL_FIELDS + children.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  // The 6 reserved bytes after the type are 0.
  view.setUint16(14, 1) // the data reference index: the one `dref` of an init segment
  // The 16 bytes of pre-defined and reserved fields are 0.
  view.setUint16(32, video.pixelWidth)
  view.setUint16(34, video.pixelHeight)
  view.setUint32(36, 0x00480000) // the horizontal resolution, 72 dpi
  view.setUint32(40, 0x00480000) // the vertical resolution
  // 4 reserved bytes.
  view.setUint16(48, 1) // the frame count
  // The 32 bytes of the compressor name are 0.
  view.setUint16(82, 0x0018) // the depth
  view.setUint16(84, 0xffff) // pre-defined
  out.set(children, BOX_HEADER + VISUAL_FIELDS)
  return out
}

/** The CodecPrivate of a track, which for AVC, HEVC and AV1 is the body of the box `boxType`; a track that has none (or an empty one) is damaged. */
function record(track: MatroskaTrack, boxType: string): Uint8Array {
  if (track.codecPrivate === null || track.codecPrivate.length === 0) {
    throw damaged(
      `it has no CodecPrivate, which holds the '${boxType}' box that a ${track.codecId} picture is played from.`,
    )
  }
  return track.codecPrivate
}

/**
 * The entry type for an `hvcC` record, and the record to write (DESIGN.md §10.4).
 * The arrays follow the 22 bytes of fields, each a byte (array_completeness in
 * bit 7, its NAL unit type in the low 6 bits), the number of its units (16 bits)
 * and the units, each of 16 bits for its length and its bytes. A record cut short
 * is damaged, and is checked in one walk, before anything is changed.
 *
 * If the record holds an array of each of the parameter sets, a VPS, an SPS and a
 * PPS (types 32 to 34), with a unit in it, the entry is `hvc1`, which keeps them
 * in the entry alone; if not it is `hev1`, which may carry them in the frames and
 * whose record is written as it was given. ISO/IEC 14496-15 makes
 * array_completeness 1 for the parameter-set arrays of an `hvc1` entry (as ffmpeg's
 * muxer writes it, and Safari wants), whatever a Matroska writer's CodecPrivate
 * said, so those arrays are marked complete in a copy; every other array (an SEI,
 * say) keeps the bit it was given.
 */
function hevcConfig(config: Uint8Array): { type: 'hvc1' | 'hev1'; record: Uint8Array } {
  const cut = () =>
    damaged(
      `the 'hvcC' record in its CodecPrivate holds ${config.length} bytes, which are too few for the arrays of parameter sets that it says it has.`,
    )
  if (config.length <= HEVC_ARRAYS) throw cut()
  const view = new DataView(config.buffer, config.byteOffset, config.length)
  const arrays = view.getUint8(HEVC_ARRAYS)
  const found = new Set<number>()
  const headers: number[] = []
  let at = HEVC_ARRAYS + 1
  for (let array = 0; array < arrays; array += 1) {
    if (at + 3 > config.length) throw cut()
    const type = view.getUint8(at) & 0x3f
    const units = view.getUint16(at + 1)
    if (HEVC_PARAMETER_SETS.includes(type)) headers.push(at)
    at += 3
    for (let unit = 0; unit < units; unit += 1) {
      if (at + 2 > config.length) throw cut()
      at += 2 + view.getUint16(at)
      if (at > config.length) throw cut()
    }
    if (units > 0) found.add(type)
  }
  if (!HEVC_PARAMETER_SETS.every((type) => found.has(type))) return { type: 'hev1', record: config }
  const record = config.slice()
  for (const header of headers) record[header] = (record[header] ?? 0) | 0x80
  return { type: 'hvc1', record }
}

/** What the first keyframe of a VP9 stream says of its colour configuration. */
export interface Vp9Header {
  profile: number
  bitDepth: 8 | 10 | 12
  subsampling: '420' | '422' | '440' | '444'
  fullRange: boolean
}

/**
 * The profile, bit depth, chroma subsampling and colour range in the header of
 * a VP9 keyframe, which are the fields of its `vpcC` that the stream is the
 * only place for (VP9 bitstream specification §6.2). The header is read bit by
 * bit from the start of the frame, which is where the first frame of a block
 * that holds a superframe starts too: the frame marker (2 bits, 2), the profile
 * (its low bit, then its high bit), a reserved bit for profile 3, whether it
 * shows an existing frame (then it is no keyframe), the frame type (0 is a
 * keyframe), whether it is shown, whether it is error resilient, the sync code
 * 0x49 0x83 0x42, and the colour configuration: the bit depth (12 or 10 bits, for
 * profile 2 and 3; else 8), the colour space (7 is RGB), the colour range, and
 * for profile 1 and 3 the subsampling and a reserved bit (else 4:2:0; RGB is 4:4:4
 * of the full range, and has no profile 0 or 2). A frame that is no keyframe, has
 * no marker or sync code, or is cut short gives null, and nothing is thrown.
 */
export function vp9Header(frame: Uint8Array): Vp9Header | null {
  let position = 0
  // The next `count` bits as a number, each past the end of the frame a 0: a frame is cut short when `position` ends up past its last bit.
  const read = (count: number): number => {
    let value = 0
    for (let index = 0; index < count; index += 1) {
      const byte = frame[position >> 3]
      value = value * 2 + (((byte ?? 0) >> (7 - (position & 7))) & 1)
      position += 1
    }
    return value
  }

  if (read(2) !== 2) return null // the frame marker
  const profile = read(1) + 2 * read(1) // the low bit comes first
  if (profile === 3) read(1) // reserved
  if (read(1) === 1) return null // show_existing_frame: a frame shown again
  if (read(1) !== 0) return null // frame_type: 1 is not a keyframe
  read(1) // show_frame
  read(1) // error_resilient_mode
  if (read(8) !== 0x49 || read(8) !== 0x83 || read(8) !== 0x42) return null // the sync code

  const bitDepth = profile >= 2 ? (read(1) === 1 ? 12 : 10) : 8
  const space = read(3)
  let fullRange = true
  let x = 0 // subsampling_x
  let y = 0 // subsampling_y
  if (space !== 7) {
    fullRange = read(1) === 1
    if (profile === 1 || profile === 3) {
      x = read(1)
      y = read(1)
      read(1) // reserved
    } else {
      x = 1
      y = 1
    }
  } else if (profile === 1 || profile === 3) {
    read(1) // reserved
  } else {
    return null // RGB is only in the profiles that are 4:4:4
  }
  if (position > frame.length * 8) return null // cut short
  const subsampling = x === 1 ? (y === 1 ? '420' : '422') : y === 1 ? '440' : '444'
  return { profile, bitDepth, subsampling, fullRange }
}

/** What the features in the CodecPrivate of a VP9 track give: each is null when they leave it out. */
interface Vp9Features {
  profile: number | null
  level: number | null
  bitDepth: number | null
  chroma: number | null
}

/**
 * The features that a VP9 track's CodecPrivate holds (WebM's codec binding for
 * VP9): each an ID byte, a length byte and its value, 1 for the profile, 2 for
 * the level, 3 for the bit depth and 4 for the chroma subsampling. Of a feature
 * that is there twice the first counts. One that is cut short, or whose value is
 * not the single byte the binding gives it, or is more than its field in `vpcC`
 * has bits for (4 for the bit depth and 3 for the chroma), is left out, as the
 * features are: what they don't give comes from the keyframe.
 */
function vp9Features(codecPrivate: Uint8Array | null): Vp9Features {
  const features: Vp9Features = { profile: null, level: null, bitDepth: null, chroma: null }
  if (codecPrivate === null) return features
  let at = 0
  while (at + 2 <= codecPrivate.length) {
    const id = codecPrivate[at] ?? 0
    const length = codecPrivate[at + 1] ?? 0
    const value = codecPrivate[at + 2]
    at += 2 + length
    if (at > codecPrivate.length || length !== 1 || value === undefined) continue
    if (id === 1) features.profile ??= value
    else if (id === 2) features.level ??= value
    else if (id === 3 && value <= 0xf) features.bitDepth ??= value
    else if (id === 4 && value <= 0x7) features.chroma ??= value
  }
  return features
}

/** Whether a track is a VP9 whose CodecPrivate lacks its profile, bit depth or chroma, which only the header of its first keyframe gives. */
export function needsKeyframe(track: MatroskaTrack): boolean {
  if (track.codecId !== 'V_VP9') return false
  const { profile, bitDepth, chroma } = vp9Features(track.codecPrivate)
  return profile === null || bitDepth === null || chroma === null
}

/**
 * The level of a VP9 picture (Annex A): the lowest whose limits on the picture
 * size and on the luma samples per second both hold, as ffmpeg works it out. The
 * samples per second are the picture size times the frames per second, which are
 * 1e9 over the DefaultDuration in nanoseconds (0 when the track has none). A
 * picture of no size is level 0, and one past the limits of the last level is
 * that level.
 */
function vp9Level(video: MatroskaVideo, defaultDuration: number | null): number {
  const size = video.pixelWidth * video.pixelHeight
  if (size === 0) return 0
  const rate = defaultDuration === null ? 0 : (size * 1e9) / defaultDuration
  const found = VP9_LEVELS.find(([, maxSize, maxRate]) => size <= maxSize && rate <= maxRate)
  return found?.[0] ?? VP9_LEVELS.at(-1)?.[0] ?? 0
}

/** A colour code of Colour as a byte of `vpcC`: unspecified (2) when the file leaves it out or gives what a byte can't hold. */
function colourCode(code: number | null): number {
  return code !== null && code <= 0xff ? code : UNSPECIFIED
}

/**
 * The chroma subsampling field of `vpcC` for a keyframe's: 4:2:0 is 0 (vertical)
 * when Colour sites the chroma at the left (ChromaSitingHorz 1) and half way
 * (ChromaSitingVert 2), and 1 (collocated) otherwise, as ffmpeg's `vpcc.c` has
 * it; 4:2:2 is 2 and 4:4:4 is 3. 4:4:0 has no code, and is refused.
 */
function chromaCode(subsampling: Vp9Header['subsampling'], colour: MatroskaColour): number {
  switch (subsampling) {
    case '420':
      return colour.chromaSitingHorz === 1 && colour.chromaSitingVert === 2 ? 0 : 1
    case '422':
      return 2
    case '444':
      return 3
    case '440':
      throw unsupported(`its keyframe is 4:4:0, which the 'vpcC' box of VP9 has no code for.`)
  }
}

/** A list of names as a sentence has it: "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  const last = names.at(-1) ?? ''
  return names.length < 2 ? last : `${names.slice(0, -1).join(', ')} and ${last}`
}

/**
 * The `vpcC` box of a VP9 picture: a full box of version 1 and flags 0, then the
 * profile and the level (a byte each), the bit depth (4 bits), chroma (3) and
 * full range (1), the colour primaries, transfer characteristics and matrix
 * coefficients (a byte each), and the size of the codec initialization data, 0.
 * The profile, the level, the bit depth and the chroma are those of the features
 * in the CodecPrivate, and for each that they leave out the level works out and
 * the keyframe gives the rest. The colour is Colour's, 2 where it says none; the
 * range is full when Colour says so (its Range is 2), else when the keyframe does.
 * It is `damaged` when the profile, bit depth or chroma is given by neither.
 */
function vp9Config(
  track: MatroskaTrack,
  video: MatroskaVideo,
  keyframe: Uint8Array | null,
): Uint8Array {
  const features = vp9Features(track.codecPrivate)
  const header = keyframe === null ? null : vp9Header(keyframe)
  const profile = features.profile ?? header?.profile ?? null
  const bitDepth = features.bitDepth ?? header?.bitDepth ?? null
  const chroma =
    features.chroma ?? (header === null ? null : chromaCode(header.subsampling, video.colour))
  if (profile === null || bitDepth === null || chroma === null) {
    const missing = [
      ...(profile === null ? ['profile'] : []),
      ...(bitDepth === null ? ['bit depth'] : []),
      ...(chroma === null ? ['chroma'] : []),
    ]
    throw damaged(
      `its CodecPrivate doesn't give the ${listed(missing)} of this VP9 picture, and the first keyframe, whose header would, ${keyframe === null ? 'was not read' : "can't be read"}.`,
    )
  }
  const level = features.level ?? vp9Level(video, track.defaultDuration)
  const fullRange = video.colour.range === 2 || header?.fullRange === true ? 1 : 0
  return box(
    'vpcC',
    Uint8Array.of(
      ...[1, 0, 0, 0], // version 1, flags 0
      profile,
      level,
      (bitDepth << 4) | (chroma << 1) | fullRange,
      colourCode(video.colour.primaries),
      colourCode(video.colour.transfer),
      colourCode(video.colour.matrix),
      ...[0, 0], // no codec initialization data
    ),
  )
}

/** A track's Dolby Vision record and the box that holds it: the first BlockAdditionMapping of a Dolby Vision type, whose box is of that type and holds the record as it is; null when it has none. */
function dolbyVision(
  track: MatroskaTrack,
): { box: Uint8Array; profile: number; compatibility: number } | null {
  const mapping = track.blockAdditions.find(({ type }) => DOLBY_VISION_TYPES.has(type))
  if (mapping === undefined) return null
  const { type, extraData } = mapping
  if (extraData.length < DOLBY_VISION_RECORD) {
    throw damaged(
      `its Dolby Vision record holds ${extraData.length} bytes, where ${DOLBY_VISION_RECORD} are the least that give its profile and its compatibility ID.`,
    )
  }
  return {
    box: box(fourcc(type), extraData),
    profile: (extraData[2] ?? 0) >> 1,
    compatibility: (extraData[4] ?? 0) >> 4,
  }
}

/**
 * The `stsd` entry that a picture track stands for, which `codecNames` names
 * and the writer carries as it is.
 * - `V_MPEG4/ISO/AVC` is `avc1` with the `avcC` of the CodecPrivate; `V_MPEGH/ISO/HEVC` is `hvc1` with its `hvcC`, or `hev1` when the record has no array of VPS, SPS or PPS; `V_AV1` is `av01` with its `av1C`. A track with no CodecPrivate is `damaged`.
 * - `V_VP9` is `vp09` with a `vpcC` made as `vp9Config` says; `keyframe` is the first frame of the stream, which `needsKeyframe` says is wanted or not.
 * - Dolby Vision (the first BlockAdditionMapping of type `dvcC`, `dvvC` or `dvwC`) over AVC, HEVC or AV1 puts the record in a box of its type after the configuration. With a compatibility ID of 0, or profile 5, the base would not play without Dolby Vision, and the entry is its own: `dvh1` (`dvhe` when the HEVC would be `hev1`), `dav1`, or `dva1` for AVC, which like `avc1` holds the parameter sets in the record. A record of under 5 bytes is `damaged`.
 * - `V_VP8` and every other CodecID is `unsupported-codec`.
 * The entry has the pixel size of the picture; `pictureSize` is the display size.
 */
export function pictureEntry(track: MatroskaTrack, keyframe: Uint8Array | null): Uint8Array {
  const { video } = track
  if (video === null) {
    throw damaged(
      `the track entry of track ${track.number} has no Video element, so it has no size.`,
    )
  }
  let type: string
  let config: Uint8Array
  let dolbyType: string
  switch (track.codecId) {
    case 'V_MPEG4/ISO/AVC':
      type = 'avc1'
      config = box('avcC', record(track, 'avcC'))
      dolbyType = 'dva1'
      break
    case 'V_MPEGH/ISO/HEVC': {
      const hevc = hevcConfig(record(track, 'hvcC'))
      type = hevc.type
      config = box('hvcC', hevc.record)
      dolbyType = type === 'hvc1' ? 'dvh1' : 'dvhe'
      break
    }
    case 'V_AV1':
      type = 'av01'
      config = box('av1C', record(track, 'av1C'))
      dolbyType = 'dav1'
      break
    case 'V_VP9':
      return visualEntry('vp09', video, [vp9Config(track, video, keyframe)])
    case 'V_VP8':
      throw unsupported(`its CodecID is V_VP8: VP8 plays only as WebM, and the reader writes MP4.`)
    default:
      throw unsupported(
        `its CodecID, ${track.codecId}, is not a codec that any browser's Media Source takes in MP4.`,
      )
  }

  const dolby = dolbyVision(track)
  if (dolby === null) return visualEntry(type, video, [config])
  // A compatible base plays without Dolby Vision, and is the entry; one that isn't is the entry of Dolby Vision's own.
  const compatible = dolby.compatibility !== 0 && dolby.profile !== DOLBY_VISION_PROFILE_5
  return visualEntry(compatible ? type : dolbyType, video, [config, dolby.box])
}

/**
 * The matrix of a picture's `tkhd` (36 bytes), the one MP4 has for the rotation
 * that Matroska's ProjectionPoseRoll gives, so that ffprobe reads both alike.
 * Only a quarter or a half turn is a rotation (the roll taken modulo 360); any
 * other roll, and a picture with none, gives the identity.
 */
export function pictureMatrix(track: MatroskaTrack): Uint8Array {
  const roll = track.video?.rollDegrees ?? null
  const turned = roll === null ? undefined : ROTATIONS.get(((roll % 360) + 360) % 360)
  const values = turned ?? IDENTITY_MATRIX
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  values.forEach((value, index) => {
    view.setInt32(index * 4, value)
  })
  return out
}

/**
 * The size of a picture in `tkhd` (0 by 0 for a track with no Video element,
 * which has no entry either): its display size when the file gives both
 * DisplayWidth and DisplayHeight in pixels (DisplayUnit 0), else its pixel size.
 * A display size of 0, or more than the 16 bits that `tkhd` has for the whole
 * part of a size, is none.
 */
export function pictureSize(track: MatroskaTrack): { width: number; height: number } {
  const video = track.video
  if (video === null) return { width: 0, height: 0 }
  const { displayWidth, displayHeight } = video
  if (
    video.displayUnit === 0 &&
    displayWidth !== null &&
    displayHeight !== null &&
    displayWidth > 0 &&
    displayHeight > 0 &&
    displayWidth <= MAX_SIZE &&
    displayHeight <= MAX_SIZE
  ) {
    return { width: displayWidth, height: displayHeight }
  }
  return { width: video.pixelWidth, height: video.pixelHeight }
}

import { Mp4Error } from '../errors.ts'
import { readBytes, readFloat, readString, readUint, walkChildren } from './ebml.ts'
import type { Element } from './ebml.ts'
import { ID } from './ids.ts'
import { MAX_ENTRY_CHILDREN, MAX_TRACK_ENTRIES } from './limits.ts'

// The tracks of a Matroska or WebM file (DESIGN.md §10.4, D45): what its Tracks
// element says of each track, and which of them play. Like `readMovie` for an
// MP4, a track is read leniently: one whose entry can't be read is kept with a
// `problem` that says why, and one that is read but can't be played is kept with
// a `refusal`, because only the tracks that are chosen have to be sound, and a
// file with a broken subtitle track still plays. The Tracks element is read the
// same way: the entries before damage that stops its walk are kept, and the
// damage turns the file away only when no picture was read before it (see
// `readTracks` and `chooseMatroskaTracks`).
//
// A track has a `problem` or a `refusal`, never both: a refusal is a reason that
// a track that was read can't be played, which a track that couldn't be read has
// no way to give. What a track is (its kind) and whether it counts (its flag
// that it is enabled) are read before anything else, from as much of the entry
// as can be walked, so that a picture that can't be read is still the picture:
// it refuses the file, and isn't passed over for a second one, as for an MP4.

/** The Colour element of a picture: each field is null when the file leaves it out. */
export interface MatroskaColour {
  matrix: number | null
  primaries: number | null
  transfer: number | null
  range: number | null
  bitsPerChannel: number | null
  chromaSubsamplingHorz: number | null
  chromaSubsamplingVert: number | null
  chromaSitingHorz: number | null
  chromaSitingVert: number | null
}

/** What a picture track's Video element says. */
export interface MatroskaVideo {
  pixelWidth: number
  pixelHeight: number
  displayWidth: number | null
  displayHeight: number | null
  /** 0 (pixels) when the element is left out, as RFC 9559 has it. */
  displayUnit: number
  colour: MatroskaColour
  /** The rotation that the track's Projection gives, in degrees (its ProjectionPoseRoll); null when it has none. */
  rollDegrees: number | null
}

/** What a sound track's Audio element says. */
export interface MatroskaAudio {
  samplingFrequency: number
  outputSamplingFrequency: number | null
  channels: number
  bitDepth: number | null
}

/** One track of a file: its entry in the Tracks element, with what RFC 9559 gives for what it leaves out. */
export interface MatroskaTrack {
  /** The TrackNumber, which the blocks of its frames name it by. */
  number: number
  /** From TrackType: 1 is a picture and 2 a sound; the rest (subtitles, buttons, a timecode) are 'other', and so is a track whose TrackType can't be read. */
  kind: 'video' | 'audio' | 'other'
  /** FlagEnabled, 1 when it is left out: a track that is not enabled is not played. */
  enabled: boolean
  /** FlagDefault, 1 when it is left out. */
  default: boolean
  /** FlagForced. */
  forced: boolean
  /** The Language as the file writes it, which isn't checked; 'eng', as RFC 9559 has it, when it is left out. */
  language: string
  codecId: string
  /** The CodecPrivate, a view onto the bytes the Tracks element was read from; null when the track has none. */
  codecPrivate: Uint8Array | null
  /** In nanoseconds, 0 when it is left out. */
  codecDelay: number
  /** In nanoseconds, 0 when it is left out. */
  seekPreRoll: number
  /** In nanoseconds; null when the track has none, or says 0, which is no duration (RFC 9559 gives it a least of 1). */
  defaultDuration: number | null
  /** Null for a track that is no picture, and for a picture that couldn't be read as far as its Video element. */
  video: MatroskaVideo | null
  /** Null for a track that is no sound, and for a sound that couldn't be read as far as its Audio element. A sound with no Audio element has the sampling frequency of 8000 and the channel of 1 that RFC 9559 gives. */
  audio: MatroskaAudio | null
  /** What header stripping took from the start of every frame, which the frames are given back with; empty when the track has none. */
  stripped: Uint8Array
  /** Each BlockAdditionMapping, in order: the extra data that goes beside the frames (Dolby Vision's configuration record, for one). */
  blockAdditions: { type: number; extraData: Uint8Array }[]
  /** Why the track can't be played though it was read: a sentence that reads after "The picture track can't be played: " and on its own. */
  refusal: Mp4Error | null
  /** Why the track can't be read, when it can't: kept here, never thrown for the file. */
  problem: string | null
}

/** A TrackType that is a picture, and one that is a sound. */
const VIDEO_TRACK = 1
const AUDIO_TRACK = 2

/** What a sound's frequency and channels are when the file says none, as RFC 9559 has them. */
const DEFAULT_SAMPLING_FREQUENCY = 8000
const DEFAULT_CHANNELS = 1

/** The ContentCompAlgo of header stripping, which the reader undoes, and the names of the other three that RFC 9559 gives. */
const HEADER_STRIPPING = 3
const COMPRESSION_NAMES: readonly string[] = ['zlib', 'bzlib', 'lzo1x']

function damaged(message: string): Mp4Error {
  return new Mp4Error('damaged', message)
}

/** The first of the elements of an ID, which is the one that counts when a file has two. */
function first(found: readonly Element[], id: number): Element | undefined {
  return found.find((el) => el.id === id)
}

/**
 * The elements directly inside `parent`, as `children` finds them, but as far
 * as `parent` can be walked: an element that can't be (its header is cut short
 * by `parent`, it is of unknown size or it runs past `parent`) stops the walk,
 * and the elements before it are kept, with the damage that stopped it. A track
 * is told by its TrackType and its flag, which come early in an entry, so
 * damage after them is no reason to lose them; the same goes for the entries of
 * a Tracks element, of which a damaged one is no reason to lose those before it.
 * The walk is the bounded one of `walkChildren`, a header at a time. `headers`
 * is the most it meets (a CRC-32 and a Void counted): the one after them is
 * damage, as it is in an entry. `kept` is the most elements it keeps (the CRC-32
 * and the Void that it leaves out are not counted): it stops at the first one
 * past them, which is no damage but the end of what is read, so that elements of
 * a few bytes each cost no more than those it keeps.
 */
function leading(
  bytes: Uint8Array,
  parent: Element,
  { kept = Infinity, headers = Infinity }: { kept?: number; headers?: number } = {},
): { found: Element[]; damage: Mp4Error | null } {
  const found: Element[] = []
  try {
    for (const el of walkChildren(bytes, parent, headers)) {
      if (found.length >= kept) break
      found.push(el)
    }
  } catch (error) {
    if (error instanceof Mp4Error) return { found, damage: error }
    throw error
  }
  return { found, damage: null }
}

/** The children of an element inside the entry of a track, which are no more than `MAX_ENTRY_CHILDREN` (a CRC-32 and a Void counted) or the element is damaged, and so is its track. */
function inEntry(bytes: Uint8Array, parent: Element): Element[] {
  return Array.from(walkChildren(bytes, parent, MAX_ENTRY_CHILDREN))
}

/** Which of Colour's fields each element is. */
const COLOUR_FIELDS: ReadonlyMap<number, keyof MatroskaColour> = new Map([
  [ID.MatrixCoefficients, 'matrix'],
  [ID.Primaries, 'primaries'],
  [ID.TransferCharacteristics, 'transfer'],
  [ID.Range, 'range'],
  [ID.BitsPerChannel, 'bitsPerChannel'],
  [ID.ChromaSubsamplingHorz, 'chromaSubsamplingHorz'],
  [ID.ChromaSubsamplingVert, 'chromaSubsamplingVert'],
  [ID.ChromaSitingHorz, 'chromaSitingHorz'],
  [ID.ChromaSitingVert, 'chromaSitingVert'],
])

/** A Colour that says nothing: what a picture with no Colour element has. */
function blankColour(): MatroskaColour {
  return {
    matrix: null,
    primaries: null,
    transfer: null,
    range: null,
    bitsPerChannel: null,
    chromaSubsamplingHorz: null,
    chromaSubsamplingVert: null,
    chromaSitingHorz: null,
    chromaSitingVert: null,
  }
}

function readColour(bytes: Uint8Array, el: Element): MatroskaColour {
  const colour = blankColour()
  for (const child of inEntry(bytes, el)) {
    const field = COLOUR_FIELDS.get(child.id)
    if (field !== undefined) colour[field] ??= readUint(bytes, child)
  }
  return colour
}

/** The ProjectionPoseRoll of a Projection, or null when it has none. */
function readRoll(bytes: Uint8Array, el: Element): number | null {
  const roll = first(inEntry(bytes, el), ID.ProjectionPoseRoll)
  return roll === undefined ? null : readFloat(bytes, roll)
}

/** A Video element, which a picture can't be played without the size of: one with no PixelWidth or PixelHeight is damaged. */
function readVideo(bytes: Uint8Array, el: Element): MatroskaVideo {
  let pixelWidth: number | undefined
  let pixelHeight: number | undefined
  let displayWidth: number | null = null
  let displayHeight: number | null = null
  let displayUnit: number | undefined
  let colour: MatroskaColour | undefined
  let rollDegrees: number | null = null
  for (const child of inEntry(bytes, el)) {
    if (child.id === ID.PixelWidth) pixelWidth ??= readUint(bytes, child)
    else if (child.id === ID.PixelHeight) pixelHeight ??= readUint(bytes, child)
    else if (child.id === ID.DisplayWidth) displayWidth ??= readUint(bytes, child)
    else if (child.id === ID.DisplayHeight) displayHeight ??= readUint(bytes, child)
    else if (child.id === ID.DisplayUnit) displayUnit ??= readUint(bytes, child)
    else if (child.id === ID.Colour) colour ??= readColour(bytes, child)
    else if (child.id === ID.Projection) rollDegrees ??= readRoll(bytes, child)
  }
  if (pixelWidth === undefined || pixelHeight === undefined) {
    throw damaged(
      `The Video element at offset ${el.start} has no ${pixelWidth === undefined ? 'PixelWidth' : 'PixelHeight'}, so the picture has no size.`,
    )
  }
  return {
    pixelWidth,
    pixelHeight,
    displayWidth,
    displayHeight,
    displayUnit: displayUnit ?? 0,
    colour: colour ?? blankColour(),
    rollDegrees,
  }
}

/** The Audio of a sound with no Audio element, which is what RFC 9559 gives a sound that says nothing of itself. */
function defaultAudio(): MatroskaAudio {
  return {
    samplingFrequency: DEFAULT_SAMPLING_FREQUENCY,
    outputSamplingFrequency: null,
    channels: DEFAULT_CHANNELS,
    bitDepth: null,
  }
}

function readAudio(bytes: Uint8Array, el: Element): MatroskaAudio {
  let samplingFrequency: number | undefined
  let outputSamplingFrequency: number | null = null
  let channels: number | undefined
  let bitDepth: number | null = null
  for (const child of inEntry(bytes, el)) {
    if (child.id === ID.SamplingFrequency) samplingFrequency ??= readFloat(bytes, child)
    else if (child.id === ID.OutputSamplingFrequency) {
      outputSamplingFrequency ??= readFloat(bytes, child)
    } else if (child.id === ID.Channels) channels ??= readUint(bytes, child)
    else if (child.id === ID.BitDepth) bitDepth ??= readUint(bytes, child)
  }
  return {
    samplingFrequency: samplingFrequency ?? DEFAULT_SAMPLING_FREQUENCY,
    outputSamplingFrequency,
    channels: channels ?? DEFAULT_CHANNELS,
    bitDepth,
  }
}

/** The extra data of a BlockAdditionMapping: its BlockAddIDType (0 when it has none) and its BlockAddIDExtraData (empty). */
function readAddition(bytes: Uint8Array, el: Element): { type: number; extraData: Uint8Array } {
  let type: number | undefined
  let extraData: Uint8Array | undefined
  for (const child of inEntry(bytes, el)) {
    if (child.id === ID.BlockAddIDType) type ??= readUint(bytes, child)
    else if (child.id === ID.BlockAddIDExtraData) extraData ??= readBytes(bytes, child)
  }
  return { type: type ?? 0, extraData: extraData ?? new Uint8Array(0) }
}

/**
 * What a track's ContentEncodings come to: the bytes that header stripping took
 * from each frame, or the reason that the player can't undo what was done to
 * them. Header stripping is the one thing it undoes: a single ContentEncoding of
 * type 0, of the frames' own contents (scope 1, as it is when left out), whose
 * ContentCompression has ContentCompAlgo 3, and whose ContentCompSettings are the
 * bytes. Zlib, bzlib and lzo1x (algorithms 0, 1 and 2, which is 0 when a
 * ContentCompression names none), encryption, a second encoding, a scope that
 * reaches the track's private data and a compression that is not there are each
 * refused as `unsupported-codec`, with the part of the file that says so in the
 * sentence. A ContentEncodings with no ContentEncoding in it is no encoding.
 */
function readEncodings(
  bytes: Uint8Array,
  el: Element,
): { stripped: Uint8Array; refusal: Mp4Error | null } {
  const refuse = (message: string): { stripped: Uint8Array; refusal: Mp4Error } => ({
    stripped: new Uint8Array(0),
    refusal: new Mp4Error('unsupported-codec', message),
  })

  const [only, ...more] = inEntry(bytes, el).filter((child) => child.id === ID.ContentEncoding)
  if (only === undefined) return { stripped: new Uint8Array(0), refusal: null }
  if (more.length > 0) {
    return refuse(
      `it has ${more.length + 1} content encodings, where the player undoes one at most, the stripping of a header.`,
    )
  }

  let scope: number | undefined
  let type: number | undefined
  let encrypted = false
  let algo: number | undefined
  let settings: Uint8Array | undefined
  let compressed = false
  const seen = new Set<number>()
  for (const child of inEntry(bytes, only)) {
    if (seen.has(child.id)) continue
    seen.add(child.id)
    if (child.id === ID.ContentEncodingScope) scope = readUint(bytes, child)
    else if (child.id === ID.ContentEncodingType) type = readUint(bytes, child)
    else if (child.id === ID.ContentEncryption) encrypted = true
    else if (child.id === ID.ContentCompression) {
      compressed = true
      for (const field of inEntry(bytes, child)) {
        if (field.id === ID.ContentCompAlgo) algo ??= readUint(bytes, field)
        else if (field.id === ID.ContentCompSettings) settings ??= readBytes(bytes, field)
      }
    }
  }

  const encodingType = type ?? 0
  if (encodingType === 1) {
    return refuse(`it is encrypted (ContentEncodingType 1), which the player can't decrypt.`)
  }
  if (encodingType !== 0) {
    return refuse(
      `its content encoding is of ContentEncodingType ${encodingType}, which the player doesn't know.`,
    )
  }
  if (encrypted) {
    return refuse(`it is encrypted (it has a ContentEncryption), which the player can't decrypt.`)
  }
  if (!compressed) {
    return refuse(
      `its content encoding is of type 0 and has no ContentCompression, so the player can't tell what was done to its frames.`,
    )
  }
  const how = algo ?? 0
  if (how !== HEADER_STRIPPING) {
    const name = COMPRESSION_NAMES[how]
    return refuse(
      name === undefined
        ? `it is compressed by ContentCompAlgo ${how}, which the player doesn't know.`
        : `it is compressed with ${name} (ContentCompAlgo ${how}), which the player can't undo.`,
    )
  }
  if ((scope ?? 1) !== 1) {
    return refuse(
      `its content encoding applies to ContentEncodingScope ${scope ?? 1}, where the player undoes only scope 1, the frames' contents.`,
    )
  }
  return { stripped: settings ?? new Uint8Array(0), refusal: null }
}

/**
 * One track, or what could be read of it, with `problem` set to the reason when
 * the entry could not be read. Only an `Mp4Error` is the file's fault: anything
 * else is a bug here and is not hidden. A track that was read whole is then held
 * to what the player can undo: a refusal is for a track with no problem. Every
 * walk inside the entry is bounded by count (`MAX_ENTRY_CHILDREN`, a CRC-32 and
 * a Void counted): an element with more children is damage like a header that
 * runs past its parent, so that the track is kept with its problem and one entry
 * of tiny children costs no more than the bound.
 */
function readEntry(bytes: Uint8Array, entry: Element): MatroskaTrack {
  const track: MatroskaTrack = {
    number: 0,
    kind: 'other',
    enabled: true,
    default: true,
    forced: false,
    language: 'eng',
    codecId: '',
    codecPrivate: null,
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
  try {
    const { found, damage } = leading(bytes, entry, { headers: MAX_ENTRY_CHILDREN })

    // What the track is, and whether it counts, before anything that can fail.
    const typeEl = first(found, ID.TrackType)
    if (typeEl !== undefined) {
      const type = readUint(bytes, typeEl)
      track.kind = type === VIDEO_TRACK ? 'video' : type === AUDIO_TRACK ? 'audio' : 'other'
    }
    const enabledEl = first(found, ID.FlagEnabled)
    if (enabledEl !== undefined) track.enabled = readUint(bytes, enabledEl) !== 0

    // The rest in the order of the file, so that the first child that can't be read is the problem. Of an element that a track has twice, the first counts.
    let encodings: { stripped: Uint8Array; refusal: Mp4Error | null } | undefined
    let timestampScale = 1
    const seen = new Set<number>()
    for (const child of found) {
      if (child.id === ID.BlockAdditionMapping) {
        track.blockAdditions.push(readAddition(bytes, child))
        continue
      }
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.id === ID.TrackNumber) track.number = readUint(bytes, child)
      else if (child.id === ID.FlagDefault) track.default = readUint(bytes, child) !== 0
      else if (child.id === ID.FlagForced) track.forced = readUint(bytes, child) !== 0
      else if (child.id === ID.Language) track.language = readString(bytes, child)
      else if (child.id === ID.CodecID) track.codecId = readString(bytes, child)
      else if (child.id === ID.CodecPrivate) track.codecPrivate = readBytes(bytes, child)
      else if (child.id === ID.CodecDelay) track.codecDelay = readUint(bytes, child)
      else if (child.id === ID.SeekPreRoll) track.seekPreRoll = readUint(bytes, child)
      else if (child.id === ID.DefaultDuration) {
        // RFC 9559 gives it a least of 1: a DefaultDuration of 0 says no duration at all.
        const duration = readUint(bytes, child)
        track.defaultDuration = duration === 0 ? null : duration
      } else if (child.id === ID.TrackTimestampScale) timestampScale = readFloat(bytes, child)
      else if (child.id === ID.ContentEncodings) encodings = readEncodings(bytes, child)
      else if (child.id === ID.Video && track.kind === 'video') {
        track.video = readVideo(bytes, child)
      } else if (child.id === ID.Audio && track.kind === 'audio') {
        track.audio = readAudio(bytes, child)
      }
    }
    // An entry that couldn't be walked to its end: what was read before it is kept.
    if (damage !== null) throw damage

    if (typeEl === undefined) throw damaged(`The track entry has no TrackType.`)
    if (track.number === 0) {
      throw damaged(`The track entry has no TrackNumber, or one of 0, where the least is 1.`)
    }
    if (track.codecId === '') {
      throw damaged(`The track entry of track ${track.number} has no CodecID.`)
    }
    if (track.kind === 'video' && track.video === null) {
      throw damaged(
        `The track entry of track ${track.number} is a picture that has no Video element, so it has no size.`,
      )
    }
    if (track.kind === 'audio' && track.audio === null) track.audio = defaultAudio()

    // The track was read: now what the player can't undo.
    if (encodings !== undefined) {
      track.stripped = encodings.stripped
      track.refusal = encodings.refusal
    }
    if (track.refusal === null && timestampScale !== 1) {
      track.refusal = damaged(
        `its TrackTimestampScale is ${timestampScale}, where the player reads only 1: it can't place a track whose timestamps are scaled again.`,
      )
    }
  } catch (error) {
    if (!(error instanceof Mp4Error)) throw error
    track.problem = error.message
  }
  return track
}

/**
 * The tracks of a file, in the order of its Tracks element, which is held whole:
 * `bytes` holds it, and `tracks` is its element in those bytes. A track whose
 * entry can't be read is in the result with its `problem`, never refused (see
 * `MatroskaTrack`). The Tracks element itself is walked as far as it can be, as
 * `leading` walks an entry, and every entry before the damage is read: an entry
 * that claims more than the Tracks element holds, one whose header is cut short
 * or one of unknown size stops the walk, and the `damage` that stopped it is
 * given beside the tracks that came before it (null when the walk reached the
 * end), for `chooseMatroskaTracks` to decide what it costs, as `need` in
 * movie.ts does for an MP4. Only a Tracks element that is no element to walk (it
 * has no size, or claims more than `bytes` holds) is refused, as
 * `Mp4Error('damaged')`. Two tracks of the same number are both kept as they are
 * read. The walk takes `MAX_TRACK_ENTRIES` elements and no more, a TrackEntry or
 * any other (a CRC-32 and a Void are not counted), one header at a time: the
 * elements past them are ignored, with no damage and no refusal, so that a file
 * keeps the tracks it shows before them and a flood of elements of a few bytes
 * each costs no more than the first of them (D45). A file whose picture lies past
 * them is a file with no picture to play.
 */
export function readTracks(
  bytes: Uint8Array,
  tracks: Element,
): { tracks: MatroskaTrack[]; damage: Mp4Error | null } {
  if (!tracks.sized) {
    throw damaged(
      `The Tracks element at offset ${tracks.start} has an unknown size, which only a Segment or a Cluster may have.`,
    )
  }
  if (tracks.end > bytes.length) {
    throw damaged(
      `The Tracks element at offset ${tracks.start} claims ${tracks.end - tracks.data} bytes, but ${Math.max(bytes.length - tracks.data, 0)} are held.`,
    )
  }
  const { found, damage } = leading(bytes, tracks, { kept: MAX_TRACK_ENTRIES })
  return {
    tracks: found
      .filter((child) => child.id === ID.TrackEntry)
      .map((entry) => readEntry(bytes, entry)),
    damage,
  }
}

/**
 * The picture and the sounds that a file plays (D45). The picture is the first
 * enabled picture track, whatever is wrong with it: a first picture that can't
 * be read or played refuses the file, and isn't passed over for a second. A file
 * with no enabled picture is refused as `no-picture`, unless `damage` (what
 * stopped the walk of the Tracks element, from `readTracks`) is given: the
 * picture may have been in the part of the element that couldn't be walked, so
 * the damage is the refusal then, as `need` in movie.ts gives the damage that
 * stopped a walk as the reason for what it lacks. A picture that was read before
 * the damage costs nothing to it. The sounds are the enabled sound tracks, the
 * first of them that is flagged default first (else the first in the file is),
 * then all the others in the order of the file, so that the sound that plays is
 * the one the file says to play and the others are there to choose. A sound that
 * has a problem or a refusal keeps its place: the index decides what that costs.
 */
export function chooseMatroskaTracks(
  tracks: readonly MatroskaTrack[],
  damage: Mp4Error | null = null,
): {
  video: MatroskaTrack
  sounds: MatroskaTrack[]
} {
  const video = tracks.find((track) => track.kind === 'video' && track.enabled)
  if (video === undefined) {
    throw (
      damage ??
      new Mp4Error('no-picture', 'The file has no picture track, so there is nothing to play.')
    )
  }
  const enabled = tracks.filter((track) => track.kind === 'audio' && track.enabled)
  const preferred = enabled.find((track) => track.default)
  const sounds =
    preferred === undefined
      ? enabled
      : [preferred, ...enabled.filter((track) => track !== preferred)]
  return { video, sounds }
}

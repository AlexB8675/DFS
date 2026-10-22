// A builder for the boxes the tests read, used by tests only (DESIGN.md §10.4):
// the boxes are written out here, byte by byte, so the reader is checked
// against what the standard says and not against what it was written to read.
// Numbers are big-endian, as in a file.

/** What a box is built from: bytes, or numbers that are bytes. */
export type Part = Uint8Array | number[]

function big(value: number | bigint, bits: number, signed: boolean): number[] {
  const wide = BigInt(value)
  const limit = 1n << BigInt(bits)
  const [low, high] = signed ? [-(limit >> 1n), limit >> 1n] : [0n, limit]
  if (wide < low || wide >= high) {
    throw new RangeError(`${value} doesn't fit in ${bits} bits${signed ? ', signed' : ''}.`)
  }
  const unsigned = BigInt.asUintN(bits, wide)
  const bytes: number[] = []
  for (let shift = bits - 8; shift >= 0; shift -= 8) {
    bytes.push(Number((unsigned >> BigInt(shift)) & 0xffn))
  }
  return bytes
}

export function u16(value: number): number[] {
  return big(value, 16, false)
}

export function i16(value: number): number[] {
  return big(value, 16, true)
}

export function u32(value: number): number[] {
  return big(value, 32, false)
}

export function i32(value: number): number[] {
  return big(value, 32, true)
}

export function u64(value: number | bigint): number[] {
  return big(value, 64, false)
}

export function i64(value: number | bigint): number[] {
  return big(value, 64, true)
}

/** A box type or other four-character code, as its 4 bytes. */
export function fourcc(code: string): number[] {
  if (code.length !== 4) throw new RangeError(`'${code}' is not four characters.`)
  return Array.from(code, (letter) => letter.charCodeAt(0))
}

export function concat(...parts: Part[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A box: its size and type, then the parts. */
export function box(type: string, ...parts: Part[]): Uint8Array {
  const body = concat(...parts)
  return concat(u32(8 + body.length), fourcc(type), body)
}

/** A box that starts with a version byte and 24 bits of flags. */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Part[]
): Uint8Array {
  return box(type, [version], big(flags, 24, false), ...parts)
}

// The index of a movie, laid out as ISO/IEC 14496-12 (and QuickTime) lay it out,
// field by field. Everything has a default, so a test names only what it reads.

/** A number in 16.16 fixed point: its integer part, then the fraction in 65536ths. */
export function fixed(value: number): number[] {
  return u32(Math.round(value * 0x10000))
}

/** A language as a box holds it: three letters, each 5 bits of its offset from 0x60, behind a zero bit. */
export function packedLanguage(code: string): number {
  if (!/^[a-z]{3}$/.test(code)) throw new RangeError(`'${code}' is not three lowercase letters.`)
  const [first = 0, second = 0, third = 0] = Array.from(
    code,
    (letter) => letter.charCodeAt(0) - 0x60,
  )
  return (first << 10) | (second << 5) | third
}

/** The matrix that leaves a picture as it is: 16.16 for a, b, c and d, 2.30 for w. */
export const IDENTITY_MATRIX: readonly number[] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]

function matrixBytes(values: readonly number[]): number[] {
  if (values.length !== 9) throw new RangeError('A matrix has 9 values.')
  return values.flatMap((value) => (value < 0 ? i32(value) : u32(value)))
}

/** Version 0 holds times in 32 bits, version 1 in 64. */
export type Version = 0 | 1

function time(version: Version, value: number | bigint): number[] {
  return version === 0 ? u32(Number(value)) : u64(value)
}

export interface MovieHeaderSpec {
  version?: Version
  timescale?: number
  duration?: number | bigint
}

/** `mvhd`: the movie's timescale and duration, with the rest of its fields at their usual values. */
export function mvhd({
  version = 0,
  timescale = 1000,
  duration = 0,
}: MovieHeaderSpec = {}): Uint8Array {
  return fullBox(
    'mvhd',
    version,
    0,
    time(version, 0), // created
    time(version, 0), // modified
    u32(timescale),
    time(version, duration),
    fixed(1), // rate
    u16(0x0100), // volume 1.0, 8.8
    new Array<number>(10).fill(0), // reserved
    matrixBytes(IDENTITY_MATRIX),
    new Array<number>(24).fill(0), // pre-defined
    u32(2), // the next track's ID
  )
}

export interface TrackHeaderSpec {
  version?: Version
  id?: number
  duration?: number | bigint
  matrix?: readonly number[]
  /** In pixels, written as 16.16: a fraction is allowed. */
  width?: number
  height?: number
}

/** `tkhd`: the track's ID, matrix and size, with the rest of its fields at their usual values. */
export function tkhd({
  version = 0,
  id = 1,
  duration = 0,
  matrix = IDENTITY_MATRIX,
  width = 0,
  height = 0,
}: TrackHeaderSpec = {}): Uint8Array {
  return fullBox(
    'tkhd',
    version,
    3, // enabled, and in the movie
    time(version, 0), // created
    time(version, 0), // modified
    u32(id),
    u32(0), // reserved
    time(version, duration),
    new Array<number>(8).fill(0), // reserved
    i16(0), // layer
    i16(0), // alternate group
    u16(0), // volume
    u16(0), // reserved
    matrixBytes(matrix),
    fixed(width),
    fixed(height),
  )
}

export interface MediaHeaderSpec {
  version?: Version
  timescale?: number
  duration?: number | bigint
  /** Three lowercase letters, or the 16 bits as they are stored. */
  language?: string | number
}

/** `mdhd`: the media's timescale, duration and language. */
export function mdhd({
  version = 0,
  timescale = 1000,
  duration = 0,
  language = 'und',
}: MediaHeaderSpec = {}): Uint8Array {
  return fullBox(
    'mdhd',
    version,
    0,
    time(version, 0), // created
    time(version, 0), // modified
    u32(timescale),
    time(version, duration),
    u16(typeof language === 'string' ? packedLanguage(language) : language),
    u16(0), // quality
  )
}

/** `hdlr`: what the media is, as a handler type such as `vide` or `soun`. */
export function hdlr(handler: string, name = ''): Uint8Array {
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre-defined (QuickTime's component type)
    fourcc(handler),
    new Array<number>(12).fill(0), // reserved
    Array.from(name, (letter) => letter.charCodeAt(0)),
    [0], // the name ends in a zero
  )
}

/** A sample entry box, with the 8 bytes every entry starts with (6 reserved, then the data reference index) and the rest as given. */
export function sampleEntry(type: string, ...rest: Part[]): Uint8Array {
  return box(type, new Array<number>(6).fill(0), u16(1), ...rest)
}

/** `stsd`: the sample entries, counted. `count` says another number than the entries there are. */
export function stsd(entries: readonly Uint8Array[], count = entries.length): Uint8Array {
  return fullBox('stsd', 0, 0, u32(count), ...entries)
}

export interface EditSpec {
  /** In the movie's timescale. */
  duration: number | bigint
  /** In the media's timescale, or -1 for an empty edit. */
  mediaTime: number | bigint
  /** 16.16 as stored: 0x10000 is 1. */
  rate?: number
}

/** `edts` with an `elst` of these edits. */
export function edts(version: Version, edits: readonly EditSpec[]): Uint8Array {
  return box(
    'edts',
    fullBox(
      'elst',
      version,
      0,
      u32(edits.length),
      ...edits.map(({ duration, mediaTime, rate = 0x10000 }) => [
        ...time(version, duration),
        ...(version === 0 ? i32(Number(mediaTime)) : i64(mediaTime)),
        ...i32(rate),
      ]),
    ),
  )
}

export interface TrackSpec {
  id?: number
  /** `vide` or `soun`, or another handler type. */
  handler?: string
  tkhdVersion?: Version
  mdhdVersion?: Version
  /** The media's timescale and duration, in `mdhd`. */
  timescale?: number
  duration?: number | bigint
  language?: string | number
  width?: number
  height?: number
  matrix?: readonly number[]
  /** `edts`, if the track has one. */
  edits?: { version: Version; edits: readonly EditSpec[] }
  /** The sample entries of `stsd`, as `sampleEntry` makes them. */
  entries?: readonly Uint8Array[]
  /** The sample tables, each a whole box: `stts`, `stsz`, `stco` and so on. */
  tables?: readonly Uint8Array[]
  /** A whole `stbl`, in place of the one made from `entries` and `tables`: for one that is damaged. */
  stbl?: Uint8Array
}

/** A `trak` with its `tkhd`, an `edts` if given, and `mdia` with `mdhd`, `hdlr` and `minf` with `stbl`. */
export function trak(spec: TrackSpec = {}): Uint8Array {
  const media = box(
    'mdia',
    mdhd({
      version: spec.mdhdVersion ?? 0,
      timescale: spec.timescale ?? 1000,
      duration: spec.duration ?? 0,
      language: spec.language ?? 'und',
    }),
    hdlr(spec.handler ?? 'vide'),
    box(
      'minf',
      // The media header and the data information that a real track holds before its table.
      fullBox('vmhd', 0, 1, new Array<number>(8).fill(0)),
      box('dinf'),
      spec.stbl ?? box('stbl', stsd(spec.entries ?? [sampleEntry('avc1')]), ...(spec.tables ?? [])),
    ),
  )
  return box(
    'trak',
    tkhd({
      version: spec.tkhdVersion ?? 0,
      id: spec.id ?? 1,
      duration: spec.duration ?? 0,
      matrix: spec.matrix ?? IDENTITY_MATRIX,
      width: spec.width ?? 0,
      height: spec.height ?? 0,
    }),
    ...(spec.edits ? [edts(spec.edits.version, spec.edits.edits)] : []),
    media,
  )
}

export interface MovieSpec extends MovieHeaderSpec {
  /** Tracks to build, or `trak` boxes already built. */
  tracks?: readonly (TrackSpec | Uint8Array)[]
  /** More boxes at the end of the `moov`: `udta`, `mvex` and so on. */
  extra?: readonly Uint8Array[]
}

/** A `moov` with an `mvhd`, its tracks, then `extra`. */
export function movie({ tracks = [], extra = [], ...header }: MovieSpec = {}): Uint8Array {
  return box(
    'moov',
    mvhd(header),
    ...tracks.map((track) => (track instanceof Uint8Array ? track : trak(track))),
    ...extra,
  )
}

// The sample tables of a track, laid out as the standard lays them out. A
// table of a whole movie is long (a two-hour film at 60 frames a second has
// 432 000 sizes), so each one writes its entries into one array of bytes
// instead of one part for each, which `concat` and `box` would have to spread.
// The ones that count their entries take `count` to say another number than
// the entries there are, for a table that lies.

/** Numbers of 32 bits, one after the other, as unsigned or signed. */
function words(values: readonly number[], signed = false): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  const [low, high] = signed ? [-(2 ** 31), 2 ** 31 - 1] : [0, 2 ** 32 - 1]
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new RangeError(`${value} doesn't fit in 32 bits${signed ? ', signed' : ''}.`)
    }
    if (signed) view.setInt32(index * 4, value)
    else view.setUint32(index * 4, value)
  })
  return out
}

/** Numbers of 64 bits, one after the other. */
function longs(values: readonly (number | bigint)[]): Uint8Array {
  const out = new Uint8Array(values.length * 8)
  values.forEach((value, index) => {
    out.set(u64(value), index * 8)
  })
  return out
}

/** A run of samples: how many there are, then what each has (a duration for `stts`, an offset for `ctts`). */
export type Run = readonly [count: number, value: number]

/** `stts`: the duration of each run of samples. */
export function stts(runs: readonly Run[], count = runs.length): Uint8Array {
  return fullBox('stts', 0, 0, u32(count), words(runs.flat()))
}

/** `ctts`: the composition offset of each run of samples, unsigned in version 0 and signed in 1. */
export function ctts(version: Version, runs: readonly Run[], count = runs.length): Uint8Array {
  return fullBox('ctts', version, 0, u32(count), words(runs.flat(), version === 1))
}

/** `stss`: the numbers of the keyframes, counting from 1. */
export function stss(samples: readonly number[], count = samples.length): Uint8Array {
  return fullBox('stss', 0, 0, u32(count), words(samples))
}

/** What `stsz` says of sizes when there is one for all: the size, and how many samples have it. */
export interface ConstantSize {
  size: number
  count: number
}

/** `stsz`: the size of each sample, or one size for all of `count`. `count` says another number of samples than there are. */
export function stsz(sizes: readonly number[] | ConstantSize, count?: number): Uint8Array {
  if ('size' in sizes) {
    if (sizes.size === 0) throw new RangeError('A size of 0 says that each sample has its own.')
    return fullBox('stsz', 0, 0, u32(sizes.size), u32(count ?? sizes.count))
  }
  return fullBox('stsz', 0, 0, u32(0), u32(count ?? sizes.length), words(sizes))
}

/** `stz2`: the sizes in 4, 8 or 16 bits each. At 4 the first of a pair is the high half, and an odd one out has the low half left at 0. */
export function stz2(bits: 4 | 8 | 16, sizes: readonly number[], count = sizes.length): Uint8Array {
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 0 || size >= 2 ** bits) {
      throw new RangeError(`${size} doesn't fit in ${bits} bits.`)
    }
  }
  const entries = new Uint8Array(Math.ceil((sizes.length * bits) / 8))
  sizes.forEach((size, index) => {
    if (bits === 4) {
      const at = index >> 1
      entries[at] = (entries[at] ?? 0) | (index % 2 === 0 ? size << 4 : size)
    } else if (bits === 8) {
      entries[index] = size
    } else {
      entries[index * 2] = size >> 8
      entries[index * 2 + 1] = size & 0xff
    }
  })
  // 24 bits reserved, then the field size, then the count.
  return fullBox('stz2', 0, 0, [0, 0, 0, bits], u32(count), entries)
}

/** A run of chunks of `stsc`: the first chunk, counting from 1, how many samples each has, and which description they use. */
export type ChunkRun = readonly [firstChunk: number, samplesPerChunk: number, description?: number]

/** `stsc`: how many samples are in each chunk, from the chunk each run starts at. */
export function stsc(runs: readonly ChunkRun[], count = runs.length): Uint8Array {
  return fullBox(
    'stsc',
    0,
    0,
    u32(count),
    words(runs.flatMap(([first, perChunk, description = 1]) => [first, perChunk, description])),
  )
}

/** `stco`: where each chunk starts, in 32 bits. */
export function stco(offsets: readonly number[], count = offsets.length): Uint8Array {
  return fullBox('stco', 0, 0, u32(count), words(offsets))
}

/** `co64`: where each chunk starts, in 64 bits. */
export function co64(offsets: readonly (number | bigint)[], count = offsets.length): Uint8Array {
  return fullBox('co64', 0, 0, u32(count), longs(offsets))
}

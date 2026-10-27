import { describe, expect, it } from 'vitest'
import { chooseTracks } from './choose.ts'
import * as api from './index.ts'
import { Mp4Error } from './errors.ts'
import type { Mp4Refusal } from './errors.ts'
import { readMovie } from './movie.ts'
import type { Movie } from './movie.ts'
import { readMatroska } from './matroska/read.ts'
import { matroskaSeek } from './matroska/seek.ts'
import { matroskaFrames, matroskaStart } from './matroska/spans.ts'
import { mp4Index, mp4Sound } from './mp4source.ts'
import type { Mp4Cursor, Mp4Index } from './mp4source.ts'
import {
  framesIn,
  heldBytes,
  nextRead,
  openSource,
  seekCursor,
  sniff,
  startCursor,
} from './source.ts'
import type { ByteRange, Chunk, Cursor, SoundOffer, SourceIndex } from './source.ts'
import { pictureEnd } from './timing.ts'
import {
  audioEntry,
  avcC,
  box,
  concat,
  dfLa,
  dOps,
  esds,
  fourcc,
  movie,
  stco,
  stsc,
  stsd,
  stss,
  stsz,
  stts,
  u32,
  visualEntry,
} from './testing/build.ts'
import type { TrackSpec } from './testing/build.ts'
import { matroskaMovie } from './testing/ebml.ts'
import type { TrackSpec as MatroskaTrackSpec } from './testing/ebml.ts'
import { fragment } from './write.ts'

// What a reader of a file in the page is given and asks for, the same for MP4 and
// Matroska (DESIGN.md §10.4, D45). The MP4 side is checked against what
// `readMovie` and `chooseTracks` give, which it adapts, and against values
// written out from the rules: the frames of a built file, the keyframe a time
// seeks to, and the sound frame that covers it. Every file is built in code.

/** What a caller reads first, a megabyte (HEAD_BYTES, which a later task names). */
const HEAD = 1024 * 1024

/** A file of a mebibyte: it holds every frame that the tables of the movies built here (not the files) place. */
const FILE_SIZE = 2 ** 20

const SOUND_SENTENCE = "The sound track can't be played: "

/** What is there, which a test knows to be. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('expected a value')
  return value
}

/** What `run` throws, which must be an `Mp4Error` of this reason. */
function refusal(reason: Mp4Refusal, run: () => unknown): Mp4Error {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Mp4Error)
    expect((error as Mp4Error).reason).toBe(reason)
    expect((error as Mp4Error).message).not.toBe('')
    return error as Mp4Error
  }
  throw new Error(`expected an Mp4Error (${reason})`)
}

/** The index of an MP4, which must be one. */
function mp4Of(index: SourceIndex): Mp4Index {
  if (index.container !== 'mp4') throw new Error('expected the index of an MP4')
  return index
}

/** The cursor of an MP4, which must be one. */
function mp4Cursor(cursor: Cursor): Mp4Cursor {
  if (cursor.container !== 'mp4') throw new Error('expected the cursor of an MP4')
  return cursor
}

/** The refusal of an offer, which must be one. */
function turnedAway(offer: SoundOffer | undefined): Mp4Error {
  if (offer === undefined || !('refusal' in offer)) throw new Error('expected a refused sound')
  return offer.refusal
}

/** The names of an offer that plays, which must be one. */
function playable(offer: SoundOffer | undefined): { id: number; codecNames: readonly string[] } {
  if (offer === undefined || 'refusal' in offer) throw new Error('expected a sound that plays')
  return offer
}

/**
 * Opens a file the way a caller does: the first `head` bytes, then each range the
 * reader asks for, from the whole file. Every ask is held to the rules on the way:
 * it lies inside the file and is never one that the caller holds.
 */
function open(
  bytes: Uint8Array,
  head = HEAD,
): { index: SourceIndex; asks: ByteRange[]; chunks: Chunk[] } {
  const chunks: Chunk[] = [{ start: 0, bytes: bytes.subarray(0, Math.min(head, bytes.length)) }]
  const asks: ByteRange[] = []
  for (let turn = 0; turn < 8; turn += 1) {
    const step = openSource(chunks, bytes.length)
    if ('done' in step) return { index: step.done, asks, chunks }
    const { start, end } = step.need
    expect(Number.isSafeInteger(start) && start >= 0 && start < end && end <= bytes.length).toBe(
      true,
    )
    expect(heldBytes(chunks, start, end)).toBeNull()
    asks.push(step.need)
    chunks.push({ start, bytes: bytes.subarray(start, end) })
  }
  throw new Error('the open went on asking')
}

// ---------------------------------------------------------------------------
// Sniffing the container.

describe('sniff', () => {
  it("tells Matroska by EBML's magic number, 1A 45 DF A3", () => {
    expect(sniff(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3))).toBe('matroska')
    expect(sniff(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01))).toBe(
      'matroska',
    )
  })

  it('tells MP4 by the type of the first box, when it is one that a file starts with', () => {
    for (const type of ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']) {
      expect(sniff(concat(u32(24), fourcc(type), new Uint8Array(16)))).toBe('mp4')
    }
    // The header alone is enough.
    expect(sniff(concat(u32(8), fourcc('ftyp')))).toBe('mp4')
  })

  it('gives null for anything else', () => {
    // Bytes that are neither, a box of a type that no file starts with, and another container's magic.
    expect(
      sniff(Uint8Array.of(0x13, 0x37, 0xc0, 0xde, 0x99, 0x01, 0x7f, 0x80, 0x00, 0x42)),
    ).toBeNull()
    expect(sniff(concat(u32(24), fourcc('trak'), new Uint8Array(16)))).toBeNull()
    expect(sniff(concat(fourcc('RIFF'), u32(0), fourcc('AVI '), new Uint8Array(8)))).toBeNull()
    // Nearly EBML's magic.
    expect(sniff(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa2, 0, 0, 0, 0))).toBeNull()
  })

  it("gives null for a head too short to say, and doesn't read past it", () => {
    expect(sniff(new Uint8Array(0))).toBeNull()
    expect(sniff(Uint8Array.of(0x1a, 0x45, 0xdf))).toBeNull()
    // A box header is 8 bytes: 'ftyp' at 4 to 8 is not all there.
    expect(sniff(concat(u32(24), fourcc('ftyp')).subarray(0, 7))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The index of an MP4.

const PICTURE = visualEntry('avc1', {}, avcC())
const AAC = audioEntry('mp4a', {}, esds())

/** 4 samples in 2 chunks, with keyframes at the samples 1 and 3 unless `keyframes` is false (as a sound's are). */
function goodTables(keyframes = true): Uint8Array[] {
  return [
    stts([[4, 1000]]),
    stsz([10, 20, 30, 40]),
    stsc([[1, 2]]),
    stco([100, 200]),
    ...(keyframes ? [stss([1, 3])] : []),
  ]
}

/** Tables that read cleanly but disagree: `stts` counts 3 samples where `stsz` counts 4, so that expanding them is refused. */
function wrongTables(): Uint8Array[] {
  return [stts([[3, 1000]]), stsz([10, 20, 30, 40]), stsc([[1, 2]]), stco([100, 200])]
}

function picture(spec: TrackSpec = {}): TrackSpec {
  return { handler: 'vide', timescale: 30000, entries: [PICTURE], tables: goodTables(), ...spec }
}

function sound(spec: TrackSpec = {}): TrackSpec {
  return { handler: 'soun', timescale: 44100, entries: [AAC], tables: goodTables(false), ...spec }
}

/** A sound with no frames at all. */
function emptySound(spec: TrackSpec = {}): TrackSpec {
  return sound({
    tables: [stts([]), stsz([]), stsc([]), stco([])],
    ...spec,
  })
}

function read(tracks: TrackSpec[]): Movie {
  return readMovie(movie({ timescale: 1000, tracks }))
}

/** What `chooseTracks` says when `tracks` are all there is: the refusal it throws. */
function chosenRefusal(tracks: TrackSpec[]): Mp4Error {
  try {
    chooseTracks(read(tracks), FILE_SIZE)
  } catch (error) {
    if (error instanceof Mp4Error) return error
    throw error
  }
  throw new Error('expected chooseTracks to refuse')
}

describe('the index of an MP4 (§10.4)', () => {
  it('has the picture and the sound that chooseTracks gives, and offers the sound', () => {
    const parsed = read([picture({ language: 'fra' }), sound({ id: 2, language: 'jpn' })])
    const index = mp4Index(parsed, FILE_SIZE)
    const chosen = chooseTracks(parsed, FILE_SIZE)
    expect(index.container).toBe('mp4')
    expect(index.movie).toBe(parsed)
    expect(index.fileSize).toBe(FILE_SIZE)
    expect(index.video).toEqual(chosen.video)
    expect(index.sound).toEqual(chosen.audio)
    expect(index.sounds).toEqual([
      { id: 2, language: 'jpn', codecNames: ['mp4a.40.2'], codec: 'mp4a.40.2' },
    ])
  })

  it("has the duration of pictureEnd: the end of the picture's last frame shown", () => {
    // Four frames of 1000 ticks at 30000 a second.
    const parsed = read([picture(), sound({ id: 2 })])
    const index = mp4Index(parsed, FILE_SIZE)
    expect(index.durationSeconds).toBeCloseTo(4 / 30, 9)
    expect(index.durationSeconds).toBe(pictureEnd(index.video))
  })

  it('has no sound, and offers none, for a file without one', () => {
    const index = mp4Index(read([picture()]), FILE_SIZE)
    expect(index.sound).toBeNull()
    expect(index.sounds).toEqual([])
  })

  it('refuses for the picture exactly as chooseTracks does, and before it looks at the sound', () => {
    const cases: { what: string; tracks: TrackSpec[]; reason: Mp4Refusal }[] = [
      { what: 'no picture', tracks: [sound({ id: 2 })], reason: 'no-picture' },
      {
        what: 'a picture in a codec no browser takes',
        tracks: [picture({ entries: [visualEntry('mp4v')] }), sound({ id: 2 })],
        reason: 'unsupported-codec',
      },
      {
        what: 'a picture whose tables disagree',
        tracks: [picture({ tables: wrongTables() }), sound({ id: 2, entries: [] })],
        reason: 'damaged',
      },
      {
        what: 'a picture with two descriptions',
        tracks: [picture({ entries: [PICTURE, PICTURE] })],
        reason: 'several-descriptions',
      },
    ]
    for (const { what, tracks, reason } of cases) {
      const wanted = refusal(reason, () => chooseTracks(read(tracks), FILE_SIZE))
      const given = refusal(reason, () => mp4Index(read(tracks), FILE_SIZE))
      expect(given.message, what).toBe(wanted.message)
    }
  })

  it('refuses a size that is no count of bytes, as chooseTracks does', () => {
    const parsed = read([picture()])
    expect(() => mp4Index(parsed, -1)).toThrow(RangeError)
    expect(() => mp4Index(parsed, 1.5)).toThrow(RangeError)
    expect(() => mp4Index(parsed, NaN)).toThrow(RangeError)
  })

  it("makes a first sound that fails an offer of its refusal, with chooseTracks's own sentence, and plays none", () => {
    // PCM: no browser's Media Source takes it in MP4.
    const tracks = [picture(), sound({ id: 2, entries: [audioEntry('sowt')] })]
    const wanted = chosenRefusal(tracks)
    expect(wanted.reason).toBe('unsupported-codec')
    const index = mp4Index(read(tracks), FILE_SIZE)
    expect(index.sound).toBeNull()
    expect(index.sounds).toHaveLength(1)
    const offer = must(index.sounds[0])
    expect(offer.id).toBe(2)
    const given = turnedAway(offer)
    expect(given).toBeInstanceOf(Mp4Error)
    expect(given.reason).toBe('unsupported-codec')
    expect(given.message).toBe(wanted.message)
    expect(given.message).toContain(SOUND_SENTENCE)
    expect(given.message).toContain('sowt')
  })

  it("refuses a first sound that fails by the cheapest rule first, as playTrack does, and doesn't try the next", () => {
    const failing: { tracks: TrackSpec[]; reason: Mp4Refusal }[] = [
      { tracks: [picture(), sound({ id: 2, tables: wrongTables() })], reason: 'damaged' },
      {
        tracks: [picture(), sound({ id: 2, entries: [AAC, AAC], tables: wrongTables() })],
        reason: 'several-descriptions',
      },
      {
        tracks: [
          picture(),
          sound({
            id: 2,
            edits: { version: 0, edits: [{ duration: 1, mediaTime: 0, rate: 0x8000 }] },
          }),
        ],
        reason: 'edit-list',
      },
    ]
    for (const { tracks, reason } of failing) {
      const wanted = chosenRefusal(tracks)
      expect(wanted.reason).toBe(reason)
      const index = mp4Index(read([...tracks, sound({ id: 3 })]), FILE_SIZE)
      expect(index.sound).toBeNull()
      expect(turnedAway(index.sounds[0]).message).toBe(wanted.message)
      // The sound after it is an offer, but it isn't the one that plays.
      expect(playable(index.sounds[1]).id).toBe(3)
    }
  })

  it('leaves out a first sound with no frames, which is no sound, and plays none', () => {
    const index = mp4Index(read([picture(), emptySound({ id: 2 })]), FILE_SIZE)
    expect(index.sound).toBeNull()
    expect(index.sounds).toEqual([])
    // The rules come first: an empty sound that the player couldn't take is a reason all the same.
    const pcm = mp4Index(
      read([picture(), emptySound({ id: 2, entries: [audioEntry('sowt')] })]),
      FILE_SIZE,
    )
    expect(pcm.sound).toBeNull()
    expect(turnedAway(pcm.sounds[0]).reason).toBe('unsupported-codec')
  })
})

describe('the sounds of an MP4 after the first (§10.4)', () => {
  /** A count of frames that no track may have: 2^22 + 1. */
  const TOO_MANY = 2 ** 22 + 1

  const flac = audioEntry('fLaC', {}, dfLa())
  const tracks = [
    picture(),
    sound({ id: 2, language: 'eng' }),
    // Offered by its names, though its frames are more than a track may have.
    sound({
      id: 3,
      language: 'deu',
      entries: [audioEntry('Opus', {}, dOps())],
      tables: [
        stts([[TOO_MANY, 1000]]),
        stsz({ size: 1, count: TOO_MANY }),
        stsc([[1, TOO_MANY]]),
        stco([0]),
      ],
    }),
    // Offered by its names, though its tables disagree.
    sound({ id: 4, language: 'spa', entries: [flac], tables: wrongTables() }),
    // Refused by what the entry says.
    sound({ id: 5, entries: [audioEntry('sowt')] }),
    sound({ id: 6, entries: [AAC, AAC] }),
    sound({ id: 7, stbl: box('stbl', stsd([AAC], 2)) }),
    sound({ id: 8, entries: [] }),
  ]
  const index = mp4Index(read(tracks), FILE_SIZE)

  it('offers each sound, in the order of the file, with the names it is played by and its language', () => {
    expect(index.sounds.map((offer) => offer.id)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(index.sounds[0]).toEqual({
      id: 2,
      language: 'eng',
      codecNames: ['mp4a.40.2'],
      codec: 'mp4a.40.2',
    })
    expect(index.sounds[1]).toEqual({
      id: 3,
      language: 'deu',
      codecNames: ['opus', 'Opus'],
      codec: 'opus',
    })
    expect(index.sounds[2]).toEqual({
      id: 4,
      language: 'spa',
      codecNames: ['flac', 'fLaC'],
      codec: 'flac',
    })
  })

  it("plays the first, and doesn't expand the others: a track of more frames than a track may have is offered", () => {
    expect(index.sound?.header.id).toBe(2)
    expect(index.sound?.table.count).toBe(4)
    // Nothing in the index holds the frames of a later sound.
    expect(playable(index.sounds[1]).codecNames).toEqual(['opus', 'Opus'])
  })

  it('gives each later sound that cannot play the refusal that playTrack gives it, as chooseTracks would say it for a first one', () => {
    const cases: [number, Mp4Refusal][] = [
      [5, 'unsupported-codec'],
      [6, 'several-descriptions'],
      [7, 'damaged'],
      [8, 'damaged'],
    ]
    for (const [id, reason] of cases) {
      const offer = must(index.sounds.find((one) => one.id === id))
      const given = turnedAway(offer)
      expect(given).toBeInstanceOf(Mp4Error)
      expect(given.reason).toBe(reason)
      const wanted = chosenRefusal([picture(), must(tracks.find((one) => one.id === id))])
      // A track's problem names the offset of the box in the moov, which is another in another movie.
      expect(given.message.replaceAll(/offset \d+/g, 'offset N')).toBe(
        wanted.message.replaceAll(/offset \d+/g, 'offset N'),
      )
      expect(given.message.startsWith(SOUND_SENTENCE)).toBe(true)
    }
  })

  it('expands a later sound when it is asked for, and refuses it with the sentence of its frames', () => {
    const wanted = chosenRefusal([picture(), must(tracks[2])])
    expect(wanted.reason).toBe('damaged')
    const error = refusal('damaged', () => mp4Sound(index, 3))
    expect(error.message).toBe(wanted.message)
    expect(error.message.startsWith(SOUND_SENTENCE)).toBe(true)
    // It is the count that is refused, 4 194 305 frames where a track may have 4 194 304.
    expect(error.message).toContain('4194305')
    // Its tables disagree: refused only when asked for.
    refusal('damaged', () => mp4Sound(index, 4))
    // And a sound that was refused before is refused again, with the same sentence.
    expect(refusal('unsupported-codec', () => mp4Sound(index, 5)).message).toBe(
      turnedAway(index.sounds[3]).message,
    )
  })

  it('gives the track that chooseTracks gives for a sound that plays, whichever it is', () => {
    const later = mp4Sound(
      mp4Index(read([picture(), sound({ id: 2 }), sound({ id: 3 })]), FILE_SIZE),
      3,
    )
    const alone = chooseTracks(read([picture(), sound({ id: 3 })]), FILE_SIZE).audio
    expect(later).toEqual(alone)
    expect(mp4Sound(index, 2)).toEqual(index.sound)
  })

  it('refuses an id that is no sound track of the file as a mistake of the caller', () => {
    expect(() => mp4Sound(index, 99)).toThrow(RangeError)
    // The picture's id is not a sound's.
    expect(() => mp4Sound(index, 1)).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// A built MP4: its frames are laid out in a file, so that they can be read.

const PICTURE_COUNT = 12
const SOUND_COUNT = 40
/** Frames of 0.1 s and 0.03 s, at 1000 ticks a second. */
const PICTURE_TICKS = 100
const SOUND_TICKS = 30
/** The picture's keyframes, as the 1-based numbers `stss` holds: the frames 0, 4 and 9. */
const KEYFRAMES = [1, 5, 10]

const PICTURE_SIZES = Array.from({ length: PICTURE_COUNT }, (_, at) => 300 + 7 * at)
const SOUND_SIZES = Array.from({ length: SOUND_COUNT }, (_, at) => 150 + at)

/** A built file, and where its frames are. */
interface Built {
  bytes: Uint8Array
  /** The offset of each frame of the picture and of the sound. */
  pictureAt: number[]
  soundAt: number[]
  /** The moov, from its header to its end. */
  moov: ByteRange
}

/** The picture (track 1) and the sound (track 2) as tracks of a moov, their frames at these offsets one to a chunk. */
function builtTracks(pictureAt: number[], soundAt: number[]): TrackSpec[] {
  return [
    {
      id: 1,
      handler: 'vide',
      timescale: 1000,
      width: 320,
      height: 240,
      entries: [PICTURE],
      tables: [
        stts([[PICTURE_COUNT, PICTURE_TICKS]]),
        stsz(PICTURE_SIZES),
        stsc([[1, 1]]),
        stco(pictureAt),
        stss(KEYFRAMES),
      ],
    },
    {
      id: 2,
      handler: 'soun',
      timescale: 1000,
      language: 'eng',
      entries: [AAC],
      tables: [
        stts([[SOUND_COUNT, SOUND_TICKS]]),
        stsz(SOUND_SIZES),
        stsc([[1, 1]]),
        stco(soundAt),
      ],
    },
  ]
}

/**
 * A file of an `ftyp`, an `mdat` with the frames of the picture and of the sound
 * in the order they are shown (the picture's first when two are shown at once),
 * and the `moov`, last as a phone writes it or, with `moovFirst`, before the
 * `mdat`. A frame holds bytes that name it: 0x10 + its number for the picture, 0x80 +
 * its number for the sound.
 */
function builtFile(moovFirst: boolean): Built {
  const order = [
    ...PICTURE_SIZES.map((size, at) => ({ picture: true, at, size, time: at * PICTURE_TICKS })),
    ...SOUND_SIZES.map((size, at) => ({ picture: false, at, size, time: at * SOUND_TICKS })),
  ].sort((a, b) => a.time - b.time || (a.picture === b.picture ? 0 : a.picture ? -1 : 1))

  const zeros = (count: number): number[] => new Array<number>(count).fill(0)
  const ftyp = box('ftyp', fourcc('isom'), u32(0), fourcc('isom'))
  // The moov is as long whatever the offsets in it are, so it is built once to measure.
  const length = movie({
    timescale: 1000,
    tracks: builtTracks(zeros(PICTURE_COUNT), zeros(SOUND_COUNT)),
  }).length
  const dataStart = ftyp.length + (moovFirst ? length : 0) + 8

  const pictureAt = zeros(PICTURE_COUNT)
  const soundAt = zeros(SOUND_COUNT)
  let at = dataStart
  for (const frame of order) {
    ;(frame.picture ? pictureAt : soundAt)[frame.at] = at
    at += frame.size
  }
  const payload = new Uint8Array(at - dataStart)
  for (const frame of order) {
    const start = (frame.picture ? pictureAt : soundAt)[frame.at] ?? 0
    payload.fill(
      (frame.picture ? 0x10 : 0x80) + frame.at,
      start - dataStart,
      start - dataStart + frame.size,
    )
  }
  const mdat = box('mdat', payload)
  const moov = movie({ timescale: 1000, tracks: builtTracks(pictureAt, soundAt) })
  expect(moov.length).toBe(length)

  const bytes = moovFirst ? concat(ftyp, moov, mdat) : concat(ftyp, mdat, moov)
  const start = moovFirst ? ftyp.length : ftyp.length + mdat.length
  return { bytes, pictureAt, soundAt, moov: { start, end: start + moov.length } }
}

describe('opening an MP4 (§10.4)', () => {
  it('is done in one call when the head holds the moov, with what readMovie and chooseTracks give', () => {
    const file = builtFile(true)
    const { index, asks } = open(file.bytes)
    expect(asks).toEqual([])
    const opened = mp4Of(index)
    const parsed = readMovie(file.bytes.subarray(file.moov.start, file.moov.end))
    const chosen = chooseTracks(parsed, file.bytes.length)
    expect(opened.fileSize).toBe(file.bytes.length)
    expect(opened.movie).toEqual(parsed)
    expect(opened.video).toEqual(chosen.video)
    expect(opened.sound).toEqual(chosen.audio)
    expect(opened.video.table.count).toBe(PICTURE_COUNT)
    expect(must(opened.sound).table.count).toBe(SOUND_COUNT)
    expect(opened.sounds).toEqual([
      { id: 2, language: 'eng', codecNames: ['mp4a.40.2'], codec: 'mp4a.40.2' },
    ])
    expect(opened.durationSeconds).toBeCloseTo(1.2, 9)
  })

  it('asks for the moov when it is at the end of a file the head stops short of, and then is done', () => {
    const file = builtFile(false)
    // The head ends inside the mdat.
    const { index, asks } = open(file.bytes, 300)
    expect(asks).toEqual([file.moov])
    expect(mp4Of(index).video.table.count).toBe(PICTURE_COUNT)
    // The same index as when the head holds all of it.
    expect(mp4Of(open(file.bytes).index).video).toEqual(mp4Of(index).video)
  })

  it("doesn't ask for a moov that the chunks hold, even when they hold it in two", () => {
    const file = builtFile(false)
    const middle = Math.floor((file.moov.start + file.moov.end) / 2)
    const chunks: Chunk[] = [
      { start: 0, bytes: file.bytes.subarray(0, 300) },
      { start: file.moov.start, bytes: file.bytes.subarray(file.moov.start, middle) },
      { start: middle, bytes: file.bytes.subarray(middle) },
    ]
    const step = openSource(chunks, file.bytes.length)
    expect('done' in step).toBe(true)
  })

  it('refuses a file with no moov, with the sentence the corpus tooling gives', () => {
    const file = builtFile(false)
    const noIndex = file.bytes.subarray(0, file.moov.start)
    const error = refusal('damaged', () =>
      openSource([{ start: 0, bytes: noIndex }], noIndex.length),
    )
    expect(error.message).toBe('No moov was found in the file.')
  })

  it('refuses a file in fragments, as locateMoov does', () => {
    const fragmented = concat(
      box('ftyp', fourcc('isom'), u32(0), fourcc('isom')),
      box('moov'),
      box('moof'),
    )
    refusal('fragmented', () => openSource([{ start: 0, bytes: fragmented }], fragmented.length))
  })

  it('refuses a file that is neither MP4 nor Matroska', () => {
    const other = Uint8Array.from({ length: 64 }, (_, at) => (at * 37 + 11) & 0xff)
    const error = refusal('damaged', () => openSource([{ start: 0, bytes: other }], other.length))
    expect(error.message).toBe('The file is neither MP4 nor Matroska.')
    refusal('damaged', () => openSource([{ start: 0, bytes: new Uint8Array(0) }], 0))
  })

  it('refuses a first chunk that does not start at 0, and a caller with no chunk, as mistakes of the caller', () => {
    const file = builtFile(true)
    expect(() =>
      openSource([{ start: 1, bytes: file.bytes.subarray(1) }], file.bytes.length),
    ).toThrow(RangeError)
    expect(() => openSource([], file.bytes.length)).toThrow(RangeError)
    expect(() => openSource([{ start: 0, bytes: file.bytes }], -1)).toThrow(RangeError)
  })
})

describe('the frames a chunk of an MP4 completes (§10.4)', () => {
  const file = builtFile(false)
  const index = mp4Of(open(file.bytes).index)
  const sounds = must(index.sound)
  const bytesAt = (offset: number, size: number): Uint8Array =>
    file.bytes.subarray(offset, offset + size)

  it('starts at the first frame of each track, and asks for the least offset of the two', () => {
    const cursor = mp4Cursor(startCursor(index, 2))
    expect(cursor).toEqual({ container: 'mp4', sound: 2, videoFrame: 0, soundFrame: 0 })
    // The picture's first frame and the sound's are both at the start of the mdat, the picture's first.
    expect(nextRead(index, cursor)).toBe(file.pictureAt[0])
    expect(file.pictureAt[0]).toBeLessThan(must(file.soundAt[0]))
    // Without the sound only the picture's frames are asked for.
    expect(mp4Cursor(startCursor(index, null))).toEqual({
      container: 'mp4',
      sound: null,
      videoFrame: 0,
      soundFrame: 0,
    })
  })

  it('gives, over the file in chunks of 1 KiB read from where it asks, slices whose fragments equal those of the track', () => {
    let cursor = startCursor(index, 2)
    let pictureFrom = 0
    let soundFrom = 0
    let calls = 0
    const picture = { header: { id: 1 }, table: index.video.table }
    const whole = { header: { id: 2 }, table: sounds.table }
    for (let at = nextRead(index, cursor); at !== null; at = nextRead(index, cursor)) {
      const chunk = { start: at, bytes: file.bytes.subarray(at, at + 1024) }
      const before = mp4Cursor(cursor)
      const given = framesIn(index, cursor, chunk)
      const after = mp4Cursor(given.cursor)
      expect(given.skipped).toEqual([])
      // Every frame taken lies inside the chunk.
      for (const track of given.frames) {
        for (let i = 0; i < track.table.count; i += 1) {
          expect(track.table.offsets[i]).toBeGreaterThanOrEqual(chunk.start)
          expect((track.table.offsets[i] ?? 0) + (track.table.sizes[i] ?? 0)).toBeLessThanOrEqual(
            chunk.start + chunk.bytes.length,
          )
        }
      }
      // The picture's slice comes first, then the sound's, each from where its cursor was to where it is.
      const expected: { id: number; from: number; to: number }[] = []
      if (after.videoFrame > before.videoFrame) {
        expected.push({ id: 1, from: before.videoFrame, to: after.videoFrame })
      }
      if (after.soundFrame > before.soundFrame) {
        expected.push({ id: 2, from: before.soundFrame, to: after.soundFrame })
      }
      expect(given.frames.map((track) => track.header.id)).toEqual(expected.map((one) => one.id))
      for (const [which, track] of given.frames.entries()) {
        const { id, from, to } = must(expected[which])
        const full = id === 1 ? picture : whole
        expect(from).toBe(id === 1 ? pictureFrom : soundFrom)
        expect(track.table.count).toBe(to - from)
        expect(fragment(track, 0, track.table.count, 7, bytesAt)).toEqual(
          fragment(full, from, to, 7, bytesAt),
        )
        if (id === 1) pictureFrom = to
        else soundFrom = to
      }
      // The cursor never goes back, and moves.
      expect(after.videoFrame).toBeGreaterThanOrEqual(before.videoFrame)
      expect(after.soundFrame).toBeGreaterThanOrEqual(before.soundFrame)
      expect(given.frames.length).toBeGreaterThan(0)
      // The cursor given is not changed.
      expect(before).toEqual(cursor)
      cursor = given.cursor
      calls += 1
      expect(calls).toBeLessThan(100)
    }
    // Every frame of each track was given once, in order.
    expect(pictureFrom).toBe(PICTURE_COUNT)
    expect(soundFrom).toBe(SOUND_COUNT)
    expect(calls).toBeGreaterThan(5)
    expect(nextRead(index, cursor)).toBeNull()
  })

  it('takes frames as slices of the track: views onto its arrays, not copies', () => {
    const cursor = startCursor(index, 2)
    const given = framesIn(index, cursor, { start: 0, bytes: file.bytes })
    const [first, second] = given.frames
    expect(first?.table.count).toBe(PICTURE_COUNT)
    expect(second?.table.count).toBe(SOUND_COUNT)
    expect(first?.table.offsets.buffer).toBe(index.video.table.offsets.buffer)
    expect(second?.table.offsets.buffer).toBe(sounds.table.offsets.buffer)
    expect(first?.prefix).toBeUndefined()
    expect(nextRead(index, given.cursor)).toBeNull()
  })

  it("gives nothing, and doesn't move, when the chunk holds no frame whole, and asks for the same again", () => {
    const cursor = startCursor(index, 2)
    const at = must(nextRead(index, cursor))
    // One byte short of the picture's first frame.
    const short = { start: at, bytes: file.bytes.subarray(at, at + (PICTURE_SIZES[0] ?? 0) - 1) }
    const given = framesIn(index, cursor, short)
    expect(given.frames).toEqual([])
    expect(given.cursor).toEqual(cursor)
    expect(nextRead(index, given.cursor)).toBe(at)
    // A chunk that starts after the frame cannot complete it either, though it holds the frames of the sound that follow.
    const after = { start: at + 1, bytes: file.bytes.subarray(at + 1) }
    expect(framesIn(index, startCursor(index, null), after).frames).toEqual([])
    expect(framesIn(index, cursor, after).frames.map((track) => track.header.id)).toEqual([2])
  })

  it('stops at the first frame of a track that is not whole, and leaves the track after it for the next chunk', () => {
    // A chunk from the first frame to one byte short of the end of the picture's frame 1: frame 0 only.
    const cursor = startCursor(index, null)
    const start = must(file.pictureAt[0])
    const end = must(file.pictureAt[1]) + must(PICTURE_SIZES[1]) - 1
    const given = framesIn(index, cursor, { start, bytes: file.bytes.subarray(start, end) })
    expect(given.frames).toHaveLength(1)
    expect(given.frames[0]?.table.count).toBe(1)
    expect(mp4Cursor(given.cursor)).toEqual({
      container: 'mp4',
      sound: null,
      videoFrame: 1,
      soundFrame: 0,
    })
    expect(nextRead(index, given.cursor)).toBe(file.pictureAt[1])
  })

  it('leaves the sound out when the cursor has none, though the file has one', () => {
    const cursor = startCursor(index, null)
    const given = framesIn(index, cursor, { start: 0, bytes: file.bytes })
    expect(given.frames.map((track) => track.header.id)).toEqual([1])
    expect(mp4Cursor(given.cursor).soundFrame).toBe(0)
    expect(nextRead(index, given.cursor)).toBeNull()
  })

  it('asks for the least offset of the next frames of the two tracks, and for none when both are done', () => {
    const cursor = (videoFrame: number, soundFrame: number, id: number | null = 2): Cursor => ({
      container: 'mp4',
      sound: id,
      videoFrame,
      soundFrame,
    })
    const first = (a: number | undefined, b: number | undefined): number =>
      Math.min(must(a), must(b))
    expect(nextRead(index, cursor(3, 7))).toBe(first(file.pictureAt[3], file.soundAt[7]))
    expect(nextRead(index, cursor(11, 0))).toBe(first(file.pictureAt[11], file.soundAt[0]))
    // The picture's done: the sound's next frame.
    expect(nextRead(index, cursor(PICTURE_COUNT, 5))).toBe(file.soundAt[5])
    // The sound's done: the picture's.
    expect(nextRead(index, cursor(2, SOUND_COUNT))).toBe(file.pictureAt[2])
    // Both done.
    expect(nextRead(index, cursor(PICTURE_COUNT, SOUND_COUNT))).toBeNull()
    // A sound that does not play is not asked for, wherever its cursor is.
    expect(nextRead(index, cursor(PICTURE_COUNT, 5, null))).toBeNull()
    expect(nextRead(index, cursor(4, 5, null))).toBe(file.pictureAt[4])
  })

  it('does not expect frames to ascend in the file: the least offset is the one asked for', () => {
    // Frames 0 and 1 of the picture are at 2000 and 1000 in a file of a mebibyte.
    const parsed = read([
      picture({
        tables: [
          stts([[4, 1000]]),
          stsz([10, 20, 30, 40]),
          stsc([[1, 1]]),
          stco([2000, 1000, 3000, 4000]),
          stss([1, 3]),
        ],
      }),
    ])
    const reversed = mp4Index(parsed, FILE_SIZE)
    expect(nextRead(reversed, startCursor(reversed, null))).toBe(2000)
    const second: Cursor = { container: 'mp4', sound: null, videoFrame: 1, soundFrame: 0 }
    expect(nextRead(reversed, second)).toBe(1000)
  })
})

describe('starting an MP4 for a sound (§10.4)', () => {
  const later = mp4Index(read([picture(), sound({ id: 2 }), sound({ id: 3 })]), FILE_SIZE)

  it('takes the sound that plays, or none', () => {
    expect(mp4Cursor(startCursor(later, 2)).sound).toBe(2)
    expect(mp4Cursor(startCursor(later, null)).sound).toBeNull()
  })

  it("refuses another sound's id, and says to make an index with that sound", () => {
    let message = ''
    try {
      startCursor(later, 3)
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError)
      message = (error as RangeError).message
    }
    expect(message).toContain('mp4Sound')
    // An id that is no sound of the file at all.
    expect(() => startCursor(later, 99)).toThrow(RangeError)
    // A file that plays none takes no id.
    const silent = mp4Index(read([picture()]), FILE_SIZE)
    expect(() => startCursor(silent, 2)).toThrow(RangeError)
    expect(mp4Cursor(startCursor(silent, null)).sound).toBeNull()
  })

  it('takes the later sound once the index is made with it, as the message says', () => {
    const chosen = { ...later, sound: mp4Sound(later, 3) }
    const cursor = mp4Cursor(startCursor(chosen, 3))
    expect(cursor.sound).toBe(3)
    const given = framesIn(chosen, cursor, { start: 0, bytes: new Uint8Array(FILE_SIZE) })
    expect(given.frames.map((track) => track.header.id)).toEqual([1, 3])
  })

  it('refuses a cursor or an index of the other container as a mistake of the caller', () => {
    const matroska = matroskaCursorAndIndex()
    expect(() => framesIn(later, matroska.cursor, { start: 0, bytes: new Uint8Array(8) })).toThrow(
      RangeError,
    )
    expect(() => nextRead(later, matroska.cursor)).toThrow(RangeError)
    const own = startCursor(later, null)
    expect(() => framesIn(matroska.index, own, { start: 0, bytes: new Uint8Array(8) })).toThrow(
      RangeError,
    )
    expect(() => nextRead(matroska.index, own)).toThrow(RangeError)
  })
})

describe('seeking in an MP4 (§10.4)', () => {
  // A picture of 12 frames of 0.1 s with keyframes at the frames 0, 4 and 9 (0, 0.4 and 0.9 s), and a sound of 40 frames of 0.03 s, in one chunk each.
  const at = (tracks: TrackSpec[]): Mp4Index => mp4Index(read(tracks), FILE_SIZE)
  const tables = (frames: number, ticks: number, keyframes?: number[]): Uint8Array[] => [
    stts([[frames, ticks]]),
    stsz({ size: 10, count: frames }),
    stsc([[1, frames]]),
    stco([1000]),
    ...(keyframes ? [stss(keyframes)] : []),
  ]
  const clip = (extra: TrackSpec = {}): Mp4Index =>
    at([
      picture({ timescale: 1000, tables: tables(PICTURE_COUNT, PICTURE_TICKS, KEYFRAMES) }),
      sound({ id: 2, timescale: 1000, tables: tables(SOUND_COUNT, SOUND_TICKS), ...extra }),
    ])
  const index = clip()

  /** Seeks, which an MP4 does at once, and gives the cursor. */
  function seek(
    of: Mp4Index,
    seconds: number,
    id: number | null = 2,
  ): { videoFrame: number; soundFrame: number; sound: number | null } {
    const step = seekCursor(of, seconds, id, [])
    if (!('done' in step)) throw new Error('an MP4 seek asked for a read')
    const cursor = mp4Cursor(step.done)
    expect(cursor.container).toBe('mp4')
    return { videoFrame: cursor.videoFrame, soundFrame: cursor.soundFrame, sound: cursor.sound }
  }

  it('is done at once, with no read, at the keyframe at or before the time', () => {
    // Before the second keyframe, at it, and between it and the third.
    expect(seek(index, 0.39).videoFrame).toBe(0)
    expect(seek(index, 0.4).videoFrame).toBe(4)
    expect(seek(index, 0.5).videoFrame).toBe(4)
    expect(seek(index, 0.9).videoFrame).toBe(9)
  })

  it('goes to the first keyframe before the start and to the last past the end', () => {
    expect(seek(index, 0).videoFrame).toBe(0)
    expect(seek(index, -5).videoFrame).toBe(0)
    expect(seek(index, -Infinity).videoFrame).toBe(0)
    expect(seek(index, 100).videoFrame).toBe(9)
    expect(seek(index, Infinity).videoFrame).toBe(9)
  })

  it("takes the sound frame decoded at the keyframe's time when there is one, and else the one before it (M1)", () => {
    // The keyframe at 0.9 s: the sound frame 30 is decoded at 30 x 0.03 = 0.9 s exactly.
    expect(seek(index, 0.95)).toEqual({ videoFrame: 9, soundFrame: 30, sound: 2 })
    // The keyframe at 0.4 s: the sound frames 13 and 14 are decoded at 0.39 and 0.42 s, and 13 covers it.
    expect(seek(index, 0.5)).toEqual({ videoFrame: 4, soundFrame: 13, sound: 2 })
    // The first keyframe, at 0: the sound frame 0, decoded at 0.
    expect(seek(index, 0)).toEqual({ videoFrame: 0, soundFrame: 0, sound: 2 })
    expect(seek(index, 100)).toEqual({ videoFrame: 9, soundFrame: 30, sound: 2 })
  })

  it("never goes below the sound's first frame: a sound that starts after the keyframe starts from its first", () => {
    // The sound starts 0.05 s late (an empty edit of 50 ms): its first frame is decoded at 0.05 s, after the keyframe at 0.
    const late = clip({
      timescale: 1000,
      edits: {
        version: 0,
        edits: [
          { duration: 50, mediaTime: -1 },
          { duration: 1200, mediaTime: 0 },
        ],
      },
    })
    expect(seek(late, 0).soundFrame).toBe(0)
    // The keyframe at 0.4 s: the frames are decoded at 0.05 + 0.03 n, which is 0.38 s for 11 and 0.41 s for 12.
    expect(seek(late, 0.5).soundFrame).toBe(11)
  })

  it('takes the sound frame that covers the keyframe when the sound starts early, with a priming edit', () => {
    // A priming edit: the media edit starts 30 ticks into the sound, so the offset is -0.03 s and the frame 1 is decoded at 0.
    const primed = clip({
      timescale: 1000,
      edits: { version: 0, edits: [{ duration: 1170, mediaTime: 30 }] },
    })
    expect(seek(primed, 0).soundFrame).toBe(1)
  })

  it('has no sound frame to start when the cursor has no sound', () => {
    expect(seek(index, 0.5, null)).toEqual({ videoFrame: 4, soundFrame: 0, sound: null })
  })

  it('refuses a time that is no number, and a sound that the index does not play', () => {
    expect(() => seekCursor(index, NaN, 2, [])).toThrow(RangeError)
    expect(() => seekCursor(index, 0, 3, [])).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// A file of Matroska through the same functions.

/** The uncompressed header of a profile 0 VP9 keyframe: frame marker, profile 0, a keyframe, the sync code, 8 bits and color_space 0 with a limited range. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

/** An OpusHead (RFC 7845 §5.1): stereo at 48 kHz with a pre-skip of 312 samples. */
function opusHead(): Uint8Array {
  const out = new Uint8Array(19)
  out.set(Array.from('OpusHead', (letter) => letter.charCodeAt(0)))
  const data = new DataView(out.buffer)
  out[8] = 1
  out[9] = 2
  data.setUint16(10, 312, true)
  data.setUint32(12, 48000, true)
  return out
}

const VP9: MatroskaTrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

const OPUS: MatroskaTrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_OPUS',
  codecPrivate: opusHead(),
  codecDelay: 6_500_000,
  seekPreRoll: 80_000_000,
  defaultDuration: 20_000_000,
  audio: { samplingFrequency: 48000, channels: 2 },
}

/** A WebM of VP9 and Opus in two clusters, a keyframe at the start of each. */
function webm(): Uint8Array {
  const key = concat(VP9_KEYFRAME, new Uint8Array(3))
  return matroskaMovie({
    docType: 'webm',
    scale: 1_000_000,
    duration: 4000,
    tracks: [VP9, OPUS],
    clusters: [
      {
        timestamp: 0,
        frames: [
          { track: 1, time: 0, keyframe: true, data: key },
          { track: 2, time: 0, keyframe: true },
          { track: 1, time: 33 },
          { track: 2, time: 20, keyframe: true },
          { track: 1, time: 67 },
          { track: 2, time: 40, keyframe: true },
        ],
      },
      {
        timestamp: 2000,
        frames: [
          { track: 1, time: 2000, keyframe: true, data: key },
          { track: 2, time: 2000, keyframe: true },
          { track: 1, time: 2033 },
          { track: 2, time: 2020, keyframe: true },
        ],
      },
    ],
  }).bytes
}

function matroskaCursorAndIndex(): { index: SourceIndex; cursor: Cursor } {
  const bytes = webm()
  const { index } = open(bytes)
  return { index, cursor: startCursor(index, 2) }
}

describe('a Matroska file through the same functions (§10.4)', () => {
  const bytes = webm()

  it('is opened by readMatroska', () => {
    const { index, asks } = open(bytes)
    expect(asks).toEqual([])
    const wanted = readMatroska([{ start: 0, bytes }], bytes.length)
    if (!('done' in wanted)) throw new Error('expected an index')
    expect(index.container).toBe('matroska')
    expect(index.durationSeconds).toBe(wanted.done.durationSeconds)
    expect(index.video.codec).toBe(wanted.done.video.codec)
    expect(index.sounds).toEqual(wanted.done.sounds)
    expect(index.sound?.header.id).toBe(2)
  })

  it('refuses what Matroska refuses, as a refusal', () => {
    // The EBML header and nothing more: no Segment.
    const header = bytes.subarray(0, 40)
    refusal('damaged', () => openSource([{ start: 0, bytes: header }], header.length))
  })

  it('starts, reads and ends as matroskaStart and matroskaFrames do', () => {
    const { index } = open(bytes)
    if (index.container !== 'matroska') throw new Error('expected the index of a Matroska file')
    const cursor = startCursor(index, 2)
    expect(cursor).toEqual(matroskaStart(index, 2))
    expect(nextRead(index, cursor)).toBe(index.firstCluster)
    const whole = { start: 0, bytes }
    const given = framesIn(index, cursor, whole)
    const wanted = matroskaFrames(index, matroskaStart(index, 2), whole)
    expect(given.frames).toEqual(wanted.frames)
    expect(given.cursor).toEqual(wanted.cursor)
    expect(given.skipped).toEqual(wanted.skipped)
    expect(given.frames.length).toBeGreaterThan(0)
    // The file is all read: nothing more to ask for.
    expect(nextRead(index, given.cursor)).toBeNull()
    // A cursor for no sound.
    const silent = framesIn(index, startCursor(index, null), whole)
    expect(silent.frames.every((track) => track.header.id === 1)).toBe(true)
  })

  it('seeks as matroskaSeek does, needing a read or not', () => {
    const { index } = open(bytes)
    if (index.container !== 'matroska') throw new Error('expected the index of a Matroska file')
    const step = seekCursor(index, 2.01, 2, [{ start: 0, bytes }])
    if (!('done' in step)) throw new Error('the seek asked for a read')
    expect(step.done.container).toBe('matroska')
    // It lands at the second cluster, whose keyframe is at 2 s.
    expect(nextRead(index, step.done)).toBeGreaterThan(index.firstCluster)
    expect(() => seekCursor(index, 0, 7, [])).toThrow(RangeError)
  })

  it('refuses a cursor of the other container', () => {
    const { index } = open(bytes)
    const own: Mp4Cursor = { container: 'mp4', sound: null, videoFrame: 0, soundFrame: 0 }
    expect(() => framesIn(index, own, { start: 0, bytes })).toThrow(RangeError)
    expect(() => nextRead(index, own)).toThrow(RangeError)
  })
})

describe('what the package exports (§10.4)', () => {
  it('has the five functions of a source, the MP4 adapter and the Matroska reader, each by one name', () => {
    expect(api.openSource).toBe(openSource)
    expect(api.startCursor).toBe(startCursor)
    expect(api.seekCursor).toBe(seekCursor)
    expect(api.nextRead).toBe(nextRead)
    expect(api.framesIn).toBe(framesIn)
    expect(api.sniff).toBe(sniff)
    expect(api.mp4Index).toBe(mp4Index)
    expect(api.mp4Sound).toBe(mp4Sound)
    expect(api.readMatroska).toBe(readMatroska)
    expect(api.matroskaStart).toBe(matroskaStart)
    expect(api.matroskaFrames).toBe(matroskaFrames)
    expect(api.matroskaSeek).toBe(matroskaSeek)
    // The chunk helpers of the reader's first step are still there, and so is where a picture ends.
    expect(api.heldBytes).toBe(heldBytes)
    expect(api.pictureEnd).toBe(pictureEnd)
  })
})

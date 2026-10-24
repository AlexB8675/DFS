import { describe, expect, it } from 'vitest'
import { chooseTracks } from './choose.ts'
import { codecString, initEntry } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import type { Mp4Refusal } from './errors.ts'
import { frameTable } from './frames.ts'
import { readMovie } from './movie.ts'
import type { Movie } from './movie.ts'
import {
  audioEntry,
  avcC,
  box,
  ctts,
  dfLa,
  dOps,
  esds,
  frma,
  hdlr,
  mdhd,
  movie,
  quickTimeAudioEntry,
  sampleEntry,
  stco,
  stsc,
  stsd,
  stss,
  stsz,
  stts,
  trak,
  visualEntry,
  vpcC,
  wave,
} from './testing/build.ts'
import type { TrackSpec } from './testing/build.ts'

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

/** A file of a mebibyte: it holds every frame that the tables here place (the furthest ends at 270). */
const FILE_SIZE = 2 ** 20

const PICTURE = visualEntry('avc1', {}, avcC())
const SOUND = audioEntry('mp4a', {}, esds())

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
  return {
    handler: 'soun',
    timescale: 44100,
    entries: [SOUND],
    tables: goodTables(false),
    ...spec,
  }
}

/** A track that `readMovie` keeps with a `problem`, and with the kind its `hdlr` says: its `stsd` counts 2 entries and holds 1. */
function broken(handler: 'vide' | 'soun', spec: TrackSpec = {}): TrackSpec {
  return {
    handler,
    timescale: 1000,
    stbl: box('stbl', stsd([handler === 'vide' ? PICTURE : SOUND], 2)),
    ...spec,
  }
}

function read(tracks: TrackSpec[], timescale = 1000): Movie {
  return readMovie(movie({ timescale, tracks }))
}

function trackOf(parsed: Movie, index: number): Movie['tracks'][number] {
  const track = parsed.tracks[index]
  if (!track) throw new Error(`expected a track at ${index}`)
  return track
}

/** Two media edits: a list that the init segment has no way to say. */
const TWO_MEDIA_EDITS: TrackSpec['edits'] = {
  version: 0,
  edits: [
    { duration: 1000, mediaTime: 0 },
    { duration: 1000, mediaTime: 2000 },
  ],
}

/** Four frames of 3000 at 90000 a second, each shown `shown` after it is decoded: the first is shown at `shown`. */
function shownTables(shown: number): Uint8Array[] {
  return [
    stts([[4, 3000]]),
    ctts(0, [[4, shown]]),
    stss([1, 3]),
    stsz([10, 20, 30, 40]),
    stsc([[1, 2]]),
    stco([100, 200]),
  ]
}

describe('the tracks a video plays (§10.4, D45)', () => {
  it('chooses the first picture and the first sound, leaving the others unexpanded', () => {
    // The tracks that are not chosen read cleanly (no problem) but could not be expanded, so a play that expanded one would be refused.
    const parsed = read([
      { id: 7, handler: 'tmcd', entries: [sampleEntry('tmcd')], tables: wrongTables() },
      sound({ id: 3 }),
      picture({ id: 2 }),
      sound({ id: 4, entries: [audioEntry('ac-3')], tables: wrongTables() }),
      sound({ id: 5, entries: [audioEntry('ac-3'), audioEntry('ec-3')], tables: wrongTables() }),
      sound({ id: 6, tables: wrongTables() }),
    ])
    const unchosen = [0, 3, 4, 5].map((index) => trackOf(parsed, index))
    expect(parsed.tracks.map((track) => track.kind)).toEqual([
      'other',
      'audio',
      'video',
      'audio',
      'audio',
      'audio',
    ])
    for (const track of unchosen) {
      expect(track.problem).toBeNull()
      refusal('damaged', () => frameTable(track, FILE_SIZE))
    }

    const { video, audio } = chooseTracks(parsed, FILE_SIZE)
    expect(video.header.id).toBe(2)
    expect(audio?.header.id).toBe(3)
    expect(video.table.count).toBe(4)
    expect(audio?.table.count).toBe(4)
  })

  it("gives each track's header, frames, timing, codec string, init entry and keyframes", () => {
    // A QuickTime sound entry is what the init segment carries rewritten as an ISO one.
    const quickTime = quickTimeAudioEntry(
      'mp4a',
      { version: 1, channels: 2, sampleRate: 48000 },
      wave(frma('mp4a'), esds()),
    )
    const parsed = read(
      [
        picture({
          id: 1,
          // The frames are shown a second (30000 ticks) after they are decoded, so the edit starts at the first of them.
          tables: shownTables(30000),
          edits: { version: 0, edits: [{ duration: 500, mediaTime: 30000 }] },
        }),
        sound({
          id: 2,
          timescale: 48000,
          entries: [quickTime],
          edits: {
            version: 0,
            edits: [
              { duration: 250, mediaTime: -1 },
              { duration: 750, mediaTime: 0 },
            ],
          },
        }),
      ],
      1000,
    )
    const { video, audio } = chooseTracks(parsed, FILE_SIZE)

    expect(video.header).toBe(trackOf(parsed, 0))
    expect(video.table).toEqual(frameTable(trackOf(parsed, 0), FILE_SIZE))
    expect(video.codec).toBe('avc1.64001f')
    expect(video.codecNames).toEqual(['avc1.64001f'])
    expect(video.entry).toEqual(PICTURE)
    expect(Array.from(video.keyframes)).toEqual([0, 2])
    // The media edit starts a second in (30000 of 30000 a second) and ends half a second after it starts being shown.
    expect(video.timing).toEqual({ offsetSeconds: -1, endSeconds: 0.5 })

    if (!audio) throw new Error('expected a sound')
    expect(audio.header).toBe(trackOf(parsed, 1))
    expect(audio.table).toEqual(frameTable(trackOf(parsed, 1), FILE_SIZE))
    expect(audio.codec).toBe('mp4a.40.2')
    expect(audio.codecNames).toEqual(['mp4a.40.2'])
    const original = trackOf(parsed, 1).entries[0]
    if (!original) throw new Error('expected an entry')
    expect(audio.entry).toEqual(initEntry(original))
    expect(audio.entry).not.toEqual(original.bytes)
    expect(codecString({ type: 'mp4a', bytes: audio.entry, stsdVersion: 0 })).toBe('mp4a.40.2')
    // Every sound frame is a sync sample, as a table with no `stss` says.
    expect(Array.from(audio.keyframes)).toEqual([0, 1, 2, 3])
    // An empty edit of a quarter second pauses the sound before it starts.
    expect(audio.timing).toEqual({ offsetSeconds: 0.25, endSeconds: 1 })
  })

  it('names a picture in VP9 and a sound in FLAC with every name the browser may be asked about', () => {
    const parsed = read([
      picture({ entries: [visualEntry('vp09', {}, vpcC())] }),
      sound({ entries: [audioEntry('fLaC', {}, dfLa())] }),
    ])
    const { video, audio } = chooseTracks(parsed, FILE_SIZE)
    expect(video.codecNames).toEqual(['vp09.00.20.08.01.02.02.02.00', 'vp09.00.20.08'])
    expect(video.codec).toBe(video.codecNames[0])
    expect(audio?.codecNames).toEqual(['flac', 'fLaC'])
    expect(audio?.codec).toBe('flac')
    // Their entries are carried as they are.
    expect(video.entry).toEqual(visualEntry('vp09', {}, vpcC()))
    expect(audio?.entry).toEqual(audioEntry('fLaC', {}, dfLa()))
  })

  it('has no sound for a file that has none', () => {
    const { video, audio } = chooseTracks(read([picture(), { handler: 'tmcd' }]), FILE_SIZE)
    expect(video.codec).toBe('avc1.64001f')
    expect(audio).toBeNull()
  })

  it('takes the first track of each kind in the order of the movie', () => {
    const parsed = read([
      sound({ id: 10, entries: [audioEntry('mp4a', { channels: 1 }, esds())] }),
      picture({ id: 20 }),
      picture({ id: 21 }),
      sound({ id: 11 }),
    ])
    const { video, audio } = chooseTracks(parsed, FILE_SIZE)
    expect(video.header.id).toBe(20)
    expect(audio?.header.id).toBe(10)
  })

  it('plays a file whose extra track is broken', () => {
    const parsed = read([
      picture({ id: 1 }),
      sound({ id: 2 }),
      // Tracks that can't be read at all, as another picture, another sound and a timecode or a subtitle.
      broken('vide', { id: 3 }),
      broken('soun', { id: 4 }),
      { id: 5, handler: 'text', stbl: box('stbl') },
      { id: 6, handler: 'tmcd', stbl: box('stbl', stsd([sampleEntry('tmcd')], 3)) },
    ])
    expect(parsed.tracks.slice(2).every((track) => track.problem !== null)).toBe(true)
    const { video, audio } = chooseTracks(parsed, FILE_SIZE)
    expect(video.header.id).toBe(1)
    expect(audio?.header.id).toBe(2)
  })

  it('has no sound for a first sound track that has no frames', () => {
    // A SourceBuffer with nothing appended to it would stall the video at 0: a sound with nothing to play is none.
    const emptyTables = [stts([]), stsz([]), stsc([]), stco([])]
    const parsed = read([
      picture({ id: 1 }),
      sound({ id: 2, tables: emptyTables }),
      sound({ id: 3 }),
    ])
    const { video, audio } = chooseTracks(parsed, FILE_SIZE)
    expect(video.header.id).toBe(1)
    expect(audio).toBeNull()
    // The rules come first: an empty sound that the player couldn't take is a reason all the same.
    refusal('unsupported-codec', () =>
      chooseTracks(
        read([picture(), sound({ entries: [audioEntry('sowt')], tables: emptyTables })]),
        FILE_SIZE,
      ),
    )
  })

  it("puts a picture's first frame at its edit's start when the edit begins before it, as FFmpeg does", () => {
    // The first frame is shown at 21020 and the edit starts at 3204.
    const early = chooseTracks(
      read([
        picture({
          timescale: 90000,
          tables: shownTables(21020),
          edits: { version: 0, edits: [{ duration: 133, mediaTime: 3204 }] },
        }),
      ]),
      FILE_SIZE,
    )
    expect(early.video.timing.offsetSeconds).toBeCloseTo(-21020 / 90000, 12)
    expect(early.video.timing.endSeconds).toBeCloseTo(0.133, 12)

    const paused = chooseTracks(
      read([
        picture({
          timescale: 90000,
          tables: shownTables(21020),
          edits: {
            version: 0,
            edits: [
              { duration: 500, mediaTime: -1 },
              { duration: 133, mediaTime: 3204 },
            ],
          },
        }),
      ]),
      FILE_SIZE,
    )
    expect(paused.video.timing.offsetSeconds).toBeCloseTo(0.5 - 21020 / 90000, 12)
    expect(paused.video.timing.endSeconds).toBeCloseTo(0.633, 12)

    // An edit that starts exactly at the first frame's time is where it says. A sound's edit may start after its first frame (an encoder's priming comes first), and is where it says too: that is accepted for a sound and not for a picture (below).
    const later = chooseTracks(
      read([
        picture({
          timescale: 90000,
          tables: shownTables(21020),
          edits: { version: 0, edits: [{ duration: 133, mediaTime: 21020 }] },
        }),
        sound({ edits: { version: 0, edits: [{ duration: 133, mediaTime: 1024 }] } }),
      ]),
      FILE_SIZE,
    )
    expect(later.video.timing.offsetSeconds).toBeCloseTo(-21020 / 90000, 12)
    expect(later.audio?.timing.offsetSeconds).toBeCloseTo(-1024 / 44100, 12)
  })

  it('refuses a picture whose edit starts after its first frame is shown, as a stream-copy cut leaves it', () => {
    // The first frame is shown at 21020. An edit that starts later hides it, and Media Source would drop its whole GOP.
    const cut = (edits: { duration: number; mediaTime: number }[]): Movie =>
      read([
        picture({ timescale: 90000, tables: shownTables(21020), edits: { version: 0, edits } }),
      ])
    const starts = /^The picture track can't be played: The track's edit list starts /

    // One tick late is as fatal as a third of a second.
    const oneTick = refusal('edit-list', () =>
      chooseTracks(cut([{ duration: 133, mediaTime: 21021 }]), FILE_SIZE),
    )
    expect(oneTick.message).toMatch(starts)
    const far = refusal('edit-list', () =>
      chooseTracks(cut([{ duration: 133, mediaTime: 30000 }]), FILE_SIZE),
    )
    expect(far.message).toMatch(starts)
    // (30000 - 21020) / 90000 s, to the millisecond.
    expect(far.message).toContain('starts 0.1 s after its first frame is shown')
    // A leading empty edit changes where the picture is shown, not where its edit starts in the media.
    const paused = refusal('edit-list', () =>
      chooseTracks(
        cut([
          { duration: 500, mediaTime: -1 },
          { duration: 133, mediaTime: 30000 },
        ]),
        FILE_SIZE,
      ),
    )
    expect(paused.message).toMatch(starts)

    // An edit that starts at the first frame is taken, as it is after the empty edit.
    expect(
      chooseTracks(cut([{ duration: 133, mediaTime: 21020 }]), FILE_SIZE).video.timing
        .offsetSeconds,
    ).toBeCloseTo(-21020 / 90000, 12)
    expect(
      chooseTracks(
        cut([
          { duration: 500, mediaTime: -1 },
          { duration: 133, mediaTime: 21020 },
        ]),
        FILE_SIZE,
      ).video.timing.offsetSeconds,
    ).toBeCloseTo(0.5 - 21020 / 90000, 12)

    // A sound alone is not held to it: its edit starts 1024 ticks in, after its first frame, as an encoder's priming leaves it.
    const primed = chooseTracks(
      read([
        picture(),
        sound({ edits: { version: 0, edits: [{ duration: 133, mediaTime: 1024 }] } }),
      ]),
      FILE_SIZE,
    )
    expect(primed.audio?.timing.offsetSeconds).toBeCloseTo(-1024 / 44100, 12)
  })

  it('refuses a file with no picture, a chosen track with two entries, an unaccepted edit list or an unknown codec, each with its reason', () => {
    const cases: { what: string; tracks: TrackSpec[]; reason: Mp4Refusal; says?: string }[] = [
      { what: 'no tracks', tracks: [], reason: 'no-picture' },
      { what: 'a sound and no picture', tracks: [sound()], reason: 'no-picture' },
      {
        what: 'a timecode and a subtitle and no picture',
        tracks: [{ handler: 'tmcd' }, { handler: 'text' }],
        reason: 'no-picture',
      },
      {
        what: 'a picture with two sample descriptions',
        tracks: [picture({ entries: [PICTURE, PICTURE] })],
        reason: 'several-descriptions',
      },
      {
        what: 'a sound with two sample descriptions',
        tracks: [picture(), sound({ entries: [SOUND, SOUND] })],
        reason: 'several-descriptions',
      },
      {
        what: 'a picture with two media edits',
        tracks: [picture({ edits: TWO_MEDIA_EDITS })],
        reason: 'edit-list',
      },
      {
        what: 'a sound that plays at half speed',
        tracks: [
          picture(),
          sound({ edits: { version: 0, edits: [{ duration: 1000, mediaTime: 0, rate: 0x8000 }] } }),
        ],
        reason: 'edit-list',
      },
      {
        what: "a picture in a codec that no browser's Media Source takes in MP4",
        tracks: [picture({ entries: [visualEntry('mp4v')] })],
        reason: 'unsupported-codec',
        says: 'mp4v',
      },
      {
        what: "a sound in a codec that no browser's Media Source takes in MP4",
        tracks: [picture(), sound({ entries: [audioEntry('sowt')] })],
        reason: 'unsupported-codec',
        says: 'sowt',
      },
      {
        what: 'a picture with a configuration that is cut short',
        tracks: [picture({ entries: [visualEntry('avc1')] })],
        reason: 'damaged',
      },
      {
        what: 'a picture whose stsd counts more entries than it holds',
        tracks: [broken('vide')],
        reason: 'damaged',
        says: 'counts 2 entries',
      },
      {
        what: 'a sound whose stsd counts more entries than it holds',
        tracks: [picture(), broken('soun')],
        reason: 'damaged',
        says: 'counts 2 entries',
      },
      {
        what: 'a picture whose tables disagree',
        tracks: [picture({ tables: wrongTables() })],
        reason: 'damaged',
      },
      {
        what: 'a sound whose tables disagree',
        tracks: [picture(), sound({ tables: wrongTables() })],
        reason: 'damaged',
      },
      {
        what: 'a picture with no keyframe',
        tracks: [picture({ tables: [...goodTables(false), stss([])] })],
        reason: 'damaged',
        says: 'keyframe',
      },
      {
        what: 'a picture of no frames',
        tracks: [picture({ tables: [stts([]), stsz([]), stsc([]), stco([])] })],
        reason: 'damaged',
        says: 'keyframe',
      },
    ]
    for (const { what, tracks, reason, says } of cases) {
      const error = refusal(reason, () => chooseTracks(read(tracks), FILE_SIZE))
      if (says) expect(error.message, what).toContain(says)
    }
  })

  it('names the track that is refused', () => {
    expect(
      refusal('unsupported-codec', () =>
        chooseTracks(read([picture(), sound({ entries: [audioEntry('sowt')] })]), FILE_SIZE),
      ).message,
    ).toMatch(/^The sound track can't be played: /)
    expect(
      refusal('several-descriptions', () =>
        chooseTracks(read([picture({ entries: [PICTURE, PICTURE] })]), FILE_SIZE),
      ).message,
    ).toMatch(/^The picture track can't be played: /)
  })

  it('refuses a file whose first picture is broken, and does not try the next', () => {
    const parsed = read([broken('vide', { id: 1 }), picture({ id: 2 })])
    expect(trackOf(parsed, 0).kind).toBe('video')
    expect(trackOf(parsed, 0).problem).not.toBeNull()
    refusal('damaged', () => chooseTracks(parsed, FILE_SIZE))
  })

  it("refuses a file whose first picture is broken before its handler's place in the file, with that track's reason", () => {
    // Broken in `mdhd`, and in `tkhd`: both are read before the track's handler in the file's order.
    const cutTkhd = box(
      'trak',
      box('tkhd', [0, 0, 0, 0, 1, 2]),
      box(
        'mdia',
        mdhd({ timescale: 30000 }),
        hdlr('vide'),
        box('minf', box('stbl', stsd([PICTURE]))),
      ),
    )
    const files = [
      { what: 'a zero timescale', first: picture({ id: 1, timescale: 0 }), reason: /timescale/ },
      { what: 'a tkhd cut short', first: cutTkhd, reason: /runs past/ },
    ]
    for (const { what, first, reason } of files) {
      const tracks = [first, picture({ id: 2 })].map((track) =>
        track instanceof Uint8Array ? track : trak(track),
      )
      const parsed = readMovie(movie({ timescale: 1000, tracks }))
      expect(trackOf(parsed, 0).kind, what).toBe('video')
      expect(trackOf(parsed, 0).problem, what).not.toBeNull()
      expect(trackOf(parsed, 1).problem, what).toBeNull()
      const error = refusal('damaged', () => chooseTracks(parsed, FILE_SIZE))
      expect(error.message, what).toMatch(/^The picture track can't be played: /)
      expect(error.message, what).toMatch(reason)
    }
    // Where nothing says what the first track is, it is not a picture, and the second is the first.
    const nameless = box(
      'trak',
      box('tkhd', [0, 0, 0, 0, 1, 2]),
      box('mdia', mdhd({ timescale: 30000 }), box('minf', box('stbl', stsd([PICTURE])))),
    )
    const parsed = readMovie(movie({ tracks: [nameless, trak(picture({ id: 2 }))] }))
    expect(chooseTracks(parsed, FILE_SIZE).video.header.id).toBe(2)
  })

  it('refuses a file whose first sound is refused, and does not try the next', () => {
    refusal('unsupported-codec', () =>
      chooseTracks(
        read([picture(), sound({ id: 2, entries: [audioEntry('sowt')] }), sound({ id: 3 })]),
        FILE_SIZE,
      ),
    )
  })

  it('refuses for the picture before it looks at the sound', () => {
    const error = refusal('unsupported-codec', () =>
      chooseTracks(
        read([picture({ entries: [visualEntry('mp4v')] }), sound({ entries: [SOUND, SOUND] })]),
        FILE_SIZE,
      ),
    )
    expect(error.message).toContain('mp4v')
  })

  it('checks a track from the cheapest rule to the dearest, so that no frame is expanded for a track that is refused anyway', () => {
    // Tables that frameTable refuses as damaged, behind a rule that is cheaper to check: the cheaper one is the reason.
    const tables = wrongTables()
    refusal('several-descriptions', () =>
      chooseTracks(read([picture({ entries: [PICTURE, PICTURE], tables })]), FILE_SIZE),
    )
    refusal('unsupported-codec', () =>
      chooseTracks(read([picture({ entries: [visualEntry('mp4v')], tables })]), FILE_SIZE),
    )
    refusal('unsupported-codec', () =>
      chooseTracks(read([picture(), sound({ entries: [audioEntry('sowt')], tables })]), FILE_SIZE),
    )
    refusal('edit-list', () =>
      chooseTracks(read([picture({ edits: TWO_MEDIA_EDITS, tables })]), FILE_SIZE),
    )
  })

  it("refuses a track for its problem before it counts the track's descriptions", () => {
    // `readMovie` leaves no description on a track with a problem, so one is given back to this one.
    const parsed = read([picture({ entries: [PICTURE, PICTURE] })])
    const track = { ...trackOf(parsed, 0), problem: 'A box is cut short.' }
    expect(track.entries).toHaveLength(2)
    const error = refusal('damaged', () => chooseTracks({ ...parsed, tracks: [track] }, FILE_SIZE))
    expect(error.message).toContain('A box is cut short.')
  })

  it('leaves the movie timescale of 0 to the edit lists that need it', () => {
    // Without an empty edit it is not asked for, and a track with no edit list doesn't ask either.
    const plain = chooseTracks(
      read(
        [picture({ edits: { version: 0, edits: [{ duration: 500, mediaTime: 0 }] } }), sound()],
        0,
      ),
      FILE_SIZE,
    )
    expect(plain.video.timing).toEqual({ offsetSeconds: 0, endSeconds: null })
    // An empty edit is a number of movie ticks, which a timescale of 0 can't turn into seconds.
    refusal('damaged', () =>
      chooseTracks(
        read(
          [
            picture({
              edits: {
                version: 0,
                edits: [
                  { duration: 100, mediaTime: -1 },
                  { duration: 500, mediaTime: 0 },
                ],
              },
            }),
          ],
          0,
        ),
        FILE_SIZE,
      ),
    )
  })

  describe("bounds the tracks' frames by the file (§10.4)", () => {
    it('refuses tables that count 16.7 million frames a track in a file of 2000 bytes, with the track named', () => {
      // About 100 bytes of tables, and each track would be 2^24 frames of 29 bytes of arrays, a gigabyte between them.
      const count = 2 ** 24
      const tables = (): Uint8Array[] => [
        stts([[count, 1]]),
        stsz({ size: 1, count }),
        stsc([[1, count]]),
        stco([100]),
      ]
      const parsed = read([
        picture({ tables: tables() }),
        sound({
          timescale: 48000,
          entries: [audioEntry('Opus', { sampleRate: 48000 }, dOps())],
          tables: tables(),
        }),
      ])
      const error = refusal('damaged', () => chooseTracks(parsed, 2000))
      expect(error.message).toMatch(/^The picture track can't be played: /)
      expect(error.message).toMatch(/'stsz'.*16777216/)
    })

    it("refuses a track whose frames end past the file's end, and takes a file that ends with them", () => {
      // The tables of `goodTables` end at 270: chunk 2 holds 30 and 40 bytes at 200.
      const parsed = read([picture(), sound()])
      expect(chooseTracks(parsed, 270).video.table.count).toBe(4)
      const error = refusal('damaged', () => chooseTracks(parsed, 269))
      expect(error.message).toMatch(/^The picture track can't be played: .*269 bytes/)

      // The sound is held to the same size as the picture is.
      const late = read([
        picture(),
        sound({
          tables: [stts([[4, 1000]]), stsz([10, 20, 30, 40]), stsc([[1, 2]]), stco([100, 9000])],
        }),
      ])
      const sounds = refusal('damaged', () => chooseTracks(late, 270))
      expect(sounds.message).toMatch(/^The sound track can't be played: .*270 bytes/)
      expect(chooseTracks(late, 9070).audio?.table.count).toBe(4)
    })

    it('refuses a size that no file has, as a caller mistake, before it looks at the tracks', () => {
      const parsed = read([picture(), sound()])
      for (const fileSize of [-1, 1.5, NaN]) {
        expect(() => chooseTracks(parsed, fileSize), `${fileSize}`).toThrow(RangeError)
        // A file with no picture is refused for it, but not before the caller's mistake is.
        expect(() => chooseTracks(read([]), fileSize), `${fileSize}`).toThrow(RangeError)
      }
    })
  })
})

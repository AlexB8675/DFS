import { mp4Sound, openSource } from '@dfs/mp4'
import type { Mp4Index, SourceIndex } from '@dfs/mp4'
import {
  audioEntry,
  avcC,
  dOps,
  esds,
  matroskaMovie,
  movie,
  stco,
  stsc,
  stss,
  stsz,
  stts,
  visualEntry,
} from '@dfs/mp4/testing'
import type { EbmlTrackSpec, TrackSpec } from '@dfs/mp4/testing'
import { describe, expect, it } from 'vitest'
import { chooseEngineTracks } from './tracks.ts'
import type { EngineRefusal } from './tracks.ts'

// The choice of the tracks that play and of the names Media Source is asked for
// them (DESIGN.md §10.4). Every file is built in code and opened with `openSource`,
// as the engine opens one; the browser is a fake `isTypeSupported`.

const PICTURE = visualEntry('avc1', {}, avcC())
const AAC = audioEntry('mp4a', {}, esds())
const OPUS = audioEntry('Opus', {}, dOps())

/** 4 samples in 2 chunks, with keyframes at the samples 1 and 3 unless `keyframes` is false. */
function tables(keyframes = true): Uint8Array[] {
  return [
    stts([[4, 1000]]),
    stsz([10, 20, 30, 40]),
    stsc([[1, 2]]),
    stco([100, 200]),
    ...(keyframes ? [stss([1, 3])] : []),
  ]
}

function picture(over: TrackSpec = {}): TrackSpec {
  return { handler: 'vide', timescale: 30000, entries: [PICTURE], tables: tables(), ...over }
}

function sound(over: TrackSpec = {}): TrackSpec {
  return { handler: 'soun', timescale: 44100, entries: [AAC], tables: tables(false), ...over }
}

/** A sound with no frames at all. */
function emptySound(over: TrackSpec = {}): TrackSpec {
  return sound({ tables: [stts([]), stsz([]), stsc([]), stco([])], ...over })
}

/** The index of an MP4 of these tracks, opened as the engine opens one. */
function mp4Of(tracks: TrackSpec[]): Mp4Index {
  const bytes = movie({ timescale: 1000, tracks })
  const step = openSource([{ start: 0, bytes }], 2 ** 20)
  if (!('done' in step) || step.done.container !== 'mp4') throw new Error('expected an MP4 index')
  return step.done
}

/** The index of a WebM of a VP9 picture (track 1) and these sounds. */
function webmOf(sounds: EbmlTrackSpec[]): SourceIndex {
  const vp9Key = Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00)
  const file = matroskaMovie({
    docType: 'webm',
    scale: 1_000_000,
    duration: 4021,
    tracks: [
      {
        number: 1,
        type: 1,
        codecId: 'V_VP9',
        defaultDuration: 33_333_333,
        video: { pixelWidth: 320, pixelHeight: 240 },
      },
      ...sounds,
    ],
    clusters: [
      {
        timestamp: 0,
        frames: [
          { track: 1, time: 0, keyframe: true, data: vp9Key },
          ...sounds.map((one) => ({ track: one.number ?? 2, time: 0, keyframe: true })),
          { track: 1, time: 33 },
        ],
      },
    ],
  })
  const step = openSource([{ start: 0, bytes: file.bytes }], file.bytes.length)
  if (!('done' in step)) throw new Error('expected an index')
  return step.done
}

/** An OpusHead: stereo at 48 kHz with a pre-skip of 312 samples. */
const OPUS_HEAD = Uint8Array.of(
  ...Array.from('OpusHead', (letter) => letter.charCodeAt(0)),
  ...[1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0],
)

const WEBM_OPUS: EbmlTrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_OPUS',
  codecPrivate: OPUS_HEAD,
  codecDelay: 6_500_000,
  seekPreRoll: 80_000_000,
  defaultDuration: 20_000_000,
  audio: { samplingFrequency: 48000, channels: 2 },
}

/** A fake browser that takes the MIME types `takes` says, and notes each it is asked about. */
function browser(takes: (mime: string) => boolean): {
  supports: (mime: string) => boolean
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    supports: (mime) => {
      asked.push(mime)
      return takes(mime)
    },
  }
}

/** The tracks that a choice gave, which must be them and not a refusal. */
function tracksOf(
  result: ReturnType<typeof chooseEngineTracks>,
): Exclude<ReturnType<typeof chooseEngineTracks>, EngineRefusal> {
  if ('refusal' in result) throw new Error(`expected the tracks, got: ${result.refusal}`)
  return result
}

describe('the names that Media Source is asked for (§10.4)', () => {
  it('asks for video/mp4 and audio/mp4 with the names, and gives the MIME that was taken', () => {
    const index = mp4Of([picture(), sound({ id: 2 })])
    const { supports, asked } = browser(() => true)
    const result = tracksOf(chooseEngineTracks(index, supports))
    expect(result.video.kind).toBe('video')
    expect(result.video.mime).toBe(`video/mp4; codecs="${index.video.codec}"`)
    expect(result.audio?.kind).toBe('audio')
    expect(result.audio?.mime).toBe('audio/mp4; codecs="mp4a.40.2"')
    expect(asked).toEqual([result.video.mime, result.audio?.mime])
  })

  it('uses the first name that is taken, and a later one only when the earlier ones are refused', () => {
    const index = webmOf([WEBM_OPUS])
    const videoNames = index.video.codecNames
    expect(videoNames).toHaveLength(2)
    expect(index.sound?.codecNames).toEqual(['opus', 'Opus'])

    // Every name taken: the first, and none after it is asked about.
    const all = browser(() => true)
    const first = tracksOf(chooseEngineTracks(index, all.supports))
    expect(first.video.mime).toBe(`video/mp4; codecs="${videoNames[0]}"`)
    expect(first.audio?.mime).toBe('audio/mp4; codecs="opus"')
    expect(all.asked).toEqual([first.video.mime, first.audio?.mime])

    // Only the later names taken: each is asked about in turn, and the first taken wins.
    const later = browser(
      (mime) =>
        mime === `video/mp4; codecs="${videoNames[1]}"` || mime === 'audio/mp4; codecs="Opus"',
    )
    const second = tracksOf(chooseEngineTracks(index, later.supports))
    expect(second.video.mime).toBe(`video/mp4; codecs="${videoNames[1]}"`)
    expect(second.audio?.mime).toBe('audio/mp4; codecs="Opus"')
    expect(later.asked).toEqual([
      `video/mp4; codecs="${videoNames[0]}"`,
      `video/mp4; codecs="${videoNames[1]}"`,
      'audio/mp4; codecs="opus"',
      'audio/mp4; codecs="Opus"',
    ])
  })

  it('refuses a picture that the browser takes none of the names of, and names them all', () => {
    const index = webmOf([WEBM_OPUS])
    const result = chooseEngineTracks(index, (mime) => mime.startsWith('audio/'))
    expect(result).toEqual({
      refusal: `This browser's Media Source takes none of ${index.video.codecNames.join(', ')}`,
      reason: 'codec',
    })
    expect(index.video.codecNames.length).toBeGreaterThan(1)
  })

  it('refuses a picture even when the sound would play, as the sound is asked about only after it', () => {
    const index = mp4Of([picture(), sound({ id: 2 })])
    const { supports, asked } = browser((mime) => mime.startsWith('audio/'))
    expect(chooseEngineTracks(index, supports)).toEqual({
      refusal: `This browser's Media Source takes none of ${index.video.codecNames.join(', ')}`,
      reason: 'codec',
    })
    expect(asked.every((mime) => mime.startsWith('video/'))).toBe(true)
  })
})

describe('the sound that plays (§10.4)', () => {
  it('plays the index sound, and gives its id, for an MP4 and for a Matroska file', () => {
    for (const index of [mp4Of([picture(), sound({ id: 2 })]), webmOf([WEBM_OPUS])]) {
      const result = tracksOf(chooseEngineTracks(index, () => true))
      expect(result.video.track).toBe(index.video)
      expect(result.audio?.track).toBe(index.sound)
      expect(index.sound).not.toBeNull()
      expect(result.video.soundId).toBe(2)
      expect(result.audio?.soundId).toBe(2)
    }
  })

  it('refuses the play, as for the picture, when the browser takes none of the sound names', () => {
    const index = mp4Of([picture(), sound({ id: 2 })])
    const result = chooseEngineTracks(index, (mime) => mime.startsWith('video/'))
    expect(result).toEqual({
      refusal: `This browser's Media Source takes none of ${(index.sound?.codecNames ?? []).join(', ')}`,
      reason: 'codec',
    })
  })

  it("joins the sound's names with ', ' in the refusal", () => {
    const result = chooseEngineTracks(webmOf([WEBM_OPUS]), (mime) => mime.startsWith('video/'))
    expect(result).toEqual({
      refusal: "This browser's Media Source takes none of opus, Opus",
      reason: 'codec',
    })
  })

  it("gives the reader's own sentence and reason for a first sound it refuses", () => {
    // PCM: no browser's Media Source takes it in MP4, so the reader refuses it.
    const index = mp4Of([picture(), sound({ id: 2, entries: [audioEntry('sowt')] })])
    expect(index.sound).toBeNull()
    const offer = index.sounds[0]
    if (offer === undefined || !('refusal' in offer)) throw new Error('expected a refused sound')
    const { supports, asked } = browser(() => true)
    const result = chooseEngineTracks(index, supports)
    expect(result).toEqual({ refusal: offer.refusal.message, reason: offer.refusal.reason })
    expect('refusal' in result && result.reason).toBe('unsupported-codec')
    expect('refusal' in result && result.refusal).toContain('sowt')
    expect(asked.every((mime) => mime.startsWith('video/'))).toBe(true)
  })

  it('plays with no sound for a file with no sound', () => {
    const index = mp4Of([picture()])
    expect(index.sound).toBeNull()
    expect(index.sounds).toEqual([])
    const result = tracksOf(chooseEngineTracks(index, () => true))
    expect(result.audio).toBeNull()
    expect(result.video.soundId).toBeNull()
  })

  it('plays with no sound when the first sound has no frames, though a later one is playable (carry M4)', () => {
    const index = mp4Of([picture(), emptySound({ id: 2 }), sound({ id: 3 })])
    expect(index.sound).toBeNull()
    expect(index.sounds[0]).toMatchObject({ id: 3 })
    const { supports, asked } = browser(() => true)
    const result = tracksOf(chooseEngineTracks(index, supports))
    expect(result.audio).toBeNull()
    expect(result.video.soundId).toBeNull()
    expect(asked.every((mime) => mime.startsWith('video/'))).toBe(true)
  })

  it('plays with no sound when the only sound has no frames', () => {
    const index = mp4Of([picture(), emptySound({ id: 2 })])
    expect(index.sound).toBeNull()
    expect(index.sounds).toEqual([])
    const result = tracksOf(chooseEngineTracks(index, () => true))
    expect(result.audio).toBeNull()
  })

  it('plays index.sound, not sounds[0], when the index plays another sound than the first', () => {
    const base = mp4Of([
      picture(),
      sound({ id: 2, language: 'eng' }),
      sound({ id: 3, language: 'jpn', entries: [OPUS] }),
    ])
    const other = mp4Sound(base, 3)
    const index: Mp4Index = { ...base, sound: other }
    expect(index.sounds[0]).toMatchObject({ id: 2 })

    const { supports, asked } = browser(() => true)
    const result = tracksOf(chooseEngineTracks(index, supports))
    expect(result.audio?.track).toBe(other)
    expect(result.audio?.soundId).toBe(3)
    expect(result.video.soundId).toBe(3)
    expect(result.audio?.mime).toBe('audio/mp4; codecs="opus"')
    expect(asked).not.toContain('audio/mp4; codecs="mp4a.40.2"')
  })
})

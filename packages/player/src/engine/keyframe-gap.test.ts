import { openSource } from '@dfs/mp4'
import type { SourceIndex } from '@dfs/mp4'
import {
  avcC,
  matroskaMovie,
  movie,
  stco,
  stsc,
  stss,
  stsz,
  stts,
  visualEntry,
} from '@dfs/mp4/testing'
import { describe, expect, it } from 'vitest'
import { keyframeGapSeconds } from './keyframe-gap.ts'
import { chooseEngineTracks } from './tracks.ts'
import type { EngineTrack } from './tracks.ts'

// The keyframe gap of a track (DESIGN.md §10.4). Every file is built in code and opened with
// `openSource`, as the engine opens one.

/** The picture of a file that chooseEngineTracks chose. */
function pictureOf(index: SourceIndex): EngineTrack {
  const chosen = chooseEngineTracks(index, () => true)
  if ('refusal' in chosen) throw new Error(`expected the tracks, got: ${chosen.refusal}`)
  return chosen.video
}

/** An MP4 whose frames are `every` ms long (timescale 1000), `count` of them, keyframes at the 0-based `keyframes`. */
function mp4Track(every: number, count: number, keyframes: number[]): EngineTrack {
  const bytes = movie({
    timescale: 1000,
    tracks: [
      {
        handler: 'vide',
        timescale: 1000,
        entries: [visualEntry('avc1', {}, avcC())],
        tables: [
          stts([[count, every]]),
          stsz(Array.from({ length: count }, () => 10)),
          stsc([[1, count]]),
          stco([100]),
          // stss is 1-based.
          stss(keyframes.map((at) => at + 1)),
        ],
      },
    ],
  })
  const step = openSource([{ start: 0, bytes }], 2 ** 20)
  if (!('done' in step)) throw new Error('expected an index')
  return pictureOf(step.done)
}

/** A WebM of a VP9 picture, which keeps no frame table. */
function matroskaTrack(): EngineTrack {
  const key = Uint8Array.of(0x82, 0x49, 0x83, 0x42, 0x00)
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
    ],
    clusters: [
      {
        timestamp: 0,
        frames: [
          { track: 1, time: 0, keyframe: true, data: key },
          { track: 1, time: 33 },
        ],
      },
    ],
  })
  const step = openSource([{ start: 0, bytes: file.bytes }], file.bytes.length)
  if (!('done' in step)) throw new Error('expected an index')
  return pictureOf(step.done)
}

describe('keyframeGapSeconds', () => {
  it('is the longest stretch from one keyframe to the next, or to the end of the last frame', () => {
    // Frames every 0.5 s, keyframes at 0, 2 s and 6 s, the last frame ending at 8 s.
    expect(keyframeGapSeconds(mp4Track(500, 16, [0, 4, 12]))).toBe(4)
  })
  it('counts the stretch from the last keyframe to the end of the last frame', () => {
    // Keyframes at 0 and 2 s, the last frame ending at 8 s: the tail, 6 s, is the longest.
    expect(keyframeGapSeconds(mp4Track(500, 16, [0, 4]))).toBe(6)
  })
  it('is 0 for a Matroska track, which keeps no frame table', () => {
    expect(keyframeGapSeconds(matroskaTrack())).toBe(0)
  })
  it('is 0 for a table with no frames', () => {
    // The reader refuses a picture with no frames, so the table of a real track is emptied.
    const real = mp4Track(500, 16, [0])
    if (!('table' in real.track)) throw new Error('expected an MP4 track')
    const empty = { ...real, track: { ...real.track, table: { ...real.track.table, count: 0 } } }
    expect(keyframeGapSeconds(empty)).toBe(0)
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { children, readHeader } from '../matroska/ebml.ts'
import type { Element } from '../matroska/ebml.ts'
import { ID } from '../matroska/ids.ts'
import { readSimpleBlock, readBlockGroup } from '../matroska/blocks.ts'
import { readTracks } from '../matroska/tracks.ts'
import { framesIn, openSource, startCursor } from '../source.ts'
import { bits, concat } from './build.ts'
import {
  cluster,
  ebmlHeader,
  element,
  info,
  matroskaFile,
  matroskaMovie,
  seekHead,
  simpleBlock,
  trackEntry,
  tracksElement,
  uint,
} from './ebml.ts'
import type { Lacing, MovieFrame, TrackSpec } from './ebml.ts'
import {
  dolbyVisionRecord,
  layoutOf,
  remux,
  remuxFile,
  walkSegment,
  withUnknownClusters,
  withUnknownClustersFile,
} from './remux.ts'

// The rewriter that makes the derived files of the corpus (DESIGN.md §10.4, D45):
// a Matroska file read by the module and written again with one change, which
// ffmpeg has no option to write (lacing, header stripping, Dolby Vision's
// configuration, clusters of unknown size). Every file here is built in code, and
// each rewrite is checked by reading both files back through `openSource` and
// `framesIn` and comparing the frames, as the player will see them.

/** The uncompressed header of a profile 0 VP9 keyframe: frame marker, profile 0, a keyframe, the sync code, 8 bits and color_space 0 with a limited range. */
const VP9_KEYFRAME = [0x82, 0x49, 0x83, 0x42, 0x00]

const PICTURE: TrackSpec = {
  number: 1,
  type: 1,
  codecId: 'V_VP9',
  defaultDuration: 33_333_333,
  video: { pixelWidth: 320, pixelHeight: 240 },
}

/** AC-3 of 1536 samples a frame at 48 kHz, which is 32 ms exactly. */
const AC3: TrackSpec = {
  number: 2,
  type: 2,
  codecId: 'A_AC3',
  defaultDuration: 32_000_000,
  audio: { samplingFrequency: 48000, channels: 6 },
}

/** AAC of 1024 samples a frame at 32 kHz, which is 32 ms exactly too (AudioSpecificConfig 0x1290: AAC-LC, 32 kHz, stereo). */
const AAC: TrackSpec = {
  number: 3,
  type: 2,
  codecId: 'A_AAC',
  codecPrivate: Uint8Array.of(0x12, 0x90),
  defaultDuration: 32_000_000,
  audio: { samplingFrequency: 32000, channels: 2 },
}

/** An AC-3 syncframe (ETSI TS 102 366, clause 4): 48 kHz, frmsizecod 0x1C, bsid 8, acmod 7 with the LFE, then 61 bytes that tell the frames apart. */
function ac3Frame(n: number): Uint8Array {
  const header = bits(
    [0x0b77, 16],
    [0, 16], // crc1
    [0, 2], // fscod
    [0x1c, 6], // frmsizecod
    [8, 5], // bsid
    [0, 3], // bsmod
    [7, 3], // acmod
    [0, 4], // cmixlev and surmixlev
    [1, 1], // lfeon
    [0, 32],
  )
  return concat(
    header,
    Uint8Array.from({ length: 61 }, (_, at) => (n * 7 + at) & 0xff),
  )
}

/** An AAC frame of a size of its own (one of them long enough for Xiph lacing to need a second byte of 255). */
function aacFrame(n: number): Uint8Array {
  const size = n === 2 ? 300 : 20 + ((n * 3) % 7)
  return Uint8Array.from({ length: size }, (_, at) => (n * 5 + at) & 0xff)
}

function pictureFrame(n: number): Uint8Array {
  return n === 0
    ? concat(VP9_KEYFRAME, new Uint8Array(40))
    : Uint8Array.from({ length: 40 }, (_, at) => (n + at) & 0xff)
}

/** When a frame of the picture (30 frames a second) or of a sound (32 ms) is shown, in milliseconds. */
const pictureTime = (n: number): number => Math.round((n * 1000) / 30)
const soundTime = (n: number): number => n * 32

/** The frames of a cluster in the order of their times, a picture's before a sound's where the times are the same. */
function inOrder(frames: MovieFrame[]): MovieFrame[] {
  return frames
    .map((frame, at) => ({ frame, at }))
    .sort((a, b) => a.frame.time - b.frame.time || a.at - b.at)
    .map(({ frame }) => frame)
}

function framesFor(
  pictures: number[],
  ac3: number[],
  aac: number[],
  groups: number[],
): MovieFrame[] {
  return inOrder([
    ...pictures.map((n) => ({
      track: 1,
      time: pictureTime(n),
      keyframe: n === 0,
      data: pictureFrame(n),
    })),
    ...ac3.map((n) => ({
      track: 2,
      time: soundTime(n),
      keyframe: true,
      data: ac3Frame(n),
      // A BlockGroup with a duration, as ffmpeg writes the last frame of a file.
      ...(groups.includes(n) ? { duration: 32 } : {}),
    })),
    ...aac.map((n) => ({ track: 3, time: soundTime(n), keyframe: true, data: aacFrame(n) })),
  ])
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, at) => from + at)

/**
 * A file of a picture and two sounds, with a SeekHead, a Tags element and Cues, in two clusters: the first holds
 * 10 frames of each track (the fifth AC-3 frame is in a BlockGroup), and the second 10 pictures, 6 AC-3 frames (the
 * last in a BlockGroup) and 9 AAC frames.
 */
function source(): Uint8Array {
  return matroskaMovie({
    scale: 1_000_000,
    duration: 640,
    tracks: [PICTURE, AC3, AAC],
    seek: true,
    tags: [20],
    cues: true,
    clusters: [
      { timestamp: 0, frames: framesFor(range(0, 10), range(0, 10), range(0, 10), [4]) },
      { timestamp: 320, frames: framesFor(range(10, 20), range(10, 16), range(10, 19), [15]) },
    ],
  }).bytes
}

/** What a track's frames are as the player is given them: each frame's bytes with the stripped prefix put back, and its times. */
interface Seen {
  frames: Uint8Array[]
  dts: number[]
  cts: number[]
  durations: number[]
  sync: number[]
  /** What the file stores of each frame, less what was stripped. */
  stored: number[]
}

/** The frames of the picture and of the sound with this id, read through `openSource` and `framesIn` from a file held whole. */
function framesOf(bytes: Uint8Array, sound: number): Map<number, Seen> {
  const opened = openSource([{ start: 0, bytes }], bytes.length)
  if (!('done' in opened)) throw new Error('the file asks for more than it holds')
  const index = opened.done
  const given = framesIn(index, startCursor(index, sound), { start: 0, bytes })
  const seen = new Map<number, Seen>()
  for (const track of given.frames) {
    const one = seen.get(track.header.id) ?? {
      frames: [],
      dts: [],
      cts: [],
      durations: [],
      sync: [],
      stored: [],
    }
    const { table } = track
    for (let i = 0; i < table.count; i += 1) {
      const at = table.offsets[i] ?? 0
      const size = table.sizes[i] ?? 0
      one.frames.push(concat(track.prefix ?? [], bytes.subarray(at, at + size)))
      one.dts.push(table.dts[i] ?? 0)
      one.cts.push(table.cts[i] ?? 0)
      one.durations.push(table.durations[i] ?? 0)
      one.sync.push(table.sync[i] ?? 0)
      one.stored.push(size)
    }
    seen.set(track.header.id, one)
  }
  return seen
}

/** Everything a rewrite must keep: the frames' bytes and times, but not where the file stores them or how many bytes it stores. */
function kept(seen: Map<number, Seen>): unknown {
  return [...seen].map(([id, { stored: _stored, ...rest }]) => [id, rest])
}

/** A block of a cluster, as the file has it: the track, the timecode, how many frames, whether it is a SimpleBlock, and its flags byte. */
interface Block {
  track: number
  timecode: number
  count: number
  simple: boolean
  flags: number
}

function clustersOf(bytes: Uint8Array): Block[][] {
  return walkSegment(bytes)
    .parts.filter((part) => part.id === ID.Cluster)
    .map((one) =>
      children(bytes, one).flatMap((child): Block[] => {
        if (child.id === ID.SimpleBlock) {
          const block = readSimpleBlock(bytes, child, 0)
          const flagsAt = child.data + 1 + 2
          return [
            {
              track: block.track,
              timecode: block.timecode,
              count: block.frames.length,
              simple: true,
              flags: bytes[flagsAt] ?? 0,
            },
          ]
        }
        if (child.id === ID.BlockGroup) {
          const block = readBlockGroup(bytes, child, 0)
          return [
            {
              track: block.track,
              timecode: block.timecode,
              count: block.frames.length,
              simple: false,
              flags: 0,
            },
          ]
        }
        return []
      }),
    )
}

/** The IDs of the elements directly inside an element, all of them, the CRC-32 and Void ones that `children` leaves out too. */
function rawIds(bytes: Uint8Array, parent: Element): number[] {
  const ids: number[] = []
  let at = parent.data
  while (at < parent.end) {
    const el = readHeader(bytes, at, parent.end)
    if (el === null) break
    ids.push(el.id)
    at = el.end
  }
  return ids
}

const text = (layout: ReturnType<typeof layoutOf>): string => layout.names.join(' ')

describe('layoutOf', () => {
  const picture = trackEntry(PICTURE)
  const blocks = [simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [pictureFrame(0)] })]

  it('names the Segment’s children in order, each run of the same once, and leaves out Void and CRC-32', () => {
    const file = matroskaFile([
      seekHead([[ID.Info, 100]]),
      element(ID.Void, new Uint8Array(30)),
      info({ scale: 1_000_000 }),
      tracksElement([picture]),
      element(ID.Tags, new Uint8Array(10)),
      cluster(0, blocks, { crc: true }),
      cluster(100, blocks, { crc: true }),
      cluster(200, blocks),
      element(ID.Cues, element(ID.CuePoint)),
      element(ID.Void, new Uint8Array(9)),
    ])
    const layout = layoutOf(file.bytes)
    expect(text(layout)).toBe('SeekHead Info Tracks Tags Cluster Cues')
    expect(layout.segmentSized).toBe(true)
    expect(layout.clustersSized).toBe(true)
    expect(walkSegment(file.bytes).parts.filter((part) => part.id === ID.Cluster)).toHaveLength(3)
  })

  it('puts a Cues element in front of the Clusters, and says one that is behind them', () => {
    const cues = element(ID.Cues, element(ID.CuePoint))
    const front = matroskaFile([
      info({}),
      tracksElement([picture]),
      cues,
      cluster(0, blocks),
      cluster(1, blocks),
    ])
    expect(text(layoutOf(front.bytes))).toBe('Info Tracks Cues Cluster')
    const back = matroskaFile([info({}), tracksElement([picture]), cluster(0, blocks), cues])
    expect(text(layoutOf(back.bytes))).toBe('Info Tracks Cluster Cues')
  })

  it('says a Segment of unknown size, and Clusters of unknown size that end where the next element begins', () => {
    const file = matroskaFile(
      [
        info({}),
        tracksElement([picture]),
        cluster(0, [...blocks, ...blocks], { unknown: true }),
        cluster(100, blocks, { unknown: true }),
        element(ID.Cues, element(ID.CuePoint)),
      ],
      { unknown: true },
    )
    const layout = layoutOf(file.bytes)
    expect(layout).toEqual({
      names: ['Info', 'Tracks', 'Cluster', 'Cues'],
      segmentSized: false,
      clustersSized: false,
    })
    const parts = walkSegment(file.bytes).parts
    const clusters = parts.filter((part) => part.id === ID.Cluster)
    expect(clusters).toHaveLength(2)
    // Each ends where the element after it starts.
    expect(clusters[0]?.end).toBe(clusters[1]?.start)
    expect(clusters[1]?.end).toBe(parts.find((part) => part.id === ID.Cues)?.start)
  })

  it('says a Cluster of unknown size inside a Segment of known size, and one of unknown size that ends the file', () => {
    const file = matroskaFile([
      info({}),
      tracksElement([picture]),
      cluster(0, blocks),
      cluster(100, blocks, { unknown: true }),
    ])
    expect(layoutOf(file.bytes)).toEqual({
      names: ['Info', 'Tracks', 'Cluster'],
      segmentSized: true,
      clustersSized: false,
    })
  })

  it('names an element it has no name for by its ID, in hex', () => {
    const file = matroskaFile([info({}), element(0x1f000000, [1, 2, 3]), tracksElement([picture])])
    expect(text(layoutOf(file.bytes))).toBe('Info 0x1f000000 Tracks')
  })

  it('says a file with no Clusters has Clusters of known size, and refuses what is not a Segment', () => {
    const file = matroskaFile([info({}), tracksElement([picture])])
    expect(layoutOf(file.bytes).clustersSized).toBe(true)
    expect(() => layoutOf(new Uint8Array(0))).toThrow(Error)
    expect(() => layoutOf(file.bytes.subarray(0, 20))).toThrow(Error)
    // The EBML header and then something that is not a Segment.
    expect(() => layoutOf(concat(ebmlHeader(), info({})))).toThrow(/Segment/)
  })
})

describe('remux', () => {
  const original = source()
  const ac3 = framesOf(original, 2)
  const aac = framesOf(original, 3)

  it('has sources that are what the tests say, or the comparisons below mean nothing', () => {
    expect(text(layoutOf(original))).toBe('SeekHead Info Tracks Tags Cluster Cues')
    expect(ac3.get(1)?.frames).toHaveLength(20)
    expect(ac3.get(2)?.frames).toHaveLength(16)
    expect(aac.get(3)?.frames).toHaveLength(19)
    expect(clustersOf(original).map((blocks) => blocks.filter((b) => !b.simple).length)).toEqual([
      1, 1,
    ])
  })

  it('writes the EBML header, then a Segment of known size with Info, Tracks and the Clusters alone', () => {
    const out = remux(original, {})
    const layout = layoutOf(out)
    expect(text(layout)).toBe('Info Tracks Cluster')
    expect(layout.segmentSized).toBe(true)
    expect(layout.clustersSized).toBe(true)
    // The header is the source's, byte for byte.
    const header = walkSegment(original).header
    expect(out.subarray(0, header.end)).toEqual(original.subarray(0, header.end))
    // Nothing is lost: the same frames at the same times, and the same blocks.
    expect(kept(framesOf(out, 2))).toEqual(kept(ac3))
    expect(kept(framesOf(out, 3))).toEqual(kept(aac))
    expect(clustersOf(out)).toEqual(clustersOf(original))
  })

  it('writes Info and Tracks from the source’s elements, and Clusters of a Timestamp and blocks', () => {
    const out = remux(original, {})
    const parts = walkSegment(out).parts
    const infoOut = parts.find((part) => part.id === ID.Info)
    const infoIn = walkSegment(original).parts.find((part) => part.id === ID.Info)
    if (!infoOut || !infoIn) throw new Error('no Info')
    expect(out.subarray(infoOut.start, infoOut.end)).toEqual(
      original.subarray(infoIn.start, infoIn.end),
    )
    const tracksIn = walkSegment(original).parts.find((part) => part.id === ID.Tracks)
    const tracksOut = parts.find((part) => part.id === ID.Tracks)
    if (!tracksIn || !tracksOut) throw new Error('no Tracks')
    expect(readTracks(out, tracksOut).tracks).toEqual(readTracks(original, tracksIn).tracks)
    const [first] = parts.filter((part) => part.id === ID.Cluster)
    if (!first) throw new Error('no Cluster')
    expect(rawIds(out, first)[0]).toBe(ID.Timestamp)
  })

  it('gives a Cluster of unknown size the size it has, so that the file it writes is the same as the sized source’s', () => {
    expect(remux(withUnknownClusters(original), {})).toEqual(remux(original, {}))
  })

  it('leaves out the CRC-32 and Void elements wherever they stand, and the SeekHead, Tags and Cues', () => {
    const crc = element(ID.CRC32, [1, 2, 3, 4])
    const blocks = [
      simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [pictureFrame(0)] }),
    ]
    const file = matroskaFile([
      seekHead([[ID.Info, 40]]),
      element(ID.Void, new Uint8Array(20)),
      element(
        ID.Info,
        crc,
        element(ID.Void, new Uint8Array(5)),
        uint(ID.TimestampScale, 1_000_000),
      ),
      element(ID.Tracks, crc, trackEntry(PICTURE)),
      element(ID.Tags, new Uint8Array(10)),
      cluster(0, blocks, { crc: true }),
      element(ID.Cues, element(ID.CuePoint)),
    ])
    const out = remux(file.bytes, {})
    expect(text(layoutOf(out))).toBe('Info Tracks Cluster')
    for (const part of walkSegment(out).parts) {
      const ids = rawIds(out, part)
      expect(ids, `inside ${part.id.toString(16)}`).not.toContain(ID.CRC32)
      expect(ids, `inside ${part.id.toString(16)}`).not.toContain(ID.Void)
    }
  })

  describe('lacing', () => {
    it.each<[Lacing]>([['xiph'], ['ebml']])(
      'groups 4 AAC frames to a block in %s lacing, a short group last in its cluster, and keeps the frames',
      (lacing) => {
        const out = remux(original, { lace: { codec: 'A_AAC', count: 4, lacing } })
        const counts = clustersOf(out).map((blocks) =>
          blocks.filter((block) => block.track === 3).map((block) => block.count),
        )
        expect(counts).toEqual([
          [4, 4, 2],
          [4, 4, 1],
        ])
        expect(kept(framesOf(out, 3))).toEqual(kept(aac))
        expect(kept(framesOf(out, 2))).toEqual(kept(ac3))
        expect(text(layoutOf(out))).toBe('Info Tracks Cluster')
      },
    )

    it('writes the lacing in the flags, the first frame’s timecode and keyframe flag, and no lace of one frame', () => {
      const out = remux(original, { lace: { codec: 'A_AAC', count: 4, lacing: 'xiph' } })
      const [first, second] = clustersOf(out)
      const aacBlocks = (blocks: Block[] | undefined) =>
        (blocks ?? []).filter((block) => block.track === 3)
      // A lace of 4 or 2 says Xiph's lacing (01 in bits 0x06) and a keyframe; a block of one frame says none.
      expect(aacBlocks(first).map((block) => block.flags & 0x86)).toEqual([0x82, 0x82, 0x82])
      expect(aacBlocks(second).map((block) => block.flags & 0x86)).toEqual([0x82, 0x82, 0x80])
      // The timecodes are those of the first frame of each lace: frames 0, 4 and 8, then 10 (320 ms from the cluster's start 320, so 0), 14 and 18.
      expect(aacBlocks(first).map((block) => block.timecode)).toEqual([0, 128, 256])
      expect(aacBlocks(second).map((block) => block.timecode)).toEqual([0, 128, 256])
    })

    it('puts a lace where its first frame was, so the blocks follow one another in the order of their first frames', () => {
      const expected = clustersOf(original).map((blocks) => {
        const seen = new Map<number, number>()
        return blocks.filter((block) => {
          if (block.track !== 3) return true
          const n = seen.get(3) ?? 0
          seen.set(3, n + 1)
          return n % 4 === 0
        })
      })
      const out = clustersOf(
        remux(original, { lace: { codec: 'A_AAC', count: 4, lacing: 'ebml' } }),
      )
      expect(out.map((blocks) => blocks.map((block) => [block.track, block.timecode]))).toEqual(
        expected.map((blocks) => blocks.map((block) => [block.track, block.timecode])),
      )
    })

    it('groups AC-3 frames of one size 3 to a block in fixed lacing, and ends the lace before a BlockGroup', () => {
      const out = remux(original, { lace: { codec: 'A_AC3', count: 3, lacing: 'fixed' } })
      const counts = clustersOf(out).map((blocks) =>
        blocks
          .filter((block) => block.track === 2)
          .map((block) => `${block.simple ? 's' : 'g'}${block.count}`),
      )
      // 10 frames, the fifth a BlockGroup: 3, then the one before the group, the group, and 3 and 2 after it. Then 5 frames and a BlockGroup: 3, 2, and the group on its own.
      expect(counts).toEqual([
        ['s3', 's1', 'g1', 's3', 's2'],
        ['s3', 's2', 'g1'],
      ])
      const [first] = clustersOf(out)
      expect(
        (first ?? []).filter((block) => block.track === 2).map((block) => block.flags & 0x86),
      ).toEqual([0x84, 0x80, 0, 0x84, 0x84])
      expect(kept(framesOf(out, 2))).toEqual(kept(ac3))
      expect(kept(framesOf(out, 3))).toEqual(kept(aac))
    })

    it('refuses fixed lacing of frames that are not all of one size, and says the source was not constant', () => {
      expect(() =>
        remux(original, { lace: { codec: 'A_AAC', count: 4, lacing: 'fixed' } }),
      ).toThrow(/same size/)
    })

    it('refuses a codec that no track has, and a count below 2 or above 256', () => {
      expect(() => remux(original, { lace: { codec: 'A_DTS', count: 4, lacing: 'xiph' } })).toThrow(
        /A_DTS/,
      )
      expect(() => remux(original, { lace: { codec: 'A_AAC', count: 1, lacing: 'xiph' } })).toThrow(
        RangeError,
      )
      expect(() =>
        remux(original, { lace: { codec: 'A_AAC', count: 257, lacing: 'xiph' } }),
      ).toThrow(RangeError)
    })

    it('refuses a source whose frames are laced already', () => {
      const laced = matroskaMovie({
        tracks: [PICTURE, AAC],
        clusters: [
          {
            timestamp: 0,
            frames: [
              { track: 1, time: 0, keyframe: true, data: pictureFrame(0) },
              {
                track: 3,
                time: 0,
                keyframe: true,
                lace: { lacing: 'xiph', frames: [aacFrame(0), aacFrame(1)] },
              },
            ],
          },
        ],
      }).bytes
      expect(() => remux(laced, { lace: { codec: 'A_AAC', count: 4, lacing: 'xiph' } })).toThrow(
        /laced/,
      )
    })
  })

  describe('header stripping', () => {
    const prefix = Uint8Array.of(0x0b, 0x77)

    it('takes the sync word off every AC-3 frame, a BlockGroup’s too, and the reader puts it back', () => {
      const out = remux(original, { strip: { codec: 'A_AC3', prefix } })
      const seen = framesOf(out, 2)
      expect(kept(seen)).toEqual(kept(ac3))
      // What the file stores is 2 bytes less for each frame of the sound (72 are built), and the picture is as it was.
      expect(new Set(seen.get(2)?.stored)).toEqual(new Set([70]))
      expect(seen.get(1)?.stored).toEqual(ac3.get(1)?.stored)
      // The stripped bytes are the reader's to put back: the track says so.
      const tracksEl = walkSegment(out).parts.find((part) => part.id === ID.Tracks)
      if (!tracksEl) throw new Error('no Tracks')
      const tracks = readTracks(out, tracksEl).tracks
      expect(tracks.map((track) => Array.from(track.stripped))).toEqual([[], [0x0b, 0x77], []])
      expect(tracks.every((track) => track.refusal === null && track.problem === null)).toBe(true)
      // The other sound is untouched.
      expect(kept(framesOf(out, 3))).toEqual(kept(aac))
    })

    it('writes the ContentEncodings of header stripping: algorithm 3 with the stripped bytes as its settings', () => {
      const out = remux(original, { strip: { codec: 'A_AC3', prefix } })
      const tracksEl = walkSegment(out).parts.find((part) => part.id === ID.Tracks)
      if (!tracksEl) throw new Error('no Tracks')
      const entry = children(out, tracksEl)[1]
      if (!entry) throw new Error('no second entry')
      const encodings = children(out, entry).find((child) => child.id === ID.ContentEncodings)
      if (!encodings) throw new Error('no ContentEncodings')
      const [encoding] = children(out, encodings)
      if (!encoding) throw new Error('no ContentEncoding')
      expect(rawIds(out, encoding).map((id) => id.toString(16))).toEqual([
        '5031', // ContentEncodingOrder
        '5032', // ContentEncodingScope
        '5033', // ContentEncodingType
        '5034', // ContentCompression
      ])
      const compression = children(out, encoding).find(
        (child) => child.id === ID.ContentCompression,
      )
      if (!compression) throw new Error('no ContentCompression')
      const fields = children(out, compression)
      expect(fields.map((field) => field.id)).toEqual([ID.ContentCompAlgo, ID.ContentCompSettings])
      const [algo, settings] = fields
      expect(out.subarray(algo?.data, algo?.end)).toEqual(Uint8Array.of(3))
      expect(out.subarray(settings?.data, settings?.end)).toEqual(prefix)
      // Order 0, scope 1 (the frames), type 0 (compression).
      const [order, scope, type] = children(out, encoding)
      expect([order, scope, type].map((el) => out.subarray(el?.data, el?.end)[0])).toEqual([
        0, 1, 0,
      ])
    })

    it('can lace the frames it strips', () => {
      const out = remux(original, {
        strip: { codec: 'A_AC3', prefix },
        lace: { codec: 'A_AC3', count: 3, lacing: 'fixed' },
      })
      expect(kept(framesOf(out, 2))).toEqual(kept(ac3))
    })

    it('refuses a frame that does not start with the bytes to strip', () => {
      expect(() =>
        remux(original, { strip: { codec: 'A_AC3', prefix: Uint8Array.of(0xaa) } }),
      ).toThrow(/doesn't start with/)
    })

    it('refuses a track that has ContentEncodings already, so it is never stripped twice', () => {
      const once = remux(original, { strip: { codec: 'A_AC3', prefix } })
      expect(() => remux(once, { strip: { codec: 'A_AC3', prefix } })).toThrow(/ContentEncodings/)
    })

    it('refuses an empty prefix and a codec that no track has', () => {
      expect(() =>
        remux(original, { strip: { codec: 'A_AC3', prefix: new Uint8Array(0) } }),
      ).toThrow(RangeError)
      expect(() => remux(original, { strip: { codec: 'A_DTS', prefix } })).toThrow(/A_DTS/)
    })
  })

  describe('Dolby Vision', () => {
    const HEVC: TrackSpec = {
      number: 1,
      type: 1,
      codecId: 'V_MPEGH/ISO/HEVC',
      defaultDuration: 33_333_333,
      video: { pixelWidth: 320, pixelHeight: 240 },
    }
    const hevc = matroskaMovie({
      tracks: [HEVC, AC3],
      clusters: [{ timestamp: 0, frames: [{ track: 1, time: 0, keyframe: true }] }],
    }).bytes

    function tracksOf(bytes: Uint8Array) {
      const el = walkSegment(bytes).parts.find((part) => part.id === ID.Tracks)
      if (!el) throw new Error('no Tracks')
      return readTracks(bytes, el).tracks
    }

    it('writes the record as the standard lays it out: version 1.0, profile, level, flags, compatibility, zeros', () => {
      // Profile 8, level 6, an RPU and a base layer and no enhancement layer, compatibility with HDR10 (1).
      expect(Array.from(dolbyVisionRecord(8, 1))).toEqual([
        0x01,
        0x00,
        0x10,
        0x35,
        0x10,
        ...new Array<number>(19).fill(0),
      ])
      // Profile 5 has no compatibility with anything (0).
      expect(Array.from(dolbyVisionRecord(5, 0))).toEqual([
        0x01,
        0x00,
        0x0a,
        0x35,
        0x00,
        ...new Array<number>(19).fill(0),
      ])
      expect(dolbyVisionRecord(8, 1)).toHaveLength(24)
      expect(() => dolbyVisionRecord(128, 0)).toThrow(RangeError)
      expect(() => dolbyVisionRecord(8, 16)).toThrow(RangeError)
    })

    it('adds a BlockAdditionMapping of type dvcC to the picture’s entry, and changes nothing else', () => {
      const out = remux(hevc, { dolbyVision: { profile: 8, compatibility: 1 } })
      const tracks = tracksOf(out)
      expect(tracks[0]?.blockAdditions).toEqual([
        { type: 0x64766343, extraData: dolbyVisionRecord(8, 1) },
      ])
      expect(tracks[1]?.blockAdditions).toEqual([])
      expect(tracks.map((track) => track.codecId)).toEqual(['V_MPEGH/ISO/HEVC', 'A_AC3'])
      const plain = tracksOf(remux(hevc, {}))
      expect(tracks.map(({ blockAdditions: _a, ...rest }) => rest)).toEqual(
        plain.map(({ blockAdditions: _a, ...rest }) => rest),
      )
      const five = tracksOf(remux(hevc, { dolbyVision: { profile: 5, compatibility: 0 } }))
      expect(five[0]?.blockAdditions[0]?.extraData).toEqual(dolbyVisionRecord(5, 0))
    })

    it('refuses a file that has no HEVC picture', () => {
      expect(() => remux(original, { dolbyVision: { profile: 8, compatibility: 1 } })).toThrow(
        /HEVC/,
      )
    })
  })

  it('refuses what is not a Matroska file with a Segment, and a track it cannot read', () => {
    expect(() => remux(new Uint8Array(0), {})).toThrow(Error)
    const noTracks = matroskaFile([info({}), cluster(0, [])]).bytes
    expect(() => remux(noTracks, {})).toThrow(/Tracks/)
  })
})

describe('withUnknownClusters', () => {
  const original = remux(source(), {})

  it('gives every Cluster the unknown size in the width it had, and changes nothing else', () => {
    const out = withUnknownClusters(original)
    expect(out.length).toBe(original.length)
    expect(layoutOf(out)).toEqual({
      names: ['Info', 'Tracks', 'Cluster'],
      segmentSized: true,
      clustersSized: false,
    })
    // Only the size bytes differ: the 3 of each Cluster here are 4 bytes of ID then the size.
    const clusters = walkSegment(original).parts.filter((part) => part.id === ID.Cluster)
    const covered = new Set(clusters.flatMap((one) => range(one.start + 4, one.data)))
    const differing = range(0, original.length).filter((at) => out[at] !== original[at])
    expect(differing.length).toBeGreaterThan(0)
    expect(differing.every((at) => covered.has(at))).toBe(true)
    for (const one of clusters) {
      const width = one.data - one.start - 4
      const first = 0xff >> (width - 1)
      expect(Array.from(out.subarray(one.start + 4, one.data))).toEqual([
        first,
        ...new Array<number>(width - 1).fill(0xff),
      ])
    }
    // The source is not touched.
    expect(original).toEqual(remux(source(), {}))
  })

  it('reads back with the same frames', () => {
    const out = withUnknownClusters(original)
    expect(kept(framesOf(out, 2))).toEqual(kept(framesOf(original, 2)))
    expect(kept(framesOf(out, 3))).toEqual(kept(framesOf(original, 3)))
  })

  it('also rewrites a file whose Segment is of unknown size already, as a live recording has it', () => {
    const blocks = [
      simpleBlock({ track: 1, timecode: 0, keyframe: true, frames: [pictureFrame(0)] }),
    ]
    const file = matroskaFile(
      [
        info({}),
        tracksElement([trackEntry(PICTURE)]),
        cluster(0, blocks),
        cluster(100, blocks),
        element(ID.Cues, element(ID.CuePoint)),
      ],
      { unknown: true },
    )
    const out = withUnknownClusters(file.bytes)
    expect(out.length).toBe(file.bytes.length)
    expect(layoutOf(out)).toEqual({
      names: ['Info', 'Tracks', 'Cluster', 'Cues'],
      segmentSized: false,
      clustersSized: false,
    })
  })
})

describe('the files', () => {
  let folder: string

  beforeAll(() => {
    folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-remux-'))
  })

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('are written from a file to a file, for the corpus script', () => {
    const from = resolve(folder, 'from.mkv')
    writeFileSync(from, source())
    const laced = resolve(folder, 'laced.mkv')
    remuxFile(from, laced, { lace: { codec: 'A_AAC', count: 4, lacing: 'xiph' } })
    expect(readFileSync(laced)).toEqual(
      Buffer.from(remux(source(), { lace: { codec: 'A_AAC', count: 4, lacing: 'xiph' } })),
    )
    const unknown = resolve(folder, 'unknown.mkv')
    withUnknownClustersFile(from, unknown)
    expect(readFileSync(unknown)).toEqual(Buffer.from(withUnknownClusters(source())))
  })
})

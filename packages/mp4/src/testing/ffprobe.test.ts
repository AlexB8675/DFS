import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syntheticDir } from './corpus.ts'
import {
  decodeProblem,
  iamfPacketSize,
  probePacketsOf,
  remuxEntry,
  remuxPackets,
  runForComplaint,
  runToFile,
  streamStart,
} from './ffprobe.ts'

// The corpus suite's helpers for ffprobe and ffmpeg (DESIGN.md §10.4): what they
// do when the program isn't there, when ffprobe can't say where a stream starts,
// what counts as a file that ffmpeg has decoded, and ffmpeg's own remux of a
// stream to MP4, which the Matroska reader's decode times and configuration boxes
// are compared with.

describe('runToFile', () => {
  it('rejects, once and with a sentence, when the program cannot be run', async () => {
    const folder = mkdtempSync(resolve(tmpdir(), 'dfs-mp4-test-'))
    try {
      await expect(
        runToFile('dfs-no-such-program', ['-version'], resolve(folder, 'out.json')),
      ).rejects.toThrow(/dfs-no-such-program could not be run.*PATH/)
      // A second close of the output file, if there is one, comes as an event after the first: give it time to throw.
      await new Promise((done) => setTimeout(done, 200))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('streamStart', () => {
  it('is the start in ticks of the time base, exactly', () => {
    expect(streamStart({ index: 0, start_pts: 22976, time_base: '1/48000' })).toBeCloseTo(
      22976 / 48000,
      12,
    )
  })

  it('falls back to the start time when there is no start in ticks', () => {
    expect(streamStart({ index: 0, start_time: '0.478667', time_base: '1/48000' })).toBe(0.478667)
  })

  it('is null when ffprobe prints N/A for the start, as it does when it has none', () => {
    expect(
      streamStart({ index: 0, start_pts: 'N/A', start_time: 'N/A', time_base: '1/90000' }),
    ).toBeNull()
    expect(streamStart({ index: 0, start_time: 'N/A', time_base: '1/90000' })).toBeNull()
    expect(streamStart({ index: 0, start_time: '', time_base: '1/90000' })).toBeNull()
    expect(streamStart({ index: 0 })).toBeNull()
  })

  it('does not take a start in ticks when the time base is not a fraction', () => {
    expect(streamStart({ index: 0, start_pts: 5, time_base: 'N/A' })).toBeNull()
    expect(streamStart({ index: 0, start_pts: 5, time_base: '1/0' })).toBeNull()
  })
})

describe('runForComplaint', () => {
  it('gives the exit code and what the program wrote to stderr, and not what it wrote to stdout', async () => {
    const run = (code: string): Promise<{ code: number | null; complaint: string }> =>
      runForComplaint(process.execPath, ['-e', code])
    await expect(run('console.log("fine")')).resolves.toEqual({ code: 0, complaint: '' })
    await expect(run('console.error("boom"); process.exit(3)')).resolves.toEqual({
      code: 3,
      complaint: 'boom\n',
    })
    // A long complaint is cut: it is a line in a report, not a log.
    const long = await run('console.error("x".repeat(20000))')
    expect(long.complaint.length).toBeLessThan(5000)
  })

  it('rejects, with a sentence, when the program cannot be run', async () => {
    await expect(runForComplaint('dfs-no-such-program', ['-version'])).rejects.toThrow(
      /dfs-no-such-program could not be run.*PATH/,
    )
  })
})

describe('decodeProblem', () => {
  it('is null for a program that exited 0 and said nothing', () => {
    expect(decodeProblem({ code: 0, complaint: '' })).toBeNull()
    expect(decodeProblem({ code: 0, complaint: ' \n' })).toBeNull()
  })

  it('says the exit code when the program failed, with what it said', () => {
    expect(
      decodeProblem({ code: 69, complaint: 'Invalid data found when processing input\n' }),
    ).toBe('ffmpeg exited with 69: Invalid data found when processing input')
    expect(decodeProblem({ code: 1, complaint: '' })).toBe('ffmpeg exited with 1')
    expect(decodeProblem({ code: null, complaint: '' })).toBe('ffmpeg was stopped before it ended')
  })

  it('says what the program said even when it exited 0: a decoder that gave up on a packet may say so and go on', () => {
    expect(decodeProblem({ code: 0, complaint: '[aac @ 0x1] Input buffer exhausted\n' })).toBe(
      'ffmpeg exited with 0 but said: [aac @ 0x1] Input buffer exhausted',
    )
  })
})

describe('iamfPacketSize', () => {
  /** Padding that a payload is made of: its bytes are not read. */
  const payload = (length: number): number[] => Array.from({ length }, (_, at) => at & 0xff)

  it('is the payload of an Audio Frame OBU that is the whole sample: after its header and its size', () => {
    // Type 6 (the audio frame of substream 0), no flags, 3 bytes.
    expect(iamfPacketSize(Uint8Array.of(0x30, 3, ...payload(3)))).toBe(3)
    // A size of 310 takes two bytes, as in a real sample.
    expect(iamfPacketSize(Uint8Array.of(0x30, 0xb6, 0x02, ...payload(310)))).toBe(310)
  })

  it('leaves out the trimming that a sample can start with, two numbers inside the OBU', () => {
    // 0x32: type 6 with the trimming flag. The OBU holds the end trim (0), the start trim (312, two bytes) and 307 bytes.
    const sample = Uint8Array.of(0x32, 0xb6, 0x02, 0x00, 0xb8, 0x02, ...payload(307))
    expect(sample.length).toBe(313)
    expect(iamfPacketSize(sample)).toBe(307)
  })

  it('leaves out the substream ID of an OBU of type 5, and the extension header of one that has it', () => {
    expect(iamfPacketSize(Uint8Array.of(0x28, 4, 0x07, ...payload(3)))).toBe(3)
    // 0x31: type 6 with the extension flag: a size of 2, and those 2 bytes, then 2 of payload.
    expect(iamfPacketSize(Uint8Array.of(0x31, 5, 2, 0xaa, 0xbb, ...payload(2)))).toBe(2)
  })

  it('is null for a sample that is not one Audio Frame OBU, or is cut short or lies about its size', () => {
    // Two OBUs, as when a temporal delimiter comes first (type 4).
    expect(iamfPacketSize(Uint8Array.of(0x20, 0, 0x30, 2, 1, 2))).toBeNull()
    // Not an audio frame: a Parameter Block (type 3).
    expect(iamfPacketSize(Uint8Array.of(0x18, 2, 1, 2))).toBeNull()
    // The size is more than the sample, or less.
    expect(iamfPacketSize(Uint8Array.of(0x30, 9, 1, 2))).toBeNull()
    expect(iamfPacketSize(Uint8Array.of(0x30, 1, 1, 2))).toBeNull()
    // A number that is cut short, in the size and in the trimming.
    expect(iamfPacketSize(Uint8Array.of(0x30, 0x80))).toBeNull()
    expect(iamfPacketSize(Uint8Array.of(0x32, 2, 0x00, 0x80))).toBeNull()
    expect(iamfPacketSize(new Uint8Array(0))).toBeNull()
    // The fields take more than the OBU says it holds.
    expect(iamfPacketSize(Uint8Array.of(0x32, 1, 0x00, 0x00))).toBeNull()
  })
})

// The remux runs on a synthetic file (the corpus folder is git-ignored, and the
// user's own videos are never remuxed), and is skipped where ffmpeg or the file
// is not there.
const ffmpegThere = spawnSync('ffmpeg', ['-version']).status === 0
const mkv = (name: string): string => resolve(syntheticDir, name)
const remuxable = ffmpegThere && existsSync(mkv('h264-aac.mkv')) && existsSync(mkv('hevc-ac3.mkv'))

/** The folders that a remux makes in the temporary folder, which are gone when it has read its output. */
function remuxFolders(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dfs-mp4-remux-'))
}

describe.skipIf(!remuxable)('remuxPackets and remuxEntry', () => {
  it("lists the packets of a stream as ffmpeg's remux to MP4 times them: decode times from before 0, in seconds, and the keyframes", async () => {
    const packets = await remuxPackets(mkv('h264-aac.mkv'), 0)
    // 12 s of a picture at 30 frames a second.
    expect(packets.length).toBe(360)
    expect(packets[0]?.flags).toContain('K')
    // The picture has B-frames: the remux starts its decode before its first presentation, by two frames of 1/30 s.
    expect(Number(packets[0]?.dts_time)).toBeCloseTo(-0.067, 3)
    expect(Number(packets[0]?.pts_time)).toBe(0)
    expect(Number(packets[1]?.dts_time)).toBeCloseTo(-0.034, 3)
    // Decode times rise.
    for (let i = 1; i < packets.length; i += 1) {
      expect(Number(packets[i]?.dts_time)).toBeGreaterThan(Number(packets[i - 1]?.dts_time))
    }
  })

  it('lists the packets of a sound too, by the index of its stream in the file', async () => {
    const packets = await remuxPackets(mkv('h264-aac.mkv'), 1)
    expect(packets.length).toBeGreaterThan(500)
    expect(packets.every((packet) => packet.flags?.includes('K'))).toBe(true)
  })

  it("reads the sample entry of the remuxed stream with the module's MP4 reader: its type and its configuration box", async () => {
    const picture = await remuxEntry(mkv('h264-aac.mkv'), 0)
    expect(picture.type).toBe('avc1')
    expect(new TextDecoder('latin1').decode(picture.bytes)).toContain('avcC')
    const sound = await remuxEntry(mkv('h264-aac.mkv'), 1)
    expect(sound.type).toBe('mp4a')
    expect(new TextDecoder('latin1').decode(sound.bytes)).toContain('esds')
  })

  it('tags HEVC as hvc1, which Safari takes, and not as the hev1 that ffmpeg writes untold', async () => {
    expect((await remuxEntry(mkv('hevc-ac3.mkv'), 0)).type).toBe('hvc1')
  })

  it('gives the same entry the second time, from its cache', async () => {
    const first = await remuxEntry(mkv('h264-aac.mkv'), 1)
    const again = await remuxEntry(mkv('h264-aac.mkv'), 1)
    expect(again.type).toBe(first.type)
    expect(Array.from(again.bytes)).toEqual(Array.from(first.bytes))
    expect(again.stsdVersion).toBe(first.stsdVersion)
  })

  it('removes its folder from the temporary folder when ffmpeg cannot remux the stream', async () => {
    const before = remuxFolders()
    // VP8 has no tag in MP4: ffmpeg turns the stream away.
    if (existsSync(mkv('vp8-vorbis.webm'))) {
      await expect(remuxPackets(mkv('vp8-vorbis.webm'), 0)).rejects.toThrow(/could not remux/)
    }
    expect(remuxFolders()).toEqual(before)
  })

  it('refuses a file that is not a synthetic one, whatever else is true of it: a video of the user is never remuxed', async () => {
    const elsewhere = resolve(tmpdir(), 'dfs-no-such-recording.mkv')
    await expect(remuxPackets(elsewhere, 0)).rejects.toThrow(/synthetic/)
    await expect(remuxEntry(elsewhere, 0)).rejects.toThrow(/synthetic/)
  })

  it('rejects, with a sentence, for a stream that the file does not have', async () => {
    await expect(remuxPackets(mkv('h264-aac.mkv'), 99)).rejects.toThrow(/no stream 99/)
    await expect(remuxEntry(mkv('h264-aac.mkv'), 99)).rejects.toThrow(/no stream 99/)
  })
})

describe.skipIf(!remuxable)('probePacketsOf', () => {
  it('lists the packets of the stream with this index in the file, with their times in seconds', async () => {
    const sound = await probePacketsOf(mkv('h264-aac.mkv'), 1)
    expect(sound.length).toBeGreaterThan(500)
    expect(sound.every((packet) => packet.flags?.includes('K'))).toBe(true)
    // A Matroska file's AAC has its CodecDelay taken off every time: the first packet is before 0.
    expect(Number(sound[0]?.pts_time)).toBeCloseTo(-0.021, 3)
    const picture = await probePacketsOf(mkv('h264-aac.mkv'), 0)
    expect(picture.length).toBe(360)
    expect(Number(picture[1]?.pts_time)).toBeCloseTo(0.1, 6)
    // The position is the block's body: a number in the file.
    expect(Number(picture[0]?.pos)).toBeGreaterThan(0)
  })

  it('selects by the index in the file and not by the kind of stream: the third sound is the fourth stream', async () => {
    if (!existsSync(mkv('three-sounds.mkv'))) return
    const third = await probePacketsOf(mkv('three-sounds.mkv'), 3)
    const second = await probePacketsOf(mkv('three-sounds.mkv'), 2)
    expect(third.length).toBeGreaterThan(0)
    expect(third[0]?.pos).not.toBe(second[0]?.pos)
  })
})

import { describe, expect, it } from 'vitest'
import { childBoxes, Reader } from './boxes.ts'
import { codecString, initEntry } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import type { Mp4Refusal } from './errors.ts'
import { readMovie } from './movie.ts'
import type { SampleEntry } from './movie.ts'
import {
  audioEntry,
  audioSpecificConfig,
  av1C,
  avcC,
  box,
  concat,
  dOps,
  esds,
  fourcc,
  frma,
  fullBox,
  hvcC,
  movie,
  quickTimeAudioEntry,
  u32,
  visualEntry,
  wave,
} from './testing/build.ts'

/**
 * The entry as `readMovie` gives it: a view onto bytes that don't start at 0,
 * so that a read that forgets where a view begins reads the wrong bytes.
 */
function entryOf(bytes: Uint8Array): SampleEntry {
  const padded = concat([9, 9, 9, 9, 9], bytes, [7, 7, 7])
  return {
    type: String.fromCharCode(...bytes.subarray(4, 8)),
    bytes: padded.subarray(5, 5 + bytes.length),
  }
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

/** A sound entry's fields as ISO lays them out, read back from the bytes `initEntry` gives. */
function audioFields(bytes: Uint8Array) {
  const [whole, ...others] = childBoxes(bytes, 0, bytes.length)
  if (!whole || others.length > 0) throw new Error('expected one box')
  const reader = new Reader(bytes, whole.body, whole.end)
  reader.skip(6) // reserved
  const dataReferenceIndex = reader.u16()
  const version = reader.u16()
  reader.skip(6) // revision and vendor
  const channels = reader.u16()
  const sampleSize = reader.u16()
  const compressionId = reader.u16()
  const packetSize = reader.u16()
  const sampleRate = reader.u32() / 0x10000
  return {
    type: whole.type,
    dataReferenceIndex,
    version,
    channels,
    sampleSize,
    compressionId,
    packetSize,
    sampleRate,
    children: childBoxes(bytes, reader.position, whole.end).map((entry) => ({
      type: entry.type,
      bytes: bytes.subarray(entry.start, entry.end),
    })),
  }
}

describe('the codec string of a picture (§10.4)', () => {
  it('gives avc1 strings from avcC', () => {
    // High profile, level 3.1.
    const high = visualEntry('avc1', {}, avcC({ profile: 0x64, compatibility: 0, level: 0x1f }))
    expect(codecString(entryOf(high))).toBe('avc1.64001f')
    // Each byte is two digits, so a small one keeps its zero: Constrained Baseline, level 1.0.
    const baseline = visualEntry(
      'avc1',
      {},
      avcC({ profile: 0x42, compatibility: 0xc0, level: 0x0a }),
    )
    expect(codecString(entryOf(baseline))).toBe('avc1.42c00a')
    // An avc3 entry (the parameter sets may be in the stream) keeps its name.
    const main = visualEntry('avc3', {}, avcC({ profile: 0x4d, compatibility: 0x40, level: 0x28 }))
    expect(codecString(entryOf(main))).toBe('avc3.4d4028')
  })

  it('finds the avcC among the entry boxes that come before it', () => {
    const entry = visualEntry(
      'avc1',
      {},
      box('colr', fourcc('nclx'), [0, 1, 0, 1, 0, 1, 0x80]),
      box('pasp', u32(1), u32(1)),
      avcC({ profile: 0x64, level: 0x28 }),
    )
    expect(codecString(entryOf(entry))).toBe('avc1.640028')
  })

  it('refuses a picture entry whose configuration is missing or cut short', () => {
    refusal('damaged', () => codecString(entryOf(visualEntry('avc1'))))
    refusal('damaged', () =>
      codecString(entryOf(visualEntry('avc1', {}, box('avcC', [1, 0x64, 0])))),
    )
    refusal('damaged', () =>
      codecString(entryOf(visualEntry('hvc1', {}, box('hvcC', [1, 2, 0x20])))),
    )
    refusal('damaged', () => codecString(entryOf(visualEntry('av01', {}, box('av1C', [0x81, 0])))))
    // An entry that ends before the 78 bytes of its own fields has no room for any box.
    refusal('damaged', () => codecString(entryOf(box('avc1', [0, 0, 0, 0, 0, 0, 0, 1]))))
  })

  it('gives hvc1 and hev1 strings from hvcC', () => {
    // Main 10 at level 153 (5.1), constraints B0.
    const main10 = visualEntry(
      'hvc1',
      {},
      hvcC({
        profile: 2,
        compatibility: 0x20000000,
        constraints: [0xb0, 0, 0, 0, 0, 0],
        level: 153,
      }),
    )
    expect(codecString(entryOf(main10))).toBe('hvc1.2.4.L153.B0')
    // Main at level 93 (3.1): profiles 1 and 2 are both flagged, which reads 6 once the bits are reversed.
    const main = visualEntry('hev1', {}, hvcC({ profile: 1, compatibility: 0x60000000, level: 93 }))
    expect(codecString(entryOf(main))).toBe('hev1.1.6.L93.B0')
    // Profile space 1 is A, the high tier is H, and the bytes of the constraints are each as short as they go.
    const spaced = visualEntry(
      'hvc1',
      {},
      hvcC({
        profileSpace: 1,
        highTier: true,
        profile: 2,
        compatibility: 0x20000000,
        constraints: [0x90, 0, 0, 0, 0, 1],
        level: 153,
      }),
    )
    expect(codecString(entryOf(spaced))).toBe('hvc1.A2.4.H153.90.0.0.0.0.1')
  })

  it('reverses the compatibility flags bit by bit, whatever bits they are', () => {
    // The last flag is the top bit once reversed: 80000000, not a negative number.
    const last = visualEntry('hvc1', {}, hvcC({ profile: 1, compatibility: 0x00000001, level: 93 }))
    expect(codecString(entryOf(last))).toBe('hvc1.1.80000000.L93.B0')
    // A mix: flags 4 to 7 and 31 are set, and come out as bits 4 to 7 and bit 31 of the reversed word.
    const mixed = visualEntry(
      'hvc1',
      {},
      hvcC({ profile: 4, compatibility: 0x0f000001, level: 120 }),
    )
    expect(codecString(entryOf(mixed))).toBe('hvc1.4.800000F0.L120.B0')
    // The profile space is 2 or 3 as B and C.
    const space2 = visualEntry(
      'hvc1',
      {},
      hvcC({ profileSpace: 2, profile: 1, compatibility: 0x40000000 }),
    )
    expect(codecString(entryOf(space2))).toBe('hvc1.B1.2.L153.B0')
    const space3 = visualEntry('hvc1', {}, hvcC({ profileSpace: 3, profile: 31, compatibility: 0 }))
    expect(codecString(entryOf(space3))).toBe('hvc1.C31.0.L153.B0')
  })

  it('drops the constraint bytes that are zero at the end, and keeps one that is zero before another', () => {
    const middle = visualEntry(
      'hvc1',
      {},
      hvcC({ constraints: [0x80, 0, 0x04, 0, 0, 0], level: 120 }),
    )
    expect(codecString(entryOf(middle))).toBe('hvc1.2.4.L120.80.0.4')
    // With none set there is nothing to write after the level, and no dot left over.
    const none = visualEntry('hvc1', {}, hvcC({ constraints: [0, 0, 0, 0, 0, 0], level: 120 }))
    expect(codecString(entryOf(none))).toBe('hvc1.2.4.L120')
  })

  it('gives av01 strings from av1C', () => {
    // Main profile, level 3.1 is index 5, main tier, 8 bits.
    expect(codecString(entryOf(visualEntry('av01', {}, av1C())))).toBe('av01.0.05M.08')
    // Level 4.1 is index 13, in the high tier; 10 bits.
    const tenBit = visualEntry(
      'av01',
      {},
      av1C({ profile: 0, level: 13, tier: 1, highBitDepth: true }),
    )
    expect(codecString(entryOf(tenBit))).toBe('av01.0.13H.10')
    // Professional profile, 12 bits (which is 10-bit's flag and 12-bit's together).
    const twelve = visualEntry(
      'av01',
      {},
      av1C({ profile: 2, level: 8, highBitDepth: true, twelveBit: true }),
    )
    expect(codecString(entryOf(twelve))).toBe('av01.2.08M.12')
    // Level index 31 is the top of what the field holds.
    expect(
      codecString(entryOf(visualEntry('av01', {}, av1C({ profile: 1, level: 31, tier: 1 })))),
    ).toBe('av01.1.31H.08')
  })

  it('refuses a picture in any other codec, naming it', () => {
    for (const type of ['mp4v', 'jpeg', 'apch', 'dvh1', 'vp09', 'H264']) {
      const entry = entryOf(visualEntry(type))
      expect(refusal('unsupported-codec', () => codecString(entry)).message).toContain(type)
      expect(refusal('unsupported-codec', () => initEntry(entry)).message).toContain(type)
    }
  })
})

describe('the codec string of a sound (§10.4)', () => {
  it('gives mp4a.40.2 and mp4a.40.5, and the escaped object type', () => {
    const aac = audioEntry('mp4a', {}, esds({ config: audioSpecificConfig(2) }))
    expect(codecString(entryOf(aac))).toBe('mp4a.40.2')
    const he = audioEntry('mp4a', {}, esds({ config: audioSpecificConfig(5) }))
    expect(codecString(entryOf(he))).toBe('mp4a.40.5')
    // 31 says that the type is 32 plus the 6 bits after it: 42 is USAC.
    const usac = audioEntry('mp4a', {}, esds({ config: audioSpecificConfig(42) }))
    expect(codecString(entryOf(usac))).toBe('mp4a.40.42')
    // The first escaped value, and the last.
    const first = audioEntry('mp4a', {}, esds({ config: audioSpecificConfig(32) }))
    expect(codecString(entryOf(first))).toBe('mp4a.40.32')
    const last = audioEntry('mp4a', {}, esds({ config: audioSpecificConfig(95) }))
    expect(codecString(entryOf(last))).toBe('mp4a.40.95')
  })

  it('reads lengths of 4 bytes, and an ES_Descriptor with every optional field', () => {
    const wide = audioEntry('mp4a', {}, esds({ wide: true, config: audioSpecificConfig(29) }))
    expect(codecString(entryOf(wide))).toBe('mp4a.40.29')
    const flags = audioEntry(
      'mp4a',
      {},
      esds({ dependsOn: 7, url: 'x://y', clock: 9, config: audioSpecificConfig(5) }),
    )
    expect(codecString(entryOf(flags))).toBe('mp4a.40.5')
    const every = audioEntry(
      'mp4a',
      {},
      esds({ wide: true, dependsOn: 7, url: '', clock: 9, config: audioSpecificConfig(2) }),
    )
    expect(codecString(entryOf(every))).toBe('mp4a.40.2')
  })

  it('does not look at what comes after the descriptor it wants', () => {
    const body = esds().subarray(8)
    // Junk after the ES_Descriptor, in the esds: a stray zero is not a descriptor.
    const trailing = audioEntry('mp4a', {}, box('esds', body, [0]))
    expect(codecString(entryOf(trailing))).toBe('mp4a.40.2')
  })

  it('refuses a sound that is not MPEG-4 audio, naming its object type', () => {
    // MP3 has no DecoderSpecificInfo, so the object type has to be checked before one is asked for.
    const mp3 = audioEntry('mp4a', {}, esds({ objectType: 0x6b, config: null }))
    expect(refusal('unsupported-codec', () => codecString(entryOf(mp3))).message).toContain('0x6b')
    expect(refusal('unsupported-codec', () => initEntry(entryOf(mp3))).message).toContain('0x6b')
    // MPEG-2 AAC, with its config.
    const mpeg2 = audioEntry('mp4a', {}, esds({ objectType: 0x67 }))
    refusal('unsupported-codec', () => codecString(entryOf(mpeg2)))
  })

  it('refuses a sound entry whose esds is missing, cut short or lying', () => {
    // No esds at all.
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a'))))
    // An esds with nothing in it, and one with the version and flags only.
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, box('esds')))))
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, fullBox('esds', 0, 0)))))
    // An ES_Descriptor that claims more than the box holds.
    const whole = esds()
    const long = whole.slice()
    long[13] = (long[13] ?? 0) + 40 // the ES_Descriptor's length, after the box header, version and tag
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, long))))
    // A length that never ends: all 4 bytes say another follows.
    refusal('damaged', () =>
      codecString(
        entryOf(
          audioEntry('mp4a', {}, fullBox('esds', 0, 0, [0x03, 0x80, 0x80, 0x80, 0x80, 0x05, 1, 2])),
        ),
      ),
    )
    // No ES_Descriptor, but another descriptor: the esds is not about a stream.
    refusal('damaged', () =>
      codecString(entryOf(audioEntry('mp4a', {}, fullBox('esds', 0, 0, [0x06, 1, 2])))),
    )
    // An ES_Descriptor with no DecoderConfigDescriptor.
    refusal('damaged', () =>
      codecString(
        entryOf(audioEntry('mp4a', {}, fullBox('esds', 0, 0, [0x03, 5, 0, 1, 0, 0x06, 0]))),
      ),
    )
    // A DecoderConfigDescriptor that stops before its fields do.
    refusal('damaged', () =>
      codecString(
        entryOf(
          audioEntry('mp4a', {}, fullBox('esds', 0, 0, [0x03, 8, 0, 1, 0, 0x04, 3, 0x40, 0x15, 0])),
        ),
      ),
    )
    // MPEG-4 audio with no DecoderSpecificInfo, and with an empty one.
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, esds({ config: null })))))
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, esds({ config: [] })))))
    // A config that is only the first byte of an escaped object type.
    refusal('damaged', () => codecString(entryOf(audioEntry('mp4a', {}, esds({ config: [0xf8] })))))
  })

  it("reads a QuickTime v1 and v2 sound entry's esds through wave, and rewrites it as an ISO v0 mp4a", () => {
    const inner = esds({ config: audioSpecificConfig(2, { frequencyIndex: 3, channels: 6 }) })
    // Version 1: the wave that FFmpeg writes, with the frma, the empty mp4a atom, the esds and its terminator.
    const v1 = quickTimeAudioEntry(
      'mp4a',
      { version: 1, channels: 6, sampleRate: 48000 },
      wave(frma('mp4a'), box('mp4a', u32(0)), inner),
    )
    expect(codecString(entryOf(v1))).toBe('mp4a.40.2')
    const fromV1 = audioFields(initEntry(entryOf(v1)))
    expect(fromV1).toMatchObject({
      type: 'mp4a',
      dataReferenceIndex: 1,
      version: 0,
      channels: 6,
      sampleSize: 16,
      compressionId: 0,
      packetSize: 0,
      sampleRate: 48000,
    })
    expect(fromV1.children).toHaveLength(1)
    expect(fromV1.children[0]?.type).toBe('esds')
    expect(fromV1.children[0]?.bytes).toEqual(inner)

    // Version 2: 3 channels at a rate of 1 in the fields an ISO entry reads, and 6 channels at 48000 in the ones after them.
    const v2 = quickTimeAudioEntry(
      'mp4a',
      { version: 2, channels: 6, sampleRate: 48000 },
      wave(frma('mp4a'), inner, [0, 0, 0, 0]),
    )
    expect(codecString(entryOf(v2))).toBe('mp4a.40.2')
    const fromV2 = audioFields(initEntry(entryOf(v2)))
    expect(fromV2).toMatchObject({
      type: 'mp4a',
      dataReferenceIndex: 1,
      version: 0,
      channels: 6,
      sampleSize: 16,
      compressionId: 0,
      packetSize: 0,
      sampleRate: 48000,
    })
    expect(fromV2.children).toHaveLength(1)
    expect(fromV2.children[0]?.bytes).toEqual(inner)
  })

  it('rewrites an entry of version 1 or 2 whose esds is not in wave, and a version 0 one whose esds is only in wave', () => {
    const inner = esds()
    for (const version of [1, 2] as const) {
      const direct = quickTimeAudioEntry('mp4a', { version, channels: 1, sampleRate: 22050 }, inner)
      expect(codecString(entryOf(direct))).toBe('mp4a.40.2')
      const fields = audioFields(initEntry(entryOf(direct)))
      expect(fields).toMatchObject({ version: 0, channels: 1, sampleRate: 22050 })
      expect(fields.children.map((entry) => entry.bytes)).toEqual([inner])
    }
    const wrapped = audioEntry(
      'mp4a',
      { channels: 2, sampleRate: 32000 },
      wave(frma('mp4a'), inner),
    )
    expect(codecString(entryOf(wrapped))).toBe('mp4a.40.2')
    const fields = audioFields(initEntry(entryOf(wrapped)))
    expect(fields).toMatchObject({ version: 0, channels: 2, sampleRate: 32000 })
    expect(fields.children.map((entry) => entry.bytes)).toEqual([inner])
    // Nothing else of the wave comes along: no frma, no terminator.
    expect(fields.children.map((entry) => entry.type)).toEqual(['esds'])
  })

  it("keeps a version 1 entry's sample rate down to its fraction", () => {
    const inner = esds()
    const v1 = quickTimeAudioEntry(
      'mp4a',
      { version: 1, channels: 2, sampleRate: 44100.5 },
      wave(frma('mp4a'), inner),
    )
    expect(audioFields(initEntry(entryOf(v1))).sampleRate).toBe(44100.5)
  })

  it('refuses a version 2 rate that an ISO entry has no room for, and one that is not a rate', () => {
    const inner = esds()
    const high = quickTimeAudioEntry('mp4a', { version: 2, sampleRate: 96000 }, wave(inner))
    // The codec is as good as ever; it is the entry that can't be rewritten.
    expect(codecString(entryOf(high))).toBe('mp4a.40.2')
    refusal('unsupported-codec', () => initEntry(entryOf(high)))
    for (const rate of [0, -44100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const odd = quickTimeAudioEntry('mp4a', { version: 2, sampleRate: rate }, wave(inner))
      refusal('damaged', () => initEntry(entryOf(odd)))
    }
    // The widest rate that fits.
    const widest = quickTimeAudioEntry('mp4a', { version: 2, sampleRate: 65535 }, wave(inner))
    expect(audioFields(initEntry(entryOf(widest))).sampleRate).toBe(65535)
  })

  it('refuses a version 2 entry with more channels than an ISO one counts', () => {
    const entry = quickTimeAudioEntry('mp4a', { version: 2, channels: 70000 }, wave(esds()))
    refusal('damaged', () => initEntry(entryOf(entry)))
  })

  it('refuses a rewritten sound entry that has no channels or no sample rate', () => {
    const inner = esds()
    // Version 1, version 2, and a version 0 entry whose esds is in wave: each is rewritten, so each is checked.
    const noChannels = [
      quickTimeAudioEntry('mp4a', { version: 1, channels: 0 }, wave(frma('mp4a'), inner)),
      quickTimeAudioEntry('mp4a', { version: 2, channels: 0 }, wave(frma('mp4a'), inner)),
      audioEntry('mp4a', { channels: 0 }, wave(frma('mp4a'), inner)),
    ]
    const noRate = [
      quickTimeAudioEntry('mp4a', { version: 1, sampleRate: 0 }, wave(frma('mp4a'), inner)),
      quickTimeAudioEntry('mp4a', { version: 2, sampleRate: 0 }, wave(frma('mp4a'), inner)),
      audioEntry('mp4a', { sampleRate: 0 }, wave(frma('mp4a'), inner)),
    ]
    for (const bytes of [...noChannels, ...noRate]) {
      const entry = entryOf(bytes)
      // The codec is as good as ever; it is the entry that can't be written.
      expect(codecString(entry)).toBe('mp4a.40.2')
      refusal('damaged', () => initEntry(entry))
    }
    // A rate below what 16.16 can hold rounds to 0, which is no rate either.
    const tiny = quickTimeAudioEntry('mp4a', { version: 2, sampleRate: 1e-9 }, wave(inner))
    refusal('damaged', () => initEntry(entryOf(tiny)))
  })

  it('keeps the other boxes of a rewritten sound entry, after the esds and in their order', () => {
    const inner = esds()
    const chan = fullBox('chan', 0, 0, u32(100), u32(0), u32(0))
    const btrt = box('btrt', u32(0), u32(96000), u32(96000))
    // Version 1, with the wave first as QuickTime writes it: the esds, then the chan.
    const v1 = quickTimeAudioEntry(
      'mp4a',
      { version: 1, channels: 2, sampleRate: 48000 },
      wave(frma('mp4a'), inner),
      chan,
    )
    const fromV1 = audioFields(initEntry(entryOf(v1)))
    expect(fromV1.children.map((entry) => entry.type)).toEqual(['esds', 'chan'])
    expect(fromV1.children[0]?.bytes).toEqual(inner)
    expect(fromV1.children[1]?.bytes).toEqual(chan)
    // An esds that is a direct child comes first, whatever its place was; the others follow in theirs.
    const v2 = quickTimeAudioEntry(
      'mp4a',
      { version: 2, channels: 6, sampleRate: 48000 },
      chan,
      inner,
      btrt,
    )
    const fromV2 = audioFields(initEntry(entryOf(v2)))
    expect(fromV2.children.map((entry) => entry.type)).toEqual(['esds', 'chan', 'btrt'])
    expect(fromV2.children.map((entry) => entry.bytes)).toEqual([inner, chan, btrt])
    // A version 0 entry whose esds is in wave, between two others.
    const v0 = audioEntry('mp4a', {}, btrt, wave(frma('mp4a'), inner), chan)
    const fromV0 = audioFields(initEntry(entryOf(v0)))
    expect(fromV0.children.map((entry) => entry.bytes)).toEqual([inner, btrt, chan])
    // The size of the box is the size of what it holds.
    const out = initEntry(entryOf(v0))
    expect(out.length).toBe(8 + 28 + inner.length + btrt.length + chan.length)
  })

  it('refuses to rewrite an entry with a box after its esds that is cut short', () => {
    // The esds is found first, so the codec is named; the rest is carried, so it has to be whole.
    const cut = quickTimeAudioEntry('mp4a', { version: 1 }, esds(), [0, 0, 0, 9, 0x63, 0x68, 0x61])
    expect(codecString(entryOf(cut))).toBe('mp4a.40.2')
    refusal('damaged', () => initEntry(entryOf(cut)))
  })

  it('refuses a sound entry of a version it does not know, or cut short', () => {
    const bytes = audioEntry('mp4a', {}, esds()).slice()
    bytes[8 + 8 + 1] = 3 // the version, at 8 bytes into the body
    refusal('damaged', () => codecString(entryOf(bytes)))
    refusal('damaged', () => initEntry(entryOf(bytes)))
    // 20 bytes of an AudioSampleEntry where 28 are needed.
    refusal('damaged', () => codecString(entryOf(box('mp4a', new Array<number>(20).fill(0)))))
    // A version 2 entry that ends before its 36 extra bytes do.
    const cut = box('mp4a', [0, 0, 0, 0, 0, 0, 0, 1, 0, 2], new Array<number>(40).fill(0))
    refusal('damaged', () => codecString(entryOf(cut)))
  })

  it('copies an ISO v0 mp4a verbatim', () => {
    const entry = audioEntry(
      'mp4a',
      { channels: 2, sampleRate: 44100 },
      esds(),
      box('btrt', u32(0), u32(1), u32(2)),
    )
    const read = entryOf(entry)
    expect(initEntry(read)).toEqual(entry)
  })

  it('gives opus for an Opus entry, which is copied verbatim', () => {
    const entry = audioEntry('Opus', { channels: 2, sampleRate: 48000 }, dOps())
    expect(codecString(entryOf(entry))).toBe('opus')
    expect(initEntry(entryOf(entry))).toEqual(entry)
    // Without its dOps there is nothing to make a decoder from.
    refusal('damaged', () => codecString(entryOf(audioEntry('Opus', { sampleRate: 48000 }))))
  })

  it('refuses PCM and unknown entries', () => {
    const entries: Uint8Array[] = [
      audioEntry('ipcm', { sampleRate: 48000 }),
      audioEntry('sowt'),
      audioEntry('twos'),
      audioEntry('in24'),
      audioEntry('fl32'),
      audioEntry('lpcm'),
      audioEntry('raw '),
      audioEntry('ulaw'),
      audioEntry('.mp3'),
      audioEntry('ac-3'),
      audioEntry('ec-3'),
      quickTimeAudioEntry('sowt', { version: 1 }),
      visualEntry('mp4v'),
    ]
    for (const bytes of entries) {
      const entry = entryOf(bytes)
      expect(refusal('unsupported-codec', () => codecString(entry)).message).toContain(entry.type)
      expect(refusal('unsupported-codec', () => initEntry(entry)).message).toContain(entry.type)
    }
  })
})

describe('the entry an init segment carries (§10.4)', () => {
  it('copies other entries verbatim', () => {
    const entry = visualEntry(
      'hvc1',
      { width: 3840, height: 2160 },
      hvcC(),
      box('colr', fourcc('nclx'), [0, 9, 0, 16, 0, 9, 0x00]),
      box('mdcv', new Array<number>(24).fill(7)),
      box('clli', [3, 232, 1, 144]),
      box('pasp', u32(1), u32(1)),
    )
    const given = entryOf(entry)
    const carried = initEntry(given)
    expect(carried).toEqual(entry)
    // Not changed on the way, either: the bytes it was given are the bytes they were.
    expect(given.bytes).toEqual(entry)
    expect(codecString(given)).toBe('hvc1.2.4.L153.B0')
    for (const type of ['avc1', 'avc3', 'hev1', 'av01']) {
      const other = visualEntry(type, {}, avcC(), hvcC(), av1C())
      expect(initEntry(entryOf(other))).toEqual(other)
    }
  })

  it('refuses an entry that codecString refuses, for the same reason', () => {
    refusal('damaged', () => initEntry(entryOf(visualEntry('avc1'))))
    refusal('damaged', () => initEntry(entryOf(audioEntry('mp4a'))))
    refusal('damaged', () => initEntry(entryOf(audioEntry('Opus'))))
  })

  it('does not change the bytes of an entry it rewrites, and gives a new array', () => {
    const entry = quickTimeAudioEntry('mp4a', { version: 1 }, wave(frma('mp4a'), esds()))
    const given = entryOf(entry)
    const rewritten = initEntry(given)
    expect(given.bytes).toEqual(entry)
    expect(rewritten.buffer).not.toBe(given.bytes.buffer)
    expect(rewritten.byteOffset).toBe(0)
    expect(rewritten.byteLength).toBe(rewritten.buffer.byteLength)
  })

  it("is what readMovie's entries give", () => {
    const avc1 = visualEntry('avc1', {}, avcC())
    const mp4a = quickTimeAudioEntry(
      'mp4a',
      { version: 2, channels: 2, sampleRate: 44100 },
      wave(frma('mp4a'), esds()),
    )
    const read = readMovie(
      movie({
        tracks: [
          { id: 1, handler: 'vide', entries: [avc1] },
          { id: 2, handler: 'soun', entries: [mp4a] },
        ],
      }),
    )
    const [picture, sound] = read.tracks.flatMap((track) => track.entries)
    if (!picture || !sound) throw new Error('expected two entries')
    expect(codecString(picture)).toBe('avc1.64001f')
    expect(codecString(sound)).toBe('mp4a.40.2')
    expect(audioFields(initEntry(sound))).toMatchObject({
      version: 0,
      channels: 2,
      sampleRate: 44100,
    })
  })
})

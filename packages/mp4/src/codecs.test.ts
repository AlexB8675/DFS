import { describe, expect, it } from 'vitest'
import { childBoxes, Reader } from './boxes.ts'
import { codecNames, codecString, initEntry } from './codecs.ts'
import { Mp4Error } from './errors.ts'
import type { Mp4Refusal } from './errors.ts'
import { readMovie } from './movie.ts'
import type { SampleEntry } from './movie.ts'
import {
  alacConfig,
  audioEntry,
  audioSpecificConfig,
  av1C,
  avcC,
  box,
  concat,
  dac3,
  dec3,
  descriptor,
  dfLa,
  dolbyVisionConfig,
  dOps,
  esds,
  fourcc,
  frma,
  fullBox,
  hvcC,
  i16,
  movie,
  quickTimeAudioEntry,
  srat,
  u16,
  u32,
  visualEntry,
  vpcC,
  wave,
} from './testing/build.ts'
import type { Part } from './testing/build.ts'

/**
 * The entry as `readMovie` gives it: a view onto bytes that don't start at 0,
 * so that a read that forgets where a view begins reads the wrong bytes, and
 * the version of the `stsd` it is in.
 */
function entryOf(bytes: Uint8Array, stsdVersion = 0): SampleEntry {
  const padded = concat([9, 9, 9, 9, 9], bytes, [7, 7, 7])
  return {
    type: String.fromCharCode(...bytes.subarray(4, 8)),
    bytes: padded.subarray(5, 5 + bytes.length),
    stsdVersion,
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
    for (const type of ['mp4v', 'jpeg', 'apch', 'H264']) {
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

  it('halves a version 2 rate that an ISO entry has no room for, and refuses one that is not a rate', () => {
    const inner = esds()
    const high = quickTimeAudioEntry('mp4a', { version: 2, sampleRate: 96000 }, wave(inner))
    // The codec is as good as ever, and so is the entry: its rate field takes half, as FFmpeg writes it.
    expect(codecString(entryOf(high))).toBe('mp4a.40.2')
    expect(audioFields(initEntry(entryOf(high))).sampleRate).toBe(48000)
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

describe('codecNames', () => {
  it('gives H.264, HEVC and AV1 their one name, H.264 for all four of its types', () => {
    for (const type of ['avc1', 'avc2', 'avc3', 'avc4']) {
      const main = visualEntry(type, {}, avcC({ profile: 0x4d, compatibility: 0x40, level: 0x28 }))
      expect(codecNames(entryOf(main))).toEqual([`${type}.4d4028`])
    }
    expect(codecNames(entryOf(visualEntry('hvc1', {}, hvcC())))).toEqual(['hvc1.2.4.L153.B0'])
    expect(codecNames(entryOf(visualEntry('av01', {}, av1C())))).toEqual(['av01.0.05M.08'])
  })

  it('names VP9 from vpcC version 1, long form first', () => {
    const first = fullBox('vpcC', 1, 0, [0x00, 0x14, 0x82, 0x02, 0x02, 0x02, 0x00, 0x00])
    const second = fullBox('vpcC', 1, 0, [0x02, 0x14, 0xa2, 0x02, 0x02, 0x09, 0x00, 0x00])
    // The builder writes what the bytes above are.
    expect(vpcC()).toEqual(first)
    expect(vpcC({ profile: 2, bitDepth: 10, matrixCoefficients: 9 })).toEqual(second)

    expect(codecNames(entryOf(visualEntry('vp09', {}, first)))).toEqual([
      'vp09.00.20.08.01.02.02.02.00',
      'vp09.00.20.08',
    ])
    expect(codecNames(entryOf(visualEntry('vp09', {}, second)))).toEqual([
      'vp09.02.20.10.01.02.02.09.00',
      'vp09.02.20.10',
    ])
    // VP8 is named the same way.
    expect(codecNames(entryOf(visualEntry('vp08', {}, first)))).toEqual([
      'vp08.00.20.08.01.02.02.02.00',
      'vp08.00.20.08',
    ])
    expect(codecNames(entryOf(visualEntry('vp08', {}, second)))).toEqual([
      'vp08.02.20.10.01.02.02.09.00',
      'vp08.02.20.10',
    ])
  })

  it('names VP9 from vpcC version 0 by its short form only', () => {
    // Profile 1, level 3.1 and 10 bits, which version 0 holds in the high nibble of its third byte.
    const old = vpcC({ version: 0, profile: 1, level: 31, bitDepth: 10 })
    expect(codecNames(entryOf(visualEntry('vp09', {}, old)))).toEqual(['vp09.01.31.10'])
  })

  it('writes the fields of a VP9 name in decimal, two digits or more', () => {
    // Colour codes go up to 255, and are not cut to two digits; the flag and the chroma are.
    const wide = vpcC({
      profile: 3,
      level: 120,
      bitDepth: 12,
      chromaSubsampling: 3,
      fullRange: true,
      colourPrimaries: 100,
      transferCharacteristics: 255,
      matrixCoefficients: 99,
    })
    expect(codecNames(entryOf(visualEntry('vp09', {}, wide)))).toEqual([
      'vp09.03.120.12.03.100.255.99.01',
      'vp09.03.120.12',
    ])
  })

  it('names Dolby Vision from its config', () => {
    // The 4 bytes that the name is read from: the version, then 7 bits of profile and 6 of level.
    const profile8 = box('dvcC', [0x01, 0x00, 0x10, 0x35])
    expect(codecNames(entryOf(visualEntry('dvh1', {}, profile8)))).toEqual(['dvh1.08.06'])
    const profile5 = box('dvcC', [0x01, 0x00, 0x0a, 0x35])
    expect(codecNames(entryOf(visualEntry('dvhe', {}, profile5)))).toEqual(['dvhe.05.06'])
    const profile10 = dolbyVisionConfig('dvvC', { profile: 10, level: 9 })
    expect(codecNames(entryOf(visualEntry('dav1', {}, profile10)))).toEqual(['dav1.10.09'])
    // The whole record as Dolby writes it, behind the hvcC that the entry is also decoded from; and the third config box.
    expect(codecNames(entryOf(visualEntry('dvh1', {}, hvcC(), dolbyVisionConfig('dvcC'))))).toEqual(
      ['dvh1.08.06'],
    )
    const wide = dolbyVisionConfig('dvwC', { profile: 127, level: 63 })
    expect(codecNames(entryOf(visualEntry('dvav', {}, wide)))).toEqual(['dvav.127.63'])
    const low = dolbyVisionConfig('dvvC', { level: 1 })
    expect(codecNames(entryOf(visualEntry('dva1', {}, low)))).toEqual(['dva1.08.01'])
  })

  it('names MPEG audio by its object type', () => {
    const named = (objectType: number, config?: number[] | null) =>
      codecNames(
        entryOf(
          audioEntry('mp4a', {}, esds({ objectType, ...(config === undefined ? {} : { config }) })),
        ),
      )
    // MPEG-2 AAC, with its AudioSpecificConfig.
    expect(named(0x66)).toEqual(['mp4a.66'])
    expect(named(0x67)).toEqual(['mp4a.67'])
    expect(named(0x68)).toEqual(['mp4a.68'])
    // MPEG audio layer 3 has no DecoderSpecificInfo, and browsers know it by three names.
    expect(named(0x6b, null)).toEqual(['mp4a.6B', 'mp3', 'mp4a.40.34'])
    expect(named(0x69, null)).toEqual(['mp4a.69', 'mp3', 'mp4a.40.34'])
    // Dolby's AC-3 and E-AC-3.
    expect(named(0xa5, null)).toEqual(['mp4a.A5', 'ac-3'])
    expect(named(0xa6, null)).toEqual(['mp4a.A6', 'ec-3'])
    // Any other object type is named as it is, in two uppercase hex digits, for the browser to say no to.
    expect(named(0xdd, null)).toEqual(['mp4a.DD'])
    expect(named(0x05, null)).toEqual(['mp4a.05'])
    // MPEG-4 audio is as it was.
    expect(named(0x40)).toEqual(['mp4a.40.2'])
    // The entry is carried as it is, whatever it holds.
    const mp3 = audioEntry('mp4a', {}, esds({ objectType: 0x6b, config: null }))
    expect(initEntry(entryOf(mp3))).toEqual(mp3)
  })

  it('names FLAC, Opus, Dolby audio and ALAC, the config direct or in wave', () => {
    const flac = audioEntry('fLaC', {}, dfLa())
    expect(codecNames(entryOf(flac))).toEqual(['flac', 'fLaC'])
    const opus = audioEntry('Opus', { sampleRate: 48000 }, dOps())
    expect(codecNames(entryOf(opus))).toEqual(['opus', 'Opus'])
    const ac3 = audioEntry('ac-3', {}, dac3())
    expect(codecNames(entryOf(ac3))).toEqual(['ac-3'])
    // QuickTime's version 1 entry keeps the config inside its wave box.
    const wrapped = quickTimeAudioEntry(
      'ac-3',
      { version: 1 },
      wave(frma('ac-3'), dac3(), [0, 0, 0, 0]),
    )
    expect(codecNames(entryOf(wrapped))).toEqual(['ac-3'])
    expect(codecNames(entryOf(audioEntry('ec-3', {}, dec3())))).toEqual(['ec-3'])
    expect(codecNames(entryOf(audioEntry('alac', {}, alacConfig())))).toEqual(['alac'])
    // QuickTime's own MP3 entry holds nothing that its name is read from.
    const mp3 = quickTimeAudioEntry('.mp3', { version: 1 })
    expect(codecNames(entryOf(mp3))).toEqual(['mp4a.6B', 'mp3', 'mp4a.40.34'])
    expect(codecNames(entryOf(audioEntry('.mp3')))).toEqual(['mp4a.6B', 'mp3', 'mp4a.40.34'])
  })

  it("finds a sound's config where the entry's own layout puts it, after the fields of its version", () => {
    // Version 1 adds 16 bytes before the boxes, and version 2 adds 36: a config looked for 28 bytes in would not be found.
    for (const version of [1, 2] as const) {
      const flac = quickTimeAudioEntry('fLaC', { version }, dfLa())
      expect(codecNames(entryOf(flac)), `fLaC v${version}`).toEqual(['flac', 'fLaC'])
      const opus = quickTimeAudioEntry('Opus', { version, sampleRate: 48000 }, dOps())
      expect(codecNames(entryOf(opus)), `Opus v${version}`).toEqual(['opus', 'Opus'])
      const ec3 = quickTimeAudioEntry('ec-3', { version }, dec3())
      expect(codecNames(entryOf(ec3)), `ec-3 v${version}`).toEqual(['ec-3'])
      const alac = quickTimeAudioEntry('alac', { version }, wave(frma('alac'), alacConfig()))
      expect(codecNames(entryOf(alac)), `alac v${version}`).toEqual(['alac'])
    }
    // The same layout rule holds the entry to the versions it reads.
    const unknown = audioEntry('fLaC', {}, dfLa()).slice()
    unknown[8 + 8 + 1] = 3 // the version, at 8 bytes into the body
    refusal('damaged', () => codecNames(entryOf(unknown)))
  })

  it('gives codecString the first name, and a new array each time', () => {
    const entries = [
      visualEntry('avc1', {}, avcC()),
      visualEntry('vp09', {}, vpcC()),
      visualEntry('dvh1', {}, dolbyVisionConfig('dvcC')),
      audioEntry('mp4a', {}, esds({ objectType: 0x6b, config: null })),
      audioEntry('fLaC', {}, dfLa()),
      audioEntry('Opus', {}, dOps()),
      audioEntry('ac-3', {}, dac3()),
    ].map(entryOf)
    for (const entry of entries) {
      const names = codecNames(entry)
      expect(names.length).toBeGreaterThan(0)
      expect(codecString(entry), entry.type).toBe(names[0])
      expect(codecNames(entry)).not.toBe(names)
    }
    expect(codecString(entryOf(visualEntry('vp09', {}, vpcC())))).toBe(
      'vp09.00.20.08.01.02.02.02.00',
    )
  })

  it('refuses an entry with its config missing, as damaged', () => {
    const missing: [Uint8Array, string][] = [
      [visualEntry('vp09'), 'vpcC'],
      [visualEntry('vp08'), 'vpcC'],
      [visualEntry('dvh1'), 'dvcC'],
      [visualEntry('dav1'), 'dvvC'],
      [audioEntry('fLaC'), 'dfLa'],
      [audioEntry('ac-3'), 'dac3'],
      [audioEntry('ec-3'), 'dec3'],
      [audioEntry('alac'), 'alac'],
      [audioEntry('Opus'), 'dOps'],
    ]
    for (const [bytes, config] of missing) {
      const entry = entryOf(bytes)
      for (const run of [
        () => codecNames(entry),
        () => codecString(entry),
        () => initEntry(entry),
      ]) {
        const error = refusal('damaged', run)
        expect(error.message).toContain(`'${entry.type}'`)
        expect(error.message).toContain(`'${config}'`)
      }
    }
  })

  it('refuses a config that is cut short or of a version unknown, as damaged', () => {
    const vp = (...config: Uint8Array[]) => entryOf(visualEntry('vp09', {}, ...config))
    // A vpcC of version 1 needs its colour fields, and one of version 0 its three bytes; both need their version.
    refusal('damaged', () => codecNames(vp(fullBox('vpcC', 1, 0, [0, 20, 0x82]))))
    refusal('damaged', () => codecNames(vp(fullBox('vpcC', 0, 0, [0, 20]))))
    refusal('damaged', () => codecNames(vp(box('vpcC'))))
    refusal('damaged', () => codecNames(vp(fullBox('vpcC', 2, 0, [0, 20, 0x82, 2, 2, 2, 0, 0]))))
    // A Dolby Vision config that stops before its level does.
    refusal('damaged', () =>
      codecNames(entryOf(visualEntry('dvh1', {}, box('dvcC', [1, 0, 0x10])))),
    )
    // An MPEG-2 AAC sound with no DecoderSpecificInfo, an empty one, or one that is cut short.
    for (const config of [null, [], [0xf8]]) {
      const entry = audioEntry('mp4a', {}, esds({ objectType: 0x67, config }))
      refusal('damaged', () => codecNames(entryOf(entry)))
    }
    // A sound entry that ends before its own fields do, whatever its codec.
    for (const type of ['fLaC', 'ac-3', '.mp3']) {
      refusal('damaged', () => codecNames(entryOf(box(type, new Array<number>(20).fill(0)))))
    }
  })

  it('refuses what no browser takes in MP4', () => {
    const pictures = ['mp4v', 'vvc1', 'vvi1', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'jpeg']
    const sounds = [
      ...['ipcm', 'fpcm', 'sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32', 'fl64', 'raw ', 'NONE'],
      ...['dtsc', 'dtse', 'dtsh', 'dtsl', 'dtsx', 'ac-4', 'mha1', 'mha2', 'mhm1', 'mhm2'],
      ...['ulaw', 'alaw', 'enca'],
    ]
    const entries = [
      ...[...pictures, 'mjpa', 'mjpb', 'encv'].map((type) => visualEntry(type)),
      ...sounds.map((type) => audioEntry(type)),
    ]
    for (const bytes of entries) {
      const entry = entryOf(bytes)
      for (const run of [
        () => codecNames(entry),
        () => codecString(entry),
        () => initEntry(entry),
      ]) {
        const error = refusal('unsupported-codec', run)
        expect(error.message).toContain(`'${entry.type}'`)
        expect(error.message).toContain("any browser's Media Source")
      }
    }
  })
})

// IAMF's `iacb` box (IAMF v1.0 §3.2 and §6.2.4), as an FFmpeg-made file holds
// it and as the standard lays it out, byte by byte.

/** Bytes written as hex digits, in groups. */
function hexBytes(groups: readonly string[]): Uint8Array {
  return Uint8Array.from(groups.join(' ').split(' '), (digits) => Number.parseInt(digits, 16))
}

/**
 * The `iacb` box of an Opus IAMF file that FFmpeg made from a generated tone (a
 * mono channel-based audio element, and a mix of it for stereo): the box as the
 * file holds it, cut out of the sample entry. The file is not kept. It was made
 * in a scratch folder outside the repo with this command, the one the controller
 * checked on 2026-10-25:
 * `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:a libopus -stream_group "type=iamf_audio_element:id=1:st=0:audio_element_type=channel,layer=ch_layout=mono" -stream_group "type=iamf_mix_presentation:id=2:stg=0:annotations=en-us=default,submix=parameter_id=100:parameter_rate=48000|element=stg=0:parameter_id=101:parameter_rate=48000:annotations=en-us=main|layout=sound_system=stereo" -f mp4 iamf.mp4`
 */
const IACB_OPUS = hexBytes([
  '00 00 00 65 69 61 63 62 01 5b', // the box of 101 bytes, 'iacb', configurationVersion 1, configOBUs_size 91
  'f8 06 69 61 6d 66 00 00', // the Sequence Header (type 31, 6 bytes): 'iamf', primary profile 0, additional profile 0
  '00 14 00 4f 70 75 73 c0 07 ff fc 01 02 01 38 00 00 bb 80 00 00 00', // the Codec Config (type 0, 20 bytes): ID 0, 'Opus', 960 samples a frame, roll distance -4, then Opus's decoder config
  '08 0a 01 00 00 01 00 00 20 00 01 00', // an Audio Element (type 1, 10 bytes)
  '10 2f 02 01 65 6e 2d 75 73 00 64 65 66 61 75 6c 74 00 01 01 01 6d 61 69 6e 00 00 00 65 80 f7 02 80 00 00 64 80 f7 02 80 00 00 01 80 00 00 00 00 00', // a Mix Presentation (type 2, 47 bytes)
])

/** A number as IAMF's leb128 writes it: 7 bits at a time, the low group first, the top bit of every byte but the last saying that another follows. `length` pads it with groups of zero up to that many bytes, as a writer may. */
function leb128(value: number | bigint, length = 1): number[] {
  const groups: number[] = []
  let rest = BigInt(value)
  do {
    groups.push(Number(rest & 0x7fn))
    rest >>= 7n
  } while (rest > 0n)
  while (groups.length < length) groups.push(0)
  return groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group))
}

interface ObuSpec {
  /** The samples to trim at the end and at the start, which put two numbers after the size. */
  trim?: readonly [number, number]
  /** The bytes of an extension header, which put their number and themselves after the size and the trimming. */
  extension?: Part
  /** The redundant copy flag. */
  redundant?: boolean
  /** The size stated, in place of the size there is: for an OBU that lies. */
  size?: number | bigint
  /** The bytes of the size, padded with zero groups up to this many. */
  sizeLength?: number
}

/** An OBU: its type and flags in a byte, its size, the fields that the flags add, then the payload. The size counts everything after it. */
function obu(
  type: number,
  payload: Part,
  { trim, extension, redundant = false, size, sizeLength }: ObuSpec = {},
): number[] {
  const body = [
    ...(trim ? [...leb128(trim[0]), ...leb128(trim[1])] : []),
    ...(extension ? [...leb128(extension.length), ...extension] : []),
    ...payload,
  ]
  const flags = (redundant ? 4 : 0) | (trim ? 2 : 0) | (extension ? 1 : 0)
  return [(type << 3) | flags, ...leb128(size ?? body.length, sizeLength), ...body]
}

/** The IA Sequence Header: its code, `iamf`, then the primary and the additional profile. */
function sequenceHeader(primary = 0, additional = 0, spec?: ObuSpec): number[] {
  return obu(31, [...fourcc('iamf'), primary, additional], spec)
}

/** A Codec Config: its ID, the codec's, the samples in a frame, the roll distance, then the decoder config as given. */
function codecConfig(
  codec: string,
  decoder: Part,
  { samples = 960, roll = 0 }: { samples?: number; roll?: number } = {},
  spec?: ObuSpec,
): number[] {
  return obu(
    0,
    [...leb128(0), ...fourcc(codec), ...leb128(samples), ...i16(roll), ...decoder],
    spec,
  )
}

/** Opus's decoder config in IAMF: the version, the channels, the pre-skip, the input rate, the gain and the channel mapping family. */
const OPUS_CONFIG = [1, 2, ...u16(312), ...u32(48000), ...i16(0), 0]

/** The decoder config of AAC, which is a DecoderConfigDescriptor as an `esds` holds it, and the AudioSpecificConfig of an object type in its DecoderSpecificInfo. */
function aacConfig(objectType = 2, wide = false): number[] {
  return descriptor(
    0x04,
    [
      0x40, // MPEG-4 audio
      0x15, // an audio stream, and not an upstream
      ...[0, 0, 0], // the size of the buffer
      ...u32(0), // the highest bit rate
      ...u32(0), // the average bit rate
      ...descriptor(0x05, audioSpecificConfig(objectType), wide),
    ],
    wide,
  )
}

/** OBUs that are not read, with bytes that would be a Codec Config and a Sequence Header if they were: an Audio Element, a Mix Presentation, a Temporal Delimiter and one of a reserved type. */
const ELEMENT = obu(1, [0, ...fourcc('fLaC'), 1, 2, 3])
const MIX = obu(2, [31, 6, ...fourcc('iamf'), 9, 9])
const DELIMITER = obu(4, [])
const RESERVED = obu(26, [1, 2, 3])

/** An `iacb`: the version, the size of its OBUs, the OBUs. */
function iacb(...obus: number[][]): Uint8Array {
  const list = obus.flat()
  return box('iacb', [1], leb128(list.length), list)
}

describe('the codec string of IAMF (§10.4)', () => {
  /** An `iamf` entry as FFmpeg writes it, with no channels and no rate: IAMF says its own in its OBUs. */
  function iamfEntry(...children: Part[]): SampleEntry {
    return entryOf(audioEntry('iamf', { channels: 0, sampleRate: 0 }, ...children))
  }

  /** The error that each of `codecNames`, `codecString` and `initEntry` gives for an entry, which must all be of this reason. */
  function refusedByAll(reason: Mp4Refusal, entry: SampleEntry): Mp4Error[] {
    return [() => codecNames(entry), () => codecString(entry), () => initEntry(entry)].map((run) =>
      refusal(reason, run),
    )
  }

  const opusConfig = codecConfig('Opus', OPUS_CONFIG, { samples: 960, roll: -4 })

  it('names IAMF from its sequence header and codec config', () => {
    // FFmpeg's file: the profiles it writes are 0 and 0, and the codec is Opus.
    const real = iamfEntry(IACB_OPUS)
    expect(codecNames(real)).toEqual(['iamf.000.000.Opus'])
    expect(codecString(real)).toBe('iamf.000.000.Opus')
    // The builders write the same bytes as that file holds.
    const rest = Array.from(IACB_OPUS.subarray(40)) // the Audio Element and the Mix Presentation
    expect(iacb(sequenceHeader(), opusConfig, rest)).toEqual(IACB_OPUS)
    // An mp4a codec config says its audio object type in the AudioSpecificConfig inside its DecoderConfigDescriptor.
    const aac = codecConfig('mp4a', aacConfig(2), { samples: 1024, roll: -1 })
    const entry = iamfEntry(iacb(sequenceHeader(), aac, rest))
    expect(codecNames(entry)).toEqual(['iamf.000.000.mp4a.40.2'])
    expect(codecString(entry)).toBe('iamf.000.000.mp4a.40.2')
  })

  it('writes the profiles with three digits, and names the codec from its codec id', () => {
    const named = (primary: number, additional: number, config: number[]) =>
      codecNames(iamfEntry(iacb(sequenceHeader(primary, additional), config)))
    expect(named(1, 2, opusConfig)).toEqual(['iamf.001.002.Opus'])
    expect(named(12, 100, opusConfig)).toEqual(['iamf.012.100.Opus'])
    expect(named(255, 255, opusConfig)).toEqual(['iamf.255.255.Opus'])
    // FLAC and LPCM are named by their codec id alone: their decoder config is not read.
    expect(
      named(0, 0, codecConfig('fLaC', [0x80, 0, 0, 34, ...new Array<number>(34).fill(0)])),
    ).toEqual(['iamf.000.000.fLaC'])
    const lpcm = codecConfig('ipcm', [1, 16, ...u32(48000)], { samples: 1024 })
    expect(named(0, 0, lpcm)).toEqual(['iamf.000.000.ipcm'])
    // AAC by the audio object type it says, escaped above 30 as in an esds, and with the lengths of 4 bytes that some writers use.
    for (const [objectType, wide] of [
      [2, false],
      [2, true],
      [5, false],
      [29, true],
      [42, false],
    ] as const) {
      const aac = codecConfig('mp4a', aacConfig(objectType, wide), { roll: -1 })
      expect(named(0, 0, aac), `AOT ${objectType}${wide ? ', wide' : ''}`).toEqual([
        `iamf.000.000.mp4a.40.${objectType}`,
      ])
    }
  })

  it('reads the two OBUs in any order, and skips the others by their size', () => {
    const name = 'iamf.000.000.Opus'
    const sequence = sequenceHeader()
    // The standard puts the Sequence Header first, and a Codec Config before it is read as well.
    expect(codecNames(iamfEntry(iacb(opusConfig, sequence)))).toEqual([name])
    // What lies between them, or before them, is skipped by its size, whatever its bytes look like.
    const between = iacb(ELEMENT, DELIMITER, sequence, MIX, RESERVED, opusConfig, ELEMENT)
    expect(codecNames(iamfEntry(between))).toEqual([name])
    // The first of each is the one that counts.
    const twice = iacb(
      sequenceHeader(1, 0),
      codecConfig('fLaC', [0x80, 0, 0, 0]),
      sequenceHeader(2, 0),
      opusConfig,
    )
    expect(codecNames(iamfEntry(twice))).toEqual(['iamf.001.000.fLaC'])
    // Also when the other OBU comes only after the second of one kind.
    const flac = codecConfig('fLaC', [0x80, 0, 0, 0])
    const laterSequence = iacb(flac, opusConfig, sequenceHeader(1, 0))
    expect(codecNames(iamfEntry(laterSequence))).toEqual(['iamf.001.000.fLaC'])
    const laterConfig = iacb(sequenceHeader(1, 0), sequenceHeader(2, 0), opusConfig)
    expect(codecNames(iamfEntry(laterConfig))).toEqual(['iamf.001.000.Opus'])
    // An OBU may state more size than it needs, which is ignored; it may be a redundant copy, hold the fields of a trimming and of an extension (inside its size), and write its size in more bytes than it takes.
    const padded = iacb(
      sequenceHeader(0, 0, { trim: [3, 400], extension: [9, 9, 9], redundant: true }),
      codecConfig('Opus', OPUS_CONFIG, { samples: 960, roll: -4 }, { extension: [0x80, 0x80, 1] }),
    )
    expect(codecNames(iamfEntry(padded))).toEqual([name])
    const longer = iacb(
      obu(31, [...fourcc('iamf'), 0, 0, 7, 7, 7], { sizeLength: 4 }),
      codecConfig('Opus', [...OPUS_CONFIG, 7, 7, 7], {}, { sizeLength: 8 }),
    )
    expect(codecNames(iamfEntry(longer))).toEqual([name])
    // What follows the OBUs in the box is not read.
    const list = [...sequence, ...opusConfig]
    const trailing = box('iacb', [1], leb128(list.length), list, [1, 2, 3])
    expect(codecNames(iamfEntry(trailing))).toEqual([name])
  })

  it('reads a leb128 of up to 8 bytes, and refuses a longer one or one beyond what a number holds', () => {
    const name = ['iamf.000.000.Opus']
    // An 8-byte leb128 for the size of the list and for each field that is one, with its groups of zero.
    const body = [
      ...obu(31, [...fourcc('iamf'), 0, 0], { sizeLength: 8 }),
      ...obu(
        0,
        [...leb128(0, 8), ...fourcc('Opus'), ...leb128(960, 8), ...i16(-4), ...OPUS_CONFIG],
        { sizeLength: 8 },
      ),
    ]
    expect(codecNames(iamfEntry(box('iacb', [1], leb128(body.length, 8), body)))).toEqual(name)
    // The largest number is exact, and the next is not.
    const id = (value: number | bigint, length = 1) =>
      iamfEntry(
        iacb(
          sequenceHeader(),
          obu(0, [
            ...leb128(value, length),
            ...fourcc('Opus'),
            ...leb128(960),
            ...i16(-4),
            ...OPUS_CONFIG,
          ]),
        ),
      )
    expect(codecNames(id(Number.MAX_SAFE_INTEGER))).toEqual(name)
    refusedByAll('damaged', id(BigInt(Number.MAX_SAFE_INTEGER) + 1n))
    refusedByAll('damaged', id(2n ** 56n - 1n))
    // 9 bytes are too many, whatever they say.
    refusedByAll('damaged', id(5, 9))
    refusedByAll('damaged', id(0, 9))
    // The same in each place that a leb128 is: the size of the list, of an OBU, of a trimming or an extension, the samples in a frame.
    const nine = leb128(1, 9)
    const huge = leb128(Number.MAX_SAFE_INTEGER)
    const beyond = leb128(2n ** 53n)
    const iamf = fourcc('iamf')
    const cases: Uint8Array[] = [
      box('iacb', [1], nine, sequenceHeader(), opusConfig),
      box('iacb', [1], huge, sequenceHeader(), opusConfig),
      iacb(obu(31, [...fourcc('iamf'), 0, 0], { size: Number.MAX_SAFE_INTEGER }), opusConfig),
      iacb(sequenceHeader(), obu(0, [0], { size: 2n ** 56n - 1n })),
      iacb([31 << 3, ...nine], opusConfig),
      // A trimming, with a number of 9 bytes and then one beyond what a number holds; an extension, the size of which is huge and then 9 bytes.
      iacb([(31 << 3) | 2, 16, ...nine, 1, ...iamf, 0, 0], opusConfig),
      iacb([(31 << 3) | 2, 15, ...beyond, 1, ...iamf, 0, 0], opusConfig),
      iacb([(31 << 3) | 1, 14, ...huge, ...iamf, 0, 0], opusConfig),
      iacb([(31 << 3) | 1, 15, ...nine, ...iamf, 0, 0], opusConfig),
      iacb(
        sequenceHeader(),
        obu(0, [0, ...fourcc('Opus'), ...leb128(2n ** 53n), ...i16(-4), ...OPUS_CONFIG]),
      ),
      iacb(sequenceHeader(), obu(0, [0, ...fourcc('Opus'), ...nine, ...i16(-4), ...OPUS_CONFIG])),
    ]
    for (const [index, bytes] of cases.entries()) {
      for (const error of refusedByAll('damaged', iamfEntry(bytes))) {
        expect(error.message, `case ${index}`).not.toBe('')
      }
    }
  })

  it('refuses an IAMF entry whose iacb is missing, of another version or cut short, as damaged', () => {
    const sequence = sequenceHeader()
    // No iacb, with or without other boxes in the entry.
    for (const bytes of [
      audioEntry('iamf', { channels: 0, sampleRate: 0 }),
      audioEntry(
        'iamf',
        { channels: 0, sampleRate: 0 },
        box('btrt', new Array<number>(12).fill(0)),
      ),
      audioEntry('iamf', { channels: 2, sampleRate: 48000 }, dOps()),
    ]) {
      for (const error of refusedByAll('damaged', entryOf(bytes))) {
        expect(error.message).toContain("'iamf'")
        expect(error.message).toContain("'iacb'")
      }
    }
    // Another version than 1, which is the only one there is.
    const list = [...sequence, ...opusConfig]
    for (const version of [0, 2, 255]) {
      const entry = iamfEntry(box('iacb', [version], leb128(list.length), list))
      for (const error of refusedByAll('damaged', entry)) {
        expect(error.message).toContain("'iacb'")
        expect(error.message).toContain(`version ${version}`)
      }
    }
    // Cut short before its version, before its size or in the middle of it.
    for (const bytes of [box('iacb'), box('iacb', [1]), box('iacb', [1, 0x80])]) {
      for (const error of refusedByAll('damaged', iamfEntry(bytes))) {
        expect(error.message).not.toBe('')
      }
    }
    // Stating a size that is past the box, or an OBU size that is past the list.
    const past: Uint8Array[] = [
      box('iacb', [1, ...leb128(list.length + 1), ...list]),
      box('iacb', [1, ...leb128(list.length), ...list.slice(0, -1)]),
      iacb(sequence, obu(0, [0, ...fourcc('Opus')], { size: 40 })),
    ]
    for (const [index, bytes] of past.entries()) {
      for (const error of refusedByAll('damaged', iamfEntry(bytes))) {
        expect(error.message, `past ${index}`).toContain("'iacb'")
      }
    }
    // No Sequence Header, no Codec Config, or neither.
    const missing: [Uint8Array, string][] = [
      [iacb(opusConfig), 'Sequence Header'],
      [iacb(sequence), 'Codec Config'],
      [iacb(ELEMENT, MIX, DELIMITER, RESERVED), 'Sequence Header'],
      [iacb(), 'Sequence Header'],
      // A second of one kind does not stand in for the other.
      [iacb(sequence, sequenceHeader(1, 1)), 'Codec Config'],
      [iacb(opusConfig, codecConfig('fLaC', [0x80, 0, 0, 0])), 'Sequence Header'],
    ]
    for (const [bytes, what] of missing) {
      for (const error of refusedByAll('damaged', iamfEntry(bytes))) {
        expect(error.message).toContain("'iacb'")
        expect(error.message).toContain(what)
      }
    }
  })

  it('refuses a sequence header that is not IAMF, and a codec config that is cut short, as damaged', () => {
    const badCode = obu(31, [...fourcc('av1C'), 0, 0])
    const cases: number[][][] = [
      [badCode, opusConfig],
      // A Sequence Header that stops before its profiles.
      [obu(31, [...fourcc('iamf'), 0]), opusConfig],
      [obu(31, fourcc('iamf')), opusConfig],
      [obu(31, []), opusConfig],
      // A Codec Config that stops before each of its fields: its ID, its codec, its samples, its roll distance.
      ...[[], [0], [0, 0x4f, 0x70], [0, ...fourcc('Opus')], [0, ...fourcc('Opus'), 0x80]].map(
        (payload) => [sequenceHeader(), obu(0, payload)],
      ),
      [sequenceHeader(), obu(0, [0, ...fourcc('Opus'), ...leb128(960), 0xff])],
    ]
    for (const [index, obus] of cases.entries()) {
      for (const error of refusedByAll('damaged', iamfEntry(iacb(...obus)))) {
        expect(error.message, `case ${index}`).not.toBe('')
      }
    }
  })

  it("refuses an mp4a codec config without its DecoderConfigDescriptor's AudioSpecificConfig, as damaged", () => {
    // Bytes follow the Codec Config that a descriptor which runs on would read: valid DecoderConfigDescriptors, in an Audio Element.
    const aac = (decoder: Part) =>
      iamfEntry(
        iacb(
          sequenceHeader(),
          codecConfig('mp4a', decoder),
          obu(1, [...aacConfig(2), ...aacConfig(2), ...aacConfig(2)]),
        ),
      )
    const fields = [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0)]
    const cases: [string, Part][] = [
      ['no decoder config', []],
      ['no DecoderConfigDescriptor', descriptor(0x05, audioSpecificConfig(2))],
      ['no DecoderSpecificInfo', descriptor(0x04, fields)],
      ['an empty DecoderSpecificInfo', descriptor(0x04, [...fields, ...descriptor(0x05, [])])],
      ['a DecoderSpecificInfo cut short', descriptor(0x04, [...fields, 0x05, 4, 0x12])],
      ['a DecoderConfigDescriptor of too few bytes', descriptor(0x04, [0x40, 0x15, 0, 0])],
      ['a length of 5 bytes', [0x04, 0x80, 0x80, 0x80, 0x80, 0x01, ...fields]],
      ['an unfinished length', [0x04, 0x80]],
      ['a tag alone', [0x04]],
      // A descriptor whose length runs on into the OBUs that follow is not read there.
      ['a length past the OBU', [0x04, 100, 0x40]],
    ]
    for (const [what, decoder] of cases) {
      for (const error of refusedByAll('damaged', aac(decoder))) {
        expect(error.message, what).not.toBe('')
      }
    }
    // The same entry with a whole decoder config is named.
    expect(codecNames(aac(aacConfig(2)))).toEqual(['iamf.000.000.mp4a.40.2'])
  })

  it('refuses a codec that IAMF does not name, as unsupported-codec', () => {
    for (const codec of ['xxxx', 'opus', 'flac', 'ac-3', 'mp3 ']) {
      const entry = iamfEntry(iacb(sequenceHeader(), codecConfig(codec, [1, 2, 3])))
      for (const error of refusedByAll('unsupported-codec', entry)) {
        expect(error.message).toContain(`'${codec}'`)
        expect(error.message).toContain("any browser's Media Source")
      }
    }
  })

  it('carries an IAMF entry as it is, however many channels and what rate it says', () => {
    // FFmpeg writes 0 channels and a rate of 0: they are in the OBUs, so the entry is not refused for them.
    const real = iamfEntry(IACB_OPUS)
    expect(initEntry(real)).toBe(real.bytes)
    expect(audioFields(real.bytes)).toMatchObject({ type: 'iamf', channels: 0, sampleRate: 0 })
    const stereo = entryOf(audioEntry('iamf', { channels: 2, sampleRate: 48000 }, IACB_OPUS))
    expect(initEntry(stereo)).toBe(stereo.bytes)
  })

  it('rewrites an IAMF entry whose iacb is inside a wave box as ISO version 0, as for the other sound codecs', () => {
    const entry = quickTimeAudioEntry(
      'iamf',
      { version: 1, channels: 2, sampleRate: 48000 },
      wave(frma('iamf'), IACB_OPUS, [0, 0, 0, 0]),
    )
    expect(codecNames(entryOf(entry))).toEqual(['iamf.000.000.Opus'])
    const out = initEntry(entryOf(entry))
    expect(audioFields(out)).toMatchObject({
      type: 'iamf',
      version: 0,
      channels: 2,
      sampleRate: 48000,
    })
    expect(audioFields(out).children.map((one) => one.bytes)).toEqual([IACB_OPUS])
    const written = entryOf(out)
    expect(codecNames(written)).toEqual(['iamf.000.000.Opus'])
    expect(initEntry(written)).toBe(written.bytes)
  })

  it('is damaged or names the same for every prefix of an iacb, whatever size it states', () => {
    const name = ['iamf.000.000.Opus']
    const body = IACB_OPUS.subarray(8) // after the box's size and type: the version, the size of the OBUs, the OBUs
    // As it was cut, so that the size it states is past its end.
    for (let length = 0; length < body.length; length += 1) {
      refusedByAll('damaged', iamfEntry(box('iacb', body.subarray(0, length))))
    }
    const whole = iamfEntry(box('iacb', body))
    expect(codecNames(whole)).toEqual(name)
    expect(initEntry(whole)).toBe(whole.bytes)
    // As it was cut with the size of what is left, which only a cut inside the two OBUs that are read can make wrong: the Sequence Header and the Codec Config, of 8 and 22 bytes. A cut after them leaves what is not read.
    const list = body.subarray(2)
    for (let length = 0; length <= list.length; length += 1) {
      const entry = iamfEntry(iacb(Array.from(list.subarray(0, length))))
      if (length < 8 + 22) {
        refusedByAll('damaged', entry)
      } else {
        expect(codecNames(entry), `${length} bytes of the OBUs`).toEqual(name)
        expect(initEntry(entry), `${length} bytes of the OBUs`).toBe(entry.bytes)
      }
    }
  })
})

/** The `esds` that a QuickTime MP3 entry is given: an ES_Descriptor, a DecoderConfigDescriptor of object type 0x6B (MPEG-1 audio) for an audio stream with no DecoderSpecificInfo, and an SLConfigDescriptor of 2. */
const MP3_ESDS = Uint8Array.from(
  '00 00 00 23 65 73 64 73 00 00 00 00 03 15 00 00 00 04 0d 6b 15 00 00 00 00 00 00 00 00 00 00 00 06 01 02'
    .split(' ')
    .map((digits) => Number.parseInt(digits, 16)),
)

describe('initEntry', () => {
  const chan = fullBox('chan', 0, 0, u32(100), u32(0), u32(0))

  /** The types of the boxes an entry that `initEntry` wrote holds after its fields, and their bytes. */
  function childrenOf(bytes: Uint8Array): { types: string[]; bytes: Uint8Array[] } {
    const { children } = audioFields(bytes)
    return { types: children.map((one) => one.type), bytes: children.map((one) => one.bytes) }
  }

  it('rewrites a QuickTime version 1 AC-3 entry as ISO version 0, its dac3 out of the wave', () => {
    const config = dac3()
    const entry = quickTimeAudioEntry(
      'ac-3',
      { version: 1, channels: 6, sampleRate: 48000 },
      wave(frma('ac-3'), config, [0, 0, 0, 0]),
      chan,
    )
    const out = initEntry(entryOf(entry))
    expect(audioFields(out)).toMatchObject({
      type: 'ac-3',
      dataReferenceIndex: 1,
      version: 0,
      channels: 6,
      sampleSize: 16,
      compressionId: 0,
      packetSize: 0,
      sampleRate: 48000,
    })
    expect(childrenOf(out).bytes).toEqual([config, chan])
    // What is written is what Media Source takes: it names the same codec, and has nothing left to rewrite.
    const written = entryOf(out)
    expect(codecNames(written)).toEqual(['ac-3'])
    expect(initEntry(written)).toBe(written.bytes)
  })

  it('rewrites QuickTime ALAC at 96 kHz (version 2) with a rate field of 48000', () => {
    const config = alacConfig()
    const entry = quickTimeAudioEntry(
      'alac',
      { version: 2, channels: 2, sampleRate: 96000 },
      wave(frma('alac'), config, [0, 0, 0, 0]),
    )
    expect(codecNames(entryOf(entry))).toEqual(['alac'])
    const out = initEntry(entryOf(entry))
    expect(audioFields(out)).toMatchObject({
      type: 'alac',
      version: 0,
      channels: 2,
      sampleSize: 16,
      sampleRate: 48000,
    })
    expect(childrenOf(out).bytes).toEqual([config])
  })

  it('rewrites QuickTime MP3 (.mp3, version 1) as an mp4a with a made esds', () => {
    const entry = quickTimeAudioEntry('.mp3', { version: 1, channels: 2, sampleRate: 44100 })
    const out = initEntry(entryOf(entry))
    expect(audioFields(out)).toMatchObject({
      type: 'mp4a',
      dataReferenceIndex: 1,
      version: 0,
      channels: 2,
      sampleSize: 16,
      sampleRate: 44100,
    })
    expect(childrenOf(out).bytes).toEqual([MP3_ESDS])
    // Read back as an entry, it is MPEG-1 audio layer 3 by its three names.
    expect(codecNames(entryOf(out))).toEqual(['mp4a.6B', 'mp3', 'mp4a.40.34'])
    // ISO's version 0 shape of the same type is written the same way; the entry's own boxes follow the esds.
    const plain = initEntry(entryOf(audioEntry('.mp3', { channels: 1, sampleRate: 22050 }, chan)))
    expect(audioFields(plain)).toMatchObject({ type: 'mp4a', channels: 1, sampleRate: 22050 })
    expect(childrenOf(plain).bytes).toEqual([MP3_ESDS, chan])
    // A wave and an esds of the entry's own are not carried: the made one is the configuration.
    const stray = quickTimeAudioEntry(
      '.mp3',
      { version: 2, channels: 2, sampleRate: 48000 },
      wave(frma('.mp3'), box('mp4a', u32(0)), esds({ objectType: 0x6b, config: null })),
      chan,
      esds(),
    )
    expect(childrenOf(initEntry(entryOf(stray))).bytes).toEqual([MP3_ESDS, chan])
  })

  it('reads an ISO AudioSampleEntryV1 in an stsd of version 1, and writes it as version 0', () => {
    const config = dfLa()
    // The 16.16 field of a version 1 entry is a placeholder: the rate is in the srat.
    const entry = audioEntry(
      'fLaC',
      { version: 1, channels: 2, sampleRate: 44100 },
      srat(96000),
      config,
    )
    const given = entryOf(entry, 1)
    expect(codecNames(given)).toEqual(['flac', 'fLaC'])
    const out = initEntry(given)
    expect(audioFields(out)).toMatchObject({
      type: 'fLaC',
      dataReferenceIndex: 1,
      version: 0,
      channels: 2,
      sampleSize: 16,
      sampleRate: 48000,
    })
    expect(childrenOf(out).types).toEqual(['dfLa'])
    expect(childrenOf(out).bytes).toEqual([config])

    // An srat is 16 bytes, as many as QuickTime's version 1 adds, so the old rule finds the dfLa too: but it takes the rate of the field, and not the srat's.
    const old = initEntry(entryOf(entry, 0))
    expect(audioFields(old).sampleRate).toBe(44100)
    expect(childrenOf(old).bytes).toEqual([config])

    // With no srat the rate is the field's, and the dfLa follows the 28 bytes: the old rule would skip 16 bytes of it.
    const bare = audioEntry('Opus', { version: 1, channels: 2, sampleRate: 48000 }, dOps())
    const fromBare = initEntry(entryOf(bare, 1))
    expect(audioFields(fromBare)).toMatchObject({ type: 'Opus', version: 0, sampleRate: 48000 })
    expect(childrenOf(fromBare).bytes).toEqual([dOps()])
    refusal('damaged', () => initEntry(entryOf(bare, 0)))
  })

  it('refuses an srat that is cut short, or gives no rate, as damaged', () => {
    const given = (rate: Uint8Array) => entryOf(audioEntry('fLaC', { version: 1 }, rate, dfLa()), 1)
    refusal('damaged', () => initEntry(given(srat(0))))
    refusal('damaged', () => initEntry(given(fullBox('srat', 0, 0, [0, 0]))))
    refusal('damaged', () => initEntry(given(box('srat'))))
  })

  it('refuses an entry of version 2 in an stsd of version 1, as damaged', () => {
    const quickTime = quickTimeAudioEntry('fLaC', { version: 2 }, dfLa())
    for (const bytes of [quickTime, audioEntry('fLaC', { version: 3 }, dfLa())]) {
      const given = entryOf(bytes, 1)
      refusal('damaged', () => codecNames(given))
      refusal('damaged', () => initEntry(given))
    }
    // The same bytes in an stsd of version 0 are QuickTime's version 2, and are read so.
    expect(codecNames(entryOf(quickTime, 0))).toEqual(['flac', 'fLaC'])
  })

  it('returns an ISO version 0 entry with its config inside as it is', () => {
    const entries = [
      audioEntry('fLaC', { sampleRate: 44100.5 }, dfLa()),
      audioEntry('ac-3', { channels: 6, sampleRate: 48000 }, dac3(), chan),
      audioEntry('Opus', { sampleRate: 0, sampleSize: 24 }, dOps()),
      audioEntry('mp4a', { sampleRate: 44100.5 }, esds(), chan),
      audioEntry('ec-3', {}, dec3()),
      audioEntry('alac', {}, alacConfig()),
    ]
    for (const bytes of entries) {
      const given = entryOf(bytes, 0)
      const out = initEntry(given)
      expect(out, given.type).toBe(given.bytes)
      expect(out, given.type).toEqual(bytes)
    }
  })

  it('writes an entry of an stsd of version 1 afresh, even when it is of version 0', () => {
    const entry = audioEntry('ac-3', { sampleSize: 24 }, dac3())
    const given = entryOf(entry, 1)
    const out = initEntry(given)
    expect(out).not.toBe(given.bytes)
    expect(audioFields(out)).toMatchObject({ type: 'ac-3', version: 0, sampleSize: 16 })
    expect(childrenOf(out).bytes).toEqual([dac3()])
  })

  it('keeps the 192000 and 88200 rates as 48000 and 44100', () => {
    const rate = (sampleRate: number) =>
      audioFields(
        initEntry(
          entryOf(
            quickTimeAudioEntry('fLaC', { version: 2, sampleRate }, wave(frma('fLaC'), dfLa())),
          ),
        ),
      ).sampleRate
    // As often as it takes to fit the 16 bits: 96000 once, 192000 twice, 88200 once.
    expect(rate(192000)).toBe(48000)
    expect(rate(88200)).toBe(44100)
    expect(rate(96000)).toBe(48000)
    expect(rate(65536)).toBe(32768)
    // The widest rate that fits, and one below it, are as they are.
    expect(rate(65535)).toBe(65535)
    expect(rate(48000)).toBe(48000)
    // An ISO version 1 entry has its rate in the srat, which has room for these.
    const iso = audioEntry('fLaC', { version: 1, sampleRate: 48000 }, srat(192000), dfLa())
    expect(audioFields(initEntry(entryOf(iso, 1))).sampleRate).toBe(48000)
    const dsd = audioEntry('fLaC', { version: 1, sampleRate: 48000 }, srat(88200), dfLa())
    expect(audioFields(initEntry(entryOf(dsd, 1))).sampleRate).toBe(44100)
  })

  it('refuses a rewritten entry of any sound codec that has no channels or no rate', () => {
    const entries: [string, Uint8Array][] = [
      ['ac-3', dac3()],
      ['ec-3', dec3()],
      ['alac', alacConfig()],
      ['fLaC', dfLa()],
      ['Opus', dOps()],
      ['.mp3', new Uint8Array()],
    ]
    for (const [type, config] of entries) {
      const wrapped = wave(frma(type), config)
      for (const bytes of [
        quickTimeAudioEntry(type, { version: 1, channels: 0 }, wrapped),
        quickTimeAudioEntry(type, { version: 2, channels: 0 }, wrapped),
        quickTimeAudioEntry(type, { version: 1, sampleRate: 0 }, wrapped),
        quickTimeAudioEntry(type, { version: 2, sampleRate: 0 }, wrapped),
        quickTimeAudioEntry(type, { version: 2, sampleRate: Number.NaN }, wrapped),
      ]) {
        refusal('damaged', () => initEntry(entryOf(bytes)))
      }
    }
  })

  it('drops the wave, the srat and a second config box, and keeps the other boxes in their order', () => {
    const btrt = box('btrt', u32(0), u32(96000), u32(96000))
    const second = box('dac3', [1, 2, 3])
    const entry = quickTimeAudioEntry(
      'ac-3',
      { version: 1 },
      btrt,
      wave(frma('ac-3'), second),
      dac3(),
      chan,
      second,
    )
    // The config is the entry's own and not the wave's, and comes first; the second dac3 is gone with the wave.
    const out = initEntry(entryOf(entry))
    expect(childrenOf(out).types).toEqual(['dac3', 'btrt', 'chan'])
    expect(childrenOf(out).bytes).toEqual([dac3(), btrt, chan])
    // The srat of an ISO version 1 entry is not carried either, wherever it is.
    const iso = audioEntry('Opus', { version: 1 }, btrt, srat(48000), dOps(), srat(44100), chan)
    expect(childrenOf(initEntry(entryOf(iso, 1))).types).toEqual(['dOps', 'btrt', 'chan'])
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

  it('copies the entries of the other codecs it names verbatim', () => {
    const entries = [
      visualEntry('vp09', {}, vpcC()),
      visualEntry('vp08', {}, vpcC()),
      visualEntry('dvh1', {}, hvcC(), dolbyVisionConfig('dvcC')),
      visualEntry('avc2', {}, avcC()),
      audioEntry('fLaC', {}, dfLa()),
      audioEntry('ac-3', {}, dac3()),
      audioEntry('ec-3', {}, dec3()),
      audioEntry('alac', {}, alacConfig()),
    ]
    for (const bytes of entries) {
      expect(initEntry(entryOf(bytes)), String.fromCharCode(...bytes.subarray(4, 8))).toEqual(bytes)
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

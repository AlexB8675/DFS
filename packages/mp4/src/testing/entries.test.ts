import { describe, expect, it } from 'vitest'
import { initEntry } from '../codecs.ts'
import type { SampleEntry } from '../movie.ts'
import {
  audioSpecificConfig,
  avcC,
  audioEntry,
  box,
  esds,
  frma,
  fullBox,
  quickTimeAudioEntry,
  stsd,
  u32,
  visualEntry,
  wave,
} from './build.ts'
import { configProblems, MP3_ESDS, writtenEntry } from './entries.ts'

// The corpus suite's check that the init entry the writer wrote holds the source
// entry's codec configuration box byte for byte (DESIGN.md §10.4): the
// boxes that ffmpeg's decode cannot vouch for, because its decoders for AAC and
// AC-3 take what they need from the frames.

function entryOf(type: string, bytes: Uint8Array, stsdVersion = 0): SampleEntry {
  return { type, bytes, stsdVersion }
}

const DAC3 = box('dac3', [0x50, 0x11, 0x60])
const OTHER_DAC3 = box('dac3', [0x50, 0x11, 0x40])

describe('writtenEntry', () => {
  /** An init segment's boxes down to the `stsd`, around the entry. */
  function init(...entries: Uint8Array[]): Uint8Array {
    return box(
      'moov',
      box('mvhd', new Array<number>(100).fill(0)),
      box('trak', box('mdia', box('minf', box('stbl', stsd(entries))))),
      box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))),
    )
  }

  it('is the first entry of the stsd of the init segment, with the version of the stsd', () => {
    const entry = audioEntry('ac-3', {}, DAC3)
    const found = writtenEntry(init(entry))
    expect(found.type).toBe('ac-3')
    expect(found.stsdVersion).toBe(0)
    expect(Array.from(found.bytes)).toEqual(Array.from(entry))
  })

  it('says which box is missing, when the init segment has no entry', () => {
    expect(() => writtenEntry(box('moov', box('mvex')))).toThrow(/'trak'/)
    expect(() => writtenEntry(init())).toThrow(/entry/)
  })
})

describe('configProblems', () => {
  it('has nothing to say when the written entry holds the same configuration box', () => {
    const entry = audioEntry('ac-3', {}, DAC3)
    expect(configProblems(entryOf('ac-3', entry), entryOf('ac-3', entry), false)).toEqual([])
  })

  it('finds the source box inside a wave box, after the fields of QuickTime version 1 and 2, and the written one directly', () => {
    for (const version of [1, 2] as const) {
      const source = quickTimeAudioEntry('ac-3', { version }, wave(frma('ac-3'), DAC3))
      const written = audioEntry('ac-3', { channels: 1, sampleRate: 48000 }, DAC3)
      expect(configProblems(entryOf('ac-3', source), entryOf('ac-3', written), false)).toEqual([])
    }
  })

  it('reads an ISO version 1 entry as it has no more fields than version 0, and a QuickTime one as it has more', () => {
    const iso = audioEntry('ac-3', { version: 1 }, DAC3)
    const written = audioEntry('ac-3', {}, DAC3)
    expect(configProblems(entryOf('ac-3', iso, 1), entryOf('ac-3', written), false)).toEqual([])
  })

  it('names the box that the written entry lacks', () => {
    const source = audioEntry('ac-3', {}, DAC3)
    const written = audioEntry('ac-3', {})
    expect(configProblems(entryOf('ac-3', source), entryOf('ac-3', written), false)).toEqual([
      "the written init entry has no 'dac3' box (the source's has 11 bytes)",
    ])
  })

  it('names the box that differs, and where', () => {
    const source = audioEntry('ac-3', {}, DAC3)
    const written = audioEntry('ac-3', {}, OTHER_DAC3)
    expect(configProblems(entryOf('ac-3', source), entryOf('ac-3', written), false)).toEqual([
      "the 'dac3' box of the written init entry differs from the source's, first at its byte 10",
    ])
    // The same bytes and a different length.
    const longer = audioEntry('ac-3', {}, box('dac3', [0x50, 0x11, 0x60, 0x00]))
    expect(configProblems(entryOf('ac-3', source), entryOf('ac-3', longer), false)).toEqual([
      "the 'dac3' box of the written init entry has 12 bytes, and the source's 11",
    ])
  })

  it('compares each configuration box that the source has, and no other box', () => {
    const source = audioEntry('mp4a', {}, esds(), box('btrt', [0, 0, 0, 0]), box('chan', [1]))
    const written = audioEntry('mp4a', {}, esds(), box('btrt', [9, 9, 9, 9]))
    expect(configProblems(entryOf('mp4a', source), entryOf('mp4a', written), false)).toEqual([])
    const without = audioEntry('mp4a', {}, box('btrt', [0, 0, 0, 0]))
    expect(configProblems(entryOf('mp4a', source), entryOf('mp4a', without), false)).toEqual([
      expect.stringMatching(/no 'esds' box/),
    ])
  })

  it("compares a picture's configuration boxes, Dolby Vision's among them when it has them", () => {
    const dolby = box('dvcC', [1, 0, 0x10, 0x10])
    const source = visualEntry('dvh1', {}, box('hvcC', [1, 2, 3]), dolby, box('pasp', [0, 0, 0, 1]))
    const written = visualEntry('dvh1', {}, box('hvcC', [1, 2, 3]), box('pasp', [0, 0, 0, 1]))
    expect(configProblems(entryOf('dvh1', source), entryOf('dvh1', source), true)).toEqual([])
    expect(configProblems(entryOf('dvh1', source), entryOf('dvh1', written), true)).toEqual([
      expect.stringMatching(/no 'dvcC' box/),
    ])
    const plain = visualEntry('avc1', {}, avcC())
    expect(configProblems(entryOf('avc1', plain), entryOf('avc1', plain), true)).toEqual([])
    const changed = visualEntry('avc1', {}, box('avcC', [1, 100, 0, 31]))
    expect(configProblems(entryOf('avc1', plain), entryOf('avc1', changed), true)).toEqual([
      expect.stringMatching(/'avcC' box of the written init entry/),
    ])
  })

  it("expects QuickTime's .mp3, which has no configuration box, to be written with the esds that is made for it", () => {
    const source = quickTimeAudioEntry('.mp3', { version: 1 })
    const made = audioEntry('mp4a', {}, MP3_ESDS)
    expect(configProblems(entryOf('.mp3', source), entryOf('mp4a', made), false)).toEqual([])
    const other = audioEntry('mp4a', {}, esds({ objectType: 0x6b, config: null }))
    expect(configProblems(entryOf('.mp3', source), entryOf('mp4a', other), false)).toEqual([
      expect.stringMatching(/'esds' box of the written init entry/),
    ])
    expect(
      configProblems(entryOf('.mp3', source), entryOf('mp4a', audioEntry('mp4a', {})), false),
    ).toEqual([expect.stringMatching(/no 'esds' box/)])
  })

  describe("the object type of MPEG-2 AAC, which is written as MPEG-4 audio's", () => {
    const config = audioSpecificConfig(2)
    const sound = (objectType: number, ...spec: Parameters<typeof esds>) =>
      entryOf('mp4a', audioEntry('mp4a', {}, esds({ objectType, config, ...spec[0] })))

    it.each([
      ['0x66', 0x66],
      ['0x67', 0x67],
      ['0x68', 0x68],
    ])(
      'allows the one byte of an esds to say 0x40 where the source says %s',
      (_name, objectType) => {
        expect(configProblems(sound(objectType), sound(0x40), false)).toEqual([])
      },
    )

    it('allows it for the esds in a QuickTime wave, and with the descriptors wide and a URL in the way', () => {
      const wide = { wide: true, url: 'a.mp4', clock: 7, dependsOn: 3 }
      const source = entryOf(
        'mp4a',
        quickTimeAudioEntry(
          'mp4a',
          { version: 1 },
          wave(frma('mp4a'), esds({ objectType: 0x67, config, ...wide })),
        ),
      )
      expect(configProblems(source, sound(0x40, wide), false)).toEqual([])
    })

    it('allows nothing else of the esds: not the other way round, not another object type, not another byte', () => {
      const problem = [expect.stringMatching(/^the 'esds' box of the written init entry differs/)]
      // MPEG-4 audio written as MPEG-2 AAC, MPEG-2 AAC written as another object type, or left as it was.
      expect(configProblems(sound(0x40), sound(0x67), false)).toEqual(problem)
      expect(configProblems(sound(0x67), sound(0x41), false)).toEqual(problem)
      expect(configProblems(sound(0x67), sound(0x68), false)).toEqual(problem)
      // The object types that are not MPEG-2 AAC's are carried as they are.
      for (const other of [0x69, 0x6b, 0xa5, 0xdd]) {
        expect(configProblems(sound(other), sound(0x40), false)).toEqual(problem)
      }
      // The object type changed and something else with it: a byte of the AudioSpecificConfig, or of the bit rates.
      const other = entryOf(
        'mp4a',
        audioEntry('mp4a', {}, esds({ objectType: 0x40, config: audioSpecificConfig(5) })),
      )
      expect(configProblems(sound(0x67), other, false)).toEqual(problem)
      // A byte that is 0x67 in the source and 0x40 in the written esds, but is not the object type.
      const odd = (byte: number) =>
        entryOf('mp4a', audioEntry('mp4a', {}, esds({ objectType: 0x40, config: [byte, 0x90] })))
      expect(configProblems(odd(0x67), odd(0x40), false)).toEqual(problem)
    })

    it('allows it for the esds alone', () => {
      const dac3 = (byte: number) =>
        entryOf('ac-3', audioEntry('ac-3', {}, box('dac3', [byte, 0x11, 0x60])))
      expect(configProblems(dac3(0x67), dac3(0x40), false)).toEqual([
        expect.stringMatching(/^the 'dac3' box of the written init entry differs/),
      ])
    })

    it('says that an esds differs, and does not throw, where its descriptors can not be read', () => {
      const broken = (byte: number) =>
        entryOf('mp4a', audioEntry('mp4a', {}, box('esds', [0, 0, 0, 0, 0x03, 0xff, byte])))
      expect(configProblems(broken(0x67), broken(0x40), false)).toEqual([
        expect.stringMatching(/^the 'esds' box of the written init entry differs/),
      ])
    })
  })

  it('is the 35 bytes that the module makes for .mp3 (the expectation is written out here, not taken from the module)', () => {
    expect(Array.from(MP3_ESDS)).toEqual([
      ...[0x00, 0x00, 0x00, 0x23, 0x65, 0x73, 0x64, 0x73, 0x00, 0x00, 0x00, 0x00],
      ...[0x03, 0x15, 0x00, 0x00, 0x00, 0x04, 0x0d, 0x6b, 0x15, 0x00, 0x00, 0x00],
      ...[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x02],
    ])
    expect(MP3_ESDS.length).toBe(35)
  })

  it('says so when the source holds no configuration box it knows, and not nothing', () => {
    const source = audioEntry('mp4a', {}, box('btrt', [0, 0, 0, 0]))
    expect(configProblems(entryOf('mp4a', source), entryOf('mp4a', source), false)).toEqual([
      expect.stringMatching(/holds no codec configuration box/),
    ])
  })

  it('says so, and does not throw, when an entry is damaged', () => {
    const source = audioEntry('ac-3', {}, DAC3)
    const cut = source.subarray(0, 40)
    expect(configProblems(entryOf('ac-3', source), entryOf('ac-3', cut), false)).toEqual([
      expect.stringMatching(/^the written init entry can't be read: /),
    ])
    expect(configProblems(entryOf('ac-3', cut), entryOf('ac-3', source), false)).toEqual([
      expect.stringMatching(/^the source entry can't be read: /),
    ])
  })

  it('agrees with what initEntry writes for the entries it rewrites, and for the ones it carries', () => {
    const entries = [
      entryOf('ac-3', audioEntry('ac-3', {}, DAC3)),
      entryOf('ac-3', quickTimeAudioEntry('ac-3', { version: 1 }, wave(frma('ac-3'), DAC3))),
      entryOf('mp4a', quickTimeAudioEntry('mp4a', { version: 2 }, wave(frma('mp4a'), esds()))),
      entryOf('.mp3', quickTimeAudioEntry('.mp3', { version: 1 })),
      entryOf('mp4a', audioEntry('mp4a', {}, esds())),
      // MPEG-2 AAC, which is written with the object type of MPEG-4 audio, whichever way its entry is laid out.
      entryOf('mp4a', audioEntry('mp4a', {}, esds({ objectType: 0x67 }))),
      entryOf(
        'mp4a',
        quickTimeAudioEntry(
          'mp4a',
          { version: 1 },
          wave(frma('mp4a'), esds({ objectType: 0x66, config: audioSpecificConfig(1) })),
        ),
      ),
    ]
    for (const source of entries) {
      const written = initEntry(source)
      const type = source.type === '.mp3' ? 'mp4a' : source.type
      expect(configProblems(source, entryOf(type, written), false)).toEqual([])
    }
  })
})

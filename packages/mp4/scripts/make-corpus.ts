// Makes the synthetic half of the MP4 reader's test corpus with ffmpeg (DESIGN.md
// §10.4, D45): small files from generated pictures and tones, each with one of
// the box structures that real files come in or one of the codecs that a
// browser's Media Source plays (and two that none does), so that the reader and
// the writer can be checked against ffprobe, and the writer's output decoded by
// ffmpeg, on files whose content is not anyone's. It writes them to
// `corpus/synthetic/` and names them in `corpus/manifest.local.json` with what
// the reader must do with each (merged with the entries already there, keyed by
// path). A file that is already made is skipped, unless `--force`.
//
// Run with `pnpm --filter @dfs/mp4 corpus:make [--force]`; it needs `ffmpeg` and
// `ffprobe` on the PATH.

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { child } from '../src/boxes.ts'
import type { Box } from '../src/boxes.ts'
import { frameTable } from '../src/frames.ts'
import { locateMoov, moovIn } from '../src/locate.ts'
import { readMovie } from '../src/movie.ts'
import {
  HEAD_BYTES,
  mergeEntries,
  readIndex,
  readManifest,
  readRange,
  syntheticDir,
  writeManifest,
} from '../src/testing/corpus.ts'
import type { ManifestEntry } from '../src/testing/corpus.ts'

/** Every file is this long, in seconds. */
const SECONDS = 12

/** A generated picture: 30 frames a second of a test pattern with a running clock. */
function picture(size: string): string[] {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${SECONDS}`]
}

/** A generated sound: a sine (mono), at 48 kHz unless it is given another rate. */
function tone(hertz: number, rate = 48000): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${hertz}:sample_rate=${rate}:duration=${SECONDS}`]
}

const H264 = [
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-bf',
  '3',
  '-g',
  '60',
  '-pix_fmt',
  'yuv420p',
]
const AAC = ['-c:a', 'aac', '-b:a', '128k']
/** VP9 as fast as it goes, with a keyframe every 2 s. */
const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-b:v',
  '1M',
  '-g',
  '60',
]
const OPUS = ['-c:a', 'libopus', '-b:a', '96k']

interface Spec {
  name: string
  /** The boxes at the top of the file, in order (what it makes of the box structure, checked after it is made). */
  layout: string
  /** ffprobe's codec name of each stream, in order. */
  streams: string[]
  /** ffmpeg's arguments between the inputs' options and the output file. */
  args: string[]
  expect: ManifestEntry['expect']
  codecs?: ManifestEntry['codecs']
  /** A change to the made file, in place and before it is checked: for what ffmpeg has no option to write. */
  patch?: (path: string) => void
  /** A check of the made file that ffprobe has no word for, throwing what is wrong. */
  verify?: (path: string) => void
}

/** A sound entry as the made file has it: its type and version, its rate field in hertz, and where its boxes begin (after the fields of its version). */
interface SoundEntry {
  type: string
  version: number
  /** The 16.16 field, as hertz. */
  rate: number
  bytes: Uint8Array
  inside: Box
}

/** The first sound's first sample description, as the reader gives it (the made file's own bytes). */
function soundEntryOf(path: string): SoundEntry {
  const size = statSync(path).size
  const entry = readIndex(path, size).tracks.find((track) => track.kind === 'audio')?.entries[0]
  if (!entry) throw new Error('The file has no sound with a sample description.')
  const view = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength)
  // After the 8 bytes of the box, 28 of fields (ISO/IEC 14496-12, and QuickTime's version 0), to which QuickTime's version 1 adds 16 and its version 2 adds 36.
  const version = view.getUint16(16)
  const fields = 36 + (version === 1 ? 16 : version === 2 ? 36 : 0)
  return {
    type: entry.type,
    version,
    rate: view.getUint32(32) / 0x10000,
    bytes: entry.bytes,
    inside: { type: entry.type, start: 0, body: fields, end: entry.bytes.length },
  }
}

/** The tag of a descriptor of an `esds` (ISO/IEC 14496-1), checked, and where its body begins: after a length of one to four bytes, 7 bits each, the top bit saying that another follows. */
function descriptorBody(bytes: Uint8Array, at: number, tag: number): number {
  if (bytes[at] !== tag) {
    throw new Error(`The descriptor at ${at} of the 'esds' has the tag ${bytes[at]}, not ${tag}.`)
  }
  let next = at + 1
  while (((bytes[next] ?? 0) & 0x80) !== 0) next += 1
  return next + 1
}

/**
 * Where the objectTypeIndication byte of the first sound's `esds` is in the
 * file, and what it says. The sound is found by the reader, and its entry's
 * position in the file is the moov's (where `locateMoov` puts it) plus its
 * position in the moov's bytes. The ES_Descriptor holds the stream's ID and its
 * flags (none are set by ffmpeg, so no stream, URL or clock follows), then the
 * DecoderConfigDescriptor, whose first byte this is.
 */
function objectTypeOf(path: string): { at: number; value: number } {
  const size = statSync(path).size
  const found = locateMoov(readRange(path, 0, Math.min(HEAD_BYTES, size)), size)
  if (!found) throw new Error('No moov was found in the file.')
  const range = readRange(path, found.start, found.end - found.start)
  const entry = readMovie(moovIn(range)).tracks.find((track) => track.kind === 'audio')?.entries[0]
  if (!entry) throw new Error('The file has no sound with a sample description.')
  const inside: Box = { type: entry.type, start: 0, body: 36, end: entry.bytes.length }
  const esds = child(entry.bytes, inside, 'esds')
  if (!esds) throw new Error(`The '${entry.type}' sample description has no 'esds' box.`)
  // The box's version and flags (4 bytes), then the ES_Descriptor: its ID (2 bytes) and its flags (1), then the DecoderConfigDescriptor.
  const stream = descriptorBody(entry.bytes, esds.body + 4, 0x03)
  if (entry.bytes[stream + 2] !== 0)
    throw new Error('The ES_Descriptor has flags that are not read.')
  const decoder = descriptorBody(entry.bytes, stream + 3, 0x04)
  const value = entry.bytes[decoder]
  if (value === undefined) throw new Error('The DecoderConfigDescriptor is empty.')
  // `entry.bytes` is a view of the moov, which is a view of the range that was read from `found.start`.
  const at = found.start + (entry.bytes.byteOffset - range.byteOffset) + decoder
  if (readRange(path, at, 1)[0] !== value) {
    throw new Error(`The byte at ${at} of the file is not the one the reader found (${value}).`)
  }
  return { at, value }
}

/** MPEG-4 audio's objectTypeIndication, which ffmpeg writes for AAC, and MPEG-2 AAC's low complexity profile. */
const OTI_MPEG4_AUDIO = 0x40
const OTI_MPEG2_AAC_LC = 0x67

const SPECS: Spec[] = [
  {
    // ftyp, moov, free, mdat: the index in front of the samples, as `-movflags +faststart` (or a phone's editor) leaves it.
    // The picture has 3 B-frames, so its decode times start before its presentation times and its edit list starts
    // in the media; the sound has AAC's priming, so its edit list does too.
    name: 'h264-aac-faststart.mp4',
    layout: 'ftyp moov free mdat',
    streams: ['h264', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // A stream-copy cut, as `ffmpeg -ss <t> -c copy` (and so LosslessCut) leaves it: the file above from 2.3 s, in the middle of
    // a group of pictures (keyframes every 2 s), by input seeking. The frames from the keyframe before the cut are kept,
    // behind a media edit that starts at the cut, so the picture's first frame is shown before its edit starts. Media Source
    // drops every frame shown before 0 and the rest of that group with them, so it would never start: the reader must refuse it.
    name: 'h264-aac-cut.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [
      '-ss',
      '2.3',
      '-i',
      resolve(syntheticDir, 'h264-aac-faststart.mp4'),
      '-c',
      'copy',
      '-f',
      'mp4',
    ],
    expect: { refused: 'edit-list' },
    verify: (path) => {
      const size = statSync(path).size
      const picture = readIndex(path, size).tracks.find((track) => track.kind === 'video')
      if (!picture) throw new Error('The cut has no picture track.')
      const edit = picture.edits?.at(-1)
      if (!edit) throw new Error(`The picture has no edit list: ${JSON.stringify(picture.edits)}`)
      const table = frameTable(picture, size)
      let first = Infinity
      for (let i = 0; i < table.count; i += 1) {
        first = Math.min(first, (table.dts[i] ?? 0) + (table.cts[i] ?? 0))
      }
      if (!(edit.mediaTime > first)) {
        throw new Error(
          `The picture's media edit starts at ${edit.mediaTime}, not after its first frame, shown at ${first} (in ticks of 1/${picture.timescale} s): it is no cut.`,
        )
      }
    },
  },
  {
    // ftyp, free, mdat, moov: the index after the samples, as a phone leaves a recording it has just stopped.
    name: 'h264-aac-end.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // Main 10 HEVC, in the `hvc1` entry that Safari takes and with the HDR (PQ, BT.2020) colour tags; index at the end.
    name: 'hevc10-hvc1-aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['hevc', 'aac'],
    args: [
      ...picture('1920x1080'),
      ...tone(440),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p10le',
      '-tag:v',
      'hvc1',
      '-x265-params',
      'keyint=60:log-level=error',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'hvc1.2.', audio: 'mp4a.40.2' },
  },
  {
    // 8-bit HEVC in the `hev1` entry (parameter sets may be in the samples), index at the end.
    name: 'hevc-hev1-aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['hevc', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hev1',
      '-x265-params',
      'keyint=60:log-level=error',
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'hev1.1.', audio: 'mp4a.40.2' },
  },
  {
    // AV1 (`av01`) and Opus (`Opus` with a `dOps`), index at the end.
    name: 'av1-opus.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['av1', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      '-c:v',
      'libsvtav1',
      '-preset',
      '10',
      '-g',
      '60',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'av01.0.', audio: 'opus' },
  },
  {
    // A picture turned a quarter: the `tkhd` matrix says 90 degrees and the picture is still 1280x720, as a phone held upright
    // records it. `-noautorotate` keeps ffmpeg from turning the pixels itself and dropping the matrix; `-display_rotation`
    // is an input option, so it comes before the picture's `-i`.
    name: 'portrait-h264.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [
      '-noautorotate',
      '-display_rotation',
      '90',
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // The sound starts 0.5 s after the picture (`-itsoffset` before the tone's `-i`): its edit list starts with an empty edit,
    // of 0.4787 s because ffmpeg takes AAC's 1024 priming samples off the pause, and then the media from its start.
    name: 'late-sound.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), '-itsoffset', '0.5', ...tone(440), ...H264, ...AAC, '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
    verify: (path) => {
      const size = statSync(path).size
      const sound = readIndex(path, size).tracks.find((track) => track.kind === 'audio')
      if (sound?.edits?.[0]?.mediaTime !== -1) {
        throw new Error(`The sound has no leading empty edit: ${JSON.stringify(sound?.edits)}`)
      }
    },
  },
  {
    // QuickTime's own flavour: `mov` brand, and AAC in a version 1 `mp4a` that holds its `esds` inside a `wave` box.
    name: 'qt-aac.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'aac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, ...AAC, '-f', 'mov'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // The sound in PCM (`sowt`), which Media Source doesn't take: the reader must refuse it.
    name: 'qt-pcm.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'pcm_s16le'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'pcm_s16le', '-f', 'mov'],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // One picture, two sounds (440 and 880 Hz) and a timecode track (`tmcd`): only the first picture and the first sound are played.
    name: 'extra-tracks.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'aac', 'aac', 'unknown'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...tone(880),
      '-map',
      '0',
      '-map',
      '1',
      '-map',
      '2',
      ...H264,
      ...AAC,
      '-timecode',
      '00:00:00:00',
      '-f',
      'mov',
    ],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.40.2' },
  },
  {
    // Already in fragments: an empty `moov` with an `mvex`, then `moof`/`mdat` pairs. The reader must refuse it.
    name: 'fragmented.mp4',
    layout: 'ftyp moov moof mdat mfra',
    streams: ['h264', 'aac'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      ...AAC,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
    ],
    expect: { refused: 'fragmented' },
  },
  {
    // VP9 (`vp09`, with a `vpcC` of version 1) and Opus, index at the end.
    name: 'vp9-opus.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['vp9', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...VP9,
      '-pix_fmt',
      'yuv420p',
      ...OPUS,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'vp09.00', audio: 'opus' },
  },
  {
    // VP9 profile 2, 10 bits, in HDR's colour (PQ, BT.2020): `vp09.02`.
    name: 'vp9-10bit-pq.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['vp9', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...VP9,
      '-profile:v',
      '2',
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      ...OPUS,
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { video: 'vp09.02' },
  },
  {
    // FLAC in MP4 (`fLaC` with a `dfLa`).
    name: 'h264-flac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'flac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'flac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'flac' },
  },
  {
    // FLAC at 96 kHz: ISO's rate field has 16 bits for the whole part of the rate, so ffmpeg writes half of it in the entry, and the
    // rate itself is in the `dfLa`.
    name: 'h264-flac96k.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'flac'],
    args: [...picture('1280x720'), ...tone(440, 96000), ...H264, '-c:a', 'flac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'flac' },
    verify: (path) => {
      const { rate } = soundEntryOf(path)
      if (rate !== 48000) throw new Error(`The entry's rate field is ${rate} Hz, not 48000.`)
    },
  },
  {
    // AC-3 in MP4 (`ac-3` with a `dac3`).
    name: 'h264-ac3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'ac3', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
  },
  {
    // E-AC-3 in MP4 (`ec-3` with a `dec3`).
    name: 'h264-eac3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'eac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'eac3', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'ec-3' },
  },
  {
    // Apple Lossless in MP4 (`alac`, with its magic cookie in an `alac` box).
    name: 'h264-alac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'alac'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'alac', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'alac' },
  },
  {
    // MP3 in MP4: an `mp4a` whose `esds` says MPEG-1 audio (0x6B), which is `mp4a.6B` and which browsers also know as `mp4a.40.34`.
    name: 'h264-mp3.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'mp3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'libmp3lame', '-f', 'mp4'],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
  },
  {
    // AC-3 in QuickTime's flavour: a version 1 entry with the `dac3` inside a `wave` box, which the init segment has to rewrite.
    name: 'h264-ac3.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'ac3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'ac3', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'ac-3' },
    verify: (path) => {
      const { type, version, bytes, inside } = soundEntryOf(path)
      if (type !== 'ac-3' || version !== 1) {
        throw new Error(`The sound is a '${type}' entry of version ${version}, not 'ac-3' of 1.`)
      }
      const wave = child(bytes, inside, 'wave')
      if (!wave || !child(bytes, wave, 'dac3'))
        throw new Error(`The entry has no 'dac3' in a 'wave'.`)
    },
  },
  {
    // Apple Lossless at 96 kHz in QuickTime's flavour: a version 2 entry, whose rate is a float and whose channels are in the bytes it adds.
    name: 'h264-alac96k.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'alac'],
    args: [...picture('1280x720'), ...tone(440, 96000), ...H264, '-c:a', 'alac', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'alac' },
    verify: (path) => {
      const { version } = soundEntryOf(path)
      if (version !== 2) throw new Error(`The sound entry is version ${version}, not 2.`)
    },
  },
  {
    // MP3 in QuickTime's flavour: the `.mp3` entry, version 1 and with no configuration box, which the init segment gives the type
    // `mp4a` and an `esds`.
    name: 'h264-mp3.mov',
    layout: 'ftyp wide mdat moov',
    streams: ['h264', 'mp3'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'libmp3lame', '-f', 'mov'],
    expect: 'plays',
    codecs: { audio: 'mp4a.6B' },
    verify: (path) => {
      const { type, version } = soundEntryOf(path)
      if (type !== '.mp3' || version !== 1) {
        throw new Error(`The sound is a '${type}' entry of version ${version}, not '.mp3' of 1.`)
      }
    },
  },
  {
    // MPEG-2 AAC (low complexity, `mp4a.67`): the AAC file above, stream-copied, with one byte of its `esds` changed in place, the
    // objectTypeIndication, from MPEG-4 audio's 0x40 to MPEG-2 AAC LC's 0x67, which ffmpeg has no option to write. The size is the same.
    name: 'h264-mpeg2aac.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'aac'],
    args: ['-i', resolve(syntheticDir, 'h264-aac-faststart.mp4'), '-c', 'copy', '-f', 'mp4'],
    expect: 'plays',
    codecs: { video: 'avc1.64', audio: 'mp4a.67' },
    patch: (path) => {
      const { at, value } = objectTypeOf(path)
      if (value !== OTI_MPEG4_AUDIO) {
        throw new Error(
          `The objectTypeIndication is ${value}, and only ${OTI_MPEG4_AUDIO} is changed.`,
        )
      }
      const fd = openSync(path, 'r+')
      try {
        writeSync(fd, Uint8Array.of(OTI_MPEG2_AAC_LC), 0, 1, at)
      } finally {
        closeSync(fd)
      }
    },
    verify: (path) => {
      const { value } = objectTypeOf(path)
      if (value !== OTI_MPEG2_AAC_LC) {
        throw new Error(`The objectTypeIndication is ${value}, not ${OTI_MPEG2_AAC_LC}.`)
      }
    },
  },
  {
    // IAMF in MP4: Opus in an `iamf` entry with an `iacb`, for an audio element made of the output stream 1 (after the picture),
    // and a mix presentation that plays it in stereo.
    name: 'h264-iamf.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'opus'],
    args: [
      ...picture('1280x720'),
      ...tone(440),
      ...H264,
      '-c:a',
      'libopus',
      '-stream_group',
      'type=iamf_audio_element:id=1:st=1:audio_element_type=channel,layer=ch_layout=mono',
      '-stream_group',
      'type=iamf_mix_presentation:id=2:stg=0:annotations=en-us=default,submix=parameter_id=100:parameter_rate=48000|element=stg=0:parameter_id=101:parameter_rate=48000:annotations=en-us=main|layout=sound_system=stereo',
      '-f',
      'mp4',
    ],
    expect: 'plays',
    codecs: { audio: 'iamf.000.000.Opus' },
    verify: (path) => {
      const { type, bytes, inside } = soundEntryOf(path)
      if (type !== 'iamf') throw new Error(`The sound is a '${type}' entry, not 'iamf'.`)
      if (!child(bytes, inside, 'iacb')) throw new Error(`The 'iamf' entry has no 'iacb' box.`)
    },
  },
  {
    // MPEG-4 Visual (`mp4v`), which no browser's Media Source takes: the reader must refuse it.
    name: 'mpeg4-visual.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['mpeg4', 'aac'],
    args: [...picture('1280x720'), ...tone(440), '-c:v', 'mpeg4', ...AAC, '-f', 'mp4'],
    expect: { refused: 'unsupported-codec' },
  },
  {
    // PCM in an ISO MP4 (`ipcm`), which no browser's Media Source takes: the reader must refuse it.
    name: 'h264-pcm.mp4',
    layout: 'ftyp free mdat moov',
    streams: ['h264', 'pcm_s16le'],
    args: [...picture('1280x720'), ...tone(440), ...H264, '-c:a', 'pcm_s16le', '-f', 'mp4'],
    expect: { refused: 'unsupported-codec' },
  },
]

/** The types of the boxes at the top of a file, in order. */
function topLevelTypes(path: string): string {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  const types: string[] = []
  try {
    const header = new Uint8Array(16)
    let at = 0
    while (at + 8 <= size) {
      // What was read is what counts: the bytes of the box before are not this box's.
      header.fill(0)
      const got = readSync(fd, header, 0, 16, at)
      if (got < 8) throw new Error(`A box at ${at} has only ${got} bytes of header.`)
      const view = new DataView(header.buffer)
      let length = view.getUint32(0)
      if (length === 1) {
        if (got < 16)
          throw new Error(`A box at ${at} has a 64-bit size, and only ${got} bytes of header.`)
        length = Number(view.getBigUint64(8))
      }
      if (length === 0) length = size - at
      if (length < 8) throw new Error(`A box at ${at} has a size of ${length}.`)
      const kind = String.fromCharCode(...header.subarray(4, 8))
      if (types.at(-1) !== kind) types.push(kind)
      at += length
    }
  } finally {
    closeSync(fd)
  }
  // A file in fragments has a `moof` and an `mdat` for each: they are said once.
  return types.join(' ').replace(/(moof mdat)( moof mdat)+/, '$1')
}

function run(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${program} failed (${result.status}): ${result.stderr.slice(0, 2000)}`)
  }
  return result.stdout
}

function streamsOf(path: string): string[] {
  const out = run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(out) as { streams: { codec_name?: string }[] }
  return parsed.streams.map((stream) => stream.codec_name ?? 'unknown')
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  mkdirSync(syntheticDir, { recursive: true })
  const entries: ManifestEntry[] = []
  for (const spec of SPECS) {
    const path = resolve(syntheticDir, spec.name)
    if (existsSync(path) && !force) {
      console.log(`${spec.name}: already made`)
    } else {
      const partial = `${path}.partial`
      rmSync(partial, { force: true })
      // `-t` is an output option, and is after the codecs so that it applies to the one output.
      run('ffmpeg', [
        '-y',
        '-hide_banner',
        '-v',
        'error',
        ...spec.args,
        '-t',
        String(SECONDS),
        partial,
      ])
      spec.patch?.(partial)
      // It is checked before it has its name, so that a file with the name is always one that was.
      const started = streamsOf(partial)
      if (started.join(',') !== spec.streams.join(',')) {
        throw new Error(
          `${spec.name} has the streams ${started.join(', ')}, not ${spec.streams.join(', ')}.`,
        )
      }
      const layout = topLevelTypes(partial)
      if (layout !== spec.layout) {
        throw new Error(`${spec.name} has the boxes '${layout}', not '${spec.layout}'.`)
      }
      spec.verify?.(partial)
      renameSync(partial, path)
      console.log(`${spec.name}: made (${layout}; ${started.join(', ')})`)
    }
    entries.push({
      path,
      expect: spec.expect,
      ...(spec.codecs ? { codecs: spec.codecs } : {}),
    })
  }
  await writeManifest(mergeEntries(readManifest(), entries, true))
  console.log(`Manifest names ${entries.length} synthetic files.`)
}

await main()

// Makes the synthetic half of the MP4 reader's test corpus with ffmpeg (DESIGN.md
// §10.4, D45): small files from generated pictures and tones, each with one of
// the box structures that real files come in, so that the reader and the writer
// can be checked against ffprobe on files whose content is not anyone's. It
// writes them to `corpus/synthetic/` and names them in `corpus/manifest.local.json`
// with what the reader must do with each (merged with the entries already
// there, keyed by path). A file that is already made is skipped, unless `--force`.
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
} from 'node:fs'
import { resolve } from 'node:path'
import {
  mergeEntries,
  readIndex,
  readManifest,
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

/** A generated sound: a sine at 48 kHz (mono). */
function tone(hertz: number): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${hertz}:sample_rate=48000:duration=${SECONDS}`]
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
  /** A check of the made file that ffprobe has no word for, throwing what is wrong. */
  verify?: (path: string) => void
}

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
      readSync(fd, header, 0, 16, at)
      const view = new DataView(header.buffer)
      let length = view.getUint32(0)
      if (length === 1) length = Number(view.getBigUint64(8))
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

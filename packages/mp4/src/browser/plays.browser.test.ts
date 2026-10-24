// The proof the repackager is for (DESIGN.md §10.4, D45): Media Source takes what
// `@dfs/mp4` writes, and a real browser plays it, from the start and from a seek,
// picture and sound in step. Each file expected to play is read as the player
// will read it (the head of the file to find the index, then the index, then one
// Range read of the frames wanted of both tracks), and played the way the player
// will play it: a SourceBuffer for each track, its `timestampOffset` and
// `appendWindowEnd` from the track's timing, an init segment, then fragments of
// up to a second. Every failure names the file, the track and the check.

import { afterAll, describe, inject, it } from 'vitest'
import type { TestContext } from 'vitest'
import { server } from 'vitest/browser'
import { Mp4Error } from '../errors.ts'
import {
  byteSpan,
  chooseTracks,
  fragment,
  frameAtOrAfter,
  initSegment,
  keyframeAtOrBefore,
  locateMoov,
  moovIn,
  presentationSeconds,
  readMovie,
} from '../index.ts'
import type { PlayTrack } from '../index.ts'
import type { CorpusFile } from '../testing/provided.ts'
import { filesToPlay, fragmentRuns, pictureEnd } from './choice.ts'
import {
  appendAll,
  fetchRange,
  mediaErrorOf,
  mediaSourceOpened,
  playsUntil,
  waitFor,
  waitUntil,
  watchFrames,
} from './media.ts'

/** How much of a file's start is read to find its index: the same 1 MiB that the player will fetch. */
const HEAD_BYTES = 1024 * 1024
/** How much of each track is appended for a start, and past a seek's target for a seek, in seconds. */
const START_SECONDS = 4
const SEEK_AHEAD_SECONDS = 2
/** Where a start must have got to, how long it has to get there, and how many pictures it must have shown by then. */
const REACH_SECONDS = 1.5
const REACH_WITHIN_MS = 10_000
const MIN_PICTURES = 30
/** The clock must have moved this far for a video to count as having started. */
const STARTED_SECONDS = 0.1
/** How long a paused video is given to answer a new callback with the picture it already shows. */
const SETTLE_MS = 250
/** A test reads, appends and plays some megabytes, and the biggest files tens of them. */
const TEST_TIMEOUT_MS = 90_000

const BROWSER =
  server.browser === 'chromium'
    ? 'Chrome'
    : server.browser === 'firefox'
      ? 'Firefox'
      : server.browser

type Kind = 'picture' | 'sound'
type Part = Kind | 'file'

/** Fails the test with the file, the track and the check, and what was found. */
function fail(file: string, part: Part, check: string, detail: string): never {
  throw new Error(`${file}, ${part}, ${check}: ${detail}`)
}

function sentence(error: unknown): string {
  if (error instanceof Mp4Error) return `${error.message} (refused as '${error.reason}')`
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}

/** Runs the step, and fails with the file, the track and the check if it throws or rejects. */
async function guarded<T>(
  file: string,
  part: Part,
  check: string,
  work: () => Promise<T> | T,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    return fail(file, part, check, sentence(error))
  }
}

interface Tracks {
  video: PlayTrack
  audio: PlayTrack | null
}

/** The picture and the sound of a file, found as the player will: the head, the moov in it or at the end, then the moov alone. */
async function readTracks(file: CorpusFile, url: string): Promise<Tracks> {
  return guarded(file.name, 'file', 'reading the index', async () => {
    const head = await fetchRange(url, 0, Math.min(HEAD_BYTES, file.size) - 1)
    const found = locateMoov(head, file.size)
    if (!found) throw new Error('no moov was found, though the corpus expects the file to play')
    const moov = moovIn(await fetchRange(url, found.start, found.end - 1))
    return chooseTracks(readMovie(moov))
  })
}

function mimeType(kind: 'video' | 'audio', track: PlayTrack): string {
  return `${kind}/mp4; codecs="${track.codec}"`
}

/** Skips the test for a browser that says it can't take one of the file's tracks. */
function skipUnsupported(ctx: TestContext, tracks: Tracks): void {
  if (!MediaSource.isTypeSupported(mimeType('video', tracks.video))) {
    ctx.skip(`${BROWSER} can't play ${tracks.video.codec}`)
  }
  if (tracks.audio && !MediaSource.isTypeSupported(mimeType('audio', tracks.audio))) {
    ctx.skip(`${BROWSER} can't play ${tracks.audio.codec}`)
  }
}

/** A video element on a media source, with a SourceBuffer for each track and its init segment appended, as the player sets one up. */
interface Player {
  video: HTMLVideoElement
  mediaSource: MediaSource
  picture: SourceBuffer
  sound: SourceBuffer | null
  /** The sequence number of the next fragment of each track: they increase from 1. */
  next: { picture: number; sound: number }
  close: () => void
}

async function openPlayer(file: CorpusFile, tracks: Tracks): Promise<Player> {
  const mediaSource = new MediaSource()
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  document.body.append(video)
  const objectUrl = URL.createObjectURL(mediaSource)
  const close = (): void => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(objectUrl)
  }
  try {
    const opened = mediaSourceOpened(video, mediaSource)
    video.src = objectUrl
    await guarded(file.name, 'file', 'opening the media source', () => opened)

    // Both buffers are added before either has its init segment: the video reaches its metadata once every buffer has one.
    const picture = await guarded(file.name, 'picture', 'adding its SourceBuffer', () =>
      mediaSource.addSourceBuffer(mimeType('video', tracks.video)),
    )
    const sound = await guarded(file.name, 'sound', 'adding its SourceBuffer', () =>
      tracks.audio ? mediaSource.addSourceBuffer(mimeType('audio', tracks.audio)) : null,
    )
    const buffers: [SourceBuffer, PlayTrack, Kind][] = [[picture, tracks.video, 'picture']]
    if (sound && tracks.audio) buffers.push([sound, tracks.audio, 'sound'])
    for (const [buffer, track, part] of buffers) {
      await guarded(file.name, part, 'setting its timestampOffset and appendWindowEnd', () => {
        buffer.timestampOffset = track.timing.offsetSeconds
        if (track.timing.endSeconds !== null) buffer.appendWindowEnd = track.timing.endSeconds
      })
    }
    await Promise.all(
      buffers.map(([buffer, track, part]) =>
        guarded(file.name, part, 'appending its init segment', () =>
          appendAll(buffer, [initSegment(track)]),
        ),
      ),
    )
    return { video, mediaSource, picture, sound, next: { picture: 1, sound: 1 }, close }
  } catch (error) {
    close()
    throw error
  }
}

/** The frames to append from each track, [from, to) in decode order: the sound's is null for a file with none, and either may be empty. */
interface Stretch {
  picture: [number, number]
  sound: [number, number] | null
}

/**
 * Reads the bytes of the stretch's frames with one Range request over the least
 * span that holds them, cuts each track's frames into fragments of up to a second,
 * and appends them to its SourceBuffer, in order, the two buffers at once.
 */
async function appendStretch(
  player: Player,
  file: CorpusFile,
  url: string,
  tracks: Tracks,
  stretch: Stretch,
): Promise<void> {
  const parts: { track: PlayTrack; part: Kind; from: number; to: number; buffer: SourceBuffer }[] =
    [
      {
        track: tracks.video,
        part: 'picture',
        from: stretch.picture[0],
        to: stretch.picture[1],
        buffer: player.picture,
      },
    ]
  if (tracks.audio && stretch.sound && player.sound) {
    parts.push({
      track: tracks.audio,
      part: 'sound',
      from: stretch.sound[0],
      to: stretch.sound[1],
      buffer: player.sound,
    })
  }
  const span = byteSpan(parts.map(({ track, from, to }) => ({ table: track.table, from, to })))
  const wanted = span.end - span.start
  if (wanted === 0) return

  const bytes = await guarded(file.name, 'file', `reading bytes ${span.start} to ${span.end}`, () =>
    fetchRange(url, span.start, span.end - 1),
  )
  if (bytes.length !== wanted) {
    fail(file.name, 'file', 'reading the frames', `asked for ${wanted} bytes, got ${bytes.length}`)
  }
  const bytesAt = (offset: number, size: number): Uint8Array =>
    bytes.subarray(offset - span.start, offset - span.start + size)

  await Promise.all(
    parts.map(({ track, part, from, to, buffer }) =>
      guarded(file.name, part, 'appending its fragments', async () => {
        const segments = fragmentRuns(track.table, from, to, part === 'picture').map(
          ([first, end]) => {
            const sequence = player.next[part]
            player.next[part] += 1
            return fragment(track, first, end, sequence, bytesAt)
          },
        )
        try {
          await appendAll(buffer, segments)
        } catch (error) {
          throw new Error(`${sentence(error)} (${standing(player)})`, { cause: error })
        }
      }),
    ),
  )
}

/** The first `START_SECONDS` of each track, as frames: a track shorter than that is all of it. */
function startStretch(tracks: Tracks): Stretch {
  const { video, audio } = tracks
  return {
    picture: [0, Math.max(frameAtOrAfter(video.table, video.timing, START_SECONDS), 1)],
    sound: audio
      ? [0, Math.max(frameAtOrAfter(audio.table, audio.timing, START_SECONDS), 1)]
      : null,
  }
}

/**
 * When the first of frames [from, to) is shown, in seconds with the track's offset
 * applied, and not before 0: a frame that ends before 0 (AAC priming, Opus pre-skip)
 * is cut by the buffer's append window, as ffprobe trims it.
 */
function firstShown(track: PlayTrack, from: number, to: number): number {
  let least = Infinity
  for (let i = from; i < to; i += 1) {
    least = Math.min(least, presentationSeconds(track.table, track.timing, i))
  }
  return Math.max(least, 0)
}

/** How long the track's first frame lasts, in seconds: the tolerance of its start. */
function firstFrameSeconds(track: PlayTrack): number {
  return (track.table.durations[0] ?? 0) / track.table.timescale
}

/** How the player stands, for a failure's sake: the media source's state, the video's error, what is buffered. */
function standing(player: Player): string {
  const sound = player.sound ? ranges(player.sound.buffered) : 'no sound'
  return `page ${document.visibilityState}, media source ${player.mediaSource.readyState}, ${mediaErrorOf(player.video)?.message ?? 'no MediaError'}, readyState ${player.video.readyState}, picture buffered ${ranges(player.picture.buffered)}, sound buffered ${sound}`
}

/** The first buffered second of a SourceBuffer, which must have some. */
function bufferedStart(file: string, part: Part, buffer: SourceBuffer): number {
  if (buffer.buffered.length === 0) {
    fail(
      file,
      part,
      'buffering',
      'its SourceBuffer holds nothing after the fragments were appended',
    )
  }
  return buffer.buffered.start(0)
}

function ranges(buffered: TimeRanges): string {
  const out: string[] = []
  for (let i = 0; i < buffered.length; i += 1) {
    out.push(`${buffered.start(i).toFixed(3)}-${buffered.end(i).toFixed(3)}`)
  }
  return out.length === 0 ? 'none' : out.join(', ')
}

/** How many of the picture's frames are shown at or before the time. */
function picturesBy(track: PlayTrack, seconds: number): number {
  let count = 0
  for (let i = 0; i < track.table.count; i += 1) {
    if (presentationSeconds(track.table, track.timing, i) <= seconds) count += 1
  }
  return count
}

/**
 * The picture a seek to `target` should show, by the table: the one shown at the
 * target (the last shown at or before it) is `covering`; `expected` is the first
 * shown at or after half a frame before the target, as the brief puts it; and
 * `half` is half the covering frame's duration, the tolerance.
 */
function pictureAt(
  track: PlayTrack,
  target: number,
): { covering: number; expected: number; half: number } {
  const { table, timing } = track
  let covering = -Infinity
  let coveringDuration = 0
  for (let i = 0; i < table.count; i += 1) {
    const shown = presentationSeconds(table, timing, i)
    if (shown <= target && shown > covering) {
      covering = shown
      coveringDuration = (table.durations[i] ?? 0) / table.timescale
    }
  }
  const half = coveringDuration / 2
  let expected = Infinity
  for (let i = 0; i < table.count; i += 1) {
    const shown = presentationSeconds(table, timing, i)
    if (shown >= target - half && shown < expected) expected = shown
  }
  return { covering, expected, half }
}

/**
 * The time to seek to: the middle of the picture, moved to a quarter of a frame after the
 * start of the frame that is shown then. A time on the edge between two frames
 * (as a frame's own time is, and the middle of a picture often is) is rounded by the
 * browser to the one frame or the other, and a frame is shown for its whole duration
 * while the table's expected frame (the first shown at or after half a frame before
 * the target) is only the nearest to a time in the second half of its interval:
 * a quarter in is unambiguous both ways, and no more than a frame from the middle.
 */
function seekTarget(track: PlayTrack): number {
  const { covering, half } = pictureAt(track, pictureEnd(track) / 2)
  return covering + half / 2
}

/** What a test ends with besides passing or failing: a reason to skip it, said after the player is closed. */
type Outcome = undefined | { skip: string }

/**
 * Whether the browser is Firefox without a window and the picture is HEVC: Firefox
 * says it can take HEVC, makes no decoder for it in that setting, and gives the
 * video a decode error ("RemoteMediaManager is not available"), after which the
 * source buffers refuse more fragments. It plays once Firefox has a window
 * (`DFS_HEADED=1`): the spike of 2026-10-22. This is the one failure that is
 * the browser's and not the output's, and any other fails the test.
 */
function noDecoderHere(tracks: Tracks): boolean {
  return (
    server.browser === 'firefox' &&
    server.config.browser.headless &&
    /^(hvc1|hev1)\./.test(tracks.video.codec)
  )
}

/** The reason to skip a test for the one browser setting that says it plays HEVC and has no decoder for it (see `noDecoderHere`). */
function neverStarted(tracks: Tracks, player: Player): string {
  return `${BROWSER} claims ${tracks.video.codec} but never started playing here (headless Firefox decodes HEVC only with a window: DFS_HEADED=1) [${standing(player)}]`
}

/**
 * Opens a player for the file's tracks, runs the test's work on it, and closes it
 * (a test left open would keep its decoders from the ones after it). The work
 * may end with a reason to skip; and a failure that leaves the video with a
 * decode error, in the one browser setting that has no decoder for the codec
 * (see `noDecoderHere`), is a skip with that reason too.
 */
async function withPlayer(
  ctx: TestContext,
  file: CorpusFile,
  tracks: Tracks,
  work: (player: Player) => Promise<Outcome>,
): Promise<void> {
  const player = await openPlayer(file, tracks)
  let outcome: Outcome
  try {
    outcome = await work(player)
  } catch (error) {
    // The decode error may come a moment after the append that it makes fail.
    if (noDecoderHere(tracks)) await waitUntil(() => player.video.error !== null, 1000)
    if (noDecoderHere(tracks) && player.video.error?.code === MediaError.MEDIA_ERR_DECODE) {
      outcome = { skip: neverStarted(tracks, player) }
    } else {
      throw error
    }
  } finally {
    // The reason to skip was worked out while the player was open: `standing` is read before this.
    player.close()
  }
  if (outcome) ctx.skip(outcome.skip)
}

const corpus = inject('corpus')
const files = filesToPlay(corpus.files, inject('playAll'))

if (files.length === 0) {
  it('has files to play', (ctx) => {
    ctx.skip('The corpus has no file expected to play (run corpus:make).')
  })
}

describe.each(files)('$name', (file) => {
  const url = `${corpus.url}/file/${file.id}`
  // The index is the same for each of a file's tests, and read once.
  let indexed: Promise<Tracks> | undefined
  const tracksOf = (): Promise<Tracks> => (indexed ??= readTracks(file, url))
  afterAll(() => {
    indexed = undefined
  })

  it(
    'plays from the start, picture and sound in step',
    { timeout: TEST_TIMEOUT_MS },
    async (ctx) => {
      const tracks = await tracksOf()
      skipUnsupported(ctx, tracks)
      const { video: picture, audio: sound } = tracks
      return withPlayer(ctx, file, tracks, async (player) => {
        const stretch = startStretch(tracks)
        await appendStretch(player, file, url, tracks, stretch)

        // Each buffer starts where its track's first frame is shown, to within that frame.
        const pictureStart = bufferedStart(file.name, 'picture', player.picture)
        const pictureWanted = firstShown(picture, stretch.picture[0], stretch.picture[1])
        const pictureFrame = firstFrameSeconds(picture)
        if (Math.abs(pictureStart - pictureWanted) > pictureFrame) {
          fail(
            file.name,
            'picture',
            'its first buffered start',
            `${pictureStart.toFixed(4)} s, but the first frame is shown at ${pictureWanted.toFixed(4)} s (one frame is ${pictureFrame.toFixed(4)} s)`,
          )
        }
        if (sound && player.sound && stretch.sound) {
          const soundStart = bufferedStart(file.name, 'sound', player.sound)
          const soundWanted = firstShown(sound, stretch.sound[0], stretch.sound[1])
          const soundFrame = firstFrameSeconds(sound)
          if (Math.abs(soundStart - soundWanted) > soundFrame) {
            fail(
              file.name,
              'sound',
              'its first buffered start',
              `${soundStart.toFixed(4)} s, but the first frame is shown at ${soundWanted.toFixed(4)} s (one frame is ${soundFrame.toFixed(4)} s)`,
            )
          }
          // In step: the sound starts as far from the picture as the tracks' own first frames are, to within one sound frame.
          // That is a few milliseconds, or the empty edit (late-sound.mp4: about 0.4787 s) where one puts the sound later.
          const apart = soundStart - pictureStart
          const wantedApart = soundWanted - pictureWanted
          if (Math.abs(apart - wantedApart) > soundFrame) {
            fail(
              file.name,
              'picture',
              'picture and sound in step',
              `the sound starts ${apart.toFixed(4)} s after the picture, but the tracks' first frames are ${wantedApart.toFixed(4)} s apart (one sound frame is ${soundFrame.toFixed(4)} s)`,
            )
          }
        }

        // Played, muted, until the clock gets to REACH_SECONDS. The promise `play()` gives is not awaited:
        // it settles only once the video is playing, which a browser with no decoder for it never is.
        let refused: string | undefined
        player.video.play().catch((error: unknown) => {
          refused = sentence(error)
        })
        const played = await guarded(file.name, 'picture', 'playing', () =>
          playsUntil(player.video, REACH_SECONDS, REACH_WITHIN_MS),
        )
        if (refused !== undefined) fail(file.name, 'picture', 'starting to play', refused)
        if (!played.reached) {
          // The one browser that takes the fragments, says it plays this, and has no decoder for it: it is skipped.
          // Anywhere else a start that never comes is the output's failure, and says how the page stands.
          if (played.highest < STARTED_SECONDS && noDecoderHere(tracks)) {
            return { skip: neverStarted(tracks, player) }
          }
          fail(
            file.name,
            'picture',
            'playing',
            `${played.highest < STARTED_SECONDS ? 'it never started: the clock stayed at' : 'the clock stopped at'} ${played.highest.toFixed(3)} s, short of ${REACH_SECONDS} s within ${REACH_WITHIN_MS} ms (${standing(player)})`,
          )
        }
        const shown = player.video.getVideoPlaybackQuality().totalVideoFrames
        // A picture of fewer than 30 frames in the time (a slow one) can't show more than it has.
        const needed = Math.min(MIN_PICTURES, picturesBy(picture, REACH_SECONDS) - 1)
        if (shown < needed) {
          fail(
            file.name,
            'picture',
            'the pictures shown',
            `${shown} frames by ${REACH_SECONDS} s, where at least ${needed} were due`,
          )
        }
      })
    },
  )

  it(
    'a seek to the middle shows the frame at that time',
    { timeout: TEST_TIMEOUT_MS },
    async (ctx) => {
      const tracks = await tracksOf()
      skipUnsupported(ctx, tracks)
      const { video: picture, audio: sound } = tracks
      return withPlayer(ctx, file, tracks, async (player) => {
        // The target is the middle of the picture (see seekTarget); the picture is decoded from the keyframe
        // at or before it, and the sound that goes with it is from the keyframe's time. Both go on until
        // 2 s past the target.
        const target = seekTarget(picture)
        const key = keyframeAtOrBefore(picture.table, picture.timing, picture.keyframes, target)
        const pictureTo = Math.max(
          frameAtOrAfter(picture.table, picture.timing, target + SEEK_AHEAD_SECONDS),
          key + 1,
        )
        let soundRange: [number, number] | null = null
        if (sound) {
          const from = frameAtOrAfter(
            sound.table,
            sound.timing,
            presentationSeconds(picture.table, picture.timing, key),
          )
          const to = frameAtOrAfter(sound.table, sound.timing, target + SEEK_AHEAD_SECONDS)
          soundRange = [from, Math.max(to, from)]
        }

        // The start's buffers are kept, as the player keeps them: what comes before the seek's own frames.
        const start = startStretch(tracks)
        await appendStretch(player, file, url, tracks, {
          picture: [0, Math.min(start.picture[1], key)],
          sound: start.sound && soundRange ? [0, Math.min(start.sound[1], soundRange[0])] : null,
        })
        await appendStretch(player, file, url, tracks, {
          picture: [key, pictureTo],
          sound: soundRange,
        })

        const { video } = player
        const seekable =
          video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0
        if (seekable < target) {
          fail(
            file.name,
            'picture',
            'the seekable range',
            `it ends at ${seekable.toFixed(3)} s, before the target ${target.toFixed(3)} s`,
          )
        }

        // Watching for pictures before the seek, so that the one it shows is not missed on a paused video, and
        // counting them before the time is set: a picture presented with or before `seeked` is the one to take,
        // and not one to wait for again.
        video.pause()
        const watch = watchFrames(video)
        // A browser may answer the first callback of a paused video with the picture it already shows (the
        // first frame, at 0), which it has not told of: that is let come first, to be counted with what
        // came before the seek, and not taken for the picture the seek shows.
        await waitUntil(() => watch.shown.length > 0, SETTLE_MS)
        const before = watch.shown.length
        const seeked = waitFor(video, 'seeked', REACH_WITHIN_MS)
        video.currentTime = target
        await guarded(file.name, 'picture', 'seeking', () => seeked)
        const error = mediaErrorOf(video)
        if (error) fail(file.name, 'picture', 'seeking', error.message)
        await waitUntil(() => watch.shown.length > before, 2000)
        watch.stop()
        // The first picture presented since the seek was asked for.
        const mediaTime = watch.shown[before]
        if (mediaTime === undefined) {
          // A page that is hidden (its window minimized, or covered where the browser tracks that) is shown no pictures.
          if (document.visibilityState === 'hidden') {
            return {
              skip: `${BROWSER} presents no pictures to a hidden page, and its window is hidden (keep it in view)`,
            }
          }
          fail(
            file.name,
            'picture',
            'the frame shown after the seek',
            `no picture was presented (the page is ${document.visibilityState}, focus ${document.hasFocus()}, readyState ${video.readyState}, paused ${video.paused}, seeking ${video.seeking}, currentTime ${video.currentTime.toFixed(3)} s)`,
          )
        }

        const { covering, expected, half } = pictureAt(picture, target)
        if (Math.abs(mediaTime - expected) > half) {
          fail(
            file.name,
            'picture',
            'the frame shown after the seek',
            `mediaTime ${mediaTime.toFixed(4)} s after a seek to ${target.toFixed(4)} s; the table has the frame at that time at ${covering.toFixed(4)} s and the first at or after half a frame before it at ${expected.toFixed(4)} s (half a frame is ${half.toFixed(4)} s); every mediaTime seen: ${watch.shown.map((time) => time.toFixed(4)).join(', ')}`,
          )
        }
      })
    },
  )

  if (file.synthetic && file.name.endsWith('/portrait-h264.mp4')) {
    it('a portrait video plays upright', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
      const tracks = await tracksOf()
      skipUnsupported(ctx, tracks)
      return withPlayer(ctx, file, tracks, async (player) => {
        const { video } = player
        const loaded = await waitUntil(
          () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
          10_000,
        )
        if (!loaded) {
          fail(
            file.name,
            'picture',
            'loadedmetadata',
            `it never came (readyState ${video.readyState})`,
          )
        }
        if (video.videoHeight <= video.videoWidth) {
          fail(
            file.name,
            'picture',
            'upright',
            `the video is ${video.videoWidth} by ${video.videoHeight}, not taller than wide`,
          )
        }
      })
    })
  }
})

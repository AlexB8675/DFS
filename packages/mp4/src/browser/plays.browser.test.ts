// The proof the repackager is for (DESIGN.md §10.4, D45): Media Source takes what
// `@dfs/mp4` writes, and a real browser plays it, from the start and from a seek,
// picture and sound in step. Each file expected to play is read as the player
// will read it (the head of the file to find the index, then the index, then one
// Range read of the frames wanted of both tracks), and played the way the player
// will play it: a SourceBuffer for each track, its `timestampOffset` and
// `appendWindowEnd` from the track's timing, an init segment, then fragments of
// up to a second. Every failure names the file, the track and the check.
//
// A track is first asked of the browser by each name it has (`codecNames`), and the
// browser's answer is held to the table of what each browser plays (support.ts): one
// that disagrees with the table, a codec the table lacks, or a name other than the
// first one taken where the table says it plays, fails the test, and only a codec that
// the browser and the table agree it doesn't take is skipped.

import { afterAll, describe, inject, it } from 'vitest'
import {
  byteSpan,
  chooseTracks,
  fragment,
  frameAtOrAfter,
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
  playsUntil,
  waitFor,
  waitUntil,
  watchFrames,
} from './media.ts'
import {
  bufferedStart,
  BROWSER,
  checkSupport,
  fail,
  firstFrameSeconds,
  firstShown,
  guarded,
  HEAD_BYTES,
  MIN_PICTURES,
  neverStarted,
  noDecoderHere,
  pictureAt,
  picturesBy,
  REACH_SECONDS,
  REACH_WITHIN_MS,
  SEEK_AHEAD_SECONDS,
  sentence,
  SETTLE_MS,
  standing,
  START_SECONDS,
  STARTED_SECONDS,
  TEST_TIMEOUT_MS,
  withPlayer,
} from './player.ts'
import type { Kind, Player } from './player.ts'

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
    return chooseTracks(readMovie(moov), file.size)
  })
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

const corpus = inject('corpus')
// The MP4 files only: a Matroska file is for the Matroska suite.
const files = filesToPlay(
  corpus.files.filter((file) => file.container === 'mp4'),
  inject('playAll'),
)

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
      checkSupport(ctx, file, tracks)
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
      checkSupport(ctx, file, tracks)
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
      checkSupport(ctx, file, tracks)
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

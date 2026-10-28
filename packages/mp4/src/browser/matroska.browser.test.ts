// The proof the Matroska reader is for (DESIGN.md §10.4, D45): Media Source takes
// what `@dfs/mp4` writes from an MKV or a WebM, and a real browser plays it, from
// the start and from a seek, picture and sound in step. Every Matroska file of the
// corpus that is expected to play is played, the synthetic ones and the user's two
// recordings, with no sampling. A file is read as the player will read it: opened
// through `openSource` with a Range read for each range it asks for, then read by
// the cursors (`startCursor` or `seekCursor`, `nextRead`, `framesIn`) a megabyte
// at a time, doubling the read where a frame is longer than it. A Matroska file
// has no table of its frames up front, so the suite gathers the frames that
// `framesIn` gives, each track's continuous runs, and appends their fragments
// (`fragmentRuns`, as the MP4 suite cuts them) the way the player will: a
// SourceBuffer for each track, its `timestampOffset` and `appendWindowEnd` from the
// track's timing, an init segment, then fragments of up to a second. The bytes of a
// frame come from every chunk read so far for the file, for a frame may lie in an
// earlier chunk than the one that completed it. Every failure names the file, the
// track and the check.
//
// What the browser is held to is the MP4 suite's (plays.browser.test.ts, and
// player.ts, which both share): the table of what each browser plays (support.ts)
// is applied to the picture and to the sound that D45 chooses before anything
// plays, and only a codec that the browser and the table agree it doesn't take is
// skipped. A seek is by the file's Cues where it has them and by a search of its
// clusters where it has none (the live-written, unknown-size and derived files),
// and the test says which (an annotation, and the failure text).

import { afterAll, describe, inject, it } from 'vitest'
import {
  fragment,
  frameAtOrAfter,
  framesIn,
  heldBytes,
  nextRead,
  openSource,
  pictureEnd,
  presentationSeconds,
  seekCursor,
  startCursor,
} from '../index.ts'
import type {
  ByteRange,
  Chunk,
  Cursor,
  FragmentTrack,
  FrameTable,
  MatroskaIndex,
} from '../index.ts'
import type { CorpusFile } from '../testing/provided.ts'
import { fragmentRuns } from './choice.ts'
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
import type { Kind, Playable, Player, PlayerTracks, Timed } from './player.ts'

/** The first read of a stretch of frames, as the engine's: 1 MiB, doubled while a frame is longer than the chunk. */
const READ_BYTES = 1024 * 1024

/** The most reads one gathering of frames may take (64 MiB at the first size): a reader that never stops fails the test, and doesn't wait out its timeout. */
const GATHER_READS = 64

/** The most ranges one open or one seek may be asked for, far above the reader's own caps (12 and 48). */
const ASK_GUARD = 100

// ---- Reading a file as the engine would ----

/** What is read of one file so far, by Range: every chunk (they are never dropped, for the bytes of a frame may be in any of them) and how many reads there have been. */
interface Reads {
  url: string
  file: CorpusFile
  chunks: Chunk[]
  count: number
}

/**
 * Reads [start, end) of the file by one Range request and keeps it as a chunk. A
 * range that is no part of the file is the reader's mistake, and an answer of
 * another length the server's: each is thrown, for the caller's `guarded` to say
 * with the file, the track and the check. A range of no bytes (the end of the
 * file) is a chunk of none, and asks the server for nothing.
 */
async function readChunk(reads: Reads, start: number, end: number): Promise<Chunk> {
  const { file } = reads
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > file.size
  ) {
    throw new Error(`${start} to ${end} is no range inside the file of ${file.size} bytes`)
  }
  if (end === start) return { start, bytes: new Uint8Array(0) }
  const bytes = await fetchRange(reads.url, start, end - 1)
  if (bytes.length !== end - start) {
    throw new Error(`asked for ${end - start} bytes at ${start}, got ${bytes.length}`)
  }
  const chunk = { start, bytes }
  reads.chunks.push(chunk)
  reads.count += 1
  return chunk
}

/** Reads the range that a reader needs, which must not be one the file's chunks hold already. */
async function answer(reads: Reads, need: ByteRange): Promise<void> {
  if (heldBytes(reads.chunks, need.start, need.end) !== null) {
    throw new Error(`it asked for ${need.start} to ${need.end}, which is held already`)
  }
  await readChunk(reads, need.start, need.end)
}

/** A file opened: its index, the tracks that play, and the reads. */
interface Opened {
  index: MatroskaIndex
  tracks: PlayerTracks
  reads: Reads
}

/** Opens a file as the player will: the head is the first read, and the reader asks for what else it needs. */
async function openFile(file: CorpusFile, url: string): Promise<Opened> {
  const reads: Reads = { url, file, chunks: [], count: 0 }
  const index = await guarded(file.name, 'file', 'opening it', async () => {
    await readChunk(reads, 0, Math.min(HEAD_BYTES, file.size))
    for (let asks = 0; asks <= ASK_GUARD; asks += 1) {
      const step = openSource(reads.chunks, file.size)
      if ('done' in step) {
        if (step.done.container !== 'matroska') {
          throw new Error(`it was opened as ${step.done.container}, though it starts as Matroska`)
        }
        return step.done
      }
      await answer(reads, step.need)
    }
    throw new Error(`it asked for more than ${ASK_GUARD} reads and is not going to stop`)
  })
  // The corpus expects the file to play, and the sound D45 chooses is the first of its offers.
  const first = index.sounds[0]
  if (index.sound === null && first !== undefined && 'refusal' in first) {
    fail(
      file.name,
      'sound',
      'the sound that plays',
      `${first.refusal.message} (refused as '${first.refusal.reason}')`,
    )
  }
  return { index, tracks: { video: index.video, audio: index.sound }, reads }
}

// ---- The frames of a file ----

/** The frames that `framesIn` gave for each track, its continuous runs in the order they came: each is a table safe for one `fragment` call, and two are never joined. */
interface Frames {
  picture: FragmentTrack[]
  sound: FragmentTrack[]
}

/** Frames gathered from a cursor, and the cursor to go on with. */
interface Gathered extends Frames {
  cursor: Cursor
  /** Whether every frame of the file has been given (`nextRead` says there is no more to read). */
  ended: boolean
}

/** When the last frame of the runs is decoded, in seconds with the track's offset applied: what `frameAtOrAfter` counts by. */
function decodedTo(runs: readonly FragmentTrack[], track: Playable): number {
  const last = runs.at(-1)
  if (last === undefined || last.table.count === 0) return -Infinity
  const { table } = last
  return (table.dts[table.count - 1] ?? 0) / table.timescale + track.timing.offsetSeconds
}

/**
 * Reads the file from the cursor and gathers the frames `framesIn` gives, until
 * `covered` says there are enough or the file ends. A chunk is 1 MiB from where
 * `nextRead` says, twice the size each time the cursor did not move (a frame is
 * longer than the chunk) and 1 MiB again when it does. A file expected to play
 * whole has no damaged stretch: one that is passed over is a failure, and says where.
 */
async function gather(
  opened: Opened,
  from: Cursor,
  covered: (frames: Frames) => boolean,
): Promise<Gathered> {
  const { index, reads } = opened
  const { file } = reads
  const found: Gathered = { picture: [], sound: [], cursor: from, ended: false }
  let length = READ_BYTES
  for (let calls = 0; !covered(found); calls += 1) {
    const at = nextRead(index, found.cursor)
    if (at === null) {
      found.ended = true
      break
    }
    if (calls >= GATHER_READS) {
      fail(
        file.name,
        'file',
        'reading the frames',
        `more than ${GATHER_READS} reads, and still at ${at} of ${file.size}`,
      )
    }
    const { chunk, out } = await guarded(file.name, 'file', 'reading the frames', async () => {
      const read = await readChunk(reads, at, at + Math.min(length, file.size - at))
      return { chunk: read, out: framesIn(index, found.cursor, read) }
    })
    if (out.skipped.length > 0) {
      fail(
        file.name,
        'file',
        'reading the frames',
        `${out.skipped.length} stretches were passed over as damaged, the first at ${out.skipped[0]?.start}, though the corpus expects the file to play whole`,
      )
    }
    for (const run of out.frames) {
      if (run.header.id === index.video.header.id) found.picture.push(run)
      else found.sound.push(run)
    }
    if (nextRead(index, out.cursor) === at) {
      if (at + chunk.bytes.length >= file.size) {
        fail(
          file.name,
          'file',
          'reading the frames',
          `the cursor stays at ${at}, though the chunk reaches the end of the file (${chunk.bytes.length} bytes)`,
        )
      }
      length *= 2
    } else {
      length = READ_BYTES
    }
    found.cursor = out.cursor
  }
  found.ended = nextRead(index, found.cursor) === null
  return found
}

/** Both tracks decoded to the time, the sound only where the file plays one. */
function decodedBy(tracks: PlayerTracks, seconds: number): (frames: Frames) => boolean {
  return (frames) =>
    decodedTo(frames.picture, tracks.video) >= seconds &&
    (tracks.audio === null || decodedTo(frames.sound, tracks.audio) >= seconds)
}

/** The cursor of a seek to the time, by asking for the ranges it needs until it is done. */
async function landAt(opened: Opened, seconds: number): Promise<Cursor> {
  const { index, reads } = opened
  return guarded(reads.file.name, 'file', `seeking to ${seconds.toFixed(3)} s`, async () => {
    for (let asks = 0; asks <= ASK_GUARD; asks += 1) {
      const step = seekCursor(index, seconds, index.sound?.header.id ?? null, reads.chunks)
      if ('done' in step) return step.done
      await answer(reads, step.need)
    }
    throw new Error(`it asked for more than ${ASK_GUARD} reads and is not going to stop`)
  })
}

/** A stretch of a run's frames, [from, to) of its table. */
interface Piece {
  run: FragmentTrack
  from: number
  to: number
}

/** The frames of the runs that are decoded before the time, as pieces, and the first frame at the least: what a track is given of a stretch of `seconds`. */
function decodedBefore(runs: readonly FragmentTrack[], track: Playable, seconds: number): Piece[] {
  const pieces: Piece[] = []
  for (const run of runs) {
    const to = frameAtOrAfter(run.table, track.timing, seconds)
    if (to > 0) pieces.push({ run, from: 0, to })
    if (to < run.table.count) break
  }
  const first = runs[0]
  if (pieces.length === 0 && first !== undefined) pieces.push({ run: first, from: 0, to: 1 })
  return pieces
}

/** Where in the file the first frame of the pieces is. */
function firstOffset(pieces: readonly Piece[]): number {
  const first = pieces[0]
  return first === undefined ? Infinity : (first.run.table.offsets[first.from] ?? Infinity)
}

/** The frames of the pieces that lie in the file before the offset: the frames are in decode order and so in file order. */
function placedBefore(pieces: readonly Piece[], offset: number): Piece[] {
  const out: Piece[] = []
  for (const { run, from, to } of pieces) {
    let end = from
    while (end < to && (run.table.offsets[end] ?? Infinity) < offset) end += 1
    if (end > from) out.push({ run, from, to: end })
    if (end < to) break
  }
  return out
}

/** The runs as one table, in the order they came: for the checks of when a frame is shown, which look at every frame of it. */
function tableOf(file: string, part: Kind, runs: readonly FragmentTrack[]): FrameTable {
  const first = runs[0]
  if (first === undefined) fail(file, part, 'its frames', 'none was given')
  const count = runs.reduce((sum, { table }) => sum + table.count, 0)
  const table: FrameTable = {
    count,
    timescale: first.table.timescale,
    offsets: new Float64Array(count),
    sizes: new Uint32Array(count),
    dts: new Float64Array(count),
    durations: new Uint32Array(count),
    cts: new Int32Array(count),
    sync: new Uint8Array(count),
  }
  let at = 0
  for (const { table: run } of runs) {
    table.offsets.set(run.offsets, at)
    table.sizes.set(run.sizes, at)
    table.dts.set(run.dts, at)
    table.durations.set(run.durations, at)
    table.cts.set(run.cts, at)
    table.sync.set(run.sync, at)
    at += run.count
  }
  return table
}

/** A track's gathered runs as the table and timing that the checks of when a frame is shown take. */
function timedOf(file: string, part: Kind, runs: readonly FragmentTrack[], track: Playable): Timed {
  return { table: tableOf(file, part, runs), timing: track.timing }
}

/**
 * Cuts the pieces into fragments of up to a second (`fragmentRuns`, as the MP4
 * suite cuts a stretch) and appends them to the SourceBuffers, in order, the two
 * buffers at once. The bytes of a frame come from every chunk the file has had
 * read, wherever the frame lies.
 */
async function appendPieces(
  player: Player,
  opened: Opened,
  pieces: { picture: readonly Piece[]; sound: readonly Piece[] },
): Promise<void> {
  const { reads } = opened
  const bytesAt = (offset: number, size: number): Uint8Array => {
    const bytes = heldBytes(reads.chunks, offset, offset + size)
    if (bytes === null) throw new Error(`the ${size} bytes at ${offset} of a frame were never read`)
    return bytes
  }
  const parts: { part: Kind; pieces: readonly Piece[]; buffer: SourceBuffer }[] = [
    { part: 'picture', pieces: pieces.picture, buffer: player.picture },
  ]
  if (opened.tracks.audio && player.sound) {
    parts.push({ part: 'sound', pieces: pieces.sound, buffer: player.sound })
  }
  await Promise.all(
    parts.map(({ part, pieces: stretch, buffer }) =>
      guarded(reads.file.name, part, 'appending its fragments', async () => {
        const segments = stretch.flatMap(({ run, from, to }) =>
          fragmentRuns(run.table, from, to, part === 'picture').map(([first, end]) => {
            const sequence = player.next[part]
            player.next[part] += 1
            return fragment(run, first, end, sequence, bytesAt)
          }),
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

/** The first `START_SECONDS` of each track, as pieces: a track shorter than that is all of it. */
function startPieces(opened: Opened, start: Frames): { picture: Piece[]; sound: Piece[] } {
  const { video, audio } = opened.tracks
  return {
    picture: decodedBefore(start.picture, video, START_SECONDS),
    sound: audio ? decodedBefore(start.sound, audio, START_SECONDS) : [],
  }
}

/**
 * When the first of the pieces' frames is shown, in seconds with the track's offset
 * applied, and not before 0 (as the MP4 suite has it: a frame that ends before 0 is
 * cut by the buffer's append window).
 */
function firstShownIn(pieces: readonly Piece[], track: Playable): number {
  return Math.min(
    ...pieces.map(({ run, from, to }) =>
      firstShown({ table: run.table, timing: track.timing }, from, to),
    ),
  )
}

/** How long the first frame of the pieces lasts, in seconds: the tolerance of its start. */
function firstFrameIn(pieces: readonly Piece[], track: Playable): number {
  const first = pieces[0]
  return first === undefined
    ? 0
    : firstFrameSeconds({ table: first.run.table, timing: track.timing })
}

/** The latest time a frame of the table is shown at, in seconds with the offset applied. */
function lastShown(timed: Timed): number {
  let latest = -Infinity
  for (let i = 0; i < timed.table.count; i += 1) {
    latest = Math.max(latest, presentationSeconds(timed.table, timed.timing, i))
  }
  return latest
}

const corpus = inject('corpus')
// Every Matroska file expected to play, and no sample of the user's: the synthetic ones first, then the user's, each by name.
const files = corpus.files
  .filter((file) => file.container === 'matroska' && file.expect === 'plays')
  .sort(
    (a, b) =>
      (a.synthetic ? 0 : 1) - (b.synthetic ? 0 : 1) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )

if (files.length === 0) {
  it('has files to play', (ctx) => {
    ctx.skip('The corpus has no Matroska file expected to play (run corpus:make).')
  })
}

/** What a seek by Cues or by search is called in a failure's text. */
function howOf(index: MatroskaIndex): string {
  return index.cues !== null ? 'by Cues' : 'by search'
}

/** Runs the work of a seek test and says how the file was sought in the text of what it fails with. */
async function sought<T>(index: MatroskaIndex, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message} [a seek ${howOf(index)}]`
    }
    throw error
  }
}

describe.each(files)('$name', (file) => {
  const url = `${corpus.url}/file/${file.id}`
  // The index and the start are the same for each of a file's tests, and read once.
  let opening: Promise<Opened> | undefined
  const openedOf = (): Promise<Opened> => (opening ??= openFile(file, url))
  let starting: Promise<Gathered> | undefined
  const startOf = (): Promise<Gathered> =>
    (starting ??= openedOf().then((opened) =>
      gather(
        opened,
        startCursor(opened.index, opened.index.sound?.header.id ?? null),
        decodedBy(opened.tracks, START_SECONDS),
      ),
    ))
  afterAll(() => {
    opening = undefined
    starting = undefined
  })

  it(
    'plays from the start, picture and sound in step',
    { timeout: TEST_TIMEOUT_MS },
    async (ctx) => {
      const opened = await openedOf()
      const { tracks } = opened
      checkSupport(ctx, file, tracks)
      const { video: picture, audio: sound } = tracks
      const start = await startOf()
      const stretch = startPieces(opened, start)
      if (stretch.picture.length === 0)
        fail(file.name, 'picture', 'its frames', 'the start gave none')
      if (sound && stretch.sound.length === 0)
        fail(file.name, 'sound', 'its frames', 'the start gave none')

      return withPlayer(ctx, file, tracks, async (player) => {
        await appendPieces(player, opened, stretch)

        // Each buffer starts where its track's first frame is shown, to within that frame.
        const pictureStart = bufferedStart(file.name, 'picture', player.picture)
        const pictureWanted = firstShownIn(stretch.picture, picture)
        const pictureFrame = firstFrameIn(stretch.picture, picture)
        if (Math.abs(pictureStart - pictureWanted) > pictureFrame) {
          fail(
            file.name,
            'picture',
            'its first buffered start',
            `${pictureStart.toFixed(4)} s, but the first frame is shown at ${pictureWanted.toFixed(4)} s (one frame is ${pictureFrame.toFixed(4)} s)`,
          )
        }
        if (sound && player.sound) {
          const soundStart = bufferedStart(file.name, 'sound', player.sound)
          const soundWanted = firstShownIn(stretch.sound, sound)
          const soundFrame = firstFrameIn(stretch.sound, sound)
          if (Math.abs(soundStart - soundWanted) > soundFrame) {
            fail(
              file.name,
              'sound',
              'its first buffered start',
              `${soundStart.toFixed(4)} s, but the first frame is shown at ${soundWanted.toFixed(4)} s (one frame is ${soundFrame.toFixed(4)} s)`,
            )
          }
          // In step: the sound starts as far from the picture as the tracks' own first frames are, to within one sound frame.
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

        // A file that ends before REACH_SECONDS (a recording of a second) can't be played to it: it must reach
        // its end instead. It was appended whole, so the stream is ended, and the clock must come to within
        // one frame of the time its last picture is shown at, or the video must end.
        const timed = timedOf(file.name, 'picture', start.picture, picture)
        const shortOf = start.ended ? lastShown(timed) - pictureFrame : Infinity
        const reach = Math.min(REACH_SECONDS, shortOf)
        if (start.ended) {
          await guarded(file.name, 'file', 'ending the stream', () => {
            player.mediaSource.endOfStream()
          })
        }

        // Played, muted, until the clock gets to the time. The promise `play()` gives is not awaited:
        // it settles only once the video is playing, which a browser with no decoder for it never is.
        let refused: string | undefined
        player.video.play().catch((error: unknown) => {
          refused = sentence(error)
        })
        const played = await guarded(file.name, 'picture', 'playing', () =>
          playsUntil(player.video, reach, REACH_WITHIN_MS),
        )
        if (refused !== undefined) fail(file.name, 'picture', 'starting to play', refused)
        const endedShort = reach < REACH_SECONDS && player.video.ended
        if (!played.reached && !endedShort) {
          // The one browser that takes the fragments, says it plays this, and has no decoder for it: it is skipped.
          // Anywhere else a start that never comes is the output's failure, and says how the page stands.
          if (played.highest < STARTED_SECONDS && noDecoderHere(tracks)) {
            return { skip: neverStarted(tracks, player) }
          }
          fail(
            file.name,
            'picture',
            'playing',
            `${played.highest < STARTED_SECONDS ? 'it never started: the clock stayed at' : 'the clock stopped at'} ${played.highest.toFixed(3)} s, short of ${reach.toFixed(3)} s within ${REACH_WITHIN_MS} ms (${standing(player)})`,
          )
        }
        const shown = player.video.getVideoPlaybackQuality().totalVideoFrames
        // A picture of fewer than 30 frames in the time (a slow one, or a short one) can't show more than it has.
        const needed = Math.min(MIN_PICTURES, picturesBy(timed, reach) - 1)
        if (shown < needed) {
          fail(
            file.name,
            'picture',
            'the pictures shown',
            `${shown} frames by ${reach.toFixed(3)} s, where at least ${needed} were due`,
          )
        }
      })
    },
  )

  it(
    'a seek to the middle shows the frame at that time (by Cues, or by search where the file has no Cues)',
    { timeout: TEST_TIMEOUT_MS },
    async (ctx) => {
      const opened = await openedOf()
      const { index, tracks } = opened
      checkSupport(ctx, file, tracks)
      await ctx.annotate(`a seek ${howOf(index)}`)
      const { video: picture, audio: sound } = tracks
      const start = await startOf()

      return withPlayer(ctx, file, tracks, (player) =>
        sought(index, async () => {
          // The middle of the picture: the file's duration, or the picture's end where the file has none (the whole file is then read for it).
          const duration =
            index.durationSeconds ??
            pictureEnd(
              timedOf(
                file.name,
                'picture',
                (
                  await gather(
                    opened,
                    startCursor(index, index.sound?.header.id ?? null),
                    () => false,
                  )
                ).picture,
                picture,
              ),
            )
          const middle = duration / 2

          // The target is a quarter of a frame into the frame that is shown at the middle, as the MP4 suite has it
          // (seekTarget): that frame is found from frames read around the middle, from a first seek to it.
          const around = await gather(
            opened,
            await landAt(opened, middle),
            decodedBy(tracks, middle + SEEK_AHEAD_SECONDS),
          )
          const { covering, half } = pictureAt(
            timedOf(file.name, 'picture', around.picture, picture),
            middle,
          )
          if (!Number.isFinite(covering)) {
            fail(
              file.name,
              'picture',
              'the frame at the middle',
              `no frame is shown at or before ${middle.toFixed(3)} s in the frames read from where the seek landed`,
            )
          }
          const target = covering + half / 2

          // The seek to the target, and the frames from where it lands to 2 s past it, for both tracks.
          const landed = await landAt(opened, target)
          const seeked = await gather(
            opened,
            landed,
            decodedBy(tracks, target + SEEK_AHEAD_SECONDS),
          )
          const table = tableOf(file.name, 'picture', seeked.picture)
          if (table.sync[0] !== 1) {
            fail(
              file.name,
              'picture',
              'the seek',
              `it lands at a frame that is not a keyframe (the first frame given is at offset ${table.offsets[0]})`,
            )
          }
          const firstAt = presentationSeconds(table, picture.timing, 0)
          if (firstAt > target + 1e-6) {
            fail(
              file.name,
              'picture',
              'the seek',
              `it lands at a keyframe shown at ${firstAt.toFixed(4)} s, after the target ${target.toFixed(4)} s`,
            )
          }
          const seek = {
            picture: decodedBefore(seeked.picture, picture, target + SEEK_AHEAD_SECONDS),
            sound: sound ? decodedBefore(seeked.sound, sound, target + SEEK_AHEAD_SECONDS) : [],
          }
          if (sound && seek.sound.length === 0)
            fail(file.name, 'sound', 'its frames', 'the seek gave none')

          // The start's buffers are kept, as the player keeps them: what lies in the file before the seek's own frames.
          const before = startPieces(opened, start)
          await appendPieces(player, opened, {
            picture: placedBefore(before.picture, firstOffset(seek.picture)),
            sound: placedBefore(before.sound, firstOffset(seek.sound)),
          })
          await appendPieces(player, opened, seek)

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
          const counted = watch.shown.length
          const done = waitFor(video, 'seeked', REACH_WITHIN_MS)
          video.currentTime = target
          await guarded(file.name, 'picture', 'seeking', () => done)
          const error = mediaErrorOf(video)
          if (error) fail(file.name, 'picture', 'seeking', error.message)
          await waitUntil(() => watch.shown.length > counted, 2000)
          watch.stop()
          // The first picture presented since the seek was asked for.
          const mediaTime = watch.shown[counted]
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

          const found = pictureAt({ table, timing: picture.timing }, target)
          if (Math.abs(mediaTime - found.expected) > found.half) {
            fail(
              file.name,
              'picture',
              'the frame shown after the seek',
              `mediaTime ${mediaTime.toFixed(4)} s after a seek to ${target.toFixed(4)} s; the frames read have the frame at that time at ${found.covering.toFixed(4)} s and the first at or after half a frame before it at ${found.expected.toFixed(4)} s (half a frame is ${found.half.toFixed(4)} s); every mediaTime seen: ${watch.shown.map((time) => time.toFixed(4)).join(', ')}`,
            )
          }
          return undefined
        }),
      )
    },
  )

  if (file.synthetic && file.name.endsWith('/portrait-h264.mkv')) {
    it('a portrait video plays upright', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
      const opened = await openedOf()
      checkSupport(ctx, file, opened.tracks)
      return withPlayer(ctx, file, opened.tracks, async (player) => {
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

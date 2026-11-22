// The engine proved on the corpus (DESIGN.md §10.4; the iron-clad spec §4.9), the suite's frame: a fast start and
// a fast seek on every file the choice names, the engine's silence about a stalled picture, what a close leaves
// behind, and what the browser keeps at rest and in its HTTP cache. The links (above and below the bit rate,
// drops and a switch) and the limits (Firefox's quota, a seek storm, the memory store) are in other files.
//
// The files are `@dfs/mp4`'s choice: every synthetic file expected to play, and a sample of the user's, or all of
// them with `DFS_CORPUS_ALL=1`. The user's files are read in place through the play server; their bytes go
// nowhere but the engine's own store (encrypted, in the page's private file system, deleted at close), and a
// failure leaves no screenshot (vitest.browser.config.ts). Every play of this file is checked, when its test is
// over, for a wait that the engine left in silence.

import { frameAtOrAfter, mp4Seek, presentationSeconds } from '@dfs/mp4'
import { filesToPlay } from '@dfs/mp4/testing'
import { commands } from 'vitest/browser'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Downloader } from '../downloader.ts'
import type { ByteRange } from '@dfs/mp4'
import { indexOfRun } from '../testing/contains.ts'
import { heldAt } from '../testing/held-at.ts'
import type { ReadStamp } from '../testing/held-at.ts'
import { PLAYS_DIRECTORY } from '../opfs.ts'
import {
  activePlays,
  begin,
  directoryExists,
  endPlays,
  frames,
  ofType,
  served,
  silentWaits,
  suite,
  synthetic,
  until,
} from './play-harness.ts'
import type { Play } from './play-harness.ts'
import {
  factsOf,
  fastLink,
  fetchRange,
  hexOf,
  isDense,
  pause,
  probeOf,
  report,
  startPicture,
  timelineOf,
} from './plays-support.ts'
import type { Facts } from './plays-support.ts'
import { control, fileUrl, files, playAll } from './server.ts'
import type { PlayFile } from './server.ts'

// A play of a user's file may read a long index, and the cache test waits for the disk.
vi.setConfig({ testTimeout: 120_000 })

/** The marks of the fast link: a picture in under a second from the start and from a seek (spec goal 2). */
const PICTURE_MS = 1_000

/** Media after the seek's picture that the test plays, in seconds: little, so that a corpus of files is quick. */
const PLAY_AFTER_SEEK_SECONDS = 2

afterEach(async () => {
  vi.restoreAllMocks()
  // The no-silent-freeze check: every wait longer than STUCK_MS has a watchdog event of the engine's, or a hold
  // explains it. It runs on every play of the file before the plays are ended, and fails the test that began it.
  const silent = activePlays().flatMap((play) => silentWaits(play))
  if (silent.length > 0) {
    for (const play of activePlays())
      report({ test: 'silent-wait-timeline', lines: timelineOf(play) })
  }
  await endPlays()
  expect(silent, 'waits longer than STUCK_MS with no watchdog event and no hold').toEqual([])
})

/** Records when each read of the downloader resolves, for the time from the store's holding the keyframe's bytes to the picture. */
function recordReads(): ReadStamp[] {
  const reads: ReadStamp[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is called on the downloader it was taken from, below.
  const real = Downloader.prototype.read
  vi.spyOn(Downloader.prototype, 'read').mockImplementation(async function (
    this: Downloader,
    range: ByteRange,
    signal?: AbortSignal,
  ) {
    const bytes = await real.call(this, range, signal)
    reads.push({ start: range.start, end: range.end, at: performance.now() })
    return bytes
  })
  return reads
}

/** Resolves with the time, in ms, from `from` until the element shows a picture past `frameCount` and has stopped seeking at the target. */
async function pictureAfter(
  play: Play,
  from: number,
  frameCount: number,
  target: number,
  what: string,
): Promise<number> {
  const { video } = play
  const ready = (): boolean =>
    !video.seeking &&
    video.readyState >= 2 &&
    video.currentTime >= target - 0.05 &&
    frames(video) > frameCount
  while (!ready()) {
    if (play.resolved || play.rejection !== null) {
      throw new Error(`The play ended while waiting for ${what}.`, {
        cause: play.rejection?.reason,
      })
    }
    if (performance.now() - from > 40_000) throw new Error(`Gave up waiting for ${what}.`)
    await pause(5)
  }
  return performance.now() - from
}

/** How many frames after the first one shown that the picture's frames may reach, for the frames that are decoded before it and shown after: a B-frame pyramid is never deeper. */
const REORDER_FRAMES = 8

/**
 * The offsets (each the end of a frame, exclusive) that the store must hold for the picture of a start (`seconds`
 * null) or of a seek to `seconds`: the frames from the keyframe to the first one shown at the target, and the
 * index (the moov) for a start, which the engine needs before it can feed a frame. None for Matroska, whose index
 * keeps no frame table.
 */
function neededEnds(facts: Facts, seconds: number | null): number[] {
  const { index } = facts
  if (index.container !== 'mp4') return []
  const { table, timing } = index.video
  const first =
    seconds === null ? 0 : mp4Seek(index, seconds, index.sound?.header.id ?? null).videoFrame
  const target = seconds ?? presentationSeconds(table, timing, 0)
  let shown = first
  while (shown < table.count - 1 && presentationSeconds(table, timing, shown) < target) shown += 1
  let end = 0
  for (let i = first; i <= Math.min(table.count - 1, shown + REORDER_FRAMES); i += 1) {
    end = Math.max(end, (table.offsets[i] ?? 0) + (table.sizes[i] ?? 0))
  }
  const needed = [end]
  // The sound's frames from the cursor to the one that covers the target, which the feed waits for too.
  const soundTrack = index.sound
  if (soundTrack !== null) {
    const firstSound =
      seconds === null ? 0 : mp4Seek(index, seconds, index.sound?.header.id ?? null).soundFrame
    const covering = Math.min(
      soundTrack.table.count - 1,
      frameAtOrAfter(soundTrack.table, soundTrack.timing, target),
    )
    let soundEnd = 0
    for (let i = firstSound; i <= covering; i += 1) {
      soundEnd = Math.max(
        soundEnd,
        (soundTrack.table.offsets[i] ?? 0) + (soundTrack.table.sizes[i] ?? 0),
      )
    }
    if (soundEnd > 0) needed.push(soundEnd)
  }
  if (seconds === null && facts.moovEnd !== null) needed.push(facts.moovEnd)
  return needed
}

/** The target of the seek: past the middle of the file, and with room after it for the little that is played. */
function seekTarget(duration: number): number {
  const target = Math.min(duration * 0.55, duration - PLAY_AFTER_SEEK_SECONDS - 1)
  // A clip shorter than that room is seeked to its middle.
  return Math.round(Math.max(target, duration / 2) * 1000) / 1000
}

const choice: PlayFile[] = filesToPlay(files(), playAll())

describe.skipIf(choice.length === 0)('the fast link: a start and a seek to a picture', () => {
  for (const file of choice) {
    test(file.name, async ({ skip }) => {
      const facts = await factsOf(file)
      if (facts.unplayable !== null)
        skip(`this browser's Media Source takes none of its codecs: ${facts.unplayable}`)
      const duration = facts.durationSeconds
      if (duration === null) skip('the file has no duration to seek by')
      if (duration === null) return
      // The synthetic files are small and made for this suite: their start and seek are held to a second whatever
      // their keyframe gap. The user's files are held to it when their keyframes are at most 1.05 s apart.
      const dense = file.synthetic || isDense(facts)

      const link = fastLink(file, duration)
      await control(link)
      const reads = recordReads()
      const startedAt = performance.now()
      const play = begin(file.name, { autoplay: () => true })
      try {
        const { firstFrameMs, movingMs: startMs } = await startPicture(play, startedAt)
        const startHeld = heldAt(reads, startedAt, neededEnds(facts, null), 'the start')
        const startDecoderMs = startHeld === null ? null : startedAt + startMs - startHeld

        // Let it play a moment so that the seek is a seek of a play, then jump past the middle.
        await until(play, 'the clock to move', 20_000, () => play.video.currentTime > 0.3)
        const target = seekTarget(duration)
        const seekMark = performance.now()
        const framesBefore = frames(play.video)
        play.video.currentTime = target
        const seekMs = await pictureAfter(
          play,
          seekMark,
          framesBefore,
          target,
          "the seek's picture",
        )
        // A seek the window holds makes no read: the data was at the decoder already, and the whole seek is the measure.
        const windowSeek = ofType(play.events, 'seek').findLast((event) => event.ms === null)
        const seekHeld =
          windowSeek?.inWindow === true
            ? seekMark
            : heldAt(reads, seekMark, neededEnds(facts, target), 'the seek')
        const seekDecoderMs = seekHeld === null ? null : seekMark + seekMs - seekHeld

        // A little of what follows the seek, as a play: the clock goes on.
        await until(play, 'the clock to go on after the seek', 20_000, () => {
          return (
            play.video.ended ||
            play.video.currentTime >=
              Math.min(target + PLAY_AFTER_SEEK_SECONDS - 0.5, duration - 0.15)
          )
        })

        const seekEvents = ofType(play.events, 'seek')
        const seekDone = seekEvents.find((event) => event.ms !== null)
        report({
          test: 'fast-link',
          file: file.name,
          synthetic: file.synthetic,
          bytes: file.size,
          container: facts.index.container,
          keyframeGapSeconds: facts.keyframeGap,
          dense,
          linkBytesPerSecond: link.bandwidthBytesPerSecond,
          bitrateBytesPerSecond: Math.round(file.size / duration),
          maxWindowBytes: Math.round(
            Math.max(
              0,
              ...play.stats.map((numbers) => numbers.windowBytes).filter(Number.isFinite),
            ),
          ),
          firstFrameMs: Math.round(firstFrameMs),
          startMs: Math.round(startMs),
          startToDecoderMs: startDecoderMs === null ? null : Math.round(startDecoderMs),
          seekMs: Math.round(seekMs),
          seekToDecoderMs: seekDecoderMs === null ? null : Math.round(seekDecoderMs),
          seekEngineMs: seekDone?.ms ?? null,
          seekInWindow: seekDone?.inWindow ?? null,
          seekTo: target,
        })
        expect(ofType(play.events, 'error')).toEqual([])
        expect(play.video.error).toBeNull()

        if (dense) {
          expect(startMs, `the start of ${file.name}`).toBeLessThan(PICTURE_MS)
          expect(seekMs, `the seek of ${file.name}`).toBeLessThan(PICTURE_MS)
        } else {
          // Sparser than DENSE_KEYFRAME_SECONDS (or no table to tell): the times are logged above, and what is held
          // to a second is the time from the store's holding the keyframe's bytes to the picture.
          if (startDecoderMs !== null)
            expect(startDecoderMs, `the start of ${file.name}, data to decoder`).toBeLessThan(
              PICTURE_MS,
            )
          if (seekDecoderMs !== null)
            expect(seekDecoderMs, `the seek of ${file.name}, data to decoder`).toBeLessThan(
              PICTURE_MS,
            )
        }
      } catch (error) {
        report({
          test: 'timeline',
          file: file.name,
          lines: timelineOf(play),
          reads: reads.map((read) => [read.start, read.end, Math.round(read.at - startedAt)]),
        })
        throw error
      }
    })
  }
})

const CLEAN = 'h264-aac-faststart.mp4'

suite(CLEAN)('the clean-up after a close', () => {
  test('no directory of the play is left in the private file system, and one was there while it played', async () => {
    const play = begin(CLEAN, { autoplay: () => true })
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    await until(play, 'the disk store', 10_000, () => play.stats.at(-1)?.backend === 'disk')
    // The guard against a vacuous pass: the directory is there while the play plays.
    expect(await directoryExists(play.playId)).toBe(true)

    play.controller.abort(new Error('the test closes the play'))
    await play.done.catch(() => undefined)
    expect(await directoryExists(play.playId)).toBe(false)
    // Nothing else of this play is left under the plays' directory either.
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(PLAYS_DIRECTORY)
    const names: string[] = []
    for await (const name of directory.keys()) names.push(name)
    expect(names).not.toContain(play.playId)
  })
})

/** Every file under a play's directory in the private file system, as bytes, at the moment of the call. */
async function slotFilesOf(playId: string): Promise<Uint8Array[]> {
  const root = await navigator.storage.getDirectory()
  const plays = await root.getDirectoryHandle(PLAYS_DIRECTORY)
  const directory = await plays.getDirectoryHandle(playId)
  const out: Uint8Array[] = []
  for await (const name of directory.keys()) {
    const handle = await directory.getFileHandle(name)
    out.push(new Uint8Array(await (await handle.getFile()).arrayBuffer()))
  }
  return out
}

const AT_REST = 'h264-aac-faststart.mp4'

suite(AT_REST)('encryption at rest', () => {
  test("the slot file holds no run of 64 of the file's bytes, while a disk store plays", async () => {
    const file = served(AT_REST)
    if (file === undefined) return
    const probe = await probeOf(file)
    // The probe is the file's own bytes: the test's own control that the scan below could find them if they were there.
    expect(indexOfRun(probe.bytes, probe.bytes)).toBe(0)

    const play = begin(AT_REST, { autoplay: () => true })
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    // The whole of the file is stored (it is small), so the block that holds the probe has been read and written: `storedBytes` counts the head and the tail first, which would pass the probe's offset too early.
    await until(play, 'the store to hold the probe', 20_000, () => {
      return (play.stats.at(-1)?.storedBytes ?? 0) >= file.size
    })
    expect(play.stats.at(-1)?.backend).toBe('disk')

    // The play goes on while the file is read: the engine still holds the slots open.
    const slots = await slotFilesOf(play.playId)
    const total = slots.reduce((sum, bytes) => sum + bytes.length, 0)
    expect(total, 'bytes at rest in the slot file').toBeGreaterThanOrEqual(file.size)
    for (const bytes of slots) expect(indexOfRun(bytes, probe.bytes)).toBe(-1)
    expect(play.resolved).toBe(false)
  })
})

const CACHED = 'portrait-h264.mp4'

/** A whole synthetic file's bytes, read with no-store: the cache test's own reads leave nothing in the cache. */
async function wholeFile(file: PlayFile): Promise<Uint8Array> {
  return fetchRange(fileUrl(file.id), 0, file.size - 1)
}

/**
 * The file for the cache test's control: another synthetic file, small, that shares no run of 64 bytes with the
 * played file's probe, and whose own 64-byte run (the witness) is not in the played file: so a cache file that
 * holds the witness is the control's, and one that holds the probe is the play's.
 */
async function controlFor(
  played: PlayFile,
  probe: Uint8Array,
): Promise<{ file: PlayFile; witness: Uint8Array } | null> {
  const playedBytes = await wholeFile(played)
  const candidates = synthetic
    .filter((file) => file.name !== played.name && file.size <= 16 * 1024 * 1024)
    .sort((x, y) => x.size - y.size)
  for (const file of candidates) {
    const bytes = await wholeFile(file)
    if (indexOfRun(bytes, probe) !== -1) continue
    const witness = (await probeOf(file)).bytes
    if (indexOfRun(playedBytes, witness) === -1) return { file, witness }
  }
  return null
}

suite(CACHED)('the HTTP cache stays clean', () => {
  test("after a play, no file of the browser's profile holds a run of the file's bytes", async ({
    skip,
  }) => {
    const played = served(CACHED)
    if (played === undefined) {
      skip(`${CACHED} is not served`)
      return
    }
    const probe = await probeOf(played)
    if ((await commands.scanProfile(hexOf(probe.bytes))) === null) {
      skip(
        "this browser has no profile folder of its own that the suite can look into (only Chrome's persistent context has)",
      )
      return
    }
    const control = await controlFor(played, probe.bytes)
    expect(control, 'a synthetic file to use as the control').not.toBeNull()
    if (control === null) return

    // A play, run to the place of the probe and closed.
    const play = begin(CACHED, { autoplay: () => true })
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    await until(play, 'the store to hold the probe', 20_000, () => {
      return (play.stats.at(-1)?.storedBytes ?? 0) >= played.size
    })
    play.controller.abort(new Error('the test closes the play'))
    await play.done.catch(() => undefined)

    // The control: an ordinary fetch of another file is kept by the HTTP cache, and the scan finds it. Without it,
    // a scan that finds nothing would say nothing.
    const response = await fetch(fileUrl(control.file.id))
    await response.arrayBuffer()
    const from = performance.now()
    let found = 0
    while (found === 0 && performance.now() - from < 20_000) {
      found = (await commands.scanProfile(hexOf(control.witness)))?.holding ?? 0
      if (found === 0) await pause(250)
    }
    expect(found, 'the control: the cache holds what an ordinary fetch took').toBeGreaterThan(0)

    const scan = await commands.scanProfile(hexOf(probe.bytes))
    report({ test: 'http-cache', holdingFiles: scan?.where })
    expect(scan?.holding, "files of the profile that hold the played file's bytes").toBe(0)
    report({
      test: 'http-cache',
      scanned: scan?.scanned,
      unreadable: scan?.unreadable,
      controlFile: control.file.name,
      controlFound: found,
    })
  })
})

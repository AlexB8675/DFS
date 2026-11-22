// The engine's play in a real browser (DESIGN.md §10.4): the synthetic corpus, served by the play server,
// goes through `playStreamed` (the downloader and its store in a real worker, the feeder, the decoder window
// and the Media Source sink) into a `video` element, and the browser is asked what it shows. This is the play
// from its start, or from a given time, to its end; the controls (seeks, holding, the watchdog) are in
// controls.browser.test.ts. Here the engine is given no `autoplay`, so it never calls `play()`: the tests do.
// A file that is not served (no `corpus:make`) skips its tests, with the reason.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { Downloader } from '../downloader.ts'
import { CHUNK_BYTES, WINDOW_BYTES, WINDOW_FLOOR_BYTES } from '../limits.ts'
import { MediaSourceSink } from '../page/index.ts'
import {
  begin,
  directoryExists,
  endPlays,
  frames,
  ofType,
  served,
  suite,
  synthetic,
  until,
} from './play-harness.ts'
import { clearLog, control, log, switchNetwork } from './server.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await endPlays()
})

suite('h264-aac-faststart.mp4')('playStreamed: a play from its start', () => {
  test('shows a picture once the test plays it, and says how it went', async () => {
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    // The engine does not play: the test does.
    expect(play.video.paused).toBe(true)
    // A track's first frame may be shown a little after 0: the common start moves the clock to it, by under a frame.
    expect(play.video.currentTime).toBeLessThan(0.1)
    await play.video.play()
    await until(play, 'the clock to move', 15_000, () => play.video.currentTime > 1)
    expect(frames(play.video)).toBeGreaterThan(0)
    expect(play.video.error).toBeNull()

    expect(ofType(play.events, 'phase').map((event) => event.phase)).toContain('buffering')
    expect(ofType(play.events, 'phase')[0]?.phase).toBe('opening')
    expect(ofType(play.events, 'error')).toEqual([])
    const appended = ofType(play.events, 'append')
    expect(appended.some((event) => event.track === 'video')).toBe(true)
    expect(appended.some((event) => event.track === 'audio')).toBe(true)
    await until(
      play,
      'the numbers to catch up',
      5_000,
      () => play.stats.at(-1)?.segments === ofType(play.events, 'append').length,
    )
    const last = play.stats.at(-1)
    expect(last?.backend).toBe('disk')
    expect(last?.storedBytes).toBeGreaterThan(0)
    expect(last?.windowBytes).toBeGreaterThan(0)
    expect(last?.segments).toBe(appended.length)
    expect(last?.codecs.length).toBe(2)
    expect(last?.targetAheadSeconds).toBeGreaterThan(0)
    expect(play.stats.every((numbers) => numbers.windowBytes <= WINDOW_BYTES + CHUNK_BYTES)).toBe(
      true,
    )
  })

  test('gives the downloader the playhead while it plays', async () => {
    // A slow link keeps the download reading: the position is not given once the download is done (the file is held whole).
    await control({ bandwidthBytesPerSecond: 250_000 })
    const position = vi.spyOn(Downloader.prototype, 'setPosition')
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    await play.video.play()
    await until(play, 'the clock to move', 15_000, () => play.video.currentTime > 0.5)
    const before = position.mock.calls.length
    await until(play, 'two more positions', 15_000, () => position.mock.calls.length >= before + 2)
    const sizes = position.mock.calls.map(([offset]) => offset)
    expect(sizes.every((offset) => Number.isInteger(offset) && offset >= 0)).toBe(true)
  })

  test('says slow once the measured rate is under the bit rate, never before a rate is known', async () => {
    // 150 KB/s is far under this file's bit rate (about 5 MB over its length).
    await control({ bandwidthBytesPerSecond: 150_000 })
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    await until(play, 'a slow rate', 15_000, () => play.stats.at(-1)?.slow === true)
    expect(play.stats.every((numbers) => !numbers.slow || numbers.rate !== null)).toBe(true)
    expect(play.stats.at(-1)?.rate).toBeLessThan(500_000)
  })

  test('does not say slow on a link that is faster than the bit rate', async () => {
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    await until(play, 'a rate', 15_000, () => play.stats.at(-1)?.rate !== null)
    expect(play.stats.some((numbers) => numbers.slow)).toBe(false)
  })

  test('removes what is played past the window behind, and keeps its bytes bounded', async () => {
    // A link slower than the file's pace keeps the feed behind the end while the playhead goes by the bound.
    await control({ bandwidthBytesPerSecond: 250_000 })
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    await play.video.play()
    await until(play, 'a removal of the picture', 25_000, () =>
      ofType(play.events, 'remove').some((event) => event.track === 'video'),
    )
    const removed = ofType(play.events, 'remove')
    expect(removed.every((event) => event.before > 0)).toBe(true)
    expect(play.video.buffered.start(0)).toBeGreaterThan(1)
    expect(play.stats.every((numbers) => numbers.windowBytes <= WINDOW_BYTES + CHUNK_BYTES)).toBe(
      true,
    )
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('logs a quota error, shrinks the window, and plays on', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is called on the buffer it was taken from, below.
    const real = SourceBuffer.prototype.appendBuffer
    let refused = 0
    SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, source: BufferSource) {
      // The first fragment (an init segment starts with `ftyp`) meets a full buffer, once.
      const head = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source)
      const box = String.fromCharCode(...head.subarray(4, 8))
      if (refused === 0 && box !== 'ftyp') {
        refused += 1
        throw new DOMException('The buffer is full.', 'QuotaExceededError')
      }
      real.call(this, source)
    }
    try {
      const play = begin('h264-aac-faststart.mp4')
      await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
      expect(refused).toBe(1)
      await play.video.play()
      await until(play, 'the clock to move', 15_000, () => play.video.currentTime > 1)
      const quota = ofType(play.events, 'quota')
      expect(quota).toHaveLength(1)
      expect(quota[0]?.pendingBytes).toBeGreaterThan(0)
      const shrunk = ofType(play.events, 'watchdog').filter((event) => event.action === 'quota')
      expect(shrunk).toHaveLength(1)
      expect(shrunk[0]?.detail).toMatch(/\d/)
      expect(play.stats.at(-1)?.quotaErrors).toBe(1)
      expect(ofType(play.events, 'error')).toEqual([])
    } finally {
      SourceBuffer.prototype.appendBuffer = real
    }
  })

  test('keeps the bytes of the window under a small limit of its own', async () => {
    // The least the window class allows is no more than its limit: 2 MiB is under every synthetic file's 5 MB.
    const limit = 2 * 1024 * 1024
    const play = begin('h264-aac-faststart.mp4', { windowBytes: limit })
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    play.video.playbackRate = 2
    await play.video.play()
    await until(play, 'the end', 40_000, () => play.video.ended)
    expect(play.stats.length).toBeGreaterThan(3)
    expect(Math.max(...play.stats.map((numbers) => numbers.windowBytes))).toBeLessThanOrEqual(
      limit + CHUNK_BYTES,
    )
    expect(ofType(play.events, 'remove').length).toBeGreaterThan(0)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('says a quota error that nothing can mend once, waits for the playhead, and plays on when the browser takes data again', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original is called on the buffer it was taken from, below.
    const real = SourceBuffer.prototype.appendBuffer
    let fragments = 0
    let refusing = true
    SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, source: BufferSource) {
      const head = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source)
      if (String.fromCharCode(...head.subarray(4, 8)) !== 'ftyp') {
        fragments += 1
        if (refusing && fragments > 4) {
          throw new DOMException('The buffer is full.', 'QuotaExceededError')
        }
      }
      real.call(this, source)
    }
    try {
      const play = begin('h264-aac-faststart.mp4', { windowBytes: WINDOW_FLOOR_BYTES })
      await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
      await play.video.play()
      // The playhead goes through the little that is buffered and waits at its end, while the browser refuses.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(ofType(play.events, 'quota')).toHaveLength(1)
      expect(
        ofType(play.events, 'watchdog').filter((event) => event.action === 'quota'),
      ).toHaveLength(1)
      refusing = false
      await until(
        play,
        'the clock past what was buffered',
        20_000,
        () => play.video.currentTime > 4,
      )
      expect(ofType(play.events, 'error')).toEqual([])
    } finally {
      SourceBuffer.prototype.appendBuffer = real
    }
  })

  test('a failure after the first picture sends one error, stops the download and reads nothing more', async () => {
    // A slow link keeps the read open. A network change breaks it; the read is then dropped once, and then refused for good (404).
    await control({ bandwidthBytesPerSecond: 200_000 })
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 20_000, () => play.video.readyState >= 2)
    await control({
      bandwidthBytesPerSecond: 200_000,
      faults: [
        { kind: 'drop', afterBytes: 0 },
        { kind: 'status', status: 404 },
      ],
    })
    await switchNetwork(200)
    await until(
      play,
      'the play to fail',
      30_000,
      () => ofType(play.events, 'phase').at(-1)?.phase === 'failed',
    )
    expect(ofType(play.events, 'error')).toHaveLength(1)
    await clearLog()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(await log()).toEqual([])
    expect(play.stats.at(-1)?.error).not.toBeNull()
  })

  test('plays to its end: ended fires once, and the stream is ended once', async () => {
    const end = vi.spyOn(MediaSourceSink.prototype, 'end')
    const play = begin('h264-aac-faststart.mp4')
    let ended = 0
    play.video.addEventListener('ended', () => {
      ended += 1
    })
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    play.video.playbackRate = 4
    await play.video.play()
    await until(play, 'the end', 30_000, () => play.video.ended)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(ended).toBe(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(play.video.duration).toBeGreaterThan(11)
    const phases = ofType(play.events, 'phase').map((event) => event.phase)
    expect(phases).toEqual(['opening', 'buffering', 'ended'])
    expect(play.stats.at(-1)?.phase).toBe('ended')
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('closing ends the play, lets go of the element and leaves no directory', async () => {
    const play = begin('h264-aac-faststart.mp4')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    await play.video.play()
    expect(await directoryExists(play.playId)).toBe(true)

    play.controller.abort(new Error('closed'))
    await play.done
    expect(play.resolved).toBe(true)
    expect(await directoryExists(play.playId)).toBe(false)
    expect(play.video.getAttribute('src')).toBeNull()

    // Nothing runs on after the close.
    const events = play.events.length
    const numbers = play.stats.length
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(play.events).toHaveLength(events)
    expect(play.stats).toHaveLength(numbers)
  })

  test('an abort before the first picture rejects with its reason and leaves no directory', async () => {
    const play = begin('h264-aac-faststart.mp4')
    const reason = new Error('left at once')
    play.controller.abort(reason)
    await expect(play.done).rejects.toBe(reason)
    const deadline = performance.now() + 5_000
    while (await directoryExists(play.playId)) {
      if (performance.now() > deadline) throw new Error('the play left its directory')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(play.video.getAttribute('src')).toBeNull()
  })
})

suite('h264-aac-faststart.mp4')('playStreamed: from a given time', () => {
  test('startAt 3 s starts there, and plays on from there', async () => {
    const play = begin('h264-aac-faststart.mp4', { startAt: 3 })
    await until(play, 'the clock at 3 s', 15_000, () => play.video.currentTime >= 2.99)
    await until(play, 'a picture', 15_000, () => play.video.readyState >= 2)
    expect(play.video.currentTime).toBeCloseTo(3, 1)
    expect(play.video.paused).toBe(true)
    // The picture is fed from the keyframe before 3 s.
    expect(play.video.buffered.start(0)).toBeLessThanOrEqual(3)
    expect(ofType(play.events, 'watchdog').filter((event) => event.action === 'gap')).toEqual([])
    await play.video.play()
    await until(play, '3.5 s', 15_000, () => play.video.currentTime > 3.5)
    expect(frames(play.video)).toBeGreaterThan(0)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('startAt past the end starts near it, and ends', async () => {
    const play = begin('h264-aac-faststart.mp4', { startAt: 100 })
    await until(play, 'a picture', 15_000, () => play.video.readyState >= 2)
    expect(play.video.currentTime).toBeGreaterThan(8)
    let ended = 0
    play.video.addEventListener('ended', () => {
      ended += 1
    })
    await play.video.play()
    await until(play, 'the end', 20_000, () => ended > 0 || play.video.ended)
    expect(ofType(play.events, 'error')).toEqual([])
  })

  test('an abort during the first feeds rejects with its reason', async () => {
    const reason = new Error('left during the first feeds')
    const play = begin('h264-aac-faststart.mp4', {
      onEvent: (event, started) => {
        if (event.type === 'append') started.controller.abort(reason)
      },
    })
    await expect(play.done).rejects.toBe(reason)
  })
})

// The sound of `late-sound.mp4` is shown 0.48 s in: with the clock at 0 the element has no sound there, and waits.
suite('late-sound.mp4')('playStreamed: the common start', () => {
  test('starts where the picture and the sound both have frames, with no stall at readyState 1, and logs the gap', async () => {
    const play = begin('late-sound.mp4')
    await until(play, 'a picture', 15_000, () => play.video.readyState >= 2)
    expect(play.video.currentTime).toBeGreaterThan(0.4)
    const gaps = ofType(play.events, 'watchdog').filter((event) => event.action === 'gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.at).toBe(0)
    expect(gaps[0]?.detail.length).toBeGreaterThan(0)
    await play.video.play()
    await until(play, '1.5 s', 15_000, () => play.video.currentTime > 1.5)
    expect(frames(play.video)).toBeGreaterThan(0)
    expect(ofType(play.events, 'error')).toEqual([])
  })
})

/** Plays the named file and checks that the engine rejects before any picture with the sentence, which is on the timeline, and that nothing is left behind. */
async function expectRefusal(name: string, reason: string): Promise<void> {
  const play = begin(name)
  await expect(play.done).rejects.toMatchObject({ refusal: expect.any(String) as unknown, reason })
  const { refusal } = (play.rejection as { reason: { refusal: string } }).reason
  expect(refusal.length).toBeGreaterThan(0)
  expect(
    ofType(play.events, 'error').some(
      (event) => event.from === 'engine' && event.message === refusal,
    ),
  ).toBe(true)
  expect(ofType(play.events, 'append')).toEqual([])
  expect(frames(play.video)).toBe(0)
  expect(play.video.getAttribute('src')).toBeNull()
  expect(ofType(play.events, 'phase').at(-1)?.phase).toBe('failed')
  const deadline = performance.now() + 5_000
  while (await directoryExists(play.playId)) {
    if (performance.now() > deadline) throw new Error('the play left its directory')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('playStreamed: a file that cannot play', () => {
  // The manifest says which files the reader refuses, and why.
  const marked = synthetic.find(
    (file) => file.name.endsWith('mpeg4-visual.mp4') && typeof file.expect === 'object',
  )
  test.skipIf(marked === undefined)(
    'rejects a picture the reader refuses, with its reason and its sentence',
    async () => {
      const { expect: wanted } = marked ?? { expect: 'plays' as const }
      if (typeof wanted !== 'object') throw new Error('the manifest does not refuse this file')
      await expectRefusal('mpeg4-visual.mp4', wanted.refused)
    },
  )

  // Chrome without a decoder for AC-3 takes none of its names, which is the `codec` refusal; where it has one, there is nothing to refuse.
  test.skipIf(served('h264-ac3.mp4') === undefined)(
    'rejects a sound that Media Source takes none of, with the codec reason',
    async (context) => {
      if (MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"')) {
        context.skip('This browser takes AC-3, so it has nothing to refuse.')
        return
      }
      await expectRefusal('h264-ac3.mp4', 'codec')
    },
  )
})

suite('h264-aac.mkv')('playStreamed: a Matroska file', () => {
  test('shows a picture and plays to its end', async () => {
    const play = begin('h264-aac.mkv')
    await until(play, 'the first picture', 15_000, () => play.video.readyState >= 2)
    play.video.playbackRate = 4
    await play.video.play()
    await until(play, 'the end', 30_000, () => play.video.ended)
    expect(frames(play.video)).toBeGreaterThan(0)
    expect(ofType(play.events, 'phase').at(-1)?.phase).toBe('ended')
    expect(ofType(play.events, 'error')).toEqual([])
  })
})

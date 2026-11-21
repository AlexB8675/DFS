// The Media Source sink in a real browser (DESIGN.md §10.4): the synthetic corpus, served whole by the
// play server, goes through a `Feeder` into a `video` element, and the browser is asked what it holds
// and what it plays. A file that is not served (no `corpus:make`) skips its tests, with the reason.

import { fragment, presentationSeconds } from '@dfs/mp4'
import type { PlayTrack } from '@dfs/mp4'
import type { TimelineEventInput } from '@dfs/shared'
import { afterEach, describe, expect, test } from 'vitest'
import { Feeder } from '../engine/feeder.ts'
import type { EngineTrack } from '../engine/tracks.ts'
import type { FedRun } from '../engine/window.ts'
import { MediaSourceSink, SinkQuotaError } from '../page/index.ts'
import { fetchMemorySource } from './memory-source.ts'
import type { MemorySource } from './memory-source.ts'
import { fileUrl, files } from './server.ts'

const synthetic = files().filter((file) => file.synthetic)

/** The served synthetic file of that name, if the corpus was made. */
function served(name: string): { id: string } | undefined {
  return synthetic.find((file) => file.name === name || file.name.endsWith(`/${name}`))
}

const videos: HTMLVideoElement[] = []
const sinks: MediaSourceSink[] = []

afterEach(() => {
  for (const sink of sinks.splice(0)) sink.close()
  for (const video of videos.splice(0)) video.remove()
})

interface Play {
  video: HTMLVideoElement
  source: MemorySource
  feeder: Feeder
  sink: MediaSourceSink
  events: TimelineEventInput[]
  signal: AbortSignal
}

async function start(name: string, duration?: null): Promise<Play> {
  const file = served(name)
  if (file === undefined) throw new Error(`${name} is not served.`)
  const source = await fetchMemorySource(fileUrl(file.id))
  const events: TimelineEventInput[] = []
  const feeder = await Feeder.open(
    source,
    (mime) => MediaSource.isTypeSupported(mime),
    (event) => events.push(event),
  )
  const video = document.createElement('video')
  video.muted = true
  document.body.append(video)
  videos.push(video)
  const sink = await MediaSourceSink.open(
    video,
    duration === undefined ? feeder.durationSeconds : duration,
  )
  sinks.push(sink)
  return { video, source, feeder, sink, events, signal: new AbortController().signal }
}

async function until(what: string, ms: number, done: () => boolean): Promise<void> {
  const from = performance.now()
  while (!done()) {
    if (performance.now() - from > ms) throw new Error(`Gave up waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Where a picture track's frames end on the playback timeline. */
function framesEnd(track: EngineTrack): number {
  const { table, timing } = track.track as PlayTrack
  let end = 0
  for (let i = 0; i < table.count; i += 1) {
    end = Math.max(
      end,
      presentationSeconds(table, timing, i) + (table.durations[i] ?? 0) / table.timescale,
    )
  }
  return end
}

/** Gives the sink the picture alone with no append window, and makes copies of its fragment, the nth `n` times as late. */
async function pictureCopies(
  play: Play,
): Promise<{ copy: (n: number) => { bytes: Uint8Array; run: FedRun }; span: number }> {
  const { video } = play.feeder.tracks
  const picture = video.track as PlayTrack
  const open: EngineTrack = {
    ...video,
    track: { ...picture, timing: { ...picture.timing, endSeconds: null } },
  }
  await play.sink.init({ video: open, audio: null })
  const { table } = picture
  const span = framesEnd(video)
  const ticks = Math.ceil(span * table.timescale)
  return {
    span,
    copy: (n) => {
      const shifted = { ...table, dts: table.dts.map((dts) => dts + n * ticks) }
      const bytes = fragment(
        { header: picture.header, table: shifted },
        0,
        table.count,
        n + 1,
        (offset, size) => play.source.bytes.subarray(offset, offset + size),
      )
      return {
        bytes,
        run: {
          kind: 'video',
          start: n * span,
          end: (n + 1) * span,
          bytes: bytes.length,
          keyframe: true,
        },
      }
    },
  }
}

function suite(name: string): ReturnType<typeof describe.skipIf> {
  return describe.skipIf(served(name) === undefined)
}

suite('h264-aac-faststart.mp4')('an MP4 through the sink', () => {
  test('plays to its end, and the duration is where its frames end', async () => {
    const play = await start('h264-aac-faststart.mp4')
    expect(await play.feeder.feed(Infinity, play.sink, play.signal)).toBe('ended')
    await play.sink.end()
    await play.sink.end()
    play.video.playbackRate = 4
    await play.video.play()
    await until('the end', 20_000, () => play.video.ended)
    expect(play.video.duration).toBeCloseTo(framesEnd(play.feeder.tracks.video), 1)
    expect(play.events).toEqual([])
  })

  test('reopen at 2 s plays on from there', async () => {
    const play = await start('h264-aac-faststart.mp4')
    await play.feeder.feed(4, play.sink, play.signal)
    play.video.playbackRate = 2
    await play.video.play()
    await until('the first second', 10_000, () => play.video.currentTime > 1)
    await play.sink.reopen(2)
    await play.feeder.seek(2, play.signal)
    expect(await play.feeder.feed(Infinity, play.sink, play.signal)).toBe('ended')
    await play.sink.end()
    await play.video.play()
    await until('2.5 s', 10_000, () => play.video.currentTime > 2.5)
    expect(play.video.error).toBeNull()
  })

  test('remove takes away what is before the cut and keeps the group being played', async () => {
    const play = await start('h264-aac-faststart.mp4')
    await play.feeder.feed(Infinity, play.sink, play.signal)
    expect(play.sink.buffered('video')[0]?.[0]).toBeCloseTo(0, 1)
    await play.sink.remove('video', 0)
    expect(play.sink.buffered('video')[0]?.[0]).toBeCloseTo(0, 1)
    // The keyframes are 2 s apart: a cut at the one at 4 s keeps it, and its group.
    await play.sink.remove('video', 4)
    const [first] = play.sink.buffered('video')
    expect(first?.[0]).toBeCloseTo(4, 1)
    expect(first?.[1]).toBeGreaterThan(11)
  })

  test('reports a quota error as a SinkQuotaError', { timeout: 90_000 }, async (context) => {
    const play = await start('h264-aac-faststart.mp4')
    const { copy } = await pictureCopies(play)
    let sent = 0
    const started = performance.now()
    for (let n = 0; ; n += 1) {
      if (sent > 400 * 1024 * 1024 || performance.now() - started > 60_000) {
        context.skip(
          `This browser took ${Math.round(sent / (1024 * 1024))} MB with no quota error.`,
        )
        return
      }
      const { bytes, run } = copy(n)
      try {
        await play.sink.append('video', bytes, run)
      } catch (error) {
        expect(error).toBeInstanceOf(SinkQuotaError)
        expect(error).toBeInstanceOf(Error)
        expect((error as SinkQuotaError).quota).toBe(true)
        return
      }
      sent += bytes.length
    }
  })

  describe('its lifecycle', () => {
    function aborted(result: PromiseSettledResult<void>): boolean {
      return (
        result.status === 'rejected' &&
        result.reason instanceof DOMException &&
        result.reason.name === 'AbortError'
      )
    }

    test('appends queued before a reopen reject with AbortError, and the new buffers take later ones', async () => {
      const play = await start('h264-aac-faststart.mp4')
      const { copy } = await pictureCopies(play)
      const queued = [0, 1, 2, 3].map((n) => {
        const { bytes, run } = copy(n)
        return play.sink.append('video', bytes, run)
      })
      const reopened = play.sink.reopen(0)
      expect(play.sink.buffered('video')).toEqual([])
      expect((await Promise.allSettled(queued)).every(aborted)).toBe(true)
      await reopened
      const { bytes, run } = copy(0)
      await play.sink.append('video', bytes, run)
      expect(play.sink.buffered('video')[0]?.[0]).toBeCloseTo(0, 1)
    })

    test('after close every queued and later operation rejects, and buffered says nothing', async () => {
      const play = await start('h264-aac-faststart.mp4')
      const { copy } = await pictureCopies(play)
      const queued = [0, 1].map((n) => {
        const { bytes, run } = copy(n)
        return play.sink.append('video', bytes, run)
      })
      play.sink.close()
      const later = copy(2)
      const settled = await Promise.allSettled([
        ...queued,
        play.sink.append('video', later.bytes, later.run),
        play.sink.remove('video', 4),
      ])
      expect(settled.every(aborted)).toBe(true)
      expect(play.sink.buffered('video')).toEqual([])
      await expect(play.sink.reopen(0)).rejects.toThrow()
      await expect(play.sink.init(play.feeder.tracks)).rejects.toThrow()
    })

    test('init is for once', async () => {
      const play = await start('h264-aac-faststart.mp4')
      await play.sink.init(play.feeder.tracks)
      await expect(play.sink.init(play.feeder.tracks)).rejects.toThrow()
    })

    test('an append started just before end completes, and the stream ends', async () => {
      const play = await start('h264-aac-faststart.mp4')
      const { copy } = await pictureCopies(play)
      const { bytes, run } = copy(0)
      const appended = play.sink.append('video', bytes, run)
      await play.sink.end()
      await appended
      expect(play.video.duration).toBeGreaterThan(11)
      expect(play.events).toEqual([])
    })

    test('setDuration gives the duration that init sets, when the sink was opened without one', async () => {
      const play = await start('h264-aac-faststart.mp4', null)
      const duration = play.feeder.durationSeconds
      expect(duration).not.toBeNull()
      play.sink.setDuration(duration)
      await play.sink.init(play.feeder.tracks)
      expect(play.video.duration).toBeCloseTo(duration ?? 0, 1)
    })

    test('open stops when its signal aborts', async () => {
      const video = document.createElement('video')
      const controller = new AbortController()
      controller.abort(new Error('stop'))
      await expect(MediaSourceSink.open(video, null, controller.signal)).rejects.toThrow('stop')
    })
  })
})

suite('h264-aac.mkv')('a Matroska file through the sink', () => {
  test('plays to its end', async () => {
    const play = await start('h264-aac.mkv')
    expect(await play.feeder.feed(Infinity, play.sink, play.signal)).toBe('ended')
    await play.sink.end()
    play.video.playbackRate = 4
    await play.video.play()
    await until('the end', 20_000, () => play.video.ended)
    expect(play.video.duration).toBeGreaterThan(11.9)
    expect(play.events).toEqual([])
  })

  test('forgets a deferred seek when it is cancelled: an append that makes it seekable does not move the clock', async () => {
    // With no known duration nothing is seekable until data is buffered, so the seek waits for an append.
    const play = await start('h264-aac.mkv', null)
    play.sink.seek(2)
    play.sink.cancelSeek()
    await play.feeder.feed(4, play.sink, play.signal)
    expect(play.video.seekable.length).toBeGreaterThan(0)
    expect(play.video.seekable.end(play.video.seekable.length - 1)).toBeGreaterThan(2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(play.video.currentTime).toBe(0)
  })

  test('reopen at 2 s with no known duration plays on from there', async () => {
    const play = await start('h264-aac.mkv', null)
    await play.feeder.feed(4, play.sink, play.signal)
    await play.sink.reopen(2)
    await play.feeder.seek(2, play.signal)
    expect(await play.feeder.feed(Infinity, play.sink, play.signal)).toBe('ended')
    await play.sink.end()
    await play.video.play()
    await until('2.5 s', 10_000, () => play.video.currentTime > 2.5)
    expect(play.video.error).toBeNull()
  })
})

// The sound of `late-sound.mp4` has an edit list that starts with an empty edit, so its frames are shown 0.48 s in.
suite('late-sound.mp4')('a track with an edit list', () => {
  test('keeps its offset', async () => {
    const play = await start('late-sound.mp4')
    await play.feeder.feed(2, play.sink, play.signal)
    const sound = play.feeder.tracks.audio
    expect(sound).not.toBeNull()
    const offset = sound?.track.timing.offsetSeconds ?? 0
    expect(offset).toBeGreaterThan(0.4)
    expect(play.sink.buffered('audio')[0]?.[0]).toBeCloseTo(offset, 1)
    expect(play.sink.buffered('video')[0]?.[0]).toBeCloseTo(0, 1)
  })
})
